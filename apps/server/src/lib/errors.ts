/**
 * The public error taxonomy. Every non-2xx API response uses one envelope:
 *   { error: { type, code, message, param, doc_url, request_id } }
 * `type` is the broad category, `code` the stable machine-readable reason clients branch on.
 */

export const ERROR_DOC_URL = "https://docs.infinimed.dev/reference/errors";

export type ErrorType =
  | "authentication_error"
  | "permission_error"
  | "invalid_request_error"
  | "not_found_error"
  | "conflict_error"
  | "rate_limit_error"
  | "billing_error"
  | "ehr_error"
  | "api_error";

export const ERROR_CODES = {
  // authentication_error (401)
  not_authenticated: { type: "authentication_error", status: 401 },
  invalid_credentials: { type: "authentication_error", status: 401 },
  session_expired: { type: "authentication_error", status: 401 },
  missing_api_key: { type: "authentication_error", status: 401 },
  invalid_api_key: { type: "authentication_error", status: 401 },
  expired_api_key: { type: "authentication_error", status: 401 },
  invalid_token: { type: "authentication_error", status: 401 },
  // permission_error (403)
  forbidden: { type: "permission_error", status: 403 },
  workspace_access_denied: { type: "permission_error", status: 403 },
  role_insufficient: { type: "permission_error", status: 403 },
  environment_mismatch: { type: "permission_error", status: 403 },
  insufficient_scope: { type: "permission_error", status: 403 },
  // invalid_request_error (400 / 413)
  bad_request: { type: "invalid_request_error", status: 400 },
  invalid_data: { type: "invalid_request_error", status: 400 },
  payload_too_large: { type: "invalid_request_error", status: 413 },
  unsupported_api_version: { type: "invalid_request_error", status: 400 },
  invalid_cursor: { type: "invalid_request_error", status: 400 },
  oauth_state_expired: { type: "invalid_request_error", status: 400 },
  unsafe_url: { type: "invalid_request_error", status: 400 },
  destination_test_failed: { type: "invalid_request_error", status: 400 },
  idempotency_key_reused: { type: "invalid_request_error", status: 400 },
  // not_found_error (404)
  resource_not_found: { type: "not_found_error", status: 404 },
  // conflict_error (409)
  resource_conflict: { type: "conflict_error", status: 409 },
  external_id_already_exists: { type: "conflict_error", status: 409 },
  webhook_endpoint_limit_reached: { type: "conflict_error", status: 409 },
  already_linked: { type: "conflict_error", status: 409 },
  // rate_limit_error (429)
  throttled: { type: "rate_limit_error", status: 429 },
  api_key_limit_exceeded: { type: "rate_limit_error", status: 429 },
  // billing_error (402)
  feature_not_enabled: { type: "billing_error", status: 402 },
  quota_exceeded: { type: "billing_error", status: 402 },
  // ehr_error (502)
  fhir_error: { type: "ehr_error", status: 502 },
  oauth_error: { type: "ehr_error", status: 502 },
  token_exchange_failed: { type: "ehr_error", status: 502 },
  token_unavailable: { type: "ehr_error", status: 502 },
  storage_error: { type: "ehr_error", status: 502 },
  upstream_unavailable: { type: "ehr_error", status: 502 },
  // api_error (500)
  internal_error: { type: "api_error", status: 500 },
  db_error: { type: "api_error", status: 500 },
  config_missing: { type: "api_error", status: 500 },
} as const satisfies Record<string, { type: ErrorType; status: number }>;

export type ErrorCode = keyof typeof ERROR_CODES;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly type: ErrorType;
  readonly status: number;
  readonly param: string | null;
  readonly retryAfter: number | null;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { param?: string | null; retryAfter?: number | null; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.type = ERROR_CODES[code].type;
    this.status = ERROR_CODES[code].status;
    this.param = options.param ?? null;
    this.retryAfter = options.retryAfter ?? null;
    this.details = options.details;
  }

  toEnvelope(requestId: string) {
    return {
      error: {
        type: this.type,
        code: this.code,
        message: this.message,
        param: this.param,
        doc_url: ERROR_DOC_URL,
        request_id: requestId,
      },
    };
  }
}

export const notFound = (what: string, param?: string) =>
  new ApiError("resource_not_found", `${what} not found`, { param: param ?? null });

export const badRequest = (message: string, param?: string) =>
  new ApiError("bad_request", message, { param: param ?? null });

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
