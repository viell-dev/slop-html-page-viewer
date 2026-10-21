// The file extensions that open in the viewer (#41). The settings list them;
// the viewer shows every listed extension's files as HTML and does nothing
// more for them.

/** The extensions that open in the viewer unless the settings list others. */
export const DEFAULT_EXTENSIONS: readonly string[] = ["html", "htm"];

/**
 * The extensions in a setting's text, or in a saved list: in lower case,
 * without leading dots, each once, in their order. Entries that cannot be an
 * extension, such as one with a dot inside, are left out. Nothing left means
 * the defaults.
 */
export function normalizeExtensions(input: string | readonly unknown[]): string[] {
  const parts =
    typeof input === "string"
      ? input.split(/[\s,;]+/)
      : input.filter((part) => typeof part === "string");
  const extensions = new Set<string>();
  for (const part of parts) {
    const extension = (part as string).trim().replace(/^\.+/, "").toLowerCase();
    if (/^[\p{L}\p{N}_-]+$/u.test(extension)) extensions.add(extension);
  }
  return extensions.size > 0 ? [...extensions] : [...DEFAULT_EXTENSIONS];
}

/**
 * The part of Obsidian's view registry that maps extensions to views. Obsidian
 * 1.5 and later have it, though its API types do not declare it. Registering an
 * extension that a view already has throws, and the registry neither changes
 * case nor removes dots.
 */
export interface ExtensionRegistry {
  registerExtensions(extensions: string[], viewType: string): void;
  unregisterExtensions(extensions: string[]): void;
  getTypeByExtension(extension: string): string | undefined;
  isExtensionRegistered(extension: string): boolean;
}

/** Obsidian's view registry, if it has every part this plugin uses. */
export function extensionRegistry(app: unknown): ExtensionRegistry | null {
  const registry = (app as { viewRegistry?: Partial<ExtensionRegistry> }).viewRegistry;
  const parts = [
    "registerExtensions",
    "unregisterExtensions",
    "getTypeByExtension",
    "isExtensionRegistered",
  ] as const;
  return registry && parts.every((name) => typeof registry[name] === "function")
    ? (registry as ExtensionRegistry)
    : null;
}

/**
 * The extensions that the viewer holds in the registry. It registers and gives
 * up each one on its own, and gives up only those still registered to it, so
 * that it never takes an extension from another view or gives up one that
 * another view took since.
 */
export class ExtensionRegistration {
  /** The extensions registered to the viewer, in the settings' order. */
  held: string[] = [];
  /** The extensions the settings list but another view has. */
  refused: string[] = [];

  constructor(
    private readonly registry: ExtensionRegistry,
    private readonly viewType: string,
  ) {}

  /** Holds exactly the `wanted` extensions that no other view has. */
  apply(wanted: readonly string[]): void {
    this.release(this.held.filter((extension) => !wanted.includes(extension)));
    const held = new Set(this.held.filter((extension) => wanted.includes(extension)));
    this.refused = [];
    for (const extension of wanted) {
      if (held.has(extension)) continue;
      if (this.registry.getTypeByExtension(extension) === this.viewType) {
        held.add(extension);
      } else if (this.registry.isExtensionRegistered(extension)) {
        this.refused.push(extension);
      } else {
        this.registry.registerExtensions([extension], this.viewType);
        held.add(extension);
      }
    }
    this.held = wanted.filter((extension) => held.has(extension));
  }

  /** Gives up every extension the viewer holds, as the plugin unloads. */
  releaseAll(): void {
    this.release(this.held);
    this.held = [];
  }

  private release(extensions: readonly string[]): void {
    const own = extensions.filter(
      (extension) => this.registry.getTypeByExtension(extension) === this.viewType,
    );
    if (own.length > 0) this.registry.unregisterExtensions(own);
  }
}
