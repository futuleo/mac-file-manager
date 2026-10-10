import PlatformPanel from "./PlatformPanel";

interface Props {
  total: number;
  hidden: number;
  selected: number;
  selectedBytes: number | null;
  loading: boolean;
  /** Set while a Spotlight search is shown: a short, honest status. */
  searchStatus?: string | null;
  formatBytes(bytes: number): string;
}

export default function StatusBar({ total, hidden, selected, selectedBytes, loading, formatBytes, searchStatus }: Props) {
  const items = `${total} item${total === 1 ? "" : "s"}`;
  return (
    <footer className="statusbar">
      <span>
        {items}
        {hidden > 0 ? ` (${hidden} hidden)` : ""}
        {loading ? " — loading…" : ""}
      </span>
      {searchStatus && <span>{searchStatus}</span>}
      {selected > 0 && (
        <span>
          {selected} selected{selectedBytes !== null && selectedBytes > 0 ? ` ${formatBytes(selectedBytes)}` : ""}
        </span>
      )}
      <span className="spacer" />
      <PlatformPanel />
    </footer>
  );
}
