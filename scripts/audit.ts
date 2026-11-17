// The required dependency audit of a package directory, the root by default:
//
//   npm run check:audit [-- <directory>]
//
// It runs `npm audit --json` there, and fails on any high or critical advisory
// that .github/audit-exceptions.json does not list for that directory, and on
// any listed exception that the audit no longer reports. Other advisories are
// listed but do not fail it. CONTRIBUTING.md says when an exception is
// acceptable.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import {
  type AuditException,
  auditProblems,
  exceptionProblems,
  reportAdvisories,
} from "./audit-lib.ts";

const directory = process.argv[2] ?? ".";
const exceptions: unknown = JSON.parse(fs.readFileSync(".github/audit-exceptions.json", "utf8"));
const invalid = exceptionProblems(exceptions);
if (invalid.length > 0) {
  for (const problem of invalid) console.error(`.github/audit-exceptions.json: ${problem}`);
  process.exit(1);
}

// Through an npm script, npm names its own entry point, which runs on any
// platform without a shell.
const npm = process.env.npm_execpath;
const args = ["audit", "--json", ...(directory === "." ? [] : ["--prefix", directory])];
const run = npm?.endsWith(".js")
  ? spawnSync(process.execPath, [npm, ...args], { encoding: "utf8", maxBuffer: 64 << 20 })
  : spawnSync("npm", args, { encoding: "utf8", maxBuffer: 64 << 20 });
if (run.error) throw run.error;

let report: unknown;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error(`npm audit gave no JSON report (exit ${run.status}):\n${run.stderr}`);
  process.exit(1);
}
const advisories = reportAdvisories(report);
const accepted = exceptions as AuditException[];
for (const advisory of advisories) {
  const entry = accepted.find(
    (item) => item.advisory === advisory.id && item.packages.includes(directory),
  );
  const note = entry ? `, accepted in ${entry.issue}` : "";
  console.log(
    `${advisory.id} ${advisory.severity}${note}: ${advisory.name} ${advisory.range}, ${advisory.title}`,
  );
}
const problems = auditProblems(advisories, accepted, directory);
for (const problem of problems) console.error(`Audit of ${directory} fails: ${problem}`);
console.log(`${advisories.length} advisories in ${directory}; ${problems.length} problems.`);
process.exit(problems.length > 0 ? 1 : 0);
