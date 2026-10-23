import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { zipSync, strToU8 } from "fflate";
import { ApiError } from "../lib/errors.js";
import { assertSafeOutboundUrl, fetchWithTimeout, readTextSafe } from "../lib/http.js";

/**
 * Object storage destinations. One file per (patient, source), rewritten in full on every run, so
 * downstream ingestion can treat each file as the current state of that patient's record from that
 * source. Formats: NDJSON (one resource per line) or a zip archive containing the NDJSON file.
 *   aws            - Amazon S3 (region + bucket)
 *   s3_compatible  - any S3 API (MinIO, Cloudflare R2, Wasabi, GCS interoperability endpoint)
 *   azure_blob     - Azure Blob Storage through a container SAS URL
 */

export type ObjectStorageConfig = {
  vendor: "aws" | "s3_compatible" | "azure_blob";
  bucket?: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
  file_type: "ndjson" | "ndjson_zip";
  force_path_style?: boolean;
};

export type ObjectStorageSecrets = {
  access_key_id?: string;
  secret_access_key?: string;
  /** Azure: container SAS URL, e.g. https://acct.blob.core.windows.net/container?sv=...&sig=... */
  sas_url?: string;
};

export class ObjectStorageWriter {
  private s3: S3Client | null = null;

  constructor(
    private readonly cfg: ObjectStorageConfig,
    private readonly secrets: ObjectStorageSecrets,
  ) {
    if (cfg.vendor !== "azure_blob") {
      if (!cfg.bucket) throw new ApiError("invalid_data", "bucket is required", { param: "bucket" });
      if (!secrets.access_key_id || !secrets.secret_access_key) {
        throw new ApiError("invalid_data", "access_key_id and secret_access_key are required", { param: "access_key_id" });
      }
      if (cfg.vendor === "s3_compatible" && !cfg.endpoint) throw new ApiError("invalid_data", "endpoint is required for S3-compatible storage", { param: "endpoint" });
      this.s3 = new S3Client({
        region: cfg.region || "us-east-1",
        endpoint: cfg.endpoint || undefined,
        forcePathStyle: cfg.force_path_style ?? cfg.vendor === "s3_compatible",
        credentials: { accessKeyId: secrets.access_key_id, secretAccessKey: secrets.secret_access_key },
        maxAttempts: 3,
        // Many S3-compatible stores do not support the newer default CRC checksums.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
    } else if (!secrets.sas_url) {
      throw new ApiError("invalid_data", "sas_url is required for Azure Blob Storage", { param: "sas_url" });
    }
  }

  private key(path: string) {
    const prefix = (this.cfg.prefix ?? "").replace(/^\/+/, "");
    return `${prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix}${path}`;
  }

  async put(path: string, body: Uint8Array | string, contentType: string) {
    const key = this.key(path);
    if (this.cfg.vendor === "azure_blob") {
      const sas = new URL(this.secrets.sas_url!);
      await assertSafeOutboundUrl(sas.toString(), { param: "sas_url" });
      const url = new URL(sas.toString());
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
      const res = await fetchWithTimeout(url, {
        method: "PUT",
        headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": contentType, "x-ms-version": "2023-11-03" },
        body: typeof body === "string" ? body : Buffer.from(body),
        timeoutMs: 120_000,
      });
      if (!res.ok) throw new Error(`Azure Blob PUT failed: HTTP ${res.status} ${await readTextSafe(res, 300)}`);
      return;
    }
    if (this.cfg.endpoint) await assertSafeOutboundUrl(this.cfg.endpoint, { param: "endpoint" });
    await this.s3!.send(new PutObjectCommand({ Bucket: this.cfg.bucket!, Key: key, Body: body, ContentType: contentType }));
  }

  async testConnection() {
    const path = "_infinimed/connection-test.txt";
    try {
      await this.put(path, `InfiniMed connectivity test ${new Date().toISOString()}\n`, "text/plain");
      if (this.s3) await this.s3.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket!, Key: this.key(path) })).catch(() => undefined);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError("destination_test_failed", `Could not write to the bucket: ${(err as Error).message}. Check bucket policy, credentials, endpoint and region.`);
    }
  }

  /** Writes one patient's resources from one source. */
  async writePatientFile(args: { workspaceId: string; patientExternalId: string; sourceId: string; resources: Record<string, unknown>[] }) {
    const ndjson = args.resources.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const safePatient = args.patientExternalId.replace(/[^A-Za-z0-9._-]/g, "_");
    const base = `${args.workspaceId}/${safePatient}/${args.sourceId}`;
    if (this.cfg.file_type === "ndjson_zip") {
      const zipped = zipSync({ [`${args.sourceId}.ndjson`]: strToU8(ndjson) }, { level: 6 });
      await this.put(`${base}.ndjson.zip`, zipped, "application/zip");
      return `${base}.ndjson.zip`;
    }
    await this.put(`${base}.ndjson`, ndjson, "application/fhir+ndjson");
    return `${base}.ndjson`;
  }
}
