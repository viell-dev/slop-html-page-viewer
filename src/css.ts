// Partial CSS Syntax 3 scanner for resource references and source spans.
// It preserves unrelated text; it does not parse declarations or evaluate CSS.

/**
 * A CSS escape: up to six hexadecimal digits with one whitespace after them,
 * or any other character but a newline, or nothing at the end. A backslash
 * before a newline is not an escape but a line continuation, which only a
 * string holds and which stands for nothing. Matching both in one pass keeps
 * a short hex escape from running on into the text after a continuation.
 */
const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[\t\n\f\r ])?|(\r\n|[\n\f\r])|([^\n\f\r])|$)/gu;

/** U+FFFD, which stands for a character that text cannot hold. */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

/**
 * Decodes the escapes in CSS text as CSS Syntax 3 consumes an escaped code
 * point: a number that is zero, a surrogate, or past U+10FFFF, and an escape
 * at the end, stand for U+FFFD. So does U+0000, which CSS replaces before
 * tokenizing. It never throws, whatever a page holds.
 */
function unescapeCss(value: string): string {
  if (!value.includes("\\") && !value.includes("\0")) return value;
  const text = value.replaceAll("\0", REPLACEMENT_CHARACTER);
  return text.replace(CSS_ESCAPE, (_, hex?: string, continuation?: string, char?: string) => {
    if (continuation !== undefined) return "";
    if (hex === undefined) return char ?? REPLACEMENT_CHARACTER;
    const code = Number.parseInt(hex, 16);
    const valid = code !== 0 && (code < 0xd800 || code > 0xdfff) && code <= 0x10ffff;
    return valid ? String.fromCodePoint(code) : REPLACEMENT_CHARACTER;
  });
}

/** Source spans, so rewriting never serializes unrelated CSS. */
export interface CssToken {
  start: number;
  end: number;
  kind:
    | "space"
    | "comment"
    | "string"
    | "name"
    | "url"
    | "delim"
    | "at-keyword"
    | "cdo"
    | "cdc"
    | "other";
  value: string;
  /**
   * Set on a comment, string, or unquoted URL that the end of the text ended
   * before its closer: CSS keeps such a token as it is.
   */
  open?: true;
}

/**
 * An import's conditions in the order CSS Cascade 5 gives them, each as
 * written: the text that its block form puts in a prelude.
 */
export interface ImportConditions {
  /** Its cascade layer: null for none, "" for an anonymous one, or the layer's name. */
  layer: string | null;
  /** The text inside its `supports()`, or null for none. */
  supports: string | null;
  /** Its media query list, from its first token to the `;`, or null for none. */
  media: string | null;
}

/** A top-level import rule's span, its reference, and what follows the reference. */
export interface CssImport {
  start: number;
  end: number;
  reference: string;
  /** Where the import's conditions start, just after its reference. */
  conditionsStart: number;
  /**
   * The import's conditions, or null for conditions that have no block form:
   * a scope (CSS Cascade 6), a layer name that is not one, empty support
   * conditions, or a media query list that `@media` cannot take as it is.
   */
  conditions: ImportConditions | null;
}

/** What CSS closes at the end of a stylesheet, which ends each one on its own. */
export interface CssEnd {
  /**
   * The text that closes what the stylesheet leaves open at its end: a
   * comment, a string, an unquoted URL, an escape, blocks, and a rule that has
   * not ended. Text put after the stylesheet's own then reads as it would in a
   * stylesheet of its own.
   */
  closers: string;
  /**
   * Whether the stylesheet has a `}` outside any block. At the top level of a
   * stylesheet, CSS makes it part of a rule's prelude, but inside a block,
   * such as `@media`, it would end that block.
   */
  strayCloser: boolean;
  /**
   * The `<!--` and `-->` between its top-level rules, which CSS discards
   * there. Inside a block, they are tokens like any other, which start a rule.
   */
  markers: CssToken[];
}

