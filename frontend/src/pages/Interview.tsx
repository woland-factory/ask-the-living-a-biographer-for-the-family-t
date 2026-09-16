import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import {
  api,
  ApiError,
  type AnswerSummary,
  type Followup,
  type Session,
  type Space,
} from "../api";
import { nextQuestion, topicLabel, type BankQuestion } from "../interview/bank";
import { useRecorder } from "../interview/useRecorder";
import { transcribe } from "../interview/transcribe";
import { firstName, formatClock } from "../format";

const GENERIC = "That didn't work. Check your connection and try again.";

type Phase = "loading" | "error" | "active" | "completed";

// The next thing to ask: either a curated bank question or a gentle follow-up
// this member's own telling opened.
type CurrentQ =
  | { kind: "bank"; question: BankQuestion }
  | { kind: "followup"; followup: Followup };

interface Completion {
  count: number;
  canContinue: boolean;
}

export function Interview() {
  const { id } = useParams<{ id: string }>();
  const [phase, setPhase] = useState<Phase>("loading");
  const [space, setSpace] = useState<Space | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [answeredKeys, setAnsweredKeys] = useState<string[]>([]);
  const [deferredTopics, setDeferredTopics] = useState<string[]>([]);
  const [saved, setSaved] = useState<AnswerSummary[]>([]);
  const [savedThisSitting, setSavedThisSitting] = useState(0);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const [pendingFollowups, setPendingFollowups] = useState<Followup[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const recorder = useRecorder();
  const blobsRef = useRef<Map<string, Blob>>(new Map());

  // A follow-up left open earlier comes first; otherwise walk the bank.
  const nextFollowup = pendingFollowups.find((f) => !dismissed.has(f.id)) ?? null;
  const bankQuestion = nextQuestion(answeredKeys, deferredTopics);
  const current: CurrentQ | null = nextFollowup
    ? { kind: "followup", followup: nextFollowup }
    : bankQuestion
      ? { kind: "bank", question: bankQuestion }
      : null;
  const person = space ? firstName(space.subject_name) : "them";

  const load = useCallback(async () => {
    if (!id) {
      setPhase("error");
      return;
    }
    setPhase("loading");
    setCompletion(null);
    setSaveError("");
    try {
      const sp = await api.getSpace(id);
      const s = await api.startSession(id);
      const progress = await api.getSession(s.id);
      setSpace(sp);
      setSession(s);
      setAnsweredKeys(progress.answered_keys);
      setDeferredTopics(progress.deferred_topics);
      setSaved([...progress.answers].reverse());
      setPendingFollowups(progress.followups ?? []);
      setDismissed(new Set());
      setSavedThisSitting(0);
      setPhase("active");
    } catch {
      setPhase("error");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const runTranscription = useCallback(async (answerId: string) => {
    setSaved((list) =>
      list.map((a) =>
        a.id === answerId ? { ...a, transcript_status: "pending" } : a
      )
    );
    try {
      let blob = blobsRef.current.get(answerId);
      if (!blob) blob = await api.fetchAudio(answerId);
      const { transcript } = await transcribe(answerId, blob);
      const updated = await api.attachTranscript(answerId, {
        transcript_status: "done",
        transcript,
      });
      setSaved((list) => list.map((a) => (a.id === answerId ? updated : a)));
      // Ask for a gentle follow-up from what they just said. Without a key this
      // returns nothing and the loop simply continues from the bank.
      try {
        const res = await api.generateFollowups(answerId);
        if (res.followups.length > 0) {
          setPendingFollowups((queue) => [...queue, ...res.followups]);
        }
      } catch {
        /* a missing follow-up is never an error; the bank continues */
      }
    } catch {
      try {
        await api.attachTranscript(answerId, { transcript_status: "failed" });
      } catch {
        /* the recording is already safe; leave the local state as failed */
      }
      setSaved((list) =>
        list.map((a) =>
          a.id === answerId
            ? { ...a, transcript_status: "failed", transcript: null }
            : a
        )
      );
    }
  }, []);

  const save = useCallback(async () => {
    if (!current || !session || !recorder.recording) return;
    setSaving(true);
    setSaveError("");
    const rec = recorder.recording;
    const meta =
      current.kind === "bank"
        ? {
            bank_question_key: current.question.key,
            prompt_text: current.question.text,
            topic: current.question.topic,
          }
        : {
            bank_question_key: current.followup.routed
              ? `routed:${current.followup.id}`
              : `followup:${current.followup.id}`,
            prompt_text: current.followup.text,
            topic: current.followup.topic,
            question_id: current.followup.id,
          };
    try {
      const created = await api.createAnswer(session.id, {
        ...meta,
        duration_ms: rec.durationMs,
      });
      await api.uploadAudio(created.id, rec.blob);
      blobsRef.current.set(created.id, rec.blob);
      const summary: AnswerSummary = {
        id: created.id,
        bank_question_key: meta.bank_question_key,
        prompt_text: meta.prompt_text,
        topic: meta.topic,
        duration_ms: rec.durationMs,
        transcript_status: "pending",
        transcript: null,
        created_at: new Date().toISOString(),
      };
      setSaved((list) => [...list, summary]);
      if (current.kind === "bank") {
        setAnsweredKeys((keys) => [...keys, current.question.key]);
      } else {
        setDismissed((prev) => new Set(prev).add(current.followup.id));
      }
      setSavedThisSitting((n) => n + 1);
      recorder.reset();
      setSaving(false);
      void runTranscription(created.id);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : GENERIC);
      setSaving(false);
    }
  }, [current, session, recorder, runTranscription]);

  // "Not this topic yet" applies to bank questions only.
  const defer = useCallback(async () => {
    if (!current || current.kind !== "bank" || !session) return;
    const topic = current.question.topic;
    setDeferredTopics((t) => [...t, topic]);
    recorder.reset();
    try {
      await api.deferTopic(session.id, topic);
    } catch {
      /* the local skip already advanced the interview; a retry can re-defer */
    }
  }, [current, session, recorder]);

  // "Keep it on the map" leaves a follow-up open and moves past it for now.
  const keepOnMap = useCallback(() => {
    if (!current || current.kind !== "followup") return;
    setDismissed((prev) => new Set(prev).add(current.followup.id));
    recorder.reset();
  }, [current, recorder]);

  const complete = useCallback(async () => {
    if (!session) return;
    try {
      const res = await api.completeSession(session.id);
      setCompletion({ count: res.answered_count, canContinue: current !== null });
      setPhase("completed");
    } catch {
      setSaveError(GENERIC);
    }
  }, [session, current]);

  return (
    <>
      <TopBar />
      <main className="page">
        {phase === "loading" && <InterviewSkeleton />}

        {phase === "error" && (
          <div className="card">
            <div className="notice notice-error" role="alert">
              This sitting could not open. Check your connection and try again.
            </div>
            <button className="btn btn-primary" type="button" onClick={load}>
              Try again
            </button>
          </div>
        )}

        {phase === "completed" && completion && (
          <CompletionCard
            count={completion.count}
            person={person}
            spaceId={id!}
            canContinue={completion.canContinue}
            onAnother={load}
          />
        )}

        {phase === "active" && !current && (
          <CompletionCard
            count={savedThisSitting}
            person={person}
            spaceId={id!}
            canContinue={false}
            onAnother={load}
          />
        )}

        {phase === "active" && current && (
          <div className="stack">
            <p className="muted interview-intro">
              Take your time. One question at a time, in your own voice.
            </p>

            <section
              className={`card interview-card${current.kind === "followup" ? " interview-followup" : ""}`}
              aria-live="polite"
            >
              {current.kind === "followup" ? (
                <p className="topic-label followup-label">
                  {current.followup.routed
                    ? "Your family thought you might know"
                    : "A question your telling opened"}
                </p>
              ) : (
                <p className="topic-label">{topicLabel(current.question.topic)}</p>
              )}
              <h1 className="question-text">
                {current.kind === "followup" ? current.followup.text : current.question.text}
              </h1>

              <RecordArea
                recorder={recorder}
                saving={saving}
                saveError={saveError}
                onSave={save}
              />

              {(recorder.status === "idle" ||
                recorder.status === "preparing" ||
                recorder.status === "denied" ||
                recorder.status === "unsupported") && (
                <div className="quiet-actions">
                  {current.kind === "followup" ? (
                    <button className="btn btn-quiet" type="button" onClick={keepOnMap}>
                      {current.followup.routed ? "Leave it for now" : "Keep it on the map"}
                    </button>
                  ) : (
                    <button className="btn btn-quiet" type="button" onClick={defer}>
                      Not this topic yet
                    </button>
                  )}
                  <Link className="btn btn-quiet" to={`/space/${id}`}>
                    Save and step away
                  </Link>
                </div>
              )}
            </section>

            {saved.length > 0 && (
              <section className="stack">
                <h2 className="saved-heading">Saved this sitting</h2>
                <ul className="saved-list">
                  {saved.map((a) => (
                    <SavedAnswer
                      key={a.id}
                      answer={a}
                      onRetry={() => void runTranscription(a.id)}
                    />
                  ))}
                </ul>
              </section>
            )}

            {savedThisSitting > 0 && (
              <div className="center">
                <button
                  className="btn btn-quiet"
                  type="button"
                  onClick={complete}
                >
                  I'm done for now
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </>
  );
}

function RecordArea({
  recorder,
  saving,
  saveError,
  onSave,
}: {
  recorder: ReturnType<typeof useRecorder>;
  saving: boolean;
  saveError: string;
  onSave: () => void;
}) {
  if (recorder.status === "recorded" && recorder.recording) {
    return (
      <div className="record-area stack">
        <audio
          className="answer-audio"
          controls
          src={recorder.recording.url}
          aria-label="Listen to your recording"
        />
        <div className="record-actions">
          <button
            className="btn btn-primary btn-block"
            type="button"
            onClick={onSave}
            disabled={saving}
          >
            {saving ? "Saving your voice..." : "Save this memory"}
          </button>
          <button
            className="btn btn-quiet"
            type="button"
            onClick={recorder.reset}
            disabled={saving}
          >
            Record again
          </button>
        </div>
        {saveError && (
          <div className="notice notice-error" role="alert">
            {saveError}
          </div>
        )}
      </div>
    );
  }

  if (recorder.status === "recording") {
    return (
      <div className="record-area">
        <div className="recording-indicator" role="status" aria-live="polite">
          <span className="rec-dot" aria-hidden="true" />
          Recording {formatClock(recorder.elapsedMs)}
        </div>
        <button
          className="btn btn-primary btn-block"
          type="button"
          onClick={recorder.stop}
        >
          Stop
        </button>
      </div>
    );
  }

  if (recorder.status === "denied") {
    return (
      <div className="record-area stack">
        <div className="notice notice-info" role="status">
          Your microphone is off. Turn it on in your browser settings, then try
          again.
        </div>
        <button
          className="btn btn-primary btn-block"
          type="button"
          aria-pressed={false}
          onClick={recorder.start}
        >
          Try the microphone again
        </button>
      </div>
    );
  }

  if (recorder.status === "unsupported") {
    return (
      <div className="record-area">
        <div className="notice notice-info" role="status">
          Recording needs a recent browser. Try Chrome, Safari, or Firefox.
        </div>
      </div>
    );
  }

  // idle or preparing
  const preparing = recorder.status === "preparing";
  return (
    <div className="record-area">
      <button
        className="btn btn-primary btn-block record-btn"
        type="button"
        aria-pressed={preparing}
        onClick={recorder.start}
      >
        {preparing ? "Getting your microphone ready..." : "Record your answer"}
      </button>
    </div>
  );
}

function SavedAnswer({
  answer,
  onRetry,
}: {
  answer: AnswerSummary;
  onRetry: () => void;
}) {
  return (
    <li className="saved-item">
      <p className="saved-prompt">{answer.prompt_text}</p>
      <audio
        className="answer-audio"
        controls
        preload="none"
        src={api.audioUrl(answer.id)}
        aria-label={`Recording for: ${answer.prompt_text}`}
      />
      {answer.transcript_status === "pending" && (
        <p className="muted saved-note" role="status">
          Writing down what you said.
        </p>
      )}
      {answer.transcript_status === "done" && answer.transcript && (
        <p className="saved-transcript">{answer.transcript}</p>
      )}
      {answer.transcript_status === "failed" && (
        <div className="saved-note">
          <p className="muted">
            Your recording is saved. The written copy didn't come through.
          </p>
          <button className="btn btn-quiet" type="button" onClick={onRetry}>
            Try transcribing again
          </button>
        </div>
      )}
    </li>
  );
}

function CompletionCard({
  count,
  person,
  spaceId,
  canContinue,
  onAnother,
}: {
  count: number;
  person: string;
  spaceId: string;
  canContinue: boolean;
  onAnother: () => void;
}) {
  const memories = count === 1 ? "memory" : "memories";
  return (
    <div className="card">
      <div className="confirm">
        <div className="mark" aria-hidden="true">
          ♥
        </div>
        <h1 className="section-title">You gave them your voice today.</h1>
        <p className="section-sub">
          {count > 0
            ? `You saved ${count} ${memories} of ${person} this sitting.`
            : `Your voice is here whenever you're ready to tell ${person}'s story.`}
        </p>
        <div className="record-actions">
          {canContinue && (
            <button
              className="btn btn-primary btn-block"
              type="button"
              onClick={onAnother}
            >
              Record another
            </button>
          )}
          <Link className="btn btn-quiet" to={`/space/${spaceId}`}>
            Back to {person}'s space
          </Link>
        </div>
      </div>
    </div>
  );
}

function InterviewSkeleton() {
  return (
    <div className="stack" aria-busy="true" aria-label="Opening this sitting">
      <div className="skeleton sk-line" style={{ width: "40%" }} />
      <div className="card stack">
        <div className="skeleton sk-line" style={{ width: "30%" }} />
        <div
          className="skeleton sk-line"
          style={{ width: "85%", height: "1.6rem" }}
        />
        <div className="skeleton sk-card" style={{ height: "52px" }} />
      </div>
    </div>
  );
}
