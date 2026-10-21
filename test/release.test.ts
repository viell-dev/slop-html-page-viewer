import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  assetNames,
  assetProblems,
  checkProblems,
  CHECKSUMS,
  compareVersions,
  createZip,
  DryRun,
  type Files,
  type GitHub,
  packageRelease,
  PLUGIN_ID,
  publish,
  readZip,
  Refusal,
  type Release,
  type ReleaseAsset,
  sha256,
  type Sources,
  verifyPublished,
  versionProblems,
  zipName,
} from "../scripts/release-lib.ts";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function plugin(version: string, main = "console.log(1);\n"): Files {
  return new Map([
    ["main.js", text(main)],
    ["manifest.json", text(`{"id":"${PLUGIN_ID}","version":"${version}"}\n`)],
    ["styles.css", text(".html-page-viewer { color: red; }\n")],
  ]);
}

function candidate(version = "1.2.0", main?: string) {
  return {
    version,
    sha: SHA,
    assets: packageRelease(version, plugin(version, main)),
    notes: `Notes for ${version}.\n`,
  };
}

/**
 * GitHub in memory, recording every change. `failOn` makes a change fail, as
 * a lost connection or a cancelled run would, after the changes before it.
 */
class FakeGitHub implements GitHub {
  readonly tags = new Map<string, string>();
  readonly releases: Release[] = [];
  readonly bytes = new Map<number, Uint8Array>();
  readonly changes: string[] = [];
  failOn: ((change: string) => boolean) | null = null;
  /** Corrupts what an upload stores, as a damaged transfer would. */
  corrupt: string | null = null;
  /** Leaves out GitHub's digests, as for files uploaded before GitHub computed them. */
  noDigests = false;
  /** The tag of the release that GitHub marks as the latest. */
  latest: string | null = null;
  private nextId = 1;

  private change(description: string): void {
    if (this.failOn?.(description)) {
      this.failOn = null;
      throw new Error(`Injected failure: ${description}`);
    }
    this.changes.push(description);
  }

  async tagCommit(tag: string): Promise<string | null> {
    return this.tags.get(tag) ?? null;
  }

  async findRelease(tag: string): Promise<Release | null> {
    const release = this.releases.find((candidate) => candidate.tag === tag);
    return release === undefined ? null : structuredClone(release);
  }

  async getRelease(id: number): Promise<Release | null> {
    const release = this.releases.find((candidate) => candidate.id === id);
    return release === undefined ? null : structuredClone(release);
  }

  async latestTag(): Promise<string | null> {
    return this.latest;
  }

  async publishedTags(): Promise<{ tag: string; prerelease: boolean }[]> {
    return this.releases
      .filter((release) => !release.draft)
      .map(({ tag, prerelease }) => ({ tag, prerelease }));
  }

  async downloadAsset(asset: ReleaseAsset): Promise<Uint8Array> {
    return this.bytes.get(asset.id)!;
  }

  async download(url: string): Promise<Uint8Array> {
    const asset = this.releases
      .flatMap((release) => release.assets)
      .find((candidate) => candidate.url === url);
    assert.ok(asset, url);
    return this.bytes.get(asset.id)!;
  }

  async createTag(tag: string, sha: string): Promise<void> {
    if (this.tags.has(tag)) throw new Error("Reference already exists");
    this.change(`tag ${tag}`);
    this.tags.set(tag, sha);
  }

  async createDraft(
    tag: string,
    details: { name: string; body: string; prerelease: boolean },
  ): Promise<Release> {
    this.change(`draft ${tag}`);
    const release: Release = { id: this.nextId++, tag, draft: true, assets: [], ...details };
    this.releases.push(release);
    return structuredClone(release);
  }

