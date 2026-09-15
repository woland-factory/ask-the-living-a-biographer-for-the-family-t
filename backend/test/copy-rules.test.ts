import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { COPY_CHECKS, copyViolations } from "../src/lib/copy-rules.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("copyViolations", () => {
  it("catches em-dashes, banned vocabulary, and negative phrasing", () => {
    expect(copyViolations("A gentle line — with an aside")).toContain("em-dash");
    expect(copyViolations("We leverage robust tooling")).toContain("banned vocabulary");
    expect(copyViolations("You don't have any answers")).toContain(
      "negative phrasing (you don't have)"
    );
    expect(copyViolations("No memories yet")).toContain("negative phrasing (no ... yet)");
    expect(copyViolations("Something went wrong")).toContain(
      "negative phrasing (something went wrong)"
    );
  });

  it("passes clean, warm copy", () => {
    expect(copyViolations("What did his coffee mornings look like?")).toEqual([]);
    expect(copyViolations("Add your first memory to begin.")).toEqual([]);
  });
});

describe("anti-drift: runtime checks cover the static sweep", () => {
  it("includes every regex the static copy-sweep script lists", () => {
    const src = readFileSync(path.join(root, "scripts", "copy-sweep.mjs"), "utf8");
    // Pull each `re: /.../flags` literal out of the static script.
    const staticPatterns = [...src.matchAll(/re:\s*(\/(?:\\.|[^/\\\n])+\/[a-z]*)/g)].map(
      (m) => m[1]
    );
    expect(staticPatterns.length).toBeGreaterThan(0);

    const runtime = new Set(COPY_CHECKS.map((c) => c.re.toString()));
    for (const pattern of staticPatterns) {
      expect(runtime, `runtime is missing static pattern ${pattern}`).toContain(pattern);
    }
  });
});
