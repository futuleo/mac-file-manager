import { describe, expect, it } from "vitest";
import main from "./main.tsx?raw";

// Source-level regression: the stylesheet must be imported by the real entry point.
// The build step is checked separately (npm run build output must reference a CSS asset).
describe("stylesheet wiring", () => {
  it("is imported by the application entry point", () => {
    expect(main).toMatch(/import\s+["']\.\/styles\.css["']/);
  });
});
