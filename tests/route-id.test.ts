import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_ID_CHARS, decodeRouteIdParam, isValidIdText } from "@/lib/dashboard/route-id";
import { parseThreadIdParam } from "@/lib/dashboard/thread-detail-view";
import { parseTraceIdParam, traceDetailHref } from "@/lib/dashboard/trace-detail-view";
import { HOSTILE_THREAD_IDS } from "@/lib/dashboard/thread-fixtures";
import { threadDetailHref } from "@/lib/dashboard/threads-view";
import { getDemoTraceIds } from "@/lib/demo/traces";
import { traceIdSchema } from "@/lib/repo/trace-detail";

/**
 * The id a dynamic route hands a page. Next 16 passes the PERCENT-ENCODED segment (shared/lib/router/utils/get-dynamic-param.js
 * encodes it with encodeURIComponent), the link helpers encode with the same function, so one decode restores the id. These
 * tests run the real link helpers into the real decoder, the way a click does.
 */
const TRACES = "/dashboard/projects/p1/traces";
const THREADS = "/dashboard/projects/p1/threads";
const read = (f: string) => readFileSync(f, "utf8");

/** What Next gives the page for a link: the segment after the base path, exactly as the browser sends it (still encoded). */
const segmentOf = (href: string, base: string) => href.slice(base.length + 1);

const SPECIAL_IDS = [
  "tr-ok", "has space", "a b  c", "a/b", "/", "a//b", "100%", "%", "%%", "a%20b", "%2F", "%25", "..", ".", "../..", "../etc/passwd",
  "a?b", "a#b", "a?b=c&d=e#f", "a\\b", "q\"uo'te", "<script>alert(1)</script>", "é", "ünïcödé", "日本語のトレース", "сессия", "😀", "👨‍👩‍👧", "a😀b", "💬".repeat(64),
  "x".repeat(128), "a+b", "a;b", "a:b@c", "[]{}|^`", "tab-free but long " + "y".repeat(60), "‮bidi‬", "zero​width",
] as const;

