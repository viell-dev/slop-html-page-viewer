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

import { READING_STYLE_ID } from "./reading";

/** What the view knows about the page and its vault. */
export interface PageContext {
  /** The page's resource URL, without a query. */
  readonly pageUrl: string;
  /** The vault root's resource URL, ending in a slash. */
  readonly vaultUrl: string;
  /** Reads a vault file's text by its vault path, or returns null if there is none. */
  read(path: string): Promise<string | null>;
}

/** The deepest chain of stylesheet imports that is followed. */
const MAX_IMPORT_DEPTH = 8;

/** Removes a URL's query and fragment. */
export function withoutQuery(url: string): string {
  return url.replace(/[?#].*$/, "");
}

/** Returns the vault path of a URL inside the vault, or null for any other URL. */
export function vaultPath(url: string, vaultUrl: string): string | null {
  const plain = withoutQuery(url);
  if (!plain.startsWith(vaultUrl)) return null;
  try {
    const path = decodeURIComponent(plain.slice(vaultUrl.length));
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

function unescapeCss(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6}\s?|[^\n\r\f0-9a-fA-F])/g, (_, escape: string) => {
    const hex = escape.trim();
    return /^[0-9a-fA-F]+$/.test(hex) ? String.fromCodePoint(Number.parseInt(hex, 16)) : escape;
  });
}

const URL_TOKEN = /url\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|((?:[^)"'\s\\]|\\.)*))\s*\)/gi;
const IMPORT_RULE =
  /@import\s+(?:url\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|((?:[^)"'\s\\]|\\.)*))\s*\)|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')\s*([^;]*);/gi;

/** Makes every `url()` in a stylesheet absolute, against the stylesheet's own URL. */
export function absoluteUrls(css: string, sheetUrl: string): string {
  return css.replace(URL_TOKEN, (token: string, double?: string, single?: string, bare?: string) => {
    const reference = unescapeCss(double ?? single ?? bare ?? "");
    // An empty reference or a fragment refers to the document, as in SVG filters.
    if (reference === "" || reference.startsWith("#")) return token;
    const absolute = resolve(reference, sheetUrl);
    return absolute === null ? token : `url(${cssString(absolute)})`;
  });
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
): Promise<string> {
  const imports: { start: number; end: number; text: string }[] = [];
  for (const match of css.matchAll(IMPORT_RULE)) {
    const [rule, a, b, c, d, e, media] = match;
    const reference = unescapeCss(a ?? b ?? c ?? d ?? e ?? "");
    const absolute = resolve(reference, sheetUrl);
    const path = absolute === null ? null : vaultPath(absolute, context.vaultUrl);
    const conditions = media.trim();
    let text = absolute === null ? rule : `@import url(${cssString(absolute)})${conditions ? ` ${conditions}` : ""};`;
    // Cascade layers and support conditions have no plain block form to wrap
    // the imported text in, so such imports stay imports.
    const wrappable = !/\b(layer|supports)\s*\(|^layer\b/i.test(conditions);
    if (absolute !== null && path !== null && wrappable && !seen.has(path) && seen.size < MAX_IMPORT_DEPTH) {
      const imported = await context.read(path);
      if (imported !== null) {
        const inner = await inlineStylesheet(imported, absolute, context, new Set([...seen, path]));
        text = conditions === "" ? inner : `@media ${conditions} {\n${inner}\n}`;
      }
    }
    imports.push({ start: match.index, end: match.index + rule.length, text });
  }

  let result = "";
  let cursor = 0;
  for (const { start, end, text } of imports) {
    result += absoluteUrls(css.slice(cursor, start), sheetUrl) + text;
    cursor = end;
  }
  return result + absoluteUrls(css.slice(cursor), sheetUrl);
}

/**
 * Stylesheet text that is safe inside a <style> element: the copy is
 * serialized and parsed again, and `</style` would end the element there.
 * `<\/style` is the same text to CSS.
 */
export function styleElementText(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

function isStylesheetLink(element: Element): element is HTMLLinkElement {
  const rel = (element.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
  return rel.includes("stylesheet") && !rel.includes("alternate") && element.hasAttribute("href");
}

export interface PageOptions {
  /** A stylesheet for pages without styles of their own (see reading.ts). */
  readonly readingStyle?: string;
}

export interface PreparedPage {
  /** The serialized copy. */
  readonly html: string;
  /** Whether the page has styles of its own, which the reading style leaves alone. */
  readonly ownStyles: boolean;
}

/** Whether a page has a stylesheet of its own: a <style> or a stylesheet link. */
function hasOwnStyles(doc: Document): boolean {
  return doc.querySelector("style") !== null || [...doc.querySelectorAll("link")].some(isStylesheetLink);
}

/** Prepares the copy of a page that the rendered view shows. */
export async function preparePage(html: string, context: PageContext, options: PageOptions = {}): Promise<PreparedPage> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const ownStyles = hasOwnStyles(doc);

  // The first <base> with an href sets the base URL. The page's own one, if
  // any, is resolved against the file's location, as a browser opening the
  // file would.
  const pageBase = doc.querySelector("base[href]")?.getAttribute("href") ?? "";
  const baseUrl = resolve(pageBase, context.pageUrl) ?? context.pageUrl;

  for (const link of [...doc.querySelectorAll("link")].filter(isStylesheetLink)) {
    const sheetUrl = resolve(link.getAttribute("href") ?? "", baseUrl);
    const path = sheetUrl === null ? null : vaultPath(sheetUrl, context.vaultUrl);
    if (sheetUrl === null || path === null) continue;
    const css = await context.read(path);
    if (css === null) continue;
    const style = doc.createElement("style");
    for (const name of ["media", "title"]) {
      const value = link.getAttribute(name);
      if (value !== null) style.setAttribute(name, value);
    }
    style.textContent = styleElementText(await inlineStylesheet(css, sheetUrl, context, new Set([path])));
    link.replaceWith(style);
  }

  for (const style of doc.querySelectorAll("style")) {
    if (/@import/i.test(style.textContent ?? "")) {
      style.textContent = styleElementText(await inlineStylesheet(style.textContent ?? "", baseUrl, context));
    }
  }

  // A refresh would navigate the frame away from the copy, past the policy
  // below, which governs what the page loads but not where it navigates.
  for (const refresh of doc.querySelectorAll("meta[http-equiv]")) {
    if (refresh.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh") refresh.remove();
  }

  const policy = doc.createElement("meta");
  policy.setAttribute("http-equiv", "Content-Security-Policy");
  policy.setAttribute("content", pagePolicy(context.vaultUrl));
  const base = doc.createElement("base");
  base.setAttribute("href", baseUrl);
  doc.head.prepend(policy, base);

  if (!ownStyles && options.readingStyle !== undefined) {
    const reading = doc.createElement("style");
    reading.id = READING_STYLE_ID;
    reading.textContent = styleElementText(options.readingStyle);
    base.after(reading);
  }

  const doctype = doc.doctype ? `${new XMLSerializer().serializeToString(doc.doctype)}\n` : "";
  return { html: doctype + doc.documentElement.outerHTML, ownStyles };
}
