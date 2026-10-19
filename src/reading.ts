// The reading style: a stylesheet for pages without styles of their own, in
// the colors and fonts of Obsidian's current theme. Pages saved in a semantic
// format have no stylesheet by design, and a browser shows them in black serif
// text on white, whatever Obsidian's theme.

/** The theme values the reading style uses, as CSS values. */
export interface Theme {
  readonly dark: boolean;
  readonly background: string;
  readonly text: string;
  readonly muted: string;
  readonly link: string;
  readonly border: string;
  readonly codeBackground: string;
  readonly tableHeader: string;
  readonly quoteBorder: string;
  readonly selection: string;
  readonly font: string;
  readonly monospace: string;
  readonly fontSize: string;
  readonly lineHeight: string;
  readonly lineWidth: string;
}

/** The id of the reading style's element in the page, for updates in place. */
export const READING_STYLE_ID = "html-page-viewer-reading-style";

/**
 * A theme value safe to place in a declaration: it cannot end the declaration
 * or the rule, or the <style> element that holds it.
 */
function declarationValue(value: string): string {
  return value.replace(/[;{}<>\\]/g, "").trim();
}

/** Reads the theme from Obsidian's document. */
export function readTheme(doc: Document): Theme {
  const style = doc.defaultView?.getComputedStyle(doc.body);
  const value = (name: string, fallback: string): string =>
    declarationValue(style?.getPropertyValue(name) ?? "") || fallback;
  const dark = doc.body.classList.contains("theme-dark");
  return {
    dark,
    background: value("--background-primary", dark ? "#1e1e1e" : "#ffffff"),
    text: value("--text-normal", dark ? "#dadada" : "#222222"),
    muted: value("--text-muted", dark ? "#b3b3b3" : "#5c5c5c"),
    link: value("--link-color", value("--text-accent", dark ? "#a68af9" : "#8a5cf5")),
    border: value("--background-modifier-border", dark ? "#363636" : "#e3e3e3"),
    codeBackground: value("--code-background", dark ? "#2a2a2a" : "#f5f5f5"),
    tableHeader: value("--table-header-background", value("--background-secondary", "transparent")),
    quoteBorder: value("--blockquote-border-color", value("--interactive-accent", "#8a5cf5")),
    selection: value("--text-selection", "Highlight"),
    font: value("--font-text", "system-ui, sans-serif"),
    monospace: value("--font-monospace", "ui-monospace, monospace"),
    fontSize: value("--font-text-size", "16px"),
    lineHeight: value("--line-height-normal", "1.5"),
    lineWidth: value("--file-line-width", "700px"),
  };
}

/** The reading style for a theme. */
export function readingStylesheet(theme: Theme): string {
  return `:root {
  color-scheme: ${theme.dark ? "dark" : "light"};
  background: ${theme.background};
  color: ${theme.text};
}
body {
  box-sizing: border-box;
  max-width: calc(${theme.lineWidth} + 4em);
  margin: 0 auto;
  padding: 1.5em 2em 3em;
  font-family: ${theme.font};
  font-size: ${theme.fontSize};
  line-height: ${theme.lineHeight};
  overflow-wrap: break-word;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.6em; }
a { color: ${theme.link}; }
::selection { background: ${theme.selection}; }
img, video { max-width: 100%; height: auto; }
svg, canvas, iframe { max-width: 100%; }
figure { margin: 1.5em 0; }
figcaption { color: ${theme.muted}; font-size: 0.9em; }
table { border-collapse: collapse; margin: 1em 0; }
th, td { border: 1px solid ${theme.border}; padding: 0.35em 0.7em; vertical-align: top; }
th { background: ${theme.tableHeader}; text-align: start; }
code, kbd, samp, pre { font-family: ${theme.monospace}; font-size: 0.9em; }
code, kbd, samp { background: ${theme.codeBackground}; border-radius: 4px; padding: 0.1em 0.3em; }
pre { background: ${theme.codeBackground}; border-radius: 4px; padding: 0.8em 1em; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { margin: 1em 0; padding: 0 0 0 1em; border-inline-start: 3px solid ${theme.quoteBorder}; color: ${theme.muted}; }
hr { border: none; border-top: 1px solid ${theme.border}; margin: 2em 0; }
`;
}
