import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { call } from "../backend/client";
import { DRAG_EVENT, type DragEvent, type DragOperation } from "../backend/contracts";
import { toAppError } from "../backend/directory";

/** The view an incoming drag may act on. */
export interface DropContext {
  tabId: string;
  /** Changes whenever the tab loads another listing. */
  nav: number;
  /** Changes when the tab starts, replaces or clears a search, which swaps the list without a navigation. */
  view: string;
  /** The folder the tab shows; null while it has none or when it lists search results. */
  folderId: string | null;
  folderName: string;
}

export interface DropRequest {
  operation: DragOperation;
  count: number;
  tabId: string;
  targetName: string;
  /**
   * Claims the drop for the transfer task. Re-checks the visible context at claim time, because the
   * task may start after the drop event; a changed view discards the drop and rejects.
   */
  run(taskId: string): Promise<void>;
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
  /** The `drag_hover` request number; only the verdict and drop carrying it count. */
  token: number;
  pointer: number;
  key: string;
  folderId: string | null;
  name: string;
  ctx: DropContext;
  operation: DragOperation | null;
  reason: string | null;
  settled: boolean;
}

interface Active {
  dragId: string;
  count: number;
  target: Target | null;
  token: number;
  busy: boolean;
  /** A rejected hover request was already shown for this drag. */
  reported: boolean;
  latest: Extract<DragEvent, { type: "over" }> | null;
}

const VIEW_CHANGED = "The view changed during the drop, so nothing was copied or moved.";

function sameView(a: DropContext, b: DropContext, key: string): boolean {
  return a.tabId === b.tabId && a.nav === b.nav && a.view === b.view && (key !== CURRENT || a.folderId === b.folderId);
}

const DROP_ATTRIBUTE = "data-drop-id";
const NAME_ATTRIBUTE = "data-drop-name";
const CURRENT = "current";
const NO_CONTEXT: DropContext = { tabId: "", nav: -1, view: "", folderId: null, folderName: "" };

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

    // A rejected request for the current pointer update is final for that update: it is settled
    // (so it is not asked again until the pointer sends newer input) and shown once per drag.
    const fail = (drag: Active, target: Target, reason: unknown) => {
      target.reason = toAppError(reason, "check the drop target").message;
      target.operation = null;
      target.settled = true;
      setHighlight(target.key ? { key: target.key, allowed: false } : null);
      if (!drag.reported) {
        drag.reported = true;
        opts.current.onProblem(target.reason, target.ctx.tabId || null);
      }
    };

    const settle = (drag: Active) => {
      drag.busy = false;
      pump(drag);
    };

    // One hover request per drag at a time; every pointer update gets a fresh verdict, so a drop is
    // only ever accepted for the exact update whose target was validated.
    const pump = (drag: Active) => {
      const event = drag.latest;
      if (active.current !== drag || drag.busy || !event) return;
      if (drag.target?.settled && drag.target.pointer === event.pointer) return;
      const ctx = opts.current.context();
      const hit = ctx && targetAt(event.x, event.y, ctx);
      const valid = !!ctx && !!hit && hit.key !== "" && !(hit.key === CURRENT && !hit.folderId);
      if (!valid) {
        const target: Target = { token: ++drag.token, pointer: event.pointer, key: "", folderId: null, name: "", ctx: ctx ?? NO_CONTEXT, operation: null, reason: null, settled: false };
        drag.target = target;
        setHighlight(null);
        drag.busy = true;
        call("drag_hover", { dragId: drag.dragId, pointer: event.pointer, token: target.token, destinationId: null }).then(
          () => {
            if (active.current === drag && drag.target === target) target.settled = true;
            settle(drag);
          },
          (reason) => {
            if (active.current === drag && drag.target === target) fail(drag, target, reason);
            settle(drag);
          },
        );
        return;
      }
      const target: Target = { ...hit, token: ++drag.token, pointer: event.pointer, ctx, operation: null, reason: null, settled: false };
      drag.target = target;
      setHighlight({ key: target.key, allowed: false });
      drag.busy = true;
      call("drag_hover", { dragId: drag.dragId, pointer: event.pointer, token: target.token, destinationId: target.folderId }).then(
        (verdict) => {
          if (active.current === drag && drag.target === target && verdict.token === target.token) {
            target.operation = verdict.operation;
            target.reason = verdict.reason;
            target.settled = true;
            setHighlight({ key: target.key, allowed: verdict.operation !== null });
          }
          settle(drag);
        },
        (reason) => {
          if (active.current === drag && drag.target === target) fail(drag, target, reason);
          settle(drag);
        },
      );
    };

    const over = (event: Extract<DragEvent, { type: "over" }>) => {
      const drag = active.current;
      if (!drag || drag.dragId !== event.dragId) return;
      drag.latest = event;
      pump(drag);
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
      if (!event.accepted || !event.operation || event.token === null) {
        opts.current.onProblem(
          target?.reason ?? "The items can't be dropped here. Drop them on a folder or on the open folder.",
          ctx?.tabId ?? null,
        );
        return;
      }
      const discard = () => void call("drag_discard", { dragId: drag.dragId }).catch(() => undefined);
      const token = event.token;
      if (!target || !target.settled || target.token !== token || !target.folderId || !ctx || !sameView(ctx, target.ctx, target.key)) {
        discard();
        opts.current.onProblem(VIEW_CHANGED, ctx?.tabId ?? null);
        return;
      }
      const destinationId = target.folderId;
      opts.current.onDrop({
        operation: event.operation,
        count: event.count,
        tabId: target.ctx.tabId,
        targetName: target.name,
        run: async (taskId) => {
          const now = opts.current.context();
          if (!now || !sameView(now, target.ctx, target.key)) {
            discard();
            throw { category: "cancelled", operation: "drag and drop", context: null, message: VIEW_CHANGED };
          }
          await call("drag_drop_transfer", { taskId, dragId: drag.dragId, token, destinationId });
        },
      });
    };

    const subscription = listen<DragEvent>(DRAG_EVENT, ({ payload }) => {
      switch (payload.type) {
        case "enter":
          active.current = { dragId: payload.dragId, count: payload.count, target: null, token: 0, busy: false, reported: false, latest: null };
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
