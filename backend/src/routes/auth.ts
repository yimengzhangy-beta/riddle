import {
  AdminConfirmSignUpCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { BadRequest } from './input';
import type { RouteResult } from './result';

/**
 * The two public routes. Everything else on the API sits behind the JWT
 * authorizer, so these are how a client gets a token in the first place.
 */

const cognito = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.USER_POOL_ID!;
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

function requireEmail(body: Record<string, unknown>): string {
  const value = body.email;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequest('"email" is required and must be a non-empty string');
  }
  return value.trim();
}

/** Deliberately not trimmed — leading and trailing spaces are legal in a password. */
function requirePassword(body: Record<string, unknown>): string {
  const value = body.password;
  if (typeof value !== 'string' || value === '') {
    throw new BadRequest('"password" is required and must be a non-empty string');
  }
  return value;
}

/** Cognito's own errors are already user-facing; anything else is ours. */
function asBadRequest(err: unknown): never {
  const name = (err as { name?: string }).name;
  const message = (err as { message?: string }).message ?? 'Authentication failed';

  const clientErrors = [
    'UsernameExistsException',
    'InvalidPasswordException',
    'InvalidParameterException',
    'NotAuthorizedException',
    'UserNotFoundException',
    'UserNotConfirmedException',
    'CodeMismatchException',
    'LimitExceededException',
    'TooManyRequestsException',
  ];

  if (name && clientErrors.includes(name)) throw new BadRequest(message);
  throw err;
}

/**
 * POST /signup — body: { email, password }
 *
 * Confirms the account server-side straight after creating it. That skips the
 * emailed verification code, which keeps a curl session to two calls; a real
 * deployment would drop the confirm step and let the user verify their address.
 */
export async function postSignup(body: Record<string, unknown>): Promise<RouteResult> {
  const email = requireEmail(body);
  const password = requirePassword(body);

  try {
    await cognito.send(
      new SignUpCommand({
        ClientId: CLIENT_ID,
        Username: email,
        Password: password,
        UserAttributes: [{ Name: 'email', Value: email }],
      })
    );

    await cognito.send(
      new AdminConfirmSignUpCommand({ UserPoolId: USER_POOL_ID, Username: email })
    );

    await cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        UserAttributes: [{ Name: 'email_verified', Value: 'true' }],
      })
    );
  } catch (err) {
    asBadRequest(err);
  }

  return {
    status: 201,
    body: { email, status: 'confirmed', next: 'POST /login to get a token' },
  };
}

/**
 * POST /login — body: { email, password }
 *
 * Callers should send the **ID token**. The authorizer would also accept the access
 * token, but only the ID token carries `email` and `cognito:groups` — the claims the
 * profile and the admin gate read.
 */
export async function postLogin(body: Record<string, unknown>): Promise<RouteResult> {
  const email = requireEmail(body);
  const password = requirePassword(body);

  let result;
  try {
    result = await cognito.send(
      new InitiateAuthCommand({
        ClientId: CLIENT_ID,
        AuthFlow: 'USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: email, PASSWORD: password },
      })
    );
  } catch (err) {
    asBadRequest(err);
  }

  const auth = result.AuthenticationResult;
  if (!auth?.IdToken) {
    throw new BadRequest(
      `Login did not return a token${result.ChallengeName ? ` (challenge: ${result.ChallengeName})` : ''}`
    );
  }

  return {
    status: 200,
    body: {
      idToken: auth.IdToken,
      accessToken: auth.AccessToken,
      refreshToken: auth.RefreshToken,
      expiresIn: auth.ExpiresIn,
      tokenType: 'Bearer',
      usage: 'Send the idToken as: Authorization: Bearer <idToken>',
    },
  };
}
