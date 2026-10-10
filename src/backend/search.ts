import { listen } from "@tauri-apps/api/event";
import { call } from "./client";
import { toAppError } from "./directory";
import {
  SEARCH_EVENT,
  type AppError,
  type FileEntry,
  type SearchEvent,
  type SearchMode,
  type SearchState,
} from "./contracts";

export interface SearchHandlers {
  onResults(entries: FileEntry[], skipped: number): void;
  onRemoved(ids: string[]): void;
  onState(state: SearchState): void;
  onLimited(limit: number): void;
  /** Terminal: the search failed (start, listener or native error). Never an empty success. */
  onFailed(error: AppError): void;
}

export interface SearchHandle {
  /** Stops the search and releases the native query; no handler is called afterwards. Idempotent. */
  cancel(): void;
}

let counter = 0;
function newSearchId(): string {
  counter += 1;
  return `search-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${counter}`}`;
}

/**
 * Starts a Spotlight search of a folder. The event listener is registered before the start
 * command, a listener error fails the search closed, and events are filtered by this search's
 * id so a cancelled or replaced search can never deliver into newer state.
 */
export function searchFolder(scopeId: string, mode: SearchMode, query: string, handlers: SearchHandlers): SearchHandle {
  const searchId = newSearchId();
  let active = true;
  let unlisten: (() => void) | null = null;
  const stop = () => {
    active = false;
    unlisten?.();
    unlisten = null;
  };
  const fail = (reason: unknown) => {
    if (!active) return;
    stop();
    void call("cancel_search", { searchId }).catch(() => {});
    handlers.onFailed(toAppError(reason, "search"));
  };

  const ready = listen<SearchEvent>(SEARCH_EVENT, ({ payload }) => {
    if (!active || payload.searchId !== searchId) return;
    switch (payload.type) {
      case "results":
        handlers.onResults(payload.entries, payload.skipped);
        break;
      case "removed":
        handlers.onRemoved(payload.ids);
        break;
      case "state":
        if (payload.state === "cancelled") stop();
        else handlers.onState(payload.state);
        break;
      case "limited":
        handlers.onLimited(payload.limit);
        break;
      case "failed":
        stop();
        handlers.onFailed(payload.error);
        break;
    }
  });

  ready
    .then((fn) => {
      if (active) unlisten = fn;
      else fn();
      if (!active) return;
      return call("start_search", { searchId, scopeId, mode, query }).then(
        () => {
          if (!active) void call("cancel_search", { searchId }).catch(() => {});
        },
        fail,
      );
    })
    .catch(fail);

  return {
    cancel() {
      if (!active) return;
      stop();
      void ready.then(() => call("cancel_search", { searchId })).catch(() => {});
    },
  };
}
