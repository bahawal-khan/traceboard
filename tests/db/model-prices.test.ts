import { neon } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";
import { loadModelPrices } from "@/db/seed/model-prices.schema.mjs";

/** Run `npm run db:seed` first. As app_rw: reads work, writes are denied. Skipped without DATABASE_URL. */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("model_prices (app_rw)", () => {
  const sql = neon(url!);
  const file = loadModelPrices();

  it("contains every seeded model with exactly the seed prices (run npm run db:seed if this fails)", async () => {
    const rows = await sql`select model, provider, input_per_1m::text as i, output_per_1m::text as o, cached_input_per_1m::text as c from model_prices`;
    const byModel = new Map(rows.map((r) => [r.model as string, r]));
    for (const m of file.models) {
      const r = byModel.get(m.model);
      expect(r, `${m.model} missing: run npm run db:seed`).toBeDefined();
      expect(r!.provider).toBe(m.provider);
      expect(Number(r!.i)).toBe(Number(m.inputPer1m));
      expect(Number(r!.o)).toBe(Number(m.outputPer1m));
      expect(r!.c === null ? null : Number(r!.c)).toBe(m.cachedInputPer1m === null ? null : Number(m.cachedInputPer1m));
    }
  });

  it("is readable by the runtime role but not writable", async () => {
    await expect(sql`insert into model_prices (model, provider, input_per_1m, output_per_1m) values ('hack', 'x', 0, 0)`).rejects.toThrow(/permission denied/i);
    await expect(sql`update model_prices set input_per_1m = 0`).rejects.toThrow(/permission denied/i);
    await expect(sql`delete from model_prices`).rejects.toThrow(/permission denied/i);
  });
});