const space = (c: string): boolean => {
  const n = c.charCodeAt(0);
  return n === 32 || n === 9 || n === 10 || n === 12 || n === 13;
};
const newline = (c: string): boolean => c === "\n" || c === "\r" || c === "\f";
/** Exactly 0-9, A-F, and a-f: any other character after a backslash is escaped alone. */
const hex = (c: string): boolean => {
  const n = c.charCodeAt(0);
  return (n >= 48 && n <= 57) || (n >= 65 && n <= 70) || (n >= 97 && n <= 102);
};
/**
 * Identifier characters. U+0000 counts, as the U+FFFD that CSS reads it as.
 * Every non-ASCII character counts: a tokenizer that counted fewer could only
 * find more `url(` and `@import` tokens, which this scanner then leaves alone.
 */
const name = (c: string): boolean => {
  const n = c.charCodeAt(0);
  return (
    (n >= 48 && n <= 57) ||
    (n >= 65 && n <= 90) ||
    (n >= 97 && n <= 122) ||
    n === 95 ||
    n === 45 ||
    n === 0 ||
    n >= 128
  );
};
/** Quotes, `(`, and non-printable characters but U+0000 make an unquoted URL bad. */
const badUrlCode = (n: number): boolean =>
  n === 34 ||
  n === 39 ||
  n === 40 ||
  (n >= 1 && n <= 8) ||
  n === 11 ||
  (n >= 14 && n <= 31) ||
  n === 127;
const validEscape = (css: string, i: number): boolean =>
  css[i] === "\\" && !newline(css[i + 1] ?? "");
/**
 * Whether an identifier starts at `i`, as CSS checks before it reads "@" as
 * the start of an at-keyword: "@1" and "@-1" are a delimiter and a number,
 * which start a qualified rule, not an at-rule.
 */
const identifierStart = (css: string, i: number): boolean => {
  const start = (c: string): boolean => name(c) && c !== "-" && !(c >= "0" && c <= "9");
  if (css[i] === "-")
    return start(css[i + 1] ?? "") || css[i + 1] === "-" || validEscape(css, i + 1);
  return start(css[i] ?? "") || validEscape(css, i);
};

/**
 * Whether `text` is `keyword`, given in lowercase, compared ASCII
 * case-insensitively as CSS compares names; `toLowerCase` would also fold
 * U+212A KELVIN SIGN into `k`.
 */
function isKeyword(text: string, keyword: string): boolean {
  if (text.length !== keyword.length) return false;
  for (let i = 0; i < text.length; i++) {
    const n = text.charCodeAt(i);
    if ((n >= 65 && n <= 90 ? n + 32 : n) !== keyword.charCodeAt(i)) return false;
  }
  return true;
}

function skipSpace(css: string, i: number): number {
  while (i < css.length && space(css[i])) i++;
  return i;
}

/** Consumes a string, distinguishing closing quotes, EOF, and bad-string newlines. */
function stringEnd(css: string, start: number): { end: number; closed: boolean; value: string } {
  let end = start + 1;
  while (end < css.length && css[end] !== css[start] && !newline(css[end])) {
    end = css[end] === "\\" ? escapeEnd(css, end) : end + 1;
  }
  const closed = css[end] === css[start];
  const value = unescapeCss(css.slice(start + 1, end));
  return { end: end + (closed ? 1 : 0), closed, value };
}

/** Consumes one escape, including the optional whitespace after hex digits. */
function escapeEnd(css: string, start: number): number {
  let i = start + 1;
  if (hex(css[i] ?? "")) {
    const limit = i + 6;
    while (i < limit && hex(css[i] ?? "")) i++;
    if (css[i] === "\r" && css[i + 1] === "\n") return i + 2;
    return i + (space(css[i] ?? "") ? 1 : 0);
  }
  return Math.min(css.length, i + (css[i] === "\r" && css[i + 1] === "\n" ? 2 : 1));
}

/**
 * Consumes `url(` from its `(` at `open`, returning where the URL ends, or
 * null when scanning should resume at `(`.
 *
 * Quoted contents make a function that holds a string, not a URL token: it is
 * taken as a URL only when the string closes and `)` follows. Otherwise the
 * function is malformed, and resuming at `(` keeps later strings strings.
 * Unquoted contents make a URL token, or a bad URL, which runs through its
 * closing parenthesis: syntax in its remnants must never turn into a resource
 * reference. An unquoted URL left open at the end is taken as bad too, which
 * leaves it as it is, and marked open.
 */
