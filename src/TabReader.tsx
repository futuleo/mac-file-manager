import { memo, useEffect } from "react";
import { readDirectory } from "./backend/directory";
import type { TabAction } from "./explorer/tabs";

interface Props {
  tabId: string;
  locationId: string | null;
  nav: number;
  dispatch: (action: TabAction) => void;
}

/**
 * Owns the one directory read of a tab. A new navigation or refresh (`nav`) cancels the
 * previous read, and closing the tab unmounts this component, which cancels it and
 * releases its event listener. Results are tagged with `nav`, so a late event from an
 * older navigation is ignored by the reducer even if it were delivered.
 */
function TabReader({ tabId, locationId, nav, dispatch }: Props) {
  useEffect(() => {
    if (!locationId) return;
    const read = readDirectory(locationId, {
      onEntries: (entries, failures) => dispatch({ type: "entries", tabId, nav, entries, failures }),
      onFinished: () => dispatch({ type: "finished", tabId, nav }),
      onFailed: (error) => dispatch({ type: "failed", tabId, nav, error }),
    });
    return () => read.cancel();
  }, [tabId, locationId, nav, dispatch]);
  return null;
}

export default memo(TabReader);
