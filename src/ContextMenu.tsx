import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem =
  | { separator: true }
  | {
      label: string;
      onSelect?: () => void;
      /** Shown greyed out; the feature belongs to a later slice. */
      unavailable?: boolean;
      checked?: boolean;
      shortcut?: string;
    };

interface Props {
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
  onClose: () => void;
}

const isAction = (item: MenuItem): item is Exclude<MenuItem, { separator: true }> => !("separator" in item);

/** A Windows-style context menu with real, keyboard-operable items. */
export default function ContextMenu({ x, y, label, items, onClose }: Props) {
  const ref = useRef<HTMLUListElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const enabled = items.map((item, i) => (isAction(item) && !item.unavailable ? i : -1)).filter((i) => i >= 0);
  const [active, setActive] = useState<number>(enabled[0] ?? -1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition({
      left: Math.max(0, Math.min(x, window.innerWidth - rect.width - 2)),
      top: Math.max(0, Math.min(y, window.innerHeight - rect.height - 2)),
    });
    el.focus();
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  const choose = (index: number) => {
    const item = items[index];
    if (!item || !isAction(item) || item.unavailable) return;
    onClose();
    item.onSelect?.();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const at = enabled.indexOf(active);
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive(enabled[(at + step + enabled.length) % enabled.length] ?? -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(enabled[event.key === "Home" ? 0 : enabled.length - 1] ?? -1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(active);
    } else if (event.key === "Tab") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <>
      <div className="menu-scrim" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <ul
        ref={ref}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        className="context-menu"
        style={position}
        aria-activedescendant={active >= 0 ? `menu-item-${active}` : undefined}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, i) =>
          isAction(item) ? (
            <li
              key={item.label}
              id={`menu-item-${i}`}
              role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={item.checked}
              aria-disabled={item.unavailable || undefined}
              title={item.unavailable ? "Not available yet" : undefined}
              className={`${item.unavailable ? "unavailable" : ""} ${active === i ? "active" : ""}`}
              onMouseEnter={() => !item.unavailable && setActive(i)}
              onClick={() => choose(i)}
            >
              <span className="check" aria-hidden="true">{item.checked ? "✓" : ""}</span>
              <span className="text">{item.label}</span>
              {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
            </li>
          ) : (
            <li key={`sep-${i}`} role="separator" className="separator" />
          ),
        )}
      </ul>
    </>
  );
}
