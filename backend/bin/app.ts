#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack';

const app = new cdk.App();

new AppStack(app, 'RiddleDemoStack', {
  env: {
    account: '136311627418',
    region: 'us-east-1',
  },
});

cdk.Tags.of(app).add('project', 'riddle-demo');
