// The text of the source view and of the split view's source side: a file's
// lines, numbered and highlighted where HTML's tokenizer would see tags,
// comments, and text, and the lines of its start tags, which split.ts pairs
// with the page's elements. The source is the file as it is: the tokens' texts
// together, and the lines shown, joined with newlines, are exactly its text.
// Nothing here parses it into elements, so showing it loads and runs nothing.

/** A start tag in the source: its element's name, lowercased, and its line, from 1. */
export interface StartTag {
  readonly name: string;
  readonly line: number;
}

/**
 * Shows `data` in `parent` as highlighted source with line numbers, and
 * returns the element that scrolls.
 */
export function renderSource(parent: HTMLElement, data: string): HTMLElement {
  const source = parent.createDiv({ cls: "html-page-viewer__source" });
  const pre = source.createEl("pre");
  let lineNumber = 0;
  const startLine = (): HTMLElement => {
    lineNumber += 1;
    const lineEl = pre.createDiv({ cls: "html-page-viewer__source-line" });
    lineEl.createSpan({ cls: "html-page-viewer__line-number", text: String(lineNumber) });
    return lineEl.createSpan({ cls: "html-page-viewer__source-code" });
  };

  // A token can continue over several lines, as a comment or a tag can, and
  // keeps its highlighting on each of them.
  let code = startLine();
  for (const token of tokenizeHtml(data)) {
    token.text.split("\n").forEach((part, index) => {
      if (index > 0) code = startLine();
      if (part === "") return;
      if (token.kind === "text") {
        code.appendText(part);
      } else {
        code.createSpan({ cls: `html-page-viewer__tok-${token.kind}`, text: part });
      }
    });
  }
  return source;
}

type TokenKind = "text" | "comment" | "punctuation" | "tag" | "attr" | "string";

interface Token {
  readonly kind: TokenKind;
  text: string;
}

