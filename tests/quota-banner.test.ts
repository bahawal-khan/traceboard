import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuotaBanner } from "@/components/dashboard/quota-banner";
import { QuotaMeter } from "@/components/dashboard/quota-meter";
import { QUOTA_WARN_RATIO, quotaBanner, quotaLevel } from "@/lib/dashboard/quota-banner";

const render = (used: number | null | undefined, limit: number | null | undefined) => renderToStaticMarkup(createElement(QuotaBanner, { used, limit }));

describe("quotaLevel: thresholds, and unknown is never zero", () => {
  it("is ok below 80%, near from 80%, reached from 100% (also above)", () => {
    expect(quotaLevel(0, 1900)).toBe("ok");
    expect(quotaLevel(1519, 1900)).toBe("ok");
    expect(quotaLevel(1520, 1900)).toBe("near");
    expect(quotaLevel(1899, 1900)).toBe("near");
    expect(quotaLevel(1900, 1900)).toBe("reached");
    expect(quotaLevel(5000, 1900)).toBe("reached");
    expect(QUOTA_WARN_RATIO).toBe(0.8);
  });
  it("null, undefined, NaN, infinity, negatives and a non-positive limit are unknown", () => {
    for (const [u, l] of [[null, 1900], [5, null], [undefined, undefined], [NaN, 1900], [5, NaN], [Infinity, 10], [-1, 10], [5, 0], [5, -3]] as const) {
      expect(quotaLevel(u, l)).toBe("unknown");
    }
  });
});

describe("quotaBanner text", () => {
  it("says nothing when the numbers are fine or unknown", () => {
    expect(quotaBanner(10, 1900)).toBeNull();
    expect(quotaBanner(null, 1900)).toBeNull();
    expect(quotaBanner(1900, null)).toBeNull();
  });
  it("near: the real numbers and the UTC reset, neutral wording", () => {
    const b = quotaBanner(1600, 1900)!;
    expect(b.level).toBe("near");
    expect(b.body).toContain("1,600 of 1,900");
    expect(b.body).toContain("00:00 UTC");
  });
  it("reached: says new events are refused and stored events are unaffected", () => {
    const b = quotaBanner(1900, 1900)!;
    expect(b.level).toBe("reached");
    expect(b.title).toContain("reached");
    expect(b.body).toContain("refused until 00:00 UTC");
    expect(b.body).toContain("already stored are not affected");
  });
  it("mentions no internals (tables, rollups, keys, plan vendors, errors codes)", () => {
    for (const b of [quotaBanner(1600, 1900)!, quotaBanner(2000, 1900)!]) {
      expect(`${b.title} ${b.body}`).not.toMatch(/postgres|neon|vercel|usage_daily|rollup|429|api key|lm_|cron|conserve/i);
    }
  });
});

describe("QuotaBanner markup", () => {
  it("renders nothing for ok and unknown", () => {
    expect(render(3, 1900)).toBe("");
    expect(render(null, null)).toBe("");
  });
  it("is a polite status with an icon (aria-hidden) AND text, never colour alone", () => {
    for (const [u, level] of [[1700, "near"], [1900, "reached"]] as const) {
      const m = render(u, 1900);
      expect(m).toContain('role="status"');
      expect(m).not.toContain('role="alert"');
      expect(m).toContain(`data-quota-level="${level}"`);
      expect(m).toMatch(/<svg[^>]*aria-hidden="true"/);
      expect(m).toContain("1,900");
    }
  });
  it("near and reached use different icons and different titles", () => {
    expect(render(1700, 1900)).not.toBe(render(1900, 1900));
    expect(render(1700, 1900)).toContain("Close to today");
    expect(render(1900, 1900)).toContain("limit is reached");
  });
  it("the meter and the banner agree at every threshold", () => {
    for (const used of [0, 1519, 1520, 1899, 1900, 2500]) {
      const meter = renderToStaticMarkup(createElement(QuotaMeter, { used, limit: 1900 }));
      const level = quotaLevel(used, 1900);
      if (level === "reached") expect(meter).toContain("Quota reached");
      else if (level === "near") expect(meter).toContain("Approaching");
      else expect(meter).toContain("Within today");
    }
  });
});
