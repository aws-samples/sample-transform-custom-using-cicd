import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as codedeploy from "aws-cdk-lib/aws-codedeploy";
import * as codecommit from "aws-cdk-lib/aws-codecommit";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sns_subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

export class AtxPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── Context Parameters ───
    const transformationName =
      this.node.tryGetContext("transformationName") || "python-version-upgrade-314";
    const approvalEmail = this.node.tryGetContext("approvalEmail") || "";
    const sourcePythonVersion = this.node.tryGetContext("sourcePythonVersion") || "3.9";
    const targetPythonVersion = this.node.tryGetContext("targetPythonVersion") || "3.14";
    const targetRuntime = `python${targetPythonVersion}`;

    // Validate supported version combinations
    const validSourceVersions = ["3.8", "3.9"];
    const validTargetVersions = ["3.11", "3.12", "3.13", "3.14"];
    if (!validSourceVersions.includes(sourcePythonVersion)) {
      throw new Error(`sourcePythonVersion must be one of ${validSourceVersions.join(", ")}. Got: ${sourcePythonVersion}`);
    }
    if (!validTargetVersions.includes(targetPythonVersion)) {
      throw new Error(`targetPythonVersion must be one of ${validTargetVersions.join(", ")}. Got: ${targetPythonVersion}`);
    }

    // Map version string to CDK Lambda Runtime
    const runtimeMap: Record<string, lambda.Runtime> = {
      "3.8": lambda.Runtime.PYTHON_3_8,
      "3.9": lambda.Runtime.PYTHON_3_9,
      "3.10": lambda.Runtime.PYTHON_3_10,
      "3.11": lambda.Runtime.PYTHON_3_11,
      "3.12": lambda.Runtime.PYTHON_3_12,
      "3.13": lambda.Runtime.PYTHON_3_13,
    };
    const sourceRuntime = runtimeMap[sourcePythonVersion] || lambda.Runtime.PYTHON_3_9;

    // ─── KMS Key for encryption ───
    const encryptionKey = new kms.Key(this, "PipelineKey", {
      alias: "atx-pipeline-key",
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      description: "KMS key for ATX pipeline encryption (CodeBuild, S3, SNS)",
    });

    // ─── S3 Buckets ───
    const accessLogsBucket = new s3.Bucket(this, "AccessLogsBucket", {
      bucketName: `atx-access-logs-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      encryptionKey,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
    });

    const artifactBucket = new s3.Bucket(this, "ArtifactBucket", {
      bucketName: `atx-pipeline-artifacts-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      encryptionKey,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "artifact-bucket/",
    });

    const outputBucket = new s3.Bucket(this, "OutputBucket", {
      bucketName: `atx-output-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      encryptionKey,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "output-bucket/",
    });

    // ─── Upload transformation definition to S3 ───
    new s3deploy.BucketDeployment(this, "TransformDefDeployment", {
      sources: [s3deploy.Source.asset("../python-314-def")],
      destinationBucket: outputBucket,
      destinationKeyPrefix: "definitions",
    });

    // ─── CodeCommit Repository ───
    const repo = new codecommit.Repository(this, "SourceRepo", {
      repositoryName: "atx-python-upgrade-source",
      description: "Python project source code for ATX transformation",
    });

    // ─── Lambda Function ───
    const lambdaLogGroup = new logs.LogGroup(this, "AppLogGroup", {
      logGroupName: "/aws/lambda/atx-python-app",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    const appFunction = new lambda.Function(this, "AppFunction", {
      functionName: "atx-python-app",
      runtime: sourceRuntime,
      handler: "main.handler",
      code: lambda.Code.fromInline(
        "def handler(event, context):\n    return {'statusCode': 200, 'body': 'Placeholder — will be replaced by pipeline deploy'}\n"
      ),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: lambdaLogGroup,
      currentVersionOptions: {
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
      environment: {
        PYTHON_VERSION: sourcePythonVersion,
        APP_ENV: "production",
      },
    });

    // Publish a version and create an alias for CodeDeploy
    const version = appFunction.currentVersion;
    const alias = new lambda.Alias(this, "AppAlias", {
      aliasName: "live",
      version,
    });

    // ─── CloudWatch Alarm for CodeDeploy rollback ───
    const errorAlarm = new cloudwatch.Alarm(this, "LambdaErrorAlarm", {
      alarmName: "atx-python-app-errors",
      metric: alias.metricErrors({
        period: cdk.Duration.minutes(1),
        statistic: "Sum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ─── CodeDeploy for Lambda ───
    const deploymentGroup = new codedeploy.LambdaDeploymentGroup(this, "DeploymentGroup", {
      alias,
      deploymentConfig: codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
      alarms: [errorAlarm],
      autoRollback: {
        failedDeployment: true,
        deploymentInAlarm: true,
      },
    });

    // Grant CodeDeploy service role access to read artifacts from S3 + decrypt with KMS
    artifactBucket.grantRead(deploymentGroup.role);
    encryptionKey.grantDecrypt(deploymentGroup.role);

    // ─── CodeBuild: ATX Transform Stage ───
    const transformProject = new codebuild.PipelineProject(this, "TransformProject", {
      projectName: "atx-transform",
      encryptionKey,
      environment: {
        buildImage: codebuild.LinuxBuildImage.fromDockerRegistry(
          "public.ecr.aws/b7y6j9m3/aws-transform-custom:latest"
        ),
        computeType: codebuild.ComputeType.MEDIUM,
        privileged: false,
      },
      environmentVariables: {
        TRANSFORMATION_NAME: { value: transformationName },
        OUTPUT_BUCKET: { value: outputBucket.bucketName },
        TRANSFORM_DEF_S3_KEY: { value: "definitions/transformation_definition.md" },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              "echo 'Downloading transformation definition from S3...'",
              "aws s3 cp s3://$OUTPUT_BUCKET/$TRANSFORM_DEF_S3_KEY /tmp/transformation_definition.md",
              "echo 'Publishing transformation definition to registry...'",
              "mkdir -p /tmp/transform-def && cp /tmp/transformation_definition.md /tmp/transform-def/",
              `atx custom def publish -n $TRANSFORMATION_NAME --sd /tmp/transform-def --description 'Python ${sourcePythonVersion} to ${targetPythonVersion} upgrade'`,
              "echo 'Preparing source for ATX transformation...'",
              "cd $CODEBUILD_SRC_DIR",
              "git config --global user.email 'atx-pipeline@automated.com'",
              "git config --global user.name 'ATX Pipeline'",
              "if [ ! -d .git ]; then git init && git add . && git commit -m 'initial'; fi",
            ],
          },
          build: {
            commands: [
              `atx custom def exec \\
                -n $TRANSFORMATION_NAME \\
                -p $CODEBUILD_SRC_DIR \\
                -c noop \\
                -x -t \\
                --configuration 'additionalPlanContext=The target Python version to upgrade to is Python ${targetPythonVersion}'`,
            ],
          },
          post_build: {
            commands: [
              "echo 'Archiving transformed output to S3...'",
              "cd $CODEBUILD_SRC_DIR",
              "zip -r /tmp/transformed.zip .",
              "aws s3 cp /tmp/transformed.zip s3://$OUTPUT_BUCKET/results/transformed.zip",
            ],
          },
        },
        artifacts: {
          "base-directory": "$CODEBUILD_SRC_DIR",
          files: ["**/*"],
        },
      }),
      timeout: cdk.Duration.hours(2),
    });

    transformProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["transform-custom:*"],
        resources: [
          `arn:aws:transform-custom:${this.region}:${this.account}:*`,
          `arn:aws:transform-custom:${this.region}:${this.account}:transformation/*`,
        ],
      })
    );
    // ConverseStream and other streaming APIs may require resource "*"
    transformProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "transform-custom:ConverseStream",
          "transform-custom:Converse",
        ],
        resources: ["*"],
      })
    );
    outputBucket.grantReadWrite(transformProject);

    // ─── CodeBuild: Package Stage (Package code & publish Lambda version) ───
    const packageProject = new codebuild.PipelineProject(this, "PackageProject", {
      projectName: "atx-package-lambda",
      encryptionKey,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      environmentVariables: {
        FUNCTION_NAME: { value: appFunction.functionName },
        ALIAS_NAME: { value: "live" },
        OUTPUT_BUCKET: { value: outputBucket.bucketName },
        TARGET_RUNTIME: { value: targetRuntime },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            "runtime-versions": { python: "3.12" },
            commands: [
              "echo 'Packaging Lambda deployment...'",
              "if [ -f requirements.txt ]; then pip install -r requirements.txt -t .; fi",
            ],
          },
          build: {
            commands: [
              "echo 'Creating deployment package...'",
              "zip -r /tmp/lambda-package.zip . -x '*.git*' '__pycache__/*' '*.pyc'",
              "echo 'Updating Lambda function code...'",
              "aws lambda update-function-code --function-name $FUNCTION_NAME --zip-file fileb:///tmp/lambda-package.zip",
              "echo 'Waiting for code update to complete...'",
              "aws lambda wait function-updated --function-name $FUNCTION_NAME",
              "echo 'Upgrading Lambda runtime to $TARGET_RUNTIME...'",
              "aws lambda update-function-configuration --function-name $FUNCTION_NAME --runtime $TARGET_RUNTIME",
              "echo 'Waiting for configuration update to complete...'",
              "aws lambda wait function-updated --function-name $FUNCTION_NAME",
              "echo 'Publishing new version...'",
              "NEW_VERSION=$(aws lambda publish-version --function-name $FUNCTION_NAME --query 'Version' --output text)",
              "echo \"Published version: $NEW_VERSION\"",
              "echo 'Getting current alias version...'",
              "CURRENT_VERSION=$(aws lambda get-alias --function-name $FUNCTION_NAME --name $ALIAS_NAME --query 'FunctionVersion' --output text)",
              "echo \"Current alias version: $CURRENT_VERSION\"",
              "echo 'Generating AppSpec for CodeDeploy...'",
              "export CURRENT_VERSION NEW_VERSION",
              "python3 -c 'import json,os; appspec={\"version\":0.0,\"Resources\":[{\"myLambdaFunction\":{\"Type\":\"AWS::Lambda::Function\",\"Properties\":{\"Name\":os.environ[\"FUNCTION_NAME\"],\"Alias\":os.environ[\"ALIAS_NAME\"],\"CurrentVersion\":os.environ[\"CURRENT_VERSION\"],\"TargetVersion\":os.environ[\"NEW_VERSION\"]}}}]}; open(\"appspec.json\",\"w\").write(json.dumps(appspec))'",
              "cat appspec.json",
              "echo 'Archiving deployed artifact...'",
              "aws s3 cp /tmp/lambda-package.zip s3://$OUTPUT_BUCKET/deployed/lambda-$(date +%Y%m%d-%H%M%S).zip || true",
            ],
          },
        },
        artifacts: {
          files: ["appspec.json"],
        },
      }),
      timeout: cdk.Duration.minutes(15),
    });

    // Grant package project permissions for Lambda
    appFunction.grantInvoke(packageProject);
    outputBucket.grantReadWrite(packageProject);
    packageProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:PublishVersion",
          "lambda:GetAlias",
          "lambda:UpdateAlias",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
        ],
        resources: [
          appFunction.functionArn,
          `${appFunction.functionArn}:*`,
        ],
      })
    );

    // ─── SNS Topic with SSL enforcement (AwsSolutions-SNS3) ───
    const approvalTopic = new sns.Topic(this, "ApprovalTopic", {
      topicName: "atx-pipeline-approval",
      masterKey: encryptionKey,
    });

    approvalTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "EnforceSSLOnly",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["sns:Publish"],
        resources: [approvalTopic.topicArn],
        conditions: {
          Bool: { "aws:SecureTransport": "false" },
        },
      })
    );

    if (approvalEmail) {
      approvalTopic.addSubscription(
        new sns_subs.EmailSubscription(approvalEmail)
      );
    }

    // ─── Pipeline Artifacts ───
    const sourceOutput = new codepipeline.Artifact("SourceOutput");
    const transformOutput = new codepipeline.Artifact("TransformOutput");
    const packageOutput = new codepipeline.Artifact("PackageOutput");

    // ─── CodePipeline: Source → Transform → Approve → Package → Deploy ───
    const pipeline = new codepipeline.Pipeline(this, "AtxPipeline", {
      pipelineName: "atx-python-upgrade-pipeline",
      pipelineType: codepipeline.PipelineType.V2,
      artifactBucket,
      stages: [
        {
          stageName: "Source",
          actions: [
            new codepipeline_actions.CodeCommitSourceAction({
              actionName: "CodeCommit_Source",
              repository: repo,
              branch: "main",
              output: sourceOutput,
            }),
          ],
        },
        {
          stageName: "ATX_Transform",
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: "ATX_Transform",
              project: transformProject,
              input: sourceOutput,
              outputs: [transformOutput],
            }),
          ],
        },
        {
          stageName: "Manual_Approve",
          actions: [
            new codepipeline_actions.ManualApprovalAction({
              actionName: "Review_And_Approve",
              notificationTopic: approvalTopic,
              additionalInformation:
                `Review the ATX Python ${sourcePythonVersion} → ${targetPythonVersion} transformation results before deploying to Lambda via CodeDeploy.`,
            }),
          ],
        },
        {
          stageName: "Package",
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: "Package_Lambda",
              project: packageProject,
              input: transformOutput,
              outputs: [packageOutput],
            }),
          ],
        },
        {
          stageName: "Deploy",
          actions: [
            new codepipeline_actions.CodeDeployServerDeployAction({
              actionName: "CodeDeploy_Canary",
              deploymentGroup: deploymentGroup as any,
              input: packageOutput,
            }),
          ],
        },
      ],
    });

    // ─── cdk-nag Suppressions ───
    const cdkGeneratedS3Suppressions = [
      "Action::s3:GetObject*",
      "Action::s3:GetBucket*",
      "Action::s3:List*",
      "Action::s3:DeleteObject*",
      "Action::s3:Abort*",
    ];

    const cdkGeneratedKmsSuppressions = [
      "Action::kms:ReEncrypt*",
      "Action::kms:GenerateDataKey*",
    ];

    const s3WildcardReason =
      "CDK-generated S3 actions scoped to specific pipeline artifact/output bucket ARNs. " +
      "These wildcard action suffixes (e.g. s3:GetObject*) are standard CDK patterns for bucket grants.";

    const bucketArnWildcardReason =
      "CDK bucket.grant*() methods add /* to bucket ARN for object-level access. " +
      "This is scoped to the specific bucket, not all S3 resources.";

    const codebuildLogReason =
      "CDK auto-generates log group ARN with :* suffix for CodeBuild projects. " +
      "This is scoped to the specific project log group.";

    const codebuildReportReason =
      "CDK auto-generates report group ARN with -* suffix for CodeBuild projects. " +
      "This is scoped to the specific project report group.";

    // Suppress AwsSolutions-IAM5 on CDK-generated roles
    const rolePaths = [
      "/AtxPythonUpgradePipeline/TransformProject/Role/DefaultPolicy/Resource",
      "/AtxPythonUpgradePipeline/PackageProject/Role/DefaultPolicy/Resource",
      "/AtxPythonUpgradePipeline/AtxPipeline/Role/DefaultPolicy/Resource",
      "/AtxPythonUpgradePipeline/AtxPipeline/Source/CodeCommit_Source/CodePipelineActionRole/DefaultPolicy/Resource",
      "/AtxPythonUpgradePipeline/AtxPipeline/Deploy/CodeDeploy_Canary/CodePipelineActionRole/DefaultPolicy/Resource",
    ];

    for (const path of rolePaths) {
      NagSuppressions.addResourceSuppressionsByPath(this, path, [
        {
          id: "AwsSolutions-IAM5",
          reason: s3WildcardReason,
          appliesTo: cdkGeneratedS3Suppressions,
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "CDK KMS grant methods generate kms:ReEncrypt* and kms:GenerateDataKey* actions " +
            "scoped to the specific KMS key ARN.",
          appliesTo: cdkGeneratedKmsSuppressions,
        },
        {
          id: "AwsSolutions-IAM5",
          reason: bucketArnWildcardReason,
          appliesTo: [
            "Resource::<ArtifactBucket7410C9EF.Arn>/*",
            "Resource::<OutputBucket7114EB27.Arn>/*",
          ],
        },
        {
          id: "AwsSolutions-IAM5",
          reason: codebuildLogReason,
          appliesTo: [
            { regex: "/Resource::arn:<AWS::Partition>:logs:.*:log-group:/aws/codebuild/.*:\\*/g" } as any,
          ],
        },
        {
          id: "AwsSolutions-IAM5",
          reason: codebuildReportReason,
          appliesTo: [
            { regex: "/Resource::arn:<AWS::Partition>:codebuild:.*:report-group/.*-\\*/g" } as any,
          ],
        },
        {
          id: "AwsSolutions-IAM5",
          reason: "Resource::* required for service-level actions like ecr:GetAuthorizationToken or lambda:GetFunction.",
          appliesTo: ["Resource::*"],
        },
      ]);
    }

    // Transform project: ATX transform-custom resource ARN wildcard
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      "/AtxPythonUpgradePipeline/TransformProject/Role/DefaultPolicy/Resource",
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "ATX transform-custom requires broad permissions for publish, exec, and related API calls. " +
            "Wildcard scoped to arn:aws:transform-custom:<region>:<account>:*.",
          appliesTo: [
            `Resource::arn:aws:transform-custom:${this.region}:<AWS::AccountId>:*`,
            { regex: "/Resource::arn:aws:transform-custom:.*:.*:\\*/g" } as any,
            { regex: "/Resource::arn:aws:transform-custom:.*:.*:transformation/.*/g" } as any,
          ],
        },
        {
          id: "AwsSolutions-IAM5",
          reason: "transform-custom:* actions needed for publish, exec, and status polling of transformation definitions.",
          appliesTo: ["Action::transform-custom:*"],
        },
      ]
    );

    // Package project: Lambda ARN with :* for versions
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      "/AtxPythonUpgradePipeline/PackageProject/Role/DefaultPolicy/Resource",
      [
        {
          id: "AwsSolutions-IAM5",
          reason: "Lambda function ARN with :* suffix is needed to manage versions and aliases.",
          appliesTo: [
            { regex: "/Resource::<AppFunction.*\\.Arn>:\\*/g" } as any,
            { regex: "/Resource::arn:aws:codedeploy:.*:.*:deploymentconfig:\\*/g" } as any,
          ],
        },
      ]
    );

    // Manual approval action role: KMS actions for encrypted SNS topic
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      "/AtxPythonUpgradePipeline/AtxPipeline/Manual_Approve/Review_And_Approve/CodePipelineActionRole/DefaultPolicy/Resource",
      [
        {
          id: "AwsSolutions-IAM5",
          reason: "CDK generates kms:GenerateDataKey* for publishing to KMS-encrypted SNS topic.",
          appliesTo: cdkGeneratedKmsSuppressions,
        },
      ]
    );

    // AwsSolutions-CB5: Custom image required for ATX transform CLI
    NagSuppressions.addResourceSuppressions(transformProject, [
      {
        id: "AwsSolutions-CB5",
        reason:
          "ATX transform project requires the aws-transform-custom Docker image from public ECR " +
          "which contains the ATX CLI tooling not available in standard CodeBuild images.",
      },
    ]);

    // CodeDeploy service role: CDK-managed
    NagSuppressions.addResourceSuppressions(
      deploymentGroup,
      [
        {
          id: "AwsSolutions-IAM4",
          reason: "CodeDeploy Lambda deployment group uses AWS managed policy for Lambda deployment operations.",
          appliesTo: [
            "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSCodeDeployRoleForLambdaLimited",
          ],
        },
        {
          id: "AwsSolutions-IAM5",
          reason: s3WildcardReason,
          appliesTo: cdkGeneratedS3Suppressions,
        },
        {
          id: "AwsSolutions-IAM5",
          reason: bucketArnWildcardReason,
          appliesTo: ["Resource::<ArtifactBucket7410C9EF.Arn>/*"],
        },
      ],
      true
    );

    // Lambda function: placeholder runtime and managed execution role
    NagSuppressions.addResourceSuppressions(appFunction, [
      {
        id: "AwsSolutions-L1",
        reason:
          `Lambda starts at Python ${sourcePythonVersion} intentionally. The pipeline upgrades both the code (via ATX Transform) ` +
          `and the runtime (via Package stage) to Python ${targetPythonVersion} as part of the CI/CD flow.`,
      },
    ]);

    NagSuppressions.addResourceSuppressions(
      appFunction,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "CDK Lambda construct uses AWSLambdaBasicExecutionRole for CloudWatch Logs access. " +
            "This is the standard minimal execution role for Lambda functions.",
          appliesTo: [
            "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          ],
        },
      ],
      true
    );

    // BucketDeployment custom resource Lambda suppressions
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      "/AtxPythonUpgradePipeline/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/ServiceRole/Resource",
      [
        {
          id: "AwsSolutions-IAM4",
          reason: "CDK BucketDeployment uses AWSLambdaBasicExecutionRole. This is a CDK-managed custom resource.",
          appliesTo: [
            "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          ],
        },
      ]
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      "/AtxPythonUpgradePipeline/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/ServiceRole/DefaultPolicy/Resource",
      [
        {
          id: "AwsSolutions-IAM5",
          reason: s3WildcardReason,
          appliesTo: cdkGeneratedS3Suppressions,
        },
        {
          id: "AwsSolutions-IAM5",
          reason: "CDK KMS grant methods for encrypted bucket access.",
          appliesTo: cdkGeneratedKmsSuppressions,
        },
        {
          id: "AwsSolutions-IAM5",
          reason: bucketArnWildcardReason,
          appliesTo: ["Resource::<OutputBucket7114EB27.Arn>/*"],
        },
        {
          id: "AwsSolutions-IAM5",
          reason: "CDK BucketDeployment reads assets from the CDK bootstrap bucket.",
          appliesTo: [
            { regex: "/Resource::arn:<AWS::Partition>:s3:::cdk-.*-assets-.*-.*/.*/g" } as any,
          ],
        },
      ]
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      "/AtxPythonUpgradePipeline/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/Resource",
      [
        {
          id: "AwsSolutions-L1",
          reason: "CDK BucketDeployment Lambda runtime is controlled by the CDK framework.",
        },
      ]
    );

    // ─── Stack Outputs ───
    new cdk.CfnOutput(this, "PipelineName", {
      value: pipeline.pipelineName,
      description: "CodePipeline name",
    });
    new cdk.CfnOutput(this, "RepositoryCloneUrl", {
      value: repo.repositoryCloneUrlHttp,
      description: "CodeCommit repository clone URL",
    });
    new cdk.CfnOutput(this, "OutputBucketName", {
      value: outputBucket.bucketName,
      description: "S3 bucket for transformation outputs",
    });
    new cdk.CfnOutput(this, "LambdaFunctionName", {
      value: appFunction.functionName,
      description: "Lambda function name",
    });
    new cdk.CfnOutput(this, "LambdaFunctionArn", {
      value: appFunction.functionArn,
      description: "Lambda function ARN",
    });
    new cdk.CfnOutput(this, "CodeDeployApp", {
      value: deploymentGroup.application.applicationName,
      description: "CodeDeploy application name",
    });
    new cdk.CfnOutput(this, "CodeDeployGroup", {
      value: deploymentGroup.deploymentGroupName,
      description: "CodeDeploy deployment group name",
    });
    new cdk.CfnOutput(this, "ApprovalTopicArn", {
      value: approvalTopic.topicArn,
      description: "SNS topic for pipeline approval notifications",
    });
  }
}
