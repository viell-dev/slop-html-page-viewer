// The release procedure that scripts/release.ts runs: checking a version and
// its commit, packaging the plugin, publishing it through a draft release, and
// verifying what was published. GitHub is reached through the `GitHub`
// interface, so that the tests can stand in for it, and a dry run can record
// what it would change instead of changing it.

import { createHash } from "node:crypto";
import zlib from "node:zlib";

export const PLUGIN_ID = "viell-html-page-viewer";
export const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"] as const;
export const CHECKSUMS = "SHA256SUMS";

export function zipName(version: string): string {
  return `${PLUGIN_ID}-${version}.zip`;
}

/** The release's assets in the order they are uploaded: the checksums last. */
export function assetNames(version: string): string[] {
  return [zipName(version), ...PLUGIN_FILES, CHECKSUMS];
}

export type Files = Map<string, Uint8Array>;

/** A refusal: publishing would be wrong, and the message says what to do. */
export class Refusal extends Error {}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

// SemVer 2.0.0 without build metadata, which a tag should not carry.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export function isVersion(version: string): boolean {
  return SEMVER.test(version);
}

export function isPrerelease(version: string): boolean {
  return version.includes("-");
}

/** SemVer precedence: negative when a comes before b. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [core, pre] = version.split(/-(.*)/s);
    return { core: core.split(".").map(Number), pre: pre === undefined ? [] : pre.split(".") };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    const [m, n] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (m && n) return Number(p) - Number(q);
    if (m !== n) return m ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
}

// ---- The version and its files ------------------------------------------

export interface Sources {
  manifest: { version: string; minAppVersion: string };
  pkg: { version: string };
  lock: { version: string; packages: Record<string, { version?: string }> };
  versions: Record<string, string>;
  notes: string | null;
  changelog: string;
}

/** What keeps a version from being released from these files; empty when nothing does. */
export function versionProblems(version: string, sources: Sources): string[] {
  const problems: string[] = [];
  if (!isVersion(version))
    problems.push(`${version} is not a SemVer version without build metadata.`);
  if (sources.manifest.version !== version)
    problems.push(`manifest.json has ${sources.manifest.version}.`);
  if (sources.pkg.version !== version) problems.push(`package.json has ${sources.pkg.version}.`);
  if (sources.lock.version !== version || sources.lock.packages[""]?.version !== version)
    problems.push("package-lock.json has another version.");
  if (sources.versions[version] !== sources.manifest.minAppVersion)
    problems.push(`versions.json does not map ${version} to ${sources.manifest.minAppVersion}.`);
  if (sources.notes === null || sources.notes.trim() === "")
    problems.push(`.github/release-notes/${version}.md is missing or empty.`);
  const heading = `## [${version}](.github/release-notes/${version}.md) - `;
  if (!sources.changelog.split("\n").some((line) => line.startsWith(heading)))
    problems.push(`CHANGELOG.md has no section for ${version}.`);
  return problems;
}

// ---- The commit's checks --------------------------------------------------

export interface RequiredCheck {
  context: string;
  integration_id: number;
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  appId: number;
}

/** The status checks that a ruleset requires. */
export function requiredChecks(ruleset: {
  rules: { type: string; parameters?: { required_status_checks?: RequiredCheck[] } }[];
}): RequiredCheck[] {
  return ruleset.rules.flatMap((rule) =>
    rule.type === "required_status_checks" ? (rule.parameters?.required_status_checks ?? []) : [],
  );
}

/**
 * What keeps the commit's required checks from counting as passed: each must
 * have run from its app, and its latest run must have succeeded.
 */
export function checkProblems(required: RequiredCheck[], runs: CheckRun[]): string[] {
  if (required.length === 0) return ["The ruleset requires no checks, so none can be verified."];
  return required.flatMap(({ context, integration_id }) => {
    const latest = runs
      .filter((run) => run.name === context && run.appId === integration_id)
      .sort((a, b) => b.id - a.id)[0];
    if (latest === undefined) return [`${context} has not run on this commit.`];
    if (latest.status !== "completed") return [`${context} is still ${latest.status}.`];
    if (latest.conclusion !== "success") return [`${context} concluded ${latest.conclusion}.`];
    return [];
  });
}

