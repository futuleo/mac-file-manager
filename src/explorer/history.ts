import type { Location } from "./path";

export interface History {
  items: Location[];
  index: number;
}

export const emptyHistory: History = { items: [], index: -1 };

export const current = (h: History): Location | null => h.items[h.index] ?? null;
export const canGoBack = (h: History) => h.index > 0;
export const canGoForward = (h: History) => h.index >= 0 && h.index < h.items.length - 1;

/** Visiting a new folder discards the forward entries; revisiting the current one adds nothing. */
export function push(h: History, location: Location): History {
  if (current(h)?.id === location.id) return h;
  const items = h.items.slice(0, h.index + 1);
  items.push(location);
  return { items, index: items.length - 1 };
}

export function back(h: History): History {
  return canGoBack(h) ? { ...h, index: h.index - 1 } : h;
}

export function forward(h: History): History {
  return canGoForward(h) ? { ...h, index: h.index + 1 } : h;
}
