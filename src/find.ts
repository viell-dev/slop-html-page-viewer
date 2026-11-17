// Finding text in the viewer (#13): in the source view, and in the rendered
// page while the view can reach it, with scripts off. Matches are shown with
// the CSS Custom Highlight API, which leaves the page and the source view as
// they are; measured in Obsidian 1.5.3 and 1.14.4, it works in Obsidian's
// window and in the page's frame.

/** The highlights for every match and for the current one, which styles.css and `FIND_STYLE` colour. */
export const MATCH_HIGHLIGHT = "html-page-viewer-match";
export const CURRENT_HIGHLIGHT = "html-page-viewer-current";

/** The most matches that are found and highlighted at once. */
export const MAX_MATCHES = 10_000;

/** The colours of the highlights in a page, which has none of Obsidian's styles. */
export const FIND_STYLE_ID = "html-page-viewer-find-style";
export const FIND_STYLE = [
  `::highlight(${MATCH_HIGHLIGHT}) { background-color: rgba(255, 208, 0, 0.4); }`,
  `::highlight(${CURRENT_HIGHLIGHT}) { background-color: rgb(255, 150, 50); color: black; }`,
].join("\n");

/**
 * Elements whose text a page does not show as its text. A video or an audio
 * element never shows its fallback content. A canvas shows its own while
 * scripts are off, which they are whenever find reaches the page.
 */
const UNSHOWN = new Set([
  "script",
  "style",
  "template",
  "textarea",
  "iframe",
  "progress",
  "meter",
  "head",
  "title",
  "video",
  "audio",
]);

/** SVG definitions are laid out but are never painted at their source location. */
const SVG_RESOURCES = new Set(["defs", "symbol", "clipPath", "mask", "pattern", "marker"]);

/**
 * Display types whose contents `content-visibility: hidden` leaves shown,
 * because size containment does not apply to them. As measured in Obsidian
 * 1.5.3 and 1.15.1, Chromium departs from CSS for one: it hides a table
 * cell's contents.
 */
const UNCONTAINED = new Set([
  "contents",
  "inline",
  "ruby",
  "table",
  "inline-table",
  "table-row-group",
  "table-header-group",
  "table-footer-group",
  "table-row",
  "table-column-group",
  "table-column",
  "ruby-base",
  "ruby-text",
  "ruby-base-container",
  "ruby-text-container",
]);

/** Whether this entire subtree is hidden; visibility is checked per text owner below. */
function isHidden(element: Element, style: CSSStyleDeclaration | undefined): boolean {
  if (element.hasAttribute("hidden") || style?.display === "none") return true;
  if (
    style?.contentVisibility === "hidden" &&
    (element.localName === "canvas" || !UNCONTAINED.has(style.display))
  )
    return true;
  // display:contents has no box of its own, but shows its children; opacity has no effect.
  if (style?.display === "contents") return false;
  if (style?.opacity === "0") return true;
  // checkVisibility() catches what computed styles do not show, such as the
  // children of a progress bar, which have no box. It takes no options: the
  // traversal already prunes zero-opacity ancestors, and a descendant can
  // override visibility.
  return element.checkVisibility ? !element.checkVisibility() : false;
}

/** Elements that start a block of their own, so that a match never runs from one into the next. */
const BLOCKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "br",
  "caption",
  "center",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** Text nodes that read as one piece of text, and where each starts in it. */
export interface TextRun {
  readonly nodes: readonly Text[];
  readonly starts: readonly number[];
  readonly text: string;
}

function run(nodes: Text[]): TextRun {
  const starts: number[] = [];
  let text = "";
  for (const node of nodes) {
    starts.push(text.length);
    text += node.data;
  }
  return { nodes, starts, text };
}

function collectText(node: Node, nodes: Text[]): Text[] {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) nodes.push(child as Text);
    else collectText(child, nodes);
  }
  return nodes;
}

/** The text of a source view, one run for each line. */
export function sourceRuns(source: Element): TextRun[] {
  return [...source.querySelectorAll(".html-page-viewer__source-code")].map((code) =>
    run(collectText(code, [])),
  );
}

/** The text a page shows, in runs that end where a block does. */
export function pageRuns(doc: Document): TextRun[] {
  const runs: TextRun[] = [];
  let nodes: Text[] = [];
  const end = (): void => {
    if (nodes.length > 0) runs.push(run(nodes));
    nodes = [];
  };
  const visit = (element: Element): void => {
    const style = doc.defaultView?.getComputedStyle(element);
    if (isHidden(element, style)) return;
    if (
      element.namespaceURI === "http://www.w3.org/2000/svg" &&
      SVG_RESOURCES.has(element.localName)
    )
      return;
    if (element.namespaceURI === "http://www.w3.org/1999/xhtml" && element.localName === "select") {
      // A closed select paints only its chosen label. Its option has no box,
      // so neither checkVisibility nor a text range can describe that paint.
      end();
      const select = element as HTMLSelectElement;
      if (
        !select.multiple &&
        select.size <= 1 &&
        style?.visibility !== "hidden" &&
        style?.visibility !== "collapse"
      ) {
        const option = select.selectedOptions[0];
        if (option && !option.hasAttribute("label")) nodes = collectText(option, []);
      }
      end();
      return;
    }
    const visibility = style?.visibility;
    const textVisible = visibility !== "hidden" && visibility !== "collapse";
    // A closed details element shows only its summary.
    const closed = element.localName === "details" && !element.hasAttribute("open");
    let children: Iterable<Node> = element.childNodes;
    const shadow = element.shadowRoot;
    const slot =
      element.namespaceURI === "http://www.w3.org/1999/xhtml" && element.localName === "slot"
        ? (element as HTMLSlotElement)
        : null;
    const assigned = slot?.assignedNodes();
    // Ranges cannot cross tree roots. Flush at shadow and slot boundaries,
    // and visit the composed content only, never hidden light DOM twice.
    if (shadow) {
      end();
      children = shadow.childNodes;
    } else if (assigned && assigned.length > 0) {
      end();
      children = assigned;
    }
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (
          !closed &&
          textVisible &&
          (element.namespaceURI !== "http://www.w3.org/2000/svg" || element.closest("text"))
        )
          nodes.push(child as Text);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const name = (child as Element).localName;
        if (UNSHOWN.has(name) || (closed && name !== "summary")) continue;
        const block = BLOCKS.has(name);
        if (block) end();
        visit(child as Element);
        if (block) end();
      }
    }
    if (shadow || (assigned && assigned.length > 0)) end();
  };
  if (
    doc.body &&
    !isHidden(doc.documentElement, doc.defaultView?.getComputedStyle(doc.documentElement))
  )
    visit(doc.body);
  end();
  return runs;
}

