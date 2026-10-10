import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppError } from "./backend/contracts";
import { BackGlyph, ChevronGlyph, ForwardGlyph, RefreshGlyph, UpGlyph } from "./glyphs";
import { ancestors, type Location } from "./explorer/path";

interface Props {
  location: Location | null;
  /** Label for `/` when known (the startup volume's name). */
  rootLabel: string | null;
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
  error: AppError | null;
  busy: boolean;
  /** Increment to start editing the address (⌘L). */
  focusRequest: number;
  onBack(): void;
  onForward(): void;
  onUp(): void;
  onRefresh(): void;
  onNavigate(location: Location): void;
  /** Validates and navigates; resolves true when the address was accepted. */
  onSubmit(text: string): Promise<boolean>;
  onDismissError(): void;
}

export default function NavBar(props: Props) {
  const { location, error } = props;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const crumbs = useRef<HTMLOListElement>(null);

  // Each edit session has an id; a submission may only close the session that started it.
  const session = useRef(0);
  const seenFocusRequest = useRef(props.focusRequest);

  const startEditing = () => {
    session.current += 1;
    setText(location?.path ?? "");
    setEditing(true);
  };

  useEffect(() => {
    if (props.focusRequest !== seenFocusRequest.current) {
      seenFocusRequest.current = props.focusRequest;
      startEditing();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusRequest]);

  useLayoutEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  useLayoutEffect(() => {
    const el = crumbs.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [location?.id, editing]);

  const submit = async () => {
    const started = session.current;
    const accepted = await props.onSubmit(text);
    if (accepted && session.current === started) setEditing(false);
  };

  const chain = location ? ancestors(location) : [];

  return (
    <div className="navbar">
      <div className="nav-buttons" role="group" aria-label="Navigation">
        <button type="button" className="icon-button" aria-label="Back" title="Back (⌘[)" disabled={!props.canBack} onClick={props.onBack}>
          <BackGlyph />
        </button>
        <button type="button" className="icon-button" aria-label="Forward" title="Forward (⌘])" disabled={!props.canForward} onClick={props.onForward}>
          <ForwardGlyph />
        </button>
        <button type="button" className="icon-button" aria-label="Up one level" title="Up (⌘↑)" disabled={!props.canUp} onClick={props.onUp}>
          <UpGlyph />
        </button>
      </div>
      <div className={`address${error ? " invalid" : ""}${editing ? " editing" : ""}`}>
        {editing ? (
          <input
            ref={input}
            className="address-input"
            aria-label="Address"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "address-error" : undefined}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) props.onDismissError();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                props.onDismissError();
                setEditing(false);
              }
            }}
            onBlur={() => {
              props.onDismissError();
              setEditing(false);
            }}
          />
        ) : (
          <nav aria-label="Path" className="breadcrumbs" onClick={(e) => e.target === e.currentTarget && startEditing()}>
            <ol ref={crumbs} onClick={(e) => e.target === e.currentTarget && startEditing()}>
              {location === null && <li className="crumb-empty">{props.busy ? "Locating your home folder…" : "No folder"}</li>}
              {chain.map((crumb, i) => {
                const isRoot = i === 0;
                const label = isRoot ? (props.rootLabel ?? "/") : crumb.name;
                const current = i === chain.length - 1;
                return (
                  <li key={crumb.id}>
                    {!isRoot && <ChevronGlyph size={9} />}
                    <button
                      type="button"
                      className="crumb"
                      aria-current={current ? "location" : undefined}
                      title={crumb.path}
                      onClick={() => (current ? startEditing() : props.onNavigate(crumb))}
                    >
                      {label}
                    </button>
                  </li>
                );
              })}
            </ol>
            <button type="button" className="edit-address" aria-label="Edit address" title="Type a path (⌘L)" onClick={startEditing} />
          </nav>
        )}
        {error && (
          <p id="address-error" role="alert" className="address-error">
            {error.message}
          </p>
        )}
      </div>
      <button type="button" className="icon-button" aria-label="Refresh" title="Refresh (⌘R)" disabled={!location} onClick={props.onRefresh}>
        <RefreshGlyph />
      </button>
      <input className="search" type="search" aria-label="Search" placeholder="Search (not available yet)" disabled />
    </div>
  );
}
