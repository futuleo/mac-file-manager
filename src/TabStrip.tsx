import { CloseGlyph, FolderGlyph, PlusGlyph } from "./glyphs";

export interface TabInfo {
  id: string;
  title: string;
}

interface Props {
  tabs: TabInfo[];
  activeId: string | null;
  canAdd: boolean;
  onActivate(id: string): void;
  onClose(id: string): void;
  onNew(): void;
}

export const tabButtonId = (id: string) => `tabbutton-${id}`;
export const tabPanelId = (id: string) => `tabpanel-${id}`;

export default function TabStrip({ tabs, activeId, canAdd, onActivate, onClose, onNew }: Props) {
  const focusTab = (id: string) => {
    onActivate(id);
    document.getElementById(tabButtonId(id))?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    let target: number | null = null;
    if (event.key === "ArrowRight") target = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") target = index === 0 ? last : index - 1;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = last;
    if (target !== null) {
      event.preventDefault();
      focusTab(tabs[target]!.id);
    } else if ((event.key === "Delete" || event.key === "Backspace") && tabs.length > 1) {
      event.preventDefault();
      const next = tabs[index === last ? index - 1 : index + 1]!;
      onClose(tabs[index]!.id);
      document.getElementById(tabButtonId(next.id))?.focus();
    }
  };

  return (
    <div className="tab-strip">
      <div role="tablist" aria-label="Folder tabs" className="tabs">
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          return (
            <div key={tab.id} className={`tab${active ? " active" : ""}`}>
              <button
                type="button"
                role="tab"
                id={tabButtonId(tab.id)}
                aria-selected={active}
                aria-controls={tabPanelId(tab.id)}
                tabIndex={active ? 0 : -1}
                className="tab-button"
                title={tab.title}
                onClick={() => onActivate(tab.id)}
                onKeyDown={(e) => onKeyDown(e, index)}
              >
                <FolderGlyph />
                <span className="tab-title">{tab.title}</span>
              </button>
              {tabs.length > 1 && (
                <button
                  type="button"
                  tabIndex={-1}
                  className="tab-close"
                  aria-label={`Close tab ${tab.title}`}
                  onClick={() => onClose(tab.id)}
                >
                  <CloseGlyph size={10} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="tab-new"
        aria-label="New tab"
        title={canAdd ? "New tab (⌘T)" : "The maximum number of tabs is open"}
        disabled={!canAdd}
        onClick={onNew}
      >
        <PlusGlyph size={12} />
      </button>
    </div>
  );
}
