// The plugin's lifecycle as a user goes through it (#98): installed from the
// zip that the release's packaging writes, its settings saved, turned off and
// on again, updated by replacing its files with a newer version's, and kept
// across a restart of Obsidian. This capability starts Obsidian without the
// plugin, so that the test installs it as the README's steps do.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { browser, expect } from "@wdio/globals";
import type { Color } from "../support/pixels.ts";
import {
  activeFile,
  framePixels,
  frameSandbox,
  openInActiveTab,
  PLUGIN_ID,
  VIEW_TYPE,
  vaultFolder,
  waitForPage,
} from "../support/viewer.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const candidateVersion = (
  JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as { version: string }
).version;
// The same build under an earlier version, so that installing the candidate
// over it changes the version that Obsidian lists, as an update does.
const previousVersion = "0.0.0-lifecycle";

const PAGE = "Saved/Example article.html";
const GREEN: Color = [46, 125, 50];
const IMAGE_PIXELS = 64 * 64;
const SETTINGS = {
  themeOn: false,
  scriptsOn: false,
  copyLocalFiles: true,
  wrapSource: false,
  extensions: ["html", "htm", "xht"],
};
const EXTENSIONS = SETTINGS.extensions;

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
}

/**
 * Packages the built plugin with the release's own command, under `version`,
 * and unzips its zip with Info-ZIP's unzip, as a user does. Returns the
 * folder that the zip holds, which a user puts in the vault's plugins folder.
 */
