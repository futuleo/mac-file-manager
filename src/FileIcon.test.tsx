// MOCKED IPC: Tauri `invoke` is replaced; this checks frontend icon policy only.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileIcon from "./FileIcon";
import { requestIcon, resetIconQueueForTests } from "./iconQueue";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const FOLDER_FILL = "#f7d55f";
const folderGlyph = (c: HTMLElement) => c.querySelector(`svg path[fill="${FOLDER_FILL}"]`);

beforeEach(() => {
  mocks.invoke.mockResolvedValue("data:image/png;base64,BLUE");
});
afterEach(() => {
  cleanup();
  resetIconQueueForTests();
  mocks.invoke.mockReset();
});

describe("FileIcon", () => {
  it("keeps folders as the yellow glyph and never requests a system icon", async () => {
    const { container } = render(<FileIcon id="d1" kind="directory" />);
    await act(async () => {});
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
    expect(folderGlyph(container)).not.toBeNull();
  });

  it("ignores a previously cached system icon for the same directory id", async () => {
    requestIcon("d2", 32, () => {});
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    await act(async () => {});
    mocks.invoke.mockClear();
    const { container } = render(<FileIcon id="d2" kind="directory" />);
    await act(async () => {});
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
    expect(folderGlyph(container)).not.toBeNull();
  });

  it("does not let a late async icon replace a folder glyph", async () => {
    let resolve: (u: string) => void = () => {};
    mocks.invoke.mockImplementation(() => new Promise<string>((r) => (resolve = r)));
    requestIcon("d3", 32, () => {}); // a lookup in flight from an earlier lifecycle
    const { container } = render(<FileIcon id="d3" kind="directory" />);
    await act(async () => resolve("data:blue"));
    expect(container.querySelector("img")).toBeNull();
    expect(folderGlyph(container)).not.toBeNull();
  });

  it("lazily loads file icons (no IntersectionObserver => immediately) and shows them", async () => {
    const { container } = render(<FileIcon id="f1" kind="file" />);
    await vi.waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,BLUE"));
    expect(mocks.invoke).toHaveBeenCalledWith("get_icon", { id: "f1", size: 32 });
  });

  it("defers file lookups until visible and cancels on unmount", async () => {
    let callback: IntersectionObserverCallback = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: IntersectionObserverCallback) {
          callback = cb;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    try {
      const { container, unmount } = render(<FileIcon id="f2" kind="file" />);
      await act(async () => {});
      expect(mocks.invoke).not.toHaveBeenCalled();
      await act(async () => callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
      await vi.waitFor(() => expect(container.querySelector("img")).not.toBeNull());
      unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not leak a file's system icon into a directory on kind or id transitions", async () => {
    const { container, rerender } = render(<FileIcon id="x" kind="file" />);
    await vi.waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    rerender(<FileIcon id="x" kind="directory" />);
    expect(container.querySelector("img")).toBeNull();
    expect(folderGlyph(container)).not.toBeNull();
    rerender(<FileIcon id="y" kind="directory" />);
    await act(async () => {});
    expect(container.querySelector("img")).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    rerender(<FileIcon id="x" kind="file" />);
    expect(container.querySelector("img")).not.toBeNull(); // cached file icon returns for a file
  });
});
