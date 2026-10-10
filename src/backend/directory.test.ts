// MOCKED IPC: `invoke` and `listen` are in-memory fakes (see App.test.tsx).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readDirectory, toAppError } from "./directory";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as ((e: { payload: unknown }) => void)[],
  listenDelay: null as Promise<void> | null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_n: string, cb: (e: { payload: unknown }) => void) => {
    await mocks.listenDelay;
    mocks.listeners.push(cb);
    return () => {
      mocks.listeners = mocks.listeners.filter((l) => l !== cb);
    };
  }),
}));

const handlers = () => ({ onEntries: vi.fn(), onFinished: vi.fn(), onFailed: vi.fn() });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.listeners = [];
  mocks.listenDelay = null;
});

describe("readDirectory (mocked IPC)", () => {
  it("subscribes before starting and unsubscribes after the terminal event", async () => {
    const h = handlers();
    readDirectory("abc", h);
    await flush();
    expect(mocks.listeners.length).toBe(1);
    const { readId } = mocks.invoke.mock.calls[0]![1];
    mocks.listeners[0]!({ payload: { type: "entries", readId: "other", entries: [], failures: [] } });
    expect(h.onEntries).not.toHaveBeenCalled();
    mocks.listeners[0]!({ payload: { type: "finished", readId, entries: 0, failed: 0 } });
    expect(h.onFinished).toHaveBeenCalledWith({ entries: 0, failed: 0 });
    expect(mocks.listeners.length).toBe(0);
  });

  it("never starts a read that was cancelled before subscription completed", async () => {
    let release!: () => void;
    mocks.listenDelay = new Promise((r) => (release = r));
    const h = handlers();
    readDirectory("abc", h).cancel();
    release();
    await flush();
    expect(mocks.invoke).not.toHaveBeenCalledWith("start_directory_read", expect.anything());
    expect(mocks.listeners.length).toBe(0);
  });

  it("stops delivering after cancel and tells the backend", async () => {
    const h = handlers();
    const read = readDirectory("abc", h);
    await flush();
    const { readId } = mocks.invoke.mock.calls[0]![1];
    const listener = mocks.listeners[0]!;
    read.cancel();
    read.cancel();
    listener({ payload: { type: "entries", readId, entries: [], failures: [] } });
    await flush();
    expect(h.onEntries).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.filter((c) => c[0] === "cancel_directory_read").length).toBe(1);
  });

  it("reports a rejected start as a typed failure", async () => {
    mocks.invoke.mockRejectedValue({ category: "invalidInput", operation: "read the folder", context: null, message: "bad id" });
    const h = handlers();
    readDirectory("zz", h);
    await flush();
    expect(h.onFailed).toHaveBeenCalledWith(expect.objectContaining({ category: "invalidInput", message: "bad id" }));
  });
});

describe("toAppError", () => {
  it("passes typed errors through and wraps everything else", () => {
    const typed = { category: "notFound", operation: "x", context: null, message: "m" };
    expect(toAppError(typed)).toBe(typed);
    expect(toAppError("boom").message).toBe("boom");
    expect(toAppError(new Error("e")).category).toBe("io");
    expect(toAppError(undefined).message).toBe("Unknown error");
  });
});
