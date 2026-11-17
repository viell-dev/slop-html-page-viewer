// The decision that scripts/audit.ts makes from a report of `npm audit --json`:
// which high or critical advisories have no recorded exception, and which
// recorded exceptions the report no longer needs.

/** The severities that fail the audit unless an exception covers them. */
const GATED = new Set(["high", "critical"]);

/** An advisory that a report names, with the package and versions it affects. */
export interface Advisory {
  /** The advisory's GitHub ID, such as `GHSA-xxxx-xxxx-xxxx`. */
  id: string;
  name: string;
  range: string;
  severity: string;
  title: string;
  url: string;
}

/**
 * An advisory accepted in .github/audit-exceptions.json: one that cannot
 * affect the project, as its issue shows, and has no fix to update to.
 */
export interface AuditException {
  advisory: string;
  /** The package directories it applies to: `.` for the root, or a path such as `test/e2e`. */
  packages: string[];
  /** Why the advisory cannot affect the project. */
  reason: string;
  /** The issue that tracks the advisory and says when to remove the exception. */
  issue: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The advisories in a report, each once. A report names an advisory in the
 * `via` list of each package it affects; packages that only depend on an
 * affected package name that package in `via` instead.
 */
export function reportAdvisories(report: unknown): Advisory[] {
  if (!isRecord(report)) throw new Error("npm audit gave no report");
  if (isRecord(report.error)) {
    throw new Error(`npm audit failed: ${String(report.error.summary ?? report.error.code)}`);
  }
  if (!isRecord(report.vulnerabilities)) throw new Error("npm audit gave no vulnerabilities");
  const found = new Map<string, Advisory>();
  for (const entry of Object.values(report.vulnerabilities)) {
    if (!isRecord(entry) || !Array.isArray(entry.via)) continue;
    for (const via of entry.via) {
      if (!isRecord(via) || typeof via.url !== "string") continue;
      const id = /GHSA(?:-[0-9a-z]{4}){3}/.exec(via.url)?.[0] ?? via.url;
      found.set(id, {
        id,
        name: String(via.name),
        range: String(via.range),
        severity: String(via.severity),
        title: String(via.title),
        url: via.url,
      });
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Problems with the exceptions file's contents, before it is applied. */
export function exceptionProblems(exceptions: unknown): string[] {
  if (!Array.isArray(exceptions)) return ["the exceptions file must hold a list"];
  const problems: string[] = [];
  for (const [index, entry] of exceptions.entries()) {
    const at = `exception ${index + 1}`;
    if (!isRecord(entry)) {
      problems.push(`${at} must be an object`);
      continue;
    }
    if (typeof entry.advisory !== "string" || !/^GHSA(?:-[0-9a-z]{4}){3}$/.test(entry.advisory))
      problems.push(`${at} must name a GHSA advisory`);
    if (
      !Array.isArray(entry.packages) ||
      entry.packages.length === 0 ||
      !entry.packages.every((value) => typeof value === "string" && value !== "")
    )
      problems.push(`${at} must list the package directories it applies to`);
    if (typeof entry.reason !== "string" || entry.reason.trim() === "")
      problems.push(`${at} must say why the advisory cannot affect the project`);
    if (
      typeof entry.issue !== "string" ||
      !/^https:\/\/github\.com\/viell-dev\/slop-html-page-viewer\/issues\/\d+$/.test(entry.issue)
    )
      problems.push(`${at} must link the issue that tracks it`);
  }
  return problems;
}

/**
 * Why the audit of the package directory `directory` fails: each gated
 * advisory without an exception for that directory, and each exception for it
 * that the report does not need, so that it is removed once a fix is adopted.
 */
export function auditProblems(
  advisories: readonly Advisory[],
  exceptions: readonly AuditException[],
  directory: string,
): string[] {
  const applying = exceptions.filter((entry) => entry.packages.includes(directory));
  const excepted = new Set(applying.map((entry) => entry.advisory));
  const gated = advisories.filter((advisory) => GATED.has(advisory.severity));
  const problems = gated
    .filter((advisory) => !excepted.has(advisory.id))
    .map(
      (advisory) =>
        `${advisory.id} (${advisory.severity}) in ${advisory.name} ${advisory.range}: ${advisory.title} (${advisory.url})`,
    );
  const reported = new Set(gated.map((advisory) => advisory.id));
  for (const entry of applying) {
    if (!reported.has(entry.advisory)) {
      problems.push(
        `${entry.advisory} is no longer reported at high or critical severity in ${directory}: remove its exception (${entry.issue})`,
      );
    }
  }
  return problems;
}
