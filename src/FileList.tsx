import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "./backend/contracts";
import FileIcon from "./FileIcon";
import { SortGlyph } from "./glyphs";
import { COLUMN_LIMITS, type ColumnWidths } from "./explorer/preferences";
import {
  extendTo,
  marqueeSelection,
  move,
  sameIds,
  selectAll,
  selectOnly,
  toggle,
  type MarqueeMode,
  type Movement,
  type Selection,
} from "./explorer/selection";
import { formatDate, formatEntrySize, typeLabel, type SortKey, type SortState } from "./explorer/sort";
import { HEADER_HEIGHT, ROW_HEIGHT, rowsInBand, scrollTopFor, visibleRange } from "./explorer/virtual";

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
  onQuickLook(): void;
  /** Search results come from many folders, so each row also shows its containing folder. */
  showLocation?: boolean;
}

/** Pointer travel before a press on empty space becomes a rectangle selection. */
const MARQUEE_THRESHOLD = 4;
/** Distance from a scroll edge where autoscroll starts, and its speed bounds (px per tick). */
const AUTOSCROLL_EDGE = 20;
const AUTOSCROLL_MIN = 2;
const AUTOSCROLL_MAX = 40;
const AUTOSCROLL_TICK_MS = 16;

interface MarqueeGesture {
  /**
   * `restore` puts the pre-gesture selection back but keeps the gesture until the button is released;
   * `commit` finalizes focus and ends it (`released`: the mouse-up that follows a drag); `drop` just ends it.
   */
  end(how: "commit" | "restore" | "drop", released?: boolean): void;
  /** Recomputes the rectangle after the list scrolled under a stationary pointer. */
  refresh(): void;
}

interface MarqueeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const edgeSpeed = (depth: number) => Math.min(AUTOSCROLL_MAX, AUTOSCROLL_MIN + Math.max(0, depth) / 2);

/** Display-only parent of an entry's path. */
function containingFolder(entry: FileEntry): string {
  const cut = entry.path.lastIndexOf("/");
  return cut <= 0 ? "/" : entry.path.slice(0, cut);
}

