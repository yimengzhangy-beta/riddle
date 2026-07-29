import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

/**
 * Shared with the co-founder app — created out of band with the AWS CLI so the key
 * value never passes through CloudFormation. See README §1. The stack only reads it.
 */
const ANTHROPIC_SECRET_NAME = 'cofounder/anthropic-api-key';

/** Members of this Cognito group may call POST /admin/*. */
const ADMIN_GROUP = 'admins';

/**
 * Fixed so the log group is `/aws/lambda/riddle-api` rather than a generated
 * name that changes whenever the construct is replaced.
 */
const FUNCTION_NAME = 'riddle-api';

/** 90 days, for both the Lambda audit log and the API Gateway access log. */
const LOG_RETENTION = logs.RetentionDays.THREE_MONTHS;

/**
 * The AWS Monetization app these plans and metrics live under. The control
 * plane is us-east-1 regardless of where this stack is deployed — that region
 * is a property of the service, not of the app.
 */
const MONETIZATION_APP_ID = '0c07accf-9932-4c68-a048-7564bea6a505';
const MONETIZATION_REGION = 'us-east-1';

/**
 * The endpoint these plans were created against. The SDK's built-in default is a
 * different host and does not resolve, so this is required rather than optional.
 */
const MONETIZATION_ENDPOINT = 'https://us-east-1.monetization.aws.dev';

/**
 * Where the web app is served from — the origin a player's browser returns to
 * after paying. This is the Amplify URL, not the API's: the Lambda cannot infer
 * it from a request, because its own origin is API Gateway. Override at synth
 * time once the frontend has a domain:
 *
 *   APP_BASE_URL=https://main.xxxx.amplifyapp.com npx cdk deploy
 */
const APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:5173';

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

    // Owned by the stack rather than auto-created by Lambda, which is the only way
    // to put a retention policy on it. Holds the structured audit events.
    const handlerLogGroup = new logs.LogGroup(this, 'ApiHandlerLogGroup', {
      logGroupName: `/aws/lambda/${FUNCTION_NAME}`,
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev convenience; switch to RETAIN for production
    });

    const apiHandler = new NodejsFunction(this, 'ApiHandler', {
      functionName: FUNCTION_NAME,
      logGroup: handlerLogGroup,
      entry: 'src/handler.ts',
      handler: 'handler',
      // 24, not 22: @aws-monetization/sdk declares engines.node >= 24.
      runtime: lambda.Runtime.NODEJS_24_X,
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
        MONETIZATION_APP_ID,
        MONETIZATION_REGION,
        MONETIZATION_ENDPOINT,
        // Set to 'false' to keep every route open while checking that metering
        // works on its own. Any other value (or none) enforces entitlement.
        MONETIZATION_ENFORCE: 'true',
        APP_BASE_URL,
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

    // AWS Monetization runtime calls: entitlement gates, usage metering, the
    // pricing page, and checkout.
    //
    // `resources: ['*']` is deliberate, not an oversight. These operations are
    // not resource-scoped by the service in its current form: every attempt to
    // narrow to the app — `app/<id>`, `app/<id>/*`, account-wide, or any other
    // arn:aws:monetization:… pattern — is rejected with AccessDeniedException,
    // while the same call under `*` succeeds. IAM's own policy simulator reports
    // the app-scoped ARN as `allowed`, so the mismatch is in what the service
    // authorises against, not in the policy document.
    //
    // Least privilege is kept where it still bites: the seven actions below are
    // exactly the ones the app calls, so this role cannot create, publish or
    // archive plans and metrics. Narrow `resources` to the app ARN once the
    // service supports it.
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'monetization:GetEntitlementDecision',
          'monetization:PutEvent',
          'monetization:PutAwsServiceEvent',
          'monetization:ListPlans',
          'monetization:CreateCheckoutSession',
          'monetization:CancelSubscription',
          'monetization:GetSubscription',
        ],
        resources: ['*'],
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
    // Public: the pricing page has to render before a visitor has an account.
    api.addRoutes({ path: '/plans', methods: [apigwv2.HttpMethod.GET], integration, ...open });
    api.addRoutes({ path: '/signup', methods: [apigwv2.HttpMethod.POST], integration, ...open });
    api.addRoutes({ path: '/login', methods: [apigwv2.HttpMethod.POST], integration, ...open });

    // Authenticated.
    api.addRoutes({ path: '/me', methods: [apigwv2.HttpMethod.GET], integration });
    api.addRoutes({ path: '/subscription', methods: [apigwv2.HttpMethod.GET], integration });
    api.addRoutes({
      path: '/subscription/summary',
      methods: [apigwv2.HttpMethod.GET],
      integration,
    });
    api.addRoutes({ path: '/subscribe', methods: [apigwv2.HttpMethod.POST], integration });
    api.addRoutes({ path: '/riddles/next', methods: [apigwv2.HttpMethod.GET], integration });
    api.addRoutes({ path: '/riddles/{id}/guess', methods: [apigwv2.HttpMethod.POST], integration });
    api.addRoutes({ path: '/riddles/{id}/hint', methods: [apigwv2.HttpMethod.POST], integration });
    // Authenticated *and* gated on the `admins` group inside the handler.
    api.addRoutes({ path: '/admin/generate', methods: [apigwv2.HttpMethod.POST], integration });

    // Steady-state ceiling with headroom above 300 TPS.
    const stage = api.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 500, throttlingBurstLimit: 1000 };

    // ------------------------------------------------------- access logging

    /**
     * Its own group, because the requests worth having here are the ones the
     * Lambda never sees: a rejected JWT is a 401 from the authorizer, so it
     * leaves no `request` event behind. `$context.requestId` is the same id the
     * handler stamps on its events, so the two groups join on it.
     *
     * Fields are metadata only — no request body, no query string.
     */
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogGroup', {
      logGroupName: `/aws/apigateway/${FUNCTION_NAME}-access`,
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev convenience; switch to RETAIN for production
    });

    stage.accessLogSettings = {
      destinationArn: accessLogGroup.logGroupArn,
      format: JSON.stringify({
        event: 'access',
        requestId: '$context.requestId',
        ts: '$context.requestTime',
        method: '$context.httpMethod',
        route: '$context.routeKey',
        path: '$context.path',
        status: '$context.status',
        integrationStatus: '$context.integrationStatus',
        integrationErrorMessage: '$context.integrationErrorMessage',
        authorizerError: '$context.authorizer.error',
        errorMessage: '$context.error.message',
        // Present only once the authorizer has accepted the token.
        userId: '$context.authorizer.claims.sub',
        responseLatencyMs: '$context.responseLatency',
        responseLength: '$context.responseLength',
        sourceIp: '$context.identity.sourceIp',
        userAgent: '$context.identity.userAgent',
      }),
    };

    // ------------------------------------------------- saved Insights queries

    const savedQuery = (id: string, name: string, logGroupNames: string[], queryString: string) =>
      new logs.CfnQueryDefinition(this, id, {
        name: `riddle/${name}`,
        logGroupNames,
        queryString,
      });

    const handlerLog = [handlerLogGroup.logGroupName];

    // Everything one player did, newest first. Paste a `sub` into the filter.
    savedQuery(
      'QueryUserTrail',
      'per-user activity trail',
      handlerLog,
      [
        'fields @timestamp, event, method, route, riddleId, status, durationMs,',
        '  resolution, verdict, solved, purpose, totalTokens, op, pk, sk, requestId',
        '| filter userId = "PASTE_USER_SUB"',
        '| sort @timestamp desc',
        '| limit 200',
      ].join('\n')
    );

    // Every event of one request in order: entry, model call, writes, response.
    savedQuery(
      'QueryRequestStory',
      'single-request story',
      [handlerLogGroup.logGroupName, accessLogGroup.logGroupName],
      [
        'fields @timestamp, @log, event, method, route, riddleId, userId, status,',
        '  durationMs, purpose, model, inputTokens, outputTokens, totalTokens,',
        '  op, pk, sk, counters.0, resolution, verdict, solved',
        '| filter requestId = "PASTE_REQUEST_ID"',
        '| sort @timestamp asc',
        '| limit 100',
      ].join('\n')
    );

    savedQuery(
      'QueryLatencyByRoute',
      'latency by route',
      handlerLog,
      [
        'filter event = "response"',
        '| stats count(*) as requests,',
        '    avg(durationMs) as avgMs,',
        '    pct(durationMs, 50) as p50Ms,',
        '    pct(durationMs, 95) as p95Ms,',
        '    max(durationMs) as maxMs',
        '  by method, route',
        '| sort avgMs desc',
      ].join('\n')
    );

    // Most guesses never reach the model — the normalisation fast path settles
    // them. This is the ratio, and so the shape of the Anthropic bill.
    savedQuery(
      'QueryGuessResolution',
      'llm-judged vs normalized guesses',
      handlerLog,
      [
        'filter event = "guess_resolved"',
        '| stats count(*) as guesses by resolution, verdict',
        '| sort guesses desc',
      ].join('\n')
    );

    savedQuery(
      'QueryTokenSpend',
      'token spend by user',
      handlerLog,
      [
        'filter event = "llm_call"',
        '| stats count(*) as calls,',
        '    sum(inputTokens) as inputTokens,',
        '    sum(outputTokens) as outputTokens,',
        '    sum(totalTokens) as totalTokens,',
        '    avg(durationMs) as avgMs',
        '  by userId, purpose',
        '| sort totalTokens desc',
      ].join('\n')
    );

    // The requests the handler never saw: rejected tokens, throttles, 5xx from
    // the platform itself.
    savedQuery(
      'QueryRejectedAtEdge',
      'rejected before the lambda (401/403/429)',
      [accessLogGroup.logGroupName],
      [
        'fields @timestamp, requestId, method, path, status, errorMessage,',
        '  authorizerError, integrationStatus, sourceIp, userAgent',
        '| filter status = 401 or status = 403 or status = 429',
        '| sort @timestamp desc',
        '| limit 200',
      ].join('\n')
    );

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'HandlerLogGroup', { value: handlerLogGroup.logGroupName });
    new cdk.CfnOutput(this, 'AccessLogGroup', { value: accessLogGroup.logGroupName });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'AnthropicSecretName', { value: ANTHROPIC_SECRET_NAME });
  }
}
