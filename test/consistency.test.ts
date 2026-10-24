import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, type ViewerSettings } from "../src/settings";

// The facts that several files state, checked against each other: versions,
// the changelog and release notes, the documented settings, the labels, the
// Node.js version, the end-to-end suites, and the documents' relative links.

const read = (file: string): string => fs.readFileSync(file, "utf8");
const json = <T>(file: string): T => JSON.parse(read(file)) as T;

const manifest = json<{ version: string; minAppVersion: string }>("manifest.json");
const pkg = json<{ version: string }>("package.json");
const lock = json<{ version: string; packages: Record<string, { version?: string }> }>(
  "package-lock.json",
);
const versions = json<Record<string, string>>("versions.json");
const changelog = read("CHANGELOG.md");
// The README with each run of whitespace as one space, as Markdown reads it.
const readme = read("README.md").replace(/\s+/g, " ");
const notesDir = path.join(".github", "release-notes");
const notes = fs
  .readdirSync(notesDir)
  .filter((file) => file.endsWith(".md"))
  .map((file) => file.slice(0, -".md".length));

/** The changelog's sections: the fork's releases, Unreleased, and upstream's. */
function changelogVersions(): { fork: string[]; upstream: string[]; unreleasedFirst: boolean } {
  const [fork, upstream = ""] = changelog.split(/^## Upstream releases$/m);
  const headings = [...fork.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  return {
    fork: headings
      .filter((heading) => heading !== "Unreleased")
      .map(
        (heading) =>
          /^\[([^\]]+)\]\(\.github\/release-notes\/\1\.md\) - \d{4}-\d{2}-\d{2}$/.exec(
            heading,
          )?.[1] ?? heading,
      ),
    upstream: [...upstream.matchAll(/^### (\S+) - \d{4}-\d{2}-\d{2}$/gm)].map((match) => match[1]),
    unreleasedFirst: headings[0] === "Unreleased",
  };
}

describe("versions", () => {
  it("agree in the manifest, package.json, and the lockfile", () => {
    assert.equal(pkg.version, manifest.version);
    assert.equal(lock.version, manifest.version);
    assert.equal(lock.packages[""]?.version, manifest.version);
  });

  it("list the manifest's version in versions.json with its minAppVersion", () => {
    assert.equal(versions[manifest.version], manifest.minAppVersion);
  });

  it("are each in the changelog, and only those", () => {
    const { fork, upstream } = changelogVersions();
    assert.deepEqual([...fork, ...upstream].sort(), Object.keys(versions).sort());
  });

  it("have release notes for each of the fork's releases, and only those", () => {
    assert.deepEqual([...notes].sort(), [...changelogVersions().fork].sort());
  });

  it("put Unreleased first, then the manifest's version", () => {
    const { fork, unreleasedFirst } = changelogVersions();
    assert.ok(unreleasedFirst, "CHANGELOG.md starts with an Unreleased section");
    assert.equal(fork[0], manifest.version);
  });

  it("name each release's own zip in its notes", () => {
    for (const version of notes) {
      const text = read(path.join(notesDir, `${version}.md`));
      assert.ok(
        text.includes(`viell-html-page-viewer-${version}.zip`),
        `${version}.md names its zip`,
      );
      const others = [...text.matchAll(/viell-html-page-viewer-([^\s`]+)\.zip/g)].map(
        (match) => match[1],
      );
      assert.deepEqual([...new Set(others)], [version], `${version}.md names only its own zip`);
    }
  });
});

describe("the README", () => {
  it("states the manifest's minimum Obsidian version", () => {
    assert.ok(readme.includes(`Obsidian ${manifest.minAppVersion} or later`));
  });

  it("documents every setting with its default", () => {
    // Each setting in the tab, with the key its control reads.
    const tab = read(path.join("src", "settings.ts"));
    const settings = [...tab.matchAll(/name: "([^"]+)"[\s\S]*?this\.host\.settings\.(\w+)/g)].map(
      (match) => ({ name: match[1], key: match[2] as keyof ViewerSettings }),
    );
    assert.deepEqual(
      settings.map((setting) => setting.key).sort(),
      Object.keys(DEFAULT_SETTINGS).sort(),
      "every setting has a control in the tab",
    );
    for (const { name, key } of settings) {
      const value = DEFAULT_SETTINGS[key];
      const stated =
        typeof value === "boolean"
          ? value
            ? "on by default"
            : "off by default"
          : `\`${value.join(", ")}\` by default`;
      assert.ok(
        readme.includes(`**${name}**, ${stated}`),
        `README states "**${name}**, ${stated}"`,
      );
    }
  });

  it("names the Node.js version in .nvmrc, as CONTRIBUTING.md and the e2e image do", () => {
    const major = read(".nvmrc").trim();
    assert.match(major, /^\d+$/);
    assert.ok(readme.includes(`Node.js ${major}`), "README");
    assert.ok(read("CONTRIBUTING.md").includes(`currently ${major}`), "CONTRIBUTING.md");
    assert.match(
      read(path.join("test", "e2e", "Dockerfile")),
      new RegExp(`^FROM node:${major}[.-]`, "m"),
    );
  });
});

describe("labels", () => {
  const labels = json<{ name: string; color: string; description: string }[]>(
    path.join(".github", "labels.json"),
  );
  const names = new Set(labels.map((label) => label.name));

  it("have unique names, colors, and descriptions that GitHub accepts", () => {
    assert.equal(names.size, labels.length);
    for (const label of labels) {
      assert.match(label.color, /^[0-9a-f]{6}$/, label.name);
      assert.ok(label.description.length > 0 && label.description.length <= 100, label.name);
    }
  });

  it("include every label that the issue forms and Dependabot apply", () => {
    const files = [
      ...fs
        .readdirSync(path.join(".github", "ISSUE_TEMPLATE"))
        .map((file) => path.join(".github", "ISSUE_TEMPLATE", file)),
      path.join(".github", "dependabot.yml"),
    ];
    let used = 0;
    for (const file of files) {
      for (const match of read(file).matchAll(/^\s*labels:\s*\[([^\]]*)\]/gm)) {
        for (const label of match[1].split(",").map((name) => name.trim().replace(/^"|"$/g, ""))) {
          used += 1;
          assert.ok(names.has(label), `${file} uses ${label}`);
        }
      }
    }
    assert.ok(used > 0);
  });
});

describe("CI", () => {
  it("has the jobs that the ruleset for main requires", () => {
    const ruleset = json<{
      rules: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[];
    }>(path.join(".github", "rulesets", "main.json"));
    const required = ruleset.rules
      .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
      .map((check) => check.context)
      .sort();
    const ci = read(path.join(".github", "workflows", "ci.yml"));
    const oses =
      /^\s*os: \[([^\]]+)\]$/m
        .exec(ci)?.[1]
        .split(",")
        .map((os) => os.trim()) ?? [];
    assert.match(ci, /^\s*name: verify \(\$\{\{ matrix\.os \}\}\)$/m);
    assert.match(ci, /^\s*name: e2e$/m);
    assert.deepEqual(required, [...oses.map((os) => `verify (${os})`), "e2e"].sort());
  });
});

describe("tests", () => {
  it("run every end-to-end spec file", () => {
    const config = read(path.join("test", "e2e", "wdio.conf.mts"));
    const listed = new Set(
      [...config.matchAll(/specs\("([^"]+\.e2e\.ts)"\)/g)].map((match) => match[1]),
    );
    const files = fs
      .readdirSync(path.join("test", "e2e", "specs"))
      .filter((file) => file.endsWith(".e2e.ts"));
    assert.ok(files.length > 0);
    for (const file of files) assert.ok(listed.has(file), `wdio.conf.mts runs ${file}`);
  });

  it("skip none and focus on none", () => {
    const dirs = ["test", path.join("test", "e2e", "specs")];
    for (const dir of dirs) {
      for (const file of fs.readdirSync(dir).filter((name) => /\.(test|e2e)\.ts$/.test(name))) {
        const text = read(path.join(dir, file));
        assert.doesNotMatch(text, /\b(?:it|describe|test|suite)\.(?:skip|only)\s*\(/, file);
        assert.doesNotMatch(text, /[{,]\s*(?:skip|only)\s*:\s*true/, file);
      }
    }
  });
});

/** GitHub's anchor for a heading: lower case, without punctuation, spaces as hyphens. */
function slug(heading: string): string {
  return heading
    .replace(/`|\*\*|_/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

function anchors(file: string): Set<string> {
  const text = read(file).replace(/^```[\s\S]*?^```/gm, "");
  return new Set([...text.matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1])));
}

describe("documents", () => {
  const documents = [
    ...fs.readdirSync(".").filter((file) => file.endsWith(".md")),
    ...notes.map((version) => path.join(notesDir, `${version}.md`)),
    path.join(".github", "pull_request_template.md"),
  ];

  it("link only to files and headings that exist", () => {
    let links = 0;
    for (const file of documents) {
      const text = read(file)
        .replace(/^```[\s\S]*?^```/gm, "")
        .replace(/`[^`\n]*`/g, "");
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        links += 1;
        const [where, anchor] = target.split("#");
        const resolved =
          where === "" ? file : path.join(path.dirname(file), decodeURIComponent(where));
        assert.ok(fs.existsSync(resolved), `${file} links to ${target}`);
        if (anchor !== undefined && resolved.endsWith(".md")) {
          assert.ok(anchors(resolved).has(anchor), `${file} links to #${anchor} in ${resolved}`);
        }
      }
    }
    assert.ok(links > 0);
  });
});
