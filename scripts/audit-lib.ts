// The decision that scripts/audit.ts makes from a report of `npm audit --json`:
// which gated advisories have no recorded exception, which recorded exceptions
// the report no longer needs, and whether the report says more than this
// reading of it understands. Where in doubt, it fails.

/** The severities that never fail the audit. Every other one does, unless an exception covers it. */
const UNGATED = new Set(["info", "low", "moderate"]);

/** Whether a severity fails the audit, including one that npm does not define. */
export const isGated = (severity: unknown): boolean =>
  typeof severity !== "string" || !UNGATED.has(severity);

/** An advisory that a report names for one package, with the versions it affects. */
export interface Advisory {
  /** The advisory's GitHub ID, such as `GHSA-xxxx-xxxx-xxxx`, or `npm-advisory-<source>` without one. */
  id: string;
  /** The package that the advisory affects. */
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
  /** The package that the advisory affects, as the report names it. */
  dependency: string;
  /** The package directories it applies to: `.` for the root, or a path such as `test/e2e`. */
  packages: string[];
  /** Why the advisory cannot affect the project. */
  reason: string;
  /** The issue that tracks the advisory and says when to remove the exception. */
  issue: string;
}

/** What a report says: its advisories, and its packages that npm gates without a gated advisory. */
export interface AuditReport {
  advisories: Advisory[];
  /** Packages whose severity npm gates, but which no gated advisory explains. */
  unexplained: string[];
}

const GHSA = /GHSA(?:-[0-9a-z]{4}){3}/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads a report of npm 7 or later (`auditReportVersion` 2). A report names an
 * advisory in the `via` list of each package it affects; packages that only
 * depend on an affected package name that package in `via` instead. It throws
 * for a report that npm could not produce or that has another shape.
 */
export function readReport(report: unknown): AuditReport {
  if (!isRecord(report)) throw new Error("npm audit gave no report");
  if (isRecord(report.error)) {
    const cause = [report.message, report.error.summary, report.error.code].find(
      (value): value is string => typeof value === "string" && value !== "",
    );
    throw new Error(`npm audit failed: ${cause ?? "no reason given"}`);
  }
  if (report.auditReportVersion !== 2) {
    throw new Error(`npm audit gave report version ${String(report.auditReportVersion)}, not 2`);
  }
  if (!isRecord(report.vulnerabilities)) throw new Error("npm audit gave no vulnerabilities");

  const found = new Map<string, Advisory>();
  /** For each package, the packages it names in `via`, and whether a gated advisory affects it. */
  const entries = new Map<string, { gated: boolean; severity: unknown; through: string[] }>();
  for (const [key, entry] of Object.entries(report.vulnerabilities)) {
    if (!isRecord(entry) || !Array.isArray(entry.via)) {
      throw new Error(`npm audit gave an entry for ${key} without a via list`);
    }
    const node = { gated: false, severity: entry.severity, through: [] as string[] };
    entries.set(key, node);
    for (const via of entry.via) {
      if (typeof via === "string") {
        node.through.push(via);
        continue;
      }
      if (!isRecord(via)) throw new Error(`npm audit gave an unreadable via entry for ${key}`);
      const url = typeof via.url === "string" ? via.url : "";
      const id = GHSA.exec(url)?.[0] ?? `npm-advisory-${String(via.source)}`;
      const name = typeof via.name === "string" ? via.name : key;
      if (isGated(via.severity)) node.gated = true;
      found.set(`${id} ${name}`, {
        id,
        name,
        range: String(via.range),
        severity: String(via.severity),
        title: String(via.title),
        url,
      });
    }
  }

  // A package that npm gates must be affected by a gated advisory, directly or
  // through the packages it names; otherwise the report says something that
  // this reading does not understand.
  const explained = (key: string, seen = new Set<string>()): boolean => {
    const node = entries.get(key);
    if (!node || seen.has(key)) return false;
    if (node.gated) return true;
    seen.add(key);
    return node.through.some((name) => explained(name, seen));
  };
  const unexplained = [...entries]
    .filter(([key, node]) => isGated(node.severity) && !explained(key))
    .map(([key, node]) => `${key} (${String(node.severity)})`);

  const advisories = [...found.values()].sort(
    (a, b) => a.id.localeCompare(b.id) || a.name.localeCompare(b.name),
  );
  return { advisories, unexplained };
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
    if (typeof entry.advisory !== "string" || !new RegExp(`^${GHSA.source}$`).test(entry.advisory))
      problems.push(`${at} must name a GHSA advisory`);
    if (typeof entry.dependency !== "string" || entry.dependency === "")
      problems.push(`${at} must name the package that the advisory affects`);
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

/** The exception that accepts an advisory in a package directory, if any. */
export function exceptionFor(
  advisory: Advisory,
  exceptions: readonly AuditException[],
  directory: string,
): AuditException | undefined {
  return exceptions.find(
    (entry) =>
      entry.advisory === advisory.id &&
      entry.dependency === advisory.name &&
      entry.packages.includes(directory),
  );
}

/**
 * Why the audit of the package directory `directory` fails: each gated
 * advisory without an exception for that directory, each package that npm
 * gates for a reason this reading does not find, and each exception for that
 * directory that the report does not need, so that it is removed once it no
 * longer applies.
 */
export function auditProblems(
  report: AuditReport,
  exceptions: readonly AuditException[],
  directory: string,
): string[] {
  const gated = report.advisories.filter((advisory) => isGated(advisory.severity));
  const problems = gated
    .filter((advisory) => exceptionFor(advisory, exceptions, directory) === undefined)
    .map(
      (advisory) =>
        `${advisory.id} (${advisory.severity}) in ${advisory.name} ${advisory.range}: ${advisory.title} (${advisory.url || "no URL"})`,
    );
  for (const name of report.unexplained) {
    problems.push(`npm gates ${name}, but the report names no gated advisory for it`);
  }
  for (const entry of exceptions.filter((item) => item.packages.includes(directory))) {
    const used = gated.some((advisory) => exceptionFor(advisory, [entry], directory) === entry);
    if (!used) {
      problems.push(
        `${entry.advisory} in ${entry.dependency} is no longer reported above moderate severity in ${directory}: remove its exception (${entry.issue})`,
      );
    }
  }
  return problems;
}
