import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { call } from "./backend/client";
import { MENU_EVENT, type AppError, type FileEntry, type Places, type SearchMode } from "./backend/contracts";
import { toAppError } from "./backend/directory";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import NameDialog from "./NameDialog";
import NavBar from "./NavBar";
import OperationsPanel from "./OperationsPanel";
import Ribbon from "./Ribbon";
import Sidebar from "./Sidebar";
import StatusBar from "./StatusBar";
import TabReader from "./TabReader";
import TabSearcher from "./TabSearcher";
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
import { startTitle, type Clipboard } from "./operations/model";
import { useOperations } from "./operations/useOperations";
import { MAX_TABS, activeTab, initialTabsState, tabsReducer, type Tab } from "./explorer/tabs";

interface MenuState {
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
}

interface NameState {
  mode: "rename" | "new";
  entry: FileEntry;
  tabId: string;
  folderId: string;
  /** Set when renaming from a search list: the query whose list holds the item. */
  searchKey: number | null;
  error: string | null;
  busy: boolean;
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
  const [searchFocus, setSearchFocus] = useState(0);
  const scrollTops = useRef(new Map<string, number>());
  const stateRef = useRef(state);
  stateRef.current = state;
  const selectionRef = useRef<Selection>(emptySelection);
  const rowsRef = useRef<FileEntry[]>([]);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [nameState, setNameState] = useState<NameState | null>(null);

