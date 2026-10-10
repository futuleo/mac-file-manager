// Rectangle selection in FileList. jsdom has no layout, so geometry is faked: the grid sits at
// (0,0), is 400px wide and 400px tall (a 26px header leaves 374px of rows). These tests cover the
// gesture logic only; real pointer, hit-testing and scrolling are exercised in the native app.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "./backend/contracts";
import FileList from "./FileList";
import { emptySelection, selectOnly, type Selection } from "./explorer/selection";

const HEADER = 26;
const ROW = 24;
const file = (i: number): FileEntry => ({
  id: `id${String(i).padStart(5, "0")}`,
  path: `/t/f${i}.txt`,
  name: `f${i}.txt`,
  kind: "file",
  size: 1,
  modifiedMs: 1,
  isSymlink: false,
  isBrokenLink: false,
});
const make = (n: number) => Array.from({ length: n }, (_, i) => file(i));

let latest: Selection = emptySelection;
const changes: Selection[] = [];

function Host({ rows, initial = emptySelection }: { rows: FileEntry[]; initial?: Selection }) {
  const [selection, setSelection] = useState(initial);
  latest = selection;
  return (
    <FileList
      rows={rows}
      label="files"
      busy={false}
      emptyMessage={null}
      selection={selection}
      sort={{ key: "name", direction: "asc" }}
      columns={{ name: 200, modified: 100, type: 50, size: 50 }}
      initialScrollTop={0}
      onScrollTop={() => {}}
      onSort={() => {}}
      onColumns={() => {}}
      onSelect={(s) => {
        changes.push(s);
        setSelection(s);
      }}
      onActivate={() => {}}
      onContextMenu={() => {}}
      onRename={() => {}}
      onQuickLook={() => {}}
    />
  );
}

const grid = () => screen.getByRole("grid");
const ids = (...n: number[]) => n.map((i) => file(i).id).sort();
const selected = () => [...latest.ids].sort();
// client y of the top of body row `i` plus an offset inside it
const yOf = (i: number, within = 5) => HEADER + i * ROW + within;

function fakeGeometry(el: HTMLElement) {
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400, x: 0, y: 0, toJSON() {} });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: 385 }); // 15px scrollbar
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: 400 });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 10_000 });
}
const press = (target: Element, x: number, y: number, init: MouseEventInit = {}) =>
  fireEvent.mouseDown(target, { button: 0, buttons: 1, clientX: x, clientY: y, ...init });
const move = (x: number, y: number) => fireEvent.mouseMove(window, { buttons: 1, clientX: x, clientY: y });
const release = (x = 0, y = 0) => fireEvent.mouseUp(window, { clientX: x, clientY: y });

function mount(n = 10, initial?: Selection) {
  const view = render(<Host rows={make(n)} initial={initial} />);
  fakeGeometry(grid());
  return view;
}

