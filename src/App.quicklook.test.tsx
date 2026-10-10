// MOCKED IPC: these tests replace Tauri's `invoke` and `listen` with an in-memory
// fake backend. They verify how the UI drives the Quick Look commands (Space, menu,
// ribbon, selection/tab changes, errors); they do not prove native panel behavior,
// which is covered by src-tauri/examples/quick_look_acceptance.rs.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { DIRECTORY_EVENT, MENU_EVENT, TASK_EVENT } from "./backend/contracts";
import type { FileEntry, PlatformInfo } from "./backend/contracts";
import { resetIconQueueForTests } from "./iconQueue";

type Listener = (e: { payload: unknown }) => void;
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  rejectTaskListener: false,
  listeners: [] as { name: string; cb: (e: { payload: unknown }) => void }[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: Listener) => {
    if (mocks.rejectTaskListener && name === TASK_EVENT) throw new Error("listen refused");
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
  capabilities: { spotlightQuery: true, quickLookPanel: true, trash: true, systemIcons: true, dragSession: false },
};
const hex = (path: string) => Array.from(new TextEncoder().encode(path), (b) => b.toString(16).padStart(2, "0")).join("");
function entry(path: string, over: Partial<FileEntry> = {}): FileEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { id: hex(path), path, name, kind: "file", size: 10, modifiedMs: 1_700_000_000_000, isSymlink: false, isBrokenLink: false, ...over };
}
const dir = (path: string) => entry(path, { kind: "directory", size: null });
const home = dir("/Users/me");
const docs = dir("/Users/me/Docs");
const a = entry("/Users/me/a.txt");
const b = entry("/Users/me/b.txt");

let reads: { readId: string; id: string }[] = [];
let calls: { command: string; args: Record<string, unknown> }[] = [];
let failCommand: Record<string, unknown> = {};
let toggleOpens = true;
// Commands whose replies the test settles by hand, in the order it chooses.
const held = new Set<string>();
let replies: { command: string; seq: number; settle: (open: boolean) => void }[] = [];
const hold = (command: string) =>
  new Promise<boolean>((settle) => {
    const seq = calls[calls.length - 1]!.args.seq as number;
    replies.push({ command, seq, settle });
  });
const reply = (command: string, nth: number, open: boolean) =>
  act(async () => {
    replies.filter((r) => r.command === command)[nth]!.settle(open);
    await Promise.resolve();
  });
let syncOpen = true;

const menu = (id: string) =>
  act(() => {
    for (const l of [...mocks.listeners]) if (l.name === MENU_EVENT) l.cb({ payload: id });
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

beforeEach(() => {
  reads = [];
  calls = [];
  failCommand = {};
  toggleOpens = true;
  syncOpen = true;
  held.clear();
  replies = [];
  mocks.listeners = [];
  mocks.rejectTaskListener = false;
  localStorage.clear();
  resetIconQueueForTests();
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command in failCommand) throw failCommand[command];
    switch (command) {
      case "get_platform_info": return info;
      case "get_home_directory": return home;
      case "list_places": return { places: [{ label: "Home", group: "quick", entry: home }, { label: "Documents", group: "quick", entry: docs }], failures: [] };
      case "resolve_directory": return home;
      case "start_directory_read":
        reads.push({ readId: args.readId as string, id: args.id as string });
        return undefined;
      case "quick_look_toggle": return held.has("quick_look_toggle") ? hold("quick_look_toggle") : toggleOpens;
      case "quick_look_sync": return held.has("quick_look_sync") ? hold("quick_look_sync") : syncOpen;
      case "create_folder": return dir("/Users/me/New folder");
      case "rename_item": return dir(`/Users/me/${args.newName as string}`);
      case "get_icon": throw new Error("no icon in tests");
      default: return undefined;
    }
  });
});
afterEach(() => {
  cleanup();
  mocks.invoke.mockReset();
});

async function start(entries: FileEntry[] = [a, b]) {
  render(<App />);
  await waitFor(() => expect(reads.length).toBe(1));
  finishRead(reads[0]!.readId, entries);
}
const select = (...names: string[]) => {
  fireEvent.click(rowFor(names[0]!));
  for (const n of names.slice(1)) fireEvent.click(rowFor(n), { metaKey: true });
};
const space = () => fireEvent.keyDown(screen.getByRole("grid"), { key: " " });

