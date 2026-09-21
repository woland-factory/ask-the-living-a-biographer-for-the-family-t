import type { FastifyInstance } from "fastify";
import archiver from "archiver";
import type { Db } from "../db/index.js";
import { copy } from "../lib/copy.js";
import { isUuid } from "../lib/crypto.js";
import { makeRequireAuth } from "../lib/session.js";
import { archiveRootName, collectArchiveEntries } from "../lib/export.js";

interface Membership {
  id: string;
  role: string;
}

async function memberOf(
  db: Db,
  userId: string,
  spaceId: string
): Promise<Membership | null> {
  const { rows } = await db.query<Membership>(
    "SELECT id, role FROM memberships WHERE space_id = $1 AND user_id = $2",
    [spaceId, userId]
  );
  return rows[0] ?? null;
}

export function registerExportRoutes(app: FastifyInstance, db: Db): void {
  const requireAuth = makeRequireAuth(db);

  // The organizer's custodial download of the whole space: one ZIP with every
  // recording, transcript, story, and the gap map, in open formats. Read-only.
  // Heavy, so it carries its own tight rate limit on top of the global one.
  app.get(
    "/spaces/:id/export",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!isUuid(id)) return reply.code(404).send({ error: copy.notFound });

      const membership = await memberOf(db, req.user!.id, id);
      if (!membership) {
        const exists = await db.query("SELECT 1 FROM spaces WHERE id = $1", [id]);
        if (exists.rows.length === 0)
          return reply.code(404).send({ error: copy.notFound });
        return reply.code(403).send({ error: copy.forbidden });
      }
      // Export is organizer-only. A contributor who is a member still cannot
      // pull the whole space. Hiding the button is not the control; this is.
      if (membership.role !== "organizer") {
        return reply.code(403).send({ error: copy.exportOrganizerOnly });
      }

      const space = await db.query<{ subject_name: string }>(
        "SELECT subject_name FROM spaces WHERE id = $1",
        [id]
      );
      const subjectName = space.rows[0]?.subject_name ?? "family";

      // Gather everything BEFORE streaming a single byte, so a collection
      // failure is a clean 500 through the normal error handler rather than a
      // half-written archive. archiveRootName is ASCII-only, so the quoted
      // filename is ASCII-safe; the filename* carries the same value for
      // clients that prefer it.
      const exportedAt = new Date().toISOString();
      const entries = await collectArchiveEntries(db, id, exportedAt);

      const filename = `${archiveRootName(subjectName, exportedAt)}.zip`;
      const encoded = encodeURIComponent(filename);
      reply
        .header("Content-Type", "application/zip")
        .header(
          "Content-Disposition",
          `attachment; filename="${filename}"; filename*=UTF-8''${encoded}`
        )
        .header("Cache-Control", "private, no-store");

      const archive = archiver("zip");
      // A mid-stream failure aborts the connection; the client shows its error
      // state. Log without leaking any archive content.
      archive.on("error", (err) => {
        req.log.error({ err }, "export archive failed mid-stream");
      });

      const sent = reply.send(archive);
      for (const item of entries) {
        // Audio is already compressed; store it without recompressing.
        const store = item.path.includes("/audio/");
        archive.append(item.content, { name: item.path, store });
      }
      void archive.finalize();
      return sent;
    }
  );
}
