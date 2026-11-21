import { describe, expect, it } from "vitest";
import {
  UNKNOWN,
  formatCompact,
  formatCostMicro,
  formatCostUsd,
  formatDuration,
  formatInt,
  formatPercent,
  formatUtc,
} from "@/lib/format";

describe("formatCostUsd", () => {
  it("renders an unknown cost as a dash, never as zero", () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatCostUsd(v)).toBe(UNKNOWN);
      expect(formatCostUsd(v)).not.toMatch(/0/);
    }
  });
  it("renders a real zero as $0.00, distinct from unknown", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
    expect(formatCostUsd(0)).not.toBe(formatCostUsd(null));
  });
  it("keeps significant digits for tiny costs instead of rounding them to $0.00", () => {
    expect(formatCostUsd(0.000123)).toBe("$0.000123");
    expect(formatCostUsd(0.0000004)).toBe("<$0.000001");
    expect(formatCostUsd(0.0004)).not.toBe("$0.00");
  });
  it("uses sensible precision at larger sizes", () => {
    expect(formatCostUsd(0.05)).toBe("$0.050");
    expect(formatCostUsd(12.345)).toBe("$12.35");
    expect(formatCostUsd(12345.6)).toBe("$12,346");
    expect(formatCostUsd(-1.5)).toBe("-$1.50");
  });
});

describe("formatCostMicro", () => {
  it("converts micro-USD and keeps null unknown", () => {
    expect(formatCostMicro(1_500_000)).toBe("$1.50");
    expect(formatCostMicro(0)).toBe("$0.00");
    expect(formatCostMicro(null)).toBe(UNKNOWN);
  });
});

describe("formatCompact / formatInt", () => {
  it("is exact below 1,000 and abbreviates above", () => {
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(1000)).toBe("1k");
    expect(formatCompact(1234)).toBe("1.2k");
    expect(formatCompact(1_500_000)).toBe("1.5M");
    expect(formatCompact(250_000)).toBe("250k");
    expect(formatCompact(null)).toBe(UNKNOWN);
  });
  it("groups digits", () => {
    expect(formatInt(1234567)).toBe("1,234,567");
    expect(formatInt(undefined)).toBe(UNKNOWN);
  });
});

describe("formatDuration", () => {
  it("scales units", () => {
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(1200)).toBe("1.2 s");
    expect(formatDuration(2000)).toBe("2 s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(null)).toBe(UNKNOWN);
    expect(formatDuration(-5)).toBe(UNKNOWN);
  });
});

describe("formatPercent", () => {
  it("formats fractions", () => {
    expect(formatPercent(0.125)).toBe("12.5%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(null)).toBe(UNKNOWN);
  });
});

describe("formatUtc", () => {
  it("is deterministic UTC text", () => {
    expect(formatUtc("2026-11-21T14:05:59Z")).toBe("2026-11-21 14:05 UTC");
    expect(formatUtc("nonsense")).toBe(UNKNOWN);
    expect(formatUtc(null)).toBe(UNKNOWN);
  });
});
