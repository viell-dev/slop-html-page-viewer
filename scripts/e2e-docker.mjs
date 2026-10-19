// Runs the end-to-end suite in Docker, on any system with Docker, Windows
// included: builds test/e2e/Dockerfile from this checkout and runs it.
// Arguments go to `wdio run`, such as `--spec specs/viewer.e2e.ts`.
//
// OBSIDIAN_VERSIONS picks the Obsidian versions and E2E_ONLY the spec files, as in
// test/e2e/wdio.conf.mts.
// Downloaded versions stay in the named volume `html-page-viewer-obsidian-cache`;
// screenshots and logs go to test-results/e2e.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const image = "html-page-viewer-e2e";
const cacheVolume = "html-page-viewer-obsidian-cache";
const output = path.resolve("test-results", "e2e");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

fs.mkdirSync(output, { recursive: true });
// The container's user can differ from the host's on Linux and macOS.
if (process.platform !== "win32") fs.chmodSync(output, 0o777);

const versions = process.env.OBSIDIAN_VERSIONS;
run("docker", ["build", "--file", "test/e2e/Dockerfile", "--tag", image, "."]);
run("docker", [
  "run",
  "--rm",
  "--init",
  "--shm-size=1g",
  ...(versions === undefined ? [] : ["--env", `OBSIDIAN_VERSIONS=${versions}`]),
  ...(process.env.E2E_ONLY === undefined ? [] : ["--env", `E2E_ONLY=${process.env.E2E_ONLY}`]),
  "--volume",
  `${cacheVolume}:/cache`,
  "--volume",
  `${output}:/out`,
  image,
  ...process.argv.slice(2),
]);
