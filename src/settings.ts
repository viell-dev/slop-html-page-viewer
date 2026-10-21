// The plugin's settings and its tab in Obsidian's settings. The Theme and
// Scripts settings choose how those buttons start; the toolbar still changes
// them for one tab or one page.

import { type App, type Plugin, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_EXTENSIONS, normalizeExtensions } from "./extensions";

export interface ViewerSettings {
  /** Whether a new tab shows pages without styles of their own in Obsidian's theme. */
  readonly themeOn: boolean;
  /** Whether a page runs its scripts when it opens. */
  readonly scriptsOn: boolean;
  /** Whether a page with scripts on gets its local files copied into it (#11). */
  readonly copyLocalFiles: boolean;
  /** Whether the source view wraps lines longer than the view. */
  readonly wrapSource: boolean;
  /** The file extensions that open in the viewer, normalized. */
  readonly extensions: readonly string[];
}

/** The defaults, for vaults that have saved no settings. */
export const DEFAULT_SETTINGS: ViewerSettings = {
  themeOn: true,
  scriptsOn: false,
  copyLocalFiles: false,
  wrapSource: true,
  extensions: DEFAULT_EXTENSIONS,
};

/**
 * The settings in data that Obsidian saved for the plugin. A value that is
 * missing or of the wrong type takes its default, so that a damaged or older
 * file never changes how pages open.
 */
export function readSettings(data: unknown): ViewerSettings {
  const saved = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const flag = (key: "themeOn" | "scriptsOn" | "copyLocalFiles" | "wrapSource"): boolean => {
    const value = saved[key];
    return typeof value === "boolean" ? value : DEFAULT_SETTINGS[key];
  };
  return {
    themeOn: flag("themeOn"),
    scriptsOn: flag("scriptsOn"),
    copyLocalFiles: flag("copyLocalFiles"),
    wrapSource: flag("wrapSource"),
    extensions: Array.isArray(saved.extensions)
      ? normalizeExtensions(saved.extensions)
      : DEFAULT_EXTENSIONS,
  };
}

/** The plugin, as the settings tab uses it. */
export interface SettingsHost extends Plugin {
  readonly settings: ViewerSettings;
  /** The listed extensions that another view opens, so the viewer does not. */
  readonly refusedExtensions: readonly string[];
  /** Whether a change of extensions applies at once, or only when the plugin loads again. */
  readonly extensionsApplyAtOnce: boolean;
  updateSettings(change: Partial<ViewerSettings>): Promise<void>;
}

// eslint-disable-next-line obsidianmd/settings-tab/prefer-setting-definitions -- Obsidian 1.5 lacks it; see #64
export class ViewerSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly host: SettingsHost,
  ) {
    super(app, host);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Theme in new tabs")
      .setDesc(
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- names the toolbar button
        "Show pages without styles of their own in Obsidian's theme when a tab opens. The Theme button changes it for one tab.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.host.settings.themeOn)
          .onChange((value) => this.host.updateSettings({ themeOn: value })),
      );

    new Setting(containerEl)
      .setName("Scripts when a page opens")
      .setDesc(
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- names the toolbar button
        "Run a page's scripts as soon as it opens. A page with scripts on cannot reach Obsidian. It shows the vault's images and other files only if the next setting copies them into it, and its links work as in a browser. The Scripts button changes it for the open page.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.host.settings.scriptsOn)
          .onChange((value) => this.host.updateSettings({ scriptsOn: value })),
      );

    new Setting(containerEl)
      .setName("Local files with scripts on")
      .setDesc(
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- MB is a unit
        "Copy the images, media, text tracks, fonts, and scripts that a page names from the vault into it while its scripts are on, so that they show and run. The page's scripts can read the files copied into it, and a page with many takes longer to open. A page gets up to 32 MB of them, scripts and fonts first, and none over 8 MB.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.host.settings.copyLocalFiles)
          .onChange((value) => this.host.updateSettings({ copyLocalFiles: value })),
      );

    new Setting(containerEl)
      .setName("Wrap long lines in the source view")
      .setDesc("Wrap lines that are longer than the view. Turn it off to scroll sideways instead.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.host.settings.wrapSource)
          .onChange((value) => this.host.updateSettings({ wrapSource: value })),
      );

    const refused = this.host.refusedExtensions;
    new Setting(containerEl)
      .setName("File extensions")
      .setDesc(
        [
          "The extensions of the files that open in the viewer, separated by commas. The viewer shows them all as HTML. Leave it empty for html and htm.",
          refused.length > 0
            ? `Another view opens ${refused.map((extension) => `.${extension}`).join(", ")}, so the viewer does not.`
            : "",
          this.host.extensionsApplyAtOnce
            ? ""
            : "A change applies when Obsidian loads the plugin again.",
        ]
          .filter(Boolean)
          .join(" "),
      )
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_EXTENSIONS.join(", "))
          .setValue(this.host.settings.extensions.join(", "));
        // A change applies when the field is left, not at every key.
        text.inputEl.addEventListener("change", () => {
          void this.host
            .updateSettings({ extensions: normalizeExtensions(text.getValue()) })
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the class
            .then(() => this.display());
        });
      });
  }
}
