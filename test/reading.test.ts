import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./support/dom";
import { READING_STYLE_ID, readingStylesheet, readTheme } from "../src/reading";
import { button, frame, Harness, settle } from "./support/harness";

/** Obsidian's document, with a theme set on its body as Obsidian sets it. */
function themedDocument(dark: boolean, variables: Record<string, string>): Document {
  document.body.className = dark ? "theme-dark" : "theme-light";
  document.body.removeAttribute("style");
  for (const [name, value] of Object.entries(variables)) document.body.style.setProperty(name, value);
  return document;
}

function readingStyle(srcdoc: string): string | null {
  return new DOMParser().parseFromString(srcdoc, "text/html").getElementById(READING_STYLE_ID)?.textContent ?? null;
}

describe("readTheme", () => {
  it("reads Obsidian's theme variables", () => {
    const theme = readTheme(
      themedDocument(true, {
        "--background-primary": "rgb(30, 30, 30)",
        "--text-normal": "#dadada",
        "--link-color": "#a68af9",
        "--font-text": "'Inter', sans-serif",
        "--file-line-width": "640px",
      }),
    );
    assert.equal(theme.dark, true);
    assert.equal(theme.background, "rgb(30, 30, 30)");
    assert.equal(theme.text, "#dadada");
    assert.equal(theme.link, "#a68af9");
    assert.equal(theme.font, "'Inter', sans-serif");
    assert.equal(theme.lineWidth, "640px");
  });

  it("falls back to light or dark defaults without a theme", () => {
    assert.equal(readTheme(themedDocument(false, {})).background, "#ffffff");
    assert.equal(readTheme(themedDocument(true, {})).background, "#1e1e1e");
  });

  it("keeps values from ending their declaration, rule, or element", () => {
    const theme = readTheme(themedDocument(false, { "--text-normal": "red; } body { display: none } </style>" }));
    assert.doesNotMatch(theme.text, /[;{}<>]/);
  });
});

describe("readingStylesheet", () => {
  it("styles the page in the theme's colors, fonts, and line width", () => {
    const css = readingStylesheet(
      readTheme(themedDocument(true, { "--background-primary": "#101010", "--text-normal": "#eeeeee" })),
    );
    assert.match(css, /color-scheme: dark;/);
    assert.match(css, /background: #101010;/);
    assert.match(css, /color: #eeeeee;/);
    assert.match(css, /th, td \{ border: 1px solid /);
    assert.match(css, /max-width: calc\(700px \+ 4em\)/);
  });

  it("uses the full width without Readable line length", () => {
    const css = readingStylesheet(readTheme(themedDocument(false, { "--file-line-width": "640px" })), false);
    assert.match(css, /max-width: none;/);
    assert.doesNotMatch(css, /640px/);
  });
});

describe("theme in the view", () => {
  const PLAIN = "<!doctype html><h1>Plain page</h1>";
  const STYLED = "<!doctype html><style>h1 { color: red }</style><h1>Styled page</h1>";

  it("shows pages without styles of their own in Obsidian's theme", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "plain.html", PLAIN);
    await settle();

    assert.ok(readingStyle(frame(view)?.srcdoc ?? ""));
    const toggle = button(view, "Theme ON");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    assert.equal(toggle.disabled, false);
  });

  it("shows the page as a browser would when the theme is turned off", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "plain.html", PLAIN);
    button(view, "Theme ON").click();
    await settle();

    assert.equal(readingStyle(frame(view)?.srcdoc ?? ""), null);
    assert.equal(button(view, "Theme OFF").getAttribute("aria-pressed"), "false");
  });

  it("leaves pages with styles of their own alone, and says so", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "styled.html", STYLED);
    await settle();

    assert.equal(readingStyle(frame(view)?.srcdoc ?? ""), null);
    const toggle = button(view, "Theme ON");
    assert.equal(toggle.disabled, true);
    assert.equal(toggle.getAttribute("title"), "This page has styles of its own");
  });

  it("prepares the page again on a theme change while scripts are on", async () => {
    themedDocument(false, {});
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "plain.html", PLAIN);
    button(view, "Scripts OFF").click();
    await settle();
    const before = frame(view);

    themedDocument(true, { "--background-primary": "#101010" });
    harness.app.workspace.trigger("css-change");
    await settle();
    const after = frame(view);
    assert.ok(after);
    assert.notEqual(after, before);
    assert.match(readingStyle(after.srcdoc) ?? "", /background: #101010;/);
  });

  it("leaves the page alone when the theme event changes nothing it shows", async () => {
    themedDocument(false, {});
    const harness = await Harness.load();
    const plain = harness.newView();
    harness.open(plain, "plain.html", PLAIN);
    button(plain, "Scripts OFF").click();
    const styled = harness.newView();
    harness.open(styled, "styled.html", STYLED);
    button(styled, "Scripts OFF").click();
    await settle();
    const plainFrame = frame(plain);
    const styledFrame = frame(styled);

    // The same theme again leaves the plain page alone, and a page with styles
    // of its own does not follow the theme at all.
    harness.app.workspace.trigger("css-change");
    await settle();
    assert.equal(frame(plain), plainFrame);
    themedDocument(true, {});
    harness.app.workspace.trigger("css-change");
    await settle();
    assert.equal(frame(styled), styledFrame);
  });

  it("follows Obsidian's Readable line length setting", async () => {
    const harness = await Harness.load();
    harness.app.config.set("readableLineLength", false);
    const view = harness.newView();
    harness.open(view, "plain.html", PLAIN);
    await settle();
    assert.match(readingStyle(frame(view)?.srcdoc ?? "") ?? "", /max-width: none;/);

    // With scripts on, the view cannot reach the page, so it prepares it again.
    button(view, "Scripts OFF").click();
    await settle();
    const before = frame(view);
    harness.app.config.set("readableLineLength", true);
    harness.app.vault.trigger("config-changed", "readableLineLength");
    await settle();
    const after = frame(view);
    assert.notEqual(after, before);
    assert.match(readingStyle(after?.srcdoc ?? "") ?? "", /max-width: calc\(/);
  });

  it("reacts to a settings change that names no setting, as in Obsidian 1.5, and to no other", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "plain.html", PLAIN);
    button(view, "Scripts OFF").click();
    await settle();
    const first = frame(view);

    harness.app.vault.trigger("config-changed", "spellcheck");
    await settle();
    assert.equal(frame(view), first);
    harness.app.vault.trigger("config-changed");
    await settle();
    assert.equal(frame(view), first);

    harness.app.config.set("readableLineLength", false);
    harness.app.vault.trigger("config-changed");
    await settle();
    assert.notEqual(frame(view), first);
    assert.match(readingStyle(frame(view)?.srcdoc ?? "") ?? "", /max-width: none;/);
  });
});