function consumeUrl(
  css: string,
  open: number,
): { end: number; kind: "url" | "other"; value: string; open: boolean } | null {
  let i = skipSpace(css, open + 1);
  if (css[i] === '"' || css[i] === "'") {
    const string = stringEnd(css, i);
    i = skipSpace(css, string.end);
    return string.closed && css[i] === ")"
      ? { end: i + 1, kind: "url", value: string.value, open: false }
      : null;
  }
  const content = i;
  let valid = true;
  while (i < css.length && css[i] !== ")" && !space(css[i])) {
    if (badUrlCode(css.charCodeAt(i)) || (css[i] === "\\" && newline(css[i + 1] ?? "")))
      valid = false;
    i = css[i] === "\\" ? escapeEnd(css, i) : i + 1;
  }
  const value = unescapeCss(css.slice(content, i));
  i = skipSpace(css, i);
  if (css[i] !== ")") valid = false;
  while (i < css.length && css[i] !== ")") i = css[i] === "\\" ? escapeEnd(css, i) : i + 1;
  const closed = css[i] === ")";
  if (closed) i++;
  return valid
    ? { end: i, kind: "url", value, open: false }
    : { end: i, kind: "other", value: "", open: !closed };
}

/** A forward-only scanner: no recursion or backtracking on page-controlled text. */
export function cssTokens(css: string): CssToken[] {
  const tokens: CssToken[] = [];
  let i = 0;
  while (i < css.length) {
    const start = i;
    let kind: CssToken["kind"] = "other";
    let value = "";
    let open = false;
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 2;
      kind = "comment";
      open = end < 0;
    } else if (space(css[i])) {
      i = skipSpace(css, i);
      kind = "space";
    } else if (css[i] === '"' || css[i] === "'") {
      const string = stringEnd(css, i);
      i = string.end;
      if (string.closed || i === css.length) {
        kind = "string";
        value = string.value;
        open = !string.closed;
      }
    } else if (css.startsWith("<!--", i)) {
      i += 4;
      kind = "cdo";
    } else if (css.startsWith("-->", i)) {
      // Before names: CSS reads "-->" as one token where a token starts.
      i += 3;
      kind = "cdc";
    } else if (
      name(css[i]) ||
      validEscape(css, i) ||
      (css[i] === "#" && (name(css[i + 1] ?? "") || validEscape(css, i + 1))) ||
      (css[i] === "@" && identifierStart(css, i + 1))
    ) {
      const prefix = css[i] === "#" || css[i] === "@" ? css[i++] : "";
      while (i < css.length && (name(css[i]) || validEscape(css, i))) {
        i = css[i] === "\\" ? escapeEnd(css, i) : i + 1;
      }
      kind = prefix === "" ? "name" : prefix === "@" ? "at-keyword" : "other";
      value = unescapeCss(css.slice(start, i));
      const url =
        kind === "name" && css[i] === "(" && isKeyword(value, "url") ? consumeUrl(css, i) : null;
      if (url !== null) {
        i = url.end;
        kind = url.kind;
        value = url.value;
        open = url.open;
      }
    } else {
      kind = "delim";
      value = css[i++];
    }
    tokens.push(open ? { start, end: i, kind, value, open: true } : { start, end: i, kind, value });
  }
  return tokens;
}

/** The closing delimiter of each block that CSS nests. */
const CLOSERS = new Map([
  ["{", "}"],
  ["(", ")"],
  ["[", "]"],
]);

/**
 * Follows the blocks that a token opens or closes, as CSS consumes them: a
 * closer that does not match the innermost open block is part of its contents.
 */
function nest(blocks: string[], token: CssToken): void {
  if (token.kind !== "delim") return;
  const closer = CLOSERS.get(token.value);
  if (closer !== undefined) blocks.push(closer);
  else if (token.value === blocks.at(-1)) blocks.pop();
}

/** Tokens that CSS discards between rules at a stylesheet's top level. */
const betweenRules = (token: CssToken): boolean =>
  token.kind === "space" ||
  token.kind === "comment" ||
  token.kind === "cdo" ||
  token.kind === "cdc";

