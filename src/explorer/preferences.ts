import { defaultSort, type SortState } from "./sort";

/** Presentation preferences only. Paths, history and search text are never stored. */
export interface Preferences {
  sort: SortState;
  showHidden: boolean;
  columns: ColumnWidths;
}

export interface ColumnWidths {
  name: number;
  modified: number;
  type: number;
  size: number;
}

export const COLUMN_LIMITS = { min: 60, max: 800 };
export const defaultColumns: ColumnWidths = { name: 320, modified: 150, type: 140, size: 90 };
export const defaultPreferences: Preferences = { sort: defaultSort, showHidden: false, columns: defaultColumns };

const KEY = "explorer.preferences.v1";

const clampWidth = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(COLUMN_LIMITS.max, Math.max(COLUMN_LIMITS.min, Math.round(value)))
    : fallback;

/** Validates untrusted stored data field by field, falling back to defaults. */
export function parsePreferences(raw: string | null): Preferences {
  if (!raw) return defaultPreferences;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return defaultPreferences;
  }
  if (!data || typeof data !== "object") return defaultPreferences;
  const d = data as Record<string, unknown>;
  const sort = d.sort as Partial<SortState> | undefined;
  const cols = (d.columns ?? {}) as Record<string, unknown>;
  return {
    sort: {
      key: ["name", "modified", "type", "size"].includes(sort?.key as string)
        ? (sort!.key as SortState["key"])
        : defaultSort.key,
      direction: sort?.direction === "desc" ? "desc" : "asc",
    },
    showHidden: d.showHidden === true,
    columns: {
      name: clampWidth(cols.name, defaultColumns.name),
      modified: clampWidth(cols.modified, defaultColumns.modified),
      type: clampWidth(cols.type, defaultColumns.type),
      size: clampWidth(cols.size, defaultColumns.size),
    },
  };
}

export function loadPreferences(): Preferences {
  try {
    return parsePreferences(globalThis.localStorage?.getItem(KEY) ?? null);
  } catch {
    return defaultPreferences;
  }
}

export function savePreferences(preferences: Preferences): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(preferences));
  } catch {
    // Storage may be unavailable; preferences then simply last for this session.
  }
}
