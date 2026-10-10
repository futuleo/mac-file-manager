import FileIcon from "./FileIcon";
import type { Place, Places } from "./backend/contracts";
import type { AppError } from "./backend/contracts";
import { locationOf, type Location } from "./explorer/path";

interface Props {
  places: Places | null;
  error: AppError | null;
  currentPath: string | null;
  onOpen(location: Location): void;
  onContextMenu(location: Location, x: number, y: number): void;
}

function Section({ title, items, props }: { title: string; items: Place[]; props: Props }) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title}>
      <h2>{title}</h2>
      <ul>
        {items.map((place) => {
          const location = locationOf(place.entry);
          const current = props.currentPath === place.entry.path;
          return (
            <li key={place.entry.id}>
              <button
                type="button"
                className={`place${current ? " current" : ""}`}
                aria-current={current ? "page" : undefined}
                title={place.entry.path}
                onClick={() => props.onOpen(location)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  props.onContextMenu(location, e.clientX, e.clientY);
                }}
              >
                <FileIcon id={place.entry.id} kind="directory" />
                <span className="label">{place.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function Sidebar(props: Props) {
  const { places, error } = props;
  const quick = places?.places.filter((p) => p.group === "quick") ?? [];
  const volumes = places?.places.filter((p) => p.group === "volume") ?? [];
  return (
    <nav className="sidebar" aria-label="Locations">
      {!places && !error && <p role="status" className="side-note">Loading locations…</p>}
      {error && (
        <p role="alert" className="side-note error">
          Locations are unavailable: {error.message}
        </p>
      )}
      <Section title="Quick access" items={quick} props={props} />
      <Section title="This Mac" items={volumes} props={props} />
      {places && places.failures.length > 0 && (
        <details className="side-note error" role="alert">
          <summary>
            {places.failures.length} location{places.failures.length === 1 ? "" : "s"} could not be read
          </summary>
          <ul>
            {places.failures.map((f, i) => (
              <li key={`${f.id}-${i}`}>{f.error.message}</li>
            ))}
          </ul>
        </details>
      )}
    </nav>
  );
}