// ---- Packaging --------------------------------------------------------------

// Every entry is dated 1980-01-01 00:00, the earliest time a zip can hold, so
// that packaging the same files always gives the same bytes.
const DOS_DATE = (1 << 5) | 1;
const DOS_TIME = 0;

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** A zip of a folder of files, the same bytes for the same files. */
export function createZip(folder: string, entries: ZipEntry[]): Uint8Array {
  const all = [
    { name: `${folder}/`, data: new Uint8Array(), directory: true },
    ...entries.map((entry) => ({ ...entry, name: `${folder}/${entry.name}`, directory: false })),
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of all) {
    const name = Buffer.from(entry.name, "utf8");
    const stored = entry.directory;
    const body = stored ? Buffer.alloc(0) : zlib.deflateRawSync(entry.data, { level: 9 });
    const crc = zlib.crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 10 : 20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Made on Unix, zip 2.0.
    central.writeUInt16LE(stored ? 10 : 20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // Unix modes: a folder at 755 with the DOS folder flag, files at 644.
    central.writeUInt32LE(stored ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(all.length, 8);
  end.writeUInt16LE(all.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/** The files in a zip, by path, without its folders; throws on a damaged zip. */
export function readZip(bytes: Uint8Array): Files {
  const zip = Buffer.from(bytes);
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a zip: no end of central directory.");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files: Files = new Map();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("Damaged central directory.");
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`Damaged entry ${name}.`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + compressed);
    const data = method === 0 ? body : method === 8 ? zlib.inflateRawSync(body) : null;
    if (data === null) throw new Error(`${name} uses compression method ${method}.`);
    if (data.length !== size || zlib.crc32(data) !== crc) throw new Error(`${name} is damaged.`);
    files.set(name, new Uint8Array(data));
  }
  return files;
}

/** The checksums file: one `<sha256>  <name>` line for each file, in order. */
export function checksumsText(files: Files): string {
  return [...files].map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).join("");
}

export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error(`Not a checksum line: ${line}`);
    sums.set(match[2], match[1]);
  }
  return sums;
}

/** The release's assets for the plugin's three files. */
export function packageRelease(version: string, plugin: Files): Files {
  const entries = PLUGIN_FILES.map((name) => {
    const data = plugin.get(name);
    if (data === undefined) throw new Error(`${name} is missing; build the plugin first.`);
    return { name, data };
  });
  const loose: Files = new Map([
    [zipName(version), createZip(PLUGIN_ID, entries)],
    ...entries.map(({ name, data }): [string, Uint8Array] => [name, data]),
  ]);
  return new Map([...loose, [CHECKSUMS, new TextEncoder().encode(checksumsText(loose))]]);
}

/**
 * What is wrong with a release's assets, as downloaded: the set of names, the
 * checksums, the zip's contents against the loose files, and the manifest's
 * version. With `expected`, each asset must also be exactly the expected file.
 */
