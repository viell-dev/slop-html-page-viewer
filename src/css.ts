// Partial CSS Syntax 3 scanner for resource references and source spans.
// It preserves unrelated text; it does not parse declarations or evaluate CSS.

/**
 * A CSS escape: up to six hexadecimal digits with one whitespace after them,
 * or any other character but a newline, or nothing at the end. A backslash
 * before a newline is not an escape.
 */
const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[\t\n\f\r ])?|([^\n\f\r])|$)/gu;

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
  return text.replace(CSS_ESCAPE, (_, hex?: string, char?: string) => {
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
  kind: "space" | "comment" | "string" | "name" | "url" | "delim" | "at-keyword" | "other";
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
  const value = unescapeCss(css.slice(start + 1, end).replace(/\\(?:\r\n|[\n\r\f])/g, ""));
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

/** Only top-level import rules, with a balanced prelude and a terminating semicolon. */
export function cssImports(tokens: readonly CssToken[]): CssImport[] {
  const imports: CssImport[] = [];
  const blocks: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (blocks.length > 0 || token.kind !== "at-keyword" || !isKeyword(token.value, "@import")) {
      nest(blocks, token);
      continue;
    }
    let j = i + 1;
    while (tokens[j]?.kind === "space" || tokens[j]?.kind === "comment") j++;
    const resource = tokens[j];
    if (!resource || (resource.kind !== "string" && resource.kind !== "url")) continue;
    const prelude: string[] = [];
    for (j++; j < tokens.length; j++) {
      const part = tokens[j];
      if (prelude.length === 0 && part.kind === "delim") {
        // A block makes the rule something else, and a stray "}" its media list invalid.
        if (part.value === "{" || part.value === "}") break;
        if (part.value === ";") {
          imports.push({
            start: token.start,
            end: part.end,
            reference: resource.value,
            mediaStart: resource.end,
          });
          break;
        }
      }
      nest(prelude, part);
    }
    // Never rescan a malformed import prelude for more imports.
    i = j - 1;
  }
  return imports;
}
