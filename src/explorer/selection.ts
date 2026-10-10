import type { FileEntry } from "../backend/contracts";

export interface Selection {
  ids: ReadonlySet<string>;
  /** Start of shift-ranges. */
  anchor: string | null;
  /** The row with keyboard focus (and the `aria-activedescendant`). */
  focus: string | null;
}

export const emptySelection: Selection = { ids: new Set(), anchor: null, focus: null };

const indexOf = (rows: readonly FileEntry[], id: string | null) =>
  id === null ? -1 : rows.findIndex((r) => r.id === id);

export function selectOnly(id: string): Selection {
  return { ids: new Set([id]), anchor: id, focus: id };
}

export function toggle(sel: Selection, id: string): Selection {
  const ids = new Set(sel.ids);
  if (!ids.delete(id)) ids.add(id);
  return { ids, anchor: id, focus: id };
}

/** Selects the rows between the anchor and `id`; `additive` keeps the existing selection. */
export function extendTo(rows: readonly FileEntry[], sel: Selection, id: string, additive = false): Selection {
  const target = indexOf(rows, id);
  if (target < 0) return sel;
  let anchorIndex = indexOf(rows, sel.anchor);
  const anchor = anchorIndex < 0 ? id : sel.anchor!;
  if (anchorIndex < 0) anchorIndex = target;
  const [lo, hi] = anchorIndex < target ? [anchorIndex, target] : [target, anchorIndex];
  const ids = new Set(additive ? sel.ids : []);
  for (let i = lo; i <= hi; i += 1) ids.add(rows[i]!.id);
  return { ids, anchor, focus: id };
}

export type Movement = "up" | "down" | "home" | "end" | { page: number };

/** Keyboard movement. Without `extend` the selection collapses to the new row. */
export function move(rows: readonly FileEntry[], sel: Selection, movement: Movement, extend: boolean): Selection {
  if (rows.length === 0) return sel;
  const from = indexOf(rows, sel.focus);
  let to: number;
  if (movement === "home") to = 0;
  else if (movement === "end") to = rows.length - 1;
  else if (movement === "up") to = from < 0 ? 0 : from - 1;
  else if (movement === "down") to = from < 0 ? 0 : from + 1;
  else to = from < 0 ? (movement.page > 0 ? 0 : rows.length - 1) : from + movement.page;
  to = Math.min(rows.length - 1, Math.max(0, to));
  const id = rows[to]!.id;
  return extend ? extendTo(rows, sel, id) : selectOnly(id);
}

export function selectAll(rows: readonly FileEntry[], sel: Selection): Selection {
  if (rows.length === 0) return sel;
  const focus = indexOf(rows, sel.focus) >= 0 ? sel.focus : rows[0]!.id;
  return { ids: new Set(rows.map((r) => r.id)), anchor: sel.anchor ?? focus, focus };
}

export function invert(rows: readonly FileEntry[], sel: Selection): Selection {
  const ids = new Set(rows.filter((r) => !sel.ids.has(r.id)).map((r) => r.id));
  return { ids, anchor: sel.anchor, focus: sel.focus };
}

/** Drops identities that no longer exist (after a refresh). */
export function prune(sel: Selection, entries: readonly FileEntry[]): Selection {
  if (sel.ids.size === 0 && sel.focus === null && sel.anchor === null) return sel;
  const present = new Set(entries.map((e) => e.id));
  const ids = new Set([...sel.ids].filter((id) => present.has(id)));
  return {
    ids,
    anchor: sel.anchor !== null && present.has(sel.anchor) ? sel.anchor : null,
    focus: sel.focus !== null && present.has(sel.focus) ? sel.focus : null,
  };
}

/**
 * Rectangle (marquee) selection. `base` is the selection when the gesture started and
 * `band` the inclusive row indexes the rectangle currently touches.
 * - "replace" (no modifier): only the touched rows are selected.
 * - "add" (Shift): the touched rows are added to `base`.
 * - "toggle" (Command/Control): touched rows flip relative to `base`, as with ⌘-click.
 * Focus is left alone while dragging; `forward` says whether the pointer moved down the list.
 */
export type MarqueeMode = "replace" | "add" | "toggle";

export function marqueeSelection(
  rows: readonly FileEntry[],
  base: Selection,
  band: { first: number; last: number } | null,
  mode: MarqueeMode,
  forward: boolean,
): Selection {
  const touched: string[] = [];
  if (band) for (let i = band.first; i <= band.last; i += 1) touched.push(rows[i]!.id);
  const ids = new Set(mode === "replace" ? [] : base.ids);
  for (const id of touched) {
    if (mode === "toggle" && base.ids.has(id)) ids.delete(id);
    else ids.add(id);
  }
  const startSide = forward ? touched[0] : touched[touched.length - 1];
  return { ids, anchor: startSide ?? base.anchor, focus: base.focus };
}

export const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));
