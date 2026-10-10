import type { FileEntry } from "../backend/contracts";

export type SortKey = "name" | "modified" | "type" | "size";
export type SortDirection = "asc" | "desc";
export interface SortState {
  key: SortKey;
  direction: SortDirection;
}

export const defaultSort: SortState = { key: "name", direction: "asc" };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "";
}

/** Windows-style type description, derived only from metadata we really have. */
export function typeLabel(entry: FileEntry): string {
  if (entry.isBrokenLink) return "Broken link";
  const link = entry.isSymlink ? " (link)" : "";
  if (entry.kind === "directory") return `File folder${link}`;
  if (entry.kind === "other") return `Other${link}`;
  const ext = extensionOf(entry.name);
  return `${ext ? `${ext.toUpperCase()} File` : "File"}${link}`;
}

function byName(a: FileEntry, b: FileEntry): number {
  // Collator ties (case or accent variants) fall back to code units, then the unique id.
  return (
    collator.compare(a.name, b.name) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Unknown values sort after known ones in either direction. */
function compareKnown(a: number | null, b: number | null, sign: number): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a === b ? 0 : (a < b ? -1 : 1) * sign;
}

/**
 * A new sorted array: folders always group first (as in Explorer), then the
 * chosen key, with the name and id as deterministic tie-breakers.
 */
export function sortEntries(entries: readonly FileEntry[], sort: SortState): FileEntry[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  const type = new Map<FileEntry, string>();
  const typeOf = (e: FileEntry) => {
    let t = type.get(e);
    if (t === undefined) type.set(e, (t = typeLabel(e)));
    return t;
  };
  const group = (e: FileEntry) => (e.kind === "directory" ? 0 : 1);
  return [...entries].sort((a, b) => {
    const grouped = group(a) - group(b);
    if (grouped) return grouped;
    let primary = 0;
    if (sort.key === "name") primary = byName(a, b) * sign;
    else if (sort.key === "modified") primary = compareKnown(a.modifiedMs, b.modifiedMs, sign);
    else if (sort.key === "size") primary = compareKnown(a.size, b.size, sign);
    else primary = collator.compare(typeOf(a), typeOf(b)) * sign;
    // Ties keep a stable ascending name order regardless of direction.
    return primary || byName(a, b);
  });
}

export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key !== key) return { key, direction: key === "modified" ? "desc" : "asc" };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

export const isHidden = (entry: FileEntry) => entry.name.startsWith(".");

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

export const UNKNOWN = "Unknown";

export function formatDate(ms: number | null): string {
  if (ms === null) return UNKNOWN;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? UNKNOWN : dateFormat.format(date);
}

/** Folders and other items have no size; a regular file without one is unknown. */
export function formatEntrySize(entry: FileEntry): string {
  if (entry.kind !== "file") return "";
  return entry.size === null ? UNKNOWN : formatSize(entry.size);
}

export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
