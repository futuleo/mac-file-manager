import { memo, useEffect } from "react";
import { searchFolder } from "./backend/search";
import type { SearchMode } from "./backend/contracts";
import type { TabAction } from "./explorer/tabs";

interface Props {
  tabId: string;
  /** Identifies one query of the tab; a new key (or unmounting) cancels the previous one. */
  searchKey: number;
  scopeId: string;
  mode: SearchMode;
  query: string;
  dispatch: (action: TabAction) => void;
}

/**
 * Owns the one native Spotlight query of a tab. Navigating, clearing or closing the tab
 * unmounts this component, which cancels the query and releases the listener; results carry
 * `searchKey` so the reducer ignores anything from an earlier query.
 */
function TabSearcher({ tabId, searchKey: key, scopeId, mode, query, dispatch }: Props) {
  useEffect(() => {
    const search = searchFolder(scopeId, mode, query, {
      onResults: (entries, skipped) => dispatch({ type: "search-results", tabId, key, entries, skipped }),
      onRemoved: (ids) => dispatch({ type: "search-removed", tabId, key, ids }),
      onState: (state) => dispatch({ type: "search-state", tabId, key, state: state === "live" ? "live" : "gathering" }),
      onLimited: (limit) => dispatch({ type: "search-limited", tabId, key, limit }),
      onFailed: (error) => dispatch({ type: "search-failed", tabId, key, error }),
    });
    return () => search.cancel();
  }, [tabId, key, scopeId, mode, query, dispatch]);
  return null;
}

export default memo(TabSearcher);
