// The plugin's entry point: what it registers with Obsidian, its settings, and
// the extensions that it opens. The view itself is in view.ts.

import { type Events, Plugin, type TFile, type WorkspaceLeaf } from "obsidian";
import { ExtensionRegistration, extensionRegistry } from "./extensions";
import {
  DEFAULT_SETTINGS,
  readSettings,
  type SettingsHost,
  type ViewerSettings,
  ViewerSettingTab,
} from "./settings";
import {
  HtmlPageViewerView,
  SETTINGS_CHANGE,
  type TabChoices,
  VIEW_TYPE_HTML_PAGE_VIEWER,
  type ViewerHost,
} from "./view";

export default class HtmlPageViewerPlugin extends Plugin implements SettingsHost, ViewerHost {
  settings: ViewerSettings = DEFAULT_SETTINGS;

  /**
   * Each tab's choices, kept while the tab shows other views, such as a note:
   * Obsidian then replaces this plugin's view, but keeps the tab.
   */
  readonly tabChoices = new WeakMap<WorkspaceLeaf, TabChoices>();

  /** The extensions the viewer holds in Obsidian's view registry, which follow the settings. */
  private registration: ExtensionRegistration | null = null;
  /** Without the registry: the extensions registered once, and those another view had. */
  private fixedExtensions = { held: [] as string[], refused: [] as string[] };

  async onload(): Promise<void> {
    this.settings = readSettings(await this.loadData());
    this.registerView(VIEW_TYPE_HTML_PAGE_VIEWER, (leaf) => new HtmlPageViewerView(leaf, this));
    this.registerFileExtensions();
    this.addSettingTab(new ViewerSettingTab(this.app, this));

    this.addCommand({
      id: "open-current-html-in-viewer",
      name: "Open current HTML file in viewer",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.opens(file)) return false;

        if (!checking) {
          void this.openHtmlFile(file);
        }
        return true;
      },
    });

    // No default hotkey: in the viewer, Mod+F opens its find bar (#13).
    this.addCommand({
      id: "find-in-page",
      name: "Find in page",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(HtmlPageViewerView);
        if (!view) return false;
        if (!checking) view.openFind();
        return true;
      },
    });
  }

  async openHtmlFile(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_HTML_PAGE_VIEWER,
      state: { file: file.path },
      active: true,
    });
  }

  /**
   * Changes and saves settings. Open tabs keep their Theme and Scripts state,
   * which the settings choose only for what opens next; wrapping applies at once.
   */
  async updateSettings(change: Partial<ViewerSettings>): Promise<void> {
    this.settings = { ...this.settings, ...change };
    if (change.extensions) this.registration?.apply(this.settings.extensions);
    (this.app.workspace as Events).trigger(SETTINGS_CHANGE);
    await this.saveData(this.settings);
  }

  /**
   * Registers the viewer for the listed extensions. Through Obsidian's view
   * registry, it follows changes of the setting at once; without it, Obsidian's
   * API registers them once, and a change applies when the plugin loads again.
   */
  private registerFileExtensions(): void {
    const registry = extensionRegistry(this.app);
    if (registry) {
      this.registration = new ExtensionRegistration(registry, VIEW_TYPE_HTML_PAGE_VIEWER);
      this.registration.apply(this.settings.extensions);
      this.register(() => this.registration?.releaseAll());
      return;
    }
    for (const extension of this.settings.extensions) {
      try {
        this.registerExtensions([extension], VIEW_TYPE_HTML_PAGE_VIEWER);
        this.fixedExtensions.held.push(extension);
      } catch {
        // Another view opens it.
        this.fixedExtensions.refused.push(extension);
      }
    }
  }

  get extensionsApplyAtOnce(): boolean {
    return this.registration !== null;
  }

  get refusedExtensions(): readonly string[] {
    return this.registration?.refused ?? this.fixedExtensions.refused;
  }

  /** Whether the viewer opens `file`, by its extension. */
  opens(file: TFile): boolean {
    const held = this.registration?.held ?? this.fixedExtensions.held;
    return held.includes(file.extension.toLowerCase());
  }
}
