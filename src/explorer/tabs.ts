import type { AppError, FileEntry, ItemFailure, SearchMode } from "../backend/contracts";
import * as hist from "./history";
import type { Location } from "./path";
import { emptySelection, prune, type Selection } from "./selection";

export const MAX_TABS = 16;

export type Listing =
  | { status: "loading"; entries: FileEntry[]; failures: ItemFailure[] }
  | { status: "ready"; entries: FileEntry[]; failures: ItemFailure[] }
  | { status: "failed"; entries: FileEntry[]; failures: ItemFailure[]; error: AppError };

/**
 * A tab's Spotlight search. `key` identifies one native query: events carry the key they were
 * started with, so results of a cancelled or replaced search never reach a newer one.
 * There is no "complete" status because Spotlight cannot report whether it finished indexing.
 */
export interface TabSearch {
  key: number;
  query: string;
  mode: SearchMode;
  /** The folder searched (with its descendants). */
  scopeId: string;
  status: "gathering" | "live" | "limited" | "failed";
  entries: FileEntry[];
  skipped: number;
  /** Set when the result cap was reached: the search ended (status "limited") and the list is incomplete by design. */
  limit: number | null;
  error: AppError | null;
}

export interface Tab {
  id: string;
  history: hist.History;
  /**
   * Increments on every navigation or refresh. Listing results carry the value they were
   * started with, so anything from an earlier navigation is ignored.
   */
  nav: number;
  listing: Listing;
  selection: Selection;
  /** Folder to select once the listing is ready (the child we came up from). */
  reveal: string | null;
  addressError: AppError | null;
  actionError: AppError | null;
  search: TabSearch | null;
  /** Source of `TabSearch.key`; never reused within a tab. */
  searchSerial: number;
  /** Counts every swap between folder list and search list that does not change `nav`; never reused. */
  viewSerial: number;
}

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  serial: number;
}

export const initialTabsState: TabsState = { tabs: [], activeId: null, serial: 0 };

export type TabAction =
  | { type: "open"; location: Location | null }
  | { type: "close"; tabId: string }
  | { type: "activate"; tabId: string }
  | { type: "navigate"; tabId: string; location: Location; reveal?: string | null; ifNav?: number }
  | { type: "back"; tabId: string }
  | { type: "forward"; tabId: string }
  | { type: "reload"; tabId: string; reveal?: string | null; keepSearch?: boolean }
  | { type: "entries"; tabId: string; nav: number; entries: FileEntry[]; failures: ItemFailure[] }
  | { type: "finished"; tabId: string; nav: number }
  | { type: "failed"; tabId: string; nav: number; error: AppError }
  | { type: "select"; tabId: string; selection: Selection }
  | { type: "address-error"; tabId: string; error: AppError | null }
  | { type: "action-error"; tabId: string; error: AppError | null }
  | { type: "search-start"; tabId: string; query: string; mode: SearchMode }
  | { type: "search-clear"; tabId: string }
  | { type: "search-results"; tabId: string; key: number; entries: FileEntry[]; skipped: number }
  | { type: "search-removed"; tabId: string; key: number; ids: string[] }
  | { type: "search-state"; tabId: string; key: number; state: "gathering" | "live" }
  | { type: "search-limited"; tabId: string; key: number; limit: number }
  | { type: "search-failed"; tabId: string; key: number; error: AppError };

const loading: Listing = { status: "loading", entries: [], failures: [] };

function newTab(serial: number, location: Location | null): Tab {
  return {
    id: `tab-${serial}`,
    history: location ? hist.push(hist.emptyHistory, location) : hist.emptyHistory,
    nav: 0,
    listing: loading,
    selection: emptySelection,
    reveal: null,
    addressError: null,
    actionError: null,
    search: null,
    searchSerial: 0,
    viewSerial: 0,
  };
}

/** Moves a tab to a new history position: a fresh load for a new navigation id. */
function restart(tab: Tab, history: hist.History, keepSelection: boolean): Tab {
  return {
    ...tab,
    history,
    nav: tab.nav + 1,
    listing: loading,
    selection: keepSelection ? tab.selection : emptySelection,
    reveal: null,
    addressError: null,
    actionError: null,
    search: null,
  };
}

/** Applies a change to the tab's search only if the event still belongs to the live query. */
function onSearch(state: TabsState, tabId: string, key: number, change: (s: TabSearch, tab: Tab) => Tab): TabsState {
  return update(state, tabId, (tab) => (tab.search && tab.search.key === key ? change(tab.search, tab) : tab));
}

export const activeTab = (state: TabsState): Tab | null =>
  state.tabs.find((t) => t.id === state.activeId) ?? null;

function update(state: TabsState, tabId: string, change: (tab: Tab) => Tab): TabsState {
  let touched = false;
  const tabs = state.tabs.map((t) => {
    if (t.id !== tabId) return t;
    const next = change(t);
    touched = next !== t;
    return next;
  });
  return touched ? { ...state, tabs } : state;
}

