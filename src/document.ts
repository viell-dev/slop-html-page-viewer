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

import { cssEnd, cssImports, cssTokens, type CssToken } from "./css";
import { READING_STYLE_ID } from "./reading";

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
}

/** The deepest chain of stylesheet imports that is followed. */
const MAX_IMPORT_DEPTH = 8;

/**
 * A page's limits on its vault stylesheets (`StylesheetBudget`): how many
 * links and imports of them preparation follows, and how much of their text,
 * in UTF-16 code units, the copy takes in: a stylesheet's file text when it
 * is followed, and its prepared text, as copied, for each repeat of the page's
 * own link or import of it that gets that text again. The depth limit bounds an
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

/**
 * A stylesheet prepared for the copy, and whether its text has a `}` outside
 * any block, which an `@media` block around it would end early.
 */
interface PreparedSheet {
  readonly text: string;
  readonly strayCloser: boolean;
}

/**
 * The vault stylesheets that a page's copy takes in, within the page's
 * limits, which the document and the content of its templates share, in the
 * order they are prepared. Each file is read once, however often the page
 * links or imports it.
 */
class StylesheetBudget {
  private taken = 0;
  private text = 0;
  /** How often `take` has kept a stylesheet out for the limits. */
  private refused = 0;
  private readonly reads = new Map<string, Promise<string | null>>();
  private readonly kept = new Map<string, PreparedSheet | null>();

  constructor(private readonly context: PageContext) {}

