// The required dependency audit of a package directory, the root by default:
//
//   npm run check:audit [-- <directory>]
//
// It runs `npm audit --json` there, and fails on any advisory above moderate
// severity that .github/audit-exceptions.json does not list for that package
// and directory, on any listed exception that the audit no longer reports, and
// on a report that it cannot fully read. Other advisories are listed but do not
// fail it. CONTRIBUTING.md says when an exception is acceptable.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  type AuditException,
  type AuditReport,
  auditProblems,
  exceptionFor,
  exceptionProblems,
  readReport,
} from "./audit-lib.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length > 1) fail("Usage: npm run check:audit [-- <directory>]");
// The exceptions name directories relative to the root, with forward slashes.
const directory =
  path
    .relative(process.cwd(), path.resolve(args[0] ?? "."))
    .split(path.sep)
    .join("/") || ".";
if (!fs.existsSync(path.join(directory, "package-lock.json"))) {
  fail(`${directory} has no package-lock.json to audit`);
}

const exceptions: unknown = JSON.parse(fs.readFileSync(".github/audit-exceptions.json", "utf8"));
const invalid = exceptionProblems(exceptions);
if (invalid.length > 0)
  fail(invalid.map((problem) => `.github/audit-exceptions.json: ${problem}`).join("\n"));
const accepted = exceptions as AuditException[];

// Through an npm script, npm names its own entry point, which runs on any
// platform without a shell; `npm` itself is a shell script on Windows.
const npm = process.env.npm_execpath;
if (!npm?.endsWith(".js")) fail("Run the audit through npm: npm run check:audit [-- <directory>]");
// npm's advisory cache keeps a cached severity while an advisory's versions
// stay the same, so a raised severity would go unseen; audit with an empty one.
const cache = fs.mkdtempSync(path.join(os.tmpdir(), "npm-audit-"));
const run = spawnSync(
  process.execPath,
  [
    npm,
    "audit",
    "--json",
    "--include=dev",
    "--cache",
    cache,
    ...(directory === "." ? [] : ["--prefix", directory]),
  ],
  { encoding: "utf8", maxBuffer: 64 << 20 },
);
fs.rmSync(cache, { recursive: true, force: true });
if (run.error) fail(`npm audit could not run: ${run.error.message}`);

let report: AuditReport;
try {
  report = readReport(JSON.parse(run.stdout));
} catch (error) {
  const reason =
    error instanceof SyntaxError
      ? "npm audit gave no JSON report"
      : String((error as Error).message);
  fail(`${reason} (exit ${run.status})\n${run.stderr}`);
}

for (const advisory of report.advisories) {
  const entry = exceptionFor(advisory, accepted, directory);
  const note = entry ? `, accepted in ${entry.issue}` : "";
  console.log(
    `${advisory.id} ${advisory.severity}${note}: ${advisory.name} ${advisory.range}, ${advisory.title}`,
  );
}
const problems = auditProblems(report, accepted, directory);
for (const problem of problems) console.error(`Audit of ${directory} fails: ${problem}`);
console.log(`${report.advisories.length} advisories in ${directory}; ${problems.length} problems.`);
process.exit(problems.length > 0 ? 1 : 0);