  async uploadAsset(release: Release, name: string, bytes: Uint8Array): Promise<void> {
    this.change(`upload ${name}`);
    const stored = this.releases.find((candidate) => candidate.id === release.id)!;
    assert.ok(stored.draft, "uploads go only to drafts");
    assert.ok(!stored.assets.some((asset) => asset.name === name), `${name} is uploaded once`);
    const kept = name === this.corrupt ? text("damaged") : bytes;
    const id = this.nextId++;
    this.bytes.set(id, kept);
    stored.assets.push({
      id,
      name,
      size: kept.length,
      digest: this.noDigests ? null : `sha256:${sha256(kept)}`,
      url: `https://example.com/${id}`,
    });
  }

  async publishRelease(release: Release, latest: boolean): Promise<void> {
    this.change(`publish ${release.tag}${latest ? " latest" : ""}`);
    this.releases.find((candidate) => candidate.id === release.id)!.draft = false;
    if (latest) this.latest = release.tag;
  }

  /** A release as an earlier run published it. */
  published(version: string, assets: Files, prerelease = false): void {
    const release: Release = {
      id: this.nextId++,
      tag: version,
      draft: false,
      prerelease,
      name: version,
      body: "",
      assets: [],
    };
    for (const [name, bytes] of assets) {
      const id = this.nextId++;
      this.bytes.set(id, bytes);
      release.assets.push({
        id,
        name,
        size: bytes.length,
        digest: this.noDigests ? null : `sha256:${sha256(bytes)}`,
        url: `https://example.com/${id}`,
      });
    }
    this.releases.push(release);
    this.tags.set(version, OTHER);
    if (!prerelease) this.latest = version;
  }
}

