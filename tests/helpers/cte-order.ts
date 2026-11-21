/**
 * Static check of a `WITH a as (...), b as (...) select ...` statement: a CTE may only read CTEs defined EARLIER in the list
 * (Postgres answers `relation "x" does not exist` for a later one, and for itself unless WITH RECURSIVE), and every
 * `from`/`join` target must be a known CTE or a known base table. Data-modifying CTEs are read through RETURNING, which the
 * name reference covers. String literals and `--` comments are blanked first so their text cannot be mistaken for SQL.
 */
export interface CteProblem {
  cte: string; // the CTE (or "<final select>") that holds the bad reference
  ref: string;
  kind: "defined_later" | "self_reference" | "unknown_relation" | "duplicate_name";
}

export function checkCteOrder(sqlText: string, knownTables: readonly string[]): { names: string[]; problems: CteProblem[] } {
  const text = sqlText.replace(/--[^\n]*/g, " ").replace(/'(?:[^']|'')*'/g, "''");
  const m = /^\s*with\s+/i.exec(text);
  if (!m) throw new Error("statement does not start with WITH");
  let i = m[0].length;
  const ctes: { name: string; body: string }[] = [];
  for (;;) {
    const head = /^\s*([a-z_][a-z0-9_]*)\s+as\s*\(/i.exec(text.slice(i));
    if (!head) break;
    const start = i + head[0].length;
    let depth = 1;
    let j = start;
    while (j < text.length && depth > 0) {
      if (text[j] === "(") depth += 1;
      else if (text[j] === ")") depth -= 1;
      j += 1;
    }
    if (depth !== 0) throw new Error(`unbalanced parentheses in CTE ${head[1]}`);
    ctes.push({ name: head[1]!.toLowerCase(), body: text.slice(start, j - 1) });
    i = j;
    const comma = /^\s*,/.exec(text.slice(i));
    if (!comma) break;
    i += comma[0].length;
  }
  if (ctes.length === 0) throw new Error("no CTE found");
  const final = text.slice(i);
  const names = ctes.map((c) => c.name);
  const tables = new Set(knownTables.map((t) => t.toLowerCase()));
  const problems: CteProblem[] = [];
  const dupes = names.filter((n, k) => names.indexOf(n) !== k);
  for (const d of dupes) problems.push({ cte: d, ref: d, kind: "duplicate_name" });

  const refs = (body: string) => [...body.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)\b(?!\s*\()/gi)].map((r) => r[1]!.toLowerCase());
  const scan = (label: string, body: string, index: number) => {
    for (const ref of refs(body)) {
      const at = names.indexOf(ref);
      if (at === index && index < names.length) problems.push({ cte: label, ref, kind: "self_reference" });
      else if (at > index) problems.push({ cte: label, ref, kind: "defined_later" });
      else if (at === -1 && !tables.has(ref)) problems.push({ cte: label, ref, kind: "unknown_relation" });
    }
  };
  ctes.forEach((c, k) => scan(c.name, c.body, k));
  scan("<final select>", final, names.length);
  return { names, problems };
}
