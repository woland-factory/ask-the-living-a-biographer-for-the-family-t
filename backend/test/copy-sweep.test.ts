import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("copy sweep", () => {
  it("passes on all user-visible strings", () => {
    // Runs the real sweep script; throws (failing the test) on any violation.
    const out = execFileSync("node", ["scripts/copy-sweep.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(out).toContain("Copy sweep passed");
  });
});
