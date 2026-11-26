/**
 * The ONE place that decides what a user-supplied id in a URL path may be, and how it is decoded. Pure: no React, no DOM, no
 * repo. Used by the signed-in thread and trace pages (and the validators they share with the demo).
 *
 * Why decode: Next.js hands a page its dynamic segment PERCENT-ENCODED (checked in next 16.4.6:
 * shared/lib/router/utils/get-dynamic-param.js re-encodes it with encodeURIComponent before it reaches the page). The link
 * helpers (`traceDetailHref`, `threadDetailHref`) encode with the same function, so ONE decodeURIComponent restores the id
 * exactly. Decoding twice would corrupt an id that contains a literal "%20".
 */

/**
 * The ingest rule for every id: 1 to 128 characters, no control characters. "Characters" are Unicode CODE POINTS, exactly as
 * zod 4 counts them in `traceIdSchema` / the ingest `label()` (checked on zod 4.6.7: 65 emoji = 130 UTF-16 units pass
 * `.max(128)`, 129 emoji fail). Counting UTF-16 units here would refuse ids the rest of the system accepts.
 */
export const MAX_ID_CHARS = 128;

const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
// A lone surrogate half: not text, cannot come out of decodeURIComponent, and a database driver would refuse it.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Longest encoded form worth looking at: a code point takes at most 12 characters in encodeURIComponent (4 UTF-8 bytes of
 * "%XX"). Anything longer cannot be a valid id, so it is refused before decoding.
 */
const MAX_ENCODED_CHARS = MAX_ID_CHARS * 12;

/** Code points in `s`, without building an array for a long string (a code point is at most 2 units, so > 256 units is too long). */
function codePointLength(s: string): number {
  if (s.length > MAX_ID_CHARS * 2) return Number.POSITIVE_INFINITY;
  return Array.from(s).length;
}

/** True for a string that is a valid id as it is (already decoded): the same rule as `traceIdSchema`. */
export function isValidIdText(s: string): boolean {
  if (s.length === 0 || !NO_CONTROL.test(s)) return false;
  return codePointLength(s) <= MAX_ID_CHARS;
}

/**
 * The id from a dynamic route segment: decoded once, then validated. Returns null (the page shows the one not-found page and
 * makes no database call) for anything that is not a single string, an over-long segment, a malformed escape ("%", "%E0%A4%A",
 * "%ZZ"), or a decoded id that is empty, longer than 128 code points, holds a control character (NUL, newline, DEL, ...) or
 * is not well-formed text (a lone surrogate).
 */
export function decodeRouteIdParam(raw: string | string[] | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_ENCODED_CHARS) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // a malformed escape throws URIError; nothing about it is reported
  }
  return isValidIdText(decoded) && !LONE_SURROGATE.test(decoded) ? decoded : null;
}
