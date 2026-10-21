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

/** Tags that, before a page's first content, belong to its head. */
const HEAD_ONLY = new Set(["html", "head", "title", "meta", "link", "base", "style", "script", "noscript", "template"]);

/**
 * The most places in which the page's elements and the source's tags may
 * differ for them to be aligned exactly; beyond it, they are paired by
 * looking `LOOKAHEAD` tags ahead.
 */
const MAX_DIFFERENCES = 1000;
const LOOKAHEAD = 16;

/** An element's name as the parser gives it for a tag, which reads `image` as `img`. */
function nameKey(name: string): string {
  const lower = name.toLowerCase();
  return lower === "image" ? "img" : lower;
}

/**
 * The pairs of indexes at which two sequences agree, in order, as many as
 * they can have (a longest common subsequence), found by Myers's algorithm in
 * time that grows with their lengths times the places they differ; null if
 * they differ in more than `limit` places.
 */
export function alignSequences(a: readonly string[], b: readonly string[], limit: number): [number, number][] | null {
  const n = a.length;
  const m = b.length;
  const most = Math.min(n + m, limit);
  const offset = most + 1;
  // For each diagonal k = x - y, the furthest x reached so far.
  const furthest = new Int32Array(2 * most + 3);
  // The furthest points before each step, for retracing the path.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= most; d += 1) {
    trace.push(furthest.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && furthest[offset + k - 1] < furthest[offset + k + 1]);
      let x = down ? furthest[offset + k + 1] : furthest[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      furthest[offset + k] = x;
      if (x >= n && y >= m) return retrace(trace, n, m);
    }
  }
  return null;
}

function retrace(trace: readonly Int32Array[], n: number, m: number): [number, number][] {
  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const before = trace[d];
    const at = (k: number): number => before[k + d + 1];
    const k = x - y;
    const previous = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previous);
    const previousY = previousX - previous;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      pairs.push([x, y]);
    }
    x = previousX;
    y = previousY;
  }
  return pairs.reverse();
}

/** Pairs two sequences by looking a few places ahead in the second, for ones too different to align. */
function pairAhead(a: readonly string[], b: readonly string[]): [number, number][] {
  const pairs: [number, number][] = [];
  let next = 0;
  for (const [index, key] of a.entries()) {
    const end = Math.min(b.length, next + LOOKAHEAD);
    for (let other = next; other < end; other += 1) {
      if (b[other] !== key) continue;
      pairs.push([index, other]);
      next = other + 1;
      break;
    }
  }
  return pairs;
}

/**
 * Pairs the elements of a page's body, in document order, with the start tags
 * of the source after its body's, in source order, by aligning their names:
 * the parser adds elements that the source has no tags for, such as `tbody`
 * and the copies that misnested formatting makes, and drops tags, so neither
 * sequence is a copy of the other. Only the first element on each line is
 * kept, as a position in the source is a line.
 */