/** Elements whose contents HTML reads as text up to their end tag. */
const RAW_TEXT_ELEMENTS = new Set([
  "iframe",
  "noembed",
  "noframes",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

/** The same, as a parser with scripting enabled reads them. */
const RAW_TEXT_WITH_SCRIPTING = new Set([...RAW_TEXT_ELEMENTS, "noscript"]);

/** HTML's whitespace, which excludes the other spaces that `\s` matches. */
const HTML_SPACE = /[\t\n\f\r ]/;

/** What ends a tag's name, an attribute's name, and a value without quotes. */
const TAG_NAME_END = /[\t\n\f\r />]/;
const ATTRIBUTE_NAME_END = /[\t\n\f\r />=]/;
const UNQUOTED_VALUE_END = /[\t\n\f\r >]/;

/**
 * Splits HTML into tokens to highlight, where HTML's tokenizer would see tags,
 * comments, and text. The tokens' texts together are exactly `html`. Calls
 * `onRawText` with where the contents of each of the `rawText` elements are.
 */
function tokenizeHtml(
  html: string,
  rawText: ReadonlySet<string> = RAW_TEXT_ELEMENTS,
  onRawText?: (name: string, start: number, end: number) => void,
): Token[] {
  const tokens: Token[] = [];
  const push = (kind: TokenKind, text: string): void => {
    if (text === "") return;
    const last = tokens[tokens.length - 1];
    if (last?.kind === kind) {
      last.text += text;
    } else {
      tokens.push({ kind, text });
    }
  };

  let cursor = 0;
  while (cursor < html.length) {
    const start = nextMarkupStart(html, cursor);
    if (start === -1) {
      push("text", html.slice(cursor));
      break;
    }
    push("text", html.slice(cursor, start));

    if (html.startsWith("<!--", start)) {
      cursor = commentEnd(html, start);
      push("comment", html.slice(start, cursor));
      continue;
    }

    const isEndTag = html[start + 1] === "/";
    const nameStart = start + (isEndTag ? 2 : 1);
    if (!/[A-Za-z]/.test(html[nameStart] ?? "")) {
      // A doctype, or another construct that HTML skips up to the next ">".
      const end = html.indexOf(">", start + 2);
      cursor = end === -1 ? html.length : end + 1;
      push("punctuation", html.slice(start, cursor));
      continue;
    }

    let nameEnd = nameStart;
    while (nameEnd < html.length && !TAG_NAME_END.test(html[nameEnd])) nameEnd += 1;
    push("punctuation", html.slice(start, nameStart));
    push("tag", html.slice(nameStart, nameEnd));
    const end = tokenizeAttributes(html, nameEnd, push);
    if (end === -1) break;
    cursor = end;

    const name = html.slice(nameStart, nameEnd).toLowerCase();
    if (isEndTag) continue;
    if (name === "plaintext") {
      push("text", html.slice(cursor));
      break;
    }
    if (rawText.has(name)) {
      const end = rawTextEnd(html, cursor, name);
      onRawText?.(name, cursor, end);
      push("text", html.slice(cursor, end));
      cursor = end;
    }
  }
  return tokens;
}

/** The start tags of HTML, their names lowercased, with the lines they start on, from 1 (#13). */
export function startTags(html: string): StartTag[] {
  const tags: StartTag[] = [];
  let line = 1;
  let before = "";
  for (const token of tokenizeHtml(html)) {
    // A tag's name follows the punctuation that opens it: `<`, or `</` for an end tag.
    if (token.kind === "tag" && !before.endsWith("</"))
      tags.push({ name: token.text.toLowerCase(), line });
    for (let at = token.text.indexOf("\n"); at !== -1; at = token.text.indexOf("\n", at + 1))
      line += 1;
    before = token.text;
  }
  return tags;
}

/**
 * Where the contents of HTML's `<noscript>` elements are, as a parser with
 * scripting enabled reads them: text, up to the first end tag. The source does
 * not tell where an element stands in the page's tree, so one that HTML reads
 * otherwise, as in SVG, is among them.
 */
export function noscriptContents(html: string): { start: number; end: number }[] {
  const contents: { start: number; end: number }[] = [];
  tokenizeHtml(html, RAW_TEXT_WITH_SCRIPTING, (name, start, end) => {
    if (name === "noscript" && start < end) contents.push({ start, end });
  });
  return contents;
}

/** Where the next tag, comment, or declaration starts: a `<` that HTML reads as markup. */
function nextMarkupStart(html: string, from: number): number {
  let start = html.indexOf("<", from);
  while (start !== -1 && !/[A-Za-z/!?]/.test(html[start + 1] ?? "")) {
    start = html.indexOf("<", start + 1);
  }
  return start;
}

/** The end of the comment that starts at `start`, or of `html` if it has none. */
function commentEnd(html: string, start: number): number {
  const body = start + 4;
  // `<!-->` and `<!--->` are whole comments.
  if (html.startsWith(">", body)) return body + 1;
  if (html.startsWith("->", body)) return body + 2;
  const close = /--!?>/g;
  close.lastIndex = body;
  const match = close.exec(html);
  return match ? match.index + match[0].length : html.length;
}

/**
 * Tokenizes a tag's attributes from `start`, after its name, and returns where
 * the tag ends: after its `>`, which a quoted value can contain, or -1 if the
 * file ends first.
 */
function tokenizeAttributes(
  html: string,
  start: number,
  push: (kind: TokenKind, text: string) => void,
): number {
  let cursor = start;
  while (cursor < html.length) {
    const char = html[cursor];
    if (char === ">") {
      push("punctuation", char);
      return cursor + 1;
    }
    if (char === "/" || HTML_SPACE.test(char)) {
      push("punctuation", char);
      cursor += 1;
      continue;
    }

    // A name runs up to whitespace, "/", ">", or "=", and can start with "=".
    const nameStart = cursor;
    cursor += 1;
    while (cursor < html.length && !ATTRIBUTE_NAME_END.test(html[cursor])) cursor += 1;
    push("attr", html.slice(nameStart, cursor));

    let equals = cursor;
    while (equals < html.length && HTML_SPACE.test(html[equals])) equals += 1;
    if (html[equals] !== "=") continue;

    const separatorStart = cursor;
    cursor = equals + 1;
    while (cursor < html.length && HTML_SPACE.test(html[cursor])) cursor += 1;
    push("punctuation", html.slice(separatorStart, cursor));

    const quote = html[cursor];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, cursor + 1);
      const end = close === -1 ? html.length : close + 1;
      push("string", html.slice(cursor, end));
      cursor = end;
    } else {
      const valueStart = cursor;
      while (cursor < html.length && !UNQUOTED_VALUE_END.test(html[cursor])) cursor += 1;
      push("string", html.slice(valueStart, cursor));
    }
  }
  return -1;
}

/** Where the text of a raw text element such as `script` ends: at its end tag. */
function rawTextEnd(html: string, start: number, name: string): number {
  const endTag = new RegExp(`</${name}[\\t\\n\\f\\r />]`, "gi");
  endTag.lastIndex = start;
  return endTag.exec(html)?.index ?? html.length;
}
