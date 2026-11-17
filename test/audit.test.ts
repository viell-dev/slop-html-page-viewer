import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  type AuditException,
  auditProblems,
  exceptionProblems,
  readReport,
} from "../scripts/audit-lib.ts";

const ISSUE = "https://github.com/viell-dev/slop-html-page-viewer/issues/145";

interface Via {
  source: number;
  name: string;
  title: string;
  url?: string;
  severity: string;
  range: string;
}

function via(id: string, name: string, severity: string, source = 1): Via {
  return {
    source,
    name,
    title: `${name} is vulnerable`,
    url: `https://github.com/advisories/${id}`,
    severity,
    range: "<=1.0.0",
  };
}

/**
 * A report shaped as npm 11's `npm audit --json`: each advisory in the `via`
 * of the package it affects, whose severity is the highest of them, and a
 * package that depends on the first one, which names it.
 */
function report(...advisories: Via[]) {
  const order = ["info", "low", "moderate", "high", "critical"];
  const vulnerabilities: Record<string, { name: string; severity: unknown; via: unknown[] }> = {};
  for (const advisory of advisories) {
    const entry = (vulnerabilities[advisory.name] ??= {
      name: advisory.name,
      severity: advisory.severity,
      via: [],
    });
    entry.via.push(advisory);
    if (order.indexOf(advisory.severity) > order.indexOf(String(entry.severity)))
      entry.severity = advisory.severity;
    if (!order.includes(advisory.severity)) entry.severity = null;
  }
  const first = advisories[0];
  if (first) {
    vulnerabilities.dependent = {
      name: "dependent",
      severity: vulnerabilities[first.name].severity,
      via: [first.name],
    };
  }
  return { auditReportVersion: 2, vulnerabilities, metadata: {} };
}

function exception(advisory: string, dependency = "picomatch", packages = ["."]): AuditException {
  return { advisory, dependency, packages, reason: "Not reachable here.", issue: ISSUE };
}

