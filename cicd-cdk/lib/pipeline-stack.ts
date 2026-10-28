import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as codedeploy from "aws-cdk-lib/aws-codedeploy";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as codestarconnections from "aws-cdk-lib/aws-codestarconnections";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

/**
 * CI/CD for code remediated by AWS Transform continuous modernization (CM).
 *
 * CM (driven from the `atx ct` CLI, outside this stack) analyzes the GitHub
 * repository and opens a remediation pull request. This stack provides what
 * CM does not: CI on that pull request and a canary deployment once it merges.
 *
 *   PR opened/updated -> PullRequestPipeline: Source -> Test
 *   Push to branch    -> DeployPipeline:      Source -> Test -> Package -> Deploy (CodeDeploy canary)
 */
export class CmPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── Context Parameters ───
    const githubOwner: string = this.node.tryGetContext("githubOwner") || "";
    const githubRepo: string = this.node.tryGetContext("githubRepo") || "";
    const githubBranch: string = this.node.tryGetContext("githubBranch") || "main";
    const existingConnectionArn: string = this.node.tryGetContext("connectionArn") || "";
    const sourcePythonVersion: string = this.node.tryGetContext("sourcePythonVersion") || "3.9";
    const targetPythonVersion: string = this.node.tryGetContext("targetPythonVersion") || "3.13";
    const targetRuntime = `python${targetPythonVersion}`;

    if (!githubOwner || !githubRepo) {
      throw new Error(
        "githubOwner and githubRepo context values are required, e.g. " +
          "--context githubOwner=my-org --context githubRepo=todo-manager"
      );
    }

    // Supported range of the AWS managed transformation AWS/python-version-upgrade
    const validSourceVersions = ["3.8", "3.9", "3.10"];
    const validTargetVersions = ["3.11", "3.12", "3.13"];
    if (!validSourceVersions.includes(sourcePythonVersion)) {
      throw new Error(`sourcePythonVersion must be one of ${validSourceVersions.join(", ")}. Got: ${sourcePythonVersion}`);
    }
    if (!validTargetVersions.includes(targetPythonVersion)) {
      throw new Error(`targetPythonVersion must be one of ${validTargetVersions.join(", ")}. Got: ${targetPythonVersion}`);
    }

    const runtimeMap: Record<string, lambda.Runtime> = {
      "3.8": lambda.Runtime.PYTHON_3_8,
      "3.9": lambda.Runtime.PYTHON_3_9,
      "3.10": lambda.Runtime.PYTHON_3_10,
    };
    const sourceRuntime = runtimeMap[sourcePythonVersion];

    // ─── GitHub connection (AWS CodeConnections) ───
    // A connection created here starts in PENDING state and must be activated
    // once in the console (Developer Tools → Settings → Connections).
    let connectionArn = existingConnectionArn;
    if (!connectionArn) {
      const connection = new codestarconnections.CfnConnection(this, "GitHubConnection", {
        connectionName: "cm-python-upgrade-github",
        providerType: "GitHub",
      });
      connectionArn = connection.attrConnectionArn;
    }

    // ─── KMS Key for encryption ───
    const encryptionKey = new kms.Key(this, "PipelineKey", {
      alias: "cm-pipeline-key",
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      description: "KMS key for the CM CI/CD pipeline (CodeBuild, S3)",
    });

    // ─── S3 Buckets ───
    const accessLogsBucket = new s3.Bucket(this, "AccessLogsBucket", {
      bucketName: `cm-access-logs-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      encryptionKey,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
    });

    const artifactBucket = new s3.Bucket(this, "ArtifactBucket", {
      bucketName: `cm-pipeline-artifacts-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      encryptionKey,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "artifact-bucket/",
    });

    const outputBucket = new s3.Bucket(this, "OutputBucket", {
      bucketName: `cm-output-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      encryptionKey,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "output-bucket/",
    });

    // ─── Lambda Function ───
    const lambdaLogGroup = new logs.LogGroup(this, "AppLogGroup", {
      logGroupName: "/aws/lambda/cm-python-app",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    const appFunction = new lambda.Function(this, "AppFunction", {
      functionName: "cm-python-app",
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
      alarmName: "cm-python-app-errors",
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

    // ─── CodeBuild: Test Stage (CI on the target Python version) ───
    // Shared by the pull request pipeline and the deploy pipeline.
    const testProject = new codebuild.PipelineProject(this, "TestProject", {
      projectName: "cm-python-test",
      encryptionKey,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            "runtime-versions": { python: targetPythonVersion },
            commands: [
              "python --version",
              "python -m venv /tmp/venv",
              "/tmp/venv/bin/pip install --upgrade pip",
              "if [ -f requirements.txt ]; then /tmp/venv/bin/pip install -r requirements.txt; fi",
            ],
          },
          build: {
            commands: [
              "echo 'Compiling all sources on the target Python version...'",
              "/tmp/venv/bin/python -m compileall -q -x '(^|/)(\\.git|\\.venv|venv)/' .",
              "if ls test_*.py *_test.py tests 1>/dev/null 2>&1; then /tmp/venv/bin/pip install pytest && /tmp/venv/bin/python -m pytest; else echo 'No tests found, skipping pytest'; fi",
            ],
          },
        },
      }),
      timeout: cdk.Duration.minutes(15),
    });

    // ─── CodeBuild: Package Stage (Package code & publish Lambda version) ───
    const packageProject = new codebuild.PipelineProject(this, "PackageProject", {
      projectName: "cm-package-lambda",
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
            "runtime-versions": { python: targetPythonVersion },
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
              "echo \"Upgrading Lambda runtime to $TARGET_RUNTIME...\"",
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

    // ─── Pipeline 1: CI on pull requests (e.g. CM remediation PRs) ───
    const prSourceOutput = new codepipeline.Artifact("PrSourceOutput");
    const prSourceAction = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: "GitHub_Source",
      connectionArn,
      owner: githubOwner,
      repo: githubRepo,
      branch: githubBranch,
      output: prSourceOutput,
    });

    const prPipeline = new codepipeline.Pipeline(this, "PullRequestPipeline", {
      pipelineName: "cm-python-upgrade-pr-ci",
      pipelineType: codepipeline.PipelineType.V2,
      executionMode: codepipeline.ExecutionMode.PARALLEL,
      artifactBucket,
      stages: [
        { stageName: "Source", actions: [prSourceAction] },
        {
          stageName: "Test",
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: "Test_Target_Python",
              project: testProject,
              input: prSourceOutput,
            }),
          ],
        },
      ],
      triggers: [
        {
          providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
          gitConfiguration: {
            sourceAction: prSourceAction,
            pullRequestFilter: [
              {
                branchesIncludes: [githubBranch],
                events: [
                  codepipeline.GitPullRequestEvent.OPEN,
                  codepipeline.GitPullRequestEvent.UPDATED,
                ],
              },
            ],
          },
        },
      ],
    });

    // ─── Pipeline 2: Deploy on merge (push to the tracked branch) ───
    const sourceOutput = new codepipeline.Artifact("SourceOutput");
    const packageOutput = new codepipeline.Artifact("PackageOutput");
    const sourceAction = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: "GitHub_Source",
      connectionArn,
      owner: githubOwner,
      repo: githubRepo,
      branch: githubBranch,
      output: sourceOutput,
    });

    const pipeline = new codepipeline.Pipeline(this, "DeployPipeline", {
      pipelineName: "cm-python-upgrade-pipeline",
      pipelineType: codepipeline.PipelineType.V2,
      artifactBucket,
      stages: [
        { stageName: "Source", actions: [sourceAction] },
        {
          stageName: "Test",
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: "Test_Target_Python",
              project: testProject,
              input: sourceOutput,
            }),
          ],
        },
        {
          stageName: "Package",
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: "Package_Lambda",
              project: packageProject,
              input: sourceOutput,
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
      triggers: [
        {
          providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
          gitConfiguration: {
            sourceAction,
            pushFilter: [{ branchesIncludes: [githubBranch] }],
          },
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

    // Suppress AwsSolutions-IAM5 on CDK-generated roles of the projects and pipelines
    for (const construct of [testProject, packageProject, prPipeline, pipeline]) {
      NagSuppressions.addResourceSuppressions(
        construct,
        [
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
            reason: "Resource::* required for service-level actions like lambda:GetFunction.",
            appliesTo: ["Resource::*"],
          },
        ],
        true
      );
    }

    // Package project: Lambda ARN with :* for versions
    NagSuppressions.addResourceSuppressions(
      packageProject,
      [
        {
          id: "AwsSolutions-IAM5",
          reason: "Lambda function ARN with :* suffix is needed to manage versions and aliases.",
          appliesTo: [
            { regex: "/Resource::<AppFunction.*\\.Arn>:\\*/g" } as any,
            { regex: "/Resource::arn:aws:codedeploy:.*:.*:deploymentconfig:\\*/g" } as any,
          ],
        },
      ],
      true
    );

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
          `Lambda starts at Python ${sourcePythonVersion} intentionally. CM remediates the code to Python ` +
          `${targetPythonVersion}, and the Package stage upgrades the runtime as part of the CI/CD flow.`,
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

    // ─── Stack Outputs ───
    new cdk.CfnOutput(this, "DeployPipelineName", {
      value: pipeline.pipelineName,
      description: "Deploy pipeline (runs on push/merge to the tracked branch)",
    });
    new cdk.CfnOutput(this, "PullRequestPipelineName", {
      value: prPipeline.pipelineName,
      description: "CI pipeline (runs on pull requests, e.g. CM remediation PRs)",
    });
    new cdk.CfnOutput(this, "GitHubConnectionArn", {
      value: connectionArn,
      description: "CodeConnections ARN. If created by this stack, activate it once in the console.",
    });
    new cdk.CfnOutput(this, "GitHubRepository", {
      value: `${githubOwner}/${githubRepo}@${githubBranch}`,
      description: "GitHub repository and branch tracked by the pipelines",
    });
    new cdk.CfnOutput(this, "OutputBucketName", {
      value: outputBucket.bucketName,
      description: "S3 bucket for deployed artifacts",
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
  }
}
