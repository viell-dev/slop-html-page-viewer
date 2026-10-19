// End-to-end tests in real Obsidian, through WebdriverIO and
// wdio-obsidian-service. Build the plugin at the repository root first; this
// configuration copies the built plugin into dist/e2e-plugin. Each Obsidian
// version runs the suites against a copy of vaults/pages, and the corpus spec
// against the archive corpus that corpus/generate.mjs builds. The corpus spec
// also runs once with the frozen prototype build (prototype/), for
// corpus/compare.mjs.
//
// OBSIDIAN_VERSIONS lists "appVersion/installerVersion" pairs. The default
// tests the oldest public release the manifest allows on the oldest installer
// that can run it, and the latest public release. The manifest's minAppVersion,
// 1.5.0, was an Insider build, which needs an account to download; 1.5.3 was the
// first public 1.5 release.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseObsidianVersions } from "wdio-obsidian-service";

const root = path.resolve(import.meta.dirname, "../..");

function setting(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

const cacheDir = path.resolve(setting(process.env.OBSIDIAN_CACHE_DIR) ?? path.join(root, ".obsidian-cache"));
const outputDir = path.resolve(setting(process.env.E2E_OUTPUT_DIR) ?? path.join(root, "test-results", "e2e"));
const pluginDir = path.join(root, "dist", "e2e-plugin");
const corpusDir = path.join(root, "dist", "e2e-vaults", "archive");
const prototypeDir = path.join(import.meta.dirname, "prototype");
const specs = (name: string) => path.join(import.meta.dirname, "specs", name);

const versions = await parseObsidianVersions(
  setting(process.env.OBSIDIAN_VERSIONS) ?? "1.5.3/earliest latest/latest",
  { cacheDir },
);

if (setting(process.env.PRINT_OBSIDIAN_CACHE_KEY) !== undefined) {
  // CI runs this file on its own to key its download cache on the versions.
  console.log(`obsidian-cache-key:${JSON.stringify(versions)}`);
} else if (process.env.WDIO_WORKER_ID === undefined) {
  // The launcher assembles the plugin and clears the previous run's output.
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.mkdirSync(pluginDir, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    const source = path.join(root, file);
    if (!fs.existsSync(source)) throw new Error(`${source} is missing; run npm run build first.`);
    fs.copyFileSync(source, path.join(pluginDir, file));
  }
  for (const entry of ["logs", "screenshots"]) {
    fs.rmSync(path.join(outputDir, entry), { recursive: true, force: true });
  }
  for (const entry of fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : []) {
    if (/^corpus-.*\.json$/.test(entry)) fs.rmSync(path.join(outputDir, entry));
  }
  fs.mkdirSync(path.join(outputDir, "screenshots"), { recursive: true });
  const generated = spawnSync(process.execPath, [path.join(import.meta.dirname, "corpus", "generate.mjs"), corpusDir], {
    stdio: "inherit",
  });
  if (generated.status !== 0) throw new Error("Generating the archive corpus failed.");
}

// E2E_ONLY lists spec file names to run, such as "links.e2e.ts", for a quick
// run while working on one suite; capabilities left without specs are dropped.
const only = setting(process.env.E2E_ONLY)?.split(",").map((name) => name.trim());

function capability(appVersion: string, installerVersion: string, plugin: string, vault: string, files: string[]) {
  files = only ? files.filter((file) => only.includes(path.basename(file))) : files;
  return {
    browserName: "obsidian",
    browserVersion: appVersion,
    "wdio:specs": files,
    "wdio:obsidianOptions": { installerVersion, plugins: [plugin], vault },
    "goog:chromeOptions": { args: ["--disable-dev-shm-usage"] },
  };
}

const latest = versions.at(-1)!;

export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",
  specs: [path.join(import.meta.dirname, "specs/**/*.e2e.ts")],
  maxInstances: Number(setting(process.env.WDIO_MAX_INSTANCES) ?? 2),
  capabilities: [
    ...versions.flatMap(([appVersion, installerVersion]) => [
      capability(appVersion, installerVersion, pluginDir, path.join(import.meta.dirname, "vaults", "pages"), [
        specs("viewer.e2e.ts"),
        specs("resources.e2e.ts"),
        specs("theme.e2e.ts"),
        specs("links.e2e.ts"),
      ]),
      capability(appVersion, installerVersion, pluginDir, corpusDir, [specs("corpus.e2e.ts")]),
    ]),
    capability(latest[0], latest[1], prototypeDir, corpusDir, [specs("corpus.e2e.ts")]),
  ].filter((entry) => entry["wdio:specs"].length > 0),
  services: ["obsidian"],
  reporters: ["obsidian"],
  cacheDir,
  outputDir: path.join(outputDir, "logs"),
  injectGlobals: false,
  mochaOpts: { ui: "bdd", timeout: 60_000 },
  logLevel: "warn",
};
