// Where a link in the rendered page leads. The view catches clicks on links
// and opens their targets in Obsidian, the browser, or the page itself,
// instead of navigating the frame away from the copy it shows.

import { isPageFragment, linkReference, vaultPath, withoutQuery } from "./document";

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

  if (isPageFragment(url, pageUrl)) {
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

function scrollToFragment(doc: Document, id: string, rawId: string): void {
  const indicated = (name: string): Element | undefined | null =>
    doc.getElementById(name) ??
    [...doc.getElementsByName(name)].find((element) => element.localName === "a");
  // Try the literal fragment before decoding, and only named anchors (not form fields).
  const target =
    rawId === ""
      ? doc.documentElement
      : (indicated(rawId) ??
        indicated(id) ??
        (id.toLowerCase() === "top" ? doc.documentElement : null));
  target?.scrollIntoView();
}

/**
 * The reference of the innermost link that an event passed through, or null.
 * The event's path, unlike its target, reaches into the open shadow roots that
 * the event came from: outside a shadow root, the event's target is its host.
 */
function clickedReference(event: Event): string | null {
  for (const node of event.composedPath()) {
    // The page's nodes belong to the frame's window, so test by shape.
    const name = (node as { localName?: unknown }).localName;
    if (name !== "a" && name !== "area") continue;
    const reference = linkReference(node as Element);
    if (reference !== null) return reference;
  }
  return null;
}

/** The part of the Navigation API that `watchLinks` uses. */
interface NavigationEvents {
  addEventListener(type: "navigate", listener: (event: Event) => void): void;
}

/**
 * Follows clicks on the page's links in Obsidian instead of in the frame, and
 * keeps the frame on the page. Listeners that the view adds run even though
 * the page's own scripts are disabled.
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
    const reference = clickedReference(event);
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
        scrollToFragment(doc, target.id, new URL(resolved).hash.slice(1));
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
  // Whatever the listeners above miss, such as a link in a closed shadow root,
  // whose insides no event path shows, must not take the frame away from the
  // copy. The Navigation API's navigate event cancels a navigation before it
  // starts; it is in Chromium 102 and later, and the oldest installer that runs
  // a public Obsidian release the manifest allows (1.5.3) has Chromium 106.
  const navigation = (doc.defaultView as { navigation?: NavigationEvents } | null)?.navigation;
  navigation?.addEventListener("navigate", (event) => event.preventDefault());
}
