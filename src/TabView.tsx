import { useState } from "react";
import type { AppError, FileEntry } from "./backend/contracts";
import FileList from "./FileList";
import { WarnGlyph } from "./glyphs";
import type { ColumnWidths } from "./explorer/preferences";
import type { Selection } from "./explorer/selection";
import type { SortKey, SortState } from "./explorer/sort";
import type { Tab } from "./explorer/tabs";

interface Props {
  tab: Tab;
  selection: Selection;
  rows: readonly FileEntry[];
  label: string;
  sort: SortState;
  columns: ColumnWidths;
  canGoBack: boolean;
  initialScrollTop: number;
  onScrollTop(scrollTop: number): void;
  onSort(key: SortKey): void;
  onColumns(columns: ColumnWidths): void;
  onSelect(selection: Selection): void;
  onActivate(entry: FileEntry): void;
  onContextMenu(entry: FileEntry | null, x: number, y: number): void;
  onRetry(): void;
  onBack(): void;
  onDismissAction(): void;
}

const MAX_LISTED_FAILURES = 50;

function ErrorView({ error, onRetry, onBack, canGoBack }: { error: AppError; onRetry(): void; onBack(): void; canGoBack: boolean }) {
  return (
    <div className="error-view" role="alert">
      <WarnGlyph size={32} />
      <div>
        <p className="error-title">This folder can't be shown</p>
        <p className="error-message">{error.message}</p>
        <p className="error-actions">
          <button type="button" className="command" onClick={onRetry}>
            Try again
          </button>
          {canGoBack && (
            <button type="button" className="command" onClick={onBack}>
              Go back
            </button>
          )}
        </p>
      </div>
    </div>
  );
}

/** The folder area of one tab: states, per-item failures, action errors and the file list. */
export default function TabView(props: Props) {
  const { tab, rows } = props;
  const { listing } = tab;
  const [showFailures, setShowFailures] = useState(false);

  let emptyMessage: string | null = null;
  if (rows.length === 0) {
    if (listing.status === "loading") emptyMessage = "Loading…";
    else if (listing.status === "ready") {
      if (listing.entries.length > 0) emptyMessage = "This folder only contains hidden items. Turn on Hidden items in the View tab to see them.";
      else if (listing.failures.length === 0) emptyMessage = "This folder is empty.";
      else emptyMessage = "None of the items in this folder could be read.";
    }
  }

  return (
    <div className="tab-view">
      {tab.actionError && (
        <div role="alert" className="banner error">
          <WarnGlyph />
          <span>{tab.actionError.message}</span>
          <button type="button" className="banner-dismiss" onClick={props.onDismissAction}>
            Dismiss
          </button>
        </div>
      )}
      {listing.failures.length > 0 && listing.status !== "failed" && (
        <div role="alert" className="banner warning">
          <WarnGlyph />
          <span>
            {listing.failures.length} item{listing.failures.length === 1 ? "" : "s"} could not be read completely.
          </span>
          <button type="button" className="banner-dismiss" aria-expanded={showFailures} onClick={() => setShowFailures((v) => !v)}>
            {showFailures ? "Hide details" : "Show details"}
          </button>
          {showFailures && (
            <ul>
              {listing.failures.slice(0, MAX_LISTED_FAILURES).map((f, i) => (
                <li key={`${f.id}-${i}`}>{f.error.message}</li>
              ))}
              {listing.failures.length > MAX_LISTED_FAILURES && (
                <li>…and {listing.failures.length - MAX_LISTED_FAILURES} more.</li>
              )}
            </ul>
          )}
        </div>
      )}
      {listing.status === "failed" ? (
        <ErrorView error={listing.error} onRetry={props.onRetry} onBack={props.onBack} canGoBack={props.canGoBack} />
      ) : (
        <FileList
          rows={rows}
          label={props.label}
          busy={listing.status === "loading"}
          emptyMessage={emptyMessage}
          selection={props.selection}
          sort={props.sort}
          columns={props.columns}
          initialScrollTop={props.initialScrollTop}
          onScrollTop={props.onScrollTop}
          onSort={props.onSort}
          onColumns={props.onColumns}
          onSelect={props.onSelect}
          onActivate={props.onActivate}
          onContextMenu={props.onContextMenu}
        />
      )}
    </div>
  );
}
