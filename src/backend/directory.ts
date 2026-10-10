import { listen } from "@tauri-apps/api/event";
import { call } from "./client";
import {
  DIRECTORY_EVENT,
  type AppError,
  type DirectoryEvent,
  type FileEntry,
  type ItemFailure,
} from "./contracts";

export interface DirectoryHandlers {
  onEntries(entries: FileEntry[], failures: ItemFailure[]): void;
  onFinished(summary: { entries: number; failed: number }): void;
  onFailed(error: AppError): void;
}

export interface DirectoryRead {
  /** Stops the read; no handler is called afterwards. Safe to call repeatedly. */
  cancel(): void;
}

let counter = 0;
function newReadId(): string {
  counter += 1;
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${counter}`;
  return `read-${random}`;
}

/** Narrows an unknown rejection to the backend's `AppError`, or wraps it. */
export function toAppError(error: unknown, operation = "complete the request"): AppError {
  if (error && typeof error === "object" && "category" in error && "message" in error) {
    return error as AppError;
  }
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "Unknown error";
  return { category: "io", operation, context: null, message };
}

/**
 * Starts reading a directory. Events are filtered by this read's id, so a read
 * that was replaced or cancelled can never deliver into newer state.
 */
export function readDirectory(id: string, handlers: DirectoryHandlers): DirectoryRead {
  const readId = newReadId();
  let active = true;
  let unlisten: (() => void) | null = null;
  const stop = () => {
    active = false;
    unlisten?.();
    unlisten = null;
  };

  const ready = listen<DirectoryEvent>(DIRECTORY_EVENT, ({ payload }) => {
    if (!active || payload.readId !== readId) return;
    switch (payload.type) {
      case "entries":
        handlers.onEntries(payload.entries, payload.failures);
        break;
      case "finished":
        stop();
        handlers.onFinished({ entries: payload.entries, failed: payload.failed });
        break;
      case "failed":
        stop();
        handlers.onFailed(payload.error);
        break;
      case "cancelled":
        stop();
        break;
    }
  });

  ready
    .then((fn) => {
      if (active) unlisten = fn;
      else fn();
      // Subscribe first so no event can be missed; skip the read if already cancelled.
      if (!active) return;
      return call("start_directory_read", { readId, id }).then(
        () => {
          // Cancelled while the start request was in flight: it may have registered late.
          if (!active) void call("cancel_directory_read", { readId }).catch(() => {});
        },
        (reason) => {
          if (!active) return;
          stop();
          handlers.onFailed(toAppError(reason, "read the folder"));
        },
      );
    })
    .catch((reason) => {
      if (!active) return;
      stop();
      handlers.onFailed(toAppError(reason, "read the folder"));
    });

  return {
    cancel() {
      if (!active) return;
      stop();
      // The backend may not know the read yet; cancel is idempotent either way.
      void ready.then(() => call("cancel_directory_read", { readId })).catch(() => {});
    },
  };
}