export function assetProblems(version: string, assets: Files, expected?: Files): string[] {
  const problems: string[] = [];
  const names = [...assets.keys()].sort();
  const wanted = assetNames(version).sort();
  if (names.join("\n") !== wanted.join("\n"))
    return [`The assets are ${names.join(", ") || "none"}, not ${wanted.join(", ")}.`];
  const sums = parseChecksums(new TextDecoder().decode(assets.get(CHECKSUMS)));
  const summed = [...sums.keys()].sort();
  const others = wanted.filter((name) => name !== CHECKSUMS).sort();
  if (summed.join("\n") !== others.join("\n"))
    problems.push(`${CHECKSUMS} lists ${summed.join(", ")}, not ${others.join(", ")}.`);
  for (const [name, hash] of sums) {
    const bytes = assets.get(name);
    if (bytes !== undefined && sha256(bytes) !== hash)
      problems.push(`${name} does not match its checksum.`);
  }
  try {
    const zipped = readZip(assets.get(zipName(version)) ?? new Uint8Array());
    const inZip = [...zipped.keys()].sort();
    const want = PLUGIN_FILES.map((name) => `${PLUGIN_ID}/${name}`).sort();
    if (inZip.join("\n") !== want.join("\n"))
      problems.push(`The zip holds ${inZip.join(", ")}, not ${want.join(", ")}.`);
    for (const name of PLUGIN_FILES) {
      const inside = zipped.get(`${PLUGIN_ID}/${name}`);
      const loose = assets.get(name);
      if (inside && loose && !same(inside, loose))
        problems.push(`The zip's ${name} differs from the loose ${name}.`);
    }
  } catch (error) {
    problems.push(`The zip cannot be read: ${(error as Error).message}`);
  }
  try {
    const manifest = JSON.parse(new TextDecoder().decode(assets.get("manifest.json"))) as {
      version?: unknown;
    };
    if (manifest.version !== version)
      problems.push(`manifest.json says ${String(manifest.version)}.`);
  } catch {
    problems.push("manifest.json is not JSON.");
  }
  if (expected !== undefined) {
    for (const [name, bytes] of expected) {
      const actual = assets.get(name);
      if (actual !== undefined && !same(actual, bytes))
        problems.push(`${name} differs from the one built for this release.`);
    }
  }
  return problems;
}

// ---- GitHub -------------------------------------------------------------------

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  /** `sha256:<hex>`, which GitHub computes for each upload, when it gives one. */
  digest: string | null;
  /** The public download address. */
  url: string;
}

export interface Release {
  id: number;
  tag: string;
  draft: boolean;
  prerelease: boolean;
  name: string;
  body: string;
  assets: ReleaseAsset[];
}

export interface GitHub {
  /** The commit that a tag points to, through any annotated tag, or null. */
  tagCommit(tag: string): Promise<string | null>;
  /** The release for a tag, a draft too where the token can see drafts. */
  findRelease(tag: string): Promise<Release | null>;
  /** The published, non-draft releases' tags. */
  publishedTags(): Promise<{ tag: string; prerelease: boolean }[]>;
  /** An asset's bytes, through the API, which also reaches a draft's. */
  downloadAsset(asset: ReleaseAsset): Promise<Uint8Array>;
  /** Fails if the tag exists. */
  createTag(tag: string, sha: string): Promise<void>;
  createDraft(
    tag: string,
    details: { name: string; body: string; prerelease: boolean },
  ): Promise<Release>;
  uploadAsset(release: Release, name: string, bytes: Uint8Array): Promise<void>;
  publishRelease(release: Release, latest: boolean): Promise<void>;
}

export interface Candidate {
  version: string;
  /** The commit that was verified and built. */
  sha: string;
  assets: Files;
  notes: string;
}

/** Whether an uploaded asset is exactly these bytes, by GitHub's digest, or by downloading it. */
async function holds(github: GitHub, asset: ReleaseAsset, bytes: Uint8Array): Promise<boolean> {
  if (asset.size !== bytes.length) return false;
  if (asset.digest !== null) return asset.digest === `sha256:${sha256(bytes)}`;
  return same(await github.downloadAsset(asset), bytes);
}

/** Puts the tag on the candidate's commit, or checks that it is there already. */
async function claimTag(
  github: GitHub,
  candidate: Candidate,
  log: (line: string) => void,
): Promise<void> {
  const { version, sha } = candidate;
  let commit = await github.tagCommit(version);
  if (commit === null) {
    try {
      await github.createTag(version, sha);
      log(`Tagged ${sha} as ${version}.`);
      return;
    } catch (error) {
      // Another run may have created it meanwhile; it must then point here.
      commit = await github.tagCommit(version);
      if (commit === null) throw error;
    }
  }
  if (commit !== sha)
    throw new Refusal(
      `The tag ${version} points to ${commit}, not to ${sha}. Version tags never move: release this commit under a new version.`,
    );
  log(`The tag ${version} already points to ${sha}.`);
}

