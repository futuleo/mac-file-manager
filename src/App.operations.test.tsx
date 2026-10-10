// MOCKED IPC: these tests replace Tauri's `invoke` and `listen` with an in-memory
// fake backend. They verify how the UI starts file operations and reacts to task
// events; they do not prove real filesystem, Trash or native menu behavior.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { DIRECTORY_EVENT, MENU_EVENT, TASK_EVENT } from "./backend/contracts";
import type { FileEntry, PlatformInfo, TaskEvent } from "./backend/contracts";
import { resetIconQueueForTests } from "./iconQueue";

type Listener = (e: { payload: unknown }) => void;
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as { name: string; cb: (e: { payload: unknown }) => void }[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: Listener) => {
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

const emitTask = (event: TaskEvent) =>
  act(() => {
    for (const l of [...mocks.listeners]) if (l.name === TASK_EVENT) l.cb({ payload: event });
  });
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
const taskId = (command: string) => called(command)[0]!.args.taskId as string;
const rowFor = (name: string) => screen.getByText(name).closest('[role="row"]') as HTMLElement;
const emptyTotals = { succeeded: 0, skipped: 0, failed: [], failedOmitted: 0, affected: [] as string[] };

beforeEach(() => {
  reads = [];
  calls = [];
  failCommand = {};
  mocks.listeners = [];
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

describe("file operations UI (mocked IPC)", () => {
  it("copies then pastes into the current folder through start_transfer", async () => {
    await start();
    select("a.txt", "b.txt");
    menu("copy");
    menu("paste");
    await waitFor(() => expect(called("start_transfer").length).toBe(1));
    expect(called("start_transfer")[0]!.args).toMatchObject({
      moveItems: false,
      sourceIds: [a.id, b.id],
      destinationId: home.id,
    });
  });

  it("cut then paste moves, and an emptied clipboard cannot paste twice", async () => {
    await start();
    select("a.txt");
    menu("cut");
    menu("paste");
    await waitFor(() => expect(called("start_transfer").length).toBe(1));
    expect(called("start_transfer")[0]!.args).toMatchObject({ moveItems: true, sourceIds: [a.id] });
    menu("paste");
    expect(called("start_transfer").length).toBe(1);
  });

  it("moves the selection to the Trash only, never offering permanent deletion", async () => {
    await start();
    select("a.txt");
    fireEvent.contextMenu(rowFor("a.txt"));
    const menuEl = await screen.findByRole("menu");
    expect(within(menuEl).queryByText(/permanent/i)).toBeNull();
    fireEvent.click(within(menuEl).getByText("Move to the Trash"));
    await waitFor(() => expect(called("trash_items").length).toBe(1));
    expect(called("trash_items")[0]!.args).toMatchObject({ ids: [a.id] });
    expect(called("start_transfer").length).toBe(0);
  });

  it("reloads only tabs showing an affected folder when a task finishes", async () => {
    await start();
    menu("new-tab");
    await waitFor(() => expect(reads.length).toBe(2));
    finishRead(reads[1]!.readId, [a]);
    fireEvent.click(await screen.findByRole("button", { name: /Documents/ }));
    await waitFor(() => expect(reads.length).toBe(3));
    finishRead(reads[2]!.readId, [b]);
    select("b.txt");
    menu("trash");
    await waitFor(() => expect(called("trash_items").length).toBe(1));
    const id = taskId("trash_items");
    const before = reads.length;
    emitTask({ type: "finished", taskId: id, ...emptyTotals, succeeded: 1, affected: [docs.id] });
    await waitFor(() => expect(reads.length).toBe(before + 1));
    expect(reads[reads.length - 1]!.id).toBe(docs.id);
    // A later event for the same finished task, or an unknown one, changes nothing.
    emitTask({ type: "finished", taskId: id, ...emptyTotals, affected: [home.id] });
    emitTask({ type: "finished", taskId: "someone-else", ...emptyTotals, affected: [home.id] });
    expect(reads.length).toBe(before + 1);
  });

  it("shows measurable progress and never invents a percentage while counting", async () => {
    await start();
    select("a.txt");
    menu("copy");
    menu("paste");
    await waitFor(() => expect(called("start_transfer").length).toBe(1));
    const id = taskId("start_transfer");
    emitTask({ type: "progress", taskId: id, stage: "scanning", completed: null, total: null, unit: "items" });
    const region = screen.getByRole("region", { name: "File operations" });
    expect(within(region).getByText("Counting items…")).toBeTruthy();
    expect(region.querySelector("progress")!.hasAttribute("value")).toBe(false);
    emitTask({ type: "progress", taskId: id, stage: "running", completed: 512, total: 2048, unit: "bytes" });
    expect(within(region).getByText("512 B of 2.0 KB")).toBeTruthy();
    expect(region.querySelector("progress")!.getAttribute("value")).toBe("512");
  });

  it("asks before resolving a conflict; folders cannot be replaced", async () => {
    await start();
    select("a.txt");
    menu("copy");
    menu("paste");
    await waitFor(() => expect(called("start_transfer").length).toBe(1));
    const id = taskId("start_transfer");
    emitTask({
      type: "conflict", taskId: id, conflictId: "c1", sourceId: a.id, destinationId: docs.id,
      sourceName: "Docs", destinationName: "Docs", sourceKind: "directory", destinationKind: "directory", sameItem: false,
    });
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByRole("button", { name: /Replace/ })).toBeNull();
    expect(within(dialog).getByText(/never merged or replaced/)).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText(/all remaining conflicts/));
    fireEvent.click(within(dialog).getByText("Keep both"));
    await waitFor(() => expect(called("resolve_conflict").length).toBe(1));
    expect(called("resolve_conflict")[0]!.args).toEqual({ conflictId: "c1", decision: "keepBoth", applyToAll: true });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("offers explicit replacement for files and sends it only when chosen", async () => {
    await start();
    select("a.txt");
    menu("copy");
    menu("paste");
    await waitFor(() => expect(called("start_transfer").length).toBe(1));
    emitTask({
      type: "conflict", taskId: taskId("start_transfer"), conflictId: "c2", sourceId: a.id, destinationId: b.id,
      sourceName: "a.txt", destinationName: "a.txt", sourceKind: "file", destinationKind: "file", sameItem: false,
    });
    const dialog = await screen.findByRole("alertdialog");
    expect(called("resolve_conflict").length).toBe(0);
    fireEvent.click(within(dialog).getByRole("button", { name: /Replace/ }));
    await waitFor(() => expect(called("resolve_conflict")[0]!.args).toMatchObject({ decision: "replace", applyToAll: false }));
  });

  it("cancels honestly: reports completed work and does not claim rollback", async () => {
    await start();
    select("a.txt", "b.txt");
    menu("copy");
    menu("paste");
    await waitFor(() => expect(called("start_transfer").length).toBe(1));
    const id = taskId("start_transfer");
    const region = screen.getByRole("region", { name: "File operations" });
    fireEvent.click(within(region).getByText("Cancel"));
    await waitFor(() => expect(called("cancel_task")[0]!.args).toEqual({ taskId: id }));
    emitTask({ type: "cancelled", taskId: id, ...emptyTotals, succeeded: 1, affected: [home.id] });
    expect(await within(region).findByText(/Cancelled\..*already done was not undone/)).toBeTruthy();
  });

  it("lists partial failures and the omitted count", async () => {
    await start();
    select("a.txt", "b.txt");
    menu("trash");
    await waitFor(() => expect(called("trash_items").length).toBe(1));
    emitTask({
      type: "finished", taskId: taskId("trash_items"), ...emptyTotals, succeeded: 1,
      failed: [{ id: b.id, error: { category: "permissionDenied", operation: "trash", context: "b.txt", message: "b.txt is locked" } }],
      failedOmitted: 2,
    });
    const alert = await screen.findByText(/Moved to the Trash: 1 item\./);
    expect(alert.textContent).toContain("3 items could not be moved to the Trash");
    expect(screen.getByText("b.txt is locked")).toBeTruthy();
    expect(screen.getByText(/and 2 more/)).toBeTruthy();
  });

  it("reports a task that fails to start", async () => {
    failCommand = { start_transfer: { category: "permissionDenied", operation: "copy", context: "", message: "Cannot write there" } };
    await start();
    select("a.txt");
    menu("copy");
    menu("paste");
    expect(await screen.findByText("Cannot write there")).toBeTruthy();
  });

  it("creates a folder then lets the user name it", async () => {
    await start();
    menu("new-folder");
    const dialog = await screen.findByRole("dialog");
    expect(called("create_folder")[0]!.args).toEqual({ parentId: home.id, name: null });
    const input = within(dialog).getByLabelText("Name") as HTMLInputElement;
    expect(input.value).toBe("New folder");
    fireEvent.change(input, { target: { value: "Projects" } });
    fireEvent.click(within(dialog).getByText("Name folder"));
    await waitFor(() => expect(called("rename_item")[0]!.args).toEqual({ id: hex("/Users/me/New folder"), newName: "Projects" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("renames one item and shows backend errors in the dialog", async () => {
    failCommand = { rename_item: { category: "alreadyExists", operation: "rename", context: "", message: "That name is already used" } };
    await start();
    select("a.txt");
    fireEvent.keyDown(screen.getByRole("grid"), { key: "F2" });
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "b.txt" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(await within(dialog).findByText("That name is already used")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("does not rename with several items selected", async () => {
    await start();
    select("a.txt", "b.txt");
    menu("rename");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sends clipboard menu actions to the focused text field instead of file operations", async () => {
    await start();
    select("a.txt");
    fireEvent.click(screen.getByLabelText("Edit address"));
    (screen.getByLabelText("Address") as HTMLInputElement).focus();
    menu("copy");
    menu("trash");
    await waitFor(() => expect(called("edit_action")[0]!.args).toEqual({ action: "copy" }));
    expect(called("trash_items").length).toBe(0);
  });

  it("keeps Properties, Search and Move to unavailable", async () => {
    await start();
    expect(screen.getByRole("button", { name: /Move to \(not available yet\)/ })).toBeTruthy();
  });
});
