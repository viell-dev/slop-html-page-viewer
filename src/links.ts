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
 * Classifies a link's resolved URL (`link.href`), given the page's and the
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

  if (url.hash !== "" && withoutQuery(url.href) === withoutQuery(pageUrl)) {
    return { kind: "fragment", id: fragmentId(url) };
  }
  const path = vaultPath(url.href, vaultUrl);
  if (path !== null) return { kind: "vault", path };
  if (withoutQuery(url.href) === withoutQuery(vaultUrl)) return { kind: "vault", path: "" };
  // Custom schemes such as Obsidian's app: have opaque origins, so compare the
  // scheme and host: the same ones as the vault's mean a local file.
  const vaultOrigin = new URL(vaultUrl);
  if (url.protocol === vaultOrigin.protocol && url.host === vaultOrigin.host) return { kind: "outside", url: url.href };
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
  /** eference is the link's href as written, for resolving it by name. */
  openVault(path: string, pane: PaneChoice, reference: string): void;
  openExternal(url: string): void;
  refuse(url: string): void;
}

function scrollToFragment(doc: Document, id: string): void {
  // As in browsers: an empty fragment or "top" scrolls to the top.
  const target =
    id === "" || id.toLowerCase() === "top"
      ? doc.documentElement
      : (doc.getElementById(id) ?? doc.getElementsByName(id)[0] ?? null);
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
    const link = start?.closest?.("a[href], area[href]");
    if (!link) return;
    event.preventDefault();
    const target = linkTarget((link as HTMLAnchorElement).href, pageUrl, vaultUrl);
    switch (target.kind) {
      case "fragment":
        scrollToFragment(doc, target.id);
        break;
      case "vault":
        actions.openVault(target.path, paneFor(event, isMacOS), link.getAttribute("href") ?? "");
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