function packaged(work: string, version: string): string {
  let build = root;
  if (version !== candidateVersion) {
    // The command packages the build beside the manifest it reads, so the same
    // build gets a manifest with the other version.
    build = path.join(work, `build-${version}`);
    fs.mkdirSync(build);
    for (const file of ["main.js", "styles.css"])
      fs.copyFileSync(path.join(root, file), path.join(build, file));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as {
      version: string;
    };
    fs.writeFileSync(
      path.join(build, "manifest.json"),
      `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
    );
  }
  // A folder that does not exist yet, which the command creates.
  const release = path.join(work, `release-${version}`);
  run(
    process.execPath,
    [path.join(root, "scripts", "release.ts"), "package", version, "--out", release],
    build,
  );
  const unzipped = path.join(work, `unzipped-${version}`);
  run("unzip", ["-q", path.join(release, `${PLUGIN_ID}-${version}.zip`), "-d", unzipped], work);
  const folder = path.join(unzipped, PLUGIN_ID);
  expect(fs.readdirSync(folder).sort()).toEqual(["main.js", "manifest.json", "styles.css"]);
  return folder;
}

/** The plugin's folder in the test's vault. */
async function pluginFolder(): Promise<string> {
  const configDir = await browser.executeObsidian(({ app }) => app.vault.configDir);
  return path.join(await vaultFolder(), configDir, "plugins", PLUGIN_ID);
}

/** Puts the files of an unzipped release in the vault's plugins folder, replacing any there. */
async function install(folder: string): Promise<void> {
  const target = await pluginFolder();
  fs.mkdirSync(target, { recursive: true });
  for (const file of fs.readdirSync(folder))
    fs.copyFileSync(path.join(folder, file), path.join(target, file));
}

interface PluginState {
  /** The version that Obsidian lists among the installed plugins. */
  listed: string | null;
  enabled: boolean;
  /** The version of the plugin that is running, if one is. */
  running: string | null;
  settings: unknown;
}

/** What Obsidian knows of the plugin, after rereading the installed plugins' manifests. */
async function pluginState(): Promise<PluginState> {
  return browser.executeObsidian(async ({ app }, id) => {
    const plugins = (
      app as unknown as {
        plugins: {
          loadManifests(): Promise<void>;
          manifests: Record<string, { version: string } | undefined>;
          enabledPlugins: Set<string>;
          plugins: Record<string, { manifest: { version: string }; settings?: unknown }>;
        };
      }
    ).plugins;
    await plugins.loadManifests();
    const running = plugins.plugins[id] as
      { manifest: { version: string }; settings?: unknown } | undefined;
    return {
      listed: plugins.manifests[id]?.version ?? null,
      enabled: plugins.enabledPlugins.has(id),
      running: running?.manifest.version ?? null,
      settings: running?.settings ?? null,
    };
  }, PLUGIN_ID);
}

/** Turns the plugin on or off as Community plugins does, saving the choice. */
async function setEnabled(enabled: boolean): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, id, enabled) => {
      const plugins = (
        app as unknown as {
          plugins: {
            enablePluginAndSave(id: string): Promise<boolean>;
            disablePluginAndSave(id: string): Promise<void>;
          };
        }
      ).plugins;
      if (enabled) await plugins.enablePluginAndSave(id);
      else await plugins.disablePluginAndSave(id);
    },
    PLUGIN_ID,
    enabled,
  );
}

/** The view type that Obsidian's view registry gives each extension, or null. */
async function owners(extensions: string[]): Promise<Record<string, string | null>> {
  return browser.executeObsidian(({ app }, extensions) => {
    const registry = (
      app as unknown as { viewRegistry: { getTypeByExtension(e: string): string | undefined } }
    ).viewRegistry;
    return Object.fromEntries(
      extensions.map((extension) => [extension, registry.getTypeByExtension(extension) ?? null]),
    );
  }, extensions);
}

/** The settings in the plugin's data.json, once `saved` holds for them, or after 10 s. */
async function savedSettings(saved: (settings: unknown) => boolean): Promise<unknown> {
  const file = path.join(await pluginFolder(), "data.json");
  const read = (): unknown => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch {
      return null;
    }
  };
  let settings = read();
  const deadline = Date.now() + 10_000;
  while (!saved(settings) && Date.now() < deadline) {
    await browser.pause(100);
    settings = read();
  }
  return settings;
}

const sameSettings = (settings: unknown): boolean =>
  JSON.stringify(settings) === JSON.stringify(SETTINGS);

/** Opens the page in the active tab and checks that the viewer shows it, with its image. */
async function showsPage(): Promise<void> {
  await openInActiveTab(PAGE);
  expect(await activeFile()).toEqual({ path: PAGE, type: VIEW_TYPE });
  expect(await frameSandbox()).toBe("allow-same-origin");
  await waitForPage();
  expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
}

/** The page file's bytes and modification time, which the lifecycle must leave as they are. */
async function pageFile(): Promise<{ sha256: string; mtimeMs: number }> {
  const file = path.join(await vaultFolder(), PAGE);
  return {
    sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    mtimeMs: fs.statSync(file).mtimeMs,
  };
}

describe("The plugin's lifecycle in Obsidian (#98)", function () {
  // Each step starts where the previous one left the plugin.
  this.bail(true);

  let work = "";
  let previous = "";
  let candidate = "";
  let page = { sha256: "", mtimeMs: 0 };

  before(async function () {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "html-page-viewer-lifecycle-"));
    previous = packaged(work, previousVersion);
    candidate = packaged(work, candidateVersion);
    page = await pageFile();
  });

  after(function () {
    if (work !== "") fs.rmSync(work, { recursive: true, force: true });
  });

  it("is listed once its zip is unzipped into the plugins folder, and runs once turned on", async function () {
    expect(await pluginState()).toEqual({
      listed: null,
      enabled: false,
      running: null,
      settings: null,
    });
    await install(previous);
    expect((await pluginState()).listed).toBe(previousVersion);

    await setEnabled(true);
    const state = await pluginState();
    expect(state.running).toBe(previousVersion);
    expect(state.enabled).toBe(true);
    expect(await owners(EXTENSIONS)).toEqual({ html: VIEW_TYPE, htm: VIEW_TYPE, xht: null });
    await showsPage();
  });

  it("saves settings that differ from the defaults", async function () {
    await browser.executeObsidian(
      async ({ app }, id, settings) => {
        const plugin = (
          app as unknown as {
            plugins: { plugins: Record<string, { updateSettings(s: unknown): Promise<void> }> };
          }
        ).plugins.plugins[id];
        await plugin.updateSettings(settings);
      },
      PLUGIN_ID,
      SETTINGS,
    );
    expect(await savedSettings(sameSettings)).toEqual(SETTINGS);
    expect(await owners(EXTENSIONS)).toEqual({ html: VIEW_TYPE, htm: VIEW_TYPE, xht: VIEW_TYPE });
  });

  it("gives up its extensions when turned off, and keeps its saved settings", async function () {
    await setEnabled(false);
    const state = await pluginState();
    expect(state.enabled).toBe(false);
    expect(state.running).toBeNull();
    const after = await owners(EXTENSIONS);
    for (const extension of EXTENSIONS) expect(after[extension]).not.toBe(VIEW_TYPE);
    expect(await savedSettings(sameSettings)).toEqual(SETTINGS);
  });

  it("comes back with the same version, its settings, extensions, and view when turned on", async function () {
    await setEnabled(true);
    const state = await pluginState();
    expect(state.running).toBe(previousVersion);
    expect(state.settings).toEqual(SETTINGS);
    expect(await owners(EXTENSIONS)).toEqual({ html: VIEW_TYPE, htm: VIEW_TYPE, xht: VIEW_TYPE });
    // The saved extension opens in the viewer, and a new tab starts with the theme off.
    await openInActiveTab("Saved/Other extension.xht");
    expect(await activeFile()).toEqual({ path: "Saved/Other extension.xht", type: VIEW_TYPE });
    expect(
      await browser.$(".workspace-leaf.mod-active .html-page-viewer__theme-toggle").getText(),
    ).toBe("Theme OFF");
    await showsPage();
  });

  it("runs the newer version once its files replace the installed ones and it is turned off and on", async function () {
    await install(candidate);
    let state = await pluginState();
    expect(state.listed).toBe(candidateVersion);
    expect(state.running).toBe(previousVersion);

    await setEnabled(false);
    await setEnabled(true);
    state = await pluginState();
    expect(state.running).toBe(candidateVersion);
    expect(state.settings).toEqual(SETTINGS);
    expect(await owners(EXTENSIONS)).toEqual({ html: VIEW_TYPE, htm: VIEW_TYPE, xht: VIEW_TYPE });
    await showsPage();
  });

  it("keeps the newer version, its settings, and the open page across a restart", async function () {
    // A mark in the window, which only the window that ran before the restart has.
    await browser.executeObsidian(async ({ app }) => {
      (window as unknown as { e2eBeforeRestart?: boolean }).e2eBeforeRestart = true;
      const workspace = app.workspace as unknown as { saveLayout?(): Promise<void> };
      await workspace.saveLayout?.();
    });
    await browser.reloadObsidian();
    expect(
      await browser.execute(
        () => (window as unknown as { e2eBeforeRestart?: boolean }).e2eBeforeRestart ?? false,
      ),
    ).toBe(false);
    const state = await pluginState();
    expect(state).toEqual({
      listed: candidateVersion,
      enabled: true,
      running: candidateVersion,
      settings: SETTINGS,
    });
    expect(await owners(EXTENSIONS)).toEqual({ html: VIEW_TYPE, htm: VIEW_TYPE, xht: VIEW_TYPE });
    // Obsidian restores the tab that showed the page, in the viewer.
    expect(await activeFile()).toEqual({ path: PAGE, type: VIEW_TYPE });
    await waitForPage();
    expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
    expect(await savedSettings(sameSettings)).toEqual(SETTINGS);
  });

  it("leaves the page file as it was throughout", async function () {
    expect(await pageFile()).toEqual(page);
  });
});
