// MOCKED IPC: `invoke` and `listen` are in-memory fakes of the backend. These tests verify how
// the UI starts, cancels and renders searches and keeps them per tab; they do not prove real
// Spotlight results, native menu delivery or WebView behavior.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { DIRECTORY_EVENT, MENU_EVENT, SEARCH_EVENT } from "./backend/contracts";
import type { FileEntry, SearchEvent } from "./backend/contracts";
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

const hex = (path: string) => Array.from(new TextEncoder().encode(path), (b) => b.toString(16).padStart(2, "0")).join("");
function entry(path: string, over: Partial<FileEntry> = {}): FileEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { id: hex(path), path, name, kind: "file", size: 10, modifiedMs: 1_700_000_000_000, isSymlink: false, isBrokenLink: false, ...over };
}
const dir = (path: string) => entry(path, { kind: "directory", size: null });
const home = dir("/Users/me");
const nested = entry("/Users/me/Docs/deep/report.txt");
const deepDir = dir("/Users/me/Docs/deep");

let reads: { readId: string; id: string }[] = [];
let calls: { command: string; args: Record<string, unknown> }[] = [];
let failCommand: Record<string, unknown> = {};

const called = (command: string) => calls.filter((c) => c.command === command);
const emitSearch = (event: SearchEvent) =>
  act(() => {
    for (const l of [...mocks.listeners]) if (l.name === SEARCH_EVENT) l.cb({ payload: event });
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
      case "get_platform_info": return { appVersion: "0", osVersion: "26", arch: "aarch64", deploymentTarget: "12.0", capabilities: { spotlightQuery: true, quickLookPanel: true, trash: true, systemIcons: true, dragSession: false } };
      case "get_home_directory": return home;
      case "list_places": return { places: [{ label: "Home", group: "quick", entry: home }], failures: [] };
      case "start_directory_read":
        reads.push({ readId: args.readId as string, id: args.id as string });
        return undefined;
      case "parent_directory": return deepDir;
      case "get_icon": throw new Error("no icon in tests");
      default: return undefined;
    }
  });
});
afterEach(() => {
  cleanup();
  mocks.invoke.mockReset();
});

async function start() {
  render(<App />);
  await waitFor(() => expect(reads.length).toBe(1));
  finishRead(reads[0]!.readId, [entry("/Users/me/a.txt")]);
}
const box = () => screen.getByLabelText("Search this folder") as HTMLInputElement;
async function search(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: "Enter" });
  await waitFor(() => expect(called("start_search").length).toBeGreaterThan(0));
  return called("start_search")[called("start_search").length - 1]!.args as { searchId: string; scopeId: string; mode: string; query: string };
}

describe("search UI (mocked IPC)", () => {
  it("searches the current folder by name, shows incremental results with their location, honest caveats", async () => {
    await start();
    const args = await search("report");
    expect(args).toMatchObject({ scopeId: home.id, mode: "filename", query: "report" });
    expect(screen.getByText(/Searching file names for “report”/)).toBeTruthy();
    emitSearch({ type: "results", searchId: args.searchId, entries: [nested], skipped: 0 });
    expect(screen.getByText("report.txt")).toBeTruthy();
    expect(screen.getByText("/Users/me/Docs/deep")).toBeTruthy();
    emitSearch({ type: "state", searchId: args.searchId, state: "live" });
    expect(screen.getAllByText(/best-effort/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/\bcomplete\b/i)).toBeNull();
  });

  it("uses content mode and never treats an empty live result as certainty", async () => {
    await start();
    fireEvent.change(screen.getByLabelText("Search by"), { target: { value: "content" } });
    const args = await search("needle");
    expect(args.mode).toBe("content");
    emitSearch({ type: "state", searchId: args.searchId, state: "live" });
    expect(screen.getByText(/does not prove nothing matches/)).toBeTruthy();
  });

  it("ignores events of another search id", async () => {
    await start();
    const args = await search("report");
    emitSearch({ type: "results", searchId: "other", entries: [nested], skipped: 0 });
    expect(screen.queryByText("report.txt")).toBeNull();
    emitSearch({ type: "results", searchId: args.searchId, entries: [nested], skipped: 3 });
    expect(screen.getByText(/3 matches were left out/)).toBeTruthy();
  });

  it("Escape cancels natively and restores the folder listing", async () => {
    await start();
    const args = await search("report");
    fireEvent.keyDown(box(), { key: "Escape" });
    await waitFor(() => expect(called("cancel_search")[0]?.args).toEqual({ searchId: args.searchId }));
    expect(screen.getByText("a.txt")).toBeTruthy();
    expect(screen.queryByText(/Searching/)).toBeNull();
  });

  it("a new query cancels the previous native search", async () => {
    await start();
    const first = await search("one");
    fireEvent.change(box(), { target: { value: "two" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(called("start_search").length).toBe(2));
    await waitFor(() => expect(called("cancel_search").some((c) => c.args.searchId === first.searchId)).toBe(true));
    emitSearch({ type: "results", searchId: first.searchId, entries: [nested], skipped: 0 });
    expect(screen.queryByText("report.txt")).toBeNull();
  });

  it("shows a failure as an error, not an empty result", async () => {
    await start();
    const args = await search("report");
    emitSearch({ type: "failed", searchId: args.searchId, error: { category: "permissionDenied", operation: "search", context: null, message: "Cannot search this folder" } });
    expect(screen.getByRole("alert").textContent).toContain("Cannot search this folder");
    expect(screen.queryByText(/no matches/)).toBeNull();
  });

  it("⌘F focuses the search box", async () => {
    await start();
    menu("search");
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it("opens a folder result by its id and shows the containing folder with the item selected", async () => {
    await start();
    const args = await search("deep");
    emitSearch({ type: "results", searchId: args.searchId, entries: [deepDir, nested], skipped: 0 });
    fireEvent.contextMenu(screen.getByText("report.txt").closest('[role="row"]')!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Show containing folder/ }));
    await waitFor(() => expect(called("parent_directory")[0]?.args).toEqual({ id: nested.id }));
    await waitFor(() => expect(reads[reads.length - 1]!.id).toBe(deepDir.id));
    await waitFor(() => expect(called("cancel_search").length).toBe(1));
    finishRead(reads[reads.length - 1]!.readId, [nested]);
    expect(screen.getByText("report.txt").closest('[role="row"]')!.getAttribute("aria-selected")).toBe("true");
  });

  it("does not paste or create folders into a search result list", async () => {
    await start();
    const args = await search("report");
    emitSearch({ type: "results", searchId: args.searchId, entries: [nested], skipped: 0 });
    fireEvent.click(screen.getByText("report.txt").closest('[role="row"]')!);
    menu("copy");
    menu("paste");
    menu("new-folder");
    expect(called("start_transfer").length).toBe(0);
    expect(called("create_folder").length).toBe(0);
  });

  it("trashes search results by their own ids", async () => {
    await start();
    const args = await search("report");
    emitSearch({ type: "results", searchId: args.searchId, entries: [nested], skipped: 0 });
    fireEvent.click(screen.getByText("report.txt").closest('[role="row"]')!);
    menu("trash");
    await waitFor(() => expect(called("trash_items")[0]?.args).toMatchObject({ ids: [nested.id] }));
  });
});
