import { promisify } from "node:util";
import { gunzip } from "node:zlib";

const gunzipAsync = promisify(gunzip);

export type BodyErrorKind = "too_large" | "unsupported" | "malformed";

/** Carries only a kind: the route maps it to a generic 413 / 415 / 400 and never echoes the input. */
export class BodyError extends Error {
  constructor(public readonly kind: BodyErrorKind) {
    super(`ingest body ${kind}`);
    this.name = "BodyError";
  }
}

export interface BodyLimits {
  /** Hard cap on the bytes read off the wire when the body is gzip-compressed. */
  maxCompressedBytes: number;
  /** Hard cap on the JSON text: the body itself when uncompressed, the inflated output when gzip. */
  maxDecompressedBytes: number;
}

/**
 * Reads and parses an ingest body. Every size limit is enforced BEFORE anything is parsed:
 *  1. content type must be JSON and the encoding identity or gzip (else 415);
 *  2. a declared Content-Length above the cap is refused without reading (413);
 *  3. the stream is read chunk by chunk and cancelled the moment the running total passes the cap, so a
 *     lying or missing Content-Length cannot make us buffer more (413);
 *  4. gzip is inflated with a hard `maxOutputLength`, which zlib enforces while inflating (a gzip bomb
 *     stops at the cap instead of being fully expanded) (413);
 *  5. only then is the text decoded (strict UTF-8) and JSON-parsed (400 on any failure).
 * The platform limit is 4.5 MB (verified for Vercel Functions); ours is stricter.
 */
export async function readIngestBody(request: Request, limits: BodyLimits): Promise<unknown> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") throw new BodyError("unsupported");
  const encoding = (request.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (encoding !== "" && encoding !== "identity" && encoding !== "gzip") throw new BodyError("unsupported");
  const gz = encoding === "gzip";
  const wireCap = gz ? limits.maxCompressedBytes : limits.maxDecompressedBytes;

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > wireCap) throw new BodyError("too_large");
  if (!request.body) throw new BodyError("malformed");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > wireCap) {
        await reader.cancel().catch(() => {});
        throw new BodyError("too_large");
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof BodyError) throw err;
    throw new BodyError("malformed"); // aborted or broken stream
  }
  if (total === 0) throw new BodyError("malformed");

  let raw: Buffer = Buffer.concat(chunks, total);
  if (gz) {
    try {
      raw = await gunzipAsync(raw, { maxOutputLength: limits.maxDecompressedBytes });
    } catch (err) {
      if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new BodyError("too_large");
      throw new BodyError("malformed");
    }
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new BodyError("malformed");
  }
}
