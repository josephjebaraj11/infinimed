import { decodeJwt } from "jose";
import { createClientAssertion } from "../services/keys.js";
import type { ClientCredentials } from "../services/credentials.js";
import { fetchWithTimeout, parseRetryAfter, readTextSafe } from "../lib/http.js";

/**
 * OAuth 2.0 token endpoint client for SMART on FHIR. Implements the four client authentication
 * methods vendors use: private_key_jwt (Epic, Oracle Health, athenahealth, healow), client_secret_basic
 * (Aetna, CMS Blue Button, UnitedHealthcare), client_secret_post (MEDITECH) and none (public + PKCE).
 */

export type TokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
  id_token?: string;
  patient?: string;
  encounter?: string;
  [key: string]: unknown;
};

export class TokenError extends Error {
  constructor(
    readonly code: string,
    readonly description: string,
    readonly status: number,
    readonly retryAfter: number | null = null,
  ) {
    super(`${code}: ${description}`);
    this.name = "TokenError";
  }
  /** invalid_grant / invalid_client etc. mean the grant is dead; 5xx and network errors are transient. */
  get permanent() {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

async function authenticate(params: URLSearchParams, headers: Record<string, string>, creds: ClientCredentials, tokenUrl: string) {
  switch (creds.tokenAuthMethod) {
    case "private_key_jwt":
      params.set("client_id", creds.clientId);
      params.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      params.set("client_assertion", await createClientAssertion(creds.clientId, tokenUrl));
      break;
    case "client_secret_basic": {
      if (!creds.clientSecret) throw new TokenError("invalid_client", "client secret is not configured", 400);
      // RFC 6749 2.3.1: form-urlencode id and secret before base64.
      const user = encodeURIComponent(creds.clientId);
      const pass = encodeURIComponent(creds.clientSecret);
      headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
      break;
    }
    case "client_secret_post":
      if (!creds.clientSecret) throw new TokenError("invalid_client", "client secret is not configured", 400);
      params.set("client_id", creds.clientId);
      params.set("client_secret", creds.clientSecret);
      break;
    case "none":
      params.set("client_id", creds.clientId);
      break;
  }
}

async function post(tokenUrl: string, params: URLSearchParams, creds: ClientCredentials): Promise<TokenResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  await authenticate(params, headers, creds, tokenUrl);
  let res: Response;
  try {
    res = await fetchWithTimeout(tokenUrl, { method: "POST", headers, body: params.toString(), timeoutMs: 20_000 });
  } catch (err) {
    throw new TokenError("network_error", (err as Error).message, 503);
  }
  const text = await readTextSafe(res, 64 * 1024);
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // non-JSON error pages
  }
  if (!res.ok || typeof body.access_token !== "string") {
    const code = typeof body.error === "string" ? body.error : res.ok ? "invalid_response" : `http_${res.status}`;
    const description =
      typeof body.error_description === "string" ? body.error_description : res.ok ? "token response had no access_token" : text.slice(0, 300);
    throw new TokenError(code, description, res.ok ? 502 : res.status, parseRetryAfter(res.headers.get("retry-after")));
  }
  return body as TokenResponse;
}

export function exchangeAuthorizationCode(args: {
  tokenUrl: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  credentials: ClientCredentials;
}) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  });
  return post(args.tokenUrl, params, args.credentials);
}

export function refreshAccessToken(args: { tokenUrl: string; refreshToken: string; credentials: ClientCredentials; scope?: string }) {
  const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: args.refreshToken });
  if (args.scope) params.set("scope", args.scope);
  return post(args.tokenUrl, params, args.credentials);
}

/** SMART Backend Services: client_credentials grant authenticated with a signed JWT assertion. */
export function clientCredentialsGrant(args: { tokenUrl: string; scope: string; credentials: ClientCredentials }) {
  const params = new URLSearchParams({ grant_type: "client_credentials", scope: args.scope });
  return post(args.tokenUrl, params, { ...args.credentials, tokenAuthMethod: args.credentials.tokenAuthMethod === "none" ? "private_key_jwt" : args.credentials.tokenAuthMethod });
}

export async function revokeToken(args: { revokeUrl: string; token: string; hint: "refresh_token" | "access_token"; credentials: ClientCredentials }) {
  const params = new URLSearchParams({ token: args.token, token_type_hint: args.hint });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  await authenticate(params, headers, args.credentials, args.revokeUrl);
  const res = await fetchWithTimeout(args.revokeUrl, { method: "POST", headers, body: params.toString(), timeoutMs: 10_000 });
  return res.ok;
}

/** Unverified claims of an id_token, used only to read fhirUser/profile when no `patient` was returned. */
export function idTokenClaims(idToken: string | undefined): Record<string, unknown> | null {
  if (!idToken) return null;
  try {
    return decodeJwt(idToken) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Extracts `Patient/123` style fhirUser into the id when it names a Patient. */
export function patientIdFromFhirUser(fhirUser: unknown): string | null {
  if (typeof fhirUser !== "string") return null;
  const match = /(?:^|\/)Patient\/([A-Za-z0-9\-.]{1,64})$/.exec(fhirUser);
  return match ? match[1]! : null;
}
