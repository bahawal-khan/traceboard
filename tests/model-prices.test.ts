import { describe, expect, it } from "vitest";
import { loadModelPrices, modelEntry, modelPriceFile } from "@/db/seed/model-prices.schema.mjs";

const file = loadModelPrices();
const OFFICIAL_HOSTS: Record<string, string[]> = {
  openai: ["developers.openai.com", "platform.openai.com", "openai.com"],
  anthropic: ["platform.claude.com", "docs.anthropic.com", "claude.com"],
  google: ["aistudio.google.com", "ai.google.dev"],
};

describe("model price seed data", () => {
  it("validates against the schema", () => {
    expect(() => modelPriceFile.parse(JSON.parse(JSON.stringify(file)))).not.toThrow();
    expect(file.models.length).toBeGreaterThanOrEqual(20);
  });

  it("covers every provider and has unique model ids", () => {
    expect(new Set(file.models.map((m: { provider: string }) => m.provider))).toEqual(new Set(["openai", "anthropic", "google"]));
    const ids = file.models.map((m: { model: string }) => m.model);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("points every provider at an official https pricing page, verified on a real past-or-today date", () => {
    for (const [provider, s] of Object.entries(file.sources) as [string, { url: string; verifiedOn: string }][]) {
      expect(OFFICIAL_HOSTS[provider], provider).toContain(new URL(s.url).hostname);
      expect(new Date(s.verifiedOn).getTime()).toBeLessThanOrEqual(Date.now());
      expect(Number.isNaN(new Date(s.verifiedOn).getTime())).toBe(false);
    }
  });

  it("has sane prices: positive, cached <= input, long-context never cheaper than short", () => {
    for (const m of file.models) {
      expect(Number(m.inputPer1m), m.model).toBeGreaterThan(0);
      expect(Number(m.outputPer1m), m.model).toBeGreaterThan(0);
      if (m.cachedInputPer1m !== null) expect(Number(m.cachedInputPer1m), m.model).toBeLessThanOrEqual(Number(m.inputPer1m));
      if (m.longContext) {
        expect(Number(m.longContext.inputPer1m), m.model).toBeGreaterThanOrEqual(Number(m.inputPer1m));
        expect(Number(m.longContext.outputPer1m), m.model).toBeGreaterThanOrEqual(Number(m.outputPer1m));
      }
    }
  });

  it("keeps out models whose price changes soon or is promotional", () => {
    const ids = new Set(file.models.map((m: { model: string }) => m.model));
    for (const e of file.excluded) expect(ids.has(e.model), `${e.model} is documented as excluded`).toBe(false);
    for (const id of ["gpt-5.6-sol", "gemini-4-carbon", "gemini-4-argon", "gemini-3.8-flash", "gemini-3.6-flash"]) expect(ids.has(id)).toBe(false);
  });

  it("records the Claude models the SDK default list uses, with the cross-checked prices", () => {
    const by = Object.fromEntries(file.models.map((m: { model: string }) => [m.model, m]));
    expect(by["claude-fable-5-2"]).toMatchObject({ inputPer1m: "8.00", cachedInputPer1m: "0.20", outputPer1m: "40.00" });
    expect(by["claude-opus-5-5"]).toMatchObject({ inputPer1m: "4.00", cachedInputPer1m: "0.20", outputPer1m: "20.00" });
    expect(by["claude-sonnet-5-5"]).toMatchObject({ inputPer1m: "2.00", cachedInputPer1m: "0.10", outputPer1m: "10.00" });
    expect(by["claude-haiku-5-5"]).toMatchObject({ inputPer1m: "0.10", cachedInputPer1m: "0.01", outputPer1m: "0.50", longContext: { thresholdTokens: 100000 } });
  });

  it("rejects malformed entries", () => {
    const ok = { model: "x-1", provider: "openai", inputPer1m: "1.00", cachedInputPer1m: null, outputPer1m: "2.00" };
    expect(() => modelEntry.parse(ok)).not.toThrow();
    for (const bad of [
      { ...ok, inputPer1m: "-1" },
      { ...ok, inputPer1m: "1e3" },
      { ...ok, inputPer1m: 1 },
      { ...ok, model: "Has Space" },
      { ...ok, provider: "other" },
      { ...ok, extra: true },
      { ...ok, inputPer1m: "1.1234567" },
    ]) expect(() => modelEntry.parse(bad), JSON.stringify(bad)).toThrow();
  });
});
