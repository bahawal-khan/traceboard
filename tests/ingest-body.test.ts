import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { BodyError, readIngestBody, type BodyLimits } from "@/lib/ingest/body";

const LIMITS: BodyLimits = { maxCompressedBytes: 1000, maxDecompressedBytes: 2000 };
const URL_ = "http://localhost/api/ingest";
const req = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request(URL_, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, duplex: "half" } as RequestInit);
const kind = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof BodyError ? e.kind : `other:${String(e)}`;
  }
};
/** A body delivered in chunks, with no Content-Length, that records whether it was cancelled. */
function chunked(chunks: Uint8Array[]) {
  const state = { cancelled: false, pulled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      const next = chunks[state.pulled++];
      if (next) c.enqueue(next);
      else c.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

describe("readIngestBody", () => {
  it("parses plain JSON, with or without a charset parameter", async () => {
    expect(await readIngestBody(req('{"a":1}'), LIMITS)).toEqual({ a: 1 });
    expect(await readIngestBody(req('{"a":1}', { "content-type": "Application/JSON; charset=utf-8" }), LIMITS)).toEqual({ a: 1 });
    expect(await readIngestBody(req('{"a":1}', { "content-encoding": "identity" }), LIMITS)).toEqual({ a: 1 });
  });

  it("parses a gzip body", async () => {
    expect(await readIngestBody(req(gzipSync('{"a":"é"}'), { "content-encoding": "gzip" }), LIMITS)).toEqual({ a: "é" });
    expect(await readIngestBody(req(gzipSync('{"a":1}'), { "content-encoding": " GZIP " }), LIMITS)).toEqual({ a: 1 });
  });

  it("refuses other content types and encodings with 'unsupported'", async () => {
    expect(await kind(readIngestBody(req("{}", { "content-type": "text/plain" }), LIMITS))).toBe("unsupported");
    expect(await kind(readIngestBody(req("{}", { "content-type": "" }), LIMITS))).toBe("unsupported");
    for (const enc of ["br", "deflate", "gzip, br", "zstd"]) {
      expect(await kind(readIngestBody(req("{}", { "content-encoding": enc }), LIMITS)), enc).toBe("unsupported");
    }
  });

  it("refuses a declared Content-Length above the cap WITHOUT reading the body", async () => {
    const { stream } = chunked([new TextEncoder().encode("{}")]);
    const r = req(stream, { "content-length": "5000" });
    expect(await kind(readIngestBody(r, LIMITS))).toBe("too_large");
    expect(r.bodyUsed).toBe(false); // nobody took a reader: the body was never consumed
  });

  it("stops reading and cancels the stream as soon as the real size passes the cap (no or false Content-Length)", async () => {
    const piece = new Uint8Array(400).fill(0x20);
    const { stream, state } = chunked(Array.from({ length: 50 }, () => piece));
    expect(await kind(readIngestBody(req(stream), { ...LIMITS, maxDecompressedBytes: 1000 }))).toBe("too_large");
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(10); // it did not drain all 50 chunks
    const liar = chunked(Array.from({ length: 50 }, () => piece));
    expect(await kind(readIngestBody(req(liar.stream, { "content-length": "10" }), { ...LIMITS, maxDecompressedBytes: 1000 }))).toBe("too_large");
  });

  it("applies the COMPRESSED cap to the wire bytes of a gzip body", async () => {
    // Incompressible-ish data so the compressed size is itself over the cap.
    const body = gzipSync(JSON.stringify({ x: randomBytes(2000).toString("base64") }));
    expect(body.length).toBeGreaterThan(LIMITS.maxCompressedBytes);
    expect(await kind(readIngestBody(req(body, { "content-encoding": "gzip" }), LIMITS))).toBe("too_large");
  });

  it("applies the DECOMPRESSED cap: a gzip bomb is stopped, not expanded", async () => {
    const bomb = gzipSync(Buffer.alloc(100 * 1024 * 1024, 0x20)); // 100 MB of spaces, a few hundred KB... or less, compressed
    expect(bomb.length).toBeLessThan(200_000);
    const big: BodyLimits = { maxCompressedBytes: 300_000, maxDecompressedBytes: 256_000 };
    const t = Date.now();
    expect(await kind(readIngestBody(req(bomb, { "content-encoding": "gzip" }), big))).toBe("too_large");
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("a multi-member gzip cannot get around the cap either", async () => {
    const member = gzipSync(Buffer.alloc(1500, 0x20));
    const both = Buffer.concat([member, member]); // each member fits, the total (3000) does not
    expect(both.length).toBeLessThan(LIMITS.maxCompressedBytes);
    expect(await kind(readIngestBody(req(both, { "content-encoding": "gzip" }), LIMITS))).toBe("too_large");
  });

  it("accepts a body of exactly the cap (plain and inflated) and refuses one byte more", async () => {
    const pad = (n: number) => `{"a":"${"x".repeat(n - 8)}"}`;
    expect(pad(2000)).toHaveLength(2000);
    expect(await kind(readIngestBody(req(pad(2000)), LIMITS))).toBe("ok");
    expect(await kind(readIngestBody(req(pad(2001)), LIMITS))).toBe("too_large");
    expect(await kind(readIngestBody(req(gzipSync(pad(2000)), { "content-encoding": "gzip" }), LIMITS))).toBe("ok");
    expect(await kind(readIngestBody(req(gzipSync(pad(2001)), { "content-encoding": "gzip" }), LIMITS))).toBe("too_large");
  });

  it("checks size BEFORE parsing: an oversized invalid body is 'too_large', not 'malformed'", async () => {
    expect(await kind(readIngestBody(req("{".repeat(5000)), LIMITS))).toBe("too_large");
  });

  it("answers 'malformed' for bad JSON, bad UTF-8, an empty body, a missing body and broken gzip", async () => {
    expect(await kind(readIngestBody(req("{not json"), LIMITS))).toBe("malformed");
    expect(await kind(readIngestBody(req(new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])), LIMITS))).toBe("malformed");
    expect(await kind(readIngestBody(req(""), LIMITS))).toBe("malformed");
    expect(await kind(readIngestBody(req(null), LIMITS))).toBe("malformed");
    expect(await kind(readIngestBody(req("not gzip", { "content-encoding": "gzip" }), LIMITS))).toBe("malformed");
    expect(await kind(readIngestBody(req(gzipSync('{"a":1}').subarray(0, 12), { "content-encoding": "gzip" }), LIMITS))).toBe("malformed");
    expect(await kind(readIngestBody(req('{"a":1}', { "content-encoding": "gzip" }), LIMITS))).toBe("malformed"); // claims gzip, is not
  });

  it("a stream that errors mid-way is 'malformed', never an unhandled error", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"a"'));
        c.error(new Error("socket hang up"));
      },
    });
    expect(await kind(readIngestBody(req(stream), LIMITS))).toBe("malformed");
  });

  it("carries no input in the error", async () => {
    try {
      await readIngestBody(req("{secret-token-123"), LIMITS);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-token-123");
    }
    void vi;
  });
});
