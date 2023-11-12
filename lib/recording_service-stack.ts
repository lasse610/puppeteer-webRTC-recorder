import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import {
    InstanceClass,
    InstanceSize,
    InstanceType,
    Peer,
    Port,
    SubnetType,
    Vpc
} from "aws-cdk-lib/aws-ec2";
import { FckNatInstanceProvider } from "cdk-fck-nat";
import { AsgCapacityProvider, LinuxParameters } from "aws-cdk-lib/aws-ecs";
import { RemovalPolicy } from "aws-cdk-lib";
import { AutoScalingGroup } from "aws-cdk-lib/aws-autoscaling";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class RecordingServiceStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const natProvider = new FckNatInstanceProvider({
            instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.NANO)
        });

        const vpc = new Vpc(this, "main_vpc", {
            natGatewayProvider: natProvider,
            natGateways: 1,
            maxAzs: 1,
            subnetConfiguration: [
                {
                    name: "private-subnet-1",
                    subnetType: SubnetType.PRIVATE_WITH_NAT,
                    cidrMask: 24
                },
                {
                    name: "public-subnet-1",
                    subnetType: SubnetType.PUBLIC,
                    cidrMask: 24
                }
            ]
        });

        natProvider.securityGroup.addEgressRule(
            Peer.anyIpv4(),
            Port.allTraffic(),
            "Allow all traffic from NatGw to internet"
        );
        natProvider.securityGroup.addIngressRule(
            Peer.ipv4(vpc.vpcCidrBlock),
            Port.allTraffic(),
            "Allow traffic from vpc to natgw"
        );

        const cluster = new ecs.Cluster(this, "EcsClusterAutoScalingDemo", {
            vpc: vpc,
            containerInsights: true
        });
        const UserDataBucket = new s3.Bucket(this, "user_data_bucket", {
            autoDeleteObjects: true,
            removalPolicy: RemovalPolicy.DESTROY
        });

        const userData = cdk.aws_ec2.UserData.forLinux();
        userData.addS3DownloadCommand({
            bucket: UserDataBucket,
            bucketKey: "ecs.config",
            localFile: "/etc/ecs/ecs.config"
        });

        const capacityProvider = new AsgCapacityProvider(this, "capacity_provide", {
            autoScalingGroup: new AutoScalingGroup(this, "autoscaling_group", {
                vpc,
                minCapacity: 1,
                maxCapacity: 1,
                instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.NANO),
                userData: userData,
                machineImage: ecs.EcsOptimizedImage.amazonLinux2(
                    ecs.AmiHardwareType.ARM
                )
            })
        });
        // Grant Read to ec2 to allow downloading congif file for ecs agent
        UserDataBucket.grantRead(capacityProvider.autoScalingGroup);

        cluster.addAsgCapacityProvider(capacityProvider);
        //
        const task = new ecs.Ec2TaskDefinition(this, "recording_service_task", {});
        const image = ecs.ContainerImage.fromDockerImageAsset(
            new DockerImageAsset(this, "recording_service_docker_image", {
                directory: "resources/recordingService",
                platform: Platform.LINUX_ARM64
            })
        );

        task.addContainer("recording_service_container", {
            linuxParameters: new LinuxParameters(this, "parameters", {
                initProcessEnabled: true
            }),

            image,
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: "Recording_Service_Docker",
                logRetention: RetentionDays.ONE_WEEK
            }),
            memoryReservationMiB: 256
        });
        const ec2Service = new ecs.Ec2Service(this, "ec2_service", {
            cluster: cluster,
            taskDefinition: task,
            desiredCount: 1,
            capacityProviderStrategies: [
                {
                    capacityProvider: capacityProvider.capacityProviderName,
                    weight: 1
                }
            ]
        });



        const recordingQueue = new sqs.Queue(this, "recording_queue", {
            queueName: "recording_queue",
            visibilityTimeout: cdk.Duration.hours(2)
        });

        new cdk.CfnOutput(this, "queue_url", {
            exportName: "QUEUE",
            value: recordingQueue.queueUrl
        });
    }
}
