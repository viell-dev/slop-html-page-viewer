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
 * at the end, stand for U+FFFD. It never throws, whatever a page holds.
 */
function unescapeCss(value: string): string {
  if (!value.includes("\\")) return value;
  return value.replace(CSS_ESCAPE, (_, hex?: string, char?: string) => {
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

const space = (c: string): boolean => {
  const n = c.charCodeAt(0);
  return n === 32 || n === 9 || n === 10 || n === 12 || n === 13;
};
const newline = (c: string): boolean => c === "\n" || c === "\r" || c === "\f";
const hex = (c: string): boolean => {
  const n = c.charCodeAt(0) | 32;
  return (n >= 48 && n <= 57) || (n >= 97 && n <= 102);
};
const name = (c: string): boolean => {
  const n = c.charCodeAt(0);
  return (
    (n >= 48 && n <= 57) ||
    (n >= 65 && n <= 90) ||
    (n >= 97 && n <= 122) ||
    n === 95 ||
    n === 45 ||
    n >= 128
  );
};
const validEscape = (css: string, i: number): boolean =>
  css[i] === "\\" && !newline(css[i + 1] ?? "");

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
      while (i < css.length && space(css[i])) i++;
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
      if (value.toLowerCase() === "url" && css[i] === "(") {
        const functionEnd = i;
        kind = "other";
        i++;
        while (i < css.length && space(css[i])) i++;
        const content = i;
        let valid = true;
        if (css[i] === '"' || css[i] === "'") {
          const string = stringEnd(css, i);
          i = string.end;
          while (i < css.length && space(css[i])) i++;
          // Quoted url() is a function containing a string, not a URL token.
          // On malformed input resume at '(' so later strings remain strings.
          if (!string.closed || css[i] !== ")") {
            i = functionEnd;
            kind = "name";
          } else {
            i++;
            kind = "url";
            value = string.value;
          }
          tokens.push({ start, end: i, kind, value });
          continue;
        } else {
          while (i < css.length && css[i] !== ")" && !space(css[i])) {
            const code = css.charCodeAt(i);
            if (
              code === 34 ||
              code === 39 ||
              code === 40 ||
              code <= 8 ||
              code === 11 ||
              (code >= 14 && code <= 31) ||
              code === 127
            )
              valid = false;
            if (css[i] === "\\" && newline(css[i + 1] ?? "")) valid = false;
            i = css[i] === "\\" ? escapeEnd(css, i) : i + 1;
          }
          value = unescapeCss(css.slice(content, i));
        }
        while (i < css.length && space(css[i])) i++;
        if (css[i] !== ")") valid = false;
        // Bad URLs consume through their closing parenthesis too: syntax in
        // their remnants must never turn into a resource reference.
        while (i < css.length && css[i] !== ")") i = css[i] === "\\" ? escapeEnd(css, i) : i + 1;
        if (css[i] === ")") i++;
        if (valid) kind = "url";
        else value = "";
      }
    } else {
      kind = "delim";
      value = css[i++];
    }
    tokens.push({ start, end: i, kind, value });
  }
  return tokens;
}

/** Only top-level import rules, with a balanced prelude and a terminating semicolon. */
export function cssImports(
  tokens: readonly CssToken[],
): { start: number; end: number; reference: string; mediaStart: number }[] {
  const imports: { start: number; end: number; reference: string; mediaStart: number }[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "delim" && token.value === "{") depth++;
    if (token.kind === "delim" && token.value === "}") depth = Math.max(0, depth - 1);
    if (depth !== 0 || token.value.toLowerCase() !== "@import" || token.kind !== "at-keyword")
      continue;
    let j = i + 1;
    while (tokens[j]?.kind === "space" || tokens[j]?.kind === "comment") j++;
    const resource = tokens[j];
    if (!resource || (resource.kind !== "string" && resource.kind !== "url")) continue;
    let nesting = 0;
    for (j++; j < tokens.length; j++) {
      const part = tokens[j];
      if (part.kind !== "delim") continue;
      if (part.value === "{" || part.value === "}") break;
      if (part.value === "(" || part.value === "[") nesting++;
      if (part.value === ")" || part.value === "]") nesting--;
      if (part.value === ";" && nesting === 0) {
        imports.push({
          start: token.start,
          end: part.end,
          reference: resource.value,
          mediaStart: resource.end,
        });
        break;
      }
    }
    // Never rescan a malformed import prelude for more imports.
    i = j - 1;
  }
  return imports;
}
