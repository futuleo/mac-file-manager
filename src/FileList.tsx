import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "./backend/contracts";
import FileIcon from "./FileIcon";
import { SortGlyph } from "./glyphs";
import { COLUMN_LIMITS, type ColumnWidths } from "./explorer/preferences";
import { extendTo, move, selectAll, selectOnly, toggle, type Movement, type Selection } from "./explorer/selection";
import { formatDate, formatEntrySize, typeLabel, type SortKey, type SortState } from "./explorer/sort";
import { HEADER_HEIGHT, ROW_HEIGHT, scrollTopFor, visibleRange } from "./explorer/virtual";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "modified", label: "Date modified" },
  { key: "type", label: "Type" },
  { key: "size", label: "Size" },
];

/** Used when the viewport cannot be measured (it has no layout yet). */
const FALLBACK_VIEWPORT = 600;

interface Props {
  rows: readonly FileEntry[];
  label: string;
  busy: boolean;
  emptyMessage: string | null;
  selection: Selection;
  sort: SortState;
  columns: ColumnWidths;
  initialScrollTop: number;
  onScrollTop(scrollTop: number): void;
  onSort(key: SortKey): void;
  onColumns(columns: ColumnWidths): void;
  onSelect(selection: Selection): void;
  onActivate(entry: FileEntry): void;
  onContextMenu(entry: FileEntry | null, x: number, y: number): void;
  onRename(): void;
}

