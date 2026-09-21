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
  email: string | null;
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

export type FollowupOrigin = "followup" | "crosstelling";

export interface Followup {
  id: string;
  text: string;
  topic: string;
  routed: boolean;
  origin?: FollowupOrigin;
}

export interface SessionProgress {
  session: Session;
  answered_keys: string[];
  deferred_topics: string[];
  answers: AnswerSummary[];
  followups: Followup[];
}

export interface LlmCredential {
  configured: boolean;
  provider_label?: string | null;
  base_url?: string;
  model?: string;
  key_last4?: string;
  gateway_available: boolean;
}

export type QuestionStatus = "open" | "answered" | "deferred" | "lost";
export type QuestionOrigin = "bank" | "followup" | "crosstelling";

export interface Question {
  id: string;
  text: string;
  topic: string;
  origin: QuestionOrigin;
  status: QuestionStatus;
  membership_id: string | null;
  parent_answer_id: string | null;
  assigned_to: string | null;
  created_at: string;
}

export interface QuestionCounts {
  open: number;
  answered: number;
  deferred: number;
  lost: number;
  total: number;
}

export interface Person {
  membership_id: string;
  relationship_to_subject: string | null;
  display_name: string | null;
}

export interface Invite {
  id: string;
  label: string | null;
  status: "pending" | "joined" | "expired";
  expires_at: string;
  created_at: string;
  joined: {
    display_name: string | null;
    relationship_to_subject: string | null;
  } | null;
}

export interface CreatedInvite {
  id: string;
  url: string;
  label: string | null;
  status: "pending";
  expires_at: string;
  created_at: string;
}

export interface InvitePreview {
  status: "ready" | "used" | "expired";
  subject_name?: string;
}

export interface GapMap {
  questions: Question[];
  counts: QuestionCounts;
  people: Person[];
  topics: string[];
}

export interface QuestionFilters {
  status?: QuestionStatus;
  topic?: string;
  membership_id?: string;
}

// A grouping candidate: one of the caller's own answers, or (for the organizer)
// another member's safe metadata. Never another member's transcript.
export interface Telling {
  answer_id: string;
  membership_id: string;
  relationship_to_subject: string | null;
  display_name: string | null;
  topic: string;
  prompt_text: string;
  story_id: string | null;
  transcript_status: TranscriptStatus;
  created_at: string;
  is_own: boolean;
}

export interface StorySummary {
  id: string;
  label: string;
  teller_count: number;
  ready: boolean;
  created_at: string;
}

export interface CreatedStory {
  id: string;
  label: string;
  created_at: string;
}

export interface CrossQuestion {
  id: string;
  text: string;
  topic: string;
}

export interface TellingAnswer {
  id: string;
  topic: string;
  prompt_text: string;
  transcript: string | null;
  transcript_status: TranscriptStatus;
  duration_ms: number;
  has_audio: boolean;
  audio_url: string | null;
  created_at: string;
}

export interface TellingColumn {
  membership_id: string;
  relationship_to_subject: string | null;
  display_name: string | null;
  answers: TellingAnswer[];
  open_question: CrossQuestion | null;
}

export interface SideBySide {
  story: { id: string; label: string; created_at: string };
  tellings: TellingColumn[];
}

export interface StorySuggestions {
  mode: string;
  suggestions: { story_id: string; label: string }[];
  suggested_label: string | null;
}

export interface TagResult {
  answer_id: string;
  story_id: string | null;
  generated: number;
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
      question_id?: string;
    }
  ) =>
    request<{ id: string; transcript_status: TranscriptStatus }>(
      `/sessions/${sessionId}/answers`,
      { method: "POST", body: JSON.stringify(input) }
    ),
  generateFollowups: (answerId: string) =>
    request<{ followups: Followup[]; mode: string }>(
      `/answers/${answerId}/followups`,
      { method: "POST" }
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

  getLlmCredential: () => request<LlmCredential>("/me/llm-credential"),
  saveLlmCredential: (input: {
    base_url: string;
    api_key: string;
    model?: string;
    provider_label?: string;
  }) =>
    request<LlmCredential>("/me/llm-credential", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteLlmCredential: () =>
    request<void>("/me/llm-credential", { method: "DELETE" }),

  getQuestions: (spaceId: string, filters: QuestionFilters = {}) => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.topic) params.set("topic", filters.topic);
    if (filters.membership_id) params.set("membership_id", filters.membership_id);
    const qs = params.toString();
    return request<GapMap>(`/spaces/${spaceId}/questions${qs ? `?${qs}` : ""}`);
  },
  patchQuestion: (questionId: string, status: QuestionStatus) =>
    request<Question>(`/questions/${questionId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  routeQuestion: (questionId: string, membershipId: string | null) =>
    request<Question>(`/questions/${questionId}/route`, {
      method: "POST",
      body: JSON.stringify({ membership_id: membershipId }),
    }),

  createInvite: (spaceId: string, label?: string) =>
    request<CreatedInvite>(`/spaces/${spaceId}/invites`, {
      method: "POST",
      body: JSON.stringify(label ? { label } : {}),
    }),
  listInvites: (spaceId: string) =>
    request<{ invites: Invite[] }>(`/spaces/${spaceId}/invites`),
  previewInvite: (token: string) =>
    request<InvitePreview>(`/invite/${encodeURIComponent(token)}`),
  joinInvite: (
    token: string,
    input: { display_name: string; relationship_to_subject: string }
  ) =>
    request<{ space_id: string; already_member?: boolean }>(
      `/invite/${encodeURIComponent(token)}/join`,
      { method: "POST", body: JSON.stringify(input) }
    ),

  getTellings: (spaceId: string) =>
    request<{ tellings: Telling[] }>(`/spaces/${spaceId}/tellings`),
  createStory: (spaceId: string, label: string) =>
    request<CreatedStory>(`/spaces/${spaceId}/stories`, {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
  tagAnswerStory: (answerId: string, storyId: string | null) =>
    request<TagResult>(`/answers/${answerId}/story`, {
      method: "POST",
      body: JSON.stringify({ story_id: storyId }),
    }),
  suggestStory: (answerId: string) =>
    request<StorySuggestions>(`/answers/${answerId}/story-suggestions`, {
      method: "POST",
    }),
  listStories: (spaceId: string) =>
    request<{ stories: StorySummary[] }>(`/spaces/${spaceId}/stories`),
  getStory: (spaceId: string, storyId: string) =>
    request<SideBySide>(`/spaces/${spaceId}/stories/${storyId}`),
  getDemoStory: () => request<SideBySide>("/demo/story"),
};
