import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { api, ApiError, type InvitePreview } from "../api";
import { useAuth } from "../auth";
import { firstName } from "../format";

const GENERIC = "That didn't work. Check your connection and try again.";

type View =
  | { kind: "loading" }
  | { kind: "ready"; preview: InvitePreview }
  | { kind: "used" }
  | { kind: "expired" }
  | { kind: "error" };

export function Join() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [view, setView] = useState<View>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!token) {
      setView({ kind: "error" });
      return;
    }
    setView({ kind: "loading" });
    try {
      const preview = await api.previewInvite(token);
      if (preview.status === "used") setView({ kind: "used" });
      else if (preview.status === "expired") setView({ kind: "expired" });
      else setView({ kind: "ready", preview });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setView({ kind: "expired" });
      else setView({ kind: "error" });
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const onJoined = useCallback(
    async (spaceId: string) => {
      await refresh();
      navigate(`/space/${spaceId}/interview`, { replace: true });
    },
    [refresh, navigate]
  );

  return (
    <>
      <TopBar />
      <main className="page">
        {view.kind === "loading" && <JoinSkeleton />}

        {view.kind === "ready" && (
          <JoinForm
            subjectName={view.preview.subject_name ?? "them"}
            token={token!}
            onJoined={onJoined}
          />
        )}

        {view.kind === "used" && (
          <SpentCard title="This link was already used." />
        )}
        {view.kind === "expired" && (
          <SpentCard title="This link has expired." />
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

function JoinForm({
  subjectName,
  token,
  onJoined,
}: {
  subjectName: string;
  token: string;
  onJoined: (spaceId: string) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !relationship.trim()) {
      setError("Add your name and how you knew them.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await api.joinInvite(token, {
        display_name: name.trim(),
        relationship_to_subject: relationship.trim(),
      });
      await onJoined(res.space_id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        setError(
          "That invite link was already used or has expired. Ask your family to send a fresh one."
        );
      } else {
        setError(err instanceof ApiError ? err.message : GENERIC);
      }
      setSaving(false);
    }
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <div>
        <h1 className="section-title">Help tell {firstName(subjectName)}'s story.</h1>
        <p className="section-sub">
          Your family wants to remember them in your voice too.
        </p>
      </div>
      <label className="field">
        Your name
        <input
          className="input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          required
        />
      </label>
      <label className="field">
        You are their
        <input
          className="input"
          type="text"
          value={relationship}
          onChange={(e) => setRelationship(e.target.value)}
          placeholder="sister, nephew, oldest friend"
          autoComplete="off"
          required
        />
      </label>
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
      <button className="btn btn-primary btn-block" type="submit" disabled={saving}>
        {saving ? "Opening your space..." : "Start talking"}
      </button>
    </form>
  );
}

function SpentCard({ title }: { title: string }) {
  return (
    <div className="card">
      <h1 className="section-title">{title}</h1>
      <p className="section-sub">Ask your family to send a fresh one.</p>
    </div>
  );
}

function JoinSkeleton() {
  return (
    <div className="stack" aria-busy="true" aria-label="Opening your invite">
      <div className="card stack">
        <div className="skeleton sk-line" style={{ width: "70%", height: "1.6rem" }} />
        <div className="skeleton sk-line" style={{ width: "90%" }} />
        <div className="skeleton sk-card" style={{ height: "52px" }} />
        <div className="skeleton sk-card" style={{ height: "52px" }} />
      </div>
    </div>
  );
}
