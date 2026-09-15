import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { api, ApiError, type LlmCredential } from "../api";

const GENERIC = "That didn't work. Check your connection and try again.";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

type View =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; cred: LlmCredential };

export function Settings() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setView({ kind: "loading" });
    try {
      const cred = await api.getLlmCredential();
      setView({ kind: "ready", cred });
      setShowForm(!cred.configured);
    } catch {
      setView({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <TopBar />
      <main className="page">
        {view.kind === "loading" && <SettingsSkeleton />}

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
            <div>
              <h1 className="section-title">Follow-up questions</h1>
              <p className="section-sub">
                With your own model key, the interview can ask one gentle
                follow-up drawn from what you just said. Your key is stored for
                you alone and sent only to the address you enter. Without a key,
                the interview runs from the curated questions.
              </p>
            </div>

            {view.cred.configured && !showForm ? (
              <ConnectedCard
                cred={view.cred}
                onReplace={() => setShowForm(true)}
                onRemoved={load}
              />
            ) : (
              <CredentialForm
                cred={view.cred}
                onSaved={(cred) => {
                  setView({ kind: "ready", cred });
                  setShowForm(false);
                }}
                onCancel={view.cred.configured ? () => setShowForm(false) : undefined}
              />
            )}

            <Link className="btn btn-quiet" to="/">
              Back to your spaces
            </Link>
          </div>
        )}
      </main>
    </>
  );
}

function ConnectedCard({
  cred,
  onReplace,
  onRemoved,
}: {
  cred: LlmCredential;
  onReplace: () => void;
  onRemoved: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");

  const remove = async () => {
    setRemoving(true);
    setError("");
    try {
      await api.deleteLlmCredential();
      onRemoved();
    } catch {
      setError(GENERIC);
      setRemoving(false);
    }
  };

  return (
    <article className="card stack">
      <div className="cred-connected" role="status">
        <span className="cred-dot" aria-hidden="true" />
        <span>Follow-ups are on. Key ending in {cred.key_last4}</span>
      </div>
      <dl className="cred-details">
        {cred.provider_label && (
          <div className="cred-row">
            <dt>Provider</dt>
            <dd>{cred.provider_label}</dd>
          </div>
        )}
        <div className="cred-row">
          <dt>Endpoint</dt>
          <dd className="cred-mono">{cred.base_url}</dd>
        </div>
        <div className="cred-row">
          <dt>Model</dt>
          <dd className="cred-mono">{cred.model}</dd>
        </div>
      </dl>
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
      <div className="record-actions">
        <button className="btn btn-quiet" type="button" onClick={onReplace}>
          Use a different key
        </button>
        <button
          className="btn btn-quiet cred-remove"
          type="button"
          onClick={remove}
          disabled={removing}
        >
          {removing ? "Removing..." : "Remove key"}
        </button>
      </div>
    </article>
  );
}

function CredentialForm({
  cred,
  onSaved,
  onCancel,
}: {
  cred: LlmCredential;
  onSaved: (cred: LlmCredential) => void;
  onCancel?: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(cred.base_url || DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(cred.model || "gpt-4o-mini");
  const [providerLabel, setProviderLabel] = useState(cred.provider_label || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) {
      setError("Enter your API key to save.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const saved = await api.saveLlmCredential({
        base_url: baseUrl.trim(),
        api_key: apiKey.trim(),
        model: model.trim() || "gpt-4o-mini",
        provider_label: providerLabel.trim(),
      });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : GENERIC);
      setSaving(false);
    }
  };

  return (
    <form className="card stack" onSubmit={submit}>
      {cred.gateway_available && !cred.configured && (
        <div className="notice notice-info" role="status">
          Gentle follow-ups already work for you through a shared model. Add
          your own key to use your account instead.
        </div>
      )}
      <label className="field">
        Model endpoint
        <span className="hint">Works with any OpenAI-compatible API.</span>
        <input
          className="input"
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          autoComplete="off"
          required
        />
      </label>
      <label className="field">
        API key
        <span className="hint">Stored encrypted. Only the last four show.</span>
        <input
          className="input"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={cred.configured ? "Enter a new key" : "sk-..."}
          autoComplete="off"
          required
        />
      </label>
      <div className="row">
        <label className="field">
          Model
          <input
            className="input"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="field">
          Provider name
          <span className="hint">Optional.</span>
          <input
            className="input"
            type="text"
            value={providerLabel}
            onChange={(e) => setProviderLabel(e.target.value)}
            placeholder="OpenAI"
            autoComplete="off"
          />
        </label>
      </div>
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
      <div className="record-actions">
        <button className="btn btn-primary btn-block" type="submit" disabled={saving}>
          {saving ? "Saving..." : "Save key"}
        </button>
        {onCancel && (
          <button className="btn btn-quiet" type="button" onClick={onCancel}>
            Keep current key
          </button>
        )}
      </div>
    </form>
  );
}

function SettingsSkeleton() {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading settings">
      <div className="skeleton sk-line" style={{ width: "50%", height: "1.6rem" }} />
      <div className="skeleton sk-line" style={{ width: "90%" }} />
      <div className="card stack">
        <div className="skeleton sk-line" style={{ width: "40%" }} />
        <div className="skeleton sk-card" style={{ height: "52px" }} />
        <div className="skeleton sk-card" style={{ height: "52px" }} />
      </div>
    </div>
  );
}
