import { describe, expect, it } from "vitest";
import { redactText, truncateUtf8 } from "@/lib/ingest/redact";

describe("redactText", () => {
  it("removes emails", () => {
    const r = redactText("mail me at jane.doe+x@example.co.uk or bob@corp.io today");
    expect(r.text).toBe("mail me at [redacted:email] or [redacted:email] today");
    expect(r.report.email).toBe(2);
  });

  it("removes API keys, tokens and connection strings", () => {
    const secrets = [
      `lm_${"A".repeat(43)}`,
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      "sk_live_abcdefghijklmnop1234",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.0123456789",
      "AKIAABCDEFGHIJKLMNOP",
      `ghp_${"a1".repeat(20)}`,
      "xoxb-1234567890-abcdefghij",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
      "postgres://user:pw@host.neon.tech/db",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----",
    ];
    for (const s of secrets) {
      const r = redactText(`before ${s} after`);
      expect(r.text, s).toContain("[redacted:secret]");
      expect(r.text, s).not.toContain(s.slice(10, 30));
      expect(r.report.secret, s).toBeGreaterThanOrEqual(1);
    }
  });

  it("removes Luhn-valid card numbers only", () => {
    expect(redactText("pay 4111 1111 1111 1111 now").text).toBe("pay [redacted:card] now");
    expect(redactText("card 5500-0000-0000-0004.").report.card).toBe(1);
    const notCard = redactText("order 1234 5678 9012 3456 ok"); // fails Luhn
    expect(notCard.report.card).toBe(0);
  });

  it("removes phone-like numbers but leaves dates, IPs, versions and short numbers", () => {
    expect(redactText("call +92 300 1234567 please").text).toBe("call [redacted:phone] please");
    expect(redactText("(555) 123-4567").text).toBe("[redacted:phone]");
    for (const keep of ["on 2026-11-20 at 12:30", "ip 10.0.0.1", "v1.2.3.4567", "total 12345", "id 20261120"]) {
      expect(redactText(keep).text, keep).toBe(keep);
    }
  });

  it("conservatively treats long digit-dotted addresses as phone-like (an IP is personal data too)", () => {
    expect(redactText("from 192.168.100.200").report.phone).toBe(1);
  });

  it("is a no-op on clean text and reports zeros", () => {
    const r = redactText("Summarise the quarterly report in three bullets.");
    expect(r.text).toBe("Summarise the quarterly report in three bullets.");
    expect(r.report).toEqual({ secret: 0, email: 0, card: 0, phone: 0 });
  });

  it("counts every kind in one pass", () => {
    const r = redactText(`key lm_${"B".repeat(43)} mail a@b.co card 4111111111111111 tel +1 415 555 2671`);
    expect(r.report).toEqual({ secret: 1, email: 1, card: 1, phone: 1 });
  });
});

describe("truncateUtf8", () => {
  it("cuts on a character boundary and reports it", () => {
    const r = truncateUtf8("é".repeat(10), 5); // 2 bytes each
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("éé");
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(5);
    expect(r.text).not.toContain("�");
    expect(truncateUtf8("🙂🙂", 5).text).toBe("🙂");
  });

  it("leaves short text alone", () => {
    expect(truncateUtf8("abc", 10)).toEqual({ text: "abc", truncated: false });
    expect(truncateUtf8("abc", 3)).toEqual({ text: "abc", truncated: false });
  });
});
