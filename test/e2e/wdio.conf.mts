// End-to-end tests in real Obsidian, through WebdriverIO and
// wdio-obsidian-service. Build the plugin at the repository root first; this
// configuration copies the built plugin into dist/e2e-plugin and installs it
// into a copy of vaults/pages.
//
// OBSIDIAN_VERSIONS lists "appVersion/installerVersion" pairs. The default
// tests the oldest public release the manifest allows on the oldest installer
// that can run it, and the latest public release. The manifest's minAppVersion,
// 1.5.0, was an Insider build, which needs an account to download; 1.5.3 was the
// first public 1.5 release.

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
  fs.mkdirSync(path.join(outputDir, "screenshots"), { recursive: true });
}

export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",
  specs: [path.join(import.meta.dirname, "specs/**/*.e2e.ts")],
  maxInstances: Number(setting(process.env.WDIO_MAX_INSTANCES) ?? 2),
  capabilities: versions.map(([appVersion, installerVersion]) => ({
    browserName: "obsidian",
    browserVersion: appVersion,
    "wdio:obsidianOptions": {
      installerVersion,
      plugins: [pluginDir],
      vault: path.join(import.meta.dirname, "vaults", "pages"),
    },
    "goog:chromeOptions": { args: ["--disable-dev-shm-usage"] },
  })),
  services: ["obsidian"],
  reporters: ["obsidian"],
  cacheDir,
  outputDir: path.join(outputDir, "logs"),
  injectGlobals: false,
  mochaOpts: { ui: "bdd", timeout: 60_000 },
  logLevel: "warn",
};