describe("packaging", () => {
  it("gives the same bytes for the same files, and a zip of the plugin's folder", () => {
    const first = packageRelease("1.2.0", plugin("1.2.0"));
    const second = packageRelease("1.2.0", plugin("1.2.0"));
    assert.deepEqual([...first.keys()], assetNames("1.2.0"));
    for (const [name, bytes] of first) assert.deepEqual(bytes, second.get(name), name);
    const zipped = readZip(first.get(zipName("1.2.0"))!);
    assert.deepEqual(
      [...zipped.keys()],
      ["main.js", "manifest.json", "styles.css"].map((name) => `${PLUGIN_ID}/${name}`),
    );
    assert.deepEqual(assetProblems("1.2.0", first), []);
  });

  it("lists the other assets' checksums, the zip's first", () => {
    const assets = packageRelease("1.2.0", plugin("1.2.0"));
    const lines = new TextDecoder().decode(assets.get(CHECKSUMS)).trimEnd().split("\n");
    assert.deepEqual(
      lines,
      [zipName("1.2.0"), "main.js", "manifest.json", "styles.css"].map(
        (name) => `${sha256(assets.get(name)!)}  ${name}`,
      ),
    );
  });

  it("finds a damaged zip, a wrong checksum, a zip that differs from the loose files, and a wrong version", () => {
    const good = packageRelease("1.2.0", plugin("1.2.0"));
    const damaged = new Map(good);
    damaged.set(zipName("1.2.0"), good.get(zipName("1.2.0"))!.slice(0, 40));
    assert.match(assetProblems("1.2.0", damaged).join(" "), /zip cannot be read/);

    const other = new Map(good);
    other.set("main.js", text("changed"));
    assert.match(assetProblems("1.2.0", other).join(" "), /main\.js does not match its checksum/);

    const mismatched = packageRelease("1.2.0", plugin("1.2.0"));
    mismatched.set(
      zipName("1.2.0"),
      createZip(
        PLUGIN_ID,
        [...plugin("1.2.0", "other();")].map(([name, data]) => ({ name, data })),
      ),
    );
    assert.match(assetProblems("1.2.0", mismatched).join(" "), /zip's main\.js differs/);

    assert.match(
      assetProblems("1.3.0", packageRelease("1.3.0", plugin("1.2.0"))).join(" "),
      /manifest\.json says 1\.2\.0/,
    );
    assert.match(assetProblems("1.2.0", new Map()).join(" "), /The assets are none/);
  });
});

describe("versions", () => {
  it("orders versions by SemVer precedence", () => {
    const ordered = [
      "0.2.0-rc.1",
      "0.2.0",
      "0.3.0-alpha",
      "0.3.0-alpha.1",
      "0.3.0-alpha.beta",
      "0.3.0-beta.2",
      "0.3.0-beta.11",
      "0.3.0",
      "0.10.0",
    ];
    for (let i = 0; i + 1 < ordered.length; i++) {
      assert.ok(
        compareVersions(ordered[i], ordered[i + 1]) < 0,
        `${ordered[i]} < ${ordered[i + 1]}`,
      );
      assert.ok(compareVersions(ordered[i + 1], ordered[i]) > 0);
    }
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  });

  it("are ready only when every file agrees and the notes and changelog have them", () => {
    const sources = (): Sources => ({
      manifest: { version: "1.2.0", minAppVersion: "1.5.0" },
      pkg: { version: "1.2.0" },
      lock: { version: "1.2.0", packages: { "": { version: "1.2.0" } } },
      versions: { "1.2.0": "1.5.0" },
      notes: "Notes.\n",
      changelog:
        "# Changelog\n\n## Unreleased\n\n## [1.2.0](.github/release-notes/1.2.0.md) - 2026-10-21\n",
    });
    assert.deepEqual(versionProblems("1.2.0", sources()), []);
    assert.equal(versionProblems("v1.2.0", sources()).length > 0, true);
    assert.match(
      versionProblems("1.2.0", { ...sources(), pkg: { version: "1.1.0" } }).join(" "),
      /package\.json/,
    );
    assert.match(
      versionProblems("1.2.0", {
        ...sources(),
        lock: { version: "1.2.0", packages: { "": { version: "1.1.0" } } },
      }).join(" "),
      /lock/,
    );
    assert.match(
      versionProblems("1.2.0", { ...sources(), versions: {} }).join(" "),
      /versions\.json/,
    );
    assert.match(
      versionProblems("1.2.0", { ...sources(), notes: null }).join(" "),
      /release-notes/,
    );
    assert.match(
      versionProblems("1.2.0", { ...sources(), changelog: "# Changelog\n" }).join(" "),
      /CHANGELOG/,
    );
  });
});

describe("the commit's checks", () => {
  const required = [
    { context: "verify (ubuntu-latest)", integration_id: 15368 },
    { context: "e2e", integration_id: 15368 },
  ];
  const run = (
    id: number,
    name: string,
    conclusion: string | null,
    status = "completed",
    appId = 15368,
  ) => ({ id, name, status, conclusion, appId });

  it("allow a release when the latest run of each passed", () => {
    assert.deepEqual(
      checkProblems(required, [
        run(1, "e2e", "failure"),
        run(2, "e2e", "success"),
        run(3, "verify (ubuntu-latest)", "success"),
      ]),
      [],
    );
  });

  it("refuse a missing, running, failed, or cancelled check, and one from another app", () => {
    assert.match(
      checkProblems(required, [run(1, "e2e", "success")]).join(" "),
      /verify \(ubuntu-latest\) has not run/,
    );
    assert.match(
      checkProblems(required, [
        run(1, "e2e", null, "in_progress"),
        run(2, "verify (ubuntu-latest)", "success"),
      ]).join(" "),
      /e2e is still in_progress/,
    );
    assert.match(
      checkProblems(required, [
        run(1, "e2e", "success"),
        run(2, "e2e", "failure"),
        run(3, "verify (ubuntu-latest)", "success"),
      ]).join(" "),
      /e2e concluded failure/,
    );
    assert.match(
      checkProblems(required, [
        run(1, "e2e", "cancelled"),
        run(2, "verify (ubuntu-latest)", "success"),
      ]).join(" "),
      /e2e concluded cancelled/,
    );
    assert.match(
      checkProblems(required, [
        run(1, "e2e", "success", "completed", 1),
        run(2, "verify (ubuntu-latest)", "success"),
      ]).join(" "),
      /e2e has not run/,
    );
    assert.match(checkProblems([], []).join(" "), /requires no checks/);
  });
});

describe("publishing", () => {
  it("tags the commit, uploads to a draft with the checksums last, checks it, and publishes it", async () => {
    const github = new FakeGitHub();
    assert.equal(await publish(github, candidate()), "published");
    assert.deepEqual(github.changes, [
      "tag 1.2.0",
      "draft 1.2.0",
      ...assetNames("1.2.0").map((name) => `upload ${name}`),
      "publish 1.2.0 latest",
    ]);
    assert.equal(github.tags.get("1.2.0"), SHA);
    assert.deepEqual(
      await verifyPublished(github, (url) => github.download(url), "1.2.0", {
        sha: SHA,
        expected: candidate().assets,
      }),
      [],
    );
  });

  it("resumes a run that stopped after any change, without uploading a file twice", async () => {
    const steps = [
      "tag 1.2.0",
      "draft 1.2.0",
      ...assetNames("1.2.0").map((name) => `upload ${name}`),
      "publish 1.2.0 latest",
    ];
    for (const stop of steps) {
      const github = new FakeGitHub();
      github.failOn = (change) => change === stop;
      await assert.rejects(publish(github, candidate()), /Injected failure/, stop);
      assert.equal(
        github.releases.some((release) => !release.draft),
        false,
        `nothing is published after ${stop} fails`,
      );
      assert.equal(await publish(github, candidate()), "published", `resumes after ${stop}`);
      assert.deepEqual(github.changes, steps, `each change happens once after ${stop} fails`);
    }
  });

  it("only reports a release that is already published with the same assets", async () => {
    const github = new FakeGitHub();
    await publish(github, candidate());
    github.changes.length = 0;
    assert.equal(await publish(github, candidate()), "already published");
    assert.deepEqual(github.changes, []);
  });

  it("refuses a tag on another commit, and changes nothing", async () => {
    const github = new FakeGitHub();
    github.tags.set("1.2.0", OTHER);
    await assert.rejects(
      publish(github, candidate()),
      (error) => error instanceof Refusal && /points to b+, not to a+/.test(error.message),
    );
    assert.deepEqual(github.changes, []);
  });

  it("never changes a published release whose assets differ or are missing", async () => {
    const incomplete = new FakeGitHub();
    const assets = new Map(candidate().assets);
    assets.delete(CHECKSUMS);
    incomplete.published("1.2.0", assets);
    incomplete.tags.set("1.2.0", SHA);
    await assert.rejects(
      publish(incomplete, candidate()),
      (error) => error instanceof Refusal && /missing: SHA256SUMS/.test(error.message),
    );
    assert.deepEqual(incomplete.changes, []);

    const different = new FakeGitHub();
    different.published("1.2.0", candidate("1.2.0", "other();").assets);
    different.tags.set("1.2.0", SHA);
    await assert.rejects(
      publish(different, candidate()),
      (error) => error instanceof Refusal && /different: .*main\.js/.test(error.message),
    );
    assert.deepEqual(different.changes, []);
  });

  it("refuses a draft that holds another candidate's file, and publishes nothing", async () => {
    const github = new FakeGitHub();
    github.failOn = (change) => change === "upload styles.css";
    await assert.rejects(publish(github, candidate("1.2.0", "earlier();")));
    await assert.rejects(
      publish(github, candidate()),
      (error) => error instanceof Refusal && /Delete the draft/.test(error.message),
    );
    assert.ok(!github.changes.some((change) => change.startsWith("publish")));
  });

  it("leaves a draft unpublished when an upload arrives damaged", async () => {
    const github = new FakeGitHub();
    github.corrupt = "main.js";
    await assert.rejects(publish(github, candidate()), /main\.js is not the one uploaded/);
    assert.ok(github.releases.every((release) => release.draft));
  });

  it("refuses an invalid candidate before changing anything", async () => {
    const github = new FakeGitHub();
    const broken = candidate();
    broken.assets.set("main.js", text("not what the zip holds"));
    await assert.rejects(publish(github, broken), Refusal);
    const missing = candidate();
    missing.assets.delete("styles.css");
    await assert.rejects(publish(github, missing), Refusal);
    assert.deepEqual(github.changes, []);
  });

  it("makes a release the latest only when no published full release is newer, and never a prerelease", async () => {
    const github = new FakeGitHub();
    github.published("2.0.0", packageRelease("2.0.0", plugin("2.0.0")));
    github.published("3.0.0-rc.1", packageRelease("3.0.0-rc.1", plugin("3.0.0-rc.1")), true);
    await publish(github, candidate("1.9.1"));
    await publish(github, candidate("2.1.0-rc.1"));
    await publish(github, candidate("2.1.0"));
    assert.deepEqual(
      github.changes.filter((change) => change.startsWith("publish")),
      ["publish 1.9.1", "publish 2.1.0-rc.1", "publish 2.1.0 latest"],
    );
    assert.equal((await github.findRelease("2.1.0-rc.1"))?.prerelease, true);
  });
});

describe("publishing, further cases", () => {
  it("works without GitHub's digests, by downloading the files to compare them", async () => {
    const github = new FakeGitHub();
    github.noDigests = true;
    github.failOn = (change) => change === "upload styles.css";
    await assert.rejects(publish(github, candidate("1.2.0", "earlier();")));
    await assert.rejects(
      publish(github, candidate()),
      (error) => error instanceof Refusal && /holds .*not this candidate's/.test(error.message),
    );
    const fresh = new FakeGitHub();
    fresh.noDigests = true;
    assert.equal(await publish(fresh, candidate()), "published");
    assert.equal(await publish(fresh, candidate()), "already published");
    assert.deepEqual(
      await verifyPublished(fresh, (url) => fresh.download(url), "1.2.0", { sha: SHA }),
      [],
    );
  });

  it("resumes a draft whose notes gained Windows line ends, and refuses one with other notes", async () => {
    const github = new FakeGitHub();
    github.failOn = (change) => change === "upload styles.css";
    await assert.rejects(publish(github, candidate()));
    github.releases[0].body = github.releases[0].body.replace(/\n/g, "\r\n");
    assert.equal(await publish(github, candidate()), "published");

    const edited = new FakeGitHub();
    edited.failOn = (change) => change === "upload styles.css";
    await assert.rejects(publish(edited, candidate()));
    edited.releases[0].body = "Other notes.";
    await assert.rejects(
      publish(edited, candidate()),
      (error) => error instanceof Refusal && /other notes/.test(error.message),
    );
  });

  it("reports a malformed checksums file instead of failing on it", () => {
    const assets = packageRelease("1.2.0", plugin("1.2.0"));
    const sums = new TextDecoder().decode(assets.get(CHECKSUMS));
    assets.set(CHECKSUMS, text(sums.replace(/\n/g, "\r\n")));
    assert.match(assetProblems("1.2.0", assets).join(" "), /SHA256SUMS is malformed/);
  });
});

describe("the latest release", () => {
  it("is checked after publishing: the newest full release, and no other", async () => {
    const github = new FakeGitHub();
    await publish(github, candidate("1.9.1"));
    await publish(github, candidate("2.1.0"));
    const verify = (version: string) =>
      verifyPublished(github, (url) => github.download(url), version);
    assert.deepEqual(await verify("2.1.0"), []);
    assert.deepEqual(await verify("1.9.1"), []);
    github.latest = "1.9.1";
    assert.match((await verify("2.1.0")).join(" "), /should be the latest release, but 1\.9\.1 is/);
    assert.match((await verify("1.9.1")).join(" "), /is marked as the latest release/);
  });
});

describe("a dry run", () => {
  it("lists what publishing would change, and changes nothing", async () => {
    const github = new FakeGitHub();
    const dry = new DryRun(github);
    assert.equal(await publish(dry, candidate()), "published");
    assert.deepEqual(github.changes, []);
    assert.deepEqual(github.tags.size + github.releases.length, 0);
    assert.equal(dry.changes.length, 2 + assetNames("1.2.0").length + 1);
    assert.match(dry.changes[0], /^create the tag 1\.2\.0 at a+$/);
    assert.match(dry.changes.at(-1)!, /^publish the release 1\.2\.0 as the latest$/);
  });

  it("plans only the rest of a stopped run, and refuses what a real run would", async () => {
    const github = new FakeGitHub();
    github.failOn = (change) => change === "upload styles.css";
    await assert.rejects(publish(github, candidate()));
    const before = github.changes.length;
    const dry = new DryRun(github);
    await publish(dry, candidate());
    assert.deepEqual(
      dry.changes.map((change) => change.split(" (")[0]),
      ["upload styles.css", `upload ${CHECKSUMS}`, "publish the release 1.2.0 as the latest"],
    );
    assert.equal(github.changes.length, before);

    const elsewhere = new FakeGitHub();
    elsewhere.tags.set("1.2.0", OTHER);
    await assert.rejects(publish(new DryRun(elsewhere), candidate()), Refusal);
  });
});

describe("verifying a published release", () => {
  async function published(): Promise<FakeGitHub> {
    const github = new FakeGitHub();
    await publish(github, candidate());
    return github;
  }

  it("finds a download that differs from its checksum or from GitHub's digest", async () => {
    const github = await published();
    const release = github.releases[0];
    const main = release.assets.find((asset) => asset.name === "main.js")!;
    github.bytes.set(main.id, text("tampered"));
    const problems = await verifyPublished(github, (url) => github.download(url), "1.2.0", {
      sha: SHA,
    });
    assert.match(problems.join(" "), /main\.js does not match GitHub's digest/);
    assert.match(problems.join(" "), /main\.js does not match its checksum/);
    assert.match(problems.join(" "), /zip's main\.js differs/);
  });

  it("finds a draft, a missing release, a tag elsewhere, and files other than those built", async () => {
    const draft = new FakeGitHub();
    draft.failOn = (change) => change.startsWith("publish");
    await assert.rejects(publish(draft, candidate()));
    assert.match(
      (await verifyPublished(draft, (url) => draft.download(url), "1.2.0")).join(" "),
      /still a draft/,
    );
    assert.match(
      (await verifyPublished(new FakeGitHub(), async () => new Uint8Array(), "1.2.0")).join(" "),
      /no release/,
    );

    const github = await published();
    assert.match(
      (await verifyPublished(github, (url) => github.download(url), "1.2.0", { sha: OTHER })).join(
        " ",
      ),
      /points to a+, not b+/,
    );
    const problems = await verifyPublished(github, (url) => github.download(url), "1.2.0", {
      expected: candidate("1.2.0", "rebuilt();").assets,
    });
    assert.match(problems.join(" "), /main\.js differs from the one built/);
  });
});

describe("the release script", () => {
  // The workflow runs it with Node.js, which strips its types and runs only
  // what remains: this fails if it uses TypeScript that Node.js cannot strip.
  it("runs under Node.js, and checks the manifest's version as releasable", () => {
    const { version } = JSON.parse(fs.readFileSync("manifest.json", "utf8")) as { version: string };
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["scripts/release.ts", ...args], { encoding: "utf8" });
    const good = run("check", version);
    assert.equal(good.status, 0, good.stderr);
    assert.ok(good.stdout.includes(`${version} is ready`), good.stdout);
    const bad = run("check", "0.0.0-not-this");
    assert.equal(bad.status, 1);
    assert.ok(bad.stderr.includes(`manifest.json has ${version}.`), bad.stderr);
  });
});
