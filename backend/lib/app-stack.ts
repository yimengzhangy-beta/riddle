import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

/**
 * Shared with the co-founder app — created out of band with the AWS CLI so the key
 * value never passes through CloudFormation. See README §1. The stack only reads it.
 */
const ANTHROPIC_SECRET_NAME = 'cofounder/anthropic-api-key';

/** Members of this Cognito group may call POST /admin/*. */
const ADMIN_GROUP = 'admins';

export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------- Cognito

    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev convenience; switch to RETAIN for production
    });

    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: ADMIN_GROUP,
      description: 'May call the riddle-generation admin endpoints',
    });

    // Public client (no secret) so curl can call InitiateAuth without a SECRET_HASH.
    const userPoolClient = userPool.addClient('ApiClient', {
      authFlows: { userPassword: true },
      generateSecret: false,
      accessTokenValidity: cdk.Duration.hours(12),
      idTokenValidity: cdk.Duration.hours(12),
    });

    // --------------------------------------------------------------- DynamoDB

    // Single table. See src/db/client.ts for the full key layout.
    const table = new dynamodb.Table(this, 'RiddleTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev convenience; switch to RETAIN for production
    });

    // Lets GET /riddles/next page riddles of one difficulty without a table scan.
    table.addGlobalSecondaryIndex({
      indexName: 'byDifficulty',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ----------------------------------------------------------------- Lambda

    // Anthropic API key. Referenced by name — the secret is created with the AWS
    // CLI so the key value never passes through CloudFormation.
    const anthropicSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'AnthropicApiKey',
      ANTHROPIC_SECRET_NAME
    );

    const apiHandler = new NodejsFunction(this, 'ApiHandler', {
      entry: 'src/handler.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 1024,
      // A guess makes at most one Anthropic call; admin generation makes one call
      // for the whole batch. API Gateway caps the integration at 30s — the Lambda
      // is given longer so a slow batch still lands in DynamoDB even if the client
      // sees a 504, and the riddles are queryable afterwards.
      timeout: cdk.Duration.seconds(90),
      environment: {
        TABLE_NAME: table.tableName,
        DIFFICULTY_INDEX: 'byDifficulty',
        ANTHROPIC_SECRET_NAME,
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        ADMIN_GROUP,
      },
      bundling: {
        // Ship the judge/generation prompt files as inlined strings.
        loader: { '.txt': 'text' },
      },
    });

    table.grantReadWriteData(apiHandler);
    anthropicSecret.grantRead(apiHandler);

    // Signup confirms the account server-side so a curl session needs no emailed code.
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:SignUp',
          'cognito-idp:InitiateAuth',
          'cognito-idp:AdminConfirmSignUp',
          'cognito-idp:AdminUpdateUserAttributes',
        ],
        resources: [userPool.userPoolArn],
      })
    );

    // --------------------------------------------------------------- HTTP API

    const integration = new HttpLambdaIntegration('ApiIntegration', apiHandler);

    // Validates a Cognito token against the pool's issuer. API Gateway special-cases
    // Cognito here: it matches an ID token's `aud` *or* an access token's `client_id`
    // against jwtAudience, so both are accepted. Clients should send the ID token —
    // it is the one carrying `email` and `cognito:groups`, which the handler reads.
    const authorizer = new HttpJwtAuthorizer(
      'JwtAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      {
        jwtAudience: [userPoolClient.userPoolClientId],
        identitySource: ['$request.header.Authorization'],
      }
    );

    const api = new apigwv2.HttpApi(this, 'Api', {
      defaultAuthorizer: authorizer, // every route below is protected unless it opts out
      corsPreflight: {
        allowOrigins: ['*'], // tighten to your Amplify domain later
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const open = { authorizer: new apigwv2.HttpNoneAuthorizer() };

    // Public — these are how you obtain a token in the first place.
    api.addRoutes({ path: '/health', methods: [apigwv2.HttpMethod.GET], integration, ...open });
    api.addRoutes({ path: '/signup', methods: [apigwv2.HttpMethod.POST], integration, ...open });
    api.addRoutes({ path: '/login', methods: [apigwv2.HttpMethod.POST], integration, ...open });

    // Authenticated.
    api.addRoutes({ path: '/me', methods: [apigwv2.HttpMethod.GET], integration });
    api.addRoutes({ path: '/riddles/next', methods: [apigwv2.HttpMethod.GET], integration });
    api.addRoutes({ path: '/riddles/{id}/guess', methods: [apigwv2.HttpMethod.POST], integration });
    api.addRoutes({ path: '/riddles/{id}/hint', methods: [apigwv2.HttpMethod.POST], integration });
    // Authenticated *and* gated on the `admins` group inside the handler.
    api.addRoutes({ path: '/admin/generate', methods: [apigwv2.HttpMethod.POST], integration });

    // Steady-state ceiling with headroom above 300 TPS.
    const stage = api.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 500, throttlingBurstLimit: 1000 };

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'AnthropicSecretName', { value: ANTHROPIC_SECRET_NAME });
  }
}
