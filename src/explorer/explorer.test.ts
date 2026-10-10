import { describe, expect, it } from "vitest";
import type { FileEntry } from "../backend/contracts";
import * as hist from "./history";
import { ancestors, parentOf } from "./path";
import { defaultPreferences, parsePreferences } from "./preferences";
import { emptySelection, extendTo, invert, move, prune, selectAll, selectOnly, toggle } from "./selection";
import { formatEntrySize, nextSort, sortEntries, typeLabel } from "./sort";
import { initialTabsState, MAX_TABS, tabsReducer, type TabsState } from "./tabs";
import { scrollTopFor, visibleRange } from "./virtual";

const hex = (path: string) => Array.from(new TextEncoder().encode(path), (b) => b.toString(16).padStart(2, "0")).join("");
const loc = (path: string) => ({ id: hex(path), path, name: path.slice(path.lastIndexOf("/") + 1) || "/" });
const file = (name: string, over: Partial<FileEntry> = {}): FileEntry => ({
  id: hex(`/d/${name}`), path: `/d/${name}`, name, kind: "file", size: 1, modifiedMs: 1, isSymlink: false, isBrokenLink: false, ...over,
});

describe("path", () => {
  it("derives breadcrumbs from raw bytes, including non-UTF-8 ids", () => {
    expect(ancestors(loc("/Users/me")).map((l) => l.name)).toEqual(["/", "Users", "me"]);
    expect(parentOf(loc("/Users/me"))?.id).toBe(hex("/Users"));
    expect(parentOf(loc("/"))).toBeNull();
    const odd = { id: "2f61ff", path: "/a\ufffd", name: "a\ufffd" }; // /a<0xff>
    expect(ancestors(odd)).toHaveLength(2);
    expect(ancestors({ id: "zz", path: "x", name: "x" })).toHaveLength(1);
  });
});

describe("history", () => {
  it("ignores same-location pushes and truncates forward entries", () => {
    let h = hist.push(hist.emptyHistory, loc("/a"));
    h = hist.push(h, loc("/a"));
    expect(h.items).toHaveLength(1);
    h = hist.push(hist.push(h, loc("/b")), loc("/c"));
    h = hist.back(hist.back(h));
    expect(hist.canGoForward(h)).toBe(true);
    h = hist.push(h, loc("/d"));
    expect(h.items.map((l) => l.path)).toEqual(["/a", "/d"]);
    expect(hist.canGoBack(hist.back(h))).toBe(false);
  });
});

describe("sorting", () => {
  const items = [
    file("b.txt", { size: 5, modifiedMs: 10 }),
    file("A.txt", { size: null, modifiedMs: null }),
    file("a10.txt", { size: 5, modifiedMs: 20 }),
    file("a2.txt", { size: 5, modifiedMs: 20 }),
    file("dir", { kind: "directory", size: null }),
  ];
  const names = (key: Parameters<typeof nextSort>[1], direction: "asc" | "desc") =>
    sortEntries(items, { key, direction }).map((e) => e.name);

  it("groups folders first and compares names naturally", () => {
    expect(names("name", "asc")).toEqual(["dir", "A.txt", "a2.txt", "a10.txt", "b.txt"]);
  });
  it("puts unknown values last in both directions and ties by name", () => {
    expect(names("size", "asc").slice(-1)).toEqual(["A.txt"]);
    expect(names("size", "desc").slice(-1)).toEqual(["A.txt"]);
    expect(names("modified", "desc")).toEqual(["dir", "a2.txt", "a10.txt", "b.txt", "A.txt"]);
    expect(formatEntrySize(items[1]!)).toBe("Unknown");
  });
  it("is deterministic regardless of input order and does not mutate", () => {
    const reversed = [...items].reverse();
    expect(sortEntries(reversed, { key: "type", direction: "asc" })).toEqual(sortEntries(items, { key: "type", direction: "asc" }));
    expect(items[0]!.name).toBe("b.txt");
  });
  it("labels links and toggles direction", () => {
    expect(typeLabel(file("x", { kind: "other", isSymlink: true, isBrokenLink: true }))).toContain("Broken");
    expect(nextSort({ key: "name", direction: "asc" }, "name").direction).toBe("desc");
  });
});

