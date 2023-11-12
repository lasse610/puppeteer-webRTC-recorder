import { spawn } from "child_process";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import * as puppeteer from "puppeteer";
import * as chokidar from "chokidar";
import { jwt } from "twilio";
import * as twilio from "twilio";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
dotenv.config();
const AccessToken = jwt.AccessToken;
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAccountAuthToken = process.env.TWILIO_ACCOUNT_AUTH_TOKEN;
const twilioKeySid = process.env.TWILIO_KEY_SID;
const twilioKeySecret = process.env.TWILIO_KEY_SECRET;
const awsAccessKey = process.env.AWS_ACCESS_KEY;
const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const bucketName = process.env.BUCKET_NAME;
const region = process.env.AWS_DEFAULT_REGION;

async function recorder() {
    if (
        !twilioAccountAuthToken ||
    !twilioAccountSid ||
    !twilioKeySid ||
    !twilioKeySecret ||
    !region ||
    !awsAccessKey ||
    !awsSecretAccessKey
    ) {
        throw new Error("ENV variables not configured properly");
    }

    const twilioClient = new twilio.Twilio(
        twilioAccountSid,
        twilioAccountAuthToken
    );

    let ffmpegExited = false;
    const recorderIdentity = "recording-bot";
    const hslBucketName = bucketName;
    const s3Client = new S3Client({
        region,
        credentials: {
            secretAccessKey: awsSecretAccessKey,
            accessKeyId: awsAccessKey
        }
    });
    const roomName = process.argv[2];
    console.log(`roomName ${roomName}`);
    const roomVideoDir = `./videos/${roomName}`;
    const uploadPromiseArr: Promise<void>[] = [];

    // Timeout for recorder and calls
    const timeout = setTimeout(async () => {
        await twilioClient.video.v1
            .rooms(roomName)
            .participants(recorderIdentity)
            .update({ status: "disconnected" });
        await startCloseProcess();
    }, 3600000);

    timeout.unref();

    if (!roomName) {
        console.log("no Room Name provided, exiting");
        process.exit(1);
    }

    await fs.promises.mkdir(roomVideoDir);

    chokidar.watch(roomVideoDir).on("add", async (filepath) => {
        console.log(`file added. NAME: ${filepath}`);
        const fileName = path.parse(filepath).base;
        const file = await fs.promises.readFile(filepath);
        const command = new PutObjectCommand({
            Bucket: hslBucketName,
            Key: `${roomName}/${fileName}`,
            Body: file
        });
        uploadPromiseArr.push(handleUploadAndFileDelete());
        async function handleUploadAndFileDelete() {
            await s3Client.send(command);
            console.log(`succesfully uploaded file: ${filepath} to S3`);
            await fs.promises.rm(filepath);
            console.log(`succesfully deleted file: ${filepath}`);
        }
    });
    console.log(`recording bot started. Process pid: ${process.pid}`);
    const browser = await puppeteer.launch({
        args: [
            "--disable-gesture-requirement-for-media-playback",
            "'--autoplay-policy=no-user-gesture-required'",
            "--no-sandbox"
        ]
    });
    const page = await browser.newPage();

    await page.goto("http://localhost:3005", { waitUntil: "domcontentloaded" });
    const ffmpegProcess = spawn("ffmpeg", getFfmpegArgs(roomVideoDir));
    ffmpegProcess.stderr.on("data", (chunk) => {
        console.log(chunk.toString());
    });

    await Promise.all([
        page.exposeFunction("debug", (message: string) => {
            console.log(`Puppeteer debug: ${message}`);
        }),
        page.exposeFunction("error", (message: string) => {
            console.log(`Puppeteer error: ${message}`);
        }),
        page.exposeFunction("info", (message: string) => {
            console.log(`Puppeteer info: ${message}`);
        }),
        page.exposeFunction("appendRecording", (chunk: string) => {
            console.log(`received chunk length ${chunk.length}`);
            const buffer = Buffer.from(chunk, "base64");
            const base64 = buffer.toString("base64");
            console.log(`reencoded length ${base64.length}`);
            if (buffer.length > 0) {
                console.log("writing to ffmpeg");
                ffmpegProcess?.stdin.write(buffer);
            }
        }),
        page.exposeFunction("closeProcess", async () => {
            await startCloseProcess();
        })
    ]);

    async function startCloseProcess() {
        console.log("starting to close process");
        await page.close();
        ffmpegProcess.stdin.end();
        const promise = async () => {
            ffmpegProcess?.addListener("exit", async () => {
                console.log("ffmpeg exit called");
                ffmpegExited = true;
            });
        };
        await promise();
    }
    console.log("registered callbacks");
    const token = createToken(recorderIdentity, roomName);
    console.log(process.argv);
    await page.evaluate(`main("${token}", "${roomName}")`);

    async function checkExitStatus(resolve: (value: unknown) => void) {
        setTimeout(async () => {
            console.log(`checking exit status. ffmpeg finished ${ffmpegExited}`);
            if (ffmpegExited) {
                const list = await fs.promises.readdir(roomVideoDir);
                console.log(
                    `ffmpeg finished. checking dir contents. files found ${list.length}`
                );
                if (list.length === 0) {
                    console.log("waiting to uploads to be ready");
                    await Promise.all(uploadPromiseArr);
                    console.log("uploads ready");
                    await fs.promises.rmdir(roomVideoDir);
                    console.log("tmp dir for call empty and removed. Exiting");
                    resolve("ready to exit");
                    return;
                }
                console.log("waiting to files to be uploaded");
            }
            checkExitStatus(resolve);
        }, 2000);
    }

    await new Promise((resolve, reject) => {
        try {
            checkExitStatus(resolve);
        } catch (e) {
            reject(e);
        }
    });
}

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
async function main() {
    await recorder();
    process.exit(0);
}

main();

function getFfmpegArgs(output: string) {
    const command = [
        "-i",
        "-",
        "-f",
        "hls",
        "-hls_time",
        "2",
        "-hls_playlist_type",
        "vod",
        "-hls_flags",
        "independent_segments",
        "-hls_segment_type",
        "mpegts",
        "-hls_segment_filename",
        `${output}/data%02d.ts`,
        "-var_stream_map",
        "v:0",
        `${output}/master.m3u8`
    ];
    return command;
}