  /**
   * The text of a stylesheet to put in the copy in place of a link or an
   * import of it, or null to leave the link or import as it is: when the
   * page has followed as many links and imports as it may, or the file cannot
   * be read, or its text would take the page past its limit. A smaller one
   * after it can still fit, as with the copy limits. Every call counts, the
   * ones that return null too, and so does a stylesheet whose text the caller
   * then leaves out, so that the count bounds the work, not only the copy. A
   * repeat that `sheet` answers without preparing makes no call.
   */
  async take(path: string): Promise<string | null> {
    if (this.taken >= STYLESHEET_COUNT_LIMIT) {
      this.refused++;
      return null;
    }
    this.taken++;
    let read = this.reads.get(path);
    if (read === undefined) {
      read = readStylesheet(this.context, path);
      this.reads.set(path, read);
    }
    const css = await read;
    if (css === null) return null;
    if (this.text + css.length > STYLESHEET_TEXT_LIMIT) {
      this.refused++;
      return null;
    }
    this.text += css.length;
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
      // `prepare` uses only `take` of the budget, so the same count of
      // refusals means that the limits left its result whole.
      if (this.refused === refused) this.kept.set(url, sheet);
      return sheet;
    }
    const kept = this.kept.get(url) ?? null;
    if (kept === null || this.text + kept.text.length > STYLESHEET_TEXT_LIMIT) return null;
    this.text += kept.text.length;
    return kept;
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

/** Rewrites resource spans, preserving all other source text. */
function rewriteCssUrls(
  css: string,
  replace: (token: string, reference: string) => string,
  tokens: readonly CssToken[] = cssTokens(css),
): string {
  let result = "";
  let cursor = 0;
  for (const token of tokens) {
    if (token.kind !== "url") continue;
    result +=
      css.slice(cursor, token.start) + replace(css.slice(token.start, token.end), token.value);
    cursor = token.end;
  }
  return result + css.slice(cursor);
}

/**
 * A `url()` token made absolute against its stylesheet's URL, or `token`
 * itself when its reference does not resolve.
 */
function absoluteUrl(
  token: string,
  reference: string,
  sheetUrl: string,
  context?: PageContext,
): string {
  // An empty reference or a fragment refers to the document, as in SVG filters.
  if (reference === "" || reference.startsWith("#")) return token;
  const absolute = resolve(reference, sheetUrl);
  if (absolute === null) return token;
  return `url(${cssString((context && locatedUrl(reference, absolute, context)) ?? absolute)})`;
}

/**
 * Makes every `url()` in a stylesheet absolute, against the stylesheet's own
 * URL, with a reference that does not resolve as a path located by name when
 * the context can (`locatedUrl`).
 */
export function absoluteUrls(
  css: string,
  sheetUrl: string,
  context?: PageContext,
  tokens: readonly CssToken[] = cssTokens(css),
): string {
  return rewriteCssUrls(
    css,
    (token, reference) => absoluteUrl(token, reference, sheetUrl, context),
    tokens,
  );
}

/** Replaces only the `url()`s in CSS that `locatedUrl` locates by name. */
function locateCssUrls(
  css: string,
  baseUrl: string,
  context: PageContext,
  tokens: readonly CssToken[] = cssTokens(css),
): string {
  return rewriteCssUrls(
    css,
    (token, reference) => {
      const absolute =
        reference === "" || reference.startsWith("#") ? null : resolve(reference, baseUrl);
      const located = absolute === null ? null : locatedUrl(reference, absolute, context);
      return located === null ? token : `url(${cssString(located)})`;
    },
    tokens,
  );
}

/** Attributes holding a URL of a resource the page loads, by element. */
const RESOURCE_ATTRIBUTES: Record<string, readonly string[]> = {
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  input: ["src"],
  embed: ["src"],
  object: ["data"],
  iframe: ["src"],
  image: ["href", "xlink:href"],
  use: ["href", "xlink:href"],
  script: ["src"],
};

/**
 * A URL in a `srcset`, with the comma and the space before it. A URL itself
 * can contain commas, as a `data:` URL does; a comma that ends it is left for
 * the next URL, which starts after it.
 */
const SRCSET_URL = /(^|,)(\s*)([^\s,][^\s]*?)(?=,?(?:\s|$))/g;

/** Applies `locatedUrl` to each URL of a `srcset`, keeping its descriptors. */
function locateSrcset(srcset: string, baseUrl: string, context: PageContext): string {
  return srcset.replace(SRCSET_URL, (whole, comma: string, space: string, url: string) => {
    const absolute = resolve(url, baseUrl);
    const located = absolute === null ? null : locatedUrl(url, absolute, context);
    return located === null ? whole : `${comma}${space}${located}`;
  });
}

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

/**
 * A link's reference: its `href`, which wins over the legacy `xlink:href`,
 * a reference only on SVG elements. Clicks and tooltips read links alike.
 */
export function linkReference(link: Element): string | null {
  return (
    link.getAttribute("href") ??
    (link.namespaceURI === SVG_NAMESPACE ? link.getAttributeNS(XLINK_NAMESPACE, "href") : null)
  );
}

/**
 * What a link's tooltip shows: the vault path of the file that a click opens
 * (see `openVaultPath` in main.ts), or the address of anything else. A link
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
    const reference = linkReference(link)?.trim();
    if (reference === undefined) continue;
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
 * Points the page's references that do not resolve as paths at the files
 * Obsidian's link resolution finds for them, as the previous fork did. A
 * reference that resolves, or that nothing matches, stays as written.
 */
function locateReferences(root: ParentNode, baseUrl: string, context: PageContext): void {
  if (!context.exists || !context.locate) return;
  for (const element of root.querySelectorAll(Object.keys(RESOURCE_ATTRIBUTES).join(", "))) {
    for (const name of RESOURCE_ATTRIBUTES[element.localName] ?? []) {
      const value = element.getAttribute(name);
      if (value === null || value.trim() === "") continue;
      if (name === "srcset") {
        element.setAttribute(name, locateSrcset(value, baseUrl, context));
        continue;
      }
      const absolute = resolve(value.trim(), baseUrl);
      const located = absolute === null ? null : locatedUrl(value.trim(), absolute, context);
      if (located !== null) element.setAttribute(name, located);
    }
  }
  for (const element of root.querySelectorAll("[style]")) {
    const style = element.getAttribute("style") ?? "";
    const replaced = locateCssUrls(style, baseUrl, context);
    if (replaced !== style) element.setAttribute("style", replaced);
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
function closedSheet(css: string): { text: string; tokens: CssToken[]; strayCloser: boolean } {
  const tokens = cssTokens(css);
  const end = cssEnd(css, tokens);
  if (end.closers === "") return { text: css, tokens, strayCloser: end.strayCloser };
  const text = css + end.closers;
  return { text, tokens: cssTokens(text), strayCloser: end.strayCloser };
}

/**
 * Returns a stylesheet's text, closed at its end (`closedSheet`), with its
 * imports of vault stylesheets replaced by their text, within the limits of a
 * page of its own (`StylesheetBudget`), and every reference made absolute.
 * Imports from elsewhere stay as they are, for the browser to load or refuse,
 * as do those past the limits. The plugin prepares stylesheets only through
 * `preparePage`; the tests and `scripts/css-benchmark.mjs` use this to check
 * and time a stylesheet's preparation without a page around it.
 */
export async function inlineStylesheet(
  css: string,
  sheetUrl: string,
  context: PageContext,
): Promise<string> {
  const budget = new StylesheetBudget(context);
  const { text, tokens } = closedSheet(css);
  return (await inlineImports(text, sheetUrl, context, new Set(), tokens, budget)).text;
}

/**
 * A vault stylesheet that a link or an import names, prepared for the copy and
 * closed at its end (`closedSheet`), or null to leave the link or import as it
 * is. `seen` holds the stylesheets that import it, and is empty for the page's
 * own links and the imports of its own `<style>` elements.
 */
async function fileSheet(
  path: string,
  sheetUrl: string,
  context: PageContext,
  seen: ReadonlySet<string>,
  budget: StylesheetBudget,
): Promise<PreparedSheet | null> {
  const read = await budget.take(path);
  if (read === null) return null;
  const sheet = closedSheet(read);
  const inner = await inlineImports(
    sheet.text,
    sheetUrl,
    context,
    new Set([...seen, path]),
    sheet.tokens,
    budget,
  );
  return { text: inner.text, strayCloser: sheet.strayCloser || inner.strayCloser };
}

/**
 * `inlineStylesheet`'s result, and whether it holds an imported stylesheet's
 * `}` outside any block, put in its text without an `@media` block around it.
 * `seen` holds the stylesheet's own file and those that import it, and is
 * empty for a page's own `<style>`.
 */
async function inlineImports(
  css: string,
  sheetUrl: string,
  context: PageContext,
  seen: ReadonlySet<string>,
  tokens: readonly CssToken[],
  budget: StylesheetBudget,
): Promise<PreparedSheet> {
  let strayCloser = false;
  const replacements: { start: number; end: number; text: string }[] = [];
  for (const match of cssImports(tokens)) {
    const rule = css.slice(match.start, match.end);
    const media = css.slice(match.mediaStart, match.end - 1);
    const reference = match.reference;
    const absolute = resolve(reference, sheetUrl);
    const located = absolute === null ? null : locatedUrl(reference, absolute, context);
    const target = located ?? absolute;
    const path = target === null ? null : vaultPath(target, context.vaultUrl);
    // Trim only CSS whitespace, only at the start. JavaScript's whitespace also
    // covers characters such as U+FEFF that CSS reads as part of a name. Keep
    // the end as written: a newline there ends a bad string, and a space after
    // a backslash keeps it from escaping what follows.
    const conditions = media.replace(/^[\t\n\f\r ]+/, "");
    let text =
      target === null
        ? rule
        : `@import url(${cssString(target)})${conditions ? ` ${conditions}` : ""};`;
    // Only a media query list has a block form to put the imported text in:
    // imports with cascade layers, scopes, or support conditions stay imports.
    const readable =
      path !== null && isStylesheetFile(path) && !seen.has(path) && seen.size < MAX_IMPORT_DEPTH;
    if (target !== null && path !== null && readable && match.conditions !== "other") {
      const prepare = () => fileSheet(path, target, context, seen, budget);
      // An import in a page's own <style> is prepared the same way each time,
      // as a link of the same URL is.
      const sheet = seen.size === 0 ? await budget.sheet(target, prepare) : await prepare();
      if (sheet !== null) {
        if (match.conditions === "none") {
          text = sheet.text;
          strayCloser ||= sheet.strayCloser;
        } else if (!sheet.strayCloser) {
          text = `@media ${conditions} {\n${sheet.text}\n}`;
        }
        // Otherwise a stray "}" would end the @media block early, and the
        // block's own "}" would then take the importing sheet's next rule.
      }
    }
    replacements.push({ start: match.start, end: match.end, text });
  }

  // Imports and URLs share the same scan; never rescan each intervening segment.
  for (const token of tokens) {
    if (token.kind !== "url") continue;
    const text = absoluteUrl(css.slice(token.start, token.end), token.value, sheetUrl, context);
    replacements.push({ start: token.start, end: token.end, text });
  }
  replacements.sort((a, b) => a.start - b.start);
  let result = "";
  let cursor = 0;
  for (const { start, end, text } of replacements) {
    // A URL inside an import rule, as in `@import url(...)`, is part of the
    // rule's replacement already.
    if (start < cursor) continue;
    result += css.slice(cursor, start) + text;
    cursor = end;
  }
  return { text: result + css.slice(cursor), strayCloser };
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
 * The `<style>` elements whose text is a stylesheet that Chromium applies:
 * HTML ones, and SVG ones, which SVG processes as HTML's, of a CSS type
 * (`isCssStyle`). MathML has no `<style>`, so one there is an unknown element,
 * which Chromium applies nothing from. The others stay as the page has them.
 */
function styleElements(root: ParentNode): Element[] {
  return [...root.querySelectorAll("style")].filter(
    (style) =>
      (style.namespaceURI === HTML_NAMESPACE || style.namespaceURI === SVG_NAMESPACE) &&
      isCssStyle(style),
  );
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
 * allows only inline styles there.
 */
function isStylesheetLink(element: Element): element is HTMLLinkElement {
  if (element.namespaceURI !== HTML_NAMESPACE) return false;
  const rel = (element.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
  return (
    rel.includes("stylesheet") &&
    !rel.includes("alternate") &&
    element.hasAttribute("href") &&
    !element.hasAttribute("disabled") &&
    isCssLink(element)
  );
}

/**
 * Replaces a document's or a template content's stylesheet links to `.css`
 * files in the vault with their text, and inlines the imports of its
 * `<style>` elements, as Obsidian's policy allows only inline styles. Only
 * the `<style>` and `<link>` elements that Chromium applies are prepared
 * (`styleElements`, `isStylesheetLink`), each closed at its end as CSS closes
 * it. Links and imports past the page's limits stay as they are.
 */
async function inlineStylesheets(
  root: ParentNode,
  baseUrl: string,
  context: PageContext,
  budget: StylesheetBudget,
): Promise<void> {
  // The <style> elements that links become have their imports inlined
  // already. Preparing them again would take their imports from the page's
  // limits again, with the import depth and cycle checks restarted.
  const originalStyles = styleElements(root);
  for (const link of [...root.querySelectorAll("link")].filter(isStylesheetLink)) {
    const href = link.getAttribute("href") ?? "";
    const resolved = resolve(href, baseUrl);
    const sheetUrl = (resolved && locatedUrl(href, resolved, context)) ?? resolved;
    const path = sheetUrl === null ? null : vaultPath(sheetUrl, context.vaultUrl);
    if (sheetUrl === null || path === null || !isStylesheetFile(path)) continue;
    const sheet = await budget.sheet(sheetUrl, () =>
      fileSheet(path, sheetUrl, context, new Set(), budget),
    );
    if (sheet === null) continue;
    // eslint-disable-next-line obsidianmd/prefer-create-el -- a parsed document, without Obsidian's helpers
    const style = link.ownerDocument.createElement("style");
    for (const name of ["media", "title"]) {
      const value = link.getAttribute(name);
      if (value !== null) style.setAttribute(name, value);
    }
    setStyleText(style, sheet.text);
    link.replaceWith(style);
  }

  for (const style of originalStyles) {
    const own = styleText(style);
    // Closed as a stylesheet file is, so that its last import and URL read as
    // CSS reads them there. The copy keeps the closed text, which the copying
    // of files then reads as well.
    const { text: css, tokens } = closedSheet(own);
    const text = styleElementText(
      cssImports(tokens).length > 0
        ? (await inlineImports(css, baseUrl, context, new Set(), tokens, budget)).text
        : locateCssUrls(css, baseUrl, context, tokens),
    );
    // Escaped before comparing, so that a style whose text needs only the escape is written too.
    if (text !== own) setStyleText(style, text);
  }
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

/** Attributes holding the URL of a file that is copied into a page, by element. */
const COPIED_ATTRIBUTES: Record<string, readonly string[]> = {
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  input: ["src"],
  image: ["href", "xlink:href"],
  script: ["src"],
};

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

  /** The vault path and type of a URL's file, if it is one that is copied. */
  private target(url: string): { path: string; type: string } | null {
    const path = vaultPath(url, this.vaultUrl);
    if (path === null) return null;
    const dot = path.lastIndexOf(".");
    const type = dot === -1 ? undefined : COPIED_TYPES[path.slice(dot + 1).toLowerCase()];
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
 * Visits the `url()`s in CSS, given its URL tokens, putting what `visit`
 * returns in their place.
 */
async function visitCssUrls(
  css: string,
  baseUrl: string,
  visit: Visit,
  urls: readonly CssToken[],
): Promise<string> {
  let result = "";
  let cursor = 0;
  for (const match of urls) {
    const token = css.slice(match.start, match.end);
    const reference = match.value;
    const absolute =
      reference === "" || reference.startsWith("#") ? null : resolve(reference, baseUrl);
    const replaced = absolute === null ? null : await visit(absolute);
    result +=
      css.slice(cursor, match.start) + (replaced === null ? token : `url(${cssString(replaced)})`);
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
 * Visits the references to files that a page's images, media, fonts, and
 * scripts load, in document order: their attributes, then `<style>` elements
 * and `style` attributes. A reference that `visit` gives a URL for gets it.
 */
async function visitFileReferences(
  root: ParentNode,
  baseUrl: string,
  visit: Visit,
  scans: Map<string, readonly CssToken[]>,
): Promise<void> {
  // Both passes visit the same URL tokens, and only those are kept between
  // them: a whole scan holds an object for every few bytes of CSS.
  const urls = (css: string): readonly CssToken[] => {
    let found = scans.get(css);
    if (!found) {
      found = cssTokens(css).filter((token) => token.kind === "url");
      scans.set(css, found);
    }
    return found;
  };
  for (const element of root.querySelectorAll(Object.keys(COPIED_ATTRIBUTES).join(", "))) {
    for (const name of COPIED_ATTRIBUTES[element.localName] ?? []) {
      const value = element.getAttribute(name);
      if (value === null || value.trim() === "") continue;
      if (name === "srcset") {
        const replaced = await visitSrcset(value, baseUrl, visit);
        if (replaced !== value) element.setAttribute(name, replaced);
        continue;
      }
      const absolute = resolve(value.trim(), baseUrl);
      const replaced = absolute === null ? null : await visit(absolute);
      if (replaced !== null) element.setAttribute(name, replaced);
    }
  }
  for (const style of styleElements(root)) {
    const css = styleText(style);
    const replaced = await visitCssUrls(css, baseUrl, visit, urls(css));
    if (replaced !== css) setStyleText(style, replaced);
  }
  for (const element of root.querySelectorAll("[style]")) {
    const css = element.getAttribute("style") ?? "";
    const replaced = await visitCssUrls(css, baseUrl, visit, urls(css));
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
  roots: readonly ParentNode[],
  baseUrl: string,
  files: LocalFiles,
  vaultUrl: string,
): Promise<CopiedFiles> {
  const copier = new FileCopier(files, vaultUrl);
  const scans = new Map<string, readonly CssToken[]>();
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
 * Whether a page has a stylesheet of its own that Chromium applies: a <style>
 * or a stylesheet link, as preparation finds them. A page whose only ones do
 * not apply shows as it would without them.
 */
function hasOwnStyles(doc: Document): boolean {
  return styleElements(doc).length > 0 || [...doc.querySelectorAll("link")].some(isStylesheetLink);
}

/** Prepares the copy of a page that the rendered view shows. */
export async function preparePage(
  html: string,
  context: PageContext,
  options: PageOptions = {},
): Promise<PreparedPage> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const ownStyles = hasOwnStyles(doc);

  // The first <base> with an href sets the base URL. The page's own one, if
  // any, is resolved against the file's location, as a browser opening the
  // file would.
  const pageBase = doc.querySelector("base[href]")?.getAttribute("href") ?? "";
  const baseUrl = resolve(pageBase, context.pageUrl) ?? context.pageUrl;

  // A template's content is outside the document's tree, and the shadow roots
  // that a page declares come from templates, so each template's content is
  // prepared as the document is. Their references resolve against the
  // document's base, as the frame resolves them. Content without elements has
  // nothing to prepare.
  const found = templates(doc);
  const roots: ParentNode[] = [doc];
  for (const { content } of found) if (content.firstElementChild !== null) roots.push(content);
  // The roots share the page's stylesheet limits, in their order, as they
  // share its copy limits.
  const budget = new StylesheetBudget(context);
  for (const root of roots) {
    locateReferences(root, baseUrl, context);
    addTooltips(root, baseUrl, context);
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
  if (options.openShadowRoots) {
    // A comment's text is in the source as it is, so only a page whose source
    // has the mark's text can have a comment with it.
    if (html.includes(SHADOW_ROOT_MARK)) changeMarkComments(roots);
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
  const base = doc.createElement("base");
  base.setAttribute("href", baseUrl);
  doc.head.prepend(policy, base);

  if (!ownStyles && options.readingStyle !== undefined) {
    // eslint-disable-next-line obsidianmd/prefer-create-el -- a parsed document, without Obsidian's helpers
    const reading = doc.createElement("style");
    reading.id = READING_STYLE_ID;
    reading.textContent = styleElementText(options.readingStyle);
    base.after(reading);
  }

  const doctype = doc.doctype ? `${new XMLSerializer().serializeToString(doc.doctype)}\n` : "";
  return { html: doctype + root.outerHTML, ownStyles, copiedFiles, madeInert };
}
