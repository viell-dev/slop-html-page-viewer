import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

// Load the source module at its real path: npm test bundles this test into dist/test.
// eslint-disable-next-line no-unsanitized/method -- Fixed repository-owned source path, never external input.
const { selectedSpecs, rejectSpecArguments } = (await import(
  pathToFileURL(path.resolve("scripts/e2e-selection.ts")).href
)) as typeof import("../scripts/e2e-selection.ts");

describe("focused end-to-end selection", () => {
  it("selects ordinary spec names and rejects unknown, empty and path selections", () => {
    assert.equal(selectedSpecs(" "), undefined);
    assert.deepEqual(selectedSpecs(" viewer.e2e.ts,links.e2e.ts,viewer.e2e.ts "), [
      "viewer.e2e.ts",
      "links.e2e.ts",
    ]);
    for (const value of ["missing.e2e.ts", "specs/viewer.e2e.ts", "viewer.e2e.ts,"])
      assert.throws(() => selectedSpecs(value), /Unknown E2E_ONLY selection/);
    for (const args of [
      ["--spec", "specs/viewer.e2e.ts"],
      ["--spec=specs/viewer.e2e.ts"],
      ["--suite", "viewer"],
      ["--exclude=corpus"],
    ])
      assert.throws(() => rejectSpecArguments(args), /use E2E_ONLY/);
  });

  it("rejects raw spec arguments before Docker or host startup", () => {
    for (const script of ["scripts/e2e-docker.mjs", "scripts/e2e-selection.ts"]) {
      const run = spawnSync(process.execPath, [script, "--spec", "specs/viewer.e2e.ts"], {
        encoding: "utf8",
      });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /use E2E_ONLY/);
    }
  });

  it("retains missing-results failure for full and corpus runs", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hpv-selection-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const [only, status] of [
      ["", 1],
      ["corpus.e2e.ts", 1],
      ["viewer.e2e.ts", 0],
      ["missing.e2e.ts", 1],
    ] as const) {
      const run = spawnSync(process.execPath, ["test/e2e/corpus/compare.mjs", directory], {
        env: { ...process.env, E2E_ONLY: only },
        encoding: "utf8",
      });
      assert.equal(run.status, status, run.stderr);
    }
  });
});
