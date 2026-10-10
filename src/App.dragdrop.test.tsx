// MOCKED IPC: these tests replace Tauri's `invoke`/`listen` and `document.elementFromPoint`. They
// verify how the UI reacts to native drag events and starts drags; they do not prove the real
// AppKit drag session or Finder interoperability (see README "Drag and drop" for that evidence).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { DIRECTORY_EVENT, DRAG_EVENT, TASK_EVENT } from "./backend/contracts";
import type { DragEvent, FileEntry, PlatformInfo } from "./backend/contracts";
import { resetIconQueueForTests } from "./iconQueue";

type Listener = (e: { payload: unknown }) => void;
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as { name: string; cb: (e: { payload: unknown }) => void }[],
  taskGate: null as Promise<void> | null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: Listener) => {
    if (name === "task-event" && mocks.taskGate) await mocks.taskGate;
    const record = { name, cb };
    mocks.listeners.push(record);
    return () => {
      mocks.listeners = mocks.listeners.filter((l) => l !== record);
    };
  }),
}));

const info: PlatformInfo = {
  appVersion: "0.1.0",
  osVersion: "26.6.1",
  arch: "aarch64",
  deploymentTarget: "12.0",
  capabilities: { spotlightQuery: true, quickLookPanel: true, trash: true, systemIcons: true, dragSession: true },
};
const hex = (path: string) => Array.from(new TextEncoder().encode(path), (b) => b.toString(16).padStart(2, "0")).join("");
function entry(path: string, over: Partial<FileEntry> = {}): FileEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { id: hex(path), path, name, kind: "file", size: 10, modifiedMs: 1_700_000_000_000, isSymlink: false, isBrokenLink: false, ...over };
}
const dir = (path: string) => entry(path, { kind: "directory", size: null });
const home = dir("/Users/me");
const docs = dir("/Users/me/Docs");
const pics = dir("/Users/me/Pics");
const a = entry("/Users/me/a.txt");
const b = entry("/Users/me/b.txt");

let reads: { readId: string; id: string }[] = [];
let calls: { command: string; args: Record<string, unknown> }[] = [];
let verdict: { operation: "copy" | "move" | null; reason: string | null } = { operation: "copy", reason: null };
let pointer = 0;
let failCommand: Record<string, unknown> = {};

const emit = (payload: DragEvent) =>
  act(async () => {
    for (const l of [...mocks.listeners]) if (l.name === DRAG_EVENT) l.cb({ payload });
    await Promise.resolve();
  });
const finishRead = (readId: string, entries: FileEntry[]) =>
  act(() => {
    for (const l of [...mocks.listeners]) {
      if (l.name !== DIRECTORY_EVENT) continue;
      l.cb({ payload: { type: "entries", readId, entries, failures: [] } });
      l.cb({ payload: { type: "finished", readId, entries: entries.length, failed: 0 } });
    }
  });
const called = (command: string) => calls.filter((c) => c.command === command);
const rowFor = (name: string) => screen.getByText(name).closest('[role="row"]') as HTMLElement;
const pointAt = (element: Element | null) => {
  document.elementFromPoint = vi.fn(() => element);
};

beforeEach(() => {
  reads = [];
  calls = [];
  verdict = { operation: "copy", reason: null };
  pointer = 0;
  failCommand = {};
  mocks.listeners = [];
  mocks.taskGate = null;
  localStorage.clear();
  resetIconQueueForTests();
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command in failCommand) throw failCommand[command];
    switch (command) {
      case "get_platform_info": return info;
      case "get_home_directory": return home;
      case "list_places": return { places: [{ label: "Home", group: "quick", entry: home }, { label: "Documents", group: "quick", entry: docs }], failures: [] };
      case "start_directory_read":
        reads.push({ readId: args.readId as string, id: args.id as string });
        return undefined;
      case "drag_hover": return { ...verdict, token: args.token };
      case "get_icon": throw new Error("no icon in tests");
      default: return undefined;
    }
  });
});
afterEach(() => {
  cleanup();
  mocks.invoke.mockReset();
});

