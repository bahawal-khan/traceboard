/**
 * Structured JSON logger. Never logs payloads, headers, or keys: sensitive
 * field names are redacted and secret-looking values are scrubbed, even
 * inside error messages. Use the request id from lib/request-id.ts.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY =
  /authorization|cookie|set-cookie|secret|password|passwd|token|api[-_]?key|apikey|private|ciphertext|nonce|headers?|body|payload|prompt|input_text|output_text|content|messages|key_hash|^key$|^input$|^output$/i;

const SECRET_VALUE: Array<[RegExp, string]> = [
  [/\blm_[A-Za-z0-9_-]{8,}/g, "lm_[redacted]"],
  [/\b(sk|pk|rk)[-_](live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\b(postgres(?:ql)?):\/\/[^\s"']+/gi, "$1://[redacted]"],
];

const MAX_DEPTH = 4;
const MAX_STRING = 500;

export function scrubString(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_VALUE) out = out.replace(re, rep);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}...[truncated]` : out;
}

export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };
  if (depth >= MAX_DEPTH) return "[depth-limit]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : sanitize(v, depth + 1);
    }
    return out;
  }
  return "[unsupported]";
}

export type LogFields = Record<string, unknown> & { requestId?: string };

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(base: LogFields): Logger;
}

export function createLogger(
  base: LogFields = {},
  opts: { minLevel?: Level; sink?: (line: string) => void } = {},
): Logger {
  const min = ORDER[opts.minLevel ?? (process.env.NODE_ENV === "production" ? "info" : "debug")];
  const sink = opts.sink ?? ((line: string) => console.log(line));
  const emit = (level: Level, msg: string, fields?: LogFields) => {
    if (ORDER[level] < min) return;
    const record = sanitize({ ...base, ...fields }) as Record<string, unknown>;
    sink(JSON.stringify({ level, time: new Date().toISOString(), msg: scrubString(msg), ...record }));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (extra) => createLogger({ ...base, ...extra }, opts),
  };
}

export const logger = createLogger();
