/**
 * Server-side redaction of opt-in content, applied even though the SDK can also redact locally
 * (defence in depth: a client that does not redact must still not get secrets or contact data stored).
 * It is heuristic. It removes obvious secrets, emails, card numbers (Luhn-checked) and phone-like digit
 * runs; it cannot find names or free-text PII, which is why capture stays opt-in and short-lived.
 * Order matters: secrets first, then emails, cards, phones. Redact BEFORE truncating, so a secret cut in
 * half by the size cap cannot slip through as an unmatched prefix.
 */
export interface RedactionReport {
  secret: number;
  email: number;
  card: number;
  phone: number;
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /lm_[A-Za-z0-9_-]{16,}/g, // distinctive enough to match even when glued to a preceding word
  /\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+/gi,
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const CARD_CANDIDATE = /(?<![\w-])(?:\d[ -]?){12,18}\d(?![\w-])/g;
const PHONE_CANDIDATE = /(?<![\w.-])(?:\+|\()?\d[\d\s().-]{7,}\d(?![\w-])/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function redactText(input: string): { text: string; report: RedactionReport } {
  const report: RedactionReport = { secret: 0, email: 0, card: 0, phone: 0 };
  let text = input;
  for (const re of SECRET_PATTERNS) {
    text = text.replace(re, () => {
      report.secret++;
      return "[redacted:secret]";
    });
  }
  text = text.replace(EMAIL, () => {
    report.email++;
    return "[redacted:email]";
  });
  text = text.replace(CARD_CANDIDATE, (m) => {
    const digits = m.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return m;
    report.card++;
    return "[redacted:card]";
  });
  text = text.replace(PHONE_CANDIDATE, (m) => {
    const digits = m.replace(/\D/g, "").length;
    if (digits < 9 || digits > 15) return m; // dates, versions, IPs and short numbers stay
    report.phone++;
    return "[redacted:phone]";
  });
  return { text, report };
}

/** Cuts to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return { text: s, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // back up to a character boundary
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}