async function start(entries: FileEntry[] = [a, b, docs, pics]) {
  render(<App />);
  await waitFor(() => expect(reads.length).toBe(1));
  finishRead(reads[0]!.readId, entries);
}
const enter = (dragId = "d1", count = 2) => emit({ type: "enter", dragId, count, internal: false });
const over = (dragId = "d1") => emit({ type: "over", dragId, x: 10, y: 10, pointer: ++pointer, operation: verdict.operation });
const lastToken = () => called("drag_hover").slice(-1)[0]?.args.token as number;
const drop = (dragId = "d1", accepted = true, operation: "copy" | "move" | null = "copy", token: number | null = accepted ? lastToken() : null) =>
  emit({ type: "drop", dragId, accepted, operation, token, count: 2, internal: false });

describe("drag out", () => {
  it("dragging an unselected row starts a native drag of only that row, after a movement threshold", async () => {
    await start();
    const row = rowFor("a.txt");
    fireEvent.mouseDown(row, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.mouseMove(row, { buttons: 1, clientX: 7, clientY: 5 });
    expect(called("start_drag").length).toBe(0);
    fireEvent.mouseMove(row, { buttons: 1, clientX: 30, clientY: 5 });
    await waitFor(() => expect(called("start_drag").length).toBe(1));
    expect(called("start_drag")[0]!.args).toEqual({ ids: [a.id] });
    fireEvent.mouseMove(row, { buttons: 1, clientX: 60, clientY: 5 });
    expect(called("start_drag").length).toBe(1);
  });

  it("dragging a selected row drags the whole selection", async () => {
    await start();
    fireEvent.click(rowFor("a.txt"));
    fireEvent.click(rowFor("b.txt"), { metaKey: true });
    const row = rowFor("b.txt");
    fireEvent.mouseDown(row, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.mouseMove(row, { buttons: 1, clientX: 50, clientY: 5 });
    await waitFor(() => expect(called("start_drag").length).toBe(1));
    expect(called("start_drag")[0]!.args).toEqual({ ids: [a.id, b.id] });
  });

  it("moving without the primary button, or after release, never starts a drag", async () => {
    await start();
    const row = rowFor("a.txt");
    fireEvent.mouseDown(row, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.mouseMove(row, { buttons: 0, clientX: 50, clientY: 5 });
    fireEvent.mouseUp(row);
    fireEvent.mouseMove(row, { buttons: 1, clientX: 90, clientY: 5 });
    expect(called("start_drag").length).toBe(0);
  });

  it("shows a refused drag start instead of ignoring it", async () => {
    failCommand = { start_drag: { category: "cancelled", operation: "drag and drop", context: null, message: "The drag did not start." } };
    await start();
    const row = rowFor("a.txt");
    fireEvent.mouseDown(row, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.mouseMove(row, { buttons: 1, clientX: 50, clientY: 5 });
    expect((await screen.findAllByText(/The drag did not start/)).length).toBeGreaterThan(0);
  });

  it("reloads the source folder after a handed-off move without claiming completion", async () => {
    await start();
    await emit({ type: "sourceEnded", outcome: "handedOffMove", count: 2, folders: [home.id] });
    await waitFor(() => expect(reads.length).toBe(2));
    expect(document.body.textContent).toMatch(/receiving app does the move/);
  });
});

describe("drop in", () => {
  it("a drop on a folder row validates that folder and runs the backend-held transfer once", async () => {
    await start();
    await enter();
    pointAt(rowFor("Docs"));
    await over();
    await waitFor(() => expect(called("drag_hover").length).toBe(1));
    expect(called("drag_hover")[0]!.args).toEqual({ dragId: "d1", pointer: 1, token: 1, destinationId: docs.id });
    await waitFor(() => expect(rowFor("Docs").className).toMatch(/drop-target/));
    await over(); // every pointer update is validated again, with a newer token
    await waitFor(() => expect(called("drag_hover").length).toBe(2));
    expect(called("drag_hover")[1]!.args).toMatchObject({ pointer: 2, token: 2, destinationId: docs.id });
    await drop();
    await waitFor(() => expect(called("drag_drop_transfer").length).toBe(1));
    const args = called("drag_drop_transfer")[0]!.args;
    expect(args).toMatchObject({ dragId: "d1", token: 2, destinationId: docs.id });
    expect(Object.keys(args).sort()).toEqual(["destinationId", "dragId", "taskId", "token"]);
    expect(await screen.findByText(/Copying 2 items to Docs/)).toBeTruthy();
  });

  it("a move drop is reported as a move", async () => {
    verdict = { operation: "move", reason: null };
    await start();
    await enter();
    pointAt(rowFor("Pics"));
    await over();
    await waitFor(() => expect(rowFor("Pics").className).toMatch(/drop-target/));
    await drop("d1", true, "move");
    expect(await screen.findByText(/Moving 2 items to Pics/)).toBeTruthy();
  });

  it("a drop on the content area targets the folder the tab shows", async () => {
    await start();
    await enter();
    pointAt(document.querySelector(".tabpanel"));
    await over();
    await waitFor(() => expect(called("drag_hover")[0]?.args).toMatchObject({ dragId: "d1", destinationId: home.id }));
    await drop();
    expect(await screen.findByText(/Copying 2 items to Me/i)).toBeTruthy();
  });

  it("a sidebar place is a target", async () => {
    await start();
    await enter();
    pointAt(screen.getByRole("button", { name: /Documents/ }));
    await over();
    await waitFor(() => expect(called("drag_hover")[0]?.args).toMatchObject({ dragId: "d1", destinationId: docs.id }));
  });

  it("search results are not a drop target themselves, but folder rows in them still are", async () => {
    await start();
    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: "x" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await enter();
    pointAt(document.querySelector(".tabpanel"));
    await over();
    expect(called("drag_hover").filter((c) => c.args.destinationId !== null).length).toBe(0);
    await drop("d1", false, null);
    expect((await screen.findAllByText(/can't be dropped here/)).length).toBeGreaterThan(0);
  });

  it("a refused target is shown and a refused drop explains why; nothing starts", async () => {
    verdict = { operation: null, reason: "A folder cannot be dropped into itself." };
    await start();
    await enter();
    pointAt(rowFor("Docs"));
    await over();
    await waitFor(() => expect(rowFor("Docs").className).toMatch(/drop-refused/));
    await drop("d1", false, null);
    expect((await screen.findAllByText(/cannot be dropped into itself/)).length).toBeGreaterThan(0);
    expect(called("drag_drop_transfer").length).toBe(0);
  });

  it("a drop with no pointer target is reported, not silent", async () => {
    await start();
    await enter();
    pointAt(document.body);
    await over();
    await drop("d1", false, null);
    expect((await screen.findAllByText(/can't be dropped here/)).length).toBeGreaterThan(0);
    expect(called("drag_drop_transfer").length).toBe(0);
  });

  it("an outdated hover answer is ignored after the drag leaves", async () => {
    let settle!: (v: typeof verdict) => void;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "drag_hover") return new Promise((r) => (settle = (v) => r({ ...v, token: args.token })));
      if (command === "start_directory_read") reads.push({ readId: args.readId as string, id: args.id as string });
      if (command === "get_home_directory") return home;
      if (command === "list_places") return { places: [], failures: [] };
      if (command === "get_platform_info") return info;
      if (command === "get_icon") throw new Error("none");
      return undefined;
    });
    await start();
    await enter();
    pointAt(rowFor("Docs"));
    await over();
    await emit({ type: "leave", dragId: "d1" });
    await act(async () => settle({ operation: "copy", reason: null }));
    expect(rowFor("Docs").className).not.toMatch(/drop-target/);
  });

  it("a drop after the tab navigated discards it instead of targeting the new folder", async () => {
    await start();
    await enter();
    pointAt(rowFor("Docs"));
    await over();
    await waitFor(() => expect(rowFor("Docs").className).toMatch(/drop-target/));
    fireEvent.doubleClick(rowFor("Pics"));
    await waitFor(() => expect(reads.length).toBe(2));
    await drop();
    expect(called("drag_drop_transfer").length).toBe(0);
    expect(called("drag_discard")[0]!.args).toEqual({ dragId: "d1" });
    expect((await screen.findAllByText(/view changed/)).length).toBeGreaterThan(0);
  });

  it("a drop for a drag the window never saw is discarded", async () => {
    await start();
    await drop("d9", true, "copy");
    expect(called("drag_drop_transfer").length).toBe(0);
    expect(called("drag_discard")[0]!.args).toEqual({ dragId: "d9" });
  });

  it("a rejected transfer start shows its error", async () => {
    failCommand = { drag_drop_transfer: { category: "invalidInput", operation: "drag and drop", context: null, message: "That drop was already used." } };
    await start();
    await enter();
    pointAt(rowFor("Docs"));
    await over();
    await waitFor(() => expect(rowFor("Docs").className).toMatch(/drop-target/));
    await drop();
    expect((await screen.findAllByText(/already used/)).length).toBeGreaterThan(0);
  });
});

describe("stale and reordered targets", () => {
  type Pending = { token: number; destinationId: string | null; resolve: (v: typeof verdict) => void };
  let pending: Pending[] = [];
  beforeEach(() => {
    pending = [];
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command !== "drag_hover" || !deferHovers) return base(command, args);
      calls.push({ command, args });
      return new Promise((resolve) =>
        pending.push({ token: args.token as number, destinationId: args.destinationId as string | null, resolve: (v) => resolve({ ...v, token: args.token }) }),
      );
    });
  });
  let deferHovers = true;
  afterEach(() => {
    deferHovers = true;
  });
  const settleHover = (p: Pending, v: typeof verdict = verdict) => act(async () => p.resolve(v));
  const transfers = () => called("drag_drop_transfer").length;

  it("a drop accepted for target A while B is still being validated never targets B or A", async () => {
    await start();
    await enter();
    pointAt(rowFor("Docs"));
    await over();
    await settleHover(pending[0]!);
    await waitFor(() => expect(rowFor("Docs").className).toMatch(/drop-target/));
    const tokenA = lastToken();
    pointAt(rowFor("Pics"));
    await over();
    await waitFor(() => expect(pending.length).toBe(2)); // B is validating and unresolved
    await drop("d1", true, "copy", tokenA); // backend still says A
    expect(transfers()).toBe(0);
    expect(called("drag_discard")[0]!.args).toEqual({ dragId: "d1" });
    expect((await screen.findAllByText(/view changed/)).length).toBeGreaterThan(0);
  });

  it("a drop accepted with B's token before B's verdict arrived is refused too", async () => {
    await start();
    await enter();
    pointAt(rowFor("Pics"));
    await over();
    await waitFor(() => expect(pending.length).toBe(1));
    await drop("d1", true, "copy", pending[0]!.token);
    expect(transfers()).toBe(0);
    expect(called("drag_discard").length).toBe(1);
  });

  it("a late answer for the old target neither highlights it nor replaces the newer target; only one request is in flight", async () => {
    await start();
    await enter();
    pointAt(rowFor("Docs"));
    await over();
    pointAt(rowFor("Pics"));
    await over();
    expect(called("drag_hover").length).toBe(1); // B waits for A's answer
    await settleHover(pending[0]!); // A answers after the pointer already moved on
    expect(rowFor("Docs").className).not.toMatch(/drop-target/);
    await waitFor(() => expect(pending.length).toBe(2));
    expect(pending[1]!.destinationId).toBe(pics.id);
    expect(pending[1]!.token).toBeGreaterThan(pending[0]!.token);
    await settleHover(pending[1]!);
    await waitFor(() => expect(rowFor("Pics").className).toMatch(/drop-target/));
    await drop("d1", true, "copy", pending[0]!.token); // a claim naming A's request is stale
    expect(transfers()).toBe(0);
    expect(called("drag_discard").length).toBe(1);
  });

  it("only the settled target of the accepted request starts a transfer, naming that exact folder", async () => {
    await start();
    await enter();
    pointAt(rowFor("Docs"));
    await over();
    pointAt(rowFor("Pics"));
    await over();
    await settleHover(pending[0]!);
    await waitFor(() => expect(pending.length).toBe(2));
    await settleHover(pending[1]!);
    await waitFor(() => expect(rowFor("Pics").className).toMatch(/drop-target/));
    await drop("d1", true, "copy", pending[1]!.token);
    await waitFor(() => expect(transfers()).toBe(1));
    expect(called("drag_drop_transfer")[0]!.args).toMatchObject({ token: pending[1]!.token, destinationId: pics.id });
    expect(await screen.findByText(/Copying 2 items to Pics/)).toBeTruthy();
  });

  const searchFor = (query: string) => {
    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: query } });
    fireEvent.keyDown(box, { key: "Enter" });
  };

  it("starting a search after hovering the open folder discards the drop", async () => {
    await start();
    await enter();
    pointAt(document.querySelector(".tabpanel"));
    await over();
    await settleHover(pending[0]!);
    searchFor("x");
    await drop();
    expect(transfers()).toBe(0);
    expect(called("drag_discard").length).toBe(1);
  });

  it("starting, replacing and clearing a search each invalidate a target hovered before", async () => {
    for (const change of [
      () => searchFor("x"),
      () => {
        searchFor("x");
        searchFor("y");
      },
      () => {
        searchFor("x");
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
        fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
      },
    ]) {
      calls = [];
      pending = [];
      await start();
      await enter();
      pointAt(rowFor("Docs"));
      await over();
      await settleHover(pending[0]!);
      change();
      await drop();
      expect(transfers()).toBe(0);
      expect(called("drag_discard").length).toBe(1);
      cleanup();
      mocks.listeners = [];
      reads = [];
    }
  });

  it("a view change between the drop and the transfer claim discards the drop instead of running it", async () => {
    deferHovers = false;
    let open!: () => void;
    mocks.taskGate = new Promise<void>((r) => (open = r));
    await start();
    await enter();
    pointAt(rowFor("Docs"));
    await over();
    await waitFor(() => expect(rowFor("Docs").className).toMatch(/drop-target/));
    // The claim runs after the operations service is ready; the view changes in between.
    await drop();
    searchFor("x");
    await act(async () => {
      mocks.taskGate = null;
      open();
    });
    await waitFor(() => expect(called("drag_discard").length).toBe(1));
    expect(transfers()).toBe(0);
    expect((await screen.findAllByText(/view changed/)).length).toBeGreaterThan(0);
  });

  it("navigating during validation leaves nothing claimable for the new folder", async () => {
    await start();
    await enter();
    pointAt(rowFor("Docs"));
    await over();
    fireEvent.doubleClick(rowFor("Pics"));
    await waitFor(() => expect(reads.length).toBe(2));
    await settleHover(pending[0]!);
    await drop("d1", true, "copy", pending[0]!.token);
    expect(transfers()).toBe(0);
    expect(called("drag_discard").length).toBe(1);
  });
});

describe("task events stay separate", () => {
  it("only listens to its own tasks", async () => {
    await start();
    expect(mocks.listeners.some((l) => l.name === TASK_EVENT)).toBe(true);
  });
});
