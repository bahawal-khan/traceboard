import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("app/globals.css", "utf8");

/** Text of one block, from its selector to the line that closes it. */
function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} block`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("\n}", start));
}

function series(blockText: string): string[] {
  return [1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
    const m = blockText.match(new RegExp(`--chart-${n}:\\s*(#[0-9a-fA-F]{6});`));
    expect(m, `--chart-${n}`).not.toBeNull();
    return m![1].toLowerCase();
  });
}

describe("chart colour tokens", () => {
  // The order is the colour-blind-safety mechanism (adjacent-pair separation). These exact values were run through
  // the dataviz validator on the real card surfaces (#ffffff light, #171717 dark): all gates pass; light yellow, aqua
  // and magenta are below 3:1 contrast, so charts must keep a legend or table view (ChartCard offers one).
  it("light series are the validated palette in the validated order", () => {
    expect(series(block(":root"))).toEqual([
      "#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948",
    ]);
  });
  it("dark series are the same eight hues stepped for the dark surface", () => {
    expect(series(block(".dark"))).toEqual([
      "#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#0ca30c", "#9085e9", "#e66767",
    ]);
  });
  it("status colours exist and are exposed to Tailwind", () => {
    for (const s of ["good", "warning", "serious", "critical"]) {
      expect(block(":root")).toContain(`--status-${s}:`);
      expect(css).toContain(`--color-status-${s}: var(--status-${s});`);
    }
  });
});

describe("shadcn chart component", () => {
  const src = readFileSync("components/ui/chart.tsx", "utf8");
  it("does not inject markup (dangerouslySetInnerHTML is banned in this repo)", () => {
    expect(src).not.toContain("dangerouslySetInnerHTML");
    expect(src).not.toContain("<style");
  });
  it("sets series colours as CSS variables through the style prop", () => {
    expect(src).toContain("chartColorVars(config)");
  });
});
