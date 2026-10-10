import { useEffect, useRef, useState } from "react";

interface Props {
  title: string;
  initial: string;
  confirmLabel: string;
  error: string | null;
  busy: boolean;
  onSubmit(name: string): void;
  onCancel(): void;
}

/** Modal name prompt used for renaming (and naming a just-created folder). */
export default function NameDialog(props: Props) {
  const [name, setName] = useState(props.initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    const dot = props.initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : props.initial.length);
    // Selected once when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="dialog-scrim">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="name-title"
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (!props.busy) props.onSubmit(name);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            props.onCancel();
          }
        }}
      >
        <h2 id="name-title">{props.title}</h2>
        <input
          ref={input}
          type="text"
          aria-label="Name"
          value={name}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
        {props.error && (
          <p role="alert" className="dialog-error">
            {props.error}
          </p>
        )}
        <div className="dialog-buttons">
          <button type="submit" className="command" disabled={props.busy || name.length === 0}>
            {props.confirmLabel}
          </button>
          <button type="button" className="command" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
