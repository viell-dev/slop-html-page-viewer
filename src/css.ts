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
}

/** A top-level import rule's span, its reference, and where its media list starts. */
export interface CssImport {
  start: number;
  end: number;
  reference: string;
  mediaStart: number;
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
 * leaves it as it is.
 */
function consumeUrl(
  css: string,
  open: number,
): { end: number; kind: "url" | "other"; value: string } | null {
  let i = skipSpace(css, open + 1);
  if (css[i] === '"' || css[i] === "'") {
    const string = stringEnd(css, i);
    i = skipSpace(css, string.end);
    return string.closed && css[i] === ")"
      ? { end: i + 1, kind: "url", value: string.value }
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
  if (css[i] === ")") i++;
  return valid ? { end: i, kind: "url", value } : { end: i, kind: "other", value: "" };
}

/** A forward-only scanner: no recursion or backtracking on page-controlled text. */
export function cssTokens(css: string): CssToken[] {
  const tokens: CssToken[] = [];
  let i = 0;
  while (i < css.length) {
    const start = i;
    let kind: CssToken["kind"] = "other";
    let value = "";
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 2;
      kind = "comment";
    } else if (space(css[i])) {
      i = skipSpace(css, i);
      kind = "space";
    } else if (css[i] === '"' || css[i] === "'") {
      const string = stringEnd(css, i);
      i = string.end;
      if (string.closed || i === css.length) {
        kind = "string";
        value = string.value;
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
      ((css[i] === "#" || css[i] === "@") && (name(css[i + 1] ?? "") || validEscape(css, i + 1)))
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
      }
    } else {
      kind = "delim";
      value = css[i++];
    }
    tokens.push({ start, end: i, kind, value });
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
      if (atRule && token.value === ";") return { start, end: i + 1, ending: ";", strayCloser };
      if (token.value === "}") strayCloser = true;
      if (token.value === "{") block = true;
    }
    nest(blocks, token);
    if (block && blocks.length === 0) return { start, end: i + 1, ending: "block", strayCloser };
  }
  return { start, end: tokens.length, ending: "end", strayCloser };
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
export function cssImports(tokens: readonly CssToken[]): CssImport[] {
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
    if (isKeyword(token.value, "@import")) {
      // Browsers drop a malformed import, so it leaves later imports in place.
      beforeImports = false;
      const found = importRule(tokens, rule);
      if (found !== null) imports.push(found);
    } else if (isKeyword(token.value, "@layer")) {
      if (!beforeImports || rule.ending !== ";") break;
    } else if (
      !isKeyword(token.value, "@charset") &&
      !isKeyword(token.value, "@supports-condition")
    )
      break;
    i = rule.end;
  }
  return imports;
}

/** An import rule that names a string or URL and ends with its `;`, or null. */
function importRule(tokens: readonly CssToken[], rule: TopLevelRule): CssImport | null {
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
    mediaStart: resource.end,
  };
}
