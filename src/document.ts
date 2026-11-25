// Prepares the copy of a page that the rendered view shows, so that the
// page's local files load as they would next to it on disk. The file itself is
// never changed.
//
// The view renders the copy through `srcdoc`, which inherits Obsidian's
// Content Security Policy. That policy only allows inline styles, so each
// stylesheet the page links from the vault is copied into a <style> element,
// with its own references made absolute. A <base> at the page's folder lets
// every other reference resolve as it would from the file, and a policy of the
// copy's own keeps Obsidian's resource URLs inside the vault.
//
// With scripts on, the page has an opaque origin, which Obsidian serves no
// vault files to. When the settings ask for it, the page's local images,
// media, fonts, and scripts are then copied into it as data: URLs (#11).

import {
  cssDeclarationsEnd,
  cssEnd,
  cssImports,
  cssReferences,
  cssTokens,
  importStop,
  type CssImport,
  type CssToken,
  type ImportConditions,
  type ImportStop,
} from "./css";
import { READING_STYLE_ID } from "./reading";
import { noscriptContents } from "./source";

/** What the view knows about the page and its vault. */
export interface PageContext {
  /** The page's resource URL, without a query. */
  readonly pageUrl: string;
  /** The vault root's resource URL, ending in a slash. */
  readonly vaultUrl: string;
  /**
   * Reads a vault file's text by its vault path, or returns null if there is
   * none. A file whose read fails is left out, as one that is missing. The
   * text has no byte order mark, as Obsidian's reads give it and as browsers
   * decode a stylesheet: CSS would read one as part of a name, which starts a
   * rule, so a stylesheet's imports after it would not count.
   */
  read(path: string): Promise<string | null>;
  /** Whether a file or folder exists at a vault path. */
  exists?(path: string): boolean;
  /**
   * The vault path of the file that Obsidian's link resolution finds for a
   * link text in this page, or null. With `exists`, it lets references that
   * do not resolve as paths name a file as Obsidian's own links do.
   */
  locate?(linktext: string): string | null;
  /**
   * Whether the host's Chromium applies an import's support conditions. By
   * default, whether its `CSSImportRule` has `supportsText`, which Chromium
   * added with them (`hostImportSupports`).
   */
  readonly importSupports?: boolean;
}

/**
 * Whether this window's Chromium applies the support conditions of an
 * import, `supports()`. Chromium 150 (Obsidian 1.15.1) does; Chromium 114
 * (Obsidian 1.5.3) reads `supports()` as part of the media query list, which
 * then never matches, so that the import never applies, whatever the
 * conditions (#151).
 */
function hostImportSupports(): boolean {
  const rule = (window as { CSSImportRule?: { prototype: object } }).CSSImportRule;
  return rule !== undefined && "supportsText" in rule.prototype;
}

/** The deepest chain of stylesheet imports that is followed. */
const MAX_IMPORT_DEPTH = 8;

/**
 * A page's limits on its vault stylesheets (`StylesheetBudget`): how many
 * links and imports of them preparation follows, and how much of their text,
 * in UTF-16 code units, the copy takes in: a stylesheet's file text when it
 * is followed, with what preparing adds to it (`StylesheetBudget.add`), and
 * its prepared text, as copied, for each repeat of the page's own link or
 * import of it that gets that text again. The depth limit bounds an
 * import chain, not how many imports each stylesheet has, so without these
 * the work and the copy would grow with that number raised to the depth
 * (#154). Web pages load a median of 7 stylesheets with 68 KB of CSS, and 22
 * with 256 KB at the 90th percentile (HTTP Archive's Web Almanac, 2022).
 * Preparing a copy keeps Obsidian from responding until it ends: there, 16
 * million characters of stylesheets took 5 to 12 s, and 1,000 small ones with
 * ten imports each 0.1 to 0.85 s, but 10,000 of them 3 to 8 s.
 */
export const STYLESHEET_COUNT_LIMIT = 1_000;
export const STYLESHEET_TEXT_LIMIT = 16_000_000;

/**
 * How much text, in UTF-16 code units, a page's preparation scans and
 * rewrites for stylesheets whose own text, rewritten, then does not fit in
 * the text limit, a page's own `<style>` whose imports would not fit among
 * them, measured as the length that each one's text had reached when
 * preparing it stopped (`StylesheetBudget.refuse`). Each stylesheet's
 * rewriting stops once it passes what remains of this limit and the text
 * limit (`StylesheetBudget.rewriteRoom`), so that it reaches at most that and
 * one rewrite more. The text that closes a stylesheet file is counted in one
 * step, once the file has been scanned, which `take` allows when the file's
 * own text fits. So the last such stylesheet can pass this limit by as much
 * as its own length: a file of 16 million unclosed `{`, closed by as many
 * `}`, spends it alone. Twice the text limit leaves the page's other
 * stylesheets as much again after one that reaches the whole text limit, as
 * one too large to read leaves them the whole limit. Once it is spent, no
 * further stylesheet is copied, also one that would fit. In the unit tests'
 * jsdom stand-in on Windows 11, one stylesheet that reached the limit took
 * 0.3 s with 1,362 URLs and 2.3 to 2.6 s with 190,477, each looked up as a
 * vault path, against 5 to 12 s in Obsidian for 16 million characters of
 * copied stylesheet text (#154, #177).
 */
export const DISCARD_LIMIT = 2 * STYLESHEET_TEXT_LIMIT;

/**
 * Whether a vault file is a stylesheet, by its extension; the copy includes
 * no other file that a page names as one. With scripts on, the page's scripts
 * can read the copy's stylesheets, so a page that named a note as one would
 * let them read the note.
 */
function isStylesheetFile(path: string): boolean {
  return /\.css$/i.test(path);
}

/**
 * A stylesheet's text, or null if it cannot be read: a page leaves out a
 * stylesheet that it cannot load, so one that cannot be read is left out too,
 * rather than failing the whole page.
 */
async function readStylesheet(context: PageContext, path: string): Promise<string | null> {
  try {
    return await context.read(path);
  } catch {
    return null;
  }
}

/** Text of a prepared stylesheet, and which later imports it keeps from counting. */
interface TextPart {
  readonly kind: "text";
  readonly text: string;
  readonly stop: ImportStop;
}

/**
 * An import that the copy keeps as an import, for the browser to load or
 * refuse: of a stylesheet from the web; of a vault file that is missing,
 * cannot be read, is not a `.css` file, imports itself, or lies past the
 * depth or page limits; of one with a `}` outside any block, which would end
 * a block form early; and one with a scope, or with support conditions where
 * the host never applies them (#151).
 */
interface KeptImport {
  readonly kind: "import";
  /** The rule as the copy has it. */
  readonly text: string;
  /** Its stylesheet's URL, or null for a reference that does not resolve. */
  readonly url: string | null;
  /** Its conditions as written, or null for ones without a block form (`CssImport`). */
  readonly conditions: ImportConditions | null;
}

type SheetPart = TextPart | KeptImport;

/**
 * A stylesheet prepared for the copy, in order: text, and the imports that
 * stay imports, each of which counts only where nothing before it in its
 * stylesheet keeps it from counting (`stylesheetTexts`). Also the length of
 * its text, and whether it has a `}` outside any block, which a block around
 * it, such as `@media`, would end early.
 */
interface PreparedSheet {
  readonly parts: readonly SheetPart[];
  readonly length: number;
  readonly strayCloser: boolean;
}

const STOPS: readonly ImportStop[] = ["blank", "none", "after-import", "all"];

/** Adds a part, joining text to the text before it. Parts are shared, so never changed. */
function addPart(parts: SheetPart[], part: SheetPart): void {
  if (part.text === "") return;
  const last = parts.at(-1);
  if (part.kind === "text" && last?.kind === "text") {
    const stop = STOPS[Math.max(STOPS.indexOf(last.stop), STOPS.indexOf(part.stop))];
    parts[parts.length - 1] = { kind: "text", text: last.text + part.text, stop };
  } else parts.push(part);
}

/** An import rule of `url` with these conditions. */
function importText(url: string, conditions: ImportConditions): string {
  const { layer, supports, media } = conditions;
  const layerText = layer === null ? "" : layer === "" ? " layer" : ` layer(${layer})`;
  const supportsText = supports === null ? "" : ` supports(${supports})`;
  return `@import url(${cssString(url)})${layerText}${supportsText}${media === null ? "" : ` ${media}`};`;
}

/**
 * A kept import in a stylesheet that an import with `outer` conditions puts
 * in the copy, with those conditions added to its own, so that it can still
 * count, or null when one import cannot have both. Layers nest by name, and
 * support conditions both hold, but an anonymous layer has no name for
 * another rule to add to, and two media query lists have no general form
 * for both: such an import goes in the blocks as text, which never counts.
 */
function composedImport(part: KeptImport, outer: ImportConditions): KeptImport | null {
  const inner = part.conditions;
  if (part.url === null || inner === null) return null;
  if (outer.layer === "" || (outer.layer !== null && inner.layer === "")) return null;
  if (outer.media !== null && inner.media !== null) return null;
  const conditions: ImportConditions = {
    layer:
      outer.layer === null || inner.layer === null
        ? (outer.layer ?? inner.layer)
        : `${outer.layer}.${inner.layer}`,
    supports:
      outer.supports === null || inner.supports === null
        ? (outer.supports ?? inner.supports)
        : `(${outer.supports}) and (${inner.supports})`,
    media: outer.media ?? inner.media,
  };
  return { kind: "import", text: importText(part.url, conditions), url: part.url, conditions };
}

/**
 * Text in the block forms of an import's conditions: `@media`, then
 * `@supports`, then `@layer`. The conditions go outside the layer, as CSS
 * Cascade 5 adds an import's layer to the layer order only where its
 * conditions hold: in Obsidian 1.5.3 and 1.15.1, a layer inside `@media`
 * that does not match comes in the order where it is next declared, as an
 * import's layer does, and a layer around `@media` comes where it is (#151).
 */
function blockText(text: string, conditions: ImportConditions): string {
  const { layer, supports, media } = conditions;
  const blocks = [
    media === null ? null : `@media ${media}`,
    supports === null ? null : `@supports (${supports})`,
    layer === null ? null : layer === "" ? "@layer" : `@layer ${layer}`,
  ].filter((block) => block !== null);
  return blocks.map((block) => `${block} {\n`).join("") + text + "\n}".repeat(blocks.length);
}

/**
 * The declaration of an import's named layer, in the blocks of its other
 * conditions, for a stylesheet in which nothing else declares it, such as an
 * empty one: an import declares its layer where it is, whatever its
 * stylesheet holds (#151). Without other conditions, it is an `@layer`
 * statement, which imports may follow before the first import.
 */
function layerDeclaration(layer: string, { supports, media }: ImportConditions): TextPart {
  const statement = `@layer ${layer};`;
  if (supports === null && media === null)
    return { kind: "text", text: statement, stop: "after-import" };
  return {
    kind: "text",
    text: blockText(statement, { layer: null, supports, media }),
    stop: "all",
  };
}

/**
 * A stylesheet's parts as an import with these conditions puts them in the
 * importing stylesheet, with the length of what that adds to the copy, or
 * null when that would be more than `room`. Its text goes in the conditions'
 * block forms, but not text of only what CSS discards between rules, which
 * reads the same outside them. Its kept imports take the conditions too
 * (`composedImport`), or else go in the blocks as text. Text is joined first,
 * so that an anonymous layer holds the whole stylesheet, as one block makes
 * one layer. With `merged`, every part is text in one block, which adds the
 * least: the kept imports are then where CSS ignores them, as in a block
 * that the stylesheet's own text has. The work stops once what it adds
 * passes `room`, so that a long condition, put around many parts, never
 * builds a copy past the limit. A named layer that no part declares under
 * the import's conditions gets an `@layer` statement where the import was
 * (`layerDeclaration`).
 */