/**
 * Publishes a candidate: tags its commit, uploads its assets to a draft
 * release, checks the draft's assets, and publishes it. A run that stopped
 * part way resumes: an existing tag must point to the commit, and a draft's
 * existing assets must be exactly the candidate's. A published release is
 * never changed: rerunning one that is complete and identical only reports so.
 */
export async function publish(
  github: GitHub,
  candidate: Candidate,
  log: (line: string) => void = () => {},
): Promise<"published" | "already published"> {
  const { version, assets, notes } = candidate;
  const order = assetNames(version);
  if ([...assets.keys()].sort().join("\n") !== [...order].sort().join("\n"))
    throw new Refusal(`The candidate's assets are not ${order.join(", ")}.`);
  const problems = assetProblems(version, assets);
  if (problems.length > 0) throw new Refusal(`The candidate is not valid: ${problems.join(" ")}`);

  await claimTag(github, candidate, log);

  let release = await github.findRelease(version);
  if (release !== null && !release.draft) {
    const missing = order.filter((name) => !release!.assets.some((asset) => asset.name === name));
    const extra = release.assets.filter((asset) => !order.includes(asset.name));
    const different: string[] = [];
    for (const asset of release.assets) {
      const bytes = assets.get(asset.name);
      if (bytes !== undefined && !(await holds(github, asset, bytes))) different.push(asset.name);
    }
    if (missing.length + extra.length + different.length === 0) {
      log(`Release ${version} is already published with these assets.`);
      return "already published";
    }
    throw new Refusal(
      `Release ${version} is published, and its assets differ from this candidate ` +
        `(missing: ${missing.join(", ") || "none"}; extra: ${extra.map((a) => a.name).join(", ") || "none"}; ` +
        `different: ${different.join(", ") || "none"}). A published release is never changed: publish a new version.`,
    );
  }

  if (release === null) {
    release = await github.createDraft(version, {
      name: version,
      body: notes,
      prerelease: isPrerelease(version),
    });
    log(`Created draft release ${version}.`);
  } else {
    if (release.body.trim() !== notes.trim() || release.prerelease !== isPrerelease(version))
      throw new Refusal(
        `The draft release ${version} has other notes or another prerelease setting. Delete the draft, which was never published, and run again.`,
      );
    for (const asset of release.assets) {
      const bytes = assets.get(asset.name);
      if (bytes === undefined || !(await holds(github, asset, bytes)))
        throw new Refusal(
          `The draft release ${version} holds ${asset.name}, which is not this candidate's. Delete the draft, which was never published, and run again.`,
        );
    }
    log(`Resuming draft release ${version}.`);
  }

  for (const name of order) {
    if (release.assets.some((asset) => asset.name === name)) continue;
    await github.uploadAsset(release, name, assets.get(name)!);
    log(`Uploaded ${name}.`);
  }

  const draft = await github.findRelease(version);
  if (draft === null || !draft.draft) throw new Error(`The draft release ${version} disappeared.`);
  for (const name of order) {
    const asset = draft.assets.find((candidateAsset) => candidateAsset.name === name);
    if (asset === undefined || !(await holds(github, asset, assets.get(name)!)))
      throw new Error(`The draft's ${name} is not the one uploaded; it stays unpublished.`);
  }
  if (draft.assets.length !== order.length)
    throw new Error(`The draft has assets besides ${order.join(", ")}.`);

  const published = await github.publishedTags();
  const latest =
    !isPrerelease(version) &&
    published.every(
      ({ tag, prerelease }) => prerelease || !isVersion(tag) || compareVersions(tag, version) < 0,
    );
  await github.publishRelease(draft, latest);
  log(`Published release ${version}${latest ? " as the latest" : ""}.`);
  return "published";
}

