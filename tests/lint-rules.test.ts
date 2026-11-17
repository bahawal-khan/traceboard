import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

async function lint(code: string, filePath: string) {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [res] = await eslint.lintText(code, { filePath });
  return res.messages.filter((m) => m.severity === 2).map((m) => m.ruleId);
}

describe("architecture lint rules", () => {
  it("bans importing the db client outside lib/repo", async () => {
    const rules = await lint('import { db } from "@/lib/db/client";\nexport const x = db;\n', "app/bad.ts");
    expect(rules).toContain("no-restricted-imports");
  });

  it("bans importing the neon driver in app code", async () => {
    const rules = await lint('import { neon } from "@neondatabase/serverless";\nexport const x = neon;\n', "lib/other.ts");
    expect(rules).toContain("no-restricted-imports");
  });

  it("allows the db client inside lib/repo", async () => {
    const rules = await lint('import { db } from "@/lib/db/client";\nexport const x = db;\n', "lib/repo/projects.ts");
    expect(rules).not.toContain("no-restricted-imports");
  });

  it("bans dangerouslySetInnerHTML", async () => {
    const rules = await lint('export const A = () => <div dangerouslySetInnerHTML={{ __html: "x" }} />;\n', "app/bad.tsx");
    expect(rules).toContain("no-restricted-syntax");
  });
});
