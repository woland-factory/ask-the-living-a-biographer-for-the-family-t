import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { AppShellLoading } from "../components/Loading";
import { api, ApiError, type Space } from "../api";
import { formatYears } from "../format";

type View =
  | { kind: "loading" }
  | { kind: "ready"; space: Space }
  | { kind: "forbidden" }
  | { kind: "missing" }
  | { kind: "error" };

export function SpaceDetail() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<View>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    (async () => {
      if (!id) {
        setView({ kind: "missing" });
        return;
      }
      try {
        const space = await api.getSpace(id);
        if (active) setView({ kind: "ready", space });
      } catch (err) {
        if (!active) return;
        if (err instanceof ApiError && err.status === 403)
          setView({ kind: "forbidden" });
        else if (err instanceof ApiError && err.status === 404)
          setView({ kind: "missing" });
        else setView({ kind: "error" });
      }
    })();
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <>
      <TopBar />
      <main className="page">
        {view.kind === "loading" && <AppShellLoading />}

        {view.kind === "ready" && (
          <article className="card stack">
            <div>
              <h1 className="section-title">{view.space.subject_name}</h1>
              {formatYears(
                view.space.subject_birth_year,
                view.space.subject_death_year
              ) && (
                <p className="space-years">
                  {formatYears(
                    view.space.subject_birth_year,
                    view.space.subject_death_year
                  )}
                </p>
              )}
            </div>
            <p className="muted">
              This is where your family's memories of{" "}
              {view.space.subject_name.split(" ")[0]} will gather, in the voices
              of everyone who loved them.
            </p>
            <Link className="btn btn-quiet" to="/">
              Back to your spaces
            </Link>
          </article>
        )}

        {view.kind === "forbidden" && (
          <div className="card">
            <div className="notice notice-error" role="alert">
              This space is private to its family.
            </div>
            <Link className="btn btn-primary" to="/">
              Back to your spaces
            </Link>
          </div>
        )}

        {view.kind === "missing" && (
          <div className="card">
            <h1 className="section-title">That page is not here</h1>
            <p className="section-sub">
              The space may have been removed, or the link is off.
            </p>
            <Link className="btn btn-primary" to="/">
              Back to your spaces
            </Link>
          </div>
        )}

        {view.kind === "error" && (
          <div className="card">
            <div className="notice notice-error" role="alert">
              That didn't work. Check your connection and try again.
            </div>
            <Link className="btn btn-primary" to="/">
              Back to your spaces
            </Link>
          </div>
        )}
      </main>
    </>
  );
}
