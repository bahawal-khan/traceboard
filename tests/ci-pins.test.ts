import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The CI database images must be pinned: postgres to a minor version, the proxy to a digest. */
const compose = readFileSync("ci/docker-compose.db.yml", "utf8");
const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

function imageOf(service: string): string {
  const block = compose.split(/^ {2}[a-z-]+:\s*$/m);
  const names = [...compose.matchAll(/^ {2}([a-z-]+):\s*$/gm)].map((m) => m[1]);
  const body = block[names.indexOf(service) + 1] ?? "";
  const m = /^ {4}image:\s*(\S+)\s*$/m.exec(body);
  if (!m) throw new Error(`no image for ${service}`);
  return m[1];
}

describe("CI database image pins", () => {
  it("pins postgres to a specific minor version", () => {
    expect(imageOf("postgres")).toMatch(/^postgres:\d+\.\d+$/);
  });

  const pending = compose.includes("PIN_PENDING");
  const stepPresent = workflow.includes("Print resolved image digests (temporary)");

  it("pins the proxy by digest once the pin is done, and then the temporary digest step must be gone", () => {
    const image = imageOf("neon-proxy");
    if (pending) {
      expect(image, "pending state is only for the moving main tag").toBe("ghcr.io/timowilhelm/local-neon-http-proxy:main");
      expect(stepPresent, "pending pin needs the temporary digest step to read the digest from").toBe(true);
    } else {
      expect(image).toMatch(/^ghcr\.io\/timowilhelm\/local-neon-http-proxy@sha256:[0-9a-f]{64}$/);
      expect(stepPresent, "remove the temporary 'Print resolved image digests' step from ci.yml").toBe(false);
    }
  });

  it("keeps both published ports on localhost", () => {
    for (const m of compose.matchAll(/^\s+- "([^"]+)"\s*$/gm)) expect(m[1]).toMatch(/^127\.0\.0\.1:/);
  });
});
