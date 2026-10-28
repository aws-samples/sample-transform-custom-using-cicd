# Security

## Reporting a Vulnerability

If you discover a potential security issue in this project, please refer to the [AWS Vulnerability Reporting](https://aws.amazon.com/security/vulnerability-reporting/) page.

## Production Deployment Considerations

This project is designed as a blog/demo reference implementation. The following items are accepted security debt for this context and should be reviewed before production use.

### Accepted Security Debt

#### 1. GitHub personal access token used by AWS Transform continuous modernization

CM authenticates to GitHub with a personal access token (classic, `repo` scope) supplied to `atx ct source add`. The token can read and write every repository the owning account can access. Prefer a token from a dedicated machine user limited to the target repositories, keep its expiry short, and never paste it into chat, scripts, or shell history (the README uses `read -s`). The CDK stack itself never handles this token; the pipelines reach GitHub through an AWS CodeConnections connection.

#### 2. CI results are not enforced as a GitHub status check

The pull request pipeline reports results in CodePipeline only. Configure branch protection on the tracked branch (required pull request review) so only reviewed merges reach the deploy pipeline.

#### 3. Lambda environment variables and CloudWatch Logs using default encryption

The Lambda function's environment variables (`PYTHON_VERSION`, `APP_ENV`) contain non-sensitive configuration values only. CloudWatch Logs for the Lambda use default encryption. For production workloads with sensitive data, consider using KMS CMK encryption for both Lambda environment variables and CloudWatch Log groups.

#### 4. `deploy.sh` uses `--require-approval never`

The convenience deploy script skips CDK deployment approval prompts. This is intentional for demo/blog use to simplify the deployment experience. For production deployments, remove the `--require-approval never` flag and review CloudFormation changesets before applying.

### Security Controls in Place

- All S3 buckets enforce SSL (`enforceSSL: true`) and are encrypted with a KMS key with rotation enabled
- CodeBuild artifacts are encrypted with the shared KMS key
- IAM policies are scoped to specific resource ARNs wherever possible
- `cdk-nag` (`AwsSolutionsChecks`) runs at synth time to catch security issues
- GitHub access from the pipelines uses AWS CodeConnections; no Git credentials are stored in the stack
- CM-remediated code reaches deployment only through a GitHub pull request, which is the human review gate
- Every change is tested on the target Python version before packaging
- CodeDeploy uses canary deployment with CloudWatch alarm-based auto-rollback
