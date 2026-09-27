import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { ForbiddenError, UnauthorizedError, optionalUserId, playerOf, requireAdmin } from './auth';
import { EntitlementDeniedError, meter, requireEntitlement } from './billing';
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

/**
 * Origins allowed to call this API from a browser, set by the stack. The
 * preflight allowlist lives on the HTTP API, but the actual response header is
 * ours — leaving it as `*` here would keep the API open no matter what the
 * gateway says, so the two have to agree.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Echoes the caller's origin when it is on the list. An unknown origin gets the
 * first allowed one, which the browser then rejects — a mismatch is the correct
 * failure, and it keeps the header well-formed either way. Also the origin the
 * hosted billing pages return the player to (see routes/billing.ts).
 */
function allowedOrigin(origin: string | undefined): string {
  return origin && ALLOWED_ORIGINS.includes(origin) ? origin : (ALLOWED_ORIGINS[0] ?? '');
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowed = allowedOrigin(origin);
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    // The response varies by request origin, so caches must not share it.
    Vary: 'Origin',
    'Content-Type': 'application/json',
  };
}

function respond(
  statusCode: number,
  body: unknown,
  origin?: string
): APIGatewayProxyResultV2 {
  return { statusCode, headers: corsHeaders(origin), body: JSON.stringify(body) };
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

  // --------------------------------------------------------- authenticated
  if (method === 'GET' && match(segments, ['me'])) {
    return meRoutes.getProfile(playerOf(event));
  }

  // Billable actions: check the player's plan BEFORE the paid work (a denied
  // request costs nothing), and record one unit AFTER it succeeds — the route
  // throws on failure, so a metered event always means the action happened.
  if (method === 'GET' && match(segments, ['riddles', 'next'])) {
    const player = playerOf(event);
    await requireEntitlement(player.userId, 'riddle_played');
    const result = await riddleRoutes.getNext(player, event.queryStringParameters ?? {});
    await meter(player.userId, 'riddle_played');
    return result;
  }

  if (method === 'POST' && match(segments, ['riddles', ':', 'guess'])) {
    const player = playerOf(event);
    await requireEntitlement(player.userId, 'guess_submitted');
    const result = await riddleRoutes.postGuess(player, riddleIdOf(event), parseBody(event));
    await meter(player.userId, 'guess_submitted');
    return result;
  }

  if (method === 'POST' && match(segments, ['riddles', ':', 'hint'])) {
    const player = playerOf(event);
    await requireEntitlement(player.userId, 'hint_taken');
    const result = await riddleRoutes.postHint(player, riddleIdOf(event));
    await meter(player.userId, 'hint_taken');
    return result;
  }

  // --------------------------------------------------------------- billing
  if (method === 'GET' && match(segments, ['billing', 'session'])) {
    const origin = allowedOrigin(event.headers?.origin ?? event.headers?.Origin);
    return billingRoutes.getSession(playerOf(event), origin);
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
  if (err instanceof EntitlementDeniedError) {
    // Not entitled (no plan, or over quota). The SPA keys off decision:'DENY'
    // and offers the hosted pricing page.
    return {
      status: 403,
      body: { error: err.message, decision: 'DENY', reason: err.code, action: err.action },
    };
  }
  if (err instanceof NotFoundError) {
    return { status: 404, body: { error: err.message } };
  }
  if (err instanceof ConflictError) {
    return { status: 409, body: { error: err.message } };
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

    logResponse(result.status);
    return respond(result.status, result.body, event.headers?.origin ?? event.headers?.Origin);
  });
}