describe("selection", () => {
  const rows = ["a", "b", "c", "d"].map((n) => file(n));
  it("handles toggle, range, movement and select-all by identity", () => {
    let s = toggle(selectOnly(rows[0]!.id), rows[2]!.id);
    expect([...s.ids]).toEqual([rows[0]!.id, rows[2]!.id]);
    s = extendTo(rows, selectOnly(rows[1]!.id), rows[3]!.id);
    expect(s.ids.size).toBe(3);
    s = move(rows, s, "up", true);
    expect(s.ids.size).toBe(2);
    expect(move(rows, emptySelection, "down", false).focus).toBe(rows[0]!.id);
    expect(move(rows, selectOnly(rows[3]!.id), "down", false).focus).toBe(rows[3]!.id);
    expect(move(rows, selectOnly(rows[0]!.id), { page: 10 }, false).focus).toBe(rows[3]!.id);
    expect(selectAll(rows, emptySelection).ids.size).toBe(4);
    expect(invert(rows, selectOnly(rows[0]!.id)).ids.size).toBe(3);
  });
  it("prunes vanished identities", () => {
    const pruned = prune(selectAll(rows, emptySelection), rows.slice(0, 2));
    expect(pruned.ids.size).toBe(2);
    expect(pruned.focus).toBe(rows[0]!.id);
  });
});

describe("virtual window", () => {
  it("is bounded by the viewport, not the count", () => {
    const r = visibleRange(24 * 5000, 600, 1_000_000);
    expect(r.end - r.start).toBeLessThan(50);
    expect(visibleRange(0, 600, 3)).toEqual({ start: 0, end: 3 });
    expect(scrollTopFor(100, 0, 240)).toBe(100 * 24 + 24 - 240);
    expect(scrollTopFor(1, 0, 240)).toBe(0);
  });
});

describe("preferences", () => {
  it("validates stored data and stores nothing else", () => {
    expect(parsePreferences("not json")).toEqual(defaultPreferences);
    const p = parsePreferences(JSON.stringify({ sort: { key: "evil", direction: "desc" }, showHidden: true, columns: { name: 1, modified: 99999 }, history: ["/secret"] }));
    expect(p.sort).toEqual({ key: "name", direction: "desc" });
    expect(p.columns.name).toBe(60);
    expect(p.columns.modified).toBe(800);
    expect(Object.keys(p).sort()).toEqual(["columns", "showHidden", "sort"]);
  });
});

