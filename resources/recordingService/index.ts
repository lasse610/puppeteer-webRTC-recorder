import express, { Request, Response } from "express";
import * as osu from "node-os-utils";
import expressWinston from "express-winston";
import winston from "winston";
import { join } from "path";
import { spawn } from "child_process";
import AccessToken from "twilio/lib/jwt/AccessToken";
import * as twilio from "twilio";
import * as dotenv from "dotenv";
dotenv.config();
import {
    SQSClient,
    ReceiveMessageCommand,
    DeleteMessageCommand
} from "@aws-sdk/client-sqs";
const awsAccessKey = process.env.AWS_ACCESS_KEY;
const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioKeySid = process.env.TWILIO_KEY_SID;
const twilioKeySecret = process.env.TWILIO_KEY_SECRET;
const twilioAccountAuthToken = process.env.TWILIO_ACCOUNT_AUTH_TOKEN;
const region = process.env.AWS_DEFAULT_REGION;
console.log(`aws default region ${region}`);

if (
    !twilioAccountAuthToken ||
  !twilioAccountSid ||
  !twilioKeySecret ||
  !twilioKeySid
) {
    throw new Error("ENV variables not configured properly");
}
const twilioClient = new twilio.Twilio(
    twilioAccountSid,
    twilioAccountAuthToken
);

const internalServer = express();

const logger = winston.createLogger({
    format: winston.format.combine(
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        winston.format.printf(
            (info) => `${info.timestamp} ${info.level}: ${info.message}`
        )
    ),
    transports: [new winston.transports.Console()]
});

const loggerMiddleware = expressWinston.logger({ winstonInstance: logger });
// Serve index.html and bundle.js for puppeteer;

internalServer.get("/", (req, res) => {
    res.sendFile(join(__dirname, "./index.html"));
});
internalServer.get("/bundle.js", (req, res) => {
    res.sendFile(join(__dirname, "./bundle/bundle.js"));
});

internalServer.get("/bundle.js.map", (req, res) => {
    res.sendFile(join(__dirname, "./bundle/bundle.js.map"));
});

console.log("internal server listening on port 3005");
internalServer.listen(3005);

internalServer.use(loggerMiddleware);

interface StartRecordingMessageBody {
  RoomName: string;
  TenantId: string;
}

async function queueListener() {
    let activeProcesses: number[] = [];
    const sqsClient = new SQSClient({
        region,
        credentials: {
            accessKeyId: awsAccessKey || "",
            secretAccessKey: awsSecretAccessKey || ""
        }
    });
    let shouldExit = false;
    setImmediate(async () => {
        await handleListening();
    });

    process.on("SIGTERM", (signal) => {
        console.log(`received ${signal}`);
        shouldExit = true;
        console.log("preparing for exit");

        setInterval(() => {
            handleExit();
        }, 1000);

        function handleExit() {
            console.log("checking exit status");
            console.log(`active processes ${activeProcesses.length}`);
            if (activeProcesses.length === 0) {
                // kill pid 1
                console.log("killing process");
                process.kill(1, "SIGKILL");
                process.exit(0);
            } else {
                console.log("waiting for processes to finnish");
            }
        }
    });

    // Loop
    // Check cpu usage if too high do nothing
    // Poll for messages
    // If received messages
    // Start childprocess
    // save childprocess somewhere
    // when started succesfully delete message from sqs
    // if receve SIGINT shitdown childprocesses gracefully
    async function handleListening() {
        const cpuUsage = await osu.cpu.usage();
        console.log(`starting listener. CPU usage currently ${cpuUsage}`);
        if (cpuUsage < 50 || shouldExit) {
            console.log("Retrieving messages from sqs");
            const getMessagesCommand = new ReceiveMessageCommand({
                QueueUrl: process.env.QUEUE_URL,
                WaitTimeSeconds: 20
            });

            const messages = await sqsClient.send(getMessagesCommand);

            if (messages.Messages) {
                const { Messages } = messages;
                console.log(`Received ${Messages.length}}`);

                for (const message of Messages) {
                    const deleteMessageCommand = new DeleteMessageCommand({
                        QueueUrl: process.env.QUEUE_URL,
                        ReceiptHandle: message.ReceiptHandle
                    });
                    if (message.Body) {
                        const { RoomName, TenantId } = JSON.parse(
                            message.Body
                        ) as StartRecordingMessageBody;

                        const isValid = await checkIfRoomExistsAndHasParticipants(RoomName);
                        if (isValid) {
                            const recordingProcess = spawn("node", [
                                "./recorder.js",
                                RoomName
                            ]);
                            if (recordingProcess.pid) {
                                console.log(
                                    `started recording process with pid ${recordingProcess.pid}`
                                );
                                activeProcesses = activeProcesses.concat(recordingProcess.pid);
                                `active processes ${JSON.stringify(activeProcesses)}`;
                            } else {
                                console.log("failed spawning process");
                            }

                            recordingProcess.stdout.on("data", (data) => {
                                console.log(`childprocess data: ${data}`);
                            });
                            console.log("registered listeners");

                            recordingProcess.stderr.on("data", (data) => {
                                console.log(`childprocess error: ${data}`);
                            });

                            recordingProcess.on("exit", (exitCode) => {
                                console.log(
                                    `process with pid: ${recordingProcess.pid} exited with code ${exitCode} `
                                );
                                activeProcesses = activeProcesses.filter(
                                    (activeProcessPid) =>
                                        activeProcessPid !== recordingProcess.pid
                                );
                                console.log(
                                    `active processes ${JSON.stringify(activeProcesses)}`
                                );
                            });
                        } else {
                            console.log(`room with roomName:${RoomName} is not valid`);
                        }
                    } else {
                        console.log("no body received for message");
                        console.log(message);
                    }
                    console.log("deleting message");
                    await sqsClient.send(deleteMessageCommand);
                }
            } else {
                console.log("No messages received");
            }
        } else {
            console.log(
                "cpu usage too high or container scheduled for exit. Waiting for processes to finnish"
            );
        }
        if (!shouldExit) {
            setImmediate(async () => {
                await handleListening();
            });
        } else {
            console.log("scheduled for exit");
        }
    }
}

queueListener();

function createToken(identity: string, roomName: string) {
    console.log("creating access token");
    const token = new AccessToken(
        twilioAccountSid || "",
        twilioKeySid || "",
        twilioKeySecret || ""
    );
    token.identity = identity;
    token.addGrant(new AccessToken.VideoGrant({ room: roomName }));
    return token.toJwt();
}

async function checkIfRoomExistsAndHasParticipants(roomName: string) {
    const participants = await twilioClient.video.v1
        .rooms(roomName)
        .participants.list({ status: "connected" });
    console.log(JSON.stringify(participants));
    return participants.length == 2;
}
