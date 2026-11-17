/** Source spans, so rewriting never serializes unrelated CSS. */
export interface CssToken {
  start: number;
  end: number;
  kind: "space" | "comment" | "string" | "name" | "url" | "other";
  value: string;
}

const space = (c: string): boolean => /[\t\n\f\r ]/.test(c);
const name = (c: string): boolean => /[\w-]/.test(c) || c.charCodeAt(0) >= 0x80;

/** Consumes one escape, including the optional whitespace after hex digits. */
function escapeEnd(css: string, start: number): number {
  let i = start + 1;
  if (/[0-9a-f]/i.test(css[i] ?? "")) {
    const limit = i + 6;
    while (i < limit && /[0-9a-f]/i.test(css[i] ?? "")) i++;
    if (css[i] === "\r" && css[i + 1] === "\n") return i + 2;
    return i + (space(css[i] ?? "") ? 1 : 0);
  }
  return Math.min(css.length, i + (css[i] === "\r" && css[i + 1] === "\n" ? 2 : 1));
}

/** A forward-only scanner: no recursion or backtracking on page-controlled text. */
export function cssTokens(css: string, decode: (value: string) => string): CssToken[] {
  const tokens: CssToken[] = [];
  let i = 0;
  const stringEnd = (start: number): number => {
    const quote = css[start];
    let end = start + 1;
    while (end < css.length) {
      if (css[end] === quote) return end + 1;
      if (/[\n\r\f]/.test(css[end])) return end;
      end = css[end] === "\\" ? escapeEnd(css, end) : end + 1;
    }
    return end;
  };
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
      i = stringEnd(i);
      if (css[i - 1] === css[start] && i > start + 1) {
        kind = "string";
        value = decode(css.slice(start + 1, i - 1).replace(/\\(?:\r\n|[\n\r\f])/g, ""));
      }
    } else if (
      name(css[i]) ||
      css[i] === "\\" ||
      ((css[i] === "#" || css[i] === "@") && (name(css[i + 1] ?? "") || css[i + 1] === "\\"))
    ) {
      const prefix = css[i] === "#" || css[i] === "@" ? css[i++] : "";
      while (i < css.length && (name(css[i]) || css[i] === "\\")) {
        i = css[i] === "\\" ? escapeEnd(css, i) : i + 1;
      }
      kind = "name";
      value = decode(css.slice(start, i));
      if (prefix !== "") kind = "other";
      if (value.toLowerCase() === "url" && css[i] === "(") {
        kind = "other";
        i++;
        while (i < css.length && space(css[i])) i++;
        const content = i;
        let valid = true;
        if (css[i] === '"' || css[i] === "'") {
          i = stringEnd(i);
          valid = i > content + 1 && css[i - 1] === css[content];
          value = decode(css.slice(content + 1, i - 1).replace(/\\(?:\r\n|[\n\r\f])/g, ""));
        } else {
          while (i < css.length && css[i] !== ")" && !space(css[i])) {
            const code = css.charCodeAt(i);
            if (
              /["'(]/.test(css[i]) ||
              code <= 8 ||
              code === 11 ||
              (code >= 14 && code <= 31) ||
              code === 127
            )
              valid = false;
            if (css[i] === "\\" && /[\n\r\f]/.test(css[i + 1] ?? "")) valid = false;
            i = css[i] === "\\" ? escapeEnd(css, i) : i + 1;
          }
          value = decode(css.slice(content, i));
        }
        while (i < css.length && space(css[i])) i++;
        if (css[i] !== ")") valid = false;
        // Bad URLs consume through their closing parenthesis too: syntax in
        // their remnants must never turn into a resource reference.
        while (i < css.length && css[i] !== ")") i = css[i] === "\\" ? escapeEnd(css, i) : i + 1;
        if (css[i] === ")") i++;
        if (valid) kind = "url";
      }
    } else {
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
    if (token.kind === "other" && token.value === "{") depth++;
    if (token.kind === "other" && token.value === "}") depth--;
    if (depth !== 0 || token.value.toLowerCase() !== "@import" || token.kind !== "other") continue;
    let j = i + 1;
    while (tokens[j]?.kind === "space" || tokens[j]?.kind === "comment") j++;
    const resource = tokens[j];
    if (!resource || (resource.kind !== "string" && resource.kind !== "url")) continue;
    let nesting = 0;
    for (j++; j < tokens.length; j++) {
      const part = tokens[j];
      if (part.kind !== "other") continue;
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
        i = j;
        break;
      }
    }
    // Never rescan a malformed import prelude for more imports.
    i = j - 1;
  }
  return imports;
}
