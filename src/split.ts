// The split view (#13): the source and the page side by side. While the view
// can reach the page (scripts off), the two sides scroll in step: each of the
// page's elements is paired with the source line of its start tag, and a
// position between two such elements maps to the lines between theirs.

/** A start tag in the source: its element's name, lowercased, and its line, from 1. */
export interface StartTag {
  readonly name: string;
  readonly line: number;
}

/** An element of the page with the source line of its start tag. */
export interface Anchor {
  readonly element: Element;
  readonly line: number;
}

/** How far ahead in the source an element's start tag is looked for. */
const LOOKAHEAD = 16;

/** Tags that, before a page's first content, belong to its head. */
const HEAD_ONLY = new Set(["html", "head", "title", "meta", "link", "base", "style", "script", "noscript", "template"]);

/**
 * Pairs the elements of a page's body, in document order, with the start tags
 * of the source, in source order. The parser adds elements that the source
 * does not have, such as `tbody`, and drops tags that it does, so an element
 * whose tag is not among the next few is left out, and a tag that no element
 * takes is passed over.
 */
export function anchorElements(body: Element, tags: readonly StartTag[]): Anchor[] {
  const anchors: Anchor[] = [];
  // The body's content starts after its tag, or, without one, after the
  // head's, which would otherwise keep the first elements from their tags.
  const bodyTag = tags.findIndex((tag) => tag.name === "body");
  let next = bodyTag + 1;
  if (bodyTag === -1) {
    next = tags.findIndex((tag) => !HEAD_ONLY.has(tag.name));
    if (next === -1) next = tags.length;
  }
  let lastLine = 0;
  const visit = (element: ParentNode): void => {
    for (const child of element.children) {
      const name = child.localName.toLowerCase();
      const end = Math.min(tags.length, next + LOOKAHEAD);
      for (let index = next; index < end; index += 1) {
        if (tags[index].name !== name) continue;
        // Keep the lines in order, which the scrolling relies on.
        if (tags[index].line >= lastLine) {
          anchors.push({ element: child, line: tags[index].line });
          lastLine = tags[index].line;
        }
        next = index + 1;
        break;
      }
      // A template's elements are in its content, not among its children;
      // they show nowhere, but their tags are in the source.
      visit(child.localName === "template" ? (child as HTMLTemplateElement).content : child);
    }
  };
  visit(body);
  return anchors;
}

/**
 * The index of the last item at or before `value` in a sorted list, by
 * `key`, or -1 if there is none.
 */
function lastAtOrBefore<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let low = 0;
  let high = items.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (key(items[middle]) <= value) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** A source line, as a fraction, paired with a height of the page. */
export interface Point {
  readonly line: number;
  readonly top: number;
}

/**
 * The value on one side for a value on the other, along points sorted by
 * both: between two points, in proportion; before the first and after the
 * last, the first's and the last's.
 */
function along(points: readonly Point[], value: number, from: keyof Point, to: keyof Point): number | null {
  if (points.length === 0) return null;
  const index = lastAtOrBefore(points, value, (point) => point[from]);
  if (index === -1) return points[0][to];
  const a = points[index];
  const b = points[index + 1];
  if (b === undefined || b[from] === a[from]) return a[to];
  const fraction = Math.min(1, Math.max(0, (value - a[from]) / (b[from] - a[from])));
  return a[to] + fraction * (b[to] - a[to]);
}

/** The page's height at the top of a source line, given the anchors' lines and heights. */
export function pageTopForLine(points: readonly Point[], line: number): number | null {
  return along(points, line, "line", "top");
}

/** The source line, as a fraction, at a height of the page. */
export function lineForPageTop(points: readonly Point[], top: number): number | null {
  return along(points, top, "top", "line");
}

/** The source line, as a fraction from 1, at a height of the source view, given each line's top. */
export function lineAtTop(lineTops: readonly number[], top: number): number {
  const index = lastAtOrBefore(lineTops, top, (value) => value);
  if (index === -1) return 1;
  const next = lineTops[index + 1];
  const height = next === undefined ? 0 : next - lineTops[index];
  return index + 1 + (height > 0 ? Math.min(1, (top - lineTops[index]) / height) : 0);
}

/** The height of the source view at a source line, as a fraction from 1. */
export function topOfLine(lineTops: readonly number[], line: number): number {
  if (lineTops.length === 0) return 0;
  const index = Math.min(lineTops.length - 1, Math.max(0, Math.floor(line) - 1));
  const next = lineTops[index + 1];
  const height = next === undefined ? 0 : next - lineTops[index];
  return lineTops[index] + Math.min(1, Math.max(0, line - 1 - index)) * height;
}

/**
 * The points that pair the source's lines with the page's heights: one for
 * each anchor whose line and height both come at or after the previous
 * point's, so that the points are in order on both sides. An element that
 * the page does not show, or shows out of order, is left out.
 */
export function syncPoints(anchors: readonly Anchor[], topOf: (element: Element) => number | null): Point[] {
  const points: Point[] = [];
  for (const { element, line } of anchors) {
    const top = topOf(element);
    if (top === null) continue;
    const last = points[points.length - 1];
    if (last === undefined || (line >= last.line && top >= last.top)) points.push({ line, top });
  }
  return points;
}
