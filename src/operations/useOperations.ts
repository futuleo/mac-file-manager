import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { call } from "../backend/client";
import { TASK_EVENT, type ConflictDecision, type TaskEvent } from "../backend/contracts";
import { toAppError } from "../backend/directory";
import {
  newOperation,
  operationsReducer,
  type Operation,
  type OperationKind,
} from "./model";

let counter = 0;
const newTaskId = () => {
  counter += 1;
  return `task-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${counter}`}`;
};

export interface StartRequest {
  kind: OperationKind;
  title: string;
  itemCount: number;
  originTabId: string;
  /** Issues the backend command for this task id. */
  run(taskId: string): Promise<void>;
}

interface Options {
  /** Called once per terminal event with the folder ids whose contents changed. */
  onChanged(affected: string[], op: Operation): void;
}

/**
 * Tracks file-operation tasks. One listener receives every task event; each event is
 * matched to its task by id, so events of other tasks, finished tasks and closed tabs
 * can never change unrelated state.
 */
export function useOperations({ onChanged }: Options) {
  const [operations, dispatch] = useReducer(operationsReducer, [] as Operation[]);
  const known = useRef(new Map<string, Operation>());
  known.current = new Map(operations.map((op) => [op.id, op]));
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const ready = useRef<Promise<unknown>>(Promise.resolve());
  const meta = useRef(new Map<string, Operation>());

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    const subscription = listen<TaskEvent>(TASK_EVENT, ({ payload }) => {
      const op = meta.current.get(payload.taskId);
      if (!op) return;
      dispatch({ type: "event", event: payload });
      if (payload.type === "finished" || payload.type === "cancelled") {
        meta.current.delete(payload.taskId);
        changed.current(payload.affected, op);
      } else if (payload.type === "failed") {
        meta.current.delete(payload.taskId);
      }
    });
    ready.current = subscription.then(
      (fn) => (active ? (unlisten = fn) : fn()),
      () => undefined,
    );
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const start = useCallback((request: StartRequest): string => {
    const id = newTaskId();
    const op = newOperation(id, request.kind, request.title, request.itemCount, request.originTabId);
    meta.current.set(id, op);
    dispatch({ type: "add", operation: op });
    // Subscribed before the command runs, so the first event cannot be missed.
    void ready.current.then(() => request.run(id)).catch((reason) => {
      meta.current.delete(id);
      dispatch({ type: "start-failed", id, error: toAppError(reason, request.title) });
    });
    return id;
  }, []);

  const cancel = useCallback((id: string) => {
    dispatch({ type: "cancelling", id });
    call("cancel_task", { taskId: id }).catch(() => undefined);
  }, []);

  const resolve = useCallback(
    (id: string, conflictId: string, decision: ConflictDecision, applyToAll: boolean) => {
      dispatch({ type: "conflict-answered", id });
      call("resolve_conflict", { conflictId, decision, applyToAll }).catch((reason) =>
        dispatch({ type: "start-failed", id, error: toAppError(reason, "resolve the conflict") }),
      );
    },
    [],
  );

  const dismiss = useCallback((id: string) => dispatch({ type: "dismiss", id }), []);

  return { operations, start, cancel, resolve, dismiss };
}
