// MOCKED IPC: these tests replace Tauri's `invoke` and `listen` with an in-memory
// fake backend. They verify the frontend contract handling only; they are not
// evidence of a real native IPC round trip or of real filesystem data.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { DIRECTORY_EVENT, MENU_EVENT } from "./backend/contracts";
import type { AppError, DirectoryEvent, FileEntry, PlatformInfo, Places } from "./backend/contracts";
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
  const name = path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
  return { id: hex(path), path, name, kind: "file", size: 1234, modifiedMs: 1_700_000_000_000, isSymlink: false, isBrokenLink: false, ...over };
}
const dir = (path: string) => entry(path, { kind: "directory", size: null });

const home = dir("/Users/me");
const docs = dir("/Users/me/Docs");
const root = dir("/");
const places: Places = {
  places: [
    { label: "Home", group: "quick", entry: home },
    { label: "Documents", group: "quick", entry: docs },
    { label: "Macintosh HD", group: "volume", entry: root },
  ],
  failures: [],
};

let reads: { readId: string; id: string }[] = [];
let cancelled: string[] = [];
let opened: string[] = [];
let openError: AppError | null = null;
let resolveError: AppError | null = null;
const directories = new Map<string, FileEntry>();

function emit(event: DirectoryEvent) {
  act(() => {
    for (const l of [...mocks.listeners]) if (l.name === DIRECTORY_EVENT) l.cb({ payload: event });
  });
}
function menu(id: unknown) {
  act(() => {
    for (const l of [...mocks.listeners]) if (l.name === MENU_EVENT) l.cb({ payload: id });
  });
}

