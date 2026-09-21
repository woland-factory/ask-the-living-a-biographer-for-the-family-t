import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { api, ApiError, type SideBySide as SideBySideData } from "../api";
import { topicLabel } from "../interview/bank";

const GENERIC = "That didn't work. Check your connection and try again.";

type View =
  | { kind: "loading" }
  | { kind: "ready"; data: SideBySideData }
  | { kind: "locked" }
  | { kind: "missing" }
  | { kind: "error" };

/**
 * The two tellings, always shown separately. There is no combined or summary
 * block. Two columns on desktop, stacked on mobile. Reused by the signed-in
 * page and the public demo.
 */
export function SideBySideColumns({ data }: { data: SideBySideData }) {
  return (
    <div className="stack">
      <div className="sbs-header">
        <p className="topic-label">Side by side</p>
        <h1 className="section-title">{data.story.label}</h1>
        <p className="muted">
          Two tellings of the same memory, kept in each voice.
        </p>
      </div>
      <div className="sbs-grid">
        {data.tellings.map((t) => (
          <section className="card sbs-column" key={t.membership_id}>
            <header className="sbs-teller">
              <span className="sbs-name">{t.display_name || "A family member"}</span>
              {t.relationship_to_subject && (
                <span className="sbs-rel">{t.relationship_to_subject}</span>
              )}
            </header>
            {t.answers.map((a) => (
              <div className="sbs-answer" key={a.id}>
                <p className="sbs-prompt">{a.prompt_text}</p>
                {a.transcript_status === "done" && a.transcript ? (
                  <p className="sbs-transcript">{a.transcript}</p>
                ) : (
                  <p className="muted sbs-note">A recording is saved for this telling.</p>
                )}
                {a.has_audio && a.audio_url && (
                  <audio
                    className="answer-audio"
                    controls
                    preload="none"
                    src={a.audio_url}
                    aria-label={`Recording for: ${a.prompt_text}`}
                  />
                )}
              </div>
            ))}
            {t.open_question && (
              <div className="sbs-question">
                <p className="topic-label">A question the other telling opened</p>
                <p className="sbs-question-text">{t.open_question.text}</p>
                {topicLabel(t.open_question.topic) && (
                  <span className="sbs-question-topic">
                    {topicLabel(t.open_question.topic)}
                  </span>
                )}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

export function SideBySide() {
  const { id, sid } = useParams<{ id: string; sid: string }>();
  const [view, setView] = useState<View>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!id || !sid) {
      setView({ kind: "missing" });
      return;
    }
    setView({ kind: "loading" });
    try {
      const data = await api.getStory(id, sid);
      setView({ kind: "ready", data });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setView({ kind: "locked" });
      else if (err instanceof ApiError && err.status === 404) setView({ kind: "missing" });
      else setView({ kind: "error" });
    }
  }, [id, sid]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <TopBar />
      <main className="page">
        {view.kind === "loading" && <SideBySideSkeleton />}

        {view.kind === "ready" && (
          <div className="stack">
            <SideBySideColumns data={view.data} />
            <Link className="btn btn-quiet" to={`/space/${id}/stories`}>
              Back to stories
            </Link>
          </div>
        )}

        {view.kind === "locked" && (
          <div className="card stack">
            <h1 className="section-title">This story opens once you tell it too.</h1>
            <p className="muted">
              Add your own telling of this memory, then you'll see it beside the
              others.
            </p>
            <Link className="btn btn-primary btn-block" to={`/space/${id}/interview`}>
              Record your telling
            </Link>
            <Link className="btn btn-quiet" to={`/space/${id}/stories`}>
              Back to stories
            </Link>
          </div>
        )}

        {view.kind === "missing" && (
          <div className="card">
            <h1 className="section-title">That page is not here</h1>
            <Link className="btn btn-primary" to={`/space/${id}/stories`}>
              Back to stories
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

function SideBySideSkeleton() {
  return (
    <div className="stack" aria-busy="true" aria-label="Opening the tellings">
      <div className="skeleton sk-line" style={{ width: "55%", height: "1.6rem" }} />
      <div className="sbs-grid">
        <div className="skeleton sk-card" style={{ height: "180px" }} />
        <div className="skeleton sk-card" style={{ height: "180px" }} />
      </div>
    </div>
  );
}
