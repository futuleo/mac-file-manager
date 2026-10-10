// MOCKED IPC: `invoke` and `listen` are in-memory fakes. These tests verify the client's
// subscribe-first, fail-closed and stale-event behavior, not real Spotlight.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchFolder } from "./search";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as ((e: { payload: unknown }) => void)[],
  listenDelay: null as Promise<void> | null,
  listenError: false,
  order: [] as string[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: unknown) => {
    mocks.order.push(command);
    return mocks.invoke(command, args);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_n: string, cb: (e: { payload: unknown }) => void) => {
    await mocks.listenDelay;
    if (mocks.listenError) throw new Error("listener refused");
    mocks.order.push("listen");
    mocks.listeners.push(cb);
    return () => {
      mocks.listeners = mocks.listeners.filter((l) => l !== cb);
    };
  }),
}));

const handlers = () => ({ onResults: vi.fn(), onRemoved: vi.fn(), onState: vi.fn(), onLimited: vi.fn(), onFailed: vi.fn() });
const flush = () => new Promise((r) => setTimeout(r, 0));
const idOf = () => mocks.invoke.mock.calls.find((c) => c[0] === "start_search")![1].searchId as string;
const send = (payload: unknown) => mocks.listeners[0]!({ payload });

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.listeners = [];
  mocks.listenDelay = null;
  mocks.listenError = false;
  mocks.order = [];
});

describe("searchFolder (mocked IPC)", () => {
  it("subscribes before starting and passes the query as typed data", async () => {
    const h = handlers();
    searchFolder("scope", "content", 'a" OR 1=1', h);
    await flush();
    expect(mocks.order.slice(0, 2)).toEqual(["listen", "start_search"]);
    expect(mocks.invoke).toHaveBeenCalledWith("start_search", expect.objectContaining({ scopeId: "scope", mode: "content", query: 'a" OR 1=1' }));
  });

  it("delivers only its own events, incrementally", async () => {
    const h = handlers();
    searchFolder("scope", "filename", "x", h);
    await flush();
    const searchId = idOf();
    send({ type: "results", searchId: "someone-else", entries: [], skipped: 0 });
    expect(h.onResults).not.toHaveBeenCalled();
    send({ type: "results", searchId, entries: [], skipped: 2 });
    send({ type: "state", searchId, state: "live" });
    send({ type: "removed", searchId, ids: ["aa"] });
    send({ type: "limited", searchId, limit: 10 });
    expect(h.onResults).toHaveBeenCalledWith([], 2);
    expect(h.onState).toHaveBeenCalledWith("live");
    expect(h.onRemoved).toHaveBeenCalledWith(["aa"]);
    expect(h.onLimited).toHaveBeenCalledWith(10);
  });

  it("stops delivering after cancel and cancels natively once", async () => {
    const h = handlers();
    const s = searchFolder("scope", "filename", "x", h);
    await flush();
    const searchId = idOf();
    const listener = mocks.listeners[0]!;
    s.cancel();
    s.cancel();
    listener({ payload: { type: "results", searchId, entries: [], skipped: 0 } });
    await flush();
    expect(h.onResults).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.filter((c) => c[0] === "cancel_search").length).toBe(1);
    expect(mocks.listeners.length).toBe(0);
  });

  it("never starts a search cancelled before the subscription completed", async () => {
    let release!: () => void;
    mocks.listenDelay = new Promise((r) => (release = r));
    searchFolder("scope", "filename", "x", handlers()).cancel();
    release();
    await flush();
    expect(mocks.invoke).not.toHaveBeenCalledWith("start_search", expect.anything());
    expect(mocks.listeners.length).toBe(0);
  });

  it("fails closed when the listener cannot be registered", async () => {
    mocks.listenError = true;
    const h = handlers();
    searchFolder("scope", "filename", "x", h);
    await flush();
    expect(h.onFailed).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).not.toHaveBeenCalledWith("start_search", expect.anything());
  });

  it("reports a rejected start as a typed failure and releases the listener", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "start_search") throw { category: "notFound", operation: "search", context: null, message: "gone" };
    });
    const h = handlers();
    searchFolder("scope", "filename", "x", h);
    await flush();
    expect(h.onFailed).toHaveBeenCalledWith(expect.objectContaining({ category: "notFound" }));
    expect(mocks.listeners.length).toBe(0);
  });

  it("a native failure is terminal and an unsolicited cancelled state ends the search", async () => {
    const h = handlers();
    searchFolder("scope", "filename", "x", h);
    await flush();
    const searchId = idOf();
    const listener = mocks.listeners[0]!;
    send({ type: "failed", searchId, error: { category: "io", operation: "search", context: null, message: "boom" } });
    listener({ payload: { type: "results", searchId, entries: [], skipped: 0 } });
    expect(h.onFailed).toHaveBeenCalledTimes(1);
    expect(h.onResults).not.toHaveBeenCalled();
  });
});
