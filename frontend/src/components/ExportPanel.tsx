import { useState } from "react";
import { api, ApiError } from "../api";

type State = "idle" | "preparing" | "done" | "error";

const GENERIC = "That download didn't finish. Check your connection and try again.";

// Save the blob to disk by clicking a temporary download link.
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// The organizer's custodial download of the whole space. Rendered inside
// SpaceDetail only for the organizer; the endpoint enforces that too.
export function ExportPanel({ spaceId }: { spaceId: string }) {
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState(GENERIC);

  const run = async () => {
    setState("preparing");
    try {
      const { blob, filename } = await api.exportSpace(spaceId);
      saveBlob(blob, filename);
      setState("done");
    } catch (err) {
      setError(err instanceof ApiError && err.message ? err.message : GENERIC);
      setState("error");
    }
  };

  if (state === "done") {
    return (
      <section className="card stack export-panel" aria-live="polite">
        <div className="confirm export-done">
          <span className="mark" aria-hidden="true">
            ✓
          </span>
          <p className="export-done-text">
            Saved. Your archive holds every recording, transcript, story, and the map.
          </p>
        </div>
        <button className="btn btn-quiet btn-block" type="button" onClick={run}>
          Download again
        </button>
      </section>
    );
  }

  return (
    <section className="stack export-panel">
      <button
        className="btn btn-quiet btn-block"
        type="button"
        onClick={run}
        disabled={state === "preparing"}
        aria-busy={state === "preparing"}
      >
        {state === "preparing" ? (
          <span className="export-busy">
            <span className="export-dot" aria-hidden="true" />
            Gathering
          </span>
        ) : (
          "Download everything"
        )}
      </button>

      <p className="hint export-hint" aria-live="polite">
        {state === "preparing"
          ? "Gathering every recording and transcript. This can take a moment."
          : "Every recording, transcript, story, and the map, in one file."}
      </p>

      {state === "error" && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
