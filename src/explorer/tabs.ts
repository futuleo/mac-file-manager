import type { AppError, FileEntry, ItemFailure } from "../backend/contracts";
import * as hist from "./history";
import type { Location } from "./path";
import { emptySelection, prune, type Selection } from "./selection";

export const MAX_TABS = 16;

export type Listing =
  | { status: "loading"; entries: FileEntry[]; failures: ItemFailure[] }
  | { status: "ready"; entries: FileEntry[]; failures: ItemFailure[] }
  | { status: "failed"; entries: FileEntry[]; failures: ItemFailure[]; error: AppError };

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
  | { type: "reload"; tabId: string; reveal?: string | null }
  | { type: "entries"; tabId: string; nav: number; entries: FileEntry[]; failures: ItemFailure[] }
  | { type: "finished"; tabId: string; nav: number }
  | { type: "failed"; tabId: string; nav: number; error: AppError }
  | { type: "select"; tabId: string; selection: Selection }
  | { type: "address-error"; tabId: string; error: AppError | null }
  | { type: "action-error"; tabId: string; error: AppError | null };

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
  };
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
      return update(state, action.tabId, (tab) =>
        hist.current(tab.history) ? { ...restart(tab, tab.history, true), reveal: action.reveal ?? null } : tab,
      );
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
        let selection = prune(tab.selection, entries);
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
  }
}