describe("tabs reducer", () => {
  const open = (s: TabsState, path: string | null) => tabsReducer(s, { type: "open", location: path ? loc(path) : null });
  const err = { category: "notFound" as const, operation: "x", context: null, message: "boom" };

  it("keeps per-tab state independent and never closes the last tab", () => {
    let s = open(open(initialTabsState, "/a"), "/b");
    const [t1, t2] = s.tabs;
    s = tabsReducer(s, { type: "navigate", tabId: t1!.id, location: loc("/c") });
    expect(s.tabs[0]!.history.items).toHaveLength(2);
    expect(s.tabs[1]!.history.items).toHaveLength(1);
    s = tabsReducer(s, { type: "close", tabId: t2!.id });
    expect(tabsReducer(s, { type: "close", tabId: t1!.id })).toBe(s);
  });
  it("ignores results from superseded navigations and closed tabs", () => {
    let s = open(initialTabsState, "/a");
    const id = s.tabs[0]!.id;
    const stale = s.tabs[0]!.nav;
    s = tabsReducer(s, { type: "navigate", tabId: id, location: loc("/b") });
    const after = tabsReducer(s, { type: "entries", tabId: id, nav: stale, entries: [file("x")], failures: [] });
    expect(after).toBe(s);
    expect(tabsReducer(s, { type: "failed", tabId: id, nav: stale, error: err })).toBe(s);
    expect(tabsReducer(s, { type: "finished", tabId: "tab-99", nav: 1 })).toBe(s);
  });
  it("guards address navigation with ifNav and a failure does not touch history", () => {
    let s = open(initialTabsState, "/a");
    const { id, nav } = s.tabs[0]!;
    s = tabsReducer(s, { type: "address-error", tabId: id, error: err });
    expect(s.tabs[0]!.history.items).toHaveLength(1);
    s = tabsReducer(s, { type: "navigate", tabId: id, location: loc("/b") }); // newer navigation
    const guarded = tabsReducer(s, { type: "navigate", tabId: id, location: loc("/c"), ifNav: nav });
    expect(guarded).toBe(s);
  });
  it("marks failures and caps tab count", () => {
    let s = open(initialTabsState, "/a");
    const { id, nav } = s.tabs[0]!;
    s = tabsReducer(s, { type: "failed", tabId: id, nav, error: err });
    expect(s.tabs[0]!.listing.status).toBe("failed");
    for (let i = 0; i < MAX_TABS + 3; i += 1) s = open(s, "/a");
    expect(s.tabs).toHaveLength(MAX_TABS);
  });
  it("keeps selection on reload and clears it on a new folder", () => {
    let s = open(initialTabsState, "/a");
    const id = s.tabs[0]!.id;
    s = tabsReducer(s, { type: "select", tabId: id, selection: selectOnly("x") });
    s = tabsReducer(s, { type: "reload", tabId: id });
    expect(s.tabs[0]!.selection.ids.has("x")).toBe(true);
    s = tabsReducer(s, { type: "navigate", tabId: id, location: loc("/b") });
    expect(s.tabs[0]!.selection.ids.size).toBe(0);
  });
});