function FileList(props: Props) {
  const { rows, selection, sort, columns } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(props.initialScrollTop);
  const [viewport, setViewport] = useState(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = props.initialScrollTop;
    // Only the first mount restores the position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const bodyViewport = Math.max(0, (viewport || FALLBACK_VIEWPORT) - HEADER_HEIGHT);
  const range = useMemo(
    () => visibleRange(scrollTop, bodyViewport, rows.length),
    [scrollTop, bodyViewport, rows.length],
  );

  // Keep the focused row on screen after keyboard movement or a reveal.
  useEffect(() => {
    const el = scroller.current;
    if (!el || selection.focus === null) return;
    const index = rowsRef.current.findIndex((r) => r.id === selection.focus);
    if (index < 0) return;
    const next = scrollTopFor(index, el.scrollTop, Math.max(0, (el.clientHeight || FALLBACK_VIEWPORT) - HEADER_HEIGHT));
    if (next !== el.scrollTop) {
      el.scrollTop = next;
      setScrollTop(next);
      props.onScrollTop(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.focus]);

  const template = `${columns.name}px ${columns.modified}px ${columns.type}px ${columns.size}px 1fr`;
  const width = columns.name + columns.modified + columns.type + columns.size;

  const focusIndex = selection.focus === null ? -1 : rows.findIndex((r) => r.id === selection.focus);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.altKey || event.target !== event.currentTarget) return;
    const cmd = event.metaKey || event.ctrlKey;
    const pageRows = Math.max(1, Math.floor(bodyViewport / ROW_HEIGHT) - 1);
    let movement: Movement | null = null;
    switch (event.key) {
      case "ArrowDown":
        if (cmd) return; // Command+Down is a native menu shortcut family; leave it alone
        movement = "down";
        break;
      case "ArrowUp":
        if (cmd) return;
        movement = "up";
        break;
      case "Home":
        movement = "home";
        break;
      case "End":
        movement = "end";
        break;
      case "PageDown":
        movement = { page: pageRows };
        break;
      case "PageUp":
        movement = { page: -pageRows };
        break;
    }
    if (movement) {
      event.preventDefault();
      props.onSelect(move(rows, selection, movement, event.shiftKey));
      return;
    }
    if (event.key === "F2" && !cmd) {
      event.preventDefault();
      props.onRename();
    } else if (event.key === "Enter" && !cmd) {
      const entry = focusIndex >= 0 ? rows[focusIndex] : undefined;
      if (entry) {
        event.preventDefault();
        props.onActivate(entry);
      }
    } else if (event.key === "Escape") {
      if (selection.ids.size > 0) {
        event.preventDefault();
        props.onSelect({ ids: new Set(), anchor: null, focus: selection.focus });
      }
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      props.onSelect(selectAll(rows, selection));
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const el = scroller.current?.getBoundingClientRect();
      const entry = focusIndex >= 0 ? rows[focusIndex] : null;
      const y = el ? el.top + HEADER_HEIGHT + Math.max(0, (focusIndex + 1) * ROW_HEIGHT - (scroller.current?.scrollTop ?? 0)) : 0;
      props.onContextMenu(entry ?? null, (el?.left ?? 0) + 40, y);
    }
  };

  const clickRow = (event: React.MouseEvent, entry: FileEntry) => {
    scroller.current?.focus();
    if (event.shiftKey) props.onSelect(extendTo(rows, selection, entry.id, event.metaKey));
    else if (event.metaKey) props.onSelect(toggle(selection, entry.id));
    else props.onSelect(selectOnly(entry.id));
  };

  const contextRow = (event: React.MouseEvent, entry: FileEntry | null) => {
    event.preventDefault();
    event.stopPropagation();
    scroller.current?.focus();
    if (entry && !selection.ids.has(entry.id)) props.onSelect(selectOnly(entry.id));
    if (!entry && selection.ids.size > 0) props.onSelect({ ids: new Set(), anchor: null, focus: selection.focus });
    props.onContextMenu(entry, event.clientX, event.clientY);
  };

  const startResize = (key: SortKey, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = columns[key];
    const onMove = (e: MouseEvent) =>
      props.onColumns({
        ...columns,
        [key]: Math.min(COLUMN_LIMITS.max, Math.max(COLUMN_LIMITS.min, Math.round(startWidth + e.clientX - startX))),
      });
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const keyResize = (key: SortKey, event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 40 : 10;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const delta = event.key === "ArrowRight" ? step : -step;
    props.onColumns({
      ...columns,
      [key]: Math.min(COLUMN_LIMITS.max, Math.max(COLUMN_LIMITS.min, columns[key] + delta)),
    });
  };

  const setScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const top = event.currentTarget.scrollTop;
      setScrollTop(top);
      props.onScrollTop(top);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.onScrollTop],
  );

  const mounted = [];
  for (let i = range.start; i < range.end; i += 1) {
    const entry = rows[i]!;
    const selected = selection.ids.has(entry.id);
    mounted.push(
      <div
        key={entry.id}
        id={`row-${i}`}
        role="row"
        aria-rowindex={i + 2}
        aria-selected={selected}
        className={`row${selected ? " selected" : ""}${entry.id === selection.focus ? " focused" : ""}`}
        style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT, gridTemplateColumns: template, minWidth: width }}
        title={entry.isBrokenLink ? `${entry.path} (broken link: its target cannot be found)` : entry.path}
        onClick={(e) => clickRow(e, entry)}
        onDoubleClick={() => props.onActivate(entry)}
        onContextMenu={(e) => contextRow(e, entry)}
      >
        <div role="gridcell" className="cell name">
          <FileIcon id={entry.id} kind={entry.kind} />
          <span className="label">{entry.name}</span>
        </div>
        <div role="gridcell" className="cell">
          {formatDate(entry.modifiedMs)}
        </div>
        <div role="gridcell" className="cell">
          {typeLabel(entry)}
        </div>
        <div role="gridcell" className="cell size">
          {formatEntrySize(entry)}
        </div>
        <div role="gridcell" className="cell filler" />
      </div>,
    );
  }

  return (
    <div
      ref={scroller}
      className="grid"
      role="grid"
      tabIndex={0}
      aria-label={props.label}
      aria-rowcount={rows.length + 1}
      aria-colcount={4}
      aria-multiselectable="true"
      aria-busy={props.busy}
      aria-activedescendant={focusIndex >= range.start && focusIndex < range.end ? `row-${focusIndex}` : undefined}
      onScroll={setScroll}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => contextRow(e, null)}
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("body")) {
          props.onSelect({ ids: new Set(), anchor: null, focus: selection.focus });
        }
      }}
    >
      <div
        role="row"
        aria-rowindex={1}
        className="header"
        style={{ gridTemplateColumns: template, minWidth: width, height: HEADER_HEIGHT }}
      >
        {COLUMNS.map(({ key, label }) => (
          <div
            key={key}
            role="columnheader"
            className="column"
            aria-sort={sort.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
          >
            <button
              type="button"
              className="column-button"
              aria-label={`Sort by ${label}`}
              onClick={() => props.onSort(key)}
            >
              <span>{label}</span>
              {sort.key === key && <SortGlyph direction={sort.direction} />}
            </button>
            <span
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize ${label} column`}
              aria-valuenow={columns[key]}
              aria-valuemin={COLUMN_LIMITS.min}
              aria-valuemax={COLUMN_LIMITS.max}
              tabIndex={0}
              className="resizer"
              onMouseDown={(e) => startResize(key, e)}
              onKeyDown={(e) => keyResize(key, e)}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        ))}
        <div className="column filler" />
      </div>
      <div className="body" style={{ height: rows.length * ROW_HEIGHT, minWidth: width }}>
        {mounted}
      </div>
      {props.emptyMessage && (
        <p className="empty" role="status">
          {props.emptyMessage}
        </p>
      )}
    </div>
  );
}

export default memo(FileList);
