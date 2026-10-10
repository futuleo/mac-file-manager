import { useState } from "react";
import type { SortKey, SortState } from "./explorer/sort";

interface Props {
  canOpen: boolean;
  canSelect: boolean;
  hasSelection: boolean;
  showHidden: boolean;
  sort: SortState;
  onOpen(): void;
  onSelectAll(): void;
  onSelectNone(): void;
  onInvert(): void;
  onShowHidden(show: boolean): void;
  onSort(sort: SortState): void;
}

const UNAVAILABLE = "Not available yet";

function Command({ label, onClick, disabled, unavailable }: { label: string; onClick?: () => void; disabled?: boolean; unavailable?: boolean }) {
  return (
    <button
      type="button"
      className={`command${unavailable ? " unavailable" : ""}`}
      disabled={unavailable || disabled}
      title={unavailable ? UNAVAILABLE : undefined}
      aria-label={unavailable ? `${label} (${UNAVAILABLE.toLowerCase()})` : undefined}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="ribbon-group">
      <div className="ribbon-commands">{children}</div>
      <div className="ribbon-label" aria-hidden="true">
        {label}
      </div>
    </div>
  );
}

/** Ribbon-inspired command area. Only commands that really work are enabled. */
export default function Ribbon(props: Props) {
  const [tab, setTab] = useState<"home" | "view">("home");
  return (
    <div className="ribbon">
      <div role="tablist" aria-label="Ribbon" className="ribbon-tabs">
        {(["home", "view"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`ribbon-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`ribbon-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? "active" : undefined}
            onClick={() => setTab(id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                const next = id === "home" ? "view" : "home";
                setTab(next);
                document.getElementById(`ribbon-tab-${next}`)?.focus();
              }
            }}
          >
            {id === "home" ? "Home" : "View"}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`ribbon-panel-${tab}`} aria-labelledby={`ribbon-tab-${tab}`} className="ribbon-panel">
        {tab === "home" ? (
          <>
            <Group label="Clipboard">
              <Command label="Copy" unavailable />
              <Command label="Cut" unavailable />
              <Command label="Paste" unavailable />
            </Group>
            <Group label="Organize">
              <Command label="Move to" unavailable />
              <Command label="Delete" unavailable />
              <Command label="Rename" unavailable />
            </Group>
            <Group label="New">
              <Command label="New folder" unavailable />
            </Group>
            <Group label="Open">
              <Command label="Open" disabled={!props.canOpen} onClick={props.onOpen} />
            </Group>
            <Group label="Select">
              <Command label="Select all" disabled={!props.canSelect} onClick={props.onSelectAll} />
              <Command label="Select none" disabled={!props.hasSelection} onClick={props.onSelectNone} />
              <Command label="Invert selection" disabled={!props.canSelect} onClick={props.onInvert} />
            </Group>
          </>
        ) : (
          <>
            <Group label="Layout">
              <button type="button" className="command" aria-pressed="true" disabled title="Details is the only layout so far">
                Details
              </button>
            </Group>
            <Group label="Current view">
              <label className="field">
                Sort by
                <select
                  value={props.sort.key}
                  onChange={(e) => props.onSort({ ...props.sort, key: e.target.value as SortKey })}
                >
                  <option value="name">Name</option>
                  <option value="modified">Date modified</option>
                  <option value="type">Type</option>
                  <option value="size">Size</option>
                </select>
              </label>
              <label className="field">
                Order
                <select
                  value={props.sort.direction}
                  onChange={(e) => props.onSort({ ...props.sort, direction: e.target.value as SortState["direction"] })}
                >
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select>
              </label>
            </Group>
            <Group label="Show/hide">
              <label className="check">
                <input type="checkbox" checked={props.showHidden} onChange={(e) => props.onShowHidden(e.target.checked)} />
                Hidden items
              </label>
            </Group>
          </>
        )}
      </div>
    </div>
  );
}