describe("the dependency audit", () => {
  it("reads each advisory once per package that it affects", () => {
    const { advisories, unexplained } = readReport(
      report(
        via("GHSA-fc5q-39xc-vjpf", "picomatch", "high"),
        via("GHSA-g3hv-75wg-m249", "minimatch", "moderate"),
        via("GHSA-fc5q-39xc-vjpf", "picomatch", "high"),
        via("GHSA-fc5q-39xc-vjpf", "micromatch", "critical"),
      ),
    );
    assert.deepEqual(
      advisories.map((advisory) => [advisory.id, advisory.name, advisory.severity]),
      [
        ["GHSA-fc5q-39xc-vjpf", "micromatch", "critical"],
        ["GHSA-fc5q-39xc-vjpf", "picomatch", "high"],
        ["GHSA-g3hv-75wg-m249", "minimatch", "moderate"],
      ],
    );
    assert.deepEqual(unexplained, []);
  });

  it("refuses a report that npm could not produce, or of another version", () => {
    // npm 11 when the registry cannot be reached.
    const refused = {
      message: "request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed",
      error: { summary: "", detail: "" },
    };
    assert.throws(() => readReport(refused), /npm audit failed: request to https/);
    assert.throws(
      () => readReport({ error: { summary: "", detail: "" } }),
      /npm audit failed: no reason given/,
    );
    assert.throws(
      () => readReport({ auditReportVersion: 3, vulnerabilities: {} }),
      /report version 3, not 2/,
    );
    assert.throws(() => readReport({ auditReportVersion: 2 }), /no vulnerabilities/);
    assert.throws(
      () => readReport({ auditReportVersion: 2, vulnerabilities: { x: { name: "x" } } }),
      /without a via list/,
    );
    assert.deepEqual(readReport({ auditReportVersion: 2, vulnerabilities: {} }), {
      advisories: [],
      unexplained: [],
    });
  });

  it("fails on advisories above moderate without an exception, and only on those", () => {
    const problems = auditProblems(
      readReport(
        report(
          via("GHSA-aaaa-aaaa-aaaa", "high-one", "high"),
          via("GHSA-bbbb-bbbb-bbbb", "critical-one", "critical"),
          via("GHSA-cccc-cccc-cccc", "moderate-one", "moderate"),
          via("GHSA-dddd-dddd-dddd", "low-one", "low"),
          via("GHSA-eeee-eeee-eeee", "info-one", "info"),
        ),
      ),
      [],
      ".",
    );
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^GHSA-aaaa-aaaa-aaaa \(high\) in high-one/);
    assert.match(problems[1], /^GHSA-bbbb-bbbb-bbbb \(critical\) in critical-one/);
  });

  it("fails on an advisory whose severity npm does not define, or that has no URL", () => {
    const odd = via("GHSA-ffff-ffff-ffff", "odd", "High");
    const unnamed = { ...via("GHSA-gggg-gggg-gggg", "unnamed", "high", 1099), url: undefined };
    const problems = auditProblems(
      readReport(report(odd, unnamed)),
      [exception("GHSA-ffff-ffff-ffff", "other")],
      ".",
    );
    assert.deepEqual(problems.slice(0, 2), [
      "GHSA-ffff-ffff-ffff (High) in odd <=1.0.0: odd is vulnerable (https://github.com/advisories/GHSA-ffff-ffff-ffff)",
      "npm-advisory-1099 (high) in unnamed <=1.0.0: unnamed is vulnerable (no URL)",
    ]);
  });

  it("fails on a package that npm gates for a reason the report does not give", () => {
    const strange = {
      auditReportVersion: 2,
      vulnerabilities: {
        lone: { name: "lone", severity: "high", via: ["missing"] },
        loop: { name: "loop", severity: "critical", via: ["loop"] },
      },
    };
    assert.deepEqual(auditProblems(readReport(strange), [], "."), [
      "npm gates lone (high), but the report names no gated advisory for it",
      "npm gates loop (critical), but the report names no gated advisory for it",
    ]);
  });

  it("accepts an advisory only for the package and directories its exception names", () => {
    const found = readReport(
      report(
        via("GHSA-fc5q-39xc-vjpf", "picomatch", "high"),
        via("GHSA-fc5q-39xc-vjpf", "micromatch", "high"),
      ),
    );
    const exceptions = [exception("GHSA-fc5q-39xc-vjpf", "picomatch", ["test/e2e"])];
    assert.deepEqual(auditProblems(found, exceptions, "test/e2e"), [
      "GHSA-fc5q-39xc-vjpf (high) in micromatch <=1.0.0: micromatch is vulnerable (https://github.com/advisories/GHSA-fc5q-39xc-vjpf)",
    ]);
    assert.equal(auditProblems(found, exceptions, ".").length, 2);
  });

  it("fails on an exception that the report no longer needs", () => {
    const fixed = readReport(report(via("GHSA-fc5q-39xc-vjpf", "picomatch", "moderate")));
    const none = readReport(report());
    for (const found of [none, fixed]) {
      assert.deepEqual(auditProblems(found, [exception("GHSA-fc5q-39xc-vjpf")], "."), [
        `GHSA-fc5q-39xc-vjpf in picomatch is no longer reported above moderate severity in .: remove its exception (${ISSUE})`,
      ]);
    }
  });

  it("checks each exception's advisory, package, directories, reason, and issue", () => {
    assert.deepEqual(exceptionProblems({}), ["the exceptions file must hold a list"]);
    assert.deepEqual(
      exceptionProblems([
        { advisory: "CVE-2026-1", packages: [], reason: " ", issue: "#145" },
        "GHSA-fc5q-39xc-vjpf",
      ]),
      [
        "exception 1 must name a GHSA advisory",
        "exception 1 must name the package that the advisory affects",
        "exception 1 must list the package directories it applies to",
        "exception 1 must say why the advisory cannot affect the project",
        "exception 1 must link the issue that tracks it",
        "exception 2 must be an object",
      ],
    );
  });

  it("keeps the repository's exceptions file valid", () => {
    const exceptions: unknown = JSON.parse(
      fs.readFileSync(".github/audit-exceptions.json", "utf8"),
    );
    assert.deepEqual(exceptionProblems(exceptions), []);
  });
});
