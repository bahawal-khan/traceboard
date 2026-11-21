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

/** Job blocks of ci.yml, by name (2-space-indented keys under `jobs:`). */
function job(name: string): string {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:\\n|(?![\\s\\S]))`, "m").exec(workflow);
  if (!m) throw new Error(`no job ${name} in ci.yml`);
  return m[1];
}

describe("CI runner pins", () => {
  it("pins ONLY the sdk-python job to ubuntu-24.04 (Python 3.9 has no build for the 26.04 that ubuntu-latest now means)", () => {
    expect(job("sdk-python")).toMatch(/^ {4}runs-on: ubuntu-24\.04$/m);
    for (const other of ["check", "db-tests"]) expect(job(other), other).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
  });

  it("explains the pin next to it", () => {
    const block = job("sdk-python");
    expect(block).toMatch(/PINNED on purpose[\s\S]*Python 3\.9[\s\S]*runs-on: ubuntu-24\.04/);
  });

  it("keeps the 3.9 matrix entry only while the runner has a 3.9 build (drop the pin together with 3.9)", () => {
    const block = job("sdk-python");
    const has39 = /python: \[[^\]]*"3\.9"/.test(block);
    // the pin is only justified by 3.9: if 3.9 leaves the matrix, move this job back to ubuntu-latest and delete the comment
    expect(has39, "3.9 left the matrix: remove the ubuntu-24.04 pin and the comment that explains it").toBe(true);
  });
});
