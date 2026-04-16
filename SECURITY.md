# Security

## Reporting a Vulnerability

If you discover a potential security issue in this project, please refer to the [AWS Vulnerability Reporting](https://aws.amazon.com/security/vulnerability-reporting/) page.

## Production Deployment Considerations

This project is designed as a blog/demo reference implementation. The following items are accepted security debt for this context and should be reviewed before production use.

### Accepted Security Debt

#### 1. `transform-custom:ConverseStream/Converse` with `Resource: "*"`

The ATX streaming APIs (`ConverseStream`, `Converse`) do not support resource-level permissions. `Resource: "*"` is required for these actions to function. This is an AWS service limitation, not a misconfiguration.

#### 2. `transform-custom:*` wildcard scoped to account/region ARN

The ATX CLI calls multiple internal APIs during `publish`, `exec`, and status polling. The full API surface is not publicly documented, so specific action enumeration risks breaking the transform when the API evolves. The wildcard is scoped to `arn:aws:transform-custom:<region>:<account>:*`, limiting access to the deploying account and region only.

#### 3. Lambda environment variables and CloudWatch Logs using default encryption

The Lambda function's environment variables (`PYTHON_VERSION`, `APP_ENV`) contain non-sensitive configuration values only. CloudWatch Logs for the Lambda use default encryption. For production workloads with sensitive data, consider using KMS CMK encryption for both Lambda environment variables and CloudWatch Log groups.

#### 4. `deploy.sh` uses `--require-approval never`

The convenience deploy script skips CDK deployment approval prompts. This is intentional for demo/blog use to simplify the deployment experience. For production deployments, remove the `--require-approval never` flag and review CloudFormation changesets before applying.

### Security Controls in Place

- All S3 buckets enforce SSL (`enforceSSL: true`) and are encrypted with a KMS key with rotation enabled
- SNS topic is KMS-encrypted with a resource policy denying non-SSL publishes
- CodeBuild artifacts are encrypted with the shared KMS key
- IAM policies are scoped to specific resource ARNs wherever possible
- `cdk-nag` (`AwsSolutionsChecks`) runs at synth time to catch security issues
- Pipeline includes a manual approval gate before deploying transformed code
- CodeDeploy uses canary deployment with CloudWatch alarm-based auto-rollback
