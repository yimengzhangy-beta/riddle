import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { ForbiddenError, UnauthorizedError, optionalUserId, playerOf, requireAdmin } from './auth';
import { NotEntitledError, flushBilling } from './billing';
import { ConflictError, NotFoundError, ValidationError } from './engine/riddles';
import { ModelOutputError } from './llm/client';
import { logError, logResponse, stackFrames, withRequest } from './log';
import * as adminRoutes from './routes/admin';
import * as authRoutes from './routes/auth';
import * as billingRoutes from './routes/billing';
import { BadRequest } from './routes/input';
import * as meRoutes from './routes/me';
import type { RouteResult } from './routes/result';
import * as riddleRoutes from './routes/riddles';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // tighten to your Amplify domain later
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Content-Type': 'application/json',
};

function respond(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function parseBody(event: APIGatewayProxyEventV2WithJWTAuthorizer): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequest('Request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof BadRequest) throw err;
    throw new BadRequest('Request body is not valid JSON');
  }
}

/**
 * The HTTP API routes are declared with path parameters in the stack, so the
 * matched route key and `{id}` arrive already parsed. Falling back to the raw path
 * keeps local invocations and any future proxy route working.
 */
function pathSegments(event: APIGatewayProxyEventV2WithJWTAuthorizer): string[] {
  return (event.rawPath || '/').split('/').filter(Boolean);
}

function riddleIdOf(event: APIGatewayProxyEventV2WithJWTAuthorizer): string {
  const fromRoute = event.pathParameters?.id;
  if (typeof fromRoute === 'string' && fromRoute !== '') return decodeURIComponent(fromRoute);

  // /riddles/{id}/guess → segment 1
  const segments = pathSegments(event);
  const id = segments[1];
  if (!id) throw new BadRequest('Request path carries no riddle id');
  return decodeURIComponent(id);
}

/** Matches "/riddles/{id}/guess" style patterns against the incoming path segments. */
function match(segments: string[], pattern: string[]): boolean {
  if (segments.length !== pattern.length) return false;
  return pattern.every((p, i) => p === ':' || p === segments[i]);
}

async function route(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<RouteResult> {
  const method = event.requestContext.http.method.toUpperCase();
  const segments = pathSegments(event);

  // ------------------------------------------------------------------ public
  if (method === 'GET' && match(segments, ['health'])) {
    return {
      status: 200,
      body: { status: 'ok', service: 'riddle', time: new Date().toISOString() },
    };
  }

  if (method === 'POST' && match(segments, ['signup'])) {
    return authRoutes.postSignup(parseBody(event));
  }

  if (method === 'POST' && match(segments, ['login'])) {
    return authRoutes.postLogin(parseBody(event));
  }

  // Public so the pricing page can render to a signed-out visitor.
  if (method === 'GET' && match(segments, ['plans'])) {
    return billingRoutes.getPlans();
  }

  // --------------------------------------------------------- authenticated
  if (method === 'GET' && match(segments, ['me'])) {
    return meRoutes.getProfile(playerOf(event));
  }

  if (method === 'GET' && match(segments, ['subscription'])) {
    return billingRoutes.getSubscription(playerOf(event));
  }

  if (method === 'GET' && match(segments, ['subscription', 'summary'])) {
    return billingRoutes.getSubscriptionSummary(playerOf(event));
  }

  if (method === 'POST' && match(segments, ['subscribe'])) {
    return billingRoutes.postSubscribe(playerOf(event), parseBody(event));
  }

  if (method === 'GET' && match(segments, ['riddles', 'next'])) {
    return riddleRoutes.getNext(playerOf(event), event.queryStringParameters ?? {});
  }

  if (method === 'POST' && match(segments, ['riddles', ':', 'guess'])) {
    return riddleRoutes.postGuess(playerOf(event), riddleIdOf(event), parseBody(event));
  }

  if (method === 'POST' && match(segments, ['riddles', ':', 'hint'])) {
    return riddleRoutes.postHint(playerOf(event), riddleIdOf(event));
  }

  // ----------------------------------------------------------------- admin
  if (method === 'POST' && match(segments, ['admin', 'generate'])) {
    requireAdmin(event);
    return adminRoutes.postGenerate(parseBody(event));
  }

  return { status: 404, body: { error: `No route for ${method} ${event.rawPath}` } };
}

function errorResult(err: unknown): RouteResult {
  if (err instanceof BadRequest || err instanceof ValidationError) {
    return { status: 400, body: { error: err.message } };
  }
  if (err instanceof UnauthorizedError) {
    return { status: 401, body: { error: err.message } };
  }
  if (err instanceof ForbiddenError) {
    return { status: 403, body: { error: err.message } };
  }
  if (err instanceof NotFoundError) {
    return { status: 404, body: { error: err.message } };
  }
  if (err instanceof ConflictError) {
    return { status: 409, body: { error: err.message } };
  }
  if (err instanceof NotEntitledError) {
    // Distinct from ForbiddenError: the caller is authenticated and allowed to
    // be here, their plan just does not cover this. The reason is an enum from
    // the billing backend, and the pointer tells the client where to go next.
    return {
      status: 403,
      body: {
        error: err.message,
        reason: err.reason,
        action: err.action,
        upgradeUrl: '/pricing',
      },
    };
  }
  if (err instanceof ModelOutputError) {
    return { status: 502, body: { error: `Model output could not be used: ${err.message}` } };
  }

  // Unexpected. The message is withheld from the audit log because an error
  // raised deep in a client library can quote the input that caused it.
  logError({
    where: 'handler',
    name: err instanceof Error ? err.name : typeof err,
    message: 'unexpected error (message withheld — may contain request content)',
    frames: stackFrames(err),
  });
  return { status: 500, body: { error: 'Internal server error' } };
}

/**
 * Ids for the audit trail, read without throwing — an unauthenticated or
 * unroutable request still gets a `request` event.
 *
 * `requestId` is API Gateway's, so these events join to the access log line for
 * the same call. The route is the matched template (`POST /riddles/{id}/guess`),
 * which keeps per-route stats from fragmenting across riddle ids.
 */
function auditContextOf(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const method = event.requestContext?.http?.method?.toUpperCase() ?? 'UNKNOWN';
  const routeKey = event.requestContext?.routeKey;
  const template =
    routeKey && routeKey !== '$default' ? routeKey.replace(/^\S+\s+/, '') : (event.rawPath ?? '/');

  const segments = pathSegments(event);
  const fromPath = segments[0] === 'riddles' && segments[1] !== 'next' ? segments[1] : undefined;
  const riddleId = event.pathParameters?.id ?? fromPath;

  return {
    requestId: event.requestContext?.requestId ?? randomUUID(),
    userId: optionalUserId(event),
    route: template,
    method,
    riddleId: riddleId ? decodeURIComponent(riddleId) : null,
  };
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  return withRequest(auditContextOf(event), async () => {
    let result: RouteResult;
    try {
      result = await route(event);
    } catch (err) {
      result = errorResult(err);
    }

    // The SDK batches usage events, and a Lambda is frozen the instant it
    // returns — anything still buffered here would never be sent.
    await flushBilling();

    logResponse(result.status);
    return respond(result.status, result.body);
  });
}
