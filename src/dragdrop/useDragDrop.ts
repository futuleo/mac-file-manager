import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { call } from "../backend/client";
import { DRAG_EVENT, type DragEvent, type DragOperation } from "../backend/contracts";
import { toAppError } from "../backend/directory";

/** The view an incoming drag may act on. `nav` changes whenever the tab loads another listing. */
export interface DropContext {
  tabId: string;
  nav: number;
  /** The folder the tab shows; null while it has none or when it lists search results. */
  folderId: string | null;
  folderName: string;
}

export interface DropRequest {
  dragId: string;
  operation: DragOperation;
  count: number;
  tabId: string;
  targetName: string;
}

interface Options {
  context(): DropContext | null;
  /** Starts the transfer task for an accepted drop. */
  onDrop(request: DropRequest): void;
  /** A drop or drag that did nothing; must be shown, never swallowed. */
  onProblem(message: string, tabId: string | null): void;
  onSourceEnded(event: Extract<DragEvent, { type: "sourceEnded" }>): void;
  announce(message: string): void;
}

interface Target {
  key: string;
  folderId: string | null;
  name: string;
  tabId: string;
  nav: number;
  operation: DragOperation | null;
  reason: string | null;
  settled: boolean;
}

interface Active {
  dragId: string;
  count: number;
  target: Target | null;
}

const DROP_ATTRIBUTE = "data-drop-id";
const NAME_ATTRIBUTE = "data-drop-name";
const CURRENT = "current";

/** Folder row or sidebar place under the point, else the shown folder when over the content area. */
function targetAt(x: number, y: number, ctx: DropContext | null): { key: string; folderId: string | null; name: string } | null {
  const element = document.elementFromPoint?.(x, y) ?? null;
  const marked = element?.closest(`[${DROP_ATTRIBUTE}]`);
  if (marked) {
    return { key: marked.getAttribute(DROP_ATTRIBUTE) ?? "", folderId: marked.getAttribute(DROP_ATTRIBUTE), name: marked.getAttribute(NAME_ATTRIBUTE) ?? "" };
  }
  if (element?.closest(".tabpanel")) {
    return { key: CURRENT, folderId: ctx?.folderId ?? null, name: ctx?.folderName ?? "" };
  }
  return null;
}

/**
 * Follows native drags entering the window. The backend owns the dragged paths and the copy/move
 * choice; this hook only reports the folder under the pointer and starts the transfer once.
 * Any answer for a drag or target that is no longer current is dropped.
 */
export function useDragDrop(options: Options) {
  const opts = useRef(options);
  opts.current = options;
  const active = useRef<Active | null>(null);
  const [highlight, setHighlight] = useState<{ key: string; allowed: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;

    const clear = () => {
      active.current = null;
      setHighlight(null);
    };

    const over = (event: Extract<DragEvent, { type: "over" }>) => {
      const drag = active.current;
      if (!drag || drag.dragId !== event.dragId) return;
      const ctx = opts.current.context();
      const hit = ctx && targetAt(event.x, event.y, ctx);
      if (!ctx || !hit || hit.key === "" || (hit.key === CURRENT && !hit.folderId)) {
        if (drag.target) {
          drag.target = null;
          setHighlight(null);
          void call("drag_hover", { dragId: drag.dragId, destinationId: null }).catch(() => undefined);
        }
        return;
      }
      if (drag.target && drag.target.key === hit.key && drag.target.tabId === ctx.tabId && drag.target.nav === ctx.nav) return;
      const target: Target = { ...hit, tabId: ctx.tabId, nav: ctx.nav, operation: null, reason: null, settled: false };
      drag.target = target;
      setHighlight({ key: target.key, allowed: false });
      call("drag_hover", { dragId: drag.dragId, destinationId: target.folderId }).then(
        (verdict) => {
          if (active.current?.target !== target) return;
          target.operation = verdict.operation;
          target.reason = verdict.reason;
          target.settled = true;
          setHighlight({ key: target.key, allowed: verdict.operation !== null });
        },
        (reason) => {
          if (active.current?.target !== target) return;
          target.reason = toAppError(reason, "check the drop target").message;
          target.settled = true;
        },
      );
    };

    const drop = (event: Extract<DragEvent, { type: "drop" }>) => {
      const drag = active.current;
      clear();
      if (!drag || drag.dragId !== event.dragId) {
        if (event.accepted) void call("drag_discard", { dragId: event.dragId }).catch(() => undefined);
        return;
      }
      const ctx = opts.current.context();
      const target = drag.target;
      if (!event.accepted || !event.operation || !target) {
        opts.current.onProblem(
          target?.reason ?? "The items can't be dropped here. Drop them on a folder or on the open folder.",
          ctx?.tabId ?? null,
        );
        return;
      }
      if (!ctx || ctx.tabId !== target.tabId || ctx.nav !== target.nav) {
        void call("drag_discard", { dragId: drag.dragId }).catch(() => undefined);
        opts.current.onProblem("The view changed during the drop, so nothing was copied or moved.", ctx?.tabId ?? null);
        return;
      }
      opts.current.onDrop({
        dragId: drag.dragId,
        operation: event.operation,
        count: event.count,
        tabId: target.tabId,
        targetName: target.name,
      });
    };

    const subscription = listen<DragEvent>(DRAG_EVENT, ({ payload }) => {
      switch (payload.type) {
        case "enter":
          active.current = { dragId: payload.dragId, count: payload.count, target: null };
          opts.current.announce(`Dragging ${payload.count} item${payload.count === 1 ? "" : "s"}`);
          return;
        case "over":
          return over(payload);
        case "leave":
          if (active.current?.dragId === payload.dragId) clear();
          return;
        case "drop":
          return drop(payload);
        case "sourceEnded":
          return opts.current.onSourceEnded(payload);
      }
    });
    subscription.then(
      (fn) => (alive ? (unlisten = fn) : fn()),
      () => undefined,
    );
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return { highlight };
}

export const DROP_ATTRS = { id: DROP_ATTRIBUTE, name: NAME_ATTRIBUTE, current: CURRENT } as const;
