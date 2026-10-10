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
  onRename(): void;
  onRetry(): void;
  onBack(): void;
  onDismissAction(): void;
  onRetrySearch(): void;
  onClearSearch(): void;
}

const MAX_LISTED_FAILURES = 50;

function SearchBanner({ search, scopeName, onClear }: { search: NonNullable<Tab["search"]>; scopeName: string; onClear(): void }) {
  const what = search.mode === "content" ? "file contents" : "file names";
  const caveat =
    "Spotlight results are best-effort: recently created or changed files may not be indexed yet, some file types are not searchable by content, and entries may be stale.";
  return (
    <div className="search-banner" role="status">
      <strong>
        {search.status === "gathering" ? "Searching" : "Showing"} {what} for “{search.query}” in {scopeName}
        {search.status === "gathering" ? "…" : ""}
      </strong>{" "}
      <span>
        {search.status === "gathering"
          ? "Results appear as Spotlight reports them."
          : search.status === "limited"
            ? "This search has ended and is no longer updated."
            : "Spotlight keeps this list up to date until you clear the search."}{" "}
        {search.skipped > 0 &&
          `${search.skipped} match${search.skipped === 1 ? "" : "es"} were left out because the item no longer exists or could not be read. `}
        {search.limit !== null && `Stopped after ${search.limit} results; the list is incomplete. Narrow the search to see more. `}
        {caveat}
      </span>{" "}
      <button type="button" className="banner-dismiss" onClick={onClear}>
        Clear search
      </button>
    </div>
  );
}

function ErrorView({ error, onRetry, onBack, canGoBack, title = "This folder can't be shown" }: { error: AppError; onRetry(): void; onBack(): void; canGoBack: boolean; title?: string }) {
  return (
    <div className="error-view" role="alert">
      <WarnGlyph size={32} />
      <div>
        <p className="error-title">{title}</p>
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
  const { listing, search } = tab;
  const [showFailures, setShowFailures] = useState(false);

  let emptyMessage: string | null = null;
  if (search) {
    if (rows.length === 0) {
      emptyMessage =
        search.status === "gathering"
          ? "Searching…"
          : "Spotlight reported no matches. That does not prove nothing matches: the folder may not be indexed or the files may be too new.";
    }
  } else if (rows.length === 0) {
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
      {search && search.status !== "failed" && (
        <SearchBanner search={search} scopeName={props.label.replace(/^Contents of /, "")} onClear={props.onClearSearch} />
      )}
      {!search && listing.failures.length > 0 && listing.status !== "failed" && (
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
      {search?.status === "failed" && search.error ? (
        <ErrorView
          title="The search could not run"
          error={search.error}
          onRetry={props.onRetrySearch}
          onBack={props.onClearSearch}
          canGoBack
        />
      ) : !search && listing.status === "failed" ? (
        <ErrorView error={listing.error} onRetry={props.onRetry} onBack={props.onBack} canGoBack={props.canGoBack} />
      ) : (
        <FileList
          rows={rows}
          label={props.label}
          busy={search ? search.status === "gathering" : listing.status === "loading"}
          showLocation={!!search}
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
          onRename={props.onRename}
        />
      )}
    </div>
  );
}