/** A top-level rule, from the token that starts it to the token after its end. */
interface TopLevelRule {
  start: number;
  end: number;
  /** Whether its `;` or its block ended it, or the end of the text did. */
  ending: ";" | "block" | "end";
  /** The closers of the blocks still open at the end of the text. */
  blocks: string[];
  /** Whether its own `{}` block had started. */
  block: boolean;
  /** Whether its prelude has a `}` outside any block. */
  strayCloser: boolean;
}

/**
 * Follows a top-level rule as CSS Syntax 3 consumes a stylesheet's contents:
 * an at-keyword starts an at-rule, which its `;` or its block ends, and any
 * other token a qualified rule, which its block ends. A `}` outside any block
 * is part of the prelude there.
 */
function topLevelRule(tokens: readonly CssToken[], start: number): TopLevelRule {
  const atRule = tokens[start].kind === "at-keyword";
  const blocks: string[] = [];
  let block = false;
  let strayCloser = false;
  for (let i = atRule ? start + 1 : start; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "delim") continue;
    if (blocks.length === 0) {
      if (atRule && token.value === ";")
        return { start, end: i + 1, ending: ";", blocks, block, strayCloser };
      if (token.value === "}") strayCloser = true;
      if (token.value === "{") block = true;
    }
    nest(blocks, token);
    if (block && blocks.length === 0)
      return { start, end: i + 1, ending: "block", blocks, block, strayCloser };
  }
  return { start, end: tokens.length, ending: "end", blocks, block, strayCloser };
}

const blank = (token: CssToken | undefined): boolean =>
  token?.kind === "space" || token?.kind === "comment";

/** The index of the first token from `i` on, before `to`, that is not a space or a comment. */
function skipBlank(tokens: readonly CssToken[], i: number, to: number): number {
  while (i < to && blank(tokens[i])) i++;
  return i;
}

/** Whether the token at `i` is `name(`, a function of that name: no space or comment before `(`. */
function isFunction(tokens: readonly CssToken[], i: number, name: string): boolean {
  const token = tokens[i];
  const next = tokens[i + 1];
  return (
    token?.kind === "name" &&
    isKeyword(token.value, name) &&
    next?.kind === "delim" &&
    next.value === "("
  );
}

/** The index of the `)` that closes the `(` at `open`, before `to`, or -1. */
function closingParenthesis(tokens: readonly CssToken[], open: number, to: number): number {
  const blocks: string[] = [];
  for (let i = open; i < to; i++) {
    nest(blocks, tokens[i]);
    if (blocks.length === 0) return i;
  }
  return -1;
}

/** The index of the first token from `i` on that is not a comment. */
function skipComments(tokens: readonly CssToken[], i: number): number {
  while (tokens[i]?.kind === "comment") i++;
  return i;
}

/**
 * The layer name between the parentheses of `layer()`, its identifiers as
 * written, joined by `.`, or null when it is not one. Chromium 114 and 150
 * read identifiers joined by `.`, with comments but no spaces between them,
 * and spaces or comments around the whole: with a comment beside its dot,
 * `a.b` is still `a.b`. With a space beside a dot, a dot at the end, a number,
 * or a comma, they read
 * `layer()` as part of the media query list, which then never matches. The
 * comments are left out, so that the name reads the same in a block's prelude.
 */
function layerName(css: string, tokens: readonly CssToken[], from: number, to: number) {
  const ident = (token: CssToken | undefined) =>
    token?.kind === "name" && identifierStart(css, token.start);
  let i = skipBlank(tokens, from, to);
  if (!ident(tokens[i])) return null;
  let name = css.slice(tokens[i].start, tokens[i].end);
  for (;;) {
    const dot = skipComments(tokens, i + 1);
    if (tokens[dot]?.kind !== "delim" || tokens[dot].value !== ".") break;
    const next = skipComments(tokens, dot + 1);
    if (!ident(tokens[next])) return null;
    name += `.${css.slice(tokens[next].start, tokens[next].end)}`;
    i = next;
  }
  return skipBlank(tokens, i + 1, to) === to ? name : null;
}

/**
 * Whether an import's media query list is one that `@media` takes as it is:
 * it starts with neither `layer` nor `scope`, which CSS Cascade 5 and 6 put
 * before it, and has no function at its top level, such as a second
 * `layer()` or `supports()`, `scope()`, or part of a media query that the
 * plugin does not read, which keeps the import as an import for the browser
 * to decide. Strings and comments name none of them.
 */
