import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_CONCURRENT_ICONS, requestIcon, resetIconQueueForTests } from "./iconQueue";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

afterEach(() => {
  resetIconQueueForTests();
  mocks.invoke.mockReset();
});

describe("icon queue (mocked IPC)", () => {
  it("limits concurrency, dedupes and drops cancelled pending lookups", async () => {
    const resolvers: ((url: string) => void)[] = [];
    mocks.invoke.mockImplementation(() => new Promise<string>((r) => resolvers.push(r)));
    const loaded: string[] = [];
    for (let i = 0; i < 10; i += 1) requestIcon(`id${i}`, 32, (u) => loaded.push(u));
    requestIcon("id0", 32, () => {}); // shares the first lookup
    expect(mocks.invoke).toHaveBeenCalledTimes(MAX_CONCURRENT_ICONS);

    const cancel = requestIcon("id9", 32, () => loaded.push("late"));
    cancel();
    for (let i = 0; i < MAX_CONCURRENT_ICONS; i += 1) resolvers[i]!(`url${i}`);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(8));
    expect(loaded.slice(0, 4)).toEqual(["url0", "url1", "url2", "url3"]);
  });

  it("serves repeats from cache and tolerates failures", async () => {
    mocks.invoke.mockResolvedValueOnce("data:one").mockRejectedValueOnce(new Error("no"));
    const got: string[] = [];
    requestIcon("a", 16, (u) => got.push(u));
    requestIcon("b", 16, (u) => got.push(u));
    await vi.waitFor(() => expect(got).toEqual(["data:one"]));
    requestIcon("a", 16, (u) => got.push(u));
    expect(got).toEqual(["data:one", "data:one"]);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
});
