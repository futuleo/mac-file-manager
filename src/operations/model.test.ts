import { describe, expect, it } from "vitest";
import {
  canReplace,
  formatBytes,
  needsAttention,
  newOperation,
  operationsReducer,
  progressText,
  resultMessage,
} from "./model";

const totals = { succeeded: 0, skipped: 0, failed: [], failedOmitted: 0, affected: [] as string[] };
const base = () => newOperation("t1", "copy", "Copying", 3, "tab-1");

describe("operations model", () => {
  it("ignores events of other tasks and of finished tasks", () => {
    const list = [base()];
    expect(operationsReducer(list, { type: "event", event: { type: "progress", taskId: "x", stage: "running", completed: 1, total: 2, unit: "items" } })).toBe(list);
    const done = operationsReducer(list, { type: "event", event: { type: "finished", taskId: "t1", ...totals, succeeded: 3 } });
    const again = operationsReducer(done, { type: "event", event: { type: "progress", taskId: "t1", stage: "running", completed: 1, total: 2, unit: "items" } });
    expect(again).toBe(done);
    expect(resultMessage(done[0]!)).toBe("Copied 3 of 3 items.");
    expect(needsAttention(done[0]!)).toBe(false);
  });

  it("describes partial success and cancellation without claiming rollback", () => {
    const [op] = operationsReducer([base()], {
      type: "event",
      event: { type: "cancelled", taskId: "t1", ...totals, succeeded: 1, skipped: 1, failedOmitted: 1 },
    });
    const text = resultMessage(op!);
    expect(text).toContain("Cancelled.");
    expect(text).toContain("1 item skipped.");
    expect(text).toContain("1 item could not be copied.");
    expect(text).toContain("not undone");
    expect(needsAttention(op!)).toBe(true);
  });

  it("only reports measured progress", () => {
    const op = base();
    expect(progressText(op)).toBeNull();
    expect(progressText({ ...op, stage: "running", completed: 2, total: 5, unit: "items" })).toBe("2 of 5 items");
    expect(progressText({ ...op, stage: "running", completed: 1536, total: 3072, unit: "bytes" })).toBe("1.5 KB of 3.0 KB");
    expect(formatBytes(12 * 1024 * 1024)).toBe("12 MB");
  });

  it("never allows replacing folders or the same item", () => {
    const c = { conflictId: "c", sourceName: "a", destinationName: "a", sourceKind: "file", destinationKind: "file", sameItem: false } as const;
    expect(canReplace(c)).toBe(true);
    expect(canReplace({ ...c, destinationKind: "directory" })).toBe(false);
    expect(canReplace({ ...c, sameItem: true })).toBe(false);
  });
});
