import { decryptString, encryptString, type KeyRing } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { QUOTAS } from "@/lib/quotas";
import { redactText, truncateUtf8, type RedactionReport } from "./redact";

/**
 * Opt-in content capture: redact -> truncate -> encrypt, in that order, before anything reaches the
 * database. Plaintext content is never stored, never logged, and never part of an SQL string.
 * Whether it is stored at all is decided in the ingest statement by `projects.capture_content`.
 */
export const CONTENT_KEY_VERSION = 1;

export interface ContentCipher {
  readonly keyVersion: number;
  encrypt(plaintext: string, aad: string): string;
  decrypt(payload: string, aad: string): string;
}

export function createContentCipher(key: Buffer, keyVersion = CONTENT_KEY_VERSION): ContentCipher {
  const ring: KeyRing = new Map([[keyVersion, key]]);
  return {
    keyVersion,
    encrypt: (plaintext, aad) => encryptString(key, keyVersion, plaintext, aad),
    decrypt: (payload, aad) => decryptString(ring, payload, aad),
  };
}

/** The cipher for this deployment, or null when CONTENT_ENCRYPTION_KEY is not set (content then is dropped). */
export function contentCipherFromEnv(): ContentCipher | null {
  const k = getEnv().CONTENT_ENCRYPTION_KEY;
  return k ? createContentCipher(Buffer.from(k, "base64")) : null;
}

/** Binds a ciphertext to its project, event and field: moved or swapped ciphertexts fail to decrypt. */
export function contentAad(projectId: string, eventId: string, field: "input" | "output"): string {
  return `content|${projectId}|${eventId}|${field}`;
}

export interface PreparedContent {
  input: string | null;
  output: string | null;
  report: { v: 1; enc: "aes-256-gcm"; keyVersion: number; redactions: RedactionReport; truncated: boolean };
}

const sum = (a: RedactionReport, b: RedactionReport): RedactionReport => ({
  secret: a.secret + b.secret,
  email: a.email + b.email,
  card: a.card + b.card,
  phone: a.phone + b.phone,
});

/** Null when the event has no content to store. */
export function prepareContent(
  cipher: ContentCipher,
  projectId: string,
  eventId: string,
  content: { input?: string; output?: string } | null,
): PreparedContent | null {
  if (!content || (content.input === undefined && content.output === undefined)) return null;
  let redactions: RedactionReport = { secret: 0, email: 0, card: 0, phone: 0 };
  let truncated = false;
  const one = (field: "input" | "output", value: string | undefined): string | null => {
    if (value === undefined) return null;
    const r = redactText(value);
    redactions = sum(redactions, r.report);
    const t = truncateUtf8(r.text, QUOTAS.contentCaptureBytesPerEvent);
    truncated ||= t.truncated;
    return cipher.encrypt(t.text, contentAad(projectId, eventId, field));
  };
  return {
    input: one("input", content.input),
    output: one("output", content.output),
    report: { v: 1, enc: "aes-256-gcm", keyVersion: cipher.keyVersion, redactions, truncated },
  };
}