describe("Quick Look UI (mocked IPC)", () => {
  it("Space previews the selected ids and does nothing without a selection", async () => {
    await start();
    screen.getByRole("grid").focus();
    space();
    expect(called("quick_look_toggle").length).toBe(0);
    select("a.txt", "b.txt");
    space();
    await waitFor(() => expect(called("quick_look_toggle").length).toBe(1));
    expect(called("quick_look_toggle")[0]!.args).toMatchObject({ ids: [a.id, b.id] });
  });

  it("Space typed into the address field is not a preview request", async () => {
    await start();
    select("a.txt");
    fireEvent.click(screen.getByRole("button", { name: "Edit address" }));
    const input = screen.getByLabelText("Address");
    fireEvent.keyDown(input, { key: " " });
    menu("quick-look");
    expect(called("quick_look_toggle").length).toBe(0);
  });

  it("the native menu item and the ribbon button toggle once each", async () => {
    await start();
    expect((screen.getByRole("button", { name: "Preview" }) as HTMLButtonElement).disabled).toBe(true);
    select("a.txt");
    menu("quick-look");
    await waitFor(() => expect(called("quick_look_toggle").length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(called("quick_look_toggle").length).toBe(2));
  });

  it("an open preview follows selection changes and closes when nothing is selected", async () => {
    await start();
    select("a.txt");
    menu("quick-look");
    await waitFor(() => expect(called("quick_look_toggle").length).toBe(1));
    await act(async () => { await Promise.resolve(); });
    select("b.txt");
    await waitFor(() => expect(called("quick_look_sync").slice(-1)[0]!.args).toMatchObject({ ids: [b.id] }));
    syncOpen = false;
    fireEvent.click(screen.getByRole("button", { name: "Select none" }));
    await waitFor(() => expect(called("quick_look_sync").slice(-1)[0]!.args).toMatchObject({ ids: [] }));
    const before = called("quick_look_sync").length;
    select("a.txt");
    await Promise.resolve();
    expect(called("quick_look_sync").length).toBe(before);
  });

  it("switching tabs re-targets the open preview at the new tab's selection", async () => {
    await start();
    select("a.txt");
    menu("quick-look");
    await waitFor(() => expect(called("quick_look_toggle").length).toBe(1));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await waitFor(() => expect(called("quick_look_sync").slice(-1)[0]!.args).toMatchObject({ ids: [] }));
  });

  it("a marquee drag re-targets an open preview and keeps tabs independent", async () => {
    await start();
    select("a.txt");
    menu("quick-look");
    await waitFor(() => expect(called("quick_look_toggle").length).toBe(1));
    await act(async () => { await Promise.resolve(); });
    const grid = screen.getByRole("grid");
    grid.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400, x: 0, y: 0, toJSON() {} });
    Object.defineProperty(grid, "clientWidth", { configurable: true, value: 385 });
    Object.defineProperty(grid, "clientHeight", { configurable: true, value: 400 });
    fireEvent.mouseDown(grid, { button: 0, buttons: 1, clientX: 300, clientY: 200 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 300, clientY: 26 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(called("quick_look_sync").slice(-1)[0]!.args).toMatchObject({ ids: [a.id, b.id] }));
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await waitFor(() => expect(called("quick_look_sync").slice(-1)[0]!.args).toMatchObject({ ids: [] }));
  });

  it("shows a typed preview error instead of pretending it opened", async () => {
    await start();
    select("a.txt");
    failCommand.quick_look_toggle = { category: "notFound", message: "Could not preview \"a.txt\": it no longer exists.", operation: "preview", context: "a.txt" };
    menu("quick-look");
    expect(await screen.findByText(/no longer exists/)).toBeTruthy();
    const syncs = called("quick_look_sync").length;
    await Promise.resolve();
    expect(called("quick_look_sync").length).toBe(syncs);
  });

  it("a failed sync closes the preview state and reports the error", async () => {
    await start();
    select("a.txt");
    menu("quick-look");
    await waitFor(() => expect(called("quick_look_toggle").length).toBe(1));
    await act(async () => { await Promise.resolve(); });
    failCommand.quick_look_sync = { category: "permissionDenied", message: "Not allowed to preview b.txt.", operation: "preview", context: "b.txt" };
    select("b.txt");
    expect(await screen.findByText(/Not allowed to preview/)).toBeTruthy();
  });

  it("numbers every toggle/sync call so the backend can order them", async () => {
    await start();
    select("a.txt");
    menu("quick-look");
    await waitFor(() => expect(called("quick_look_toggle").length).toBe(1));
    await act(async () => { await Promise.resolve(); });
    select("b.txt");
    await waitFor(() => expect(called("quick_look_sync").length).toBe(1));
    select("a.txt");
    await waitFor(() => expect(called("quick_look_sync").length).toBe(2));
    const seqs = [...called("quick_look_toggle"), ...called("quick_look_sync")].map((c) => c.args.seq as number);
    expect(seqs.every((n, i) => i === 0 || n !== seqs[i - 1])).toBe(true);
    expect(new Set(seqs).size).toBe(seqs.length);
    const sync = called("quick_look_sync").map((c) => c.args.seq as number);
    expect(sync[1]).toBeGreaterThan(sync[0]!);
    expect(sync[0]).toBeGreaterThan(called("quick_look_toggle")[0]!.args.seq as number);
  });

  it("pending open, B sync answers true, then C still gets a sync and the UI adopts true", async () => {
    await start([a, b, entry("/Users/me/c.txt")]);
    held.add("quick_look_toggle");
    held.add("quick_look_sync");
    select("a.txt");
    menu("quick-look");
    await waitFor(() => expect(called("quick_look_toggle").length).toBe(1));
    select("b.txt");
    await waitFor(() => expect(called("quick_look_sync").length).toBe(1));
    expect(called("quick_look_sync")[0]!.args).toMatchObject({ ids: [b.id] });
    // The native panel already opened for the first toggle, so B's answer is true;
    // the toggle's own (now superseded) reply arrives last and is ignored.
    await reply("quick_look_sync", 0, true);
    await reply("quick_look_toggle", 0, true);
    select("c.txt");
    await waitFor(() => expect(called("quick_look_sync").length).toBe(2));
    expect(called("quick_look_sync")[1]!.args).toMatchObject({ ids: [hex("/Users/me/c.txt")] });
    expect(called("quick_look_sync")[1]!.args.seq as number).toBeGreaterThan(called("quick_look_sync")[0]!.args.seq as number);
  });

  it("C changing before B's sync settles still sends a sync, and only the newest reply counts", async () => {
    await start([a, b, entry("/Users/me/c.txt")]);
    held.add("quick_look_toggle");
    held.add("quick_look_sync");
    select("a.txt");
    menu("quick-look");
    await waitFor(() => expect(called("quick_look_toggle").length).toBe(1));
    select("b.txt");
    await waitFor(() => expect(called("quick_look_sync").length).toBe(1));
    select("c.txt");
    await waitFor(() => expect(called("quick_look_sync").length).toBe(2));
    await reply("quick_look_sync", 1, true);
    await reply("quick_look_sync", 0, false);
    await reply("quick_look_toggle", 0, true);
    // The UI now owns an open preview (newest answer true): the next change syncs again.
    select("a.txt");
    await waitFor(() => expect(called("quick_look_sync").length).toBeGreaterThan(2));
    expect(called("quick_look_sync").slice(-1)[0]!.args).toMatchObject({ ids: [a.id] });
  });

  it("a newest sync answering false clears the open state", async () => {
    await start();
    held.add("quick_look_toggle");
    held.add("quick_look_sync");
    select("a.txt");
    menu("quick-look");
    await waitFor(() => expect(called("quick_look_toggle").length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Select none" }));
    await waitFor(() => expect(called("quick_look_sync").length).toBe(1));
    await reply("quick_look_sync", 0, false);
    const syncs = called("quick_look_sync").length;
    select("b.txt");
    await Promise.resolve();
    expect(called("quick_look_sync").length).toBe(syncs);
  });

  it("opening a new tab while the open is pending sends an empty sync", async () => {
    await start();
    held.add("quick_look_toggle");
    select("a.txt");
    menu("quick-look");
    await waitFor(() => expect(called("quick_look_toggle").length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await waitFor(() => expect(called("quick_look_sync").length).toBe(1));
    expect(called("quick_look_sync")[0]!.args).toMatchObject({ ids: [] });
  });
});
