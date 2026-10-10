import PlatformPanel from "./PlatformPanel";

interface Props {
  total: number;
  hidden: number;
  selected: number;
  selectedBytes: number | null;
  loading: boolean;
  formatBytes(bytes: number): string;
}

export default function StatusBar({ total, hidden, selected, selectedBytes, loading, formatBytes }: Props) {
  const items = `${total} item${total === 1 ? "" : "s"}`;
  return (
    <footer className="statusbar">
      <span>
        {items}
        {hidden > 0 ? ` (${hidden} hidden)` : ""}
        {loading ? " — loading…" : ""}
      </span>
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