describe("tab search state", () => {
  const loc = { id: "aa", path: "/a", name: "a" } as never;
  const file = (id: string, name = id) =>
    ({ id, path: `/a/${name}`, name, kind: "file", size: 1, modifiedMs: null, isSymlink: false, isBrokenLink: false }) as FileEntry;
  const start = () => {
    let s = tabsReducer(initialTabsState, { type: "open", location: loc });
    s = tabsReducer(s, { type: "search-start", tabId: "tab-1", query: "q", mode: "filename" });
    return s;
  };

  it("applies results as upserts and drops events from an older query or other tab", () => {
    let s = start();
    s = tabsReducer(s, { type: "search-results", tabId: "tab-1", key: 1, entries: [file("1"), file("2")], skipped: 1 });
    s = tabsReducer(s, { type: "search-results", tabId: "tab-1", key: 1, entries: [file("2", "renamed")], skipped: 0 });
    expect(s.tabs[0]!.search!.entries.map((e) => e.name)).toEqual(["1", "renamed"]);
    expect(s.tabs[0]!.search!.skipped).toBe(1);
    s = tabsReducer(s, { type: "search-start", tabId: "tab-1", query: "r", mode: "content" });
    expect(s.tabs[0]!.search!.key).toBe(2);
    const stale = tabsReducer(s, { type: "search-results", tabId: "tab-1", key: 1, entries: [file("9")], skipped: 0 });
    expect(stale).toBe(s);
    expect(tabsReducer(s, { type: "search-results", tabId: "tab-9", key: 2, entries: [file("9")], skipped: 0 })).toBe(s);
  });

  it("a terminal limit ends gathering and live states and ignores later state events", () => {
    for (const first of ["gathering", "live"] as const) {
      let s = start();
      s = tabsReducer(s, { type: "search-results", tabId: "tab-1", key: 1, entries: [file("1", "q")], skipped: 0 });
      if (first === "live") s = tabsReducer(s, { type: "search-state", tabId: "tab-1", key: 1, state: "live" });
      expect(s.tabs[0]!.search!.status).toBe(first);
      s = tabsReducer(s, { type: "search-limited", tabId: "tab-1", key: 1, limit: 3 });
      expect(s.tabs[0]!.search).toMatchObject({ status: "limited", limit: 3 });
      expect(tabsReducer(s, { type: "search-state", tabId: "tab-1", key: 1, state: "gathering" })).toBe(s);
      expect(tabsReducer(s, { type: "search-state", tabId: "tab-1", key: 1, state: "live" })).toBe(s);
    }
  });

  it("a folder refresh under a search keeps the search selection and focus through reload, entries and finished", () => {
    let s = start();
    s = tabsReducer(s, { type: "search-results", tabId: "tab-1", key: 1, entries: [file("d", "q-deep")], skipped: 0 });
    s = tabsReducer(s, { type: "select", tabId: "tab-1", selection: { ids: new Set(["d"]), anchor: "d", focus: "d" } });
    s = tabsReducer(s, { type: "reload", tabId: "tab-1", keepSearch: true });
    const nav = s.tabs[0]!.nav;
    s = tabsReducer(s, { type: "entries", tabId: "tab-1", nav, entries: [file("other")], failures: [] });
    s = tabsReducer(s, { type: "finished", tabId: "tab-1", nav });
    const tab = s.tabs[0]!;
    expect(tab.listing.status).toBe("ready");
    expect(tab.search?.entries.map((e) => e.id)).toEqual(["d"]);
    expect([...tab.selection.ids]).toEqual(["d"]);
    expect(tab.selection.focus).toBe("d");
  });

  it("refreshing the folder under a search keeps it only when asked", () => {
    let s = start();
    s = tabsReducer(s, { type: "search-results", tabId: "tab-1", key: 1, entries: [file("1", "q")], skipped: 0 });
    const kept = tabsReducer(s, { type: "reload", tabId: "tab-1", keepSearch: true }).tabs[0]!;
    expect(kept.search?.key).toBe(1);
    expect(kept.search?.entries.length).toBe(1);
    expect(kept.listing.status).toBe("loading");
    expect(tabsReducer(s, { type: "reload", tabId: "tab-1" }).tabs[0]!.search).toBeNull();
  });

  it("navigation and reload end the search; removals prune selection", () => {
    let s = start();
    s = tabsReducer(s, { type: "search-results", tabId: "tab-1", key: 1, entries: [file("1"), file("2")], skipped: 0 });
    s = tabsReducer(s, { type: "select", tabId: "tab-1", selection: { ids: new Set(["1", "2"]), anchor: "1", focus: "2" } });
    s = tabsReducer(s, { type: "search-removed", tabId: "tab-1", key: 1, ids: ["2"] });
    expect([...s.tabs[0]!.selection.ids]).toEqual(["1"]);
    expect(tabsReducer(s, { type: "reload", tabId: "tab-1" }).tabs[0]!.search).toBeNull();
    expect(tabsReducer(s, { type: "navigate", tabId: "tab-1", location: { id: "bb", path: "/b", name: "b" } as never }).tabs[0]!.search).toBeNull();
    expect(tabsReducer(s, { type: "search-clear", tabId: "tab-1" }).tabs[0]!.search).toBeNull();
  });

  it("a failure is terminal and never an empty success", () => {
    let s = start();
    const error = { category: "notFound", operation: "search", context: null, message: "gone" } as const;
    s = tabsReducer(s, { type: "search-failed", tabId: "tab-1", key: 1, error });
    s = tabsReducer(s, { type: "search-state", tabId: "tab-1", key: 1, state: "live" });
    s = tabsReducer(s, { type: "search-results", tabId: "tab-1", key: 1, entries: [file("1")], skipped: 0 });
    expect(s.tabs[0]!.search).toMatchObject({ status: "failed", error, entries: [] });
  });
});
