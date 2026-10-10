export const ROW_HEIGHT = 24;
export const HEADER_HEIGHT = 26;
const OVERSCAN = 8;

export interface Range {
  start: number;
  end: number; // exclusive
}

/** Rows to mount for the body viewport; bounded by the viewport, not the item count. */
export function visibleRange(
  scrollTop: number,
  viewport: number,
  count: number,
  rowHeight = ROW_HEIGHT,
  overscan = OVERSCAN,
): Range {
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewport)) / rowHeight);
  return {
    start: Math.min(count, Math.max(0, first - overscan)),
    end: Math.min(count, last + overscan),
  };
}

/** The scrollTop that brings row `index` fully into the body viewport (unchanged if it already is). */
export function scrollTopFor(
  index: number,
  scrollTop: number,
  viewport: number,
  rowHeight = ROW_HEIGHT,
): number {
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewport) return Math.max(0, bottom - viewport);
  return scrollTop;
}