function FileList(props: Props) {
  const { rows, selection, sort, columns } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(props.initialScrollTop);
  const [viewport, setViewport] = useState(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const onSelectRef = useRef(props.onSelect);
  onSelectRef.current = props.onSelect;
  const gesture = useRef<MarqueeGesture | null>(null);
  const suppressClick = useRef(false);
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null);

  // A gesture never outlives the list it started on (refresh, sort, new results) or the component.
  useEffect(() => () => gesture.current?.end("drop"), []);
  useEffect(() => {
    gesture.current?.end("drop");
  }, [rows]);

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
    if (event.key === " " && !cmd && !event.shiftKey) {
      event.preventDefault();
      props.onQuickLook();
    } else if (event.key === "F2" && !cmd) {
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

  const startMarquee = (event: React.MouseEvent<HTMLDivElement>) => {
    gesture.current?.end("commit");
    const el = scroller.current;
    const target = event.target as HTMLElement;
    if (!el || event.button !== 0 || event.ctrlKey || target.closest(".header")) return;
    const emptySpace =
      target === el || target.classList.contains("body") || target.classList.contains("empty") || target.classList.contains("filler");
    if (!emptySpace) return;
    const box = el.getBoundingClientRect();
    // Presses on the scrollbars belong to the scrollbars.
    if (event.clientX >= box.left + el.clientWidth || event.clientY >= box.top + el.clientHeight) return;

    event.preventDefault();
    el.focus();
    const mode: MarqueeMode = event.shiftKey ? "add" : event.metaKey ? "toggle" : "replace";
    const base = selectionRef.current;
    const toContent = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      return { x: cx - r.left + el.scrollLeft, y: cy - r.top + el.scrollTop - HEADER_HEIGHT };
    };
    const origin = toContent(event.clientX, event.clientY);
    let pointer = { x: event.clientX, y: event.clientY };
    let active = false;
    let latest = base;
    let far: string | null = null;
    let cancelled = false;
    suppressClick.current = false;

    const update = () => {
      if (cancelled) return;
      const now = toContent(pointer.x, pointer.y);
      if (!active) {
        if (Math.hypot(now.x - origin.x, now.y - origin.y) < MARQUEE_THRESHOLD) return;
        active = true;
      }
      const list = rowsRef.current;
      const band = rowsInBand(origin.y, now.y, list.length);
      const forward = now.y >= origin.y;
      far = band ? list[forward ? band.last : band.first]!.id : null;
      const next = marqueeSelection(list, base, band, mode, forward);
      if (!sameIds(next.ids, latest.ids) || next.anchor !== latest.anchor) {
        latest = next;
        onSelectRef.current(next);
      }
      const maxX = el.scrollWidth;
      const maxY = el.scrollHeight - HEADER_HEIGHT;
      const x0 = Math.max(0, Math.min(origin.x, now.x));
      const x1 = Math.min(maxX, Math.max(origin.x, now.x));
      const y0 = Math.max(0, Math.min(origin.y, now.y));
      const y1 = Math.min(maxY, Math.max(origin.y, now.y));
      setMarquee({ left: x0, top: y0 + HEADER_HEIGHT, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) });
    };

    const autoscroll = () => {
      if (!active || cancelled) return;
      const r = el.getBoundingClientRect();
      const top = r.top + HEADER_HEIGHT;
      const bottom = r.top + el.clientHeight;
      const right = r.left + el.clientWidth;
      let dx = 0;
      let dy = 0;
      if (pointer.y < top + AUTOSCROLL_EDGE) dy = -edgeSpeed(top + AUTOSCROLL_EDGE - pointer.y);
      else if (pointer.y > bottom - AUTOSCROLL_EDGE) dy = edgeSpeed(pointer.y - (bottom - AUTOSCROLL_EDGE));
      if (pointer.x < r.left + AUTOSCROLL_EDGE) dx = -edgeSpeed(r.left + AUTOSCROLL_EDGE - pointer.x);
      else if (pointer.x > right - AUTOSCROLL_EDGE) dx = edgeSpeed(pointer.x - (right - AUTOSCROLL_EDGE));
      if (dx === 0 && dy === 0) return;
      const before = { x: el.scrollLeft, y: el.scrollTop };
      el.scrollLeft = Math.max(0, before.x + dx);
      el.scrollTop = Math.max(0, before.y + dy);
      if (el.scrollLeft !== before.x || el.scrollTop !== before.y) {
        // Scroll events may lag a tick; keep the virtual window in step directly.
        setScrollTop(el.scrollTop);
        props.onScrollTop(el.scrollTop);
        update();
      }
    };

    const onMove = (e: MouseEvent) => {
      if (e.buttons === 0) return end("commit", true); // the release happened outside the window
      pointer = { x: e.clientX, y: e.clientY };
      update();
    };
    const onUp = () => end("commit", true);
    const onDown = () => end("commit");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !cancelled) {
        e.preventDefault();
        e.stopPropagation();
        end("restore");
      }
    };
    const onBlur = () => end("commit");
    const timer = window.setInterval(autoscroll, AUTOSCROLL_TICK_MS);

    function end(how: "commit" | "restore" | "drop", released = false) {
      if (gesture.current !== handle) return;
      if (how === "restore") {
        if (!active || cancelled) return;
        cancelled = true;
        active = false;
        setMarquee(null);
        onSelectRef.current(base);
        return;
      }
      gesture.current = null;
      window.clearInterval(timer);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      setMarquee(null);
      if (released && (active || cancelled)) {
        // Only the click that this very release produces is swallowed, not later ones.
        suppressClick.current = true;
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      }
      if (how === "drop" || !active) return;
      if (far !== null && rowsRef.current.some((r) => r.id === far)) {
        onSelectRef.current({ ...latest, focus: far });
      }
    }
    const handle: MarqueeGesture = { end, refresh: update };
    gesture.current = handle;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
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
      gesture.current?.refresh();
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
          {props.showLocation && <span className="location">{containingFolder(entry)}</span>}
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
      onMouseDown={startMarquee}
      onClickCapture={(e) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          e.stopPropagation();
        }
      }}
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
      {marquee && <div className="marquee" aria-hidden="true" style={marquee} />}
      {props.emptyMessage && (
        <p className="empty" role="status">
          {props.emptyMessage}
        </p>
      )}
    </div>
  );
}

export default memo(FileList);
