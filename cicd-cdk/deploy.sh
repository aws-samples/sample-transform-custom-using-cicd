#!/bin/bash
set -e

echo "=== CM Python Upgrade Pipeline - CDK Deployment ==="

if [ -z "$GITHUB_OWNER" ] || [ -z "$GITHUB_REPO" ]; then
  echo "Set GITHUB_OWNER and GITHUB_REPO first, e.g.:"
  echo "  GITHUB_OWNER=my-org GITHUB_REPO=todo-manager ./deploy.sh"
  exit 1
fi

# Set account and region
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_ACCOUNT=$AWS_ACCOUNT_ID
export CDK_DEFAULT_REGION=${AWS_REGION:-us-east-1}

echo "Account: $AWS_ACCOUNT_ID"
echo "Region:  $CDK_DEFAULT_REGION"
echo "Repo:    $GITHUB_OWNER/$GITHUB_REPO@${GITHUB_BRANCH:-main}"

# Install dependencies
npm install

# Bootstrap CDK (first time only)
npx cdk bootstrap aws://$AWS_ACCOUNT_ID/$CDK_DEFAULT_REGION

CONTEXT_ARGS=(
  --context "githubOwner=$GITHUB_OWNER"
  --context "githubRepo=$GITHUB_REPO"
  --context "githubBranch=${GITHUB_BRANCH:-main}"
)
if [ -n "$CONNECTION_ARN" ]; then
  CONTEXT_ARGS+=(--context "connectionArn=$CONNECTION_ARN")
fi

# Deploy the stack
npx cdk deploy --all --require-approval never "${CONTEXT_ARGS[@]}"

echo ""
echo "=== Deployment Complete ==="
echo "Next steps:"
echo "  1. Activate the GitHub connection in the console if this stack created it (see GitHubConnectionArn output)"
echo "  2. Run CM analysis and remediation against the repo; CM opens a pull request"
echo "  3. The PR triggers cm-python-upgrade-pr-ci: Source → Test"
echo "  4. Merging the PR triggers cm-python-upgrade-pipeline: Source → Test → Package → Deploy (CodeDeploy canary)"
echo "  5. See stack outputs: aws cloudformation describe-stacks --stack-name CmPythonUpgradePipeline --query 'Stacks[0].Outputs' --output table"