function placedParts(
  parts: readonly SheetPart[],
  conditions: ImportConditions,
  room: number,
  merged: boolean,
): { parts: SheetPart[]; added: number } | null {
  const joined: SheetPart[] = [];
  let added = 0;
  // Whether a part declares the import's layer under the import's own
  // conditions: text in their blocks does, and so does a kept import that
  // takes them and has no media or support conditions of its own, which
  // would decide whether it declares anything (#151).
  let declared = false;
  for (const part of parts) {
    if (part.kind === "text") {
      addPart(joined, part);
      continue;
    }
    const kept = merged ? null : composedImport(part, conditions);
    if (kept === null) {
      addPart(joined, { kind: "text", text: part.text, stop: "all" });
      continue;
    }
    // Written anew, a kept import can be shorter than as the stylesheet has
    // it, without its spaces and comments. What that leaves out is never
    // given back: the stylesheet's own text took it already, and giving it
    // back would let the same file in again (#154).
    added += Math.max(0, kept.text.length - part.text.length);
    if (added > room) return null;
    declared ||= part.conditions?.media === null && part.conditions.supports === null;
    addPart(joined, kept);
  }
  const wrapper = blockText("", conditions).length;
  const placed: SheetPart[] = [];
  for (const part of joined) {
    if (part.kind === "import" || part.stop === "blank") {
      placed.push(part);
      continue;
    }
    added += wrapper;
    if (added > room) return null;
    placed.push({ kind: "text", text: blockText(part.text, conditions), stop: "all" });
    declared = true;
  }
  if (!declared && conditions.layer !== null && conditions.layer !== "") {
    const declaration = layerDeclaration(conditions.layer, conditions);
    added += declaration.text.length;
    if (added > room) return null;
    placed.unshift(declaration);
  }
  return { parts: placed, added };
}

/**
 * The origin of the only stylesheets from elsewhere that a page loads in
 * Obsidian. Obsidian's policy is `style-src 'unsafe-inline' 'self'
 * https://fonts.googleapis.com` in 1.5.3 and 1.15.1, and the copy's own
 * policy leaves out Obsidian's `'self'` (`pagePolicy`).
 */
const LOADED_STYLESHEETS_ORIGIN = "https://fonts.googleapis.com";

/**
 * Whether where a kept import stands in the copy changes how the page shows:
 * it can load (`LOADED_STYLESHEETS_ORIGIN`), it declares a cascade layer,
 * which an import does where it counts, also when it does not load, or it has
 * conditions that the viewer does not read. Any other import does nothing,
 * whether it counts or not.
 */
