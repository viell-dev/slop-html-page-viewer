// Where a link in the rendered page leads. The view catches clicks on links
// and opens their targets in Obsidian, the browser, or the page itself,
// instead of navigating the frame away from the copy it shows.

import { vaultPath, withoutQuery } from "./document";

export type LinkTarget =
  /** A part of the page itself, by its id or name. */
  | { readonly kind: "fragment"; readonly id: string }
  /** A file or folder in the vault, by its vault path; a folder's ends in a slash. */
  | { readonly kind: "vault"; readonly path: string }
  /** A local file outside the vault, which is never opened. */
  | { readonly kind: "outside"; readonly url: string }
  /** A web page, an email address, or anything the system opens. */
  | { readonly kind: "external"; readonly url: string }
  /** Nothing to open, such as a `javascript:` URL. */
  | { readonly kind: "none" };

function fragmentId(url: URL): string {
  try {
    return decodeURIComponent(url.hash.slice(1));
  } catch {
    return url.hash.slice(1);
  }
}

/**
 * Classifies a link's resolved URL, given the page's and the
 * vault's resource URLs.
 */
export function linkTarget(href: string, pageUrl: string, vaultUrl: string): LinkTarget {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { kind: "none" };
  }
  if (url.protocol === "javascript:") return { kind: "none" };

  if (url.href.includes("#") && withoutQuery(url.href) === withoutQuery(pageUrl)) {
    return { kind: "fragment", id: fragmentId(url) };
  }
  const path = vaultPath(url.href, vaultUrl);
  if (path !== null) return { kind: "vault", path };
  if (withoutQuery(url.href) === withoutQuery(vaultUrl)) return { kind: "vault", path: "" };
  // Custom schemes such as Obsidian's app: have opaque origins, so compare the
  // scheme and host: the same ones as the vault's mean a local file.
  const vaultOrigin = new URL(vaultUrl);
  if (url.protocol === vaultOrigin.protocol && url.host === vaultOrigin.host)
    return { kind: "outside", url: url.href };
  return { kind: "external", url: url.href };
}

/** Where Obsidian opens a link, as for links in notes: a modifier opens a new tab. */
export type PaneChoice = false | "tab" | "split" | "window";

export function paneFor(event: MouseEvent, isMacOS: boolean): PaneChoice {
  if (event.button === 1) return "tab";
  if (!(isMacOS ? event.metaKey : event.ctrlKey)) return false;
  if (event.altKey && event.shiftKey) return "window";
  if (event.altKey) return "split";
  return "tab";
}

/** What following a link does outside the page. */
export interface LinkActions {
  /**
   * Opens the resolved vault `path` in `pane`. `reference` retains the href as
   * written so Obsidian can resolve it by name when the path does not exist.
   */
  openVault(path: string, pane: PaneChoice, reference: string): void;
  openExternal(url: string): void;
  refuse(url: string): void;
}

function scrollToFragment(doc: Document, id: string): void {
  // An empty fragment scrolls to the top; a real target takes precedence over "top".
  const target =
    id === ""
      ? doc.documentElement
      : (doc.getElementById(id) ??
        doc.getElementsByName(id)[0] ??
        (id.toLowerCase() === "top" ? doc.documentElement : null));
  target?.scrollIntoView();
}

/**
 * Follows clicks on the page's links in Obsidian instead of in the frame.
 * Listeners that the view adds run even though the page's own scripts are
 * disabled.
 */
export function watchLinks(
  doc: Document,
  pageUrl: string,
  vaultUrl: string,
  isMacOS: boolean,
  actions: LinkActions,
): void {
  const follow = (event: MouseEvent): void => {
    if (event.type === "auxclick" && event.button !== 1) return;
    // The page's nodes belong to the frame's window, so test by shape.
    const start = event.target as { closest?: (selector: string) => Element | null } | null;
    const link = start?.closest?.("a, area[href]");
    if (!link) return;
    const reference =
      link.getAttribute("href") ??
      (link.namespaceURI === "http://www.w3.org/2000/svg"
        ? link.getAttributeNS("http://www.w3.org/1999/xlink", "href")
        : null);
    if (reference === null) return;
    event.preventDefault();
    let resolved: string;
    try {
      resolved = new URL(reference, doc.baseURI).href;
    } catch {
      return;
    }
    const target = linkTarget(resolved, pageUrl, vaultUrl);
    switch (target.kind) {
      case "fragment":
        scrollToFragment(doc, target.id);
        break;
      case "vault":
        actions.openVault(target.path, paneFor(event, isMacOS), reference);
        break;
      case "external":
        actions.openExternal(target.url);
        break;
      case "outside":
        actions.refuse(target.url);
        break;
      case "none":
        break;
    }
  };
  doc.addEventListener("click", follow, true);
  doc.addEventListener("auxclick", follow, true);
}
