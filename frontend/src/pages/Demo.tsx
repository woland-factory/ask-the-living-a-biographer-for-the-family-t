import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { api, ApiError, type SideBySide as SideBySideData } from "../api";
import { SideBySideColumns } from "./SideBySide";

const GENERIC = "That didn't work. Check your connection and try again.";

type View =
  | { kind: "loading" }
  | { kind: "ready"; data: SideBySideData }
  | { kind: "empty" }
  | { kind: "error" };

export function Demo() {
  const [view, setView] = useState<View>({ kind: "loading" });

  const load = useCallback(async () => {
    setView({ kind: "loading" });
    try {
      const data = await api.getDemoStory();
      setView({ kind: "ready", data });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setView({ kind: "empty" });
      else setView({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <TopBar />
      <main className="page">
        {view.kind === "loading" && <DemoSkeleton />}

        {view.kind === "ready" && (
          <div className="stack">
            <p className="muted demo-intro">
              A short example. Two people remember the same mornings, and each is
              asked the one question the other's telling opened.
            </p>
            <SideBySideColumns data={view.data} />
            <Link className="btn btn-primary btn-block" to="/signin">
              Create a space to begin
            </Link>
          </div>
        )}

        {view.kind === "empty" && (
          <div className="card stack">
            <h1 className="section-title">Start your family's story.</h1>
            <p className="muted">
              Create a space to gather your family's memories in their own voices.
            </p>
            <Link className="btn btn-primary btn-block" to="/signin">
              Create a space to begin
            </Link>
          </div>
        )}

        {view.kind === "error" && (
          <div className="card">
            <div className="notice notice-error" role="alert">
              {GENERIC}
            </div>
            <button className="btn btn-primary" type="button" onClick={load}>
              Try again
            </button>
          </div>
        )}
      </main>
    </>
  );
}

function DemoSkeleton() {
  return (
    <div className="stack" aria-busy="true" aria-label="Opening the example">
      <div className="skeleton sk-line" style={{ width: "70%" }} />
      <div className="sbs-grid">
        <div className="skeleton sk-card" style={{ height: "180px" }} />
        <div className="skeleton sk-card" style={{ height: "180px" }} />
      </div>
    </div>
  );
}