function isMediaList(tokens: readonly CssToken[], from: number, to: number): boolean {
  const blocks: string[] = [];
  const first = skipBlank(tokens, from, to);
  const keyword = tokens[first];
  if (
    first < to &&
    keyword.kind === "name" &&
    (isKeyword(keyword.value, "layer") || isKeyword(keyword.value, "scope"))
  )
    return false;
  for (let i = first; i < to; i++) {
    const token = tokens[i];
    if (blank(token)) continue;
    if (token.kind === "name" && blocks.length === 0) {
      const next = tokens[i + 1];
      if (next?.kind === "delim" && next.value === "(") return false;
    }
    nest(blocks, token);
  }
  return true;
}

/**
 * Reads an import's conditions from its tokens after the reference, `from`,
 * to its `;`, `to`, in the order that CSS Cascade 5 gives them and Chromium
 * reads them: a layer, as the `layer` keyword or `layer()`, then
 * `supports()`, then a media query list. Anything else in its place is part
 * of the media query list (`isMediaList`).
 */
function importConditions(
  css: string,
  tokens: readonly CssToken[],
  from: number,
  to: number,
): ImportConditions | null {
  let i = from;
  let next = skipBlank(tokens, i, to);
  let layer: string | null = null;
  if (isFunction(tokens, next, "layer")) {
    const close = closingParenthesis(tokens, next + 1, to);
    layer = close === -1 ? null : layerName(css, tokens, next + 2, close);
    if (layer === null) return null;
    i = close + 1;
  } else if (tokens[next]?.kind === "name" && isKeyword(tokens[next].value, "layer")) {
    layer = "";
    i = next + 1;
  }
  next = skipBlank(tokens, i, to);
  let supports: string | null = null;
  if (isFunction(tokens, next, "supports")) {
    const close = closingParenthesis(tokens, next + 1, to);
    // Empty, they are not any; Chromium 150 drops such an import, as it drops one whose
    // support conditions do not hold, and Chromium 114 never applies it.
    if (close === -1 || skipBlank(tokens, next + 2, close) === close) return null;
    supports = css.slice(tokens[next + 1].end, tokens[close].start);
    i = close + 1;
  }
  if (!isMediaList(tokens, i, to)) return null;
  // As written, apart from the spaces before it: a comment stays.
  while (tokens[i].kind === "space") i++;
  const media =
    skipBlank(tokens, i, to) === to ? null : css.slice(tokens[i].start, tokens[to].start);
  return { layer, supports, media };
}

/**
 * The import rules that CSS applies: only where a top-level rule starts, and
 * only before every rule but `@charset`, `@supports-condition`, other imports,
 * and `@layer` statements before the first import (CSS Cascade 5). Browsers
 * keep importing after a rule that they drop as invalid, but telling which
 * rules are valid would mean evaluating CSS, so every other rule ends the
 * imports here: that can only find fewer of them. Each import found has a
 * string or URL, a balanced prelude, and a terminating semicolon.
 */
export function cssImports(css: string, tokens: readonly CssToken[] = cssTokens(css)): CssImport[] {
  const imports: CssImport[] = [];
  let beforeImports = true;
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i];
    if (betweenRules(token)) {
      i++;
      continue;
    }
    if (token.kind !== "at-keyword") break;
    const rule = topLevelRule(tokens, i);
    const place = importPlace(tokens, rule);
    if (place === "import") {
      // Browsers drop a malformed import, so it leaves later imports in place.
      beforeImports = false;
      const found = importRule(css, tokens, rule);
      if (found !== null) imports.push(found);
    } else if (place === "other" || (place === "layer statement" && !beforeImports)) break;
    i = rule.end;
  }
  return imports;
}

/**
 * Where a top-level rule may stand among a stylesheet's imports, as CSS
 * Cascade 5 orders them: an import; an `@layer` statement, only before the
 * first import; `@charset` and `@supports-condition`, anywhere among them; or
 * any other rule, which ends them.
 */
