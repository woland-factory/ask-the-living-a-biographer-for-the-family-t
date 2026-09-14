export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const GENERIC = "That didn't work. Check your connection and try again.";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers: initHeaders, ...rest } = init ?? {};
  // Only declare a JSON body when there actually is one. A bodyless POST with
  // a JSON content-type makes the server try to parse an empty body and 400.
  const headers: Record<string, string> = {
    ...(init?.body != null ? { "content-type": "application/json" } : {}),
    ...(initHeaders as Record<string, string> | undefined),
  };
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      ...rest,
      headers,
    });
  } catch {
    throw new ApiError(0, GENERIC);
  }

  if (res.status === 204) return undefined as T;

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const message =
      (body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : "") || GENERIC;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

export interface Me {
  id: string;
  email: string;
  display_name: string | null;
}

export interface Space {
  id: string;
  subject_name: string;
  subject_birth_year: number | null;
  subject_death_year: number | null;
  created_at?: string;
  role?: string;
}

export type TranscriptStatus = "pending" | "done" | "failed";

export interface Session {
  id: string;
  space_id: string;
  membership_id: string;
  started_at: string;
  ended_at: string | null;
}

export interface AnswerSummary {
  id: string;
  bank_question_key: string;
  prompt_text: string;
  topic: string;
  duration_ms: number;
  transcript_status: TranscriptStatus;
  transcript: string | null;
  created_at: string;
}

export interface SessionProgress {
  session: Session;
  answered_keys: string[];
  deferred_topics: string[];
  answers: AnswerSummary[];
}

export const api = {
  me: () => request<Me>("/me"),
  requestMagicLink: (email: string) =>
    request<{ ok: true }>("/auth/magic-link", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  listSpaces: () => request<{ spaces: Space[] }>("/spaces"),
  createSpace: (input: {
    subject_name: string;
    subject_birth_year?: number | null;
    subject_death_year?: number | null;
  }) =>
    request<Space>("/spaces", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getSpace: (id: string) => request<Space>(`/spaces/${id}`),

  startSession: (spaceId: string) =>
    request<Session>(`/spaces/${spaceId}/sessions`, { method: "POST" }),
  getSession: (sessionId: string) =>
    request<SessionProgress>(`/sessions/${sessionId}`),
  createAnswer: (
    sessionId: string,
    input: {
      bank_question_key: string;
      prompt_text: string;
      topic: string;
      duration_ms: number;
    }
  ) =>
    request<{ id: string; transcript_status: TranscriptStatus }>(
      `/sessions/${sessionId}/answers`,
      { method: "POST", body: JSON.stringify(input) }
    ),
  uploadAudio: async (answerId: string, blob: Blob) => {
    // Raw octet-stream body. Do not send the default JSON content-type.
    // Strip any ";codecs=..." so the mime matches the server's allow-list.
    const mime = (blob.type || "audio/webm").split(";")[0].trim();
    let res: Response;
    try {
      res = await fetch(
        `/answers/${answerId}/audio?mime=${encodeURIComponent(mime)}`,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: { "content-type": "application/octet-stream" },
          body: blob,
        }
      );
    } catch {
      throw new ApiError(0, GENERIC);
    }
    if (!res.ok) {
      let message = GENERIC;
      const text = await res.text();
      if (text) {
        try {
          const body = JSON.parse(text);
          if (body && typeof body === "object" && "error" in body) {
            message = String((body as { error: unknown }).error) || GENERIC;
          }
        } catch {
          /* keep generic */
        }
      }
      throw new ApiError(res.status, message);
    }
  },
  attachTranscript: (
    answerId: string,
    input: { transcript_status: "done" | "failed"; transcript?: string }
  ) =>
    request<AnswerSummary>(`/answers/${answerId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  fetchAudio: async (answerId: string): Promise<Blob> => {
    let res: Response;
    try {
      res = await fetch(`/answers/${answerId}/audio`, {
        credentials: "same-origin",
      });
    } catch {
      throw new ApiError(0, GENERIC);
    }
    if (!res.ok) throw new ApiError(res.status, GENERIC);
    return res.blob();
  },
  deferTopic: (sessionId: string, topic: string) =>
    request<{ ok: true }>(`/sessions/${sessionId}/defer`, {
      method: "POST",
      body: JSON.stringify({ topic }),
    }),
  completeSession: (sessionId: string) =>
    request<{ id: string; ended_at: string; answered_count: number }>(
      `/sessions/${sessionId}/complete`,
      { method: "POST" }
    ),
  audioUrl: (answerId: string) => `/answers/${answerId}/audio`,
};