function placeMatters(part: KeptImport): boolean {
  if (part.conditions === null || part.conditions.layer !== null) return true;
  if (part.url === null) return false;
  try {
    return new URL(part.url).origin === LOADED_STYLESHEETS_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * The texts of the stylesheets that the copy puts in place of a prepared
 * one, in order. An import that stays an import counts only where nothing
 * before it in its stylesheet keeps it from counting, which an imported
 * stylesheet's rules do when the copy puts them before it (#152). After them,
 * one whose place matters (`placeMatters`) starts a stylesheet of its own,
 * where `split` allows another, and the parts after it follow it there; any
 * other stays where it is. Stylesheets apply in order, so each rule keeps its
 * place in the cascade.
 */
function stylesheetTexts(parts: readonly SheetPart[], split: () => boolean): string[] {
  const texts: string[] = [];
  let text = "";
  let imported = false;
  let stopped = false;
  for (const part of parts) {
    if (part.kind === "import") {
      if (stopped && placeMatters(part) && split()) {
        texts.push(text);
        text = "";
        stopped = false;
      }
      imported = true;
    } else if (part.stop === "all" || (part.stop === "after-import" && imported)) stopped = true;
    text += part.text;
  }
  texts.push(text);
  return texts;
}

/**
 * The most `<style>` elements that the copy adds to a page for the imports
 * that stay imports (`stylesheetTexts`). Past it, such an import stays where
 * it is, where it does not count, as it does when its place does not matter.
 */
export const STYLE_ELEMENT_LIMIT = 1_000;

/**
 * The vault stylesheets that a page's copy takes in, within the page's
 * limits, which the document and the content of its templates share, in the
 * order they are prepared. Each file is read once, however often the page
 * links or imports it.
 */
class StylesheetBudget {
  private taken = 0;
  private text = 0;
  /** How far preparing has rewritten stylesheets whose text did not fit (`refuse`). */
  private discarded = 0;
  /** How often the limits have kept something out: a stylesheet (`take`), or what `refuse` counts. */
  private refused = 0;
  /** How many `<style>` elements the copy has added (`addStyle`). */
  private styles = 0;
  private readonly reads = new Map<string, Promise<string | null>>();
  private readonly kept = new Map<string, PreparedSheet | null>();
  /** The URLs of stylesheets whose own text, rewritten, did not fit (`refuse`). */
  private readonly unfit = new Set<string>();

  constructor(private readonly context: PageContext) {}

  /** How much more text the copy can take in within the text limit. */
  get room(): number {
    return STYLESHEET_TEXT_LIMIT - this.text;
  }

  /**
   * How long a stylesheet's own text may grow, as it is scanned and
   * rewritten, before preparing it stops (`ownRewrites`): within `room`, and
   * within what remains of `DISCARD_LIMIT`, as the work is discarded if the
   * text does not fit.
   */
  get rewriteRoom(): number {
    return Math.min(this.room, DISCARD_LIMIT - this.discarded);
  }

  /**
   * Takes `length` more characters into the text limit, and returns true,
   * when they fit in `room`; otherwise counts a refusal and takes nothing.
   * Every charge to the text limit comes here: a stylesheet file's text as
   * preparing writes it, closed at its end, with its URLs made absolute or
   * found by name and its imports written as the copy keeps those that stay
   * imports, and what that writing adds to a page's `<style>` whose imports
   * the copy takes in (`ownRewrites`); the blocks of an import's conditions
   * and the conditions that it adds to kept imports (`placedParts`); a
   * repeat's prepared text (`sheet`); and the copied attributes of added
   * `<style>` elements (`addStyle`). Callers that build text check `room` as
   * they go, so as to stop early. It only ever adds: what the copy leaves out
   * of a stylesheet's text stays counted, so that the room never grows back.
   */
  add(length: number): boolean {
    if (length > this.room) {
      this.refused++;
      return false;
    }
    this.text += Math.max(0, length);
    return true;
  }

  /**
   * Counts something that the limits kept out of a stylesheet, as `take`
   * counts one it refuses. `discarded` is how long a stylesheet's text had
   * become, scanned and rewritten, when preparing it stopped because it did
   * not fit (`ownRewrites`): that work, done for nothing, takes from
   * `DISCARD_LIMIT`. `url` is such a stylesheet's, which `take` then refuses
   * without preparing it again: the room never grows back, so it would not
   * fit later either.
   */
  refuse(discarded = 0, url?: string): void {
    this.refused++;
    this.discarded += discarded;
    if (url !== undefined) this.unfit.add(url);
  }

  /**
   * Whether the copy may add another `<style>` element, whose copied
   * attributes take `length` more text: at most `STYLE_ELEMENT_LIMIT` for a
   * page, within the text limit. One that it may add counts.
   */
  addStyle(length: number): boolean {
    if (this.styles >= STYLE_ELEMENT_LIMIT || !this.add(length)) return false;
    this.styles++;
    return true;
  }

  /**
   * The text of a stylesheet at this path and URL to prepare in place of a
   * link or an import of it, or null to leave the link or import as it is:
   * when the page has followed as many links and imports as it may, or the
   * stylesheet's text, rewritten, did not fit before (`refuse`), or the file
   * cannot be read, or its text alone does not fit in `rewriteRoom`, which
   * keeps it from being scanned once `DISCARD_LIMIT` is spent. A smaller one
   * after it can still fit, as with the copy limits, while that limit is not
   * spent. It takes nothing from the text limit: `ownRewrites` takes the text
   * as preparing writes it, once that is known to fit. Every call counts, the
   * ones that return null too, a repeat of a remembered refusal among them,
   * and so does a stylesheet whose text the caller then leaves out, so that
   * the count bounds the work, not only the copy. A repeat that `sheet`
   * answers without preparing makes no call.
   */
  async take(path: string, url: string): Promise<string | null> {
    if (this.taken >= STYLESHEET_COUNT_LIMIT) {
      this.refused++;
      return null;
    }
    this.taken++;
    if (this.unfit.has(url)) {
      this.refused++;
      return null;
    }
    let read = this.reads.get(path);
    if (read === undefined) {
      read = readStylesheet(this.context, path);
      this.reads.set(path, read);
    }
    const css = await read;
    if (css === null) return null;
    if (css.length > this.rewriteRoom) {
      this.refused++;
      return null;
    }
    return css;
  }

  /**
   * A stylesheet that the page links, or imports from one of its own `<style>`
   * elements, by its URL: what `prepare` makes of it with `take`, or null to
   * leave the link or import as it is. Such a stylesheet is always prepared
   * the same way (`fileSheet`), against its own URL, closed at its end, and
   * with its own file as its only ancestor for the depth and cycle checks, so
   * the result depends only on the URL, unless the limits kept something out
   * of it. A link and an import of the same URL are prepared alike, so they
   * share it.
   *
   * A result that the limits did not touch is kept: a prepared stylesheet, or
   * null for one that cannot be read, which the read cache gives every repeat
   * too. The same key again gets it without preparing it again. It takes
   * nothing from the count, as the page's own links and imports grow only
   * with the page; a prepared stylesheet takes the length of its prepared
   * text, as copied, from the text limit. A page of components that each link
   * the same stylesheet from a shadow root then counts it once (#154). Only
   * these are kept: the imports inside stylesheets are what multiplies.
   */
  async sheet(
    url: string,
    prepare: () => Promise<PreparedSheet | null>,
  ): Promise<PreparedSheet | null> {
    if (!this.kept.has(url)) {
      const refused = this.refused;
      const sheet = await prepare();
      // `prepare` counts everything that the limits keep out of it, so the
      // same count of refusals means that the limits left its result whole.
      if (this.refused === refused) this.kept.set(url, sheet);
      return sheet;
    }
    const kept = this.kept.get(url) ?? null;
    return kept !== null && this.add(kept.length) ? kept : null;
  }
}

/** Removes a URL's query and fragment. */
export function withoutQuery(url: string): string {
  return url.replace(/[?#].*$/, "");
}

/** An explicit empty fragment counts too: URL.hash is empty for both page and page#. */
export function isPageFragment(url: URL, pageUrl: string): boolean {
  return url.href.includes("#") && withoutQuery(url.href) === withoutQuery(pageUrl);
}

/**
 * Returns the vault path of a URL inside the vault, or null for any other URL.
 * A URL resolves its own dot segments, so a path that has them once decoded
 * came from encoded slashes, and names no vault file.
 */
export function vaultPath(url: string, vaultUrl: string): string | null {
  const plain = withoutQuery(url);
  if (!plain.startsWith(vaultUrl)) return null;
  try {
    const path = decodeURIComponent(plain.slice(vaultUrl.length));
    if (path.split("/").some((segment) => segment === "." || segment === "..")) return null;
    return path === "" ? null : path;
  } catch {
    return null;
  }
}

function resolve(reference: string, base: string): string | null {
  try {
    return new URL(reference, base).href;
  } catch {
    return null;
  }
}

/** The resource URL of a vault path. */
export function resourceUrl(path: string, vaultUrl: string): string {
  return vaultUrl + path.split("/").map(encodeURIComponent).join("/");
}

/**
 * The resource URL of the file a reference names as Obsidian's links do, by
 * name or by a partial path, when its URL leads to a vault path where nothing
 * exists; otherwise null, and the reference stays as it is. The reference's
 * fragment is kept, as for an SVG symbol.
 */
export function locatedUrl(
  reference: string,
  absolute: string,
  context: PageContext,
): string | null {
  if (!context.exists || !context.locate) return null;
  const path = vaultPath(absolute, context.vaultUrl);
  if (path === null || context.exists(path)) return null;
  let linktext: string;
  try {
    linktext = decodeURIComponent(withoutQuery(reference)).replace(/^\/+/, "");
  } catch {
    return null;
  }
  const located = linktext === "" ? null : context.locate(linktext);
  if (located === null) return null;
  const hash = reference.indexOf("#");
  return resourceUrl(located, context.vaultUrl) + (hash === -1 ? "" : reference.slice(hash));
}

/** The origin and path of the vault, as a CSP source expression. */
function vaultSource(vaultUrl: string): string {
  // CSP treats a source that ends in a slash as a path prefix, and compares
  // paths after percent-decoding them, so encoding a character that could end
  // or split the source keeps it matching the same URLs.
  return vaultUrl.replace(
    /[^A-Za-z0-9\-._~!$&()*+=:@/%]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/**
 * The copy's own policy. Browsers enforce it together with Obsidian's, so it
 * can only restrict further: Obsidian's resource URLs load only from inside
 * the vault, while web and inline resources load as before.
 */
export function pagePolicy(vaultUrl: string): string {
  const vault = vaultSource(vaultUrl);
  const web = "https: http: data: blob:";
  return [
    `default-src ${vault} ${web} 'unsafe-inline' 'unsafe-eval'`,
    `img-src ${vault} ${web}`,
    `media-src ${vault} ${web}`,
    `font-src ${vault} ${web}`,
    `frame-src ${vault} ${web}`,
    "object-src 'none'",
  ].join("; ");
}

function cssString(value: string): string {
  return `"${value.replace(/["\\\n\r\f]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `)}"`;
}

/**
 * A reference to `url` in the form of `token`: a URL token as `url()`, and a
 * string that names a resource (`cssReferences`) as a string, which keeps the
 * function around it as the page has it.
 */
function referenceText(token: CssToken, url: string): string {
  return token.kind === "url" ? `url(${cssString(url)})` : cssString(url);
}

/**
 * Rewrites the spans of the tokens that name resources (`cssReferences`),
 * preserving all other source text.
 */
function rewriteCssUrls(
  css: string,
  replace: (written: string, token: CssToken) => string,
  tokens: readonly CssToken[] = cssTokens(css),
): string {
  let result = "";
  let cursor = 0;
  for (const token of cssReferences(tokens)) {
    result += css.slice(cursor, token.start) + replace(css.slice(token.start, token.end), token);
    cursor = token.end;
  }
  return result + css.slice(cursor);
}

/**
 * A reference (`cssReferences`) made absolute against its stylesheet's URL,
 * or `written`, its text, when it does not resolve.
 */
function absoluteUrl(
  written: string,
  token: CssToken,
  sheetUrl: string,
  context?: PageContext,
): string {
  const reference = token.value;
  // An empty reference or a fragment refers to the document, as in SVG filters.
  if (reference === "" || reference.startsWith("#")) return written;
  const absolute = resolve(reference, sheetUrl);
  if (absolute === null) return written;
  return referenceText(token, (context && locatedUrl(reference, absolute, context)) ?? absolute);
}

/**
 * Makes every reference in a stylesheet (`cssReferences`) absolute, against
 * the stylesheet's own URL, with a reference that does not resolve as a path
 * located by name when the context can (`locatedUrl`).
 */
export function absoluteUrls(
  css: string,
  sheetUrl: string,
  context?: PageContext,
  tokens: readonly CssToken[] = cssTokens(css),
): string {
  return rewriteCssUrls(
    css,
    (written, token) => absoluteUrl(written, token, sheetUrl, context),
    tokens,
  );
}

/**
 * A reference (`cssReferences`) pointed at the file that `locatedUrl` finds
 * for it by name, or `written`, its text: a reference that resolves as a
 * path, against `baseUrl`, stays as written.
 */
function locatedToken(
  written: string,
  token: CssToken,
  baseUrl: string,
  context: PageContext,
): string {
  const reference = token.value;
  const absolute =
    reference === "" || reference.startsWith("#") ? null : resolve(reference, baseUrl);
  const located = absolute === null ? null : locatedUrl(reference, absolute, context);
  return located === null ? written : referenceText(token, located);
}

/** Replaces only the references in CSS (`cssReferences`) that `locatedUrl` locates by name. */
function locateCssUrls(
  css: string,
  baseUrl: string,
  context: PageContext,
  tokens: readonly CssToken[] = cssTokens(css),
): string {
  return rewriteCssUrls(
    css,
    (written, token) => locatedToken(written, token, baseUrl, context),
    tokens,
  );
}

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

/** Attributes that hold URLs, on the elements that Chromium reads them on (`urlAttributes`). */
interface UrlAttributes {
  /**
   * The elements of a document or a template's content that may have such
   * attributes, in tree order, with the names of those attributes.
   */
  elements(root: ParentNode): Generator<[Element, readonly string[]]>;
}

/**
 * `UrlAttributes` of these names, by the namespace and the local name of the
 * elements that have them: an HTML `<script>` names its file with `src`, and
 * an SVG one with `href`. The elements are found by walking the tree, which
 * in jsdom took a fifth of the time of a selector of their names on a page
 * of 100,000 table cells and 50,000 images, and matches an SVG name such as
 * `feImage` in its case. A page names its elements, so they are looked up in
 * maps: an object would give a `<constructor>` its prototype's function.
 */
function urlAttributes(
  byNamespace: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>,
): UrlAttributes {
  const names = new Map(
    Object.entries(byNamespace).map(([namespace, elements]) => [
      namespace,
      new Map(Object.entries(elements)),
    ]),
  );
  return {
    *elements(root) {
      const doc = root.ownerDocument ?? (root as Document);
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const element = node as Element;
        const found = names.get(element.namespaceURI ?? "")?.get(element.localName);
        if (found !== undefined) yield [element, found];
      }
    },
  };
}

/**
 * The HTML elements whose `background` attribute Chromium takes for the URL
 * of their background image: those of HTML's rendering rules, and `<col>` and
 * `<colgroup>`, whose images Obsidian 1.5.3 and 1.15.1 load too (#198).
 */
const BACKGROUND_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  ["body", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "col", "colgroup"].map((name) => [
    name,
    ["background"],
  ]),
);

/** Attributes holding a URL of a resource the page loads. */
const RESOURCE_ATTRIBUTES = urlAttributes({
  [HTML_NAMESPACE]: {
    img: ["src", "srcset"],
    source: ["src", "srcset"],
    video: ["src", "poster"],
    audio: ["src"],
    track: ["src"],
    input: ["src"],
    embed: ["src"],
    object: ["data"],
    iframe: ["src"],
    script: ["src"],
    ...BACKGROUND_ATTRIBUTES,
  },
  [SVG_NAMESPACE]: {
    image: ["href", "xlink:href"],
    use: ["href", "xlink:href"],
    feImage: ["href", "xlink:href"],
    script: ["href", "xlink:href"],
  },
});

/**
 * HTML's ASCII whitespace, as the inside of a character class: what HTML
 * splits a `rel` or a `srcset` on and strips from either end of a value
 * (#192). JavaScript's `\s` also matches U+00A0 and the other Unicode spaces,
 * which HTML keeps in a value.
 */
const HTML_SPACE = String.raw`\t\n\f\r `;

/** A run of HTML's whitespace (`HTML_SPACE`), on which `rel` is split. */
const HTML_SPACE_RUN = new RegExp(`[${HTML_SPACE}]+`);

/** HTML's whitespace (`HTML_SPACE`) at either end of a value. */
const HTML_SPACE_AT_ENDS = new RegExp(`^[${HTML_SPACE}]+|[${HTML_SPACE}]+$`, "g");

/**
 * A URL in a `srcset`, with the comma and the space before it. A URL itself
 * can contain commas, as a `data:` URL does; a comma that ends it is left for
 * the next URL, which starts after it. HTML splits a `srcset` on its
 * whitespace only (`HTML_SPACE`), so a URL can hold U+00A0 and the other
 * spaces that JavaScript's `\s` also matches (#192).
 */
const SRCSET_URL = new RegExp(
  `(^|,)([${HTML_SPACE}]*)([^${HTML_SPACE},][^${HTML_SPACE}]*?)(?=,?(?:[${HTML_SPACE}]|$))`,
  "g",
);

/**
 * A resource attribute's reference as the copy has it, or `written`, its
 * text, which the copy's `<base>` then resolves. A reference that does not
 * resolve as a path against `base`, the one that it resolves against
 * (`parsedBases`), points at the file that Obsidian's link resolution finds
 * for it (`locatedUrl`). Otherwise, where `base` is not the copy's `<base>`,
 * `baseUrl`, and the two resolve it to different URLs, it is made absolute
 * against `base`, as Chromium resolves it before a later `<base>`. An empty
 * reference names nothing, and one of only a fragment names a part of the
 * document itself, as an SVG `<use>`'s does: an absolute URL of the page
 * would name another document than the copy.
 */
function preparedReference(
  written: string,
  base: string,
  baseUrl: string,
  context: PageContext,
): string {
  const reference = stripSpaces(written);
  if (reference === "" || reference.startsWith("#")) return written;
  const absolute = resolve(reference, base);
  if (absolute === null) return written;
  const located = locatedUrl(reference, absolute, context);
  if (located !== null) return located;
  return base !== baseUrl && absolute !== resolve(reference, baseUrl) ? absolute : written;
}

/** Applies `preparedReference` to each URL of a `srcset`, keeping its descriptors. */
function preparedSrcset(
  srcset: string,
  base: string,
  baseUrl: string,
  context: PageContext,
): string {
  return srcset.replace(SRCSET_URL, (whole, comma: string, space: string, url: string) => {
    const prepared = preparedReference(url, base, baseUrl, context);
    return prepared === url ? whole : `${comma}${space}${prepared}`;
  });
}

/**
 * A link's reference: its `href`, which wins over the legacy `xlink:href`,
 * a reference only on SVG elements, without the ASCII whitespace that
 * Chromium strips from its ends (`stripSpaces`). It keeps U+00A0 and the
 * other spaces of JavaScript's `trim`, which Chromium resolves as part of the
 * URL (#199). Clicks and tooltips read links alike, so that a tooltip names
 * the file that a click opens, also when Obsidian's link resolution finds it
 * by name.
 */
export function linkReference(link: Element): string | null {
  const reference =
    link.getAttribute("href") ??
    (link.namespaceURI === SVG_NAMESPACE ? link.getAttributeNS(XLINK_NAMESPACE, "href") : null);
  return reference === null ? null : stripSpaces(reference);
}

/**
 * What a link's tooltip shows: the vault path of the file that a click opens
 * (see `openVaultPath` in view.ts), or the address of anything else. A link
 * within the page, such as a footnote, and a `javascript:` link show none, as
 * `linkTarget` in links.ts treats them.
 */
function linkTooltip(reference: string, absolute: string, context: PageContext): string | null {
  const url = new URL(absolute);
  if (url.protocol === "javascript:") return null;
  if (isPageFragment(url, context.pageUrl)) return null;
  const opened = locatedUrl(reference, absolute, context) ?? absolute;
  // The vault's own folder has no path to show.
  if (withoutQuery(opened) === withoutQuery(context.vaultUrl)) return null;
  return vaultPath(opened, context.vaultUrl) ?? opened;
}

/** Attributes that give an element in a link a name, which becomes part of the link's. */
const NAMING_ATTRIBUTES = ["aria-label", "aria-labelledby", "alt", "title"];

/** Elements in an SVG link that may give it a name, which `keepsSvgLink` does not compute. */
const NAMING_ELEMENTS = new Set(["title", "use", "foreignObject"]);

/**
 * Whether an SVG link keeps what it has: a title of its own, or content that
 * may name it. Chromium shows an SVG link's `xlink:title`, or else its
 * `<title>` child, as its tooltip, never a `title` attribute, and reads either
 * as the link's name, before the name that its content gives it (SVG-AAM).
 * That name can come from text, from the labels and titles of the elements
 * inside, and from what a `<use>` shows, which is not followed here; any of
 * them keeps the link as it is. HTML, which enters SVG only through a
 * `<foreignObject>`, can name it in ways that its tree does not show here:
 * with a shadow root that it declares, a form control's default label, or
 * CSS generated content. So a `<foreignObject>` inside keeps it too. The
 * link's own `aria-label` or `aria-labelledby` names it before a title does,
 * so a link with one still gets the tooltip.
 */
function keepsSvgLink(link: Element): boolean {
  if (link.hasAttribute("title") || link.hasAttributeNS(XLINK_NAMESPACE, "title")) return true;
  if ((link.textContent ?? "").trim() !== "") return true;
  for (const element of link.querySelectorAll("*")) {
    if (NAMING_ELEMENTS.has(element.localName)) return true;
    if (NAMING_ATTRIBUTES.some((name) => element.hasAttribute(name))) return true;
  }
  return false;
}

/**
 * Gives links and images without a title one (#42). A browser shows a link's
 * address in its status bar, which the viewer's frame does not have, and an
 * image's alt text only when the image does not load. A page's own titles
 * stay. An SVG link gets the tooltip as its `xlink:title`, which Chromium
 * shows, only when nothing inside it may name it (`keepsSvgLink`).
 */
function addTooltips(root: ParentNode, baseUrl: string, context: PageContext): void {
  for (const link of root.querySelectorAll("a, area")) {
    const svg = link.namespaceURI === SVG_NAMESPACE;
    if (svg ? keepsSvgLink(link) : link.hasAttribute("title")) continue;
    const reference = linkReference(link);
    if (reference === null) continue;
    const absolute = resolve(reference, baseUrl);
    const tooltip = absolute === null ? null : linkTooltip(reference, absolute, context);
    if (tooltip === null) continue;
    if (svg) link.setAttributeNS(XLINK_NAMESPACE, "xlink:title", tooltip);
    else link.setAttribute("title", tooltip);
  }
  for (const image of root.querySelectorAll("img[alt]")) {
    const alt = image.getAttribute("alt")?.trim() ?? "";
    if (alt !== "" && !image.hasAttribute("title")) image.setAttribute("title", alt);
  }
}

/**
 * Prepares the resource attributes of a document or a template's content
 * (`preparedReference`): those that do not resolve as paths point at the
 * files that Obsidian's link resolution finds for them, as the previous fork
 * did, and those before a later `<base>` are made absolute against the
 * page's address (`parsedBases`), as Chromium resolves them (#187).
 *
 * In Obsidian 1.5.3 and 1.15.1, Chromium resolves the URL of an image, a
 * picture's source, a frame, a script, also an SVG one, an SVG `<use>`, and
 * an SVG `<feImage>` as it parses the element, so always before a later
 * `<base>`. It resolves those of image inputs, posters, `background`
 * attributes, media and their sources, text tracks, SVG `<image>`, `<embed>`,
 * and `<object>` later, when it lays the element out or starts to load it:
 * against the page's address where the parser waits for a script, or reads
 * on in a longer page, before it reaches the `<base>`, but against the
 * `<base>` in a short page that it reads in one go (TESTING.md's limits). The
 * copy takes the page's address for both. So for such a short page it shows
 * the second kind from the page's folder, where Chromium shows them from the
 * `<base>`'s, as the copy's `<base>` alone did. Its policy refuses `<embed>`
 * and `<object>` anyway (`pagePolicy`). The `style` attributes are prepared
 * with the stylesheets (`prepareStyleAttributes`).
 */
function prepareReferences(
  root: ParentNode,
  parsedBase: (element: Element) => string,
  baseUrl: string,
  context: PageContext,
): void {
  for (const [element, names] of RESOURCE_ATTRIBUTES.elements(root)) {
    // Found only for an element with such an attribute: most table cells have none.
    let base: string | undefined;
    for (const name of names) {
      const value = element.getAttribute(name);
      if (value === null) continue;
      base ??= parsedBase(element);
      const prepared =
        name === "srcset"
          ? preparedSrcset(value, base, baseUrl, context)
          : preparedReference(value, base, baseUrl, context);
      if (prepared !== value) element.setAttribute(name, prepared);
    }
  }
}

/**
 * The page's base URL as Chromium computes it, and the `<base>` that sets it:
 * the first HTML `<base>` with an `href` in the document's tree, resolved
 * against the page's address. Chromium ignores a `<base>` in SVG or MathML,
 * which is an element of theirs, and one whose URL is a `data:` or
 * `javascript:` URL, which then leaves the page's address as the base, as
 * one whose `href` does not resolve does here (#185). A later `<base>` never
 * applies. The content of templates is not in the document's tree.
 */
function documentBase(doc: Document, pageUrl: string): { url: string; element: Element | null } {
  const element = [...doc.querySelectorAll("base[href]")].find(
    (base) => base.namespaceURI === HTML_NAMESPACE,
  );
  const url = element === undefined ? null : resolve(element.getAttribute("href") ?? "", pageUrl);
  if (element === undefined || url === null || /^(?:data|javascript):/.test(url))
    return { url: pageUrl, element: null };
  return { url, element };
}

/**
 * Which base URL each element of the page resolves what it names against,
 * as Chromium parses it: its stylesheets (#185), a `<style>`'s text and
 * imports, a stylesheet link's `href`, and a `style` attribute, and its
 * resource attributes (#187, `prepareReferences`). Chromium resolves them as
 * it parses each element, or soon after, against the base URL that applies
 * then, and keeps what it resolved when a `<base>` comes later. So those that
 * it parses before the page's `<base>` resolve against the page's own
 * address: the elements before it in the document's tree order, its
 * ancestors among them, and those in the declarative shadow roots of
 * templates before it, also nested ones. The others, and the content of any
 * other template, which only a script can put in the page, resolve against
 * the document's base URL, as a script that runs once the page is parsed puts
 * them there. Links, which resolve when they are followed, resolve against
 * the document's base URL too.
 */
function parsedBases(
  doc: Document,
  found: readonly HTMLTemplateElement[],
  base: Element | null,
  pageUrl: string,
  baseUrl: string,
): (element: Element) => string {
  if (base === null || baseUrl === pageUrl) return () => baseUrl;
  // What comes before the <base> in tree order is taken for what the parser
  // made before it. That holds apart from what the parser moves or completes
  // later: the foster parenting of a table puts a <base> inside one before
  // the table, which it made first, and a second <body> tag's attributes go
  // on the first <body>, after the <base> before them (TESTING.md's limits).
  const before = new Set<Node>();
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node !== null && node !== base; node = walker.nextNode())
    before.add(node);
  const owners = new Map<Node, HTMLTemplateElement>(
    found.map((template) => [template.content, template]),
  );
  // Whether each template's content is parsed before the <base>, found once
  // for all of its elements.
  const contents = new Map<Node, boolean>();
  const parsedBefore = (element: Element): boolean => {
    const root = element.getRootNode();
    if (root === doc) return before.has(element);
    let known = contents.get(root);
    if (known === undefined) {
      const owner = owners.get(root);
      known = owner !== undefined && declaresShadowRoot(owner) && parsedBefore(owner);
      contents.set(root, known);
    }
    return known;
  };
  return (element) => (parsedBefore(element) ? pageUrl : baseUrl);
}

/**
 * A `style` attribute's tokens, as CSS reads its declarations: closed at its
 * end, as CSS closes them (`cssDeclarationsEnd`), so that a string or a
 * `url(` that the end leaves open names its file there, as in Chromium
 * (#194). The closers only follow the attribute's text, so that each token
 * keeps its place, and the last one's span can reach past the text. The copy
 * keeps the attribute's text, in which a rewrite of that token replaces it to
 * the end: the rewritten reference is closed, and CSS closes the rest in the
 * frame as here. So a custom property that the end leaves open keeps its
 * text, as it does not in a closed `<style>` (`closedSheet`).
 */
function declarationTokens(css: string): CssToken[] {
  const tokens = cssTokens(css);
  const closers = cssDeclarationsEnd(css, tokens);
  return closers === "" ? tokens : cssTokens(css + closers);
}

/**
 * A `style` attribute's declarations, with their tokens
 * (`declarationTokens`), with their references made absolute against `base`,
 * or found by name (`absoluteUrl`), and the length that this adds, or null
 * once that passes `room`, where the work stops.
 */
function absoluteDeclarations(
  css: string,
  tokens: readonly CssToken[],
  base: string,
  context: PageContext,
  room: number,
): { text: string; added: number } | null {
  let text = "";
  let cursor = 0;
  let added = 0;
  for (const token of cssReferences(tokens)) {
    const written = css.slice(token.start, token.end);
    const rewrite = absoluteUrl(written, token, base, context);
    added += Math.max(0, rewrite.length - written.length);
    if (added > room) return null;
    text += css.slice(cursor, token.start) + rewrite;
    cursor = token.end;
  }
  return { text: text + css.slice(cursor), added };
}

/**
 * Prepares the `style` attributes of a document or a template's content. One
 * that resolves against the copy's `<base>` (`parsedBases`) keeps its
 * references as written, apart from those found by name. Any other gets them
 * absolute against its own base, and what that adds counts toward the text
 * limit, as for a `<style>`; when it would not fit, it keeps its references as
 * written, apart from those found by name, which the copy's `<base>` then
 * resolves.
 */
function prepareStyleAttributes(
  root: ParentNode,
  parsedBase: (element: Element) => string,
  baseUrl: string,
  context: PageContext,
  budget: StylesheetBudget,
): void {
  for (const element of root.querySelectorAll("[style]")) {
    const style = element.getAttribute("style") ?? "";
    const base = parsedBase(element);
    const tokens = declarationTokens(style);
    let replaced: string | null = null;
    if (base !== baseUrl) {
      const absolute = absoluteDeclarations(style, tokens, base, context, budget.room);
      if (absolute !== null && budget.add(absolute.added)) replaced = absolute.text;
    }
    if (replaced === null && context.exists && context.locate)
      replaced = locateCssUrls(style, base, context, tokens);
    if (replaced !== null && replaced !== style) element.setAttribute("style", replaced);
  }
}

/**
 * A stylesheet's text closed at its end, with its tokens, and whether it has a
 * `}` outside any block (`cssEnd`). CSS ends each stylesheet on its own,
 * closing what is still open there, such as a block, a string, or an import
 * without its `;`. Closed, the text holds whole tokens that read as CSS reads
 * them there: an unquoted URL at its end is a URL, and its last import counts.
 * Put in an importing stylesheet, it ends where a rule may start, so it leaves
 * the text after its import as the page has it. In a `<style>` of its own,
 * CSS parses the same rules from it, apart from an empty one for a selector
 * left without its block. A custom property left open at the end is the
 * exception: Chromium keeps its value as text, closers and all, and puts that
 * text where the property is used, so a use with more text after it can
 * compute differently, as with `--x: (1px + 2px` in `calc(var(--x) * 2)`.
 */
function closedSheet(css: string): {
  text: string;
  tokens: CssToken[];
  strayCloser: boolean;
  markers: CssToken[];
} {
  const tokens = cssTokens(css);
  const { closers, strayCloser, markers } = cssEnd(css, tokens);
  if (closers === "") return { text: css, tokens, strayCloser, markers };
  const text = css + closers;
  // The markers keep their places: the closers only follow the text.
  return { text, tokens: cssTokens(text), strayCloser, markers };
}

/**
 * Returns the texts of the stylesheets that the copy puts in place of a
 * stylesheet (`stylesheetTexts`): its text, closed at its end
 * (`closedSheet`), with its imports of vault stylesheets replaced by their
 * text, within the limits of a page of its own (`StylesheetBudget`), and
 * every reference made absolute. Imports from elsewhere stay as they are, for
 * the browser to load or refuse, as do those past the limits. Its own text
 * takes nothing from the text limit, as a page's `<style>` takes nothing, but
 * what making its URLs and imports absolute adds does, as for a stylesheet
 * file. Past the limit, it keeps its closed text, with only the references
 * found by name replaced, as a page's `<style>` does. The plugin prepares
 * stylesheets only through `preparePage`; the tests and
 * `scripts/css-benchmark.mjs` use this to check and time a stylesheet's
 * preparation without a page around it.
 */
export async function inlineStylesheet(
  css: string,
  sheetUrl: string,
  context: PageContext,
): Promise<string[]> {
  const budget = new StylesheetBudget(context);
  const { text, tokens } = closedSheet(css);
  const sheet = await inlineImports(text, sheetUrl, context, budget, {
    seen: new Set(),
    tokens,
    own: { length: 0, absolute: true },
  });
  if (sheet === null) return [locateCssUrls(text, sheetUrl, context, tokens)];
  return stylesheetTexts(sheet.parts, () => budget.addStyle(0));
}

/**
 * A vault stylesheet that a link or an import names, prepared for the copy and
 * closed at its end (`closedSheet`), or null to leave the link or import as it
 * is. Its markers become spaces, so that it reads the same in a block of an
 * import's conditions (#152). `seen` holds the stylesheets that import it, and
 * is empty for the page's own links and the imports of its own `<style>`
 * elements.
 *
 * It is also null when its text as preparing writes it, closed and rewritten,
 * would not fit in the text limit (`ownRewrites`): with its URLs left
 * relative, which would resolve against the page instead, its images and
 * fonts would not load, and its kept imports would name other files. Such a
 * stylesheet takes nothing from the text limit, as one too large does. The
 * length that scanning and rewriting it reached takes from `DISCARD_LIMIT`
 * instead, and its URL is remembered, so that the work is bounded: a repeat
 * of the URL is refused without preparing it (`StylesheetBudget.take`), and
 * another URL of the same file, such as one with a query, is prepared only
 * within what remains of that limit (`StylesheetBudget.rewriteRoom`).
 */
async function fileSheet(
  path: string,
  sheetUrl: string,
  context: PageContext,
  seen: ReadonlySet<string>,
  budget: StylesheetBudget,
): Promise<PreparedSheet | null> {
  const read = await budget.take(path, sheetUrl);
  if (read === null) return null;
  const sheet = closedSheet(read);
  const inner = await inlineImports(sheet.text, sheetUrl, context, budget, {
    seen: new Set([...seen, path]),
    tokens: sheet.tokens,
    markers: sheet.markers,
    own: { length: sheet.text.length, absolute: true, url: sheetUrl },
  });
  if (inner === null) return null;
  return { ...inner, strayCloser: sheet.strayCloser || inner.strayCloser };
}

/** Whether an import has no conditions: its stylesheet's parts go in the importing one as they are. */
function unconditional({ layer, supports, media }: ImportConditions): boolean {
  return layer === null && supports === null && media === null;
}

/** An import rule of a stylesheet, and the vault path of the stylesheet that it names, or null. */
interface ImportEntry {
  readonly match: CssImport;
  /** The rule as the copy keeps it if it stays an import. */
  readonly kept: KeptImport;
  readonly path: string | null;
}

/**
 * An import rule, with its reference made absolute against its stylesheet's
 * URL, or located by name (`locatedUrl`), in the rule that the copy keeps if
 * it stays an import.
 */
function importEntry(
  match: CssImport,
  css: string,
  sheetUrl: string,
  context: PageContext,
): ImportEntry {
  const reference = match.reference;
  const absolute = resolve(reference, sheetUrl);
  const located = absolute === null ? null : locatedUrl(reference, absolute, context);
  const target = located ?? absolute;
  // Trim only CSS whitespace, only at the start. JavaScript's whitespace also
  // covers characters such as U+FEFF that CSS reads as part of a name. Keep
  // the end as written: a newline there ends a bad string, and a space after
  // a backslash keeps it from escaping what follows.
  const written = css.slice(match.conditionsStart, match.end - 1).replace(/^[\t\n\f\r ]+/, "");
  const kept: KeptImport = {
    kind: "import",
    text:
      target === null
        ? css.slice(match.start, match.end)
        : `@import url(${cssString(target)})${written ? ` ${written}` : ""};`,
    url: target,
    conditions: match.conditions,
  };
  return { match, kept, path: target === null ? null : vaultPath(target, context.vaultUrl) };
}

/** A span of a stylesheet's own text, from `start` to `end`, and the text that the copy puts there. */
interface Rewrite {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** How a stylesheet's own text counts toward the text limit, and how its URLs change (`ownRewrites`). */
interface OwnText {
  /**
   * How much of the text limit its own text takes, as closed (`closedSheet`):
   * a stylesheet file's length, or 0 for a page's `<style>`, whose text is
   * the page's own.
   */
  readonly length: number;
  /**
   * Whether its URLs are made absolute against its URL, as a stylesheet
   * file's must be in a `<style>` of the page, or keep their text, apart from
   * those found by name: the copy's `<base>` resolves a page's `<style>` as
   * the page does.
   */
  readonly absolute: boolean;
  /** A stylesheet file's URL, which a refusal remembers (`StylesheetBudget.refuse`). */
  readonly url?: string;
}

/**
 * What rewriting makes of a stylesheet's own text: each of its import rules
 * as the copy keeps it if it stays an import (`importEntry`), and each of its
 * other URLs made absolute against its URL (`absoluteUrl`), or, without
 * `own.absolute`, pointed at a file found by name (`locatedToken`). Its own
 * text, with what making URLs and imports absolute adds to it, takes from the
 * text limit (`StylesheetBudget.add`); what finding a file by name adds to a
 * page's `<style>` takes nothing, as in the rest of the page's own text.
 *
 * Null when that would not fit, once it passes `StylesheetBudget.rewriteRoom`,
 * where the work stops. The refusal counts, with the length that the text had
 * reached, and remembers a stylesheet file's URL (`StylesheetBudget.refuse`).
 * A rewrite that shortens its text, as one without the spaces around a
 * reference does, gives nothing back, as the text limit never does. Each
 * rewrite is made once, and the copy uses the text that was measured.
 */
function ownRewrites(
  css: string,
  sheetUrl: string,
  context: PageContext,
  tokens: readonly CssToken[],
  own: OwnText,
  budget: StylesheetBudget,
): { imports: ImportEntry[]; rewrites: Rewrite[] } | null {
  const room = budget.rewriteRoom;
  /** How long the text is so far as the copy would have it, which is discarded if it does not fit. */
  let added = own.length;
  const refuse = () => {
    budget.refuse(added, own.url);
    return null;
  };
  if (added > room) return refuse();
  const imports: ImportEntry[] = [];
  for (const match of cssImports(css, tokens)) {
    const entry = importEntry(match, css, sheetUrl, context);
    added += Math.max(0, entry.kept.text.length - (match.end - match.start));
    if (added > room) return refuse();
    imports.push(entry);
  }
  // Imports and URLs share the same scan; never rescan each intervening segment.
  const rewrites: Rewrite[] = [];
  let next = 0;
  for (const token of cssReferences(tokens)) {
    // A URL inside an import rule, as in `@import url(...)`, is part of the
    // rule's replacement. Rules and tokens both come in order.
    while (next < imports.length && imports[next].match.end <= token.start) next++;
    if (next < imports.length && imports[next].match.start <= token.start) continue;
    const written = css.slice(token.start, token.end);
    if (!own.absolute) {
      const text = locatedToken(written, token, sheetUrl, context);
      if (text !== written) rewrites.push({ start: token.start, end: token.end, text });
      continue;
    }
    const text = absoluteUrl(written, token, sheetUrl, context);
    added += Math.max(0, text.length - written.length);
    if (added > room) return refuse();
    rewrites.push({ start: token.start, end: token.end, text });
  }
  return budget.add(added) ? { imports, rewrites } : refuse();
}

/** A stylesheet's own text as `inlineImports` prepares it, beside the text itself. */
interface SheetText {
  /** The stylesheet's own file and those that import it; empty for a page's own `<style>`. */
  readonly seen: ReadonlySet<string>;
  /** Its tokens (`cssTokens`). */
  readonly tokens: readonly CssToken[];
  /** Its `<!--` and `-->` between rules (`CssEnd`), which become spaces: a stylesheet file's. */
  readonly markers?: readonly CssToken[];
  readonly own: OwnText;
}

/**
 * A stylesheet's parts (`PreparedSheet`), with its imports of vault
 * stylesheets replaced by theirs, in the block forms of their conditions
 * (`placedParts`), and its URLs rewritten (`ownRewrites`); its markers become
 * spaces. Also whether it holds an imported stylesheet's `}` outside any
 * block, put in it without a block around it.
 *
 * Its own text, rewritten, takes from the text limit before the stylesheets
 * that it imports do (`ownRewrites`). When that would not fit, it is null.
 */
async function inlineImports(
  css: string,
  sheetUrl: string,
  context: PageContext,
  budget: StylesheetBudget,
  { seen, tokens, markers = [], own }: SheetText,
): Promise<PreparedSheet | null> {
  const importSupports = context.importSupports ?? hostImportSupports();
  const rewritten = ownRewrites(css, sheetUrl, context, tokens, own, budget);
  if (rewritten === null) return null;
  let strayCloser = false;
  const rewrites: Rewrite[] = rewritten.rewrites;
  if (markers.length > 0) {
    for (const { start, end } of markers) rewrites.push({ start, end, text: " " });
    rewrites.sort((a, b) => a.start - b.start);
  }
  let cursor = 0;
  let next = 0;
  /** The stylesheet's own text from the cursor to `to`, rewritten, and the cursor moved there. */
  const ownPart = (to: number): TextPart => {
    const stop = importStop(tokens, cursor, to);
    let text = "";
    for (; next < rewrites.length && rewrites[next].start < to; next++) {
      const { start, end, text: rewrite } = rewrites[next];
      text += css.slice(cursor, start) + rewrite;
      cursor = end;
    }
    text += css.slice(cursor, to);
    cursor = to;
    return { kind: "text", text, stop };
  };

  const parts: (TextPart | KeptImport)[] = [];
  for (const { match, kept, path } of rewritten.imports) {
    addPart(parts, ownPart(match.start));
    cursor = match.end;
    const target = kept.url;
    // An import with a scope, or with support conditions where the host
    // never applies them, stays an import, as the browser reads it (#151).
    const conditions =
      match.conditions !== null && (match.conditions.supports === null || importSupports)
        ? match.conditions
        : null;
    const readable =
      path !== null && isStylesheetFile(path) && !seen.has(path) && seen.size < MAX_IMPORT_DEPTH;
    let sheet: PreparedSheet | null = null;
    if (target !== null && path !== null && readable && conditions !== null) {
      const prepare = () => fileSheet(path, target, context, seen, budget);
      // An import in a page's own <style> is prepared the same way each time,
      // as a link of the same URL is.
      sheet = seen.size === 0 ? await budget.sheet(target, prepare) : await prepare();
    }
    if (sheet !== null && conditions !== null && unconditional(conditions)) {
      for (const part of sheet.parts) addPart(parts, part);
      strayCloser ||= sheet.strayCloser;
      continue;
    }
    // A stray "}" would end the blocks early, and the blocks' own "}" would
    // then take the importing sheet's next rule.
    let placed: ReturnType<typeof placedParts> = null;
    if (sheet !== null && conditions !== null && !sheet.strayCloser) {
      placed = placedParts(sheet.parts, conditions, budget.room, false);
      if (placed === null) {
        // What it adds would take the page past its text limit: one block,
        // which adds the least, may still fit.
        budget.refuse();
        placed = placedParts(sheet.parts, conditions, budget.room, true);
      }
    }
    if (placed === null || !budget.add(placed.added)) {
      addPart(parts, kept);
      continue;
    }
    for (const part of placed.parts) addPart(parts, part);
  }
  addPart(parts, ownPart(css.length));
  let length = 0;
  for (const part of parts) length += part.text.length;
  return { parts, length, strayCloser };
}

/**
 * Stylesheet text that is safe inside a <style> element: the copy is
 * serialized and parsed again, and `</style` would end the element there.
 * `<\/style` is the same text to CSS.
 */
export function styleElementText(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

/** Text with its ASCII capitals in lowercase, for ASCII case-insensitive comparison. */
function asciiLowercase(text: string): string {
  return text.replace(/[A-Z]+/g, (capitals) => capitals.toLowerCase());
}

/**
 * Whether a `<style>` element's `type` names CSS, which Chromium applies:
 * absent or empty, or exactly `text/css` in any ASCII case, without
 * parameters or spaces around it (#147). Other types keep a stylesheet
 * language or a template in the page, which the page's scripts may read.
 *
 * Chromium 150 (Obsidian 1.15.1) reads an SVG `<style>`'s type as an HTML
 * one's, but Chromium 114 (Obsidian 1.5.3) applies an SVG one only with a
 * lowercase `text/css`. There, an SVG `<style>` with the type in other case
 * is prepared though it applies nothing either way.
 */
function isCssStyle(style: Element): boolean {
  const type = style.getAttribute("type");
  return type === null || type === "" || asciiLowercase(type) === "text/css";
}

/**
 * Whether a `<style>` element's text is a stylesheet: an HTML one, or an SVG
 * one, which SVG processes as HTML's, of a CSS type (`isCssStyle`). MathML has
 * no `<style>`, so one there is an unknown element, which Chromium applies
 * nothing from.
 */
function isStylesheetStyle(style: Element): boolean {
  return (
    (style.namespaceURI === HTML_NAMESPACE || style.namespaceURI === SVG_NAMESPACE) &&
    isCssStyle(style)
  );
}

/**
 * The titled stylesheets that apply in a template's content, whose titles do
 * not decide (`inStylesheetSet`).
 */
const EVERY_SET = Symbol("every stylesheet set");

/**
 * Which titled stylesheets of a part of the page apply (`inStylesheetSet`):
 * in the document, those of its preferred set, by the set's name
 * (`preferredSet`), or none, null, when nothing names one; in a template's
 * content, every one, `EVERY_SET`.
 */
type StylesheetSet = string | null | typeof EVERY_SET;

/**
 * The `<style>` elements whose text is a stylesheet that Chromium applies
 * (`isStylesheetStyle`), in a document only those of the stylesheet set that
 * applies (`inStylesheetSet`). The others stay as the page has them.
 */
function styleElements(root: ParentNode, preferred: StylesheetSet): Element[] {
  return [...root.querySelectorAll("style")].filter(
    (style) => isStylesheetStyle(style) && inStylesheetSet(style, preferred),
  );
}

/**
 * A link's link types, in ASCII lowercase, as HTML reads `rel`: split on
 * ASCII whitespace only (#192). JavaScript's whitespace, `\s`, also matches
 * U+00A0 and other spaces, which HTML takes for part of a type: `stylesheet`,
 * U+00A0, and `x` make one type, and no stylesheet link, which headless
 * Chrome 158 and Obsidian 1.5.3 and 1.15.1 load nothing for. Chromium 114, in
 * Obsidian 1.5.3, also takes a tab, a form feed, or a carriage return for
 * part of a type, where 1.15.1 splits on them (TESTING.md's limits). The
 * parser keeps a carriage return only from a character reference.
 */
function linkTypes(link: Element): string[] {
  return asciiLowercase(link.getAttribute("rel") ?? "").split(HTML_SPACE_RUN);
}

/**
 * Whether a stylesheet's title and link types let it apply (#169), as
 * Chromium applies stylesheet sets. In a document, `preferred` is the name of
 * the preferred set (`preferredSet`), or null when nothing names one: an
 * untitled stylesheet applies, and a titled one only with that name, also an
 * `alternate stylesheet` link, but an untitled alternate one never does. In a
 * shadow root, Chromium applies every stylesheet, whatever its title, but an
 * alternate link; so does the content of a template, for which `preferred` is
 * `EVERY_SET`, as the content of most templates goes in shadow roots.
 * Headless Chrome 158 and Obsidian 1.5.3 and 1.15.1 apply them so.
 */
function inStylesheetSet(element: Element, preferred: StylesheetSet): boolean {
  const alternate = element.localName === "link" && linkTypes(element).includes("alternate");
  const title = element.getAttribute("title") ?? "";
  if (preferred === EVERY_SET || title === "") return !alternate;
  return title === preferred;
}

/**
 * Removes the ASCII whitespace that HTML strips from either end of a value,
 * as Chromium strips it from a URL attribute's. `trim` would also remove
 * U+00A0 and the other spaces of JavaScript's `\s`, which such a URL holds,
 * escaped (#192). Resolving the URL strips the C0 controls left around it.
 */
function stripSpaces(value: string): string {
  return value.replace(HTML_SPACE_AT_ENDS, "");
}

/**
 * The name of a document's preferred stylesheet set (#169), as Chromium
 * finds it while it parses the page: the first, in tree order, of the
 * content of a `<meta http-equiv="Default-Style">` that is not empty, and the
 * title of a `<style>` (`isStylesheetStyle`) or of a stylesheet link that is
 * not an alternate one (`isStylesheetLink`), whose `href` is not blank and
 * resolves to a URL against the link's base (`parsedBase`), as `http://[x`
 * does not, and which has a title. Such a link names the set before it
 * loads, so also when its stylesheet is missing, or when the copy leaves it a
 * link that Obsidian's policy refuses. A later one, also a `<meta>`, changes
 * nothing, and none in a shadow root or a template names one. Null when
 * nothing names a set: then only untitled stylesheets apply. Titles compare
 * exactly, their case and spaces included.
 */
function preferredSet(doc: Document, parsedBase: (element: Element) => string): string | null {
  for (const element of doc.querySelectorAll("meta, style, link")) {
    let name = "";
    if (element.localName === "meta") {
      const equiv = element.getAttribute("http-equiv");
      if (
        element.namespaceURI === HTML_NAMESPACE &&
        asciiLowercase(equiv ?? "") === "default-style"
      )
        name = element.getAttribute("content") ?? "";
    } else if (element.localName === "style") {
      if (isStylesheetStyle(element)) name = element.getAttribute("title") ?? "";
    } else if (isStylesheetLink(element) && !linkTypes(element).includes("alternate")) {
      const href = stripSpaces(element.getAttribute("href") ?? "");
      if (href !== "" && resolve(href, parsedBase(element)) !== null)
        name = element.getAttribute("title") ?? "";
    }
    if (name !== "") return name;
  }
  return null;
}

/** A `<style>` element's own text nodes, in order. */
function styleTextNodes(style: Element): Text[] {
  return [...style.childNodes].filter((node): node is Text => node.nodeType === Node.TEXT_NODE);
}

/**
 * A `<style>` element's stylesheet: its child text content, the text of its
 * own text nodes, which is all that HTML applies. The text of an SVG
 * `<style>`'s child elements is not part of it, but the text on either side
 * of one is, joined, as if the element were not there.
 */
function styleText(style: Element): string {
  return styleTextNodes(style)
    .map((node) => node.data)
    .join("");
}

/**
 * Gives a `<style>` element a new stylesheet, escaped with `styleElementText`,
 * keeping the child elements that an SVG one can have: the first of its own
 * text nodes gets the whole text, and the others are removed. A rewritten URL
 * or import can span a child element, as its text joins across it, so the
 * text is not split again.
 */
function setStyleText(style: Element, css: string): void {
  const [first, ...rest] = styleTextNodes(style);
  const text = styleElementText(css);
  if (first === undefined) style.prepend(text);
  else first.data = text;
  for (const node of rest) node.remove();
}

/**
 * Whether a UTF-16 code unit is whitespace that Chromium trims around a link
 * type's essence: ASCII whitespace with U+000B, and the characters of
 * Unicode's whitespace bidirectional class, U+1680, U+2000 to U+200A, U+2028,
 * U+205F, and U+3000, as headless Chrome 158 trims them; U+0085, U+00A0,
 * U+180E, U+200B, U+2029, U+202F, and U+FEFF are not. In Obsidian 1.5.3 and
 * 1.15.1, a link loads with each of U+000B, U+1680, U+2003, U+2028, and
 * U+3000 around `text/css`, but not with U+00A0, U+180E, U+2029, or U+202F
 * (#147).
 */
function isLinkTypeSpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x205f ||
    code === 0x3000
  );
}

/**
 * Whether a link's `type` names CSS, which Chromium loads a stylesheet link
 * for: absent, or a MIME type whose essence, the text before its first `;`
 * with the whitespace around it trimmed (`isLinkTypeSpace`), is empty or
 * ASCII case-insensitively `text/css`. Parameters and spaces count, unlike on
 * a `<style>`. The type is the page's, of any length, so the trim scans each
 * end once: a regular expression that tried a run of spaces from each of its
 * positions would take quadratic time on a long run inside the essence.
 */
function isCssLink(link: Element): boolean {
  const type = link.getAttribute("type");
  if (type === null) return true;
  const semicolon = type.indexOf(";");
  let end = semicolon === -1 ? type.length : semicolon;
  let start = 0;
  while (start < end && isLinkTypeSpace(type.charCodeAt(start))) start++;
  while (end > start && isLinkTypeSpace(type.charCodeAt(end - 1))) end--;
  const essence = type.slice(start, end);
  return essence === "" || asciiLowercase(essence) === "text/css";
}

/**
 * Whether an element is a stylesheet link that Chromium loads. Only HTML has
 * `<link>`: inside SVG or MathML, the HTML parser makes one an element of
 * theirs, which loads nothing. An HTML `<style>` put in its place would be
 * parsed as theirs when the copy is parsed again, with its text read as
 * markup. A `disabled` link, or one of another type (`isCssLink`), loads
 * nothing either, and stays as the page has it. A script that enables a
 * disabled link later cannot load it in the frame, as Obsidian's policy
 * allows only inline styles there. Whether an `alternate stylesheet` link
 * applies depends on its title (`inStylesheetSet`).
 */
function isStylesheetLink(element: Element): element is HTMLLinkElement {
  return (
    element.namespaceURI === HTML_NAMESPACE &&
    linkTypes(element).includes("stylesheet") &&
    element.hasAttribute("href") &&
    !element.hasAttribute("disabled") &&
    isCssLink(element)
  );
}

/**
 * The stylesheet links that Chromium applies (`isStylesheetLink`), in a
 * document only those of the stylesheet set that applies (`inStylesheetSet`).
 * The others stay as the page has them, and are not read: a script that
 * switches to their set with scripts on gets no stylesheet, as Obsidian's
 * policy refuses a link.
 */
function stylesheetLinks(root: ParentNode, preferred: StylesheetSet): HTMLLinkElement[] {
  return [...root.querySelectorAll("link")].filter(
    (link) => isStylesheetLink(link) && inStylesheetSet(link, preferred),
  );
}

/**
 * Replaces a document's or a template content's stylesheet links to `.css`
 * files in the vault with their text, and inlines the imports of its
 * `<style>` elements, as Obsidian's policy allows only inline styles. Only
 * the `<style>` and `<link>` elements that Chromium applies are prepared
 * (`styleElements`, `stylesheetLinks`), each closed at its end as CSS closes
 * it. Links and imports past the page's limits stay as they are. Then come
 * its `style` attributes (`prepareStyleAttributes`). Each element's
 * stylesheet resolves against its own base (`PageRoot.parsedBase`), and
 * `baseUrl` is the copy's `<base>`.
 */
async function inlineStylesheets(
  { node: root, parsedBase, preferred }: PageRoot,
  baseUrl: string,
  context: PageContext,
  budget: StylesheetBudget,
): Promise<void> {
  // The <style> elements that links become have their imports inlined
  // already. Preparing them again would take their imports from the page's
  // limits again, with the import depth and cycle checks restarted.
  const originalStyles = styleElements(root, preferred);
  for (const link of stylesheetLinks(root, preferred)) {
    const href = link.getAttribute("href") ?? "";
    const resolved = resolve(href, parsedBase(link));
    const sheetUrl = (resolved && locatedUrl(href, resolved, context)) ?? resolved;
    const path = sheetUrl === null ? null : vaultPath(sheetUrl, context.vaultUrl);
    if (sheetUrl === null || path === null || !isStylesheetFile(path)) continue;
    const sheet = await budget.sheet(sheetUrl, () =>
      fileSheet(path, sheetUrl, context, new Set(), budget),
    );
    if (sheet === null) continue;
    const texts = stylesheetTexts(sheet.parts, () =>
      budget.addStyle(copiedLength(link, LINK_ATTRIBUTES)),
    );
    // One at a time: a call takes only so many arguments.
    for (const text of texts) link.before(styleFor(link, HTML_NAMESPACE, LINK_ATTRIBUTES, text));
    link.remove();
  }

  for (const style of originalStyles) {
    const own = styleText(style);
    // Closed as a stylesheet file is, so that its last import and URL read as
    // CSS reads them there. The copy keeps the closed text, which the copying
    // of files then reads as well.
    const { text: css, tokens } = closedSheet(own);
    // Its own text is the page's, which the text limit does not count. Where
    // the copy's <base> resolves it as the page does, its URLs keep their
    // text, apart from those found by name, as without imports, and what the
    // imports that stay imports add counts. Where it does not, because the
    // page's <base> comes after it (#185), its URLs are made absolute against
    // its own base, and what that adds counts too, as for a stylesheet file.
    // When that would not fit, its imports and URLs all stay as written.
    const base = parsedBase(style);
    const absolute = base !== baseUrl;
    const inlined =
      absolute || cssImports(css, tokens).length > 0
        ? await inlineImports(css, base, context, budget, {
            seen: new Set(),
            tokens,
            own: { length: 0, absolute },
          })
        : null;
    const texts =
      inlined === null
        ? [locateCssUrls(css, base, context, tokens)]
        : stylesheetTexts(inlined.parts, () =>
            budget.addStyle(copiedLength(style, STYLE_ATTRIBUTES)),
          );
    // The element keeps the last stylesheet, which holds its own rules, and
    // the others go before it, in its namespace (`styleFor`).
    const text = styleElementText(texts.pop() ?? "");
    for (const before of texts)
      style.before(styleFor(style, style.namespaceURI, STYLE_ATTRIBUTES, before));
    // Escaped before comparing, so that a style whose text needs only the escape is written too.
    if (text !== own) setStyleText(style, text);
  }
  prepareStyleAttributes(root, parsedBase, baseUrl, context, budget);
}

/**
 * The attributes that decide how a link's stylesheet applies, which the
 * `<style>` elements in its place get: `media`, and `title`, which keeps them
 * in its set of alternative stylesheets. A link's `type` may have parameters,
 * which would keep a `<style>` from applying (`isCssStyle`).
 */
const LINK_ATTRIBUTES = ["media", "title"];

/**
 * The attributes that decide how a `<style>` applies, which those put before
 * it get: also its `type`, which an SVG `<style>` on Chromium 114 needs in
 * lowercase to apply (`isCssStyle`).
 */
const STYLE_ATTRIBUTES = ["media", "title", "type"];

/** The length of an element's attributes of these names, which a `<style>` copies (`styleFor`). */
function copiedLength(element: Element, names: readonly string[]): number {
  let length = 0;
  for (const name of names) length += element.getAttribute(name)?.length ?? 0;
  return length;
}

/**
 * A `<style>` for one of the stylesheets that the copy puts in place of a link
 * or another `<style>`, with the attributes of these names, so that it
 * applies as the element does. Those before an SVG `<style>` are SVG ones,
 * so that parsing the copy again reads them as it reads the page's.
 */
function styleFor(
  element: Element,
  namespace: string | null,
  names: readonly string[],
  text: string,
): Element {
  const style = element.ownerDocument.createElementNS(namespace, "style");
  for (const name of names) {
    const value = element.getAttribute(name);
    if (value !== null) style.setAttribute(name, value);
  }
  setStyleText(style, text);
  return style;
}

/** How the view reads the vault's files to copy them into a page (#11). */
export interface LocalFiles {
  /** A vault file's size in bytes, or null if there is no file at the path. */
  size(path: string): number | null;
  /**
   * A vault file's bytes, or null if there is no file at the path. A file
   * whose read fails is left out, as one that is missing.
   */
  readBinary(path: string): Promise<ArrayBuffer | null>;
}

/**
 * The types of the vault files that are copied into a page, by extension:
 * images, audio, video, text tracks, fonts, and scripts. The page's scripts
 * can read every file copied into it, so notes and other documents never are.
 */
const COPIED_TYPES: Readonly<Record<string, string>> = {
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  m4v: "video/mp4",
  mp4: "video/mp4",
  ogv: "video/ogg",
  webm: "video/webm",
  vtt: "text/vtt",
  otf: "font/otf",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
  js: "text/javascript",
  mjs: "text/javascript",
};

/** The largest file copied into a page, and the most that a page gets in all, in bytes. */
export const COPY_FILE_LIMIT = 8_000_000;
export const COPY_PAGE_LIMIT = 32_000_000;

/**
 * Attributes holding the URL of a file that is copied into a page. Chromium
 * 150, in Obsidian 1.15.1, refuses a `data:` URL in an SVG `<use>`, so its
 * file is not copied (#196).
 */
const COPIED_ATTRIBUTES = urlAttributes({
  [HTML_NAMESPACE]: {
    img: ["src", "srcset"],
    source: ["src", "srcset"],
    video: ["src", "poster"],
    audio: ["src"],
    track: ["src"],
    input: ["src"],
    script: ["src"],
    ...BACKGROUND_ATTRIBUTES,
  },
  [SVG_NAMESPACE]: {
    image: ["href", "xlink:href"],
    feImage: ["href", "xlink:href"],
    script: ["href", "xlink:href"],
  },
});

/** What copying a page's local files did. */
export interface CopiedFiles {
  /** How many vault files were copied into the page. */
  readonly copied: number;
  /** How many were left out, in some places or all, because of the size limits. */
  readonly leftOut: number;
}

/**
 * The order in which kinds of files get the page's limit: scripts and fonts,
 * which are small and which the page needs to work and to read as intended,
 * before images, and audio and video last.
 */
function copyRank(type: string): number {
  if (type === "text/javascript") return 0;
  if (type.startsWith("font/")) return 1;
  if (type === "text/vtt") return 2;
  if (type.startsWith("image/")) return 3;
  return 4;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  // String.fromCharCode takes its arguments on the stack, so in chunks.
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/** A reference's absolute URL in, and the URL to put in its place out, or null to leave it. */
type Visit = (url: string) => Promise<string | null>;

/**
 * Turns references to vault files into `data:` URLs, which a frame with an
 * opaque origin loads (measured in #11). A first pass notes every reference;
 * the plan then gives the limits to them by kind and in document order, and
 * the second pass copies what the plan allows. Each reference counts against
 * the page's limit, as each holds its own copy, but each file is read once.
 */
class FileCopier {
  private readonly noted: { path: string; size: number; rank: number }[] = [];
  /** How many references to each file the plan allows, and how many the second pass used. */
  private readonly allowed = new Map<string, number>();
  private readonly used = new Map<string, number>();
  private readonly reads = new Map<string, Promise<string | null>>();
  private readonly copiedPaths = new Set<string>();
  private readonly leftOutPaths = new Set<string>();

  constructor(
    private readonly files: LocalFiles,
    private readonly vaultUrl: string,
  ) {}

  /**
   * The vault path and type of a URL's file, if it is one that is copied: by
   * its extension, among the types' own names only, so that a file named
   * `x.constructor` names no type (#200).
   */
  private target(url: string): { path: string; type: string } | null {
    const path = vaultPath(url, this.vaultUrl);
    if (path === null) return null;
    const dot = path.lastIndexOf(".");
    const extension = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
    const type = Object.hasOwn(COPIED_TYPES, extension) ? COPIED_TYPES[extension] : undefined;
    return type === undefined ? null : { path, type };
  }

  /** The first pass: notes a reference and leaves it as it is. */
  // eslint-disable-next-line @typescript-eslint/require-await -- a Visit returns a promise
  readonly note: Visit = async (url) => {
    const target = this.target(url);
    const size = target === null ? null : this.files.size(target.path);
    if (target !== null && size !== null)
      this.noted.push({ path: target.path, size, rank: copyRank(target.type) });
    return null;
  };

  /** Decides which noted references are copied, within the limits. */
  plan(): void {
    let total = 0;
    // Sorting is stable, so references of one kind keep document order.
    for (const { path, size } of [...this.noted].sort((a, b) => a.rank - b.rank)) {
      if (size > COPY_FILE_LIMIT || total + size > COPY_PAGE_LIMIT) {
        this.leftOutPaths.add(path);
        continue;
      }
      total += size;
      this.allowed.set(path, (this.allowed.get(path) ?? 0) + 1);
    }
  }

  /** The second pass: the `data:` URL for a reference the plan allows, keeping its fragment. */
  readonly copy: Visit = async (url) => {
    const target = this.target(url);
    if (target === null) return null;
    const used = this.used.get(target.path) ?? 0;
    if (used >= (this.allowed.get(target.path) ?? 0)) return null;
    this.used.set(target.path, used + 1);
    let data = this.reads.get(target.path);
    if (data === undefined) {
      data = this.read(target.path, target.type);
      this.reads.set(target.path, data);
    }
    const copied = await data;
    if (copied === null) return null;
    this.copiedPaths.add(target.path);
    const hash = url.indexOf("#");
    return hash === -1 ? copied : copied + url.slice(hash);
  };

  private async read(path: string, type: string): Promise<string | null> {
    let bytes: ArrayBuffer | null;
    try {
      bytes = await this.files.readBinary(path);
    } catch {
      // As when the file went away after the first pass saw it.
      return null;
    }
    return bytes === null ? null : `data:${type};base64,${base64(new Uint8Array(bytes))}`;
  }

  get result(): CopiedFiles {
    return { copied: this.copiedPaths.size, leftOut: this.leftOutPaths.size };
  }
}

/**
 * Visits the references in CSS, given the tokens that name resources
 * (`cssReferences`), putting what `visit` returns in their place.
 */
async function visitCssUrls(
  css: string,
  baseUrl: string,
  visit: Visit,
  references: readonly CssToken[],
): Promise<string> {
  let result = "";
  let cursor = 0;
  for (const match of references) {
    const written = css.slice(match.start, match.end);
    const reference = match.value;
    const absolute =
      reference === "" || reference.startsWith("#") ? null : resolve(reference, baseUrl);
    const replaced = absolute === null ? null : await visit(absolute);
    result +=
      css.slice(cursor, match.start) +
      (replaced === null ? written : referenceText(match, replaced));
    cursor = match.end;
  }
  return result + css.slice(cursor);
}

/** Visits each URL of a `srcset`, keeping its descriptors. */
async function visitSrcset(srcset: string, baseUrl: string, visit: Visit): Promise<string> {
  let result = "";
  let cursor = 0;
  for (const match of srcset.matchAll(SRCSET_URL)) {
    const [whole, comma, space, url] = match;
    const absolute = resolve(url, baseUrl);
    const replaced = absolute === null ? null : await visit(absolute);
    result +=
      srcset.slice(cursor, match.index) +
      (replaced === null ? whole : `${comma}${space}${replaced}`);
    cursor = match.index + whole.length;
  }
  return result + srcset.slice(cursor);
}

/**
 * The references that copying files finds (`cssReferences`) in each text of
 * a `<style>`, which preparing has closed, and of a `style` attribute, read
 * closed (`declarationTokens`), which the first pass keeps for the second.
 */
interface ReferenceScans {
  readonly sheets: Map<string, readonly CssToken[]>;
  readonly declarations: Map<string, readonly CssToken[]>;
}

/**
 * Visits the references to files that a page's images, media, fonts, and
 * scripts load, in document order: their attributes, then `<style>` elements
 * and `style` attributes, which resolve against their own base
 * (`PageRoot.parsedBase`), of the `<style>` elements that apply only. The
 * attributes resolve against the copy's `<base>`: preparing made absolute
 * those that resolve otherwise before a later `<base>` (`prepareReferences`).
 * A reference that `visit` gives a URL for gets it.
 */
async function visitFileReferences(
  { node: root, parsedBase, preferred }: PageRoot,
  baseUrl: string,
  visit: Visit,
  scans: ReferenceScans,
): Promise<void> {
  // Both passes visit the same references, and only those are kept between
  // them: a whole scan holds an object for every few bytes of CSS.
  const urls = (css: string, declarations: boolean): readonly CssToken[] => {
    const kept = declarations ? scans.declarations : scans.sheets;
    let found = kept.get(css);
    if (!found) {
      found = cssReferences(declarations ? declarationTokens(css) : cssTokens(css));
      kept.set(css, found);
    }
    return found;
  };
  for (const [element, names] of COPIED_ATTRIBUTES.elements(root)) {
    for (const name of names) {
      const value = element.getAttribute(name);
      if (value === null) continue;
      const reference = stripSpaces(value);
      if (reference === "") continue;
      if (name === "srcset") {
        const replaced = await visitSrcset(value, baseUrl, visit);
        if (replaced !== value) element.setAttribute(name, replaced);
        continue;
      }
      const absolute = resolve(reference, baseUrl);
      const replaced = absolute === null ? null : await visit(absolute);
      if (replaced !== null) element.setAttribute(name, replaced);
    }
  }
  for (const style of styleElements(root, preferred)) {
    const css = styleText(style);
    const replaced = await visitCssUrls(css, parsedBase(style), visit, urls(css, false));
    if (replaced !== css) setStyleText(style, replaced);
  }
  for (const element of root.querySelectorAll("[style]")) {
    const css = element.getAttribute("style") ?? "";
    const replaced = await visitCssUrls(css, parsedBase(element), visit, urls(css, true));
    if (replaced !== css) element.setAttribute("style", replaced);
  }
}

/**
 * Copies the vault files that a page's images, media, fonts, and scripts
 * refer to into the page as `data:` URLs, for a page with scripts on, which
 * cannot load them otherwise. Other references stay as they are. The roots
 * share the page's limits, in their order: the document, then the content of
 * each template.
 */
async function copyReferencedFiles(
  roots: readonly PageRoot[],
  baseUrl: string,
  files: LocalFiles,
  vaultUrl: string,
): Promise<CopiedFiles> {
  const copier = new FileCopier(files, vaultUrl);
  const scans: ReferenceScans = { sheets: new Map(), declarations: new Map() };
  for (const root of roots) await visitFileReferences(root, baseUrl, copier.note, scans);
  copier.plan();
  for (const root of roots) await visitFileReferences(root, baseUrl, copier.copy, scans);
  return copier.result;
}

export interface PageOptions {
  /** A stylesheet for pages without styles of their own (see reading.ts). */
  readonly readingStyle?: string;
  /**
   * Copies the page's local images, media, fonts, and scripts into it, for a
   * page with scripts on (#11).
   */
  readonly copyFiles?: LocalFiles;
  /**
   * Whether the frame runs scripts: its parser then reads the content of a
   * `<noscript>` as text (`parsePage`).
   */
  readonly scripts?: boolean;
  /**
   * Declares the page's shadow roots open, so that the view's link listeners
   * see the links inside them, and marks where each is declared, so that the
   * split view finds its source lines (`SHADOW_ROOT_MARK`), for a page with
   * scripts off, which has no scripts that could tell the difference.
   */
  readonly openShadowRoots?: boolean;
  /**
   * Makes the page inert until the view, having added its link listeners,
   * removes the attribute from its root, for a page with scripts off. Each
   * document that the frame shows starts from the copy, and the frame loads
   * the copy again whenever Obsidian moves the tab to another tab group or
   * window; until the view finds the new document, an inert page cannot be
   * clicked, focused, or reached with keys. On Chromium 135 to 141 a page's
   * own CSS can override `inert` (#127), so this is a backstop, not the
   * protection: the view watches each new document as soon as it exists.
   */
  readonly inertUntilWatched?: boolean;
}

export interface PreparedPage {
  /** The serialized copy. */
  readonly html: string;
  /** Whether the page has styles of its own, which the reading style leaves alone. */
  readonly ownStyles: boolean;
  /** What copying the page's local files did, when the options asked for it. */
  readonly copiedFiles?: CopiedFiles;
  /**
   * Whether preparing made the copy's root inert, which the view then removes.
   * A page whose root is inert itself stays as it is.
   */
  readonly madeInert: boolean;
}

/**
 * The HTML templates in a document or a template's content, including those
 * in their own content: a shadow root declared inside another one is there.
 */
function templates(root: ParentNode, found: HTMLTemplateElement[] = []): HTMLTemplateElement[] {
  for (const template of root.querySelectorAll("template")) {
    // An SVG or MathML element of that name has no content.
    if (template.namespaceURI !== HTML_NAMESPACE) continue;
    // Added one at a time: a page can hold more templates than a call can
    // take arguments.
    found.push(template);
    templates(template.content, found);
  }
  return found;
}

/**
 * The comment that a copy with open shadow roots has just before each
 * template that declares one. Parsing the copy for the frame attaches the
 * template's content to its host and leaves the template out, so that only
 * the comment shows where among the host's own content the source has the
 * shadow root's tags. A declaration that the host does not attach stays a
 * template, just after its mark. Comments match no selector, and the page has
 * no scripts to see them.
 */
export const SHADOW_ROOT_MARK = "html-page-viewer: shadow root";

/**
 * The names of the attribute that declares a template's content a shadow
 * root. `shadowroot` is the earlier name, which the Chromium in older
 * Obsidian installers still reads and newer ones ignore.
 */
const SHADOW_ROOT_ATTRIBUTES = ["shadowrootmode", "shadowroot"];

/**
 * Whether an element is an HTML template that declares a shadow root, by
 * either name of the attribute, which a host may attach.
 */
export function declaresShadowRoot(element: Element): boolean {
  if (element.localName !== "template" || element.namespaceURI !== HTML_NAMESPACE) return false;
  return SHADOW_ROOT_ATTRIBUTES.some((name) =>
    /^(open|closed)$/i.test(element.getAttribute(name) ?? ""),
  );
}

/**
 * Adds a space to each of the page's own comments that has the text of
 * `SHADOW_ROOT_MARK`, so that only the copy's marks have it. Content without
 * elements, which preparation skips, has no host among whose children a
 * comment could be taken for a mark.
 */
function changeMarkComments(roots: readonly ParentNode[]): void {
  for (const root of roots) {
    const doc = root.ownerDocument ?? (root as Document);
    const comments = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    for (let node = comments.nextNode(); node !== null; node = comments.nextNode()) {
      const comment = node as Comment;
      if (comment.data === SHADOW_ROOT_MARK) comment.data += " ";
    }
  }
}

/**
 * Turns the page's closed declarative shadow roots into open ones, and marks
 * each declaration with `SHADOW_ROOT_MARK`. Parsing the copy for the frame
 * attaches them, while preparing it leaves them as templates.
 */
function openShadowRoots(found: readonly HTMLTemplateElement[]): void {
  for (const template of found) {
    if (!declaresShadowRoot(template)) continue;
    for (const name of SHADOW_ROOT_ATTRIBUTES) {
      if (/^closed$/i.test(template.getAttribute(name) ?? "")) template.setAttribute(name, "open");
    }
    template.before(template.ownerDocument.createComment(SHADOW_ROOT_MARK));
  }
}

/**
 * Keeps the line feed that starts the text of a `<pre>`, `<textarea>`, or
 * `<listing>`, as where an empty line follows its tag. HTML's parser drops one
 * line feed after such a tag, and serializing adds none, so without another
 * one the frame's parse of the copy would drop the text's own (#148).
 */
function keepFirstLineFeeds(root: ParentNode): void {
  for (const element of root.querySelectorAll("pre, textarea, listing")) {
    if (element.namespaceURI !== HTML_NAMESPACE) continue;
    const first = element.firstChild;
    if (first?.nodeType !== Node.TEXT_NODE) continue;
    const text = first as Text;
    if (text.data.startsWith("\n")) text.data = `\n${text.data}`;
  }
}

/**
 * Which of the comments that `parsePage` puts in a page are the only child of
 * an HTML `<noscript>`, by their numbers.
 */
function placedComments(doc: Document, key: string): Set<number> {
  const placed = new Set<number>();
  for (const root of [doc, ...templates(doc).map(({ content }) => content)]) {
    const comments = (root.ownerDocument ?? doc).createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    for (let node = comments.nextNode(); node !== null; node = comments.nextNode()) {
      const { data, parentElement: parent } = node as Comment;
      if (
        data.startsWith(`${key} `) &&
        parent?.localName === "noscript" &&
        parent.namespaceURI === HTML_NAMESPACE &&
        parent.childNodes.length === 1
      )
        placed.add(Number(data.slice(key.length + 1)));
    }
  }
  return placed;
}

/**
 * A page's tree as its frame builds it, with what puts back the text that the
 * tree leaves out. `DOMParser` parses with scripting disabled, as a frame with
 * scripts off does: a `<noscript>` holds elements, and one in a `<head>` ends
 * at the first that it may not hold. A frame with scripts on reads its content
 * as text, which loads and applies nothing (#148). So for such a frame, a
 * comment stands for each content while the page is parsed, prepared, and
 * serialized, and `restore` puts the source's text in its place in the copy.
 *
 * The contents are found in the source (`noscriptContents`), before the page's
 * tree is known. A comment that is then not the only child of an HTML
 * `<noscript>`, as in SVG, where one is an element like any other, stands for
 * markup that the frame reads as such. So the page is parsed again with that
 * content as written, and, if another comment is misplaced then, with all of
 * them, so that a page is parsed at most three times. A `<noscript>` inside
 * content that is put back so, or that the source does not show as one, as in
 * an SVG `<title>`, is prepared as with scripts off.
 */
function parsePage(
  html: string,
  scripts: boolean,
): { doc: Document; restore: (copy: string) => string } {
  const parse = (text: string) => new DOMParser().parseFromString(text, "text/html");
  // Random, so that nothing else in the copy can hold a comment like these.
  const key = window.crypto.randomUUID();
  let contents = scripts ? noscriptContents(html) : [];
  for (let attempt = 0; contents.length > 0; attempt++) {
    let text = "";
    let cursor = 0;
    for (const [index, { start, end }] of contents.entries()) {
      text += `${html.slice(cursor, start)}<!--${key} ${index}-->`;
      cursor = end;
    }
    const doc = parse(text + html.slice(cursor));
    const placed = placedComments(doc, key);
    if (placed.size === contents.length) {
      const taken = contents;
      const comment = new RegExp(`<!--${key} (\\d+)-->`, "g");
      const restore = (copy: string) =>
        copy.replace(comment, (_, index: string) => {
          const { start, end } = taken[Number(index)];
          return html.slice(start, end);
        });
      return { doc, restore };
    }
    contents = attempt === 0 ? contents.filter((_, index) => placed.has(index)) : [];
  }
  return { doc: parse(html), restore: (copy) => copy };
}

/**
 * Whether a page has a stylesheet of its own that Chromium applies: a <style>
 * or a stylesheet link, as preparation finds them, of the stylesheet set that
 * applies (`preferredSet`). A page whose only ones do not apply shows as it
 * would without them.
 */
function hasOwnStyles(doc: Document, preferred: string | null): boolean {
  return styleElements(doc, preferred).length > 0 || stylesheetLinks(doc, preferred).length > 0;
}

/**
 * A part of the page that is prepared as a whole: the document, or the
 * content of a template, with what decides how its stylesheets apply.
 */
interface PageRoot {
  readonly node: ParentNode;
  /**
   * The base URL that each of its elements resolves what it names against as
   * it is parsed (`parsedBases`).
   */
  readonly parsedBase: (element: Element) => string;
  /**
   * The document's preferred stylesheet set (`preferredSet`), or `EVERY_SET`
   * for a template's content, where titles do not decide which stylesheets
   * apply (`inStylesheetSet`).
   */
  readonly preferred: StylesheetSet;
}

/** Prepares the copy of a page that the rendered view shows. */
export async function preparePage(
  html: string,
  context: PageContext,
  options: PageOptions = {},
): Promise<PreparedPage> {
  const { doc, restore } = parsePage(html, options.scripts === true);

  // The page's base URL, which the copy's <base> gives every reference that
  // resolves once the page is parsed. The page's own <base>, if any, is
  // resolved against the file's location, as a browser opening the file
  // would.
  const base = documentBase(doc, context.pageUrl);
  const baseUrl = base.url;

  // A template's content is outside the document's tree, and the shadow roots
  // that a page declares come from templates, so each template's content is
  // prepared as the document is. Their references resolve against the
  // document's base, as the frame resolves them. Content without elements has
  // nothing to prepare.
  const found = templates(doc);
  // The stylesheets and resource attributes that Chromium parses before a
  // <base> resolve against the page's address instead.
  const parsedBase = parsedBases(doc, found, base.element, context.pageUrl, baseUrl);
  // Which of the document's titled stylesheets apply, as preparing leaves its
  // titles and the elements that name its set where they are. Nothing above
  // changes the document.
  const preferred = preferredSet(doc, parsedBase);
  const ownStyles = hasOwnStyles(doc, preferred);
  const roots: PageRoot[] = [{ node: doc, parsedBase, preferred }];
  for (const { content } of found)
    if (content.firstElementChild !== null)
      roots.push({ node: content, parsedBase, preferred: EVERY_SET });
  // The roots share the page's stylesheet limits, in their order, as they
  // share its copy limits.
  const budget = new StylesheetBudget(context);
  for (const root of roots) {
    prepareReferences(root.node, root.parsedBase, baseUrl, context);
    addTooltips(root.node, baseUrl, context);
    await inlineStylesheets(root, baseUrl, context, budget);
  }

  // After locating and copying, so that the references are final.
  const copiedFiles = options.copyFiles
    ? await copyReferencedFiles(roots, baseUrl, options.copyFiles, context.vaultUrl)
    : undefined;

  // A refresh would navigate the frame away from the copy, past the policy
  // below, which governs what the page loads but not where it navigates.
  // Chromium acts on one only in the document's tree, not in a shadow root.
  for (const refresh of doc.querySelectorAll("meta[http-equiv]")) {
    if (refresh.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh") refresh.remove();
  }
  for (const { node } of roots) keepFirstLineFeeds(node);
  if (options.openShadowRoots) {
    // A comment's text is in the source as it is, so only a page whose source
    // has the mark's text can have a comment with it.
    if (html.includes(SHADOW_ROOT_MARK)) changeMarkComments(roots.map(({ node }) => node));
    openShadowRoots(found);
  }
  const root = doc.documentElement;
  const madeInert = options.inertUntilWatched === true && !root.hasAttribute("inert");
  if (madeInert) root.setAttribute("inert", "");

  // eslint-disable-next-line obsidianmd/prefer-create-el -- a parsed document, without Obsidian's helpers
  const policy = doc.createElement("meta");
  policy.setAttribute("http-equiv", "Content-Security-Policy");
  policy.setAttribute("content", pagePolicy(context.vaultUrl));
  // eslint-disable-next-line obsidianmd/prefer-create-el -- a parsed document, without Obsidian's helpers
  const copyBase = doc.createElement("base");
  copyBase.setAttribute("href", baseUrl);
  doc.head.prepend(policy, copyBase);

  if (!ownStyles && options.readingStyle !== undefined) {
    // eslint-disable-next-line obsidianmd/prefer-create-el -- a parsed document, without Obsidian's helpers
    const reading = doc.createElement("style");
    reading.id = READING_STYLE_ID;
    reading.textContent = styleElementText(options.readingStyle);
    copyBase.after(reading);
  }

  const doctype = doc.doctype ? `${new XMLSerializer().serializeToString(doc.doctype)}\n` : "";
  return { html: doctype + restore(root.outerHTML), ownStyles, copiedFiles, madeInert };
}