beforeEach(() => {
  reads = [];
  cancelled = [];
  opened = [];
  openError = null;
  resolveError = null;
  mocks.listeners = [];
  localStorage.clear();
  resetIconQueueForTests();
  directories.clear();
  for (const d of [home, docs, root]) directories.set(d.path, d);
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
    switch (command) {
      case "get_platform_info":
        return info;
      case "get_home_directory":
        return home;
      case "list_places":
        return places;
      case "resolve_directory": {
        if (resolveError) throw resolveError;
        const found = directories.get(args.path);
        if (!found) throw { category: "notFound", operation: "open", context: args.path, message: `${args.path} was not found` };
        return found;
      }
      case "start_directory_read":
        reads.push({ readId: args.readId, id: args.id });
        return undefined;
      case "cancel_directory_read":
        cancelled.push(args.readId);
        return undefined;
      case "open_item":
        if (openError) throw openError;
        opened.push(args.id);
        return undefined;
      case "get_icon":
        throw new Error("no icon in tests");
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
});

afterEach(() => {
  cleanup();
  mocks.invoke.mockReset();
});

const lastRead = () => reads[reads.length - 1]!;
const waitForRead = (n: number) => waitFor(() => expect(reads.length).toBe(n));
const finish = (readId: string, entries: FileEntry[]) => {
  emit({ type: "entries", readId, entries, failures: [] });
  emit({ type: "finished", readId, entries: entries.length, failed: 0 });
};
const grid = () => screen.getByRole("grid");
const rowFor = (name: string) => screen.getByText(name).closest('[role="row"]') as HTMLElement;
const tabs = () => within(screen.getByRole("tablist", { name: "Folder tabs" })).getAllByRole("tab");

async function startInHome(entries: FileEntry[] = []) {
  render(<App />);
  await waitForRead(1);
  finish(lastRead().readId, entries);
}

describe("App (mocked IPC)", () => {
  it("starts in the home folder and streams entries", async () => {
    render(<App />);
    await waitForRead(1);
    expect(lastRead().id).toBe(home.id);
    emit({ type: "entries", readId: lastRead().readId, entries: [entry("/Users/me/b.txt")], failures: [] });
    expect(await screen.findByText("b.txt")).toBeTruthy();
    expect(grid().getAttribute("aria-busy")).toBe("true");
    emit({ type: "entries", readId: lastRead().readId, entries: [entry("/Users/me/a.txt")], failures: [] });
    emit({ type: "finished", readId: lastRead().readId, entries: 2, failed: 0 });
    expect(grid().getAttribute("aria-busy")).toBe("false");
    const names = screen.getAllByRole("row").slice(1).map((r) => r.textContent);
    expect(names[0]).toContain("a.txt");
    expect(names[1]).toContain("b.txt");
  });

  it("shows an empty folder only after a successful finish", async () => {
    render(<App />);
    await waitForRead(1);
    expect(screen.queryByText("This folder is empty.")).toBeNull();
    emit({ type: "finished", readId: lastRead().readId, entries: 0, failed: 0 });
    expect(await screen.findByText("This folder is empty.")).toBeTruthy();
  });

  it("shows a failed read as an error, never as an empty folder", async () => {
    render(<App />);
    await waitForRead(1);
    emit({ type: "failed", readId: lastRead().readId, error: { category: "permissionDenied", operation: "read the folder", context: "me", message: "Permission denied for me" } });
    expect((await screen.findAllByRole("alert"))[0]!.textContent).toContain("Permission denied for me");
    expect(screen.queryByText("This folder is empty.")).toBeNull();
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("reports metadata failures instead of dropping entries", async () => {
    render(<App />);
    await waitForRead(1);
    const { readId } = lastRead();
    emit({ type: "entries", readId, entries: [entry("/Users/me/ok.txt")], failures: [{ id: "x", error: { category: "notFound", operation: "read", context: "gone", message: "gone vanished" } }] });
    emit({ type: "finished", readId, entries: 1, failed: 1 });
    const banner = (await screen.findAllByRole("alert")).find((a) => a.textContent?.includes("1 item could not be read"))!;
    fireEvent.click(within(banner).getByText("Show details"));
    expect(banner.textContent).toContain("gone vanished");
    expect(screen.getByText("ok.txt")).toBeTruthy();
  });

  it("navigates into folders with coherent history and back/forward/up", async () => {
    await startInHome([docs]);
    fireEvent.doubleClick(rowFor("Docs"));
    await waitForRead(2);
    expect(lastRead().id).toBe(docs.id);
    expect(cancelled).not.toContain(reads[0]!.readId); // first read already finished
    finish(lastRead().readId, [entry("/Users/me/Docs/new.txt")]);
    expect(await screen.findByText("new.txt")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Back"));
    await waitForRead(3);
    expect(lastRead().id).toBe(home.id);
    expect((screen.getByLabelText("Forward") as HTMLButtonElement).disabled).toBe(false);
    finish(lastRead().readId, [docs]);

    fireEvent.click(screen.getByLabelText("Forward"));
    await waitForRead(4);
    expect(lastRead().id).toBe(docs.id);
    finish(lastRead().readId, []);

    // Up is lexical and selects the folder we came from.
    fireEvent.click(screen.getByLabelText("Up one level"));
    await waitForRead(5);
    expect(lastRead().id).toBe(home.id);
    finish(lastRead().readId, [docs, entry("/Users/me/z.txt")]);
    await waitFor(() => expect(rowFor("Docs").getAttribute("aria-selected")).toBe("true"));
  });

  it("cancels an in-flight read when navigating and ignores its late events", async () => {
    render(<App />);
    await waitForRead(1);
    const first = lastRead().readId;
    emit({ type: "entries", readId: first, entries: [docs], failures: [] });
    fireEvent.doubleClick(await screen.findByText("Docs"));
    await waitForRead(2);
    await waitFor(() => expect(cancelled).toContain(first));
    emit({ type: "entries", readId: first, entries: [entry("/Users/me/stale.txt")], failures: [] });
    emit({ type: "finished", readId: first, entries: 1, failed: 0 });
    expect(screen.queryByText("stale.txt")).toBeNull();
    emit({ type: "entries", readId: lastRead().readId, entries: [entry("/Users/me/Docs/new.txt")], failures: [] });
    expect(await screen.findByText("new.txt")).toBeTruthy();
  });

  it("validates typed addresses and leaves history untouched on failure", async () => {
    await startInHome();
    fireEvent.click(screen.getByLabelText("Edit address"));
    const input = screen.getByLabelText("Address") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/nope" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toContain("/nope was not found");
    expect(reads.length).toBe(1);
    expect((screen.getByLabelText("Back") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "/Users/me/Docs" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitForRead(2);
    expect(lastRead().id).toBe(docs.id);
    expect((screen.getByLabelText("Back") as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens the address editor from the native Go to Folder menu action", async () => {
    await startInHome();
    menu("address");
    expect(await screen.findByLabelText("Address")).toBeTruthy();
  });

  it("keeps tabs independent: path, history, selection and loading state", async () => {
    await startInHome([docs, entry("/Users/me/a.txt")]);
    fireEvent.click(rowFor("a.txt"));
    fireEvent.click(screen.getByLabelText("New tab"));
    await waitForRead(2);
    expect(lastRead().id).toBe(home.id);
    expect(tabs().length).toBe(2);
    // Second tab loads while the first keeps its content; navigate it away.
    finish(lastRead().readId, [docs, entry("/Users/me/a.txt")]);
    expect(rowFor("a.txt").getAttribute("aria-selected")).toBe("false");
    fireEvent.doubleClick(rowFor("Docs"));
    await waitForRead(3);
    finish(lastRead().readId, [entry("/Users/me/Docs/inner.txt")]);
    expect(await screen.findByText("inner.txt")).toBeTruthy();
    expect((screen.getByLabelText("Back") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(tabs()[0]!);
    expect(screen.queryByText("inner.txt")).toBeNull();
    expect(rowFor("a.txt").getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("Back") as HTMLButtonElement).disabled).toBe(true);
  });

  it("cancels the read of a closed tab and ignores its late events", async () => {
    await startInHome([docs]);
    fireEvent.click(screen.getByLabelText("New tab"));
    await waitForRead(2);
    const second = lastRead().readId;
    fireEvent.click(screen.getAllByLabelText(/^Close tab/)[1]!);
    await waitFor(() => expect(cancelled).toContain(second));
    expect(tabs().length).toBe(1);
    emit({ type: "entries", readId: second, entries: [entry("/Users/me/ghost.txt")], failures: [] });
    expect(screen.queryByText("ghost.txt")).toBeNull();
  });

  it("does not close the last tab and says why", async () => {
    await startInHome();
    menu("close-tab");
    expect(tabs().length).toBe(1);
    await waitFor(() => expect(document.body.textContent).toContain("last tab can't be closed"));
  });

  it("supports keyboard tab management through native menu actions", async () => {
    await startInHome();
    menu("new-tab");
    await waitForRead(2);
    expect(tabs().length).toBe(2);
    menu("previous-tab");
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    menu("next-tab");
    expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
    menu("close-tab");
    expect(tabs().length).toBe(1);
    menu({ not: "a string" }); // ignored
  });

  it("selects with click, Command-toggle, Shift-range, arrows and Command+A", async () => {
    await startInHome(["a", "b", "c", "d"].map((n) => entry(`/Users/me/${n}.txt`)));
    const sel = (n: string) => rowFor(n).getAttribute("aria-selected");
    fireEvent.click(rowFor("a.txt"));
    fireEvent.click(rowFor("c.txt"), { metaKey: true });
    expect([sel("a.txt"), sel("b.txt"), sel("c.txt")]).toEqual(["true", "false", "true"]);
    fireEvent.click(rowFor("b.txt"));
    fireEvent.click(rowFor("d.txt"), { shiftKey: true });
    expect([sel("a.txt"), sel("b.txt"), sel("c.txt"), sel("d.txt")]).toEqual(["false", "true", "true", "true"]);
    fireEvent.keyDown(grid(), { key: "ArrowUp" });
    expect([sel("a.txt"), sel("b.txt"), sel("c.txt")]).toEqual(["false", "false", "true"]);
    fireEvent.keyDown(grid(), { key: "a", metaKey: true });
    expect(["a", "b", "c", "d"].every((n) => sel(`${n}.txt`) === "true")).toBe(true);
    expect(screen.getByText(/4 selected/)).toBeTruthy();
    fireEvent.keyDown(grid(), { key: "Escape" });
    expect(sel("a.txt")).toBe("false");
  });

  it("keeps the selected identity when the sort order changes", async () => {
    await startInHome([entry("/Users/me/a.txt", { size: 5 }), entry("/Users/me/b.txt", { size: 1 })]);
    fireEvent.click(rowFor("a.txt"));
    fireEvent.click(screen.getByLabelText("Sort by Size"));
    const order = screen.getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
    expect(order[0]).toContain("b.txt");
    expect(rowFor("a.txt").getAttribute("aria-selected")).toBe("true");
    expect(grid().querySelector('[aria-sort="ascending"]')?.textContent).toContain("Size");
    expect(JSON.parse(localStorage.getItem("explorer.preferences.v1")!).sort).toEqual({ key: "size", direction: "asc" });
  });

  it("hides dot items by default and shows them on request", async () => {
    await startInHome([entry("/Users/me/.secret"), entry("/Users/me/a.txt")]);
    expect(screen.queryByText(".secret")).toBeNull();
    expect(screen.getByText(/1 hidden/)).toBeTruthy();
    menu("hidden-items");
    expect(await screen.findByText(".secret")).toBeTruthy();
  });

  it("opens files through the backend and surfaces open failures", async () => {
    await startInHome([entry("/Users/me/a.txt")]);
    fireEvent.doubleClick(rowFor("a.txt"));
    await waitFor(() => expect(opened).toEqual([hex("/Users/me/a.txt")]));
    expect(reads.length).toBe(1);
    openError = { category: "notFound", operation: "open", context: "a.txt", message: "a.txt vanished" };
    fireEvent.click(rowFor("a.txt"));
    fireEvent.keyDown(grid(), { key: "Enter" });
    expect((await screen.findAllByRole("alert"))[0]!.textContent).toContain("a.txt vanished");
  });

  it("navigates from the sidebar to a real location", async () => {
    await startInHome();
    fireEvent.click(await screen.findByRole("button", { name: /Documents/ }));
    await waitForRead(2);
    expect(lastRead().id).toBe(docs.id);
  });

  it("offers real actions in context menus and marks later work unavailable", async () => {
    await startInHome([docs]);
    fireEvent.contextMenu(rowFor("Docs"));
    const menuEl = await screen.findByRole("menu");
    expect(within(menuEl).getByText("Open")).toBeTruthy();
    const props = within(menuEl).getByText("Properties").closest("li")!;
    expect(props.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(props);
    expect(opened.length).toBe(0);
    expect(within(menuEl).queryByText("Delete")).toBeNull();
    fireEvent.click(within(menuEl).getByText("Open in new tab"));
    await waitForRead(2);
    expect(tabs().length).toBe(2);
    expect(lastRead().id).toBe(docs.id);
  });

  /** Holds resolve_directory calls until the test settles them, in any order. */
  function holdResolves() {
    const original = mocks.invoke.getMockImplementation()!;
    const held: { path: string; ok: (e: FileEntry) => void; fail: (e: AppError) => void }[] = [];
    mocks.invoke.mockImplementation((command: string, args: Record<string, string>) =>
      command === "resolve_directory"
        ? new Promise((ok, fail) => held.push({ path: args.path, ok: ok as (e: FileEntry) => void, fail }))
        : original(command, args),
    );
    return held;
  }
  const submit = (text: string) => {
    if (!screen.queryByLabelText("Address")) fireEvent.click(screen.getByLabelText("Edit address"));
    const input = screen.getByLabelText("Address") as HTMLInputElement;
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: "Enter" });
  };
  const ribbonOpen = () => within(screen.getByRole("group", { name: "Open" })).getByRole("button", { name: "Open" }) as HTMLButtonElement;
  const notFound: AppError = { category: "notFound", operation: "open", context: "x", message: "late failure" };

  it("ignores a late address failure after a newer navigation", async () => {
    await startInHome([docs]);
    const held = holdResolves();
    submit("/slow");
    await waitFor(() => expect(held.length).toBe(1));
    fireEvent.click(screen.getByLabelText("Refresh"));
    await waitForRead(2);
    await act(async () => held[0]!.fail(notFound));
    expect(screen.queryByText("late failure")).toBeNull();
  });

  it("ignores a late address success after a newer navigation", async () => {
    await startInHome([docs]);
    const held = holdResolves();
    submit("/slow");
    await waitFor(() => expect(held.length).toBe(1));
    fireEvent.click(screen.getByLabelText("Refresh"));
    await waitForRead(2);
    await act(async () => held[0]!.ok(docs));
    expect(reads.length).toBe(2);
    expect(lastRead().id).toBe(home.id);
  });

  it("applies only the latest of out-of-order address requests", async () => {
    await startInHome();
    const held = holdResolves();
    submit("/first");
    await waitFor(() => expect(held.length).toBe(1));
    submit("/second");
    await waitFor(() => expect(held.length).toBe(2));
    await act(async () => held[1]!.ok(docs));
    await waitForRead(2);
    expect(lastRead().id).toBe(docs.id);
    await act(async () => held[0]!.fail(notFound));
    expect(screen.queryByText("late failure")).toBeNull();
    expect(reads.length).toBe(2);
  });

  it("drops an address result for a tab that was closed", async () => {
    await startInHome();
    menu("new-tab");
    await waitForRead(2);
    const held = holdResolves();
    submit("/slow");
    await waitFor(() => expect(held.length).toBe(1));
    menu("close-tab");
    expect(tabs().length).toBe(1);
    await act(async () => held[0]!.ok(docs));
    expect(reads.length).toBe(2);
    expect(screen.queryByText("late failure")).toBeNull();
  });

  it("leaves text editing alone for native Select All and Open while the address is focused", async () => {
    await startInHome([entry("/Users/me/a.txt")]);
    fireEvent.click(rowFor("a.txt"));
    menu("address");
    const input = (await screen.findByLabelText("Address")) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    menu("select-all");
    expect(input.selectionEnd! - input.selectionStart!).toBe(input.value.length);
    expect(screen.getByText(/1 selected/)).toBeTruthy();
    menu("open");
    expect(opened).toEqual([]);
  });

  it("selects all rows from the native menu when the list has focus", async () => {
    await startInHome(["a", "b"].map((n) => entry(`/Users/me/${n}.txt`)));
    grid().focus();
    menu("select-all");
    expect(screen.getByText(/2 selected/)).toBeTruthy();
  });

  it("never acts on selected items that the hidden filter removed", async () => {
    await startInHome([entry("/Users/me/.dot"), entry("/Users/me/a.txt")]);
    menu("hidden-items");
    fireEvent.click(await screen.findByText(".dot"));
    menu("hidden-items"); // hide again while .dot is selected
    await waitFor(() => expect(screen.queryByText(".dot")).toBeNull());
    expect(screen.queryByText(/selected/)).toBeNull();
    expect(ribbonOpen().disabled).toBe(true);
    menu("open");
    expect(opened).toEqual([]);
    grid().focus();
    fireEvent.keyDown(grid(), { key: "Enter" });
    expect(opened).toEqual([]);
    // Showing them again keeps surfaces consistent.
    menu("hidden-items");
    fireEvent.click(await screen.findByText(".dot"));
    menu("open");
    await waitFor(() => expect(opened).toEqual([hex("/Users/me/.dot")]));
  });

  it("counts only visible rows in a mixed selection", async () => {
    await startInHome([entry("/Users/me/.dot"), entry("/Users/me/a.txt"), entry("/Users/me/b.txt")]);
    menu("hidden-items");
    fireEvent.click(await screen.findByText(".dot"));
    fireEvent.click(rowFor("a.txt"), { metaKey: true });
    expect(screen.getByText(/2 selected/)).toBeTruthy();
    menu("hidden-items");
    await waitFor(() => expect(screen.queryByText(".dot")).toBeNull());
    expect(screen.getByText(/1 selected/)).toBeTruthy();
    fireEvent.click(ribbonOpen());
    await waitFor(() => expect(opened).toEqual([hex("/Users/me/a.txt")]));
  });

  it("does not let an old address submission close another tab's editor", async () => {
    await startInHome();
    const held = holdResolves();
    submit("/slow-a");
    await waitFor(() => expect(held.length).toBe(1));
    menu("new-tab");
    await waitForRead(2);
    fireEvent.click(screen.getByLabelText("Edit address"));
    const input = screen.getByLabelText("Address") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/draft-b" } });
    await act(async () => held[0]!.ok(docs));
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("/draft-b");
    await waitForRead(3); // A still navigates, but only in its own tab
    expect(lastRead().id).toBe(docs.id);
  });

  it("keeps a failure of tab A from touching tab B's editor", async () => {
    await startInHome();
    const held = holdResolves();
    submit("/slow-a");
    await waitFor(() => expect(held.length).toBe(1));
    menu("new-tab");
    await waitForRead(2);
    fireEvent.click(screen.getByLabelText("Edit address"));
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "/draft-b" } });
    await act(async () => held[0]!.fail(notFound));
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("/draft-b");
    expect(screen.queryByText("late failure")).toBeNull();
  });

  it("does not let an old submission close an editor reopened in the same tab", async () => {
    await startInHome();
    const held = holdResolves();
    submit("/slow");
    await waitFor(() => expect(held.length).toBe(1));
    fireEvent.keyDown(screen.getByLabelText("Address"), { key: "Escape" });
    fireEvent.click(screen.getByLabelText("Edit address"));
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "/new-draft" } });
    await act(async () => held[0]!.ok(docs));
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("/new-draft");
  });

  it("virtualizes large directories", async () => {
    const many = Array.from({ length: 5000 }, (_, i) => entry(`/Users/me/f${String(i).padStart(5, "0")}.txt`));
    await startInHome(many);
    expect(grid().getAttribute("aria-rowcount")).toBe("5001");
    const mounted = screen.getAllByRole("row").length;
    expect(mounted).toBeLessThan(80);
    expect(screen.queryByText("f04999.txt")).toBeNull();
    fireEvent.scroll(grid(), { target: { scrollTop: 24 * 4990 } });
    expect(await screen.findByText("f04999.txt")).toBeTruthy();
    expect(screen.getAllByRole("row").length).toBeLessThan(80);
  });

  it("reports an unreadable home folder as an error", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command === "get_home_directory") throw { category: "notFound", operation: "open the home folder", context: null, message: "no home" };
      return original(command, args);
    });
    render(<App />);
    expect((await screen.findAllByRole("alert"))[0]!.textContent).toContain("no home");
  });

  it("reports sidebar failures instead of inventing locations", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command === "list_places") throw "places unavailable";
      return original(command, args);
    });
    await startInHome();
    expect((await screen.findAllByRole("alert")).some((a) => a.textContent?.includes("places unavailable"))).toBe(true);
  });

  it("surfaces a failing start request", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command === "start_directory_read") throw "backend unavailable";
      return original(command, args);
    });
    render(<App />);
    expect((await screen.findAllByRole("alert"))[0]!.textContent).toContain("backend unavailable");
  });

  it("reports native capabilities returned by the backend", async () => {
    render(<App />);
    fireEvent.click(screen.getByText("Native services"));
    expect(await screen.findByText(/26\.6\.1 \(aarch64\)/)).toBeTruthy();
    const row = screen.getByText(/NSDraggingSession/).closest("tr")!;
    expect(row.textContent).toContain("No");
  });
});