/** Where a character of a run is: the text node and the offset in it. */
function position(textRun: TextRun, index: number, atEnd: boolean): [Text, number] {
  // The last node that starts at or before the index; at the end of a match,
  // the node that the match's last character is in.
  let low = 0;
  let high = textRun.starts.length - 1;
  const target = atEnd ? index - 1 : index;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (textRun.starts[middle] <= target) low = middle;
    else high = middle - 1;
  }
  return [textRun.nodes[low], index - textRun.starts[low]];
}

/**
 * The places where `query` occurs in the runs, ignoring case, in order, up to
 * `limit`; `more` says whether there were more. A run of whitespace in the
 * query matches any run of whitespace, as a page shows any run as one space.
 */
export function findRanges(
  runs: readonly TextRun[],
  query: string,
  limit = MAX_MATCHES,
): { ranges: Range[]; more: boolean } {
  const ranges: Range[] = [];
  if (query === "") return { ranges, more: false };
  // The characters that a pattern with the u flag lets be escaped, and needs.
  const text = query.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&").replace(/\s+/gu, "[\\s\\u00a0]+");
  const pattern = new RegExp(text, "giu");
  for (const textRun of runs) {
    for (const match of textRun.text.matchAll(pattern)) {
      if (ranges.length === limit) return { ranges, more: true };
      const [startNode, startOffset] = position(textRun, match.index, false);
      const [endNode, endOffset] = position(textRun, match.index + match[0].length, true);
      const range = startNode.ownerDocument.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      ranges.push(range);
    }
  }
  return { ranges, more: false };
}

/** The CSS Custom Highlight API of a window, where it has one. */
interface HighlightApi {
  readonly registry: Map<string, Set<Range>>;
  readonly create: () => Set<Range> & { priority?: number };
}

function highlightApi(win: Window | null): HighlightApi | null {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- without it, Window has neither property
  const scope = win as
    | (Window & {
        Highlight?: new () => Set<Range>;
        CSS?: { highlights?: Map<string, Set<Range>> };
      })
    | null;
  const Highlight = scope?.Highlight;
  const registry = scope?.CSS?.highlights;
  return Highlight && registry ? { registry, create: () => new Highlight() } : null;
}

/**
 * Shows one view's matches in a window's highlights. Views in the same window
 * share the highlights, so each adds and removes only its own ranges.
 */
export class Highlighter {
  private readonly api: HighlightApi | null;
  private matches: Range[] = [];
  private current: Range | null = null;

  constructor(win: Window | null) {
    this.api = highlightApi(win);
  }

  private highlight(name: string, priority: number): Set<Range> | null {
    if (!this.api) return null;
    let highlight = this.api.registry.get(name);
    if (!highlight) {
      const created = this.api.create();
      created.priority = priority;
      this.api.registry.set(name, created);
      highlight = created;
    }
    return highlight;
  }

  /** Moves the current match, leaving the others as they are. */
  setCurrent(current: Range | null): void {
    if (this.current) this.api?.registry.get(CURRENT_HIGHLIGHT)?.delete(this.current);
    if (current) this.highlight(CURRENT_HIGHLIGHT, 1)?.add(current);
    this.current = current;
  }

  show(matches: readonly Range[], current: Range | null): void {
    this.clear();
    const all = this.highlight(MATCH_HIGHLIGHT, 0);
    for (const range of matches) {
      const root = range.startContainer.getRootNode();
      if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        const shadow = root as ShadowRoot;
        if (!shadow.getElementById(FIND_STYLE_ID)) {
          // eslint-disable-next-line obsidianmd/prefer-create-el -- the page's shadow tree lacks Obsidian helpers
          const style = shadow.ownerDocument.createElement("style");
          style.id = FIND_STYLE_ID;
          style.textContent = FIND_STYLE;
          shadow.append(style);
        }
      }
      all?.add(range);
    }
    if (current) this.highlight(CURRENT_HIGHLIGHT, 1)?.add(current);
    this.matches = [...matches];
    this.current = current;
  }

  clear(): void {
    const all = this.api?.registry.get(MATCH_HIGHLIGHT);
    for (const range of this.matches) all?.delete(range);
    if (this.current) this.api?.registry.get(CURRENT_HIGHLIGHT)?.delete(this.current);
    this.matches = [];
    this.current = null;
  }
}
