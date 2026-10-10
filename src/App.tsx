import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { call } from "./backend/client";
import { MENU_EVENT, type AppError, type FileEntry, type Places } from "./backend/contracts";
import { toAppError } from "./backend/directory";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import NavBar from "./NavBar";
import Ribbon from "./Ribbon";
import Sidebar from "./Sidebar";
import StatusBar from "./StatusBar";
import TabReader from "./TabReader";
import TabStrip, { tabButtonId, tabPanelId } from "./TabStrip";
import TabView from "./TabView";
import * as hist from "./explorer/history";
import { locationOf, parentOf, type Location } from "./explorer/path";
import {
  loadPreferences,
  savePreferences,
  type ColumnWidths,
  type Preferences,
} from "./explorer/preferences";
import { emptySelection, invert, selectAll, type Selection } from "./explorer/selection";
import { formatSize, isHidden, nextSort, sortEntries, type SortKey, type SortState } from "./explorer/sort";
import { MAX_TABS, activeTab, initialTabsState, tabsReducer, type Tab } from "./explorer/tabs";

interface MenuState {
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
}

const SHORT = (name: string) => (name.length > 24 ? `${name.slice(0, 23)}…` : name);

export default function App() {
  const [state, dispatch] = useReducer(tabsReducer, initialTabsState);
  const [prefs, setPrefs] = useState<Preferences>(loadPreferences);
  const [places, setPlaces] = useState<Places | null>(null);
  const [placesError, setPlacesError] = useState<AppError | null>(null);
  const [home, setHome] = useState<Location | null>(null);
  const [homeError, setHomeError] = useState<AppError | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [addressFocus, setAddressFocus] = useState(0);
  const scrollTops = useRef(new Map<string, number>());
  const stateRef = useRef(state);
  stateRef.current = state;
  const selectionRef = useRef<Selection>(emptySelection);
  const rowsRef = useRef<FileEntry[]>([]);

  useEffect(() => savePreferences(prefs), [prefs]);

  const tab = activeTab(state);
  const location = tab ? hist.current(tab.history) : null;

  const announce = setAnnouncement;

  // Start: resolve home and open the first tab (a failure is shown, with retry).
  const startHome = useCallback(() => {
    setHomeError(null);
    call("get_home_directory").then(
      (entry) => {
        const loc = locationOf(entry);
        setHome(loc);
        if (stateRef.current.tabs.length === 0) dispatch({ type: "open", location: loc });
        else {
          const first = stateRef.current.tabs.find((t) => !hist.current(t.history));
          if (first) dispatch({ type: "navigate", tabId: first.id, location: loc });
        }
      },
      (reason) => {
        const error = toAppError(reason, "find the home folder");
        setHomeError(error);
        if (stateRef.current.tabs.length === 0) dispatch({ type: "open", location: null });
      },
    );
  }, []);
  useEffect(startHome, [startHome]);

  const loadPlaces = useCallback(() => {
    call("list_places").then(
      (value) => {
        setPlaces(value);
        setPlacesError(null);
      },
      (reason) => setPlacesError(toAppError(reason, "list the standard locations")),
    );
  }, []);
  useEffect(() => {
    loadPlaces();
    window.addEventListener("focus", loadPlaces);
    return () => window.removeEventListener("focus", loadPlaces);
  }, [loadPlaces]);

  const rootLabel = useMemo(() => {
    const volume = places?.places.find((p) => p.group === "volume" && p.entry.path === "/");
    return volume?.label ?? null;
  }, [places]);

  // Rows: hidden filter and sorting. While loading, rows stay in arrival order.
  const hiddenCount = tab ? tab.listing.entries.filter(isHidden).length : 0;
  const rows = useMemo(() => {
    if (!tab) return [];
    const visible = prefs.showHidden ? tab.listing.entries : tab.listing.entries.filter((e) => !isHidden(e));
    return tab.listing.status === "loading" ? visible : sortEntries(visible, prefs.sort);
  }, [tab?.listing, prefs.showHidden, prefs.sort]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeId = tab?.id ?? null;

  // The selection as seen through the current filter: hidden items are never actionable.
  const selection = useMemo<Selection>(() => {
    if (!tab) return emptySelection;
    const sel = tab.selection;
    if (prefs.showHidden) return sel;
    const visible = new Set(rows.map((r) => r.id));
    const ids = new Set([...sel.ids].filter((id) => visible.has(id)));
    const anchor = sel.anchor !== null && visible.has(sel.anchor) ? sel.anchor : null;
    const focus = sel.focus !== null && visible.has(sel.focus) ? sel.focus : null;
    return ids.size === sel.ids.size && anchor === sel.anchor && focus === sel.focus ? sel : { ids, anchor, focus };
  }, [tab?.selection, rows, prefs.showHidden]); // eslint-disable-line react-hooks/exhaustive-deps

  const navigate = useCallback((tabId: string, target: Location, reveal: string | null = null) => {
    dispatch({ type: "navigate", tabId, location: target, reveal });
  }, []);

  const openEntry = useCallback(
    (tabId: string, entry: FileEntry) => {
      if (entry.kind === "directory") {
        navigate(tabId, locationOf(entry));
        return;
      }
      dispatch({ type: "action-error", tabId, error: null });
      call("open_item", { id: entry.id }).catch((reason) =>
        dispatch({ type: "action-error", tabId, error: toAppError(reason, `open ${entry.name}`) }),
      );
    },
    [navigate],
  );

  const goUp = useCallback(() => {
    const t = activeTab(stateRef.current);
    const here = t && hist.current(t.history);
    const parent = here && parentOf(here);
    if (t && here && parent) navigate(t.id, parent, here.id);
  }, [navigate]);

  // Latest address request per tab; navigation or closing a tab invalidates it.
  const addressRequests = useRef(new Map<string, { seq: number; nav: number }>());
  const addressSeq = useRef(0);
  const submitAddress = useCallback(async (text: string): Promise<boolean> => {
    const t = activeTab(stateRef.current);
    if (!t) return false;
    const { id, nav } = t;
    const seq = (addressSeq.current += 1);
    addressRequests.current.set(id, { seq, nav });
    const current = () => {
      const now = stateRef.current.tabs.find((x) => x.id === id);
      const req = addressRequests.current.get(id);
      return !!now && now.nav === nav && req?.seq === seq;
    };
    try {
      const entry = await call("resolve_directory", { path: text });
      if (!current()) return false;
      addressRequests.current.delete(id);
      dispatch({ type: "navigate", tabId: id, location: locationOf(entry), ifNav: nav });
      return true;
    } catch (reason) {
      if (current()) {
        addressRequests.current.delete(id);
        dispatch({ type: "address-error", tabId: id, error: toAppError(reason, "go to that folder") });
      }
      return false;
    }
  }, []);

  const select = useCallback(
    (selection: Selection) => activeId && dispatch({ type: "select", tabId: activeId, selection }),
    [activeId],
  );

  const focusedEntry = (): FileEntry | null => {
    const focus = selectionRef.current.focus;
    return focus === null ? null : rowsRef.current.find((e) => e.id === focus) ?? null;
  };

  const openFocused = () => {
    const t = activeTab(stateRef.current);
    const entry = focusedEntry();
    if (t && entry) openEntry(t.id, entry);
  };

  const newTab = useCallback((target?: Location | null) => {
    const t = activeTab(stateRef.current);
    const start = target ?? (t && hist.current(t.history)) ?? home;
    if (stateRef.current.tabs.length >= MAX_TABS) {
      setAnnouncement(`At most ${MAX_TABS} tabs can be open.`);
      return;
    }
    dispatch({ type: "open", location: start });
  }, [home]);

  const closeTab = useCallback((id: string) => {
    if (stateRef.current.tabs.length === 1) {
      setAnnouncement("The last tab can't be closed. Use Close Window (⇧⌘W) to quit.");
      return;
    }
    scrollTops.current.delete(id);
    addressRequests.current.delete(id);
    dispatch({ type: "close", tabId: id });
  }, []);

  const cycleTab = (delta: number) => {
    const { tabs, activeId: current } = stateRef.current;
    const i = tabs.findIndex((t) => t.id === current);
    const next = tabs[(i + delta + tabs.length) % tabs.length];
    if (next) dispatch({ type: "activate", tabId: next.id });
  };

  const setSort = (sort: SortState) => setPrefs((p) => ({ ...p, sort }));
  const setShowHidden = (showHidden: boolean) => setPrefs((p) => ({ ...p, showHidden }));
  const setColumns = (columns: ColumnWidths) => setPrefs((p) => ({ ...p, columns }));

  selectionRef.current = selection;
  rowsRef.current = rows;
  const selectAllRows = () => activeId && dispatch({ type: "select", tabId: activeId, selection: selectAll(rows, selection) });

  // Native menu actions arrive as ids on the menu event.
  const menuHandler = useRef<(id: string) => void>(() => {});
  menuHandler.current = (id) => {
    const t = activeTab(stateRef.current);
    // Native menu shortcuts must not hijack text editing.
    const el = document.activeElement as HTMLElement | null;
    const editing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    if (editing && (id === "select-all" || id === "open")) {
      if (id === "select-all") (el as HTMLInputElement).select?.();
      return;
    }
    switch (id) {
      case "new-tab": return newTab();
      case "close-tab": return t && closeTab(t.id);
      case "next-tab": return cycleTab(1);
      case "previous-tab": return cycleTab(-1);
      case "open": return openFocused();
      case "select-all": return selectAllRows();
      case "refresh": return t && dispatch({ type: "reload", tabId: t.id });
      case "back": return t && dispatch({ type: "back", tabId: t.id });
      case "forward": return t && dispatch({ type: "forward", tabId: t.id });
      case "enclosing-folder": return goUp();
      case "home": return t && home && navigate(t.id, home);
      case "address": return setAddressFocus((n) => n + 1);
      case "hidden-items": return setShowHidden(!prefs.showHidden);
    }
  };
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    listen<unknown>(MENU_EVENT, (event) => {
      if (typeof event.payload === "string") menuHandler.current(event.payload);
    }).then(
      (fn) => (active ? (unlisten = fn) : fn()),
      () => undefined,
    );
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Announce load outcomes for screen readers.
  const status = tab?.listing.status;
  const entryCount = tab?.listing.entries.length ?? 0;
  const errorMessage = tab?.listing.status === "failed" ? tab.listing.error.message : null;
  useEffect(() => {
    if (status === "ready") announce(`${entryCount} item${entryCount === 1 ? "" : "s"}`);
    else if (errorMessage) announce(errorMessage);
  }, [status, entryCount, errorMessage, activeId, announce]);

  const sortItems = (): MenuItem[] =>
    (["name", "modified", "type", "size"] as SortKey[]).map((key) => ({
      label: `Sort by ${{ name: "name", modified: "date modified", type: "type", size: "size" }[key]}`,
      checked: prefs.sort.key === key,
      onSelect: () => setSort({ ...prefs.sort, key }),
    }));

  const openItemMenu = (entry: FileEntry | null, x: number, y: number) => {
    if (!tab) return;
    if (entry) {
      if (!selection.ids.has(entry.id)) {
        dispatch({ type: "select", tabId: tab.id, selection: { ids: new Set([entry.id]), anchor: entry.id, focus: entry.id } });
      }
      const items: MenuItem[] = [
        { label: "Open", shortcut: "⌘O", onSelect: () => openEntry(tab.id, entry) },
      ];
      if (entry.kind === "directory") {
        items.push({ label: "Open in new tab", onSelect: () => newTab(locationOf(entry)) });
      }
      items.push(
        { separator: true },
        { label: "Cut", unavailable: true },
        { label: "Copy", unavailable: true },
        { separator: true },
        { label: "Rename", unavailable: true },
        { label: "Delete", unavailable: true },
        { separator: true },
        { label: "Properties", unavailable: true },
      );
      setMenu({ x, y, label: `Actions for ${entry.name}`, items });
    } else {
      setMenu({
        x,
        y,
        label: "Folder actions",
        items: [
          { label: "Refresh", shortcut: "⌘R", onSelect: () => dispatch({ type: "reload", tabId: tab.id }) },
          { separator: true },
          ...sortItems(),
          { separator: true },
          { label: "Hidden items", shortcut: "⇧⌘.", checked: prefs.showHidden, onSelect: () => setShowHidden(!prefs.showHidden) },
          { separator: true },
          { label: "Paste", unavailable: true },
          { label: "New folder", unavailable: true },
        ],
      });
    }
  };

  const openSidebarMenu = (target: Location, x: number, y: number) =>
    setMenu({
      x,
      y,
      label: `Actions for ${target.name}`,
      items: [
        { label: "Open", onSelect: () => tab && navigate(tab.id, target) },
        { label: "Open in new tab", onSelect: () => newTab(target) },
      ],
    });

  const selectedBytes = useMemo(() => {
    if (!tab) return null;
    let total = 0;
    let any = false;
    for (const e of rows) {
      if (selection.ids.has(e.id) && e.kind === "file" && e.size !== null) {
        total += e.size;
        any = true;
      }
    }
    return any ? total : null;
  }, [rows, selection]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabTitle = (t: Tab) => {
    const here = hist.current(t.history);
    return here ? SHORT(here.name || "/") : "New tab";
  };

  const currentPath = location?.path ?? null;

  return (
    <div className="explorer">
      <TabStrip
        tabs={state.tabs.map((t) => ({ id: t.id, title: tabTitle(t) }))}
        activeId={state.activeId}
        canAdd={state.tabs.length < MAX_TABS}
        onActivate={(id) => dispatch({ type: "activate", tabId: id })}
        onClose={closeTab}
        onNew={() => newTab()}
      />
      <Ribbon
        canOpen={!!selection.focus}
        canSelect={rows.length > 0}
        hasSelection={selection.ids.size > 0}
        showHidden={prefs.showHidden}
        sort={prefs.sort}
        onOpen={openFocused}
        onSelectAll={selectAllRows}
        onSelectNone={() => select(emptySelection)}
        onInvert={() => activeId && dispatch({ type: "select", tabId: activeId, selection: invert(rows, selection) })}
        onShowHidden={setShowHidden}
        onSort={setSort}
      />
      <NavBar
        key={tab?.id ?? "none"}
        location={location}
        rootLabel={rootLabel}
        canBack={!!tab && hist.canGoBack(tab.history)}
        canForward={!!tab && hist.canGoForward(tab.history)}
        canUp={!!location && !!parentOf(location)}
        error={tab?.addressError ?? null}
        busy={tab?.listing.status === "loading"}
        focusRequest={addressFocus}
        onBack={() => tab && dispatch({ type: "back", tabId: tab.id })}
        onForward={() => tab && dispatch({ type: "forward", tabId: tab.id })}
        onUp={goUp}
        onRefresh={() => tab && dispatch({ type: "reload", tabId: tab.id })}
        onNavigate={(target) => tab && navigate(tab.id, target)}
        onSubmit={submitAddress}
        onDismissError={() => tab && dispatch({ type: "address-error", tabId: tab.id, error: null })}
      />
      <div className="panes">
        <Sidebar
          places={places}
          error={placesError}
          currentPath={currentPath}
          onOpen={(target) => tab && navigate(tab.id, target)}
          onContextMenu={openSidebarMenu}
        />
        <main className="content">
          {state.tabs.map((t) => (
            <TabReader
              key={t.id}
              tabId={t.id}
              locationId={hist.current(t.history)?.id ?? null}
              nav={t.nav}
              dispatch={dispatch}
            />
          ))}
          {tab && (
            <div
              role="tabpanel"
              id={tabPanelId(tab.id)}
              aria-labelledby={tabButtonId(tab.id)}
              className="tabpanel"
            >
              {!location && homeError ? (
                <div className="error-view" role="alert">
                  <div>
                    <p className="error-title">The home folder can't be found</p>
                    <p className="error-message">{homeError.message}</p>
                    <p className="error-actions">
                      <button type="button" className="command" onClick={startHome}>
                        Try again
                      </button>
                    </p>
                  </div>
                </div>
              ) : (
                <TabView
                  key={tab.id}
                  tab={tab}
                  selection={selection}
                  rows={rows}
                  label={location ? `Contents of ${location.name || "/"}` : "Folder contents"}
                  sort={prefs.sort}
                  columns={prefs.columns}
                  canGoBack={hist.canGoBack(tab.history)}
                  initialScrollTop={scrollTops.current.get(tab.id) ?? 0}
                  onScrollTop={(top) => scrollTops.current.set(tab.id, top)}
                  onSort={(key) => setSort(nextSort(prefs.sort, key))}
                  onColumns={setColumns}
                  onSelect={select}
                  onActivate={(entry) => openEntry(tab.id, entry)}
                  onContextMenu={openItemMenu}
                  onRetry={() => dispatch({ type: "reload", tabId: tab.id })}
                  onBack={() => dispatch({ type: "back", tabId: tab.id })}
                  onDismissAction={() => dispatch({ type: "action-error", tabId: tab.id, error: null })}
                />
              )}
            </div>
          )}
        </main>
      </div>
      <StatusBar
        total={rows.length}
        hidden={prefs.showHidden ? 0 : hiddenCount}
        selected={selection.ids.size}
        selectedBytes={selectedBytes}
        loading={tab?.listing.status === "loading"}
        formatBytes={formatSize}
      />
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
