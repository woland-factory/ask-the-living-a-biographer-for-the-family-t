export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const GENERIC = "That didn't work. Check your connection and try again.";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      ...init,
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
};