export function anchorElements(body: Element, tags: readonly StartTag[]): Anchor[] {
  // The body's content starts after its tag, or, without one, after the
  // head's.
  let start = tags.findIndex((tag) => tag.name === "body") + 1;
  if (start === 0) {
    start = tags.findIndex((tag) => !HEAD_ONLY.has(tag.name));
    if (start === -1) start = tags.length;
  }
  const content = tags.slice(start);
  const elements: Element[] = [];
  const collect = (parent: ParentNode): void => {
    for (const child of parent.children) {
      elements.push(child);
      // A template's elements are in its content, not among its children;
      // they show nowhere, but their tags are in the source.
      collect(child.localName === "template" ? (child as HTMLTemplateElement).content : child);
    }
  };
  collect(body);

  const elementKeys = elements.map((element) => nameKey(element.localName));
  const tagKeys = content.map((tag) => nameKey(tag.name));
  const pairs = alignSequences(elementKeys, tagKeys, MAX_DIFFERENCES) ?? pairAhead(elementKeys, tagKeys);
  const anchors: Anchor[] = [];
  for (const [element, tag] of pairs) {
    const line = content[tag].line;
    if (anchors.length === 0 || line > anchors[anchors.length - 1].line) anchors.push({ element: elements[element], line });
  }
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
 * The points that pair the source's lines with the page's heights, in order
 * on both sides: of the anchors the page shows, which are in line order, the
 * longest run whose heights come in order too. An element shown out of order,
 * as one positioned far from its place in the source is, drops out on its
 * own, instead of taking the points after it along. The ends of both sides
 * are points as well, so that each side reaches its end with the other.
 */
export function syncPoints(
  anchors: readonly Anchor[],
  topOf: (element: Element) => number | null,
  ends?: { readonly lines: number; readonly height: number },
): Point[] {
  const candidates: Point[] = [];
  for (const { element, line } of anchors) {
    const top = topOf(element);
    if (top !== null) candidates.push({ line, top });
  }
  // The longest subsequence that does not go down, by patience sorting: the
  // last candidate of the best run of each length, and each one's predecessor.
  const tails: number[] = [];
  const previous = new Int32Array(candidates.length).fill(-1);
  for (const [index, { top }] of candidates.entries()) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (candidates[tails[middle]].top <= top) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  }
  const points: Point[] = [];
  for (let index = tails[tails.length - 1] ?? -1; index !== -1; index = previous[index]) points.push(candidates[index]);
  points.reverse();
  if (ends) {
    if (points.length === 0 || points[0].line > 1 || points[0].top > 0) points.unshift({ line: 1, top: 0 });
    const last = points[points.length - 1];
    if (ends.lines >= last.line && ends.height >= last.top) points.push({ line: ends.lines, top: ends.height });
  }
  return points;
}

/** One side of the split view, as its scrolling is followed. */
export interface ScrollSide {
  /** Where the side is scrolled to, from its top. */
  position(): number;
  /** The furthest it can be scrolled to. */
  furthest(): number;
  scrollTo(position: number): void;
}

type SideName = "source" | "page";

/**
 * Keeps two sides scrolling in step: the side that was scrolled leads, at
 * most once for each call of `schedule`, as once per animation frame, and the
 * other follows, to where `follow` maps the leader's position. Moving the
 * other side makes it report a scroll of its own, which is passed over if the
 * side is still where it landed, which a page that snaps can make other than
 * where it was sent. A report that comes from somewhere else is a scroll of
 * the user's, made in the same frame, and the other side follows it.
 */
export class ScrollFollower {
  private leader: SideName | null = null;
  /** Where moving a side put it, until the side reports that scroll. */
  private landed: Record<SideName, number | null> = { source: null, page: null };

  constructor(
    private readonly sides: Record<SideName, ScrollSide>,
    private readonly follow: Record<SideName, (position: number) => number | null>,
    private readonly schedule: (run: () => void) => void,
  ) {}

  /** Tells the follower that a side reported a scroll. */
  scrolled(side: SideName): void {
    const landed = this.landed[side];
    if (landed !== null) {
      this.landed[side] = null;
      if (Math.abs(this.sides[side].position() - landed) <= 1) return;
    }
    const waiting = this.leader !== null;
    this.leader = side;
    if (waiting) return;
    this.schedule(() => {
      const leader = this.leader;
      this.leader = null;
      if (leader !== null) this.move(leader);
    });
  }

  private move(leader: SideName): void {
    const other: SideName = leader === "source" ? "page" : "source";
    const target = this.follow[leader](this.sides[leader].position());
    if (target === null) return;
    const side = this.sides[other];
    const before = side.position();
    const to = Math.round(Math.min(Math.max(0, target), side.furthest()));
    if (Math.abs(to - before) < 1) return;
    side.scrollTo(to);
    const after = side.position();
    if (after !== before) this.landed[other] = after;
  }
}

/**
 * A measurement that is taken again when what it depends on changes size, at
 * most once every `wait` milliseconds, as measuring a long page is slow.
 */
export function remeasured<T>(measure: () => T, size: () => number, now: () => number, wait = 250): () => T {
  let value = measure();
  let lastSize = size();
  let lastTime = now();
  return () => {
    const time = now();
    if (size() !== lastSize && time - lastTime >= wait) {
      lastSize = size();
      lastTime = time;
      value = measure();
    }
    return value;
  };
}