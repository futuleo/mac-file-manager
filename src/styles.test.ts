import { describe, expect, it } from "vitest";
import main from "./main.tsx?raw";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

const css: string = readFileSync("src/styles.css", "utf8");

// Source-level regression: the stylesheet must be imported by the real entry point.
// The build step is checked separately (npm run build output must reference a CSS asset).
describe("stylesheet wiring", () => {
  it("is imported by the application entry point", () => {
    expect(main).toMatch(/import\s+["']\.\/styles\.css["']/);
  });
});

// Real WebKit layout bug found natively: rows use align-items:center, so an empty filler cell had zero
// height and a press in a row's blank area hit the row itself. jsdom has no layout, so pin the rule.
describe("row filler hit area", () => {
  it("stretches the filler cell to the full row height", () => {
    expect(css).toMatch(/\.cell\.filler\s*\{[^}]*align-self:\s*stretch/);
  });
});
