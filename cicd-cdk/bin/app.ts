#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { AtxPipelineStack } from "../lib/pipeline-stack";

const app = new cdk.App();

new AtxPipelineStack(app, "AtxPythonUpgradePipeline", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-east-1",
  },
});

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

app.synth();
