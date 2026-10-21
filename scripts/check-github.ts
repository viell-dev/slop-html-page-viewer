// Compares the repository's live GitHub settings with the files that record
// them: the labels (.github/labels.json), the rulesets (.github/rulesets/),
// the other settings (.github/settings.json), and each release's text
// (.github/release-notes/). It changes nothing.
//
//   npm run check:github
//
// It reads through the GitHub CLI, signed in with an account that administers
// the repository, which some of the settings need. Run it after changing a
// setting, and during maintenance.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REPOSITORY = process.env.GITHUB_REPOSITORY ?? "viell-dev/slop-html-page-viewer";
const [OWNER, NAME] = REPOSITORY.split("/");

/** A response, or null for an empty one, such as 204 No Content. */
function gh(args: string[]): unknown {
  const output = execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
  return output.trim() === "" ? null : JSON.parse(output);
}

/** The response of a GET, or the HTTP status when it fails, such as 404 for a setting that is off. */
function get(endpoint: string): unknown {
  try {
    return gh([endpoint]);
  } catch (error) {
    const output = String((error as { stderr?: string | Buffer }).stderr ?? "");
    const status = /HTTP (\d{3})/.exec(output)?.[1];
    if (status !== undefined) return { status: Number(status) };
    throw error;
  }
}

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;

/** JSON with every object's keys sorted, so that key order never counts. */
function canonical(value: unknown): string {
  const sort = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sort)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([key, entry]) => [key, sort(entry)]),
          )
        : item;
  return JSON.stringify(sort(value));
}

const problems: string[] = [];
const expect = (what: string, actual: unknown, wanted: unknown): void => {
  if (canonical(actual) !== canonical(wanted))
    problems.push(`${what}: GitHub has ${canonical(actual)}, the record ${canonical(wanted)}.`);
};

// Labels.
interface Label {
  name: string;
  color: string;
  description: string | null;
}
const labels = (gh(["--paginate", `repos/${REPOSITORY}/labels?per_page=100`]) as Label[]).map(
  (label) => ({
    name: label.name,
    color: label.color.toLowerCase(),
    description: label.description ?? "",
  }),
);
const byName = (a: Label, b: Label) => (a.name < b.name ? -1 : 1);
expect(
  "Labels",
  labels.sort(byName),
  readJson<Label[]>(path.join(".github", "labels.json")).sort(byName),
);

// Rulesets.
const recorded = fs
  .readdirSync(path.join(".github", "rulesets"))
  .filter((file) => file.endsWith(".json"))
  .map((file) => readJson<{ name: string }>(path.join(".github", "rulesets", file)));
const live = (gh([`repos/${REPOSITORY}/rulesets`]) as { id: number; name: string }[]).map(
  (summary) => {
    const ruleset = gh([`repos/${REPOSITORY}/rulesets/${summary.id}`]) as Record<string, unknown>;
    const { name, target, enforcement, bypass_actors, conditions, rules } = ruleset;
    return { name, target, enforcement, bypass_actors, conditions, rules } as { name: string };
  },
);
for (const ruleset of recorded) {
  const found = live.find((candidate) => candidate.name === ruleset.name);
  if (found === undefined)
    problems.push(`Ruleset "${ruleset.name}" is recorded but not on GitHub.`);
  else expect(`Ruleset "${ruleset.name}"`, found, ruleset);
}
for (const ruleset of live) {
  if (!recorded.some((candidate) => candidate.name === ruleset.name))
    problems.push(`Ruleset "${ruleset.name}" is on GitHub but not recorded.`);
}

// Other settings.
const settings = readJson<Record<string, unknown>>(path.join(".github", "settings.json"));
const pick = (source: unknown, keys: Record<string, unknown>) =>
  Object.fromEntries(
    Object.keys(keys).map((key) => [key, (source as Record<string, unknown>)[key]]),
  );
const repository = get(`repos/${REPOSITORY}`) as Record<string, unknown>;
const wanted = settings.repository as Record<string, unknown>;
expect("Repository settings", pick(repository, wanted), wanted);
const security = repository.security_and_analysis as Record<string, { status: string }>;
const wantedSecurity = settings.security_and_analysis as Record<string, string>;
expect(
  "Security and analysis",
  Object.fromEntries(Object.keys(wantedSecurity).map((key) => [key, security[key]?.status])),
  wantedSecurity,
);
for (const [key, endpoint] of [
  ["actions", "actions/permissions"],
  ["selected_actions", "actions/permissions/selected-actions"],
  ["workflow_permissions", "actions/permissions/workflow"],
] as const) {
  const wantedPart = settings[key] as Record<string, unknown>;
  expect(
    `Actions (${endpoint})`,
    pick(get(`repos/${REPOSITORY}/${endpoint}`), wantedPart),
    wantedPart,
  );
}
expect(
  "Dependabot alerts",
  (get(`repos/${REPOSITORY}/vulnerability-alerts`) as { status?: number } | null)?.status !== 404,
  settings.vulnerability_alerts,
);
expect(
  "Dependabot security updates",
  (get(`repos/${REPOSITORY}/automated-security-fixes`) as { enabled?: boolean }).enabled,
  settings.automated_security_fixes,
);
expect(
  "Private vulnerability reporting",
  (get(`repos/${REPOSITORY}/private-vulnerability-reporting`) as { enabled?: boolean }).enabled,
  settings.private_vulnerability_reporting,
);
expect(
  "Immutable releases",
  (get(`repos/${REPOSITORY}/immutable-releases`) as { enabled?: boolean }).enabled,
  settings.immutable_releases,
);
const pinned = gh([
  "graphql",
  "-f",
  `query={ repository(owner: "${OWNER}", name: "${NAME}") { pinnedIssues(first: 3) { nodes { issue { number } } } } }`,
]) as { data: { repository: { pinnedIssues: { nodes: { issue: { number: number } }[] } } } };
expect(
  "Pinned issues",
  pinned.data.repository.pinnedIssues.nodes.map((node) => node.issue.number),
  settings.pinned_issues,
);

// Each release's text is its notes file.
const releases = gh(["--paginate", `repos/${REPOSITORY}/releases?per_page=100`]) as {
  tag_name: string;
  draft: boolean;
  body: string | null;
}[];
const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim();
for (const release of releases.filter((candidate) => !candidate.draft)) {
  const file = path.join(".github", "release-notes", `${release.tag_name}.md`);
  if (!fs.existsSync(file)) problems.push(`Release ${release.tag_name} has no ${file}.`);
  else if (normalize(release.body ?? "") !== normalize(fs.readFileSync(file, "utf8")))
    problems.push(`Release ${release.tag_name}'s text differs from ${file}.`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(
  `GitHub matches the records: ${labels.length} labels, ${live.length} rulesets, the settings, and ${releases.length} releases' text.`,
);