beforeEach(() => {
  latest = emptySelection;
  changes.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("marquee selection", () => {
  it("selects the rows a drag from empty space touches and keeps them after release", () => {
    mount();
    // Starts in blank space right of the 400px of rows? rows fill, so start on the grid itself
    press(grid(), 300, yOf(9) + 40);
    move(300, yOf(7));
    expect(selected()).toEqual(ids(7, 8, 9));
    move(300, yOf(5));
    expect(selected()).toEqual(ids(5, 6, 7, 8, 9));
    move(300, yOf(8)); // shrinking deselects
    expect(selected()).toEqual(ids(8, 9));
    release();
    expect(selected()).toEqual(ids(8, 9));
    expect(latest.focus).toBe(file(8).id);
    expect(grid().querySelector(".marquee")).toBeNull();
  });

  it("does not treat the release as a click that clears the selection", () => {
    mount();
    press(grid(), 300, yOf(9) + 40);
    move(300, yOf(6));
    release();
    fireEvent.click(grid());
    expect(selected()).toEqual(ids(6, 7, 8, 9));
  });

  it("starts from a row's trailing filler cell and a plain click there still selects the row", () => {
    mount();
    const filler = screen.getByText("f2.txt").closest('[role="row"]')!.querySelector(".filler")!;
    press(filler, 380, yOf(2));
    fireEvent.mouseUp(window);
    fireEvent.click(filler);
    expect(selected()).toEqual(ids(2));
    press(filler, 380, yOf(2));
    move(380, yOf(4));
    release();
    expect(selected()).toEqual(ids(2, 3, 4));
  });

  it("ignores presses on rows, the header, scrollbars, other buttons and Control-click", () => {
    mount();
    press(screen.getByText("f3.txt"), 10, yOf(3));
    move(10, yOf(6));
    expect(changes).toEqual([]);
    release();
    press(screen.getByLabelText("Sort by Name"), 10, 10);
    move(10, yOf(6));
    press(grid(), 392, yOf(9) + 40); // inside the vertical scrollbar
    move(300, yOf(5));
    press(grid(), 300, yOf(9) + 40, { button: 2 });
    move(300, yOf(5));
    press(grid(), 300, yOf(9) + 40, { ctrlKey: true });
    move(300, yOf(5));
    expect(changes).toEqual([]);
  });

  it("needs a few pixels of travel before it replaces the selection", () => {
    mount(10, selectOnly(file(1).id));
    press(grid(), 300, yOf(9) + 40);
    move(301, yOf(9) + 41);
    release();
    expect(changes).toEqual([]);
    fireEvent.click(grid()); // an ordinary empty-space click clears it, as before
    expect(selected()).toEqual([]);
  });

  it("Shift adds to the existing selection and Command toggles it", () => {
    mount(10, selectOnly(file(0).id));
    press(grid(), 300, yOf(9) + 40, { shiftKey: true });
    move(300, yOf(8));
    release();
    expect(selected()).toEqual(ids(0, 8, 9));

    cleanup();
    mount(10, { ids: new Set(ids(0, 1, 9)), anchor: file(0).id, focus: file(0).id });
    press(grid(), 300, yOf(9) + 40, { metaKey: true });
    move(300, yOf(8));
    expect(selected()).toEqual(ids(0, 1, 8)); // 9 flipped off, 8 flipped on
    move(300, yOf(9)); // back over a single row
    expect(selected()).toEqual(ids(0, 1));
    release();
  });

  it("selection of a plain drag replaces the old selection, even with nothing touched", () => {
    mount(3, selectOnly(file(0).id));
    press(grid(), 300, yOf(8));
    move(300, yOf(7));
    expect(selected()).toEqual([]);
    release();
  });

  it("Escape cancels and restores the selection from before the drag", () => {
    mount(10, selectOnly(file(0).id));
    press(grid(), 300, yOf(9) + 40);
    move(300, yOf(5));
    expect(selected()).toEqual(ids(5, 6, 7, 8, 9));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(selected()).toEqual(ids(0));
    move(300, yOf(3));
    release();
    expect(selected()).toEqual(ids(0));
    expect(grid().querySelector(".marquee")).toBeNull();
  });

  it("a release outside the window (no buttons held) ends the gesture", () => {
    mount();
    press(grid(), 300, yOf(9) + 40);
    move(300, yOf(7));
    fireEvent.mouseMove(window, { buttons: 0, clientX: 300, clientY: yOf(2) });
    expect(selected()).toEqual(ids(7, 8, 9));
    move(300, yOf(2));
    expect(selected()).toEqual(ids(7, 8, 9));
  });

  it("a replaced list or unmount drops the gesture without touching selection", () => {
    const { rerender, unmount } = mount();
    press(grid(), 300, yOf(9) + 40);
    move(300, yOf(7));
    expect(selected()).toEqual(ids(7, 8, 9));
    const before = changes.length;
    rerender(<Host rows={make(10)} />);
    move(300, yOf(1));
    expect(changes.length).toBe(before);
    expect(grid().querySelector(".marquee")).toBeNull();
    unmount();
    move(300, yOf(1));
    release();
    expect(changes.length).toBe(before);
  });

  it("finds rows that are not mounted and autoscrolls at the edges of a virtualized list", () => {
    vi.useFakeTimers();
    render(<Host rows={make(5000)} />);
    const el = grid();
    fakeGeometry(el);
    expect(screen.queryByText("f40.txt")).toBeNull();
    press(el, 300, yOf(0));
    move(300, 395); // bottom edge
    act(() => {
      vi.advanceTimersByTime(16 * 100);
    });
    expect(el.scrollTop).toBeGreaterThan(24 * 20);
    const top = Math.floor((el.scrollTop + 370) / ROW);
    // everything from the first row down to the row under the pointer is selected, mounted or not
    expect(latest.ids.size).toBeGreaterThan(20);
    expect(latest.ids.has(file(0).id)).toBe(true);
    expect(latest.ids.has(file(top - 1).id) || latest.ids.has(file(top).id)).toBe(true);
    expect(screen.getAllByRole("row").length).toBeLessThan(80);
    // returning the pointer to the middle stops scrolling
    move(300, 120);
    const stopped = el.scrollTop;
    act(() => {
      vi.advanceTimersByTime(16 * 10);
    });
    expect(el.scrollTop).toBe(stopped);
    release();
    expect(latest.focus).not.toBeNull();
  });

  it("autoscroll upward stops at the top and the timer ends with the gesture", () => {
    vi.useFakeTimers();
    render(<Host rows={make(5000)} />);
    const el = grid();
    fakeGeometry(el);
    fireEvent.scroll(el, { target: { scrollTop: 480 } });
    press(el, 300, yOf(0));
    move(300, HEADER); // top edge of the body
    act(() => {
      vi.advanceTimersByTime(16 * 100);
    });
    expect(el.scrollTop).toBe(0);
    release();
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
