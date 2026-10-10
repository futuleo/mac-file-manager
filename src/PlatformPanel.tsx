import { useEffect, useState } from "react";
import { call } from "./backend/client";
import { toAppError } from "./backend/directory";
import type { NativeCapabilities, PlatformInfo } from "./backend/contracts";

const CAPABILITY_LABELS: [keyof NativeCapabilities, string][] = [
  ["spotlightQuery", "NSMetadataQuery (Spotlight search)"],
  ["quickLookPanel", "QLPreviewPanel (Quick Look)"],
  ["trash", "NSFileManager (Trash)"],
  ["systemIcons", "NSWorkspace (system icons)"],
  ["dragSession", "NSDraggingSession (external drag source)"],
];

export default function PlatformPanel() {
  const [info, setInfo] = useState<PlatformInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    call("get_platform_info").then(
      (value) => active && setInfo(value),
      (reason) => active && setError(toAppError(reason).message),
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <details className="platform">
      <summary>Native services</summary>
      {error && (
        <p role="alert" className="error">
          Could not read platform information: {error}
        </p>
      )}
      {!info && !error && <p>Checking native services…</p>}
      {info && (
        <>
          <dl className="facts">
            <dt>macOS</dt>
            <dd>
              {info.osVersion} ({info.arch}); configured deployment target {info.deploymentTarget}, older macOS versions are unverified
            </dd>
            <dt>Version</dt>
            <dd>{info.appVersion}</dd>
          </dl>
          <table className="capabilities">
            <caption>Native class presence (the integrations themselves are not exercised here; external dragging is untested)</caption>
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Class present</th>
              </tr>
            </thead>
            <tbody>
              {CAPABILITY_LABELS.map(([key, label]) => (
                <tr key={key}>
                  <td>{label}</td>
                  <td>{info.capabilities[key] ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </details>
  );
}
