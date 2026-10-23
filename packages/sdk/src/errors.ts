import type { InfiniMedErrorType } from "./types.js";

/** Every failed API request throws one InfiniMedError; branch on `type` and `code`. */
export class InfiniMedError extends Error {
  readonly type: InfiniMedErrorType | string;
  readonly code: string;
  readonly param: string | null;
  readonly requestId: string | null;
  readonly docUrl: string | null;
  readonly statusCode: number;
  readonly retryAfter: number | null;

  constructor(init: { type: string; code: string; message: string; param?: string | null; requestId?: string | null; docUrl?: string | null; statusCode: number; retryAfter?: number | null }) {
    super(init.message);
    this.name = "InfiniMedError";
    this.type = init.type;
    this.code = init.code;
    this.param = init.param ?? null;
    this.requestId = init.requestId ?? null;
    this.docUrl = init.docUrl ?? null;
    this.statusCode = init.statusCode;
    this.retryAfter = init.retryAfter ?? null;
  }
}

export function isInfiniMedError(err: unknown): err is InfiniMedError {
  return err instanceof InfiniMedError;
}

export type SignatureFailureReason = "missing_header" | "malformed_header" | "timestamp_expired" | "signature_mismatch" | "malformed_body";

/** Thrown by `InfiniMed.webhooks.constructEvent`; never by API calls. Return HTTP 400 on it. */
export class InfiniMedSignatureError extends Error {
  readonly reason: SignatureFailureReason;
  constructor(reason: SignatureFailureReason, message?: string) {
    super(message ?? `Webhook signature verification failed: ${reason}`);
    this.name = "InfiniMedSignatureError";
    this.reason = reason;
  }
}
