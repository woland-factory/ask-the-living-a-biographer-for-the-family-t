import { useState } from "react";
import { api, ApiError, type Space } from "../api";

function parseYear(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : NaN;
}

export function CreateSpaceForm({
  onCreated,
  submitLabel = "Create a space",
}: {
  onCreated: (space: Space) => void;
  submitLabel?: string;
}) {
  const [name, setName] = useState("");
  const [birth, setBirth] = useState("");
  const [death, setDeath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;

    const birthYear = parseYear(birth);
    const deathYear = parseYear(death);
    if (Number.isNaN(birthYear) || Number.isNaN(deathYear)) {
      setError("Please enter years as numbers, like 1949.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const space = await api.createSpace({
        subject_name: name.trim(),
        subject_birth_year: birthYear,
        subject_death_year: deathYear,
      });
      onCreated(space);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "That didn't work. Check your connection and try again."
      );
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate>
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
      <div className="field">
        <label htmlFor="subject_name">Who are we remembering?</label>
        <input
          id="subject_name"
          className="input"
          type="text"
          required
          maxLength={120}
          placeholder="Margaret Ellison"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label>
          Years <span className="hint">(optional)</span>
        </label>
        <div className="row">
          <div className="field" style={{ marginBottom: 0 }}>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              placeholder="Born, e.g. 1949"
              aria-label="Birth year"
              value={birth}
              onChange={(e) => setBirth(e.target.value)}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              placeholder="Died, e.g. 2026"
              aria-label="Death year"
              value={death}
              onChange={(e) => setDeath(e.target.value)}
            />
          </div>
        </div>
      </div>
      <button
        type="submit"
        className="btn btn-primary btn-block"
        disabled={busy || name.trim().length === 0}
      >
        {busy ? "Creating..." : submitLabel}
      </button>
    </form>
  );
}