function importPlace(
  tokens: readonly CssToken[],
  rule: TopLevelRule,
): "import" | "layer statement" | "among imports" | "other" {
  const { kind, value } = tokens[rule.start];
  if (kind !== "at-keyword") return "other";
  if (isKeyword(value, "@import")) return "import";
  if (isKeyword(value, "@layer")) return rule.ending === ";" ? "layer statement" : "other";
  return isKeyword(value, "@charset") || isKeyword(value, "@supports-condition")
    ? "among imports"
    : "other";
}

/** An import rule that names a string or URL and ends with its `;`, or null. */
function importRule(
  css: string,
  tokens: readonly CssToken[],
  rule: TopLevelRule,
): CssImport | null {
  // A stray "}" makes the media list invalid, and would end a block put around it.
  if (rule.ending !== ";" || rule.strayCloser) return null;
  let i = rule.start + 1;
  while (tokens[i]?.kind === "space" || tokens[i]?.kind === "comment") i++;
  const resource = tokens[i];
  if (resource.kind !== "string" && resource.kind !== "url") return null;
  const semicolon = tokens[rule.end - 1];
  return {
    start: tokens[rule.start].start,
    end: semicolon.end,
    reference: resource.value,
    conditionsStart: resource.end,
    conditions: importConditions(css, tokens, i + 1, rule.end - 1),
  };
}

/** The index of the first token that starts at or after `offset`. */
function tokenAt(tokens: readonly CssToken[], offset: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (tokens[middle].start < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Which imports after it a stylesheet's text keeps from counting, from least
 * to most: none, as it holds only what CSS discards between rules (`blank`);
 * none, as it holds only what CSS allows anywhere among imports; those after
 * an import before it, as it also holds `@layer` statements, which CSS allows
 * only before the first import; or all of them, as it holds any other rule.
 */
export type ImportStop = "blank" | "none" | "after-import" | "all";

/**
 * What the text from `from` to `to` keeps later imports from (`ImportStop`),
 * when it is made of whole top-level rules and starts a stylesheet or follows
 * text that imports may follow (`importPlace`).
 */
export function importStop(tokens: readonly CssToken[], from: number, to: number): ImportStop {
  let stop: ImportStop = "blank";
  for (let i = tokenAt(tokens, from); i < tokens.length && tokens[i].start < to;) {
    if (betweenRules(tokens[i])) {
      i++;
      continue;
    }
    if (tokens[i].kind !== "at-keyword") return "all";
    const rule = topLevelRule(tokens, i);
    const place = importPlace(tokens, rule);
    if (place === "other") return "all";
    if (place === "layer statement") stop = "after-import";
    else if (stop === "blank") stop = "none";
    i = rule.end;
  }
  return stop;
}

/**
 * What a stylesheet leaves open at its end, which CSS closes there, whether it
 * has a `}` outside any block, and its markers; see {@link CssEnd}. A `\` at the end
 * stands for U+FFFD, or for nothing in a string, so the closers start with
 * what keeps that meaning and keeps the `\` from escaping them.
 */
export function cssEnd(css: string, tokens: readonly CssToken[]): CssEnd {
  let strayCloser = false;
  let pending: TopLevelRule | null = null;
  const markers: CssToken[] = [];
  for (let i = 0; i < tokens.length;) {
    if (betweenRules(tokens[i])) {
      if (tokens[i].kind === "cdo" || tokens[i].kind === "cdc") markers.push(tokens[i]);
      i++;
      continue;
    }
    const rule = topLevelRule(tokens, i);
    strayCloser ||= rule.strayCloser;
    if (rule.ending === "end") pending = rule;
    i = rule.end;
  }
  const last = tokens.at(-1);
  let backslashes = 0;
  while (css[css.length - 1 - backslashes] === "\\") backslashes++;
  const escape = backslashes % 2 === 1 && last?.kind !== "comment";
  let closers = "";
  if (last?.open && last.kind === "comment") closers = "*/";
  else if (last?.open && last.kind === "string") closers = (escape ? "\n" : "") + css[last.start];
  else if (last?.open) closers = (escape ? REPLACEMENT_CHARACTER : "") + ")";
  else if (escape) closers = REPLACEMENT_CHARACTER;
  if (pending !== null) {
    closers += [...pending.blocks].reverse().join("");
    if (!pending.block) closers += tokens[pending.start].kind === "at-keyword" ? ";" : "{}";
  }
  return { closers, strayCloser, markers };
}