describe("a trace id round-trips through the real link helper and the decoder", () => {
  it.each(SPECIAL_IDS.map((id) => [id]))("%j", (id) => {
    const href = traceDetailHref(TRACES, id);
    const segment = segmentOf(href, TRACES);
    // one path segment: no separator, query, fragment, space or markup (an apostrophe is a legal, unescaped path character)
    expect(segment, "one path segment, no query, no fragment").not.toMatch(/[/?#\\ <>"]/);
    expect(decodeRouteIdParam(segment)).toBe(id);
    // Next re-encodes the decoded segment before the page sees it: the same string the browser sent for these ids
    expect(decodeRouteIdParam(encodeURIComponent(id))).toBe(id);
    // and the original id is what getTrace would receive: it passes the repo's own id rule
    expect(traceIdSchema.safeParse(decodeRouteIdParam(segment)).success).toBe(true);
  });
  it("every hostile id of the thread fixtures round-trips too, for both link helpers", () => {
    for (const id of HOSTILE_THREAD_IDS) {
      expect(decodeRouteIdParam(segmentOf(traceDetailHref(TRACES, id), TRACES))).toBe(id);
      expect(decodeRouteIdParam(segmentOf(threadDetailHref(THREADS, id), THREADS))).toBe(id);
    }
  });
  it("decodes exactly once: a literal %XX inside an id is not decoded a second time", () => {
    for (const id of ["a%20b", "%2F", "100%25", "%E0%A4%A", "%00", "%0A"]) {
      expect(decodeRouteIdParam(encodeURIComponent(id)), id).toBe(id);
    }
    expect(decodeRouteIdParam("a%2520b")).toBe("a%20b");
  });
  it("without the decoder a special id would NOT arrive intact (the bug this step fixes)", () => {
    for (const id of ["has space", "a/b", "100%", "é", "😀"]) {
      const segment = segmentOf(traceDetailHref(TRACES, id), TRACES);
      expect(parseTraceIdParam(segment) === id, id).toBe(false); // the old page passed the encoded text on
    }
  });
});

describe("what the decoder refuses (null: the one neutral not-found, no database call)", () => {
  const bad: Array<[string, unknown]> = [
    ["undefined", undefined], ["an array", ["a"]], ["an empty array", []], ["empty", ""],
    ["a lone percent", "%"], ["a short escape", "%E"], ["a truncated UTF-8 sequence", "%E0%A4%A"], ["a non-hex escape", "%ZZ"],
    ["an invalid UTF-8 byte", "%FF"], ["an overlong encoding", "%C0%AF"], ["a lone high surrogate", "%ED%A0%80"],
    ["NUL", "%00"], ["NUL inside", "a%00b"], ["newline", "%0A"], ["carriage return", "%0D"], ["tab", "%09"], ["unit separator", "%1F"], ["DEL", "%7F"],
    ["a raw newline", "a\nb"], ["a raw NUL", "a\u0000b"],
    ["129 characters", "x".repeat(129)], ["129 characters, encoded", encodeURIComponent("x".repeat(129))], ["129 emoji (code points)", encodeURIComponent("😀".repeat(129))], ["a lone surrogate", "a\uD800b"], ["a lone low surrogate", "\uDC00"],
    ["a 100,000-character segment", "x".repeat(100_000)], ["a huge run of escapes", "%41".repeat(50_000)],
  ];
  it.each(bad)("%s", (_name, raw) => {
    expect(decodeRouteIdParam(raw as never)).toBeNull();
  });
  it("accepts the limits exactly: 1 character, 128 characters, and 128 code points of emoji (the repo counts code points, not UTF-16 units)", () => {
    expect(decodeRouteIdParam("a")).toBe("a");
    expect(decodeRouteIdParam("x".repeat(MAX_ID_CHARS))).toBe("x".repeat(128));
    expect(decodeRouteIdParam(encodeURIComponent("😀".repeat(65)))).toBe("😀".repeat(65)); // 130 UTF-16 units: the repo accepts it, so must the page
    expect(decodeRouteIdParam(encodeURIComponent("😀".repeat(128)))).toBe("😀".repeat(128)); // the longest encoded form: 12 characters per code point
    expect(decodeRouteIdParam(encodeURIComponent("☃".repeat(128)))).toBe("☃".repeat(128));
  });
  it("agrees with the repo's own schema at the limit, in both directions, for emoji and astral text", () => {
    for (const n of [63, 64, 65, 127, 128, 129, 130]) {
      const id = "😀".repeat(n);
      expect(decodeRouteIdParam(encodeURIComponent(id)) !== null, `${n} emoji`).toBe(traceIdSchema.safeParse(id).success);
    }
  });
  it("never throws, whatever it is given", () => {
    for (const v of [null, 0, {}, Symbol.iterator, "%", "%%%", "\uD800", "%\uD800"]) expect(() => decodeRouteIdParam(v as never)).not.toThrow();
  });
});

describe("one rule everywhere", () => {
  it("isValidIdText, the trace validator and the repo's trace id schema accept exactly the same strings", () => {
    const samples = ["", "a", "x".repeat(128), "x".repeat(129), "a\u0000b", "a\nb", "a\tb", "a\u007fb", "a b", "é☃", "😀", "../x", "%00", "<script>", "💬".repeat(64), "💬".repeat(65), "💬".repeat(128), "💬".repeat(129)];
    for (const s of samples) {
      expect(isValidIdText(s), JSON.stringify(s)).toBe(traceIdSchema.safeParse(s).success);
      expect(parseTraceIdParam(s) !== null, JSON.stringify(s)).toBe(traceIdSchema.safeParse(s).success);
    }
  });
  it("parseTraceIdParam still validates an id AS IT IS (it does not decode)", () => {
    expect(parseTraceIdParam("%00")).toBe("%00");
    expect(parseTraceIdParam("a%20b")).toBe("a%20b");
    expect(parseTraceIdParam("tr-ok")).toBe("tr-ok");
  });
  it("parseThreadIdParam is the shared decoder", () => {
    for (const id of SPECIAL_IDS) expect(parseThreadIdParam(encodeURIComponent(id))).toBe(decodeRouteIdParam(encodeURIComponent(id)));
    expect(parseThreadIdParam("%E0%A4%A")).toBeNull();
    expect(parseThreadIdParam("a%20b")).toBe("a b");
  });
});

describe("fuzz", () => {
  it("random segments never throw, and anything accepted is a valid id that encodes back to the same decode", () => {
    let seed = 20261126;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const alphabet = "abcXYZ019%2F3AFZ0/?#\\ \u0000\n\t\u007f‮​%%é☃😀\uD800";
    let accepted = 0;
    for (let i = 0; i < 3_000; i++) {
      let s = "";
      for (let j = Math.floor(rnd() * 60); j > 0; j--) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const r = decodeRouteIdParam(s);
      if (r !== null) {
        accepted++;
        expect(traceIdSchema.safeParse(r).success, JSON.stringify(s)).toBe(true);
        expect(decodeRouteIdParam(encodeURIComponent(r))).toBe(r);
      }
    }
    expect(accepted).toBeGreaterThan(100); // the fuzz is not vacuous: plenty of inputs decode
  });
  it("random VALID ids always round-trip through both link helpers", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const pool = [..."abcXYZ019 /%?#&=+.-_~é☃日😀'\"<>\\:;,@!$()*[]{}|^`"];
    for (let i = 0; i < 1_000; i++) {
      let id = "";
      for (let j = 1 + Math.floor(rnd() * 40); j > 0; j--) id += pool[Math.floor(rnd() * pool.length)];
      if (!isValidIdText(id)) continue; // a split surrogate pair is still valid UTF-16 text for the rule, only unencodable
      let href: string;
      try {
        href = traceDetailHref(TRACES, id);
      } catch {
        continue; // encodeURIComponent refuses a lone surrogate; ingest would never produce one in a link
      }
      expect(decodeRouteIdParam(segmentOf(href, TRACES)), JSON.stringify(id)).toBe(id);
    }
  });
});

describe("the pages use the decoder", () => {
  const tracePage = read("app/dashboard/projects/[id]/traces/[traceId]/page.tsx");
  const threadPage = read("app/dashboard/projects/[id]/threads/[threadId]/page.tsx");
  it("the trace page decodes before the session and hands getTrace the DECODED id", () => {
    expect(tracePage).toContain('import { decodeRouteIdParam } from "@/lib/dashboard/route-id"');
    expect(tracePage).toContain("const traceId = decodeRouteIdParam(rawTraceId)");
    expect(tracePage.indexOf("decodeRouteIdParam(rawTraceId)")).toBeLessThan(tracePage.indexOf("ctxFromSession()"));
    expect(tracePage).toMatch(/if \(traceId === null\) notFound\(\);/);
    expect(tracePage.indexOf("decodeRouteIdParam(rawTraceId)")).toBeLessThan(tracePage.indexOf("getTrace(ctx, id, traceId)"));
    expect(tracePage).toContain("getTrace(ctx, id, traceId)");
    expect(tracePage).not.toContain("parseTraceIdParam"); // the undecoded validator must not come back into the page
  });
  it("the thread page decodes through the same rule", () => {
    expect(threadPage).toContain("parseThreadIdParam(rawThreadId)");
    expect(threadPage.indexOf("parseThreadIdParam(rawThreadId)")).toBeLessThan(threadPage.indexOf("ctxFromSession()"));
  });
  it("the route-id module is pure: no React, no repo, no database, no environment", () => {
    const s = read("lib/dashboard/route-id.ts");
    expect(s).not.toMatch(/@\/lib\/repo|@\/lib\/db|@clerk|from "react"|process\.env|["']use client["']/);
  });
});

describe("the public demo needs no decoding today, and a test says when that stops being true", () => {
  it("every demo trace id is unchanged by encodeURIComponent (so the encoded segment Next passes IS the id)", () => {
    const ids = getDemoTraceIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(encodeURIComponent(id), id).toBe(id);
  });
  it("the demo page only looks ids up in the committed sample (dynamicParams = false) and says why it does not decode", () => {
    const demo = read("app/demo/traces/[traceId]/page.tsx");
    expect(demo).toContain("export const dynamicParams = false");
    expect(demo).toContain("tests/route-id.test.ts");
  });
});
