import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ForbiddenError, UnauthorizedError, playerOf, requireAdmin } from './auth';
import { ConflictError, NotFoundError, ValidationError } from './engine/riddles';
import { ModelOutputError } from './llm/client';
import * as adminRoutes from './routes/admin';
import * as authRoutes from './routes/auth';
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

  // --------------------------------------------------------- authenticated
  if (method === 'GET' && match(segments, ['me'])) {
    return meRoutes.getProfile(playerOf(event));
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

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  try {
    const result = await route(event);
    return respond(result.status, result.body);
  } catch (err) {
    if (err instanceof BadRequest || err instanceof ValidationError) {
      return respond(400, { error: err.message });
    }
    if (err instanceof UnauthorizedError) {
      return respond(401, { error: err.message });
    }
    if (err instanceof ForbiddenError) {
      return respond(403, { error: err.message });
    }
    if (err instanceof NotFoundError) {
      return respond(404, { error: err.message });
    }
    if (err instanceof ConflictError) {
      return respond(409, { error: err.message });
    }
    if (err instanceof ModelOutputError) {
      return respond(502, { error: `Model output could not be used: ${err.message}` });
    }
    console.error(err);
    return respond(500, { error: 'Internal server error' });
  }
}
