/**
 * Auth against the Riddle user pool.
 *
 * Cognito's IDP endpoint is a plain JSON-over-HTTP API, so sign-in and refresh
 * talk to it directly — no SDK, no bundle cost. The app client is public
 * (no secret), which is what makes that safe from a browser.
 *
 * Sign-*up* is the exception and deliberately goes through our own API: the
 * pool has no email verification wired up, so the backend calls
 * AdminConfirmSignUp to confirm the account immediately. That needs admin
 * credentials, so it cannot happen here. A browser-side SignUp would leave the
 * account UNCONFIRMED and unable to log in.
 */

const REGION = 'us-east-1';
const CLIENT_ID = '6hp0qhka9tk297itheulbl6h7';
const USER_POOL_ID = 'us-east-1_TYIXhSmMv';
const IDP = `https://cognito-idp.${REGION}.amazonaws.com/`;

const RAW_API = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
const API = RAW_API.replace(/\/+$/, '');

const KEY = 'riddle.session';

/** The pool's password rules, mirrored so we can explain a rejection before it happens. */
export const PASSWORD_RULES: { label: string; test: (v: string) => boolean }[] = [
  { label: 'At least 8 characters', test: (v) => v.length >= 8 },
  { label: 'A lowercase letter', test: (v) => /[a-z]/.test(v) },
  { label: 'An uppercase letter', test: (v) => /[A-Z]/.test(v) },
  { label: 'A number', test: (v) => /[0-9]/.test(v) },
];

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/**
 * Cognito's own messages are mostly fine to show, but a few are jargon and one
 * (`NotAuthorizedException`) covers both a wrong password and a disabled user.
 * Everything else falls through to the service's wording.
 */
function friendly(code: string, raw: string): string {
  switch (code) {
    case 'NotAuthorizedException':
      return raw.includes('Refresh Token')
        ? 'Your session expired. Please sign in again.'
        : 'Incorrect email or password.';
    case 'UserNotFoundException':
      return 'No account found with that email.';
    case 'UsernameExistsException':
      return 'That email is already registered — try signing in instead.';
    case 'InvalidPasswordException':
      return 'That password does not meet the requirements below.';
    case 'InvalidParameterException':
      return raw.toLowerCase().includes('email')
        ? 'That does not look like a valid email address.'
        : raw;
    case 'UserNotConfirmedException':
      return 'That account is not confirmed yet. Contact support.';
    case 'TooManyRequestsException':
    case 'LimitExceededException':
      return 'Too many attempts. Wait a moment and try again.';
    case 'PasswordResetRequiredException':
      return 'This account needs a password reset.';
    default:
      return raw || 'Something went wrong. Please try again.';
  }
}

async function idp<T>(target: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(IDP, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError('NetworkError', 'Could not reach the sign-in service.');
  }

  const json = (await res.json().catch(() => ({}))) as {
    __type?: string;
    message?: string;
  };

  if (!res.ok) {
    // `__type` arrives as either "Code" or "com.amazon...#Code".
    const code = (json.__type ?? 'UnknownError').split('#').pop() as string;
    throw new AuthError(code, friendly(code, json.message ?? ''));
  }
  return json as T;
}

// ------------------------------------------------------------------ session

interface Session {
  idToken: string;
  refreshToken: string;
  /** Epoch ms. Refreshed a little before this to avoid a mid-request expiry. */
  expiresAt: number;
  email: string;
}

interface AuthResult {
  AuthenticationResult?: {
    IdToken: string;
    AccessToken: string;
    RefreshToken?: string;
    ExpiresIn: number;
  };
}

function read(): Session | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

function write(s: Session): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function signOut(): void {
  localStorage.removeItem(KEY);
}

export function currentEmail(): string | null {
  return read()?.email ?? null;
}

export function isSignedIn(): boolean {
  return read() !== null;
}

function store(result: AuthResult, email: string, fallbackRefresh?: string): Session {
  const r = result.AuthenticationResult;
  if (!r?.IdToken) throw new AuthError('NoToken', 'Sign-in did not return a token.');
  const session: Session = {
    idToken: r.IdToken,
    // A refresh exchange does not return a new refresh token — keep the old one.
    refreshToken: r.RefreshToken ?? fallbackRefresh ?? '',
    expiresAt: Date.now() + r.ExpiresIn * 1000,
    email,
  };
  write(session);
  return session;
}

// -------------------------------------------------------------------- flows

/**
 * Creates the account via our API, which confirms it server-side, then signs in
 * so the player lands straight in the game rather than on a second form.
 */
export async function signUp(email: string, password: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new AuthError('NetworkError', 'Could not reach the server.');
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const raw = body.error ?? 'Could not create that account.';
    // The API forwards Cognito's message, so recover the code from the text.
    const code = /already exists/i.test(raw)
      ? 'UsernameExistsException'
      : /password/i.test(raw)
        ? 'InvalidPasswordException'
        : 'InvalidParameterException';
    throw new AuthError(code, friendly(code, raw));
  }

  await signIn(email, password);
}

export async function signIn(email: string, password: string): Promise<void> {
  const result = await idp<AuthResult>('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: CLIENT_ID,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  store(result, email);
}

/**
 * A valid ID token, refreshing first if it is close to expiry.
 *
 * Returns null when there is no session, or when the refresh token itself has
 * expired — callers treat that the same as being signed out.
 */
export async function getIdToken(): Promise<string | null> {
  const session = read();
  if (!session) return null;

  // 60s of headroom so a token cannot expire between here and the server.
  if (Date.now() < session.expiresAt - 60_000) return session.idToken;
  if (!session.refreshToken) {
    signOut();
    return null;
  }

  try {
    const result = await idp<AuthResult>('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: session.refreshToken },
    });
    return store(result, session.email, session.refreshToken).idToken;
  } catch {
    // Refresh tokens last 30 days; past that the player simply signs in again.
    signOut();
    return null;
  }
}

export const POOL = { region: REGION, userPoolId: USER_POOL_ID, clientId: CLIENT_ID };