/**
 * A GitHub that records the changes a run would make, and shows later steps
 * the state those changes would leave, without changing anything.
 */
export class DryRun implements GitHub {
  readonly changes: string[] = [];
  private readonly tags = new Map<string, string>();
  private release: Release | null | undefined;
  private readonly uploaded = new Map<number, Uint8Array>();
  private nextId = -1;

  private readonly real: GitHub;

  // Node.js runs this file by stripping its types, which leaves no parameter properties.
  constructor(real: GitHub) {
    this.real = real;
  }

  async tagCommit(tag: string): Promise<string | null> {
    return this.tags.get(tag) ?? this.real.tagCommit(tag);
  }

  async findRelease(tag: string): Promise<Release | null> {
    if (this.release !== undefined && this.release?.tag === tag)
      return structuredClone(this.release);
    return this.real.findRelease(tag);
  }

  publishedTags(): Promise<{ tag: string; prerelease: boolean }[]> {
    return this.real.publishedTags();
  }

  async downloadAsset(asset: ReleaseAsset): Promise<Uint8Array> {
    return this.uploaded.get(asset.id) ?? this.real.downloadAsset(asset);
  }

  async createTag(tag: string, sha: string): Promise<void> {
    if ((await this.real.tagCommit(tag)) !== null) throw new Error(`The tag ${tag} exists.`);
    this.changes.push(`create the tag ${tag} at ${sha}`);
    this.tags.set(tag, sha);
  }

  createDraft(
    tag: string,
    details: { name: string; body: string; prerelease: boolean },
  ): Promise<Release> {
    this.changes.push(`create a draft release ${tag}${details.prerelease ? ", a prerelease" : ""}`);
    this.release = { id: this.nextId--, tag, draft: true, assets: [], ...details };
    return Promise.resolve(structuredClone(this.release));
  }

  uploadAsset(release: Release, name: string, bytes: Uint8Array): Promise<void> {
    this.changes.push(`upload ${name} (${bytes.length} bytes, sha256 ${sha256(bytes)})`);
    if (this.release === undefined || this.release === null)
      this.release = structuredClone(release);
    const id = this.nextId--;
    this.uploaded.set(id, bytes);
    this.release.assets.push({
      id,
      name,
      size: bytes.length,
      digest: `sha256:${sha256(bytes)}`,
      url: "",
    });
    return Promise.resolve();
  }

  publishRelease(release: Release, latest: boolean): Promise<void> {
    this.changes.push(`publish the release ${release.tag}${latest ? " as the latest" : ""}`);
    if (this.release) this.release.draft = false;
    return Promise.resolve();
  }
}

/**
 * Verifies a published release as its users download it: published, on the
 * expected commit, with exactly its assets, which match their checksums and
 * each other, and, with `expected`, the files built for it.
 */
export async function verifyPublished(
  github: GitHub,
  download: (url: string) => Promise<Uint8Array>,
  version: string,
  options: { sha?: string; expected?: Files } = {},
): Promise<string[]> {
  const release = await github.findRelease(version);
  if (release === null) return [`There is no release ${version}.`];
  if (release.draft) return [`Release ${version} is still a draft.`];
  const problems: string[] = [];
  if (release.prerelease !== isPrerelease(version))
    problems.push(
      `Release ${version} is ${release.prerelease ? "" : "not "}marked as a prerelease.`,
    );
  if (options.sha !== undefined) {
    const commit = await github.tagCommit(version);
    if (commit !== options.sha)
      problems.push(`The tag ${version} points to ${commit}, not ${options.sha}.`);
  }
  const assets: Files = new Map();
  for (const asset of release.assets) {
    const bytes = await download(asset.url);
    if (asset.digest !== null && asset.digest !== `sha256:${sha256(bytes)}`)
      problems.push(`The download of ${asset.name} does not match GitHub's digest.`);
    assets.set(asset.name, bytes);
  }
  return [...problems, ...assetProblems(version, assets, options.expected)];
}
