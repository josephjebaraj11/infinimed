/**
 * Reads the parameters InfiniMed appends to your `return_url` when a patient session ends.
 * Hosted mode returns `patient_id` and `patient_session_id`; direct mode adds `success` and either
 * `source_id` + `connection_id` or `error` + `error_description`. Returns null when the URL is not a
 * return URL. Treat the result as UI state only: confirm connections server-side.
 */

export type ReturnResult =
  | { patient_id: string; patient_session_id: string }
  | { patient_id: string; patient_session_id: string; success: true; source_id: string; connection_id: string }
  | { patient_id: string; patient_session_id: string; success: false; error: string; error_description: string | null };

export function parseReturnUrl(input?: URLSearchParams | string | URL): ReturnResult | null {
  let params: URLSearchParams;
  if (input instanceof URLSearchParams) params = input;
  else if (input instanceof URL) params = input.searchParams;
  else if (typeof input === "string") params = new URL(input, "http://localhost").searchParams;
  else if (typeof globalThis.location !== "undefined") params = new URLSearchParams(globalThis.location.search);
  else return null;

  const patientId = params.get("patient_id");
  const sessionId = params.get("patient_session_id");
  if (!patientId || !sessionId) return null;
  const success = params.get("success");
  if (success === null) return { patient_id: patientId, patient_session_id: sessionId };
  if (success === "true") {
    return { patient_id: patientId, patient_session_id: sessionId, success: true, source_id: params.get("source_id") ?? "", connection_id: params.get("connection_id") ?? "" };
  }
  return { patient_id: patientId, patient_session_id: sessionId, success: false, error: params.get("error") ?? "unknown_error", error_description: params.get("error_description") };
}
