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

import { cssImports, cssTokens, type CssToken } from "./css";
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
 * Returns a stylesheet's text with its imports of vault stylesheets replaced by
 * their text, and every reference made absolute. Imports from elsewhere stay
 * as they are, for the browser to load or refuse.
 */
export async function inlineStylesheet(
  css: string,
  sheetUrl: string,
  context: PageContext,
  seen: ReadonlySet<string> = new Set(),
  tokens: readonly CssToken[] = cssTokens(css),
): Promise<string> {
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
    // Cascade layers and support conditions have no plain block form to wrap
    // the imported text in, so such imports stay imports.
    const wrappable = !/\b(layer|supports)\s*\(|^layer\b/i.test(conditions);
    const readable =
      path !== null && isStylesheetFile(path) && !seen.has(path) && seen.size < MAX_IMPORT_DEPTH;
    if (target !== null && path !== null && readable && wrappable) {
      const imported = await readStylesheet(context, path);
      if (imported !== null) {
        const inner = await inlineStylesheet(imported, target, context, new Set([...seen, path]));
        text = conditions === "" ? inner : `@media ${conditions} {\n${inner}\n}`;
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
  return result + css.slice(cursor);
}

/**
 * Stylesheet text that is safe inside a <style> element: the copy is
 * serialized and parsed again, and `</style` would end the element there.
 * `<\/style` is the same text to CSS.
 */
export function styleElementText(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

/**
 * The `<style>` elements whose text is a stylesheet: HTML ones, and SVG ones,
 * which SVG processes as HTML's. MathML has no `<style>`, so one there is an
 * unknown element, which Chromium applies nothing from.
 */
function styleElements(root: ParentNode): Element[] {
  return [...root.querySelectorAll("style")].filter(
    (style) => style.namespaceURI === HTML_NAMESPACE || style.namespaceURI === SVG_NAMESPACE,
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
 * Whether an element is a stylesheet link. Only HTML has `<link>`: inside SVG
 * or MathML, the HTML parser makes one an element of theirs, which loads
 * nothing. An HTML `<style>` put in its place would be parsed as theirs when
 * the copy is parsed again, with its text read as markup.
 */
function isStylesheetLink(element: Element): element is HTMLLinkElement {
  if (element.namespaceURI !== HTML_NAMESPACE) return false;
  const rel = (element.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
  return rel.includes("stylesheet") && !rel.includes("alternate") && element.hasAttribute("href");
}

/**
 * Replaces a document's or a template content's stylesheet links to `.css`
 * files in the vault with their text, and inlines the imports of its
 * `<style>` elements, as Obsidian's policy allows only inline styles.
 */
async function inlineStylesheets(
  root: ParentNode,
  baseUrl: string,
  context: PageContext,
): Promise<void> {
  // The <style> elements that links become have their imports inlined
  // already. Preparing them again would read the files again, with the import
  // depth and cycle checks restarted.
  const originalStyles = styleElements(root);
  for (const link of [...root.querySelectorAll("link")].filter(isStylesheetLink)) {
    const href = link.getAttribute("href") ?? "";
    const resolved = resolve(href, baseUrl);
    const sheetUrl = (resolved && locatedUrl(href, resolved, context)) ?? resolved;
    const path = sheetUrl === null ? null : vaultPath(sheetUrl, context.vaultUrl);
    if (sheetUrl === null || path === null || !isStylesheetFile(path)) continue;
    const css = await readStylesheet(context, path);
    if (css === null) continue;
    // eslint-disable-next-line obsidianmd/prefer-create-el -- a parsed document, without Obsidian's helpers
    const style = link.ownerDocument.createElement("style");
    for (const name of ["media", "title"]) {
      const value = link.getAttribute(name);
      if (value !== null) style.setAttribute(name, value);
    }
    setStyleText(style, await inlineStylesheet(css, sheetUrl, context, new Set([path])));
    link.replaceWith(style);
  }

  for (const style of originalStyles) {
    const css = styleText(style);
    const tokens = cssTokens(css);
    const text = styleElementText(
      cssImports(tokens).length > 0
        ? await inlineStylesheet(css, baseUrl, context, new Set(), tokens)
        : locateCssUrls(css, baseUrl, context, tokens),
    );
    // Escaped before comparing, so that a style whose text needs only the escape is written too.
    if (text !== css) setStyleText(style, text);
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

/** Whether a page has a stylesheet of its own: a <style> or a stylesheet link. */
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
  for (const root of roots) {
    locateReferences(root, baseUrl, context);
    addTooltips(root, baseUrl, context);
    await inlineStylesheets(root, baseUrl, context);
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
