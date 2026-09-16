import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, signIn, type TestContext } from "./helpers.js";
import { sha256Hex } from "../src/lib/crypto.js";

async function createSpace(ctx: TestContext, cookie: string, name: string): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/spaces",
    headers: { cookie },
    payload: { subject_name: name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

/** Pull the token out of a create response's one-time URL. */
function tokenFromUrl(url: string): string {
  return url.split("/join/")[1];
}

/** The session cookie a join response set, ready to send on later requests. */
function cookieFromJoin(res: { cookies: { name: string; value: string }[] }): string {
  const c = res.cookies.find((x) => x.name === "atl_session");
  if (!c) throw new Error("no session cookie set on join");
  return `atl_session=${c.value}`;
}

describe("invite lifecycle", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.db.close();
  });

  it("organizer creates an invite: 201 with a join URL, hash stored, 14-day expiry", async () => {
    const cookie = await signIn(ctx.app, "org-create@example.com");
    const spaceId = await createSpace(ctx, cookie, "Anne Delgado");

    const res = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/invites`,
      headers: { cookie },
      payload: { label: "Aunt Carol" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.url).toContain("/join/");
    expect(body.label).toBe("Aunt Carol");
    expect(body.status).toBe("pending");

    const token = tokenFromUrl(body.url);
    const row = await ctx.db.query<{ token_hash: string; expires_at: string }>(
      "SELECT token_hash, expires_at FROM invites WHERE id = $1",
      [body.id]
    );
    // The raw token is never stored, only its hash.
    expect(row.rows[0].token_hash).toBe(sha256Hex(token));
    expect(row.rows[0].token_hash).not.toBe(token);
    // Expires roughly 14 days out.
    const days = (new Date(row.rows[0].expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
  });

  it("blocks a contributor, a non-member, and an unknown space", async () => {
    const organizer = await signIn(ctx.app, "org-guard@example.com");
    const spaceId = await createSpace(ctx, organizer, "Marcus Reed");

    // A contributor joins by invite, then tries to create one.
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/invites`,
      headers: { cookie: organizer },
      payload: {},
    });
    const token = tokenFromUrl(invite.json().url);
    const joined = await ctx.app.inject({
      method: "POST",
      url: `/invite/${token}/join`,
      payload: { display_name: "Carol", relationship_to_subject: "sister" },
    });
    const contributor = cookieFromJoin(joined);
    const asContributor = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/invites`,
      headers: { cookie: contributor },
      payload: {},
    });
    expect(asContributor.statusCode).toBe(403);

    const stranger = await signIn(ctx.app, "org-stranger@example.com");
    const asStranger = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/invites`,
      headers: { cookie: stranger },
      payload: {},
    });
    expect(asStranger.statusCode).toBe(403);

    const unknown = await ctx.app.inject({
      method: "POST",
      url: "/spaces/11111111-1111-1111-1111-111111111111/invites",
      headers: { cookie: stranger },
      payload: {},
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("lists invites newest-first with joined details and never a token or email", async () => {
    const cookie = await signIn(ctx.app, "org-list@example.com");
    const spaceId = await createSpace(ctx, cookie, "Rosa Ferrer");

    const first = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/invites`,
      headers: { cookie },
      payload: { label: "For Carol" },
    });
    const second = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/invites`,
      headers: { cookie },
      payload: { label: "For Sam" },
    });
    // Join the first so it reads as "joined" with a person.
    await ctx.app.inject({
      method: "POST",
      url: `/invite/${tokenFromUrl(first.json().url)}/join`,
      payload: { display_name: "Carol", relationship_to_subject: "sister" },
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/invites`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const invites = list.json().invites;
    expect(invites).toHaveLength(2);
    // Newest first.
    expect(invites[0].label).toBe("For Sam");
    expect(invites[0].status).toBe("pending");

    const joinedRow = invites.find((i: { label: string }) => i.label === "For Carol");
    expect(joinedRow.status).toBe("joined");
    expect(joinedRow.joined.display_name).toBe("Carol");
    expect(joinedRow.joined.relationship_to_subject).toBe("sister");

    // No token, hash, or email ever leaves the API.
    const text = JSON.stringify(list.json());
    expect(text).not.toContain("token");
    expect(text).not.toContain("@");
    expect(second.statusCode).toBe(201);
  });

  it("previews a live link, hides the subject on spent ones, and 404s an unknown token", async () => {
    const cookie = await signIn(ctx.app, "org-preview@example.com");
    const spaceId = await createSpace(ctx, cookie, "Nadia Hart");
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/invites`,
      headers: { cookie },
      payload: {},
    });
    const token = tokenFromUrl(invite.json().url);

    const preview = await ctx.app.inject({ method: "GET", url: `/invite/${token}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ status: "ready", subject_name: "Nadia Hart" });

    // Previewing does not consume: the invite is still pending afterwards.
    const stillPending = await ctx.db.query<{ status: string }>(
      "SELECT status FROM invites WHERE id = $1",
      [invite.json().id]
    );
    expect(stillPending.rows[0].status).toBe("pending");

    // After a join, the preview reads "used" and carries no subject name.
    await ctx.app.inject({
      method: "POST",
      url: `/invite/${token}/join`,
      payload: { display_name: "Sam", relationship_to_subject: "nephew" },
    });
    const used = await ctx.app.inject({ method: "GET", url: `/invite/${token}` });
    expect(used.json()).toEqual({ status: "used" });

    const unknown = await ctx.app.inject({
      method: "GET",
      url: `/invite/${"z".repeat(43)}`,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("join creates a guest user, contributor membership, and a session in one step", async () => {
    const cookie = await signIn(ctx.app, "org-join@example.com");
    const spaceId = await createSpace(ctx, cookie, "Theo Lang");
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/invites`,
      headers: { cookie },
      payload: {},
    });
    const token = tokenFromUrl(invite.json().url);

    const joined = await ctx.app.inject({
      method: "POST",
      url: `/invite/${token}/join`,
      payload: { display_name: "Carol", relationship_to_subject: "sister" },
    });
    expect(joined.statusCode).toBe(201);
    expect(joined.json().space_id).toBe(spaceId);
    const guest = cookieFromJoin(joined);

    // The membership is a contributor in exactly this space, carrying the
    // relationship and the invite_id.
    const membership = await ctx.db.query<{
      role: string;
      relationship_to_subject: string;
      invite_id: string | null;
      email: string | null;
    }>(
      `SELECT m.role, m.relationship_to_subject, m.invite_id, u.email
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.space_id = $1 AND m.invite_id IS NOT NULL`,
      [spaceId]
    );
    expect(membership.rows).toHaveLength(1);
    expect(membership.rows[0].role).toBe("contributor");
    expect(membership.rows[0].relationship_to_subject).toBe("sister");
    expect(membership.rows[0].invite_id).toBe(invite.json().id);
    expect(membership.rows[0].email).toBeNull();

    // The guest can read /me (null email), open the space, and start a session.
    const me = await ctx.app.inject({ method: "GET", url: "/me", headers: { cookie: guest } });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBeNull();
    expect(me.json().display_name).toBe("Carol");

    const space = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}`,
      headers: { cookie: guest },
    });
    expect(space.statusCode).toBe(200);

    const session = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/sessions`,
      headers: { cookie: guest },
    });
    expect([200, 201]).toContain(session.statusCode);

    // A guest has no key surface: every credential route is 403.
    for (const method of ["GET", "DELETE"] as const) {
      const res = await ctx.app.inject({
        method,
        url: "/me/llm-credential",
        headers: { cookie: guest },
      });
      expect(res.statusCode, method).toBe(403);
    }
    const put = await ctx.app.inject({
      method: "PUT",
      url: "/me/llm-credential",
      headers: { cookie: guest },
      payload: { base_url: "https://api.openai.com/v1", api_key: "sk-x" },
    });
    expect(put.statusCode).toBe(403);
  });

  it("a spent or expired link returns 410 and creates nothing", async () => {
    const cookie = await signIn(ctx.app, "org-spent@example.com");
    const spaceId = await createSpace(ctx, cookie, "Vera Cole");
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/invites`,
      headers: { cookie },
      payload: {},
    });
    const token = tokenFromUrl(invite.json().url);

    await ctx.app.inject({
      method: "POST",
      url: `/invite/${token}/join`,
      payload: { display_name: "Carol", relationship_to_subject: "sister" },
    });
    const second = await ctx.app.inject({
      method: "POST",
      url: `/invite/${token}/join`,
      payload: { display_name: "Someone", relationship_to_subject: "cousin" },
    });
    expect(second.statusCode).toBe(410);

    // An expired pending link: force expiry, then join is 410 and adds nothing.
    const expInvite = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/invites`,
      headers: { cookie },
      payload: {},
    });
    const expToken = tokenFromUrl(expInvite.json().url);
    await ctx.db.query(
      "UPDATE invites SET expires_at = now() - interval '1 day' WHERE id = $1",
      [expInvite.json().id]
    );
    const before = await ctx.db.query<{ n: string }>(
      "SELECT COUNT(*)::int AS n FROM memberships WHERE space_id = $1",
      [spaceId]
    );
    const expired = await ctx.app.inject({
      method: "POST",
      url: `/invite/${expToken}/join`,
      payload: { display_name: "Late", relationship_to_subject: "friend" },
    });
    expect(expired.statusCode).toBe(410);
    const after = await ctx.db.query<{ n: string }>(
      "SELECT COUNT(*)::int AS n FROM memberships WHERE space_id = $1",
      [spaceId]
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("a signed-in non-member joins onto their own user with no new row", async () => {
    const cookie = await signIn(ctx.app, "org-signed@example.com");
    const spaceId = await createSpace(ctx, cookie, "Ida Frank");
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/invites`,
      headers: { cookie },
      payload: {},
    });
    const token = tokenFromUrl(invite.json().url);

    const joinerCookie = await signIn(ctx.app, "joiner@example.com");
    const before = await ctx.db.query<{ n: string }>("SELECT COUNT(*)::int AS n FROM users");
    const joined = await ctx.app.inject({
      method: "POST",
      url: `/invite/${token}/join`,
      headers: { cookie: joinerCookie },
      payload: { display_name: "ignored", relationship_to_subject: "brother" },
    });
    expect(joined.statusCode).toBe(201);
    expect(joined.json().space_id).toBe(spaceId);
    const after = await ctx.db.query<{ n: string }>("SELECT COUNT(*)::int AS n FROM users");
    // No new user row: they joined onto their existing account.
    expect(after.rows[0].n).toBe(before.rows[0].n);
    // Their existing email is untouched (display_name was ignored).
    const row = await ctx.db.query<{ relationship_to_subject: string }>(
      `SELECT m.relationship_to_subject FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.space_id = $1 AND u.email = 'joiner@example.com'`,
      [spaceId]
    );
    expect(row.rows[0].relationship_to_subject).toBe("brother");
  });

  it("a signed-in member opening the link gets already_member without spending it", async () => {
    const cookie = await signIn(ctx.app, "org-self@example.com");
    const spaceId = await createSpace(ctx, cookie, "Owen Pike");
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/invites`,
      headers: { cookie },
      payload: {},
    });
    const token = tokenFromUrl(invite.json().url);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/invite/${token}/join`,
      headers: { cookie },
      payload: { display_name: "Owen", relationship_to_subject: "son" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().already_member).toBe(true);
    expect(res.json().space_id).toBe(spaceId);

    // The token stays pending: the organizer can still send it to a relative.
    const stillPending = await ctx.db.query<{ status: string }>(
      "SELECT status FROM invites WHERE id = $1",
      [invite.json().id]
    );
    expect(stillPending.rows[0].status).toBe("pending");
  });
});
