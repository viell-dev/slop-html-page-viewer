// The release workflow's steps, which also run locally with Node.js 24:
//
//   node scripts/release.ts check <version>
//       The version files, release notes, and changelog agree on <version>.
//   node scripts/release.ts verify-ci <sha>
//       Every check that the ruleset for main requires passed on <sha>.
//   node scripts/release.ts package <version> [--out release]
//       Packages the built plugin into the release's assets.
//   node scripts/release.ts publish <version> --sha <sha> [--assets release] [--dry-run]
//       Publishes the assets through a draft release, or resumes a stopped
//       run. With --dry-run, it only reads, and lists what it would change.
//   node scripts/release.ts verify-published <version> [--sha <sha>] [--assets release]
//       Downloads the published release as a user would, and checks it.
//
// GitHub is reached with GH_TOKEN or GITHUB_TOKEN, or anonymously without
// either; GITHUB_REPOSITORY names the repository. RELEASING.md describes the
// procedure and what to do when a step fails.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assetNames,
  type CheckRun,
  checkProblems,
  DryRun,
  type Files,
  type GitHub,
  packageRelease,
  PLUGIN_FILES,
  publish,
  Refusal,
  type Release,
  type ReleaseAsset,
  requiredChecks,
  verifyPublished,
  versionProblems,
} from "./release-lib.ts";

const REPOSITORY = process.env.GITHUB_REPOSITORY ?? "viell-dev/slop-html-page-viewer";
const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const API = `https://api.github.com/repos/${REPOSITORY}`;

async function request(
  url: string,
  options: { method?: string; body?: unknown; bytes?: Uint8Array; accept?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: options.accept ?? "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  let body: BodyInit | undefined;
  if (options.bytes !== undefined) {
    headers["Content-Type"] = "application/octet-stream";
    body = Buffer.from(options.bytes);
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  return fetch(url, { method: options.method ?? "GET", headers, body });
}

async function json<T>(url: string, options?: Parameters<typeof request>[1]): Promise<T> {
  const response = await request(url, options);
  if (!response.ok)
    throw new Error(
      `${options?.method ?? "GET"} ${url}: ${response.status} ${await response.text()}`,
    );
  return (await response.json()) as T;
}

interface ApiRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  name: string | null;
  body: string | null;
  assets: {
    id: number;
    name: string;
    size: number;
    digest?: string | null;
    browser_download_url: string;
  }[];
}

const toRelease = (release: ApiRelease): Release => ({
  id: release.id,
  tag: release.tag_name,
  draft: release.draft,
  prerelease: release.prerelease,
  name: release.name ?? "",
  body: release.body ?? "",
  assets: release.assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    size: asset.size,
    digest: asset.digest ?? null,
    url: asset.browser_download_url,
  })),
});

