import { useEffect, useRef, useState } from "react";
import type { ConflictDecision } from "./backend/contracts";
import {
  canReplace,
  conflictDescription,
  needsAttention,
  progressText,
  resultMessage,
  type Operation,
} from "./operations/model";

interface Props {
  operations: Operation[];
  onCancel(id: string): void;
  onResolve(id: string, conflictId: string, decision: ConflictDecision, applyToAll: boolean): void;
  onDismiss(id: string): void;
}

function ConflictDialog({ op, onResolve, onCancel }: { op: Operation; onResolve: Props["onResolve"]; onCancel: Props["onCancel"] }) {
  const conflict = op.conflict!;
  const [applyToAll, setApplyToAll] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), [conflict.conflictId]);
  const replace = canReplace(conflict);
  const answer = (decision: ConflictDecision) => onResolve(op.id, conflict.conflictId, decision, applyToAll);
  return (
    <div className="dialog-scrim">
      <div role="alertdialog" aria-modal="true" aria-labelledby="conflict-title" aria-describedby="conflict-text" className="dialog">
        <h2 id="conflict-title">Name conflict</h2>
        <p id="conflict-text">{conflictDescription(conflict)}</p>
        {!replace && !conflict.sameItem && (
          <p className="dialog-note">Folders are never merged or replaced; you can skip this one or keep both.</p>
        )}
        <label className="check">
          <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
          Do this for all remaining conflicts
        </label>
        <div className="dialog-buttons">
          <button type="button" className="command" ref={first} onClick={() => answer("skip")}>
            Skip
          </button>
          <button type="button" className="command" onClick={() => answer("keepBoth")}>
            Keep both
          </button>
          {replace && (
            <button type="button" className="command" onClick={() => answer("replace")}>
              Replace (old file goes to the Trash)
            </button>
          )}
          <button type="button" className="command" onClick={() => onCancel(op.id)}>
            Cancel operation
          </button>
        </div>
      </div>
    </div>
  );
}

/** Progress, conflict questions and outcomes of file operations. */
export default function OperationsPanel(props: Props) {
  const withConflict = props.operations.find((op) => op.conflict && !op.result);
  if (props.operations.length === 0) return null;
  return (
    <>
      <div className="operations" role="region" aria-label="File operations">
        {props.operations.map((op) => {
          if (op.result) {
            const failed = op.result.state === "finished" || op.result.state === "cancelled" ? op.result.summary : null;
            const bad = needsAttention(op);
            return (
              <div key={op.id} className={`operation ${bad ? "attention" : ""}`} role={bad ? "alert" : "status"}>
                <span className="operation-text">{resultMessage(op)}</span>
                <button type="button" className="banner-dismiss" onClick={() => props.onDismiss(op.id)}>
                  Dismiss
                </button>
                {failed && (failed.failed.length > 0 || failed.failedOmitted > 0) && (
                  <ul>
                    {failed.failed.slice(0, 20).map((f, i) => (
                      <li key={`${f.id}-${i}`}>{f.error.message}</li>
                    ))}
                    {failed.failed.length > 20 && <li>…and {failed.failed.length - 20 + failed.failedOmitted} more.</li>}
                    {failed.failed.length <= 20 && failed.failedOmitted > 0 && <li>…and {failed.failedOmitted} more.</li>}
                  </ul>
                )}
              </div>
            );
          }
          const text = progressText(op);
          const measurable = op.stage !== "scanning" && op.completed !== null && op.total !== null && op.total > 0;
          return (
            <div key={op.id} className="operation" role="status">
              <span className="operation-text">{op.cancelling ? `Cancelling… ${op.title}` : op.title}</span>
              {measurable ? (
                <progress aria-label={op.title} value={op.completed!} max={op.total!} />
              ) : (
                <progress aria-label={op.title} />
              )}
              {text && <span className="operation-detail">{text}</span>}
              <button type="button" className="banner-dismiss" disabled={op.cancelling} onClick={() => props.onCancel(op.id)}>
                Cancel
              </button>
            </div>
          );
        })}
      </div>
      {withConflict && <ConflictDialog op={withConflict} onResolve={props.onResolve} onCancel={props.onCancel} />}
    </>
  );
}