export function tabsReducer(state: TabsState, action: TabAction): TabsState {
  switch (action.type) {
    case "open": {
      if (state.tabs.length >= MAX_TABS) return state;
      const serial = state.serial + 1;
      const tab = newTab(serial, action.location);
      return { tabs: [...state.tabs, tab], activeId: tab.id, serial };
    }
    case "close": {
      const index = state.tabs.findIndex((t) => t.id === action.tabId);
      if (index < 0 || state.tabs.length === 1) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.tabId);
      const activeId =
        state.activeId === action.tabId ? tabs[Math.min(index, tabs.length - 1)]!.id : state.activeId;
      return { ...state, tabs, activeId };
    }
    case "activate":
      if (!state.tabs.some((t) => t.id === action.tabId) || state.activeId === action.tabId) return state;
      return { ...state, activeId: action.tabId };
    case "navigate":
      return update(state, action.tabId, (tab) => {
        if (action.ifNav !== undefined && tab.nav !== action.ifNav) return tab;
        const here = hist.current(tab.history);
        if (here?.id === action.location.id) return { ...restart(tab, tab.history, true), reveal: action.reveal ?? null };
        return { ...restart(tab, hist.push(tab.history, action.location), false), reveal: action.reveal ?? null };
      });
    case "back":
      return update(state, action.tabId, (tab) =>
        hist.canGoBack(tab.history) ? restart(tab, hist.back(tab.history), false) : tab,
      );
    case "forward":
      return update(state, action.tabId, (tab) =>
        hist.canGoForward(tab.history) ? restart(tab, hist.forward(tab.history), false) : tab,
      );
    case "reload":
      return update(state, action.tabId, (tab) => {
        if (!hist.current(tab.history)) return tab;
        const next = { ...restart(tab, tab.history, true), reveal: action.reveal ?? null };
        // A search list survives a refresh of the folder underneath it.
        return action.keepSearch ? { ...next, search: tab.search } : next;
      });
    case "entries":
      return update(state, action.tabId, (tab) =>
        tab.nav !== action.nav || tab.listing.status !== "loading"
          ? tab
          : {
              ...tab,
              listing: {
                status: "loading",
                entries: tab.listing.entries.concat(action.entries),
                failures: tab.listing.failures.concat(action.failures),
              },
            },
      );
    case "finished":
      return update(state, action.tabId, (tab) => {
        if (tab.nav !== action.nav || tab.listing.status !== "loading") return tab;
        const entries = tab.listing.entries;
        // A search list owns the selection; the folder underneath only refreshes.
        let selection = tab.search ? tab.selection : prune(tab.selection, entries);
        const reveal = tab.reveal && entries.some((e) => e.id === tab.reveal) ? tab.reveal : null;
        if (reveal) selection = { ids: new Set([reveal]), anchor: reveal, focus: reveal };
        return { ...tab, selection, reveal: null, listing: { ...tab.listing, status: "ready" } };
      });
    case "failed":
      return update(state, action.tabId, (tab) =>
        tab.nav !== action.nav
          ? tab
          : { ...tab, reveal: null, listing: { ...tab.listing, status: "failed", error: action.error } },
      );
    case "select":
      return update(state, action.tabId, (tab) => ({ ...tab, selection: action.selection }));
    case "address-error":
      return update(state, action.tabId, (tab) => ({ ...tab, addressError: action.error }));
    case "action-error":
      return update(state, action.tabId, (tab) => ({ ...tab, actionError: action.error }));
    case "search-start":
      return update(state, action.tabId, (tab) => {
        const here = hist.current(tab.history);
        if (!here) return tab;
        const key = tab.searchSerial + 1;
        return {
          ...tab,
          searchSerial: key,
          viewSerial: tab.viewSerial + 1,
          selection: emptySelection,
          reveal: null,
          actionError: null,
          search: {
            key,
            query: action.query,
            mode: action.mode,
            scopeId: here.id,
            status: "gathering",
            entries: [],
            skipped: 0,
            limit: null,
            error: null,
          },
        };
      });
    case "search-clear":
      return update(state, action.tabId, (tab) => (tab.search ? { ...tab, search: null, selection: emptySelection, viewSerial: tab.viewSerial + 1 } : tab));
    case "search-results":
      return onSearch(state, action.tabId, action.key, (s, tab) => {
        if (s.status === "failed") return tab;
        const index = new Map(s.entries.map((e, i) => [e.id, i]));
        const entries = s.entries.slice();
        for (const entry of action.entries) {
          const at = index.get(entry.id);
          if (at === undefined) {
            index.set(entry.id, entries.length);
            entries.push(entry);
          } else entries[at] = entry;
        }
        return { ...tab, search: { ...s, entries, skipped: s.skipped + action.skipped } };
      });
    case "search-removed":
      return onSearch(state, action.tabId, action.key, (s, tab) => {
        const gone = new Set(action.ids);
        const entries = s.entries.filter((e) => !gone.has(e.id));
        if (entries.length === s.entries.length) return tab;
        return { ...tab, search: { ...s, entries }, selection: prune(tab.selection, entries) };
      });
    case "search-state":
      return onSearch(state, action.tabId, action.key, (s, tab) =>
        s.status === "failed" || s.status === "limited" || s.status === action.state ? tab : { ...tab, search: { ...s, status: action.state } },
      );
    case "search-limited":
      return onSearch(state, action.tabId, action.key, (s, tab) =>
        s.status === "failed" ? tab : { ...tab, search: { ...s, status: "limited", limit: action.limit } },
      );
    case "search-failed":
      return onSearch(state, action.tabId, action.key, (s, tab) => ({
        ...tab,
        search: { ...s, status: "failed", error: action.error },
      }));
  }
}
