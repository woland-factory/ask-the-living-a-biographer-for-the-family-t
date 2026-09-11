import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { ListLoading } from "../components/Loading";
import { CreateSpaceForm } from "../components/CreateSpaceForm";
import { api, type Space } from "../api";
import { formatYears } from "../format";

type LoadState = "loading" | "ready" | "error";

export function Home() {
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const { spaces } = await api.listSpaces();
      setSpaces(spaces);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreated = (space: Space) => {
    navigate(`/space/${space.id}`);
  };

  return (
    <>
      <TopBar />
      <main className="page">
        {state === "loading" && (
          <>
            <div
              className="skeleton sk-line"
              style={{ width: "50%", height: "1.8rem" }}
            />
            <div className="mt-2">
              <ListLoading />
            </div>
          </>
        )}

        {state === "error" && (
          <div className="card">
            <div className="notice notice-error" role="alert">
              That didn't work. Check your connection and try again.
            </div>
            <button className="btn btn-primary" type="button" onClick={load}>
              Try again
            </button>
          </div>
        )}

        {state === "ready" && spaces.length === 0 && (
          <div className="card stack">
            <div>
              <h1 className="section-title">Create your first space</h1>
              <p className="section-sub">
                A space holds everything your family remembers about one person.
              </p>
            </div>
            <CreateSpaceForm onCreated={onCreated} />
          </div>
        )}

        {state === "ready" && spaces.length > 0 && (
          <>
            <h1 className="section-title">Your spaces</h1>
            <p className="section-sub">Open one to keep gathering memories.</p>
            <ul className="space-list">
              {spaces.map((s) => {
                const years = formatYears(
                  s.subject_birth_year,
                  s.subject_death_year
                );
                return (
                  <li className="space-item" key={s.id}>
                    <Link className="space-link" to={`/space/${s.id}`}>
                      <span>
                        <span className="space-name">{s.subject_name}</span>
                        {years && (
                          <>
                            <br />
                            <span className="space-years">{years}</span>
                          </>
                        )}
                      </span>
                      <span className="chevron" aria-hidden="true">
                        ›
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>

            <div className="card mt-2">
              <h2 className="section-title" style={{ fontSize: "1.25rem" }}>
                Remember someone else
              </h2>
              <CreateSpaceForm onCreated={onCreated} submitLabel="Create space" />
            </div>
          </>
        )}
      </main>
    </>
  );
}
