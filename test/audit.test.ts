import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  type Advisory,
  type AuditException,
  auditProblems,
  exceptionProblems,
  reportAdvisories,
} from "../scripts/audit-lib.ts";

const ISSUE = "https://github.com/viell-dev/slop-html-page-viewer/issues/145";

function via(id: string, name: string, severity: string) {
  return {
    source: 1,
    name,
    dependency: name,
    title: `${name} is vulnerable`,
    url: `https://github.com/advisories/${id}`,
    severity,
    range: "<=1.0.0",
  };
}

/** A report shaped as npm 11's `npm audit --json`. */
function report(...advisories: ReturnType<typeof via>[]) {
  const vulnerabilities: Record<string, unknown> = {};
  for (const advisory of advisories) {
    const entry = vulnerabilities[advisory.name] as { via: unknown[] } | undefined;
    if (entry) entry.via.push(advisory);
    else vulnerabilities[advisory.name] = { name: advisory.name, via: [advisory] };
  }
  // A package that only depends on an affected one names it, not the advisory.
  vulnerabilities.dependent = { name: "dependent", severity: "high", via: ["picomatch"] };
  return { auditReportVersion: 2, vulnerabilities, metadata: {} };
}

function exception(advisory: string, packages = ["."]): AuditException {
  return { advisory, packages, reason: "Not reachable here.", issue: ISSUE };
}

describe("the dependency audit", () => {
  it("reads each advisory once, from the packages it affects", () => {
    const found = reportAdvisories(
      report(
        via("GHSA-fc5q-39xc-vjpf", "picomatch", "high"),
        via("GHSA-g3hv-75wg-m249", "minimatch", "moderate"),
        via("GHSA-fc5q-39xc-vjpf", "picomatch", "high"),
      ),
    );
    assert.deepEqual(
      found.map((advisory) => [advisory.id, advisory.name, advisory.severity]),
      [
        ["GHSA-fc5q-39xc-vjpf", "picomatch", "high"],
        ["GHSA-g3hv-75wg-m249", "minimatch", "moderate"],
      ],
    );
  });

  it("refuses a report that npm could not produce", () => {
    assert.throws(
      () => reportAdvisories({ error: { code: "ENOAUDIT", summary: "no registry" } }),
      /npm audit failed: no registry/,
    );
    assert.throws(() => reportAdvisories({}), /no vulnerabilities/);
    assert.deepEqual(reportAdvisories({ vulnerabilities: {} }), []);
  });

  it("fails on high and critical advisories without an exception, and only on those", () => {
    const found: Advisory[] = reportAdvisories(
      report(
        via("GHSA-aaaa-aaaa-aaaa", "high-one", "high"),
        via("GHSA-bbbb-bbbb-bbbb", "critical-one", "critical"),
        via("GHSA-cccc-cccc-cccc", "moderate-one", "moderate"),
        via("GHSA-dddd-dddd-dddd", "low-one", "low"),
      ),
    );
    const problems = auditProblems(found, [], ".");
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^GHSA-aaaa-aaaa-aaaa \(high\) in high-one/);
    assert.match(problems[1], /^GHSA-bbbb-bbbb-bbbb \(critical\) in critical-one/);
  });

  it("accepts an excepted advisory only in the package directories it lists", () => {
    const found = reportAdvisories(report(via("GHSA-fc5q-39xc-vjpf", "picomatch", "high")));
    const exceptions = [exception("GHSA-fc5q-39xc-vjpf", ["test/e2e"])];
    assert.deepEqual(auditProblems(found, exceptions, "test/e2e"), []);
    assert.match(auditProblems(found, exceptions, ".")[0], /^GHSA-fc5q-39xc-vjpf \(high\)/);
  });

  it("fails on an exception that the report no longer needs", () => {
    const fixed = reportAdvisories(report(via("GHSA-fc5q-39xc-vjpf", "picomatch", "moderate")));
    for (const found of [[], fixed]) {
      assert.deepEqual(auditProblems(found, [exception("GHSA-fc5q-39xc-vjpf")], "."), [
        `GHSA-fc5q-39xc-vjpf is no longer reported at high or critical severity in .: remove its exception (${ISSUE})`,
      ]);
    }
  });

  it("checks each exception's advisory, directories, reason, and issue", () => {
    assert.deepEqual(exceptionProblems({}), ["the exceptions file must hold a list"]);
    assert.deepEqual(
      exceptionProblems([
        { advisory: "CVE-2026-1", packages: [], reason: " ", issue: "#145" },
        "GHSA-fc5q-39xc-vjpf",
      ]),
      [
        "exception 1 must name a GHSA advisory",
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