class RestGitHub implements GitHub {
  private async releases(): Promise<ApiRelease[]> {
    const all: ApiRelease[] = [];
    for (let page = 1; ; page++) {
      const batch = await json<ApiRelease[]>(`${API}/releases?per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }

  async tagCommit(tag: string): Promise<string | null> {
    const response = await request(`${API}/git/ref/tags/${encodeURIComponent(tag)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Reading the tag ${tag}: ${response.status}`);
    let object = ((await response.json()) as { object: { type: string; sha: string } }).object;
    while (object.type === "tag") {
      object = (
        await json<{ object: { type: string; sha: string } }>(`${API}/git/tags/${object.sha}`)
      ).object;
    }
    return object.sha;
  }

  async findRelease(tag: string): Promise<Release | null> {
    const found = (await this.releases()).find((release) => release.tag_name === tag);
    return found === undefined ? null : toRelease(found);
  }

  async publishedTags(): Promise<{ tag: string; prerelease: boolean }[]> {
    return (await this.releases())
      .filter((release) => !release.draft)
      .map((release) => ({ tag: release.tag_name, prerelease: release.prerelease }));
  }

  async downloadAsset(asset: ReleaseAsset): Promise<Uint8Array> {
    const response = await request(`${API}/releases/assets/${asset.id}`, {
      accept: "application/octet-stream",
    });
    if (!response.ok) throw new Error(`Downloading ${asset.name}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async createTag(tag: string, sha: string): Promise<void> {
    await json(`${API}/git/refs`, { method: "POST", body: { ref: `refs/tags/${tag}`, sha } });
  }

  async createDraft(
    tag: string,
    details: { name: string; body: string; prerelease: boolean },
  ): Promise<Release> {
    return toRelease(
      await json<ApiRelease>(`${API}/releases`, {
        method: "POST",
        body: {
          tag_name: tag,
          name: details.name,
          body: details.body,
          draft: true,
          prerelease: details.prerelease,
        },
      }),
    );
  }

  async uploadAsset(release: Release, name: string, bytes: Uint8Array): Promise<void> {
    await json(
      `https://uploads.github.com/repos/${REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      { method: "POST", bytes },
    );
  }

  async publishRelease(release: Release, latest: boolean): Promise<void> {
    await json(`${API}/releases/${release.id}`, {
      method: "PATCH",
      body: { draft: false, make_latest: latest ? "true" : "false" },
    });
  }
}

/**
 * Downloads a public address as a user would: without a token. A release's
 * files can take a moment to be served after it is published, so a failed
 * download is tried again, five times in all.
 */
async function downloadPublic(url: string): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url);
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
    if (attempt === 5) throw new Error(`Downloading ${url}: ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
}

async function checkRuns(sha: string): Promise<CheckRun[]> {
  const runs: CheckRun[] = [];
  for (let page = 1; ; page++) {
    const batch = await json<{
      check_runs: {
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        app: { id: number } | null;
      }[];
    }>(`${API}/commits/${sha}/check-runs?filter=all&per_page=100&page=${page}`);
    runs.push(
      ...batch.check_runs.map((run) => ({
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        appId: run.app?.id ?? -1,
      })),
    );
    if (batch.check_runs.length < 100) return runs;
  }
}

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const readIfThere = (file: string): string | null =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;

function readAssets(directory: string, version: string): Files {
  const present = fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
  const wanted = assetNames(version);
  if (present.join("\n") !== [...wanted].sort().join("\n"))
    throw new Refusal(
      `${directory} holds ${present.join(", ") || "nothing"}, not ${wanted.join(", ")}.`,
    );
  return new Map(
    wanted.map((name) => [name, new Uint8Array(fs.readFileSync(path.join(directory, name)))]),
  );
}

function parseArguments(argv: string[]): {
  positional: string[];
  options: Map<string, string | true>;
} {
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (!argument.startsWith("--")) positional.push(argument);
    else if (argument === "--dry-run") options.set("dry-run", true);
    else options.set(argument.slice(2), argv[++i] ?? "");
  }
  return { positional, options };
}

function fail(lines: string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, options } = parseArguments(rest);
  const option = (name: string): string | undefined => {
    const value = options.get(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const target = positional[0];
  if (target === undefined) fail(["Usage: see the top of scripts/release.ts."]);

  switch (command) {
    case "check": {
      const problems = versionProblems(target, {
        manifest: readJson("manifest.json"),
        pkg: readJson("package.json"),
        lock: readJson("package-lock.json"),
        versions: readJson("versions.json"),
        notes: readIfThere(path.join(".github", "release-notes", `${target}.md`)),
        changelog: fs.readFileSync("CHANGELOG.md", "utf8"),
      });
      if (problems.length > 0) fail(problems);
      console.log(`${target} is ready to release from these files.`);
      return;
    }
    case "verify-ci": {
      const required = requiredChecks(readJson(path.join(".github", "rulesets", "main.json")));
      const problems = checkProblems(required, await checkRuns(target));
      if (problems.length > 0)
        fail([`The checks of ${target} do not allow a release:`, ...problems]);
      console.log(
        `Every required check passed on ${target}: ${required.map((check) => check.context).join(", ")}.`,
      );
      return;
    }
    case "package": {
      const out = option("out") ?? "release";
      const manifest = readJson<{ version: string }>("manifest.json");
      if (manifest.version !== target)
        fail([`manifest.json has ${manifest.version}, not ${target}.`]);
      const plugin: Files = new Map(
        PLUGIN_FILES.map((name) => {
          if (!fs.existsSync(name)) fail([`${name} is missing; run npm run build first.`]);
          return [name, new Uint8Array(fs.readFileSync(name))];
        }),
      );
      const assets = packageRelease(target, plugin);
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      for (const [name, bytes] of assets) fs.writeFileSync(path.join(out, name), bytes);
      process.stdout.write(Buffer.from(assets.get("SHA256SUMS")!));
      return;
    }
    case "publish": {
      const sha = option("sha") ?? process.env.GITHUB_SHA;
      if (sha === undefined) fail(["publish needs --sha, the commit that was verified and built."]);
      const assets = readAssets(option("assets") ?? "release", target);
      const notes = fs.readFileSync(path.join(".github", "release-notes", `${target}.md`), "utf8");
      const real = new RestGitHub();
      const github = options.has("dry-run") ? new DryRun(real) : real;
      const result = await publish(github, { version: target, sha, assets, notes }, (line) =>
        console.log(line),
      );
      if (github instanceof DryRun) {
        console.log(
          github.changes.length === 0
            ? "Dry run: nothing would change."
            : ["Dry run: publishing would", ...github.changes.map((change) => `- ${change}`)].join(
                "\n",
              ),
        );
        if (result === "already published") {
          const problems = await verifyPublished(real, downloadPublic, target, {
            sha,
            expected: assets,
          });
          if (problems.length > 0) fail(problems);
          console.log(`The published ${target} matches this candidate.`);
        }
      }
      return;
    }
    case "verify-published": {
      const directory = option("assets");
      const problems = await verifyPublished(new RestGitHub(), downloadPublic, target, {
        sha: option("sha"),
        expected: directory === undefined ? undefined : readAssets(directory, target),
      });
      if (problems.length > 0)
        fail([`The published ${target} is not as it should be:`, ...problems]);
      console.log(
        `The published ${target} verifies: its assets match their checksums, the zip, and each other.`,
      );
      return;
    }
    default:
      fail([`Unknown command ${command ?? ""}; see the top of scripts/release.ts.`]);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Refusal ? `Refused: ${error.message}` : error);
  process.exit(1);
});
