// The plugin's settings and its tab in Obsidian's settings. The Theme and
// Scripts settings choose how those buttons start; the toolbar still changes
// them for one tab or one page.

import { type App, type Plugin, PluginSettingTab, Setting } from "obsidian";

export interface ViewerSettings {
  /** Whether a new tab shows pages without styles of their own in Obsidian's theme. */
  readonly themeOn: boolean;
  /** Whether a page runs its scripts when it opens. */
  readonly scriptsOn: boolean;
  /** Whether the source view wraps lines longer than the view. */
  readonly wrapSource: boolean;
}

/** The defaults, for vaults that have saved no settings. */
export const DEFAULT_SETTINGS: ViewerSettings = {
  themeOn: true,
  scriptsOn: false,
  wrapSource: true,
};

/**
 * The settings in data that Obsidian saved for the plugin. A value that is
 * missing or of the wrong type takes its default, so that a damaged or older
 * file never changes how pages open.
 */
export function readSettings(data: unknown): ViewerSettings {
  const saved = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const flag = (key: keyof ViewerSettings): boolean => {
    const value = saved[key];
    return typeof value === "boolean" ? value : DEFAULT_SETTINGS[key];
  };
  return { themeOn: flag("themeOn"), scriptsOn: flag("scriptsOn"), wrapSource: flag("wrapSource") };
}

/** The plugin, as the settings tab uses it. */
export interface SettingsHost extends Plugin {
  readonly settings: ViewerSettings;
  updateSettings(change: Partial<ViewerSettings>): Promise<void>;
}

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
        "Run a page's scripts as soon as it opens. A page with scripts on cannot reach Obsidian, but it cannot show the vault's images and other files either, and its links work as in a browser. The Scripts button changes it for the open page.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.host.settings.scriptsOn)
          .onChange((value) => this.host.updateSettings({ scriptsOn: value })),
      );

    new Setting(containerEl)
      .setName("Wrap long lines in the source view")
      .setDesc("Wrap lines that are longer than the view. Turn it off to scroll sideways instead.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.host.settings.wrapSource)
          .onChange((value) => this.host.updateSettings({ wrapSource: value })),
      );
  }
}
