#!/bin/bash
set -e

echo "=== ATX Python Upgrade Pipeline - CDK Deployment ==="

# Set account and region
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_ACCOUNT=$AWS_ACCOUNT_ID
export CDK_DEFAULT_REGION=${AWS_REGION:-us-east-1}

echo "Account: $AWS_ACCOUNT_ID"
echo "Region:  $CDK_DEFAULT_REGION"

# Install dependencies
npm install

# Bootstrap CDK (first time only)
npx cdk bootstrap aws://$AWS_ACCOUNT_ID/$CDK_DEFAULT_REGION

# Deploy the stack
npx cdk deploy --all --require-approval never

echo ""
echo "=== Deployment Complete ==="
echo "Next steps:"
echo "  1. Push your Python code to the CodeCommit repo (see RepositoryCloneUrl output)"
echo "  2. The pipeline will automatically trigger: Source → ATX Transform → Validate → Approve → Deploy to ECS"
echo "  3. Run 'npx cdk output --all' to see stack outputs"
