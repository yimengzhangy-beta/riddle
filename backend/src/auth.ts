import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import type { Player } from './engine/riddles';

/**
 * Claim plumbing for the API Gateway JWT authorizer.
 *
 * The authorizer has already verified the token's signature, issuer, audience and
 * expiry by the time the Lambda runs — anything reaching here is authentic. This
 * module only reads the claims it put on the request context.
 */

const ADMIN_GROUP = process.env.ADMIN_GROUP ?? 'admins';

export class UnauthorizedError extends Error {}
export class ForbiddenError extends Error {}

type Claims = Record<string, string | number | boolean | string[] | undefined>;

function claimsOf(event: APIGatewayProxyEventV2WithJWTAuthorizer): Claims {
  return (event.requestContext.authorizer?.jwt?.claims ?? {}) as Claims;
}

function stringClaim(claims: Claims, name: string): string | null {
  const value = claims[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The authenticated caller. Throws if the route was somehow reached unauthenticated.
 *
 * The authorizer accepts either Cognito token — it matches an ID token's `aud` or an
 * access token's `client_id` against the app client id. `sub` is on both and is the
 * identity everything is keyed on.
 *
 * `email` is only on the ID token, so it can legitimately be absent. There is no useful
 * fallback: the pool signs in by email alias, which means Cognito's `username` /
 * `cognito:username` claim is a generated UUID, not an address. Return blank instead and
 * let ensureProfile backfill it the first time an ID token arrives.
 */
export function playerOf(event: APIGatewayProxyEventV2WithJWTAuthorizer): Player {
  const claims = claimsOf(event);

  const userId = stringClaim(claims, 'sub');
  if (!userId) {
    throw new UnauthorizedError('Request carries no verified identity');
  }

  return { userId, email: stringClaim(claims, 'email') ?? '' };
}

/**
 * Cognito serialises `cognito:groups` as a real array in the ID token, but API
 * Gateway can flatten a single-element list into a bracketed string on the way
 * through — accept both shapes.
 */
function groupsOf(claims: Claims): string[] {
  const raw = claims['cognito:groups'];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  return raw
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

/** Admin gate for POST /admin/*. Membership of the `admins` group is the flag. */
export function requireAdmin(event: APIGatewayProxyEventV2WithJWTAuthorizer): Player {
  const player = playerOf(event);

  if (!groupsOf(claimsOf(event)).includes(ADMIN_GROUP)) {
    throw new ForbiddenError(`This endpoint requires membership of the "${ADMIN_GROUP}" group`);
  }

  return player;
}
