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

/** Elements whose text a page does not show as its text. */
const UNSHOWN = new Set(["script", "style", "template", "textarea", "select", "head", "title"]);

/**
 * Whether a page hides an element: by the `hidden` attribute, or by its styles,
 * as Chromium's `checkVisibility` reads them. An element whose `display` is
 * `contents` has no box of its own, but shows its children.
 */
function isHidden(element: Element): boolean {
  if (element.hasAttribute("hidden")) return true;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called on its element below
  const check = (element as Element & { checkVisibility?: () => boolean }).checkVisibility;
  if (!check || check.call(element)) return false;
  return element.ownerDocument.defaultView?.getComputedStyle(element).display !== "contents";
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
    // A closed details element shows only its summary.
    const closed = element.localName === "details" && !element.hasAttribute("open");
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!closed) nodes.push(child as Text);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const name = (child as Element).localName;
        if (UNSHOWN.has(name) || (closed && name !== "summary") || isHidden(child as Element))
          continue;
        const block = BLOCKS.has(name);
        if (block) end();
        visit(child as Element);
        if (block) end();
      }
    }
  };
  if (doc.body) visit(doc.body);
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
    for (const range of matches) all?.add(range);
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
