import type {
  AppError,
  ConflictDecision,
  ProgressUnit,
  TaskEvent,
  TaskStage,
  TaskSummary,
} from "../backend/contracts";

export type OperationKind = "copy" | "move" | "trash";

export interface ConflictInfo {
  conflictId: string;
  sourceName: string;
  destinationName: string;
  sourceKind: "file" | "directory" | "other";
  destinationKind: "file" | "directory" | "other";
  sameItem: boolean;
}

export type OperationResult =
  | { state: "finished"; summary: TaskSummary }
  | { state: "cancelled"; summary: TaskSummary }
  | { state: "failed"; error: AppError };

export interface Operation {
  id: string;
  kind: OperationKind;
  title: string;
  itemCount: number;
  /** The tab the user started it from; used only to place the result message. */
  originTabId: string;
  stage: TaskStage;
  completed: number | null;
  total: number | null;
  unit: ProgressUnit;
  conflict: ConflictInfo | null;
  cancelling: boolean;
  result: OperationResult | null;
}

export type OperationAction =
  | { type: "add"; operation: Operation }
  | { type: "event"; event: TaskEvent }
  | { type: "cancelling"; id: string }
  | { type: "conflict-answered"; id: string }
  | { type: "start-failed"; id: string; error: AppError }
  | { type: "dismiss"; id: string };

export function newOperation(
  id: string,
  kind: OperationKind,
  title: string,
  itemCount: number,
  originTabId: string,
): Operation {
  return {
    id,
    kind,
    title,
    itemCount,
    originTabId,
    stage: "queued",
    completed: null,
    total: null,
    unit: "items",
    conflict: null,
    cancelling: false,
    result: null,
  };
}

function change(list: Operation[], id: string, edit: (op: Operation) => Operation): Operation[] {
  let touched = false;
  const next = list.map((op) => {
    if (op.id !== id || op.result) return op;
    touched = true;
    return edit(op);
  });
  return touched ? next : list;
}

/** Events for unknown or already finished operations are ignored. */
export function operationsReducer(list: Operation[], action: OperationAction): Operation[] {
  switch (action.type) {
    case "add":
      return [...list, action.operation];
    case "dismiss":
      return list.filter((op) => op.id !== action.id);
    case "cancelling":
      return change(list, action.id, (op) => ({ ...op, cancelling: true }));
    case "conflict-answered":
      return change(list, action.id, (op) => ({ ...op, conflict: null }));
    case "start-failed":
      return change(list, action.id, (op) => ({
        ...op,
        conflict: null,
        result: { state: "failed", error: action.error },
      }));
    case "event": {
      const event = action.event;
      return change(list, event.taskId, (op) => {
        switch (event.type) {
          case "progress":
            return {
              ...op,
              stage: event.stage,
              completed: event.completed,
              total: event.total,
              unit: event.unit,
            };
          case "conflict":
            return {
              ...op,
              conflict: {
                conflictId: event.conflictId,
                sourceName: event.sourceName,
                destinationName: event.destinationName,
                sourceKind: event.sourceKind,
                destinationKind: event.destinationKind,
                sameItem: event.sameItem,
              },
            };
          case "finished":
            return { ...op, conflict: null, result: { state: "finished", summary: event } };
          case "cancelled":
            return { ...op, conflict: null, result: { state: "cancelled", summary: event } };
          case "failed":
            return { ...op, conflict: null, result: { state: "failed", error: event.error } };
        }
      });
    }
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function startTitle(kind: OperationKind, count: number, destination?: string): string {
  const items = plural(count, "item");
  switch (kind) {
    case "copy":
      return `Copying ${items} to ${destination ?? "this folder"}`;
    case "move":
      return `Moving ${items} to ${destination ?? "this folder"}`;
    case "trash":
      return `Moving ${items} to the Trash`;
  }
}

const DONE = { copy: "Copied", move: "Moved", trash: "Moved to the Trash:" } as const;
const FAILED = { copy: "copied", move: "moved", trash: "moved to the Trash" } as const;

/** Honest, plain-language outcome of a task, including partial success. */
export function resultMessage(op: Operation): string {
  const result = op.result;
  if (!result) return op.title;
  if (result.state === "failed") return result.error.message;
  const { succeeded, skipped, failed, failedOmitted, partial } = result.summary;
  const failures = failed.length + failedOmitted;
  const parts: string[] = [];
  if (op.kind === "trash") parts.push(`${DONE.trash} ${plural(succeeded, "item")}.`);
  else parts.push(`${DONE[op.kind]} ${succeeded} of ${plural(op.itemCount, "item")}.`);
  if (skipped > 0) parts.push(`${plural(skipped, "item")} skipped.`);
  if (failures > 0) parts.push(`${plural(failures, "item")} could not be ${FAILED[op.kind]}.`);
  if (partial.length > 0) {
    parts.push(
      `${plural(partial.length, "folder")} ${partial.length === 1 ? "was" : "were"} only partly ${FAILED[op.kind]} and left in place; nothing was rolled back.`,
    );
  }
  if (result.state === "cancelled") parts.unshift("Cancelled.");
  if (result.state === "cancelled" && (succeeded > 0 || partial.length > 0)) {
    parts.push("Work that was already done was not undone.");
  }
  return parts.join(" ");
}

/** True when the result needs the user's attention (not a clean, complete success). */
export function needsAttention(op: Operation): boolean {
  const result = op.result;
  if (!result) return false;
  if (result.state !== "finished") return true;
  return result.summary.failed.length > 0 || result.summary.failedOmitted > 0 || result.summary.skipped > 0 || result.summary.partial.length > 0;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** Measured progress text, or null when the total is not known yet (never an invented percentage). */
export function progressText(op: Operation): string | null {
  if (op.stage === "scanning") return "Counting items…";
  if (op.completed === null || op.total === null) return null;
  if (op.unit === "bytes") return `${formatBytes(op.completed)} of ${formatBytes(op.total)}`;
  return `${op.completed} of ${plural(op.total, "item")}`;
}

/** App-internal clipboard: it is not shared with the system clipboard or other apps. */
export interface Clipboard {
  mode: "copy" | "cut";
  ids: string[];
}

export function conflictDescription(c: ConflictInfo): string {
  if (c.sameItem) return `"${c.destinationName}" is this same item. Keep both makes a numbered copy next to it.`;
  const kind = c.destinationKind === "directory" ? "folder" : c.destinationKind === "file" ? "file" : "item";
  return `A ${kind} named "${c.destinationName}" already exists here. Nothing is overwritten unless you choose Replace.`;
}

export function canReplace(c: ConflictInfo): boolean {
  return !c.sameItem && c.sourceKind !== "directory" && c.destinationKind !== "directory";
}

export type { ConflictDecision };