  // Reload only the tabs showing a changed folder; `reveal` selects an item in one tab.
  const reloadFolders = useCallback((folderIds: string[], reveal?: { tabId: string; id: string }) => {
    const changed = new Set(folderIds);
    for (const t of stateRef.current.tabs) {
      const here = hist.current(t.history);
      if (here && changed.has(here.id)) {
        dispatch({ type: "reload", tabId: t.id, reveal: reveal && reveal.tabId === t.id ? reveal.id : null });
      }
    }
  }, []);
  const operations = useOperations({
    onChanged: (affected) => {
      reloadFolders(affected);
      // A search list can contain moved or trashed items: run those searches again.
      for (const t of stateRef.current.tabs) {
        if (t.search) dispatch({ type: "search-start", tabId: t.id, query: t.search.query, mode: t.search.mode });
      }
    },
  });

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
  const search = tab?.search ?? null;
  const searching = search !== null;
  const hiddenCount = tab && !search ? tab.listing.entries.filter(isHidden).length : 0;
  const rows = useMemo(() => {
    if (!tab) return [];
    // Search results are shown as Spotlight reports them: an explicit query is not filtered by Hidden items.
    if (tab.search) return tab.search.status === "gathering" ? tab.search.entries : sortEntries(tab.search.entries, prefs.sort);
    const visible = prefs.showHidden ? tab.listing.entries : tab.listing.entries.filter((e) => !isHidden(e));
    return tab.listing.status === "loading" ? visible : sortEntries(visible, prefs.sort);
  }, [tab?.listing, tab?.search, prefs.showHidden, prefs.sort]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeId = tab?.id ?? null;

  // The selection as seen through the current filter: hidden items are never actionable.
  const selection = useMemo<Selection>(() => {
    if (!tab) return emptySelection;
    const sel = tab.selection;
    if (prefs.showHidden || tab.search) return sel;
    const visible = new Set(rows.map((r) => r.id));
    const ids = new Set([...sel.ids].filter((id) => visible.has(id)));
    const anchor = sel.anchor !== null && visible.has(sel.anchor) ? sel.anchor : null;
    const focus = sel.focus !== null && visible.has(sel.focus) ? sel.focus : null;
    return ids.size === sel.ids.size && anchor === sel.anchor && focus === sel.focus ? sel : { ids, anchor, focus };
  }, [tab?.selection, tab?.search, rows, prefs.showHidden]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const startSearch = useCallback((tabId: string, query: string, mode: SearchMode) => {
    dispatch({ type: "search-start", tabId, query, mode });
  }, []);
  const clearSearch = useCallback((tabId: string) => dispatch({ type: "search-clear", tabId }), []);

  // "Show containing folder": navigate to the result's real parent and select it there.
  const showContaining = useCallback((tabId: string, entry: FileEntry) => {
    call("parent_directory", { id: entry.id }).then(
      (parent) => {
        if (parent) dispatch({ type: "navigate", tabId, location: locationOf(parent), reveal: entry.id });
        else dispatch({ type: "action-error", tabId, error: toAppError("This item has no containing folder.", "show the containing folder") });
      },
      (reason) => dispatch({ type: "action-error", tabId, error: toAppError(reason, `show the folder of ${entry.name}`) }),
    );
  }, []);

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

  const selectedEntries = () => rowsRef.current.filter((e) => selectionRef.current.ids.has(e.id));

  const copySelection = (mode: Clipboard["mode"]) => {
    const ids = selectedEntries().map((e) => e.id);
    if (ids.length === 0) return;
    setClipboard({ mode, ids });
    setAnnouncement(`${ids.length} item${ids.length === 1 ? "" : "s"} ${mode === "copy" ? "copied" : "cut"}`);
  };

  const pasteHere = () => {
    const t = activeTab(stateRef.current);
    const here = t && hist.current(t.history);
    if (!t || !here || t.search || !clipboard || clipboard.ids.length === 0) return;
    const { mode, ids } = clipboard;
    operations.start({
      kind: mode === "cut" ? "move" : "copy",
      title: startTitle(mode === "cut" ? "move" : "copy", ids.length, here.name || "/"),
      itemCount: ids.length,
      originTabId: t.id,
      run: (taskId) => call("start_transfer", { taskId, moveItems: mode === "cut", sourceIds: ids, destinationId: here.id }),
    });
    if (mode === "cut") setClipboard(null);
  };

  const trashSelection = () => {
    const t = activeTab(stateRef.current);
    const ids = selectedEntries().map((e) => e.id);
    if (!t || ids.length === 0) return;
    operations.start({
      kind: "trash",
      title: startTitle("trash", ids.length),
      itemCount: ids.length,
      originTabId: t.id,
      run: (taskId) => call("trash_items", { taskId, ids }),
    });
  };

  const beginRename = () => {
    const t = activeTab(stateRef.current);
    const here = t && hist.current(t.history);
    const entries = selectedEntries();
    if (!t || !here || entries.length !== 1) return;
    setNameState({
      mode: "rename",
      entry: entries[0]!,
      tabId: t.id,
      folderId: here.id,
      searchKey: t.search?.key ?? null,
      error: null,
      busy: false,
    });
  };

  const newFolder = () => {
    const t = activeTab(stateRef.current);
    const here = t && hist.current(t.history);
    if (!t || !here || t.search) return;
    call("create_folder", { parentId: here.id, name: null }).then(
      (entry) => {
        reloadFolders([here.id], { tabId: t.id, id: entry.id });
        setNameState({ mode: "new", entry, tabId: t.id, folderId: here.id, searchKey: null, error: null, busy: false });
      },
      (reason) => dispatch({ type: "action-error", tabId: t.id, error: toAppError(reason, "create the folder") }),
    );
  };

  const submitName = (name: string) => {
    const current = nameState;
    if (!current) return;
    if (name === current.entry.name) {
      setNameState(null);
      return;
    }
    setNameState({ ...current, busy: true, error: null });
    call("rename_item", { id: current.entry.id, newName: name }).then(
      (entry) => {
        setNameState(null);
        if (current.searchKey !== null) {
          // The item stays where it was found: update the list and refresh its real folder.
          dispatch({ type: "search-replace", tabId: current.tabId, key: current.searchKey, removeId: current.entry.id, entry });
          call("parent_directory", { id: entry.id }).then(
            (parent) => parent && reloadFolders([parent.id]),
            () => undefined,
          );
        } else reloadFolders([current.folderId], { tabId: current.tabId, id: entry.id });
      },
      (reason) => setNameState({ ...current, busy: false, error: toAppError(reason, "rename the item").message }),
    );
  };

  // Cancelling the name of a new folder keeps its default name.
  const cancelName = () => setNameState(null);

  // Native menu actions arrive as ids on the menu event.
  const menuHandler = useRef<(id: string) => void>(() => {});
  menuHandler.current = (id) => {
    const t = activeTab(stateRef.current);
    // Native menu shortcuts must not hijack text editing.
    const el = document.activeElement as HTMLElement | null;
    const editing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    if (editing && (id === "copy" || id === "cut" || id === "paste")) {
      call("edit_action", { action: id }).catch(() => undefined);
      return;
    }
    if (editing && (id === "select-all" || id === "open")) {
      if (id === "select-all") (el as HTMLInputElement).select?.();
      return;
    }
    if (editing && (id === "trash" || id === "rename" || id === "new-folder")) return;
    if (nameState || operations.operations.some((op) => op.conflict)) return;
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
      case "search": return location ? setSearchFocus((n) => n + 1) : undefined;
      case "new-folder": return newFolder();
      case "copy": return copySelection("copy");
      case "cut": return copySelection("cut");
      case "paste": return pasteHere();
      case "rename": return beginRename();
      case "trash": return trashSelection();
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
      if (tab.search) {
        items.push({ label: "Show containing folder", onSelect: () => showContaining(tab.id, entry) });
      }
      items.push(
        { separator: true },
        { label: "Cut", shortcut: "⌘X", onSelect: () => copySelection("cut") },
        { label: "Copy", shortcut: "⌘C", onSelect: () => copySelection("copy") },
        { separator: true },
        { label: "Rename", shortcut: "F2", unavailable: selection.ids.size > 1, onSelect: beginRename },
        { label: "Move to the Trash", shortcut: "⌘⌫", onSelect: trashSelection },
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
          { label: "Paste", shortcut: "⌘V", unavailable: !clipboard || searching, onSelect: pasteHere },
          { label: "New folder", shortcut: "⇧⌘N", unavailable: !location || searching, onSelect: newFolder },
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
        canPaste={!!clipboard && !!location && !searching}
        canCreate={!!location && !searching}
        canRename={selection.ids.size === 1}
        onCopy={() => copySelection("copy")}
        onCut={() => copySelection("cut")}
        onPaste={pasteHere}
        onTrash={trashSelection}
        onRename={beginRename}
        onNewFolder={newFolder}
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
        search={search ? { query: search.query, mode: search.mode } : null}
        searchFocusRequest={searchFocus}
        onSearch={(query, mode) => tab && startSearch(tab.id, query.trim(), mode)}
        onClearSearch={() => tab && clearSearch(tab.id)}
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
          {state.tabs.map(
            (t) =>
              t.search && (
                <TabSearcher
                  key={t.id}
                  tabId={t.id}
                  searchKey={t.search.key}
                  scopeId={t.search.scopeId}
                  mode={t.search.mode}
                  query={t.search.query}
                  dispatch={dispatch}
                />
              ),
          )}
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
                  label={search ? `Search results in ${location?.name || "/"}` : location ? `Contents of ${location.name || "/"}` : "Folder contents"}
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
                  onRename={beginRename}
                  onRetry={() => dispatch({ type: "reload", tabId: tab.id })}
                  onBack={() => dispatch({ type: "back", tabId: tab.id })}
                  onDismissAction={() => dispatch({ type: "action-error", tabId: tab.id, error: null })}
                  onRetrySearch={() => search && startSearch(tab.id, search.query, search.mode)}
                  onClearSearch={() => clearSearch(tab.id)}
                />
              )}
            </div>
          )}
        </main>
      </div>
      <OperationsPanel
        operations={operations.operations}
        onCancel={operations.cancel}
        onResolve={operations.resolve}
        onDismiss={operations.dismiss}
      />
      <StatusBar
        total={rows.length}
        hidden={prefs.showHidden ? 0 : hiddenCount}
        selected={selection.ids.size}
        selectedBytes={selectedBytes}
        loading={search ? search.status === "gathering" : tab?.listing.status === "loading"}
        searchStatus={search && search.status !== "failed" ? "Spotlight search (best-effort)" : null}
        formatBytes={formatSize}
      />
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
      {nameState && (
        <NameDialog
          title={nameState.mode === "new" ? "Name the new folder" : "Rename"}
          initial={nameState.entry.name}
          confirmLabel={nameState.mode === "new" ? "Name folder" : "Rename"}
          error={nameState.error}
          busy={nameState.busy}
          onSubmit={submitName}
          onCancel={cancelName}
        />
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
