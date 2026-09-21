import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import {
  api,
  ApiError,
  type StorySummary,
  type Telling,
} from "../api";
import { topicLabel } from "../interview/bank";

const GENERIC = "That didn't work. Check your connection and try again.";

type View =
  | { kind: "loading" }
  | { kind: "ready"; stories: StorySummary[]; tellings: Telling[] }
  | { kind: "forbidden" }
  | { kind: "missing" }
  | { kind: "error" };

function tellerName(t: Telling): string {
  return t.display_name || t.relationship_to_subject || "A family member";
}

export function Stories() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<View>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!id) {
      setView({ kind: "missing" });
      return;
    }
    try {
      const [stories, tellings] = await Promise.all([
        api.listStories(id),
        api.getTellings(id),
      ]);
      setView({ kind: "ready", stories: stories.stories, tellings: tellings.tellings });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setView({ kind: "forbidden" });
      else if (err instanceof ApiError && err.status === 404) setView({ kind: "missing" });
      else setView({ kind: "error" });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <TopBar />
      <main className="page">
        {view.kind === "loading" && <StoriesSkeleton />}

        {view.kind === "forbidden" && (
          <SimpleCard title="This space is private to its family." spaceId={id} />
        )}
        {view.kind === "missing" && (
          <SimpleCard title="That page is not here" spaceId={id} />
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

        {view.kind === "ready" && (
          <div className="stack">
            <div className="gap-header">
              <p className="topic-label">Side by side</p>
              <h1 className="section-title">Stories</h1>
              <p className="muted">
                Group two people's tellings of one memory to see them side by
                side.
              </p>
            </div>

            {view.stories.length === 0 ? (
              <div className="card gap-empty">
                <p>Bring two tellings together to see them side by side.</p>
              </div>
            ) : (
              <ul className="story-list">
                {view.stories.map((s) => (
                  <li key={s.id}>
                    <Link className="story-link" to={`/space/${id}/story/${s.id}`}>
                      <span className="story-label">{s.label}</span>
                      <span className="story-meta">
                        {s.ready ? (
                          <span className="story-ready">Ready side by side</span>
                        ) : (
                          <span className="story-count">
                            {s.teller_count === 1 ? "1 telling" : `${s.teller_count} tellings`}
                          </span>
                        )}
                        <span className="chevron" aria-hidden="true">
                          →
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            <GroupPanel
              spaceId={id!}
              stories={view.stories}
              tellings={view.tellings}
              onChanged={load}
            />

            <Link className="btn btn-quiet" to={`/space/${id}`}>
              Back to the space
            </Link>
          </div>
        )}
      </main>
    </>
  );
}

function GroupPanel({
  spaceId,
  stories,
  tellings,
  onChanged,
}: {
  spaceId: string;
  stories: StorySummary[];
  tellings: Telling[];
  onChanged: () => void | Promise<void>;
}) {
  const untagged = tellings.filter((t) => t.story_id === null);
  const [answerId, setAnswerId] = useState("");
  const [target, setTarget] = useState(""); // "" | "new" | storyId
  const [newLabel, setNewLabel] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const suggest = async () => {
    if (!answerId) return;
    setHint("");
    setError("");
    try {
      const res = await api.suggestStory(answerId);
      if (res.suggestions.length > 0) {
        setTarget(res.suggestions[0].story_id);
        setHint(`Suggested story: ${res.suggestions[0].label}`);
      } else if (res.suggested_label) {
        setTarget("new");
        setNewLabel(res.suggested_label);
        setHint("Suggested a name for a new story.");
      } else {
        setHint("Pick a story below, or name a new one.");
      }
    } catch {
      setHint("Pick a story below, or name a new one.");
    }
  };

  const add = async () => {
    if (!answerId || !target) return;
    setBusy(true);
    setError("");
    setDone("");
    try {
      let storyId = target;
      if (target === "new") {
        const label = newLabel.trim();
        if (!label) {
          setError("Name the story first.");
          setBusy(false);
          return;
        }
        const created = await api.createStory(spaceId, label);
        storyId = created.id;
      }
      const res = await api.tagAnswerStory(answerId, storyId);
      setDone(
        res.generated > 0
          ? "Two tellings now sit side by side, with a question for each."
          : "Added to the story."
      );
      setAnswerId("");
      setTarget("");
      setNewLabel("");
      setHint("");
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : GENERIC);
    } finally {
      setBusy(false);
    }
  };

  if (untagged.length === 0) {
    return (
      <section className="card stack">
        <h2 className="saved-heading">Group a telling</h2>
        <p className="muted">
          Record a telling first, then bring it together with another.
        </p>
        <Link className="btn btn-primary btn-block" to={`/space/${spaceId}/interview`}>
          Record a memory
        </Link>
      </section>
    );
  }

  return (
    <section className="card stack">
      <h2 className="saved-heading">Group a telling</h2>
      <label className="field">
        Choose a telling
        <select
          className="input"
          value={answerId}
          onChange={(e) => {
            setAnswerId(e.target.value);
            setHint("");
            setDone("");
          }}
        >
          <option value="">Pick one</option>
          {untagged.map((t) => (
            <option key={t.answer_id} value={t.answer_id}>
              {tellerName(t)}: {t.prompt_text}
              {topicLabel(t.topic) ? ` (${topicLabel(t.topic)})` : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        Add it to
        <select
          className="input"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-label="Choose a story"
        >
          <option value="">Pick a story</option>
          {stories.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
          <option value="new">Start a new story</option>
        </select>
      </label>

      {target === "new" && (
        <label className="field">
          New story name
          <input
            className="input"
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="The bakery on Sunday mornings"
            autoComplete="off"
            maxLength={120}
          />
        </label>
      )}

      <div className="record-actions">
        <button
          className="btn btn-primary btn-block"
          type="button"
          onClick={add}
          disabled={busy || !answerId || !target}
        >
          {busy ? "Adding..." : "Add to story"}
        </button>
        <button
          className="btn btn-quiet"
          type="button"
          onClick={suggest}
          disabled={busy || !answerId}
        >
          Suggest a story
        </button>
      </div>

      {hint && <p className="hint">{hint}</p>}
      {done && (
        <div className="notice notice-info" role="status">
          {done}
        </div>
      )}
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

function SimpleCard({ title, spaceId }: { title: string; spaceId?: string }) {
  return (
    <div className="card">
      <h1 className="section-title">{title}</h1>
      <Link className="btn btn-primary" to={spaceId ? `/space/${spaceId}` : "/"}>
        Back to the space
      </Link>
    </div>
  );
}

function StoriesSkeleton() {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading stories">
      <div className="skeleton sk-line" style={{ width: "40%", height: "1.6rem" }} />
      <div className="skeleton sk-card" />
      <div className="skeleton sk-card" />
    </div>
  );
}
