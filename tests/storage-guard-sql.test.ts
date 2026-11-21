import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIZING, STORAGE_GUARD } from "@/lib/quotas";

/** Static checks of db/migrations/0012_storage_guard.sql (no database needed). */
const sql = readFileSync("db/migrations/0012_storage_guard.sql", "utf8");
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const body = (fn: string) => {
  const start = code.search(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${fn}\\s*\\(`));
  expect(start, fn).toBeGreaterThan(-1);
  const next = code.slice(start + 10).search(/\nCREATE (?:OR REPLACE )?FUNCTION /);
  return code.slice(start, next === -1 ? undefined : start + 10 + next);
};
const NEW = ["storage_level_for", "apply_storage_level", "apply_storage_guard"];

describe("0012 storage guard: thresholds match lib/quotas.ts", () => {
  it("storage_level_for uses the warn, critical and release-margin numbers of STORAGE_GUARD", () => {
    const b = body("storage_level_for");
    const crit = STORAGE_GUARD.pauseSignupsAt.toFixed(2);
    const warn = STORAGE_GUARD.warnAt.toFixed(2);
    const margin = STORAGE_GUARD.releaseMargin.toFixed(2);
    expect(b).toContain(`p_ratio >= ${crit} THEN 'critical'`);
    expect(b).toContain(`p_previous = 'critical' AND p_ratio >= ${crit} - ${margin}`);
    expect(b).toContain(`p_ratio >= ${warn} THEN 'warn'`);
    expect(b).toContain(`p_previous IN ('critical', 'warn') AND p_ratio >= ${warn} - ${margin}`);
  });
  it("the database-size ratio uses the 1 GB cap of SIZING", () => {
    expect(body("apply_storage_guard")).toContain(`database_bytes::numeric / ${SIZING.databaseBytes}`);
  });
  it("the release margin is positive and keeps the bands apart (hysteresis)", () => {
    expect(STORAGE_GUARD.releaseMargin).toBeGreaterThan(0);
    expect(STORAGE_GUARD.warnAt + 0).toBeLessThan(STORAGE_GUARD.pauseSignupsAt - STORAGE_GUARD.releaseMargin);
  });
});

describe("0012 storage guard: locked down", () => {
  it("every new function is SECURITY DEFINER (except the pure one) with a pinned search_path", () => {
    for (const n of NEW) {
      const b = body(n).split("$fn$")[0]!.split("AS $$")[0]!;
      expect(b, n).toContain("SET search_path = pg_catalog, public");
      if (n !== "storage_level_for") expect(b, n).toContain("SECURITY DEFINER");
    }
    expect(body("storage_level_for")).toContain("IMMUTABLE");
    expect(body("claim_user_slot")).toContain("SECURITY DEFINER");
    expect(body("claim_user_slot")).toContain("SET search_path = pg_catalog, public");
  });
  it("revokes EXECUTE from PUBLIC explicitly and grants to app_job only (never app_rw)", () => {
    const sigs: Record<string, string> = { storage_level_for: "text, numeric", apply_storage_level: "text", apply_storage_guard: "" };
    for (const n of NEW) {
      expect(code, n).toContain(`REVOKE ALL ON FUNCTION ${n}(${sigs[n]}) FROM PUBLIC;`);
      expect(code, n).toContain(`GRANT EXECUTE ON FUNCTION ${n}(${sigs[n]}) TO app_job;`);
    }
    const grantees = [...code.matchAll(/GRANT [A-Z, ]+ ON [A-Z ]*[a-z_]+(?:\([^)]*\))? TO ([a-z_]+);/g)].map((m) => m[1]);
    expect(grantees.every((g) => g === "app_job")).toBe(true);
    expect(code).not.toMatch(/\bTO\s+(app_rw|PUBLIC)\b/i);
  });
  it("takes the table grants away: app_rw loses INSERT and UPDATE on app_state, app_job loses everything on it", () => {
    expect(code).toContain("REVOKE INSERT, UPDATE ON app_state FROM app_rw;");
    expect(code).toContain("REVOKE ALL ON app_state FROM app_job;");
    expect(code).not.toMatch(/GRANT [A-Z, ]+ ON app_state/);
  });
  it("writes only the keys storage_level and conserve, never deletes, and has no string-built SQL", () => {
    const keys = [...code.matchAll(/INSERT INTO public\.app_state \(key, value, updated_at\) VALUES \('([a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(keys)).toEqual(new Set(["storage_level", "conserve"]));
    expect(code).not.toMatch(/DELETE\s+FROM|TRUNCATE|EXECUTE\s+(format|'|")/i);
    expect(body("apply_storage_level")).toContain("WHERE public.app_state.value IS DISTINCT FROM excluded.value"); // idempotent: no write on a repeat
  });
  it("every one of the three app_state upserts is a no-op on a repeat (the guard is on all of them, not just one)", () => {
    const b = body("apply_storage_level");
    expect(b.match(/INSERT INTO public\.app_state/g)).toHaveLength(3);
    expect(b.match(/WHERE public\.app_state\.value IS DISTINCT FROM excluded\.value;/g)).toHaveLength(3);
  });
  it("apply_storage_guard takes no argument (the caller cannot choose the level through the job path)", () => {
    expect(body("apply_storage_guard")).toMatch(/FUNCTION apply_storage_guard\(\)/);
  });
});

describe("0012 storage guard: storage_level_for is a pure helper", () => {
  const b = body("storage_level_for");
  const header = b.split("AS $$")[0]!;
  const def = b.slice(header.length);
  it("is IMMUTABLE, not SECURITY DEFINER, and pins search_path", () => {
    expect(header).toContain("IMMUTABLE");
    expect(header).not.toContain("SECURITY DEFINER");
    expect(header).toContain("SET search_path = pg_catalog, public");
    expect(header).toContain("LANGUAGE sql");
  });
  it("reads no table or function: only its two arguments and constants", () => {
    expect(def).not.toMatch(/\b(FROM|JOIN|INTO|UPDATE|INSERT|DELETE|PERFORM|EXECUTE)\b/i);
    expect(def).not.toMatch(/\bpublic\./i);
    expect(def).not.toMatch(/\b(now|current_[a-z]+|random|clock_timestamp)\s*\(/i);
    const idents = new Set([...def.matchAll(/\bp_[a-z]+\b/g)].map((m) => m[0]));
    expect(idents).toEqual(new Set(["p_previous", "p_ratio"]));
  });
  it("has EXECUTE revoked from PUBLIC and granted to app_job only", () => {
    expect(code).toContain("REVOKE ALL ON FUNCTION storage_level_for(text, numeric) FROM PUBLIC;");
    expect(code).toContain("GRANT EXECUTE ON FUNCTION storage_level_for(text, numeric) TO app_job;");
    expect([...code.matchAll(/ON FUNCTION storage_level_for\([^)]*\) TO ([a-z_]+)/g)].map((m) => m[1])).toEqual(["app_job"]);
  });
  it("the two functions that DO touch data are SECURITY DEFINER", () => {
    for (const n of ["apply_storage_level", "apply_storage_guard"]) expect(body(n).split("$fn$")[0], n).toContain("SECURITY DEFINER");
  });
});

describe("0012 storage guard: claim_user_slot", () => {
  const b = body("claim_user_slot");
  it("keeps its signature and the existing-user answers BEFORE the pause check, and pauses before counting", () => {
    expect(b).toMatch(/FUNCTION claim_user_slot\(p_user_id text, p_max int\) RETURNS text/);
    const firstExisting = b.indexOf("RETURN 'existing'");
    const pause = b.indexOf("RETURN 'paused'");
    const count = b.indexOf("SELECT count(*) INTO n");
    expect(firstExisting).toBeGreaterThan(-1);
    expect(firstExisting).toBeLessThan(pause);
    expect(b.lastIndexOf("RETURN 'existing'")).toBeLessThan(pause);
    expect(pause).toBeLessThan(count);
    expect(b).toContain("= 'critical'");
  });
  it("is replaced, not dropped, so the app_rw grant from 0007 survives", () => {
    expect(code).toContain("CREATE OR REPLACE FUNCTION claim_user_slot");
    expect(code).not.toMatch(/DROP FUNCTION/i);
  });
});

describe("0012 migration registration", () => {
  it("is in the journal right after 0011 with a snapshot that chains to 0011's", () => {
    const journal = JSON.parse(readFileSync("db/migrations/meta/_journal.json", "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.tag === "0012_storage_guard")).toMatchObject({ idx: 12 });
    const snap = JSON.parse(readFileSync("db/migrations/meta/0012_snapshot.json", "utf8")) as { id: string; prevId: string };
    const prev = JSON.parse(readFileSync("db/migrations/meta/0011_snapshot.json", "utf8")) as { id: string };
    expect(snap.prevId).toBe(prev.id);
    expect(snap.id).not.toBe(prev.id);
  });
});
