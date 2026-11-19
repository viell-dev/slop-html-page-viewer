import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { browser, expect } from "@wdio/globals";
import { type Color, decodePng, solidPng } from "../support/pixels.ts";
import {
  ACTIVE,
  clickToolbarButton,
  expectNoPixels,
  framePixels,
  openInActiveTab,
  PLUGIN_ID,
  recordedFrames,
  recordedFramesAfterClick,
  saveScreenshot,
  vaultFolder,
  waitForPage,
} from "../support/viewer.ts";

// The fixture image's green, and the mirrored site's banner blue.
const GREEN: Color = [46, 125, 50];
const BLUE: Color = [21, 101, 192];
const RED: Color = [198, 40, 40];
const ORANGE: Color = [239, 108, 0];
const IMAGE_PIXELS = 64 * 64;

describe("A page's local files in Obsidian", function () {
  it("keeps CSS resource-like text visible while loading real resources, also in shadow DOM (#91)", async function () {
    await browser.executeObsidian(async ({ app }) => {
      await app.vault.create(
        "Css tokens.css",
        `p::after { content: 'url(ghost.png)'; } p { color: rgb(46, 125, 50); } /* @import "ghost.css"; */`,
      );
      await app.vault.create(
        "Css tokens.html",
        `<link rel="stylesheet" href="Css tokens.css"><p>Text</p>` +
          `<div id="host"><template shadowrootmode="closed"><link rel="stylesheet" href="Css tokens.css"><p>Shadow</p></template></div>`,
      );
    });
    try {
      await openInActiveTab("Css tokens.html");
      await waitForPage();
      const shown = await browser.execute((active) => {
        const doc = document.querySelector<HTMLIFrameElement>(`${active} iframe`)!.contentDocument!;
        const read = (p: Element) => ({
          content: doc.defaultView!.getComputedStyle(p, "::after").content,
          color: doc.defaultView!.getComputedStyle(p).color,
        });
        // With scripts off, the copy declares the shadow root open.
        const shadow = doc.querySelector("#host")!.shadowRoot!.querySelector("p")!;
        return { page: read(doc.querySelector("p")!), shadow: read(shadow) };
      }, ACTIVE);
      const expected = { content: '"url(ghost.png)"', color: "rgb(46, 125, 50)" };
      expect(shown).toEqual({ page: expected, shadow: expected });
    } finally {
      await browser.executeObsidian(async ({ app }) => {
        for (const path of ["Css tokens.html", "Css tokens.css"]) {
          const file = app.vault.getAbstractFileByPath(path);
          if (file) await app.vault.delete(file);
        }
      });
    }
  });

  describe("with <style> text that Chromium does not apply (#143)", function () {
    const COLOR = "rgb(46, 125, 50)";
    // Chromium applies an SVG <style>'s own text, joined across its child
    // elements, and nothing inside those elements, in a MathML <style>, or
    // from a <link> inside SVG. The first <style> imports a file, so the copy
    // rewrites it. The document and a shadow root each have all of them.
    const tree = [
      `<div class="square" style="width: 64px; height: 64px"></div>`,
      `<p><span id="plain">Plain</span> <span id="own">Own</span>`,
      ` <span id="imported">Imported</span> <span id="joined">Joined</span>`,
      ` <span id="child">Child</span> <span id="math">MathML</span> <span id="link">Link</span></p>`,
      `<svg width="0" height="0"><style>@import "Style text.css"; #own { color: ${COLOR} }`,
      ` .square { background: url("2026-01-15/figure.png") }`,
      `<desc>#child { color: ${COLOR}; background: url("2026-01-15/figure.png") }</desc></style>`,
      `<style>#jo<desc>#child { color: ${COLOR} }</desc>ined { color: ${COLOR} }</style></svg>`,
      `<math><style>@import "Style ghost.css"; #math { color: ${COLOR};`,
      ` background: url("2026-01-15/figure.png") }</style></math>`,
      `<svg width="0" height="0"><link rel="stylesheet" href="Style link.css"></svg>`,
    ].join("");
    const page = [
      `<!doctype html>`,
      `<html lang="en"><head><meta charset="utf-8"><title>Style text</title></head><body>`,
      tree,
      `<div id="host"><template shadowrootmode="open">${tree}</template></div>`,
      `</body></html>`,
    ].join("\n");
    const files: Record<string, string> = {
      "Saved/Style text.css": `#imported { color: ${COLOR} }`,
      "Saved/Style ghost.css": `#math { color: ${COLOR} } .ghost-marker {}`,
      "Saved/Style link.css": `#link { color: ${COLOR} } .ghost-marker {}`,
      "Saved/Style text.html": page,
    };
    const FRAME = `${ACTIVE} iframe.html-page-viewer__frame`;

    before(async function () {
      for (const [path, text] of Object.entries(files)) await writeVaultFile(path, text);
    });

    after(async function () {
      await browser.executeObsidian(async ({ app }, paths) => {
        for (const path of paths) {
          const file = app.vault.getAbstractFileByPath(path);
          if (file) await app.vault.delete(file);
        }
      }, Object.keys(files));
    });

    /**
     * What the frame shows, in the document and in its shadow root: the colors
     * of the labelled text, which <style> and <link> elements Chromium gives a
     * stylesheet, and how many <desc> elements in SVG <style> elements the
     * copy kept. Read inside the frame when scripts are on.
     */
    async function shown(scriptsOn: boolean) {
      const read = (selector: string) => {
        const frame = document.querySelector<HTMLIFrameElement>(selector);
        const doc = frame === null ? document : frame.contentDocument!;
        const names: Record<string, string> = {
          "http://www.w3.org/2000/svg": "SVG",
          "http://www.w3.org/1998/Math/MathML": "MathML",
          "http://www.w3.org/1999/xhtml": "HTML",
        };
        const tree = (root: Document | ShadowRoot) => ({
          colors: Object.fromEntries(
            [...root.querySelectorAll("span[id]")].map((span) => [
              span.id,
              doc.defaultView!.getComputedStyle(span).color,
            ]),
          ),
          elements: [...root.querySelectorAll("style, link")].map(
            (element) =>
              `${names[element.namespaceURI ?? ""] ?? element.namespaceURI} ${element.localName}` +
              ((element as Element & { sheet?: StyleSheet | null }).sheet
                ? " with a stylesheet"
                : ""),
          ),
          kept: root.querySelectorAll("svg style > desc").length,
        });
        return { page: tree(doc), shadow: tree(doc.querySelector("#host")!.shadowRoot!) };
      };
      if (!scriptsOn) return browser.execute(read, FRAME);
      await browser.switchFrame(browser.$(FRAME));
      try {
        return await browser.execute(read, FRAME);
      } finally {
        await browser.switchFrame(null);
      }
    }

    /** Whether the copy holds the text of a stylesheet that nothing applies, and how many files it holds. */
    async function copy(): Promise<{ ghost: boolean; files: number }> {
      const srcdoc = await browser.execute(
        (selector) => document.querySelector<HTMLIFrameElement>(selector)!.srcdoc,
        FRAME,
      );
      return {
        ghost: srcdoc.includes("ghost-marker"),
        files: srcdoc.match(/data:image\/png/g)?.length ?? 0,
      };
    }

    function expected(plain: string, files: number) {
      const tree = {
        colors: {
          plain,
          own: COLOR,
          imported: COLOR,
          joined: COLOR,
          child: plain,
          math: plain,
          link: plain,
        },
        elements: [
          "SVG style with a stylesheet",
          "SVG style with a stylesheet",
          "MathML style",
          "SVG link",
        ],
        kept: 2,
      };
      // The square shows its image in the document and in the shadow root.
      return { page: tree, shadow: tree, copy: { ghost: false, files }, squares: true };
    }

    async function squares(): Promise<boolean> {
      return (await framePixels(GREEN)) >= 2 * IMAGE_PIXELS * 0.9;
    }

    it("applies only an HTML or SVG <style>'s own text, and reads nothing else", async function () {
      await openInActiveTab("Saved/Style text.html");
      await waitForPage();
      await saveScreenshot("style-text");
      const result = { ...(await shown(false)), copy: await copy(), squares: await squares() };
      expect(result).toEqual(expected(result.page.colors.plain, 0));
    });

    it("copies only the files that applied <style> text names into a page with scripts on", async function () {
      await copyLocalFiles(true);
      try {
        await openInActiveTab("Saved/Style text.html");
        await clickToolbarButton("Scripts OFF");
        await waitForPage();
        await saveScreenshot("style-text-scripts-on");
        const result = { ...(await shown(true)), copy: await copy(), squares: await squares() };
        // The square's image, copied once for the document and once for the shadow root.
        expect(result).toEqual(expected(result.page.colors.plain, 2));
      } finally {
        await clickToolbarButton("Scripts ON");
        await copyLocalFiles(false);
      }
    });
  });

  describe("with <style> and <link> elements of other types, and disabled links (#147)", function () {
    const COLOR = "rgb(46, 125, 50)";
    const FIGURE = "Saved/2026-01-15/figure.png";
    // Each type is on a <style>, which imports a file, names an image, and
    // colors a paragraph, and on a stylesheet <link> to a file that colors
    // another. Whether Chromium applies each, as #147 measured it, and as the
    // viewer prepares it: a <style> needs exactly `text/css`, in any ASCII
    // case, and a link a MIME type whose essence is empty or `text/css`.
    const TYPES: readonly { type: string | null; style: boolean; link: boolean }[] = [
      { type: null, style: true, link: true },
      { type: "", style: true, link: true },
      { type: "text/css", style: true, link: true },
      { type: "TEXT/CSS", style: true, link: true },
      { type: "text/css; charset=utf-8", style: false, link: true },
      { type: " text/css", style: false, link: true },
      { type: "text/css ", style: false, link: true },
      { type: " TEXT/CSS ; a=b", style: false, link: true },
      { type: ";", style: false, link: true },
      { type: " ", style: false, link: true },
      { type: "\ttext/css\n", style: false, link: true },
      { type: "\vtext/css", style: false, link: true },
      { type: `${String.fromCodePoint(0x2003)}text/css`, style: false, link: true },
      { type: `${String.fromCodePoint(0xa0)}text/css`, style: false, link: false },
      // Of Unicode's whitespace, the characters of the whitespace bidirectional
      // class are trimmed around a link type's essence, and others are not.
      ...[0x1680, 0x2028, 0x3000].map((code) => {
        const space = String.fromCodePoint(code);
        return { type: `${space}text/css${space}`, style: false, link: true };
      }),
      ...[0x180e, 0x2029, 0x202f].map((code) => {
        const space = String.fromCodePoint(code);
        return { type: `${space}text/css${space}`, style: false, link: false };
      }),
      { type: "text/x-scss", style: false, link: false },
      { type: "text/plain", style: false, link: false },
      { type: "text/css2", style: false, link: false },
    ];
    const SVG_TYPES: readonly { type: string | null; style: boolean }[] = [
      { type: null, style: true },
      { type: "text/css", style: true },
      // Chromium 114 (Obsidian 1.5.3) applies this one only in lowercase.
      { type: "TEXT/CSS", style: true },
      { type: "text/css; charset=utf-8", style: false },
    ];
    const LOWERCASE_IN_114 = ["v2", "v2-imported"];
    const typed = (type: string | null) => (type === null ? "" : ` type="${type}"`);
    /** A <style> that colors `.id` and names the figure, and imports a file that colors `.id-imported`. */
    const style = (id: string, type: string | null, extra = "") =>
      `<style id="${id}"${typed(type)}${extra}>@import "Style types/${id}.css";` +
      ` .${id} { color: ${COLOR}; background-image: url("${FIGURE}") }</style>`;
    /** A stylesheet link to a file that colors `.id`. */
    const link = (id: string, type: string | null, extra = "") =>
      `<link id="${id}" rel="stylesheet"${typed(type)} href="Style types/${id}.css"${extra}>`;
    // `disabled` does nothing on a <style>, and keeps a link from loading,
    // whatever its value.
    const elements = [
      ...TYPES.map(({ type }, i) => style(`s${i}`, type) + link(`l${i}`, type)),
      style("sd", null, " disabled"),
      link("ld", null, " disabled"),
      link("ldt", "text/css", ' disabled="false"'),
      `<svg width="0" height="0">${SVG_TYPES.map(({ type }, i) => style(`v${i}`, type)).join("")}</svg>`,
    ];
    const styleIds = [
      ...[...TYPES.keys()].map((i) => `s${i}`),
      "sd",
      ...[...SVG_TYPES.keys()].map((i) => `v${i}`),
    ];
    const linkIds = [...[...TYPES.keys()].map((i) => `l${i}`), "ld", "ldt"];
    const classes = [...styleIds.flatMap((id) => [id, `${id}-imported`]), ...linkIds];
    const tree =
      elements.join("") + classes.map((name) => `<p class="${name}">${name}</p>`).join("");
    const files: Record<string, string> = {
      ...Object.fromEntries([
        ...styleIds.map((id) => [`Style types/${id}.css`, `.${id}-imported { color: ${COLOR} }`]),
        ...linkIds.map((id) => [`Style types/${id}.css`, `.${id} { color: ${COLOR} }`]),
      ]),
      "Style types.html": [
        `<!doctype html>`,
        `<html lang="en"><head><meta charset="utf-8"><title>Style types</title></head><body>`,
        tree,
        `<div id="host"><template shadowrootmode="open" shadowroot="open">${tree}</template></div>`,
        `</body></html>`,
      ].join("\n"),
    };
    const FRAME = `${ACTIVE} iframe.html-page-viewer__frame`;

    // What applies, as Chromium applies it, and what the copy keeps as written.
    // The viewer prepares the elements that apply, and keeps the others.
    const appliedStyles = [
      ...TYPES.flatMap(({ style }, i) => (style ? [`s${i}`] : [])),
      "sd",
      ...SVG_TYPES.flatMap(({ style }, i) => (style ? [`v${i}`] : [])),
    ];
    const appliedLinks = TYPES.flatMap(({ link }, i) => (link ? [`l${i}`] : []));
    const applied = [
      ...appliedStyles.flatMap((id) => [id, `${id}-imported`]),
      ...appliedLinks,
    ].sort();
    const kept = {
      styles: styleIds.filter((id) => !appliedStyles.includes(id)),
      links: linkIds.filter((id) => !appliedLinks.includes(id)),
    };
    /** The vault stylesheets that the copy takes in: the files of the elements that apply. */
    const taken = [...appliedStyles, ...appliedLinks].map((id) => `Style types/${id}.css`).sort();

    /** What Chromium applies to the same page outside Obsidian, on this host. */
    let chromium: { page: string[]; shadow: string[] } = { page: [], shadow: [] };

    before(async function () {
      await browser.executeObsidian(async ({ app }) => {
        if (!app.vault.getAbstractFileByPath("Style types"))
          await app.vault.createFolder("Style types");
      });
      for (const [path, text] of Object.entries(files)) await writeVaultFile(path, text);
      const served = await inServedPage(files, "Style types.html", () =>
        browser.execute(read, COLOR),
      );
      chromium = { page: served.page.applied, shadow: served.shadow.applied };
    });

    after(async function () {
      await browser.executeObsidian(async ({ app }) => {
        for (const path of ["Style types.html", "Style types"]) {
          const file = app.vault.getAbstractFileByPath(path);
          if (file) await app.vault.delete(file, true);
        }
      });
    });

    afterEach(async function () {
      await restoreHost();
    });

    /**
     * Which classes' rules apply, in the document and in its shadow root, and
     * which <style> and <link> elements are as the page has them: a <style>
     * that keeps its import, and a link. Run inside the frame.
     */
    function read(color: string) {
      const tree = (root: Document | ShadowRoot) => ({
        applied: [...root.querySelectorAll("p")]
          .filter((p) => getComputedStyle(p).color === color)
          .map((p) => p.className)
          .sort(),
        styles: [...root.querySelectorAll("style[id]")]
          .filter((style) => (style.textContent ?? "").includes("@import"))
          .map((style) => style.id),
        links: [...root.querySelectorAll("link")].map((link) => link.id),
      });
      return { page: tree(document), shadow: tree(document.getElementById("host")!.shadowRoot!) };
    }

    /** What the viewer's frame shows, and how many copied images its copy holds. */
    async function shown() {
      const copy = await browser.execute(
        (selector) => document.querySelector<HTMLIFrameElement>(selector)!.srcdoc,
        FRAME,
      );
      // Read inside the frame, which a page with scripts on keeps from the window.
      await browser.switchFrame(browser.$(FRAME));
      try {
        const shown = await browser.execute(read, COLOR);
        return { ...shown, copied: copy.split("data:image/png").length - 1 };
      } finally {
        await browser.switchFrame(null);
      }
    }

    /** What the viewer shows: what Chromium applies on this host, with the others as written. */
    function expected(copied: number) {
      return {
        page: { applied: chromium.page, ...kept },
        shadow: { applied: chromium.shadow, ...kept },
        copied,
        reads: taken,
      };
    }

    it("is measured against what Chromium applies to the same page outside Obsidian", async function () {
      const measured = chromium.page.includes("v2")
        ? applied
        : applied.filter((name) => !LOWERCASE_IN_114.includes(name));
      expect(chromium).toEqual({ page: measured, shadow: measured });
    });

    it("reads and changes only the elements that apply, and keeps the others as written", async function () {
      await recordReads("Style types/");
      await openInActiveTab("Style types.html");
      await waitForPage();
      await saveScreenshot("style-types");
      expect({ ...(await shown()), reads: await recordedReads() }).toEqual(expected(0));
    });

    it("copies only the files that the elements that apply name into a page with scripts on", async function () {
      await copyLocalFiles(true);
      try {
        await openInActiveTab("Style types.html");
        await waitForPage();
        await recordReads("Style types/");
        await clickToolbarButton("Scripts OFF");
        await waitForPage();
        await saveScreenshot("style-types-scripts-on");
        // The figure, once for each <style> that applies, in the document and in the shadow root.
        expect({ ...(await shown()), reads: await recordedReads() }).toEqual(
          expected(2 * appliedStyles.length),
        );
      } finally {
        await clickToolbarButton("Scripts ON");
        await copyLocalFiles(false);
      }
    });
  });

  describe("with stylesheet imports (#136, #139, #144, #151, #152, #155)", function () {
    const green = "rgb(46, 125, 50)";
    const red = "rgb(198, 40, 40)";
    // A web stylesheet that Obsidian's policy refuses stands in for Google
    // Fonts, the one that it allows, so that the tests need no network: an
    // import's CSSImportRule shows whether it counts. Chromium refuses the
    // port too.
    const web = "http://127.0.0.1:9";
    // Each case's paragraph, and the styles that its stylesheets give it.
    const styles = [
      // #139: imported sheets that end inside a string, a comment, an unquoted
      // url(, and a block. The rules after each import must still apply, and
      // the strings there must stay strings.
      `<style>@import "Import rules/string.css"; #string::after { content: "url(Saved/2026-01-15/figure.png)" } #string { color: ${green} }</style>`,
      `<style>@import "Import rules/comment.css"; #comment { color: ${green} }</style>`,
      `<style>@import "Import rules/url.css"; #url::after { content: "x) url(Saved/2026-01-15/figure.png)" } #url { color: ${green} }</style>`,
      `<style>@import "Import rules/block.css"; #block { color: ${green} }</style>`,
      // #136: an import after a style rule, which CSS ignores, and one after
      // what CSS allows before imports.
      `<style>p { margin: 0 } @import "Import rules/ghost.css";</style>`,
      `<style><!-- @charset "utf-8"; @layer page; @import "Import rules/placed.css"; --></style>`,
      // A stylesheet file that starts with a byte order mark, and imports
      // another. Obsidian's reads leave the mark out, as browsers do; CSS
      // would read it as part of a name, which starts a rule before imports.
      `<link rel="stylesheet" href="Import rules/bom.css">`,
      // #144: an import into a cascade layer, with a comment before "layer".
      `<style>@import "Import rules/layered.css" /**/ layer;</style>`,
      // #151: layers in the order of their imports, also one whose file is
      // missing, which declares its layer where it is; one whose conditions
      // do not hold, which does not; and support conditions and a scope.
      `<style>@import "Import rules/order a.css" layer(ia); @import "Import rules/order b.css" layer(ib);</style>`,
      `<style>@import "Import rules/missing.css" layer(im); @import "Import rules/declared.css" layer(ig); @layer im { #declared { color: ${red} } }</style>`,
      `<style>@import "Import rules/late.css" layer(late) print; @layer early { #conditional { color: ${red} } } @layer late { #conditional { color: ${green} } }</style>`,
      `<style>@import "Import rules/supported.css" supports(display: grid);</style>`,
      `<style>@import "Import rules/unsupported.css" supports(display: nonsense);</style>`,
      `<style>@import "Import rules/scoped.css" scope(.scope);</style>`,
      // An empty stylesheet still declares its layer where its import is, and
      // a layer name with a comment beside its dot is still one.
      `<style>@import "Import rules/empty.css" layer(ea); @import "Import rules/empty b.css" layer(eb); @layer ea { #empty { color: ${red} } }</style>`,
      `<style>@import "Import rules/comment name.css" layer(cm/**/.x);</style>`,
      // So does one that holds only a kept import whose own conditions do not
      // hold: a media query that does not match, or, on Chromium 114, any
      // support conditions.
      `<style>@import "Import rules/print only.css" layer(pa); @import "Import rules/print only b.css" layer(pb); @layer pa { #printonly { color: ${red} } }</style>`,
      `<style>@import "Import rules/supports only.css" layer(sa); @import "Import rules/supports only b.css" layer(sb); @layer sa { #supportsonly { color: ${red} } }</style>`,
      // #152: imports that stay imports count after an inlined stylesheet's
      // rules, and inside a stylesheet imported with a media query list, whose
      // "<!--" and "-->" between rules start none. The one into a layer
      // declares it, so its place matters, as that of Google Fonts would. An
      // SVG <style> applies on Chromium 114 only with a lowercase type, which
      // the stylesheet split from it keeps.
      `<style>@import "Import rules/local.css"; @import url("${web}/kept.css") layer(kept);</style>`,
      `<svg width="0" height="0"><style type="TEXT/CSS">@import "Import rules/svg a.css"; @import url("${web}/svg.css") layer(svgk); #svgown { color: ${green} }</style></svg>`,
      `<style>@import "Import rules/web fonts.css" screen;</style>`,
      `<style>@import "Import rules/markers.css" screen;</style>`,
      // #155: the page's own stylesheets end where CSS ends them too. A linked
      // stylesheet and a <style> that end in an import without its ";" import
      // its file, and an unquoted URL at the end of a linked stylesheet is
      // that stylesheet's, in its folder.
      `<link rel="stylesheet" href="Import rules/ends in import.css">`,
      `<style>@import "Import rules/style tail.css"</style>`,
      `<link rel="stylesheet" href="Import rules/ends in url.css">`,
    ].join("\n");
    const paragraphs =
      [
        ...["string", "comment", "url", "block", "ghost", "placed", "bom", "layered"],
        ...["linktail", "styletail", "urltail", "ordered", "declared", "conditional"],
        ...["supported", "unsupported", "local", "webfonts", "markers", "empty"],
        ...["commentname", "svgown", "svgimported", "printonly", "supportsonly"],
      ]
        .map((id) => `<p id="${id}">${id}</p>`)
        .join("") + `<div class="scope"><p id="scoped">scoped</p></div>`;
    const files: Record<string, string> = {
      "Import rules/string.css": '"',
      "Import rules/comment.css": "/*",
      "Import rules/url.css": "a { b: url(",
      "Import rules/block.css": "a {",
      "Import rules/ghost.css": "#ghost { color: rgb(198, 40, 40) }",
      "Import rules/placed.css": `#placed { color: ${green} }`,
      "Import rules/bom.css": '﻿@import "bom import.css"; #bom { font-style: italic }',
      "Import rules/bom import.css": `﻿#bom { color: ${green} }`,
      "Import rules/layered.css": `#layered { color: ${green} }`,
      "Import rules/ends in import.css": '@import "link tail.css"',
      "Import rules/link tail.css": `#linktail { color: ${green} }`,
      "Import rules/style tail.css": `#styletail { color: ${green} }`,
      "Import rules/ends in url.css": "#urltail { background-image: url(target.png",
      "Import rules/order a.css": `#ordered { color: ${red} }`,
      "Import rules/order b.css": `#ordered { color: ${green} }`,
      "Import rules/declared.css": `#declared { color: ${green} }`,
      "Import rules/late.css": `#conditional { color: ${red} }`,
      "Import rules/supported.css": `#supported { color: ${green} }`,
      "Import rules/unsupported.css": `#unsupported { color: ${green} }`,
      "Import rules/scoped.css": `#scoped { color: ${green} }`,
      "Import rules/local.css": `#local { color: ${green} }`,
      "Import rules/web fonts.css": `@import url("${web}/fonts.css"); #webfonts { color: ${green} }`,
      "Import rules/markers.css": `<!-- #markers { color: ${green} } -->`,
      "Import rules/empty.css": "",
      "Import rules/empty b.css": `#empty { color: ${green} }`,
      "Import rules/comment name.css": `#commentname { color: ${green} }`,
      "Import rules/svg a.css": `#svgimported { color: ${green} }`,
      "Import rules/print only.css": `@import url("${web}/p.css") print;`,
      "Import rules/print only b.css": `#printonly { color: ${green} }`,
      "Import rules/supports only.css": `@import url("${web}/s.css") supports(display: block);`,
      "Import rules/supports only b.css": `#supportsonly { color: ${green} }`,
      "Import rules.html":
        `${styles}<p id="plain">plain</p>${paragraphs}` +
        `<div id="host"><template shadowrootmode="open">${styles}${paragraphs}</template></div>`,
    };

    before(async function () {
      await browser.executeObsidian(async ({ app }, files) => {
        await app.vault.createFolder("Import rules");
        for (const [path, text] of Object.entries(files)) await app.vault.create(path, text);
      }, files);
    });

    after(async function () {
      await browser.executeObsidian(async ({ app }) => {
        for (const path of ["Import rules.html", "Import rules"]) {
          const file = app.vault.getAbstractFileByPath(path);
          if (file) await app.vault.delete(file, true);
        }
      });
    });

    /**
     * The colors, generated content, and background images of the page's
     * paragraphs, and its shadow root's, and the imports that count in each:
     * the file names of their URLs, with their media query lists. Run inside
     * the frame.
     */
    function read() {
      const tree = (root: Document | ShadowRoot) =>
        Object.fromEntries(
          [...root.querySelectorAll("p[id]")].map((p) => [
            p.id,
            {
              color: getComputedStyle(p).color,
              after: getComputedStyle(p, "::after").content,
              background: getComputedStyle(p).backgroundImage,
            },
          ]),
        );
      const imports = (root: Document | ShadowRoot) => {
        const found: string[] = [];
        const visit = (sheet: CSSStyleSheet) => {
          let rules: CSSRuleList;
          try {
            rules = sheet.cssRules;
          } catch {
            // Another origin's stylesheet, whose rules a page cannot read.
            return;
          }
          for (const rule of rules) {
            if (!(rule instanceof CSSImportRule)) continue;
            const media = rule.media.mediaText;
            found.push(`${rule.href.replace(/^.*\//, "")}${media ? ` ${media}` : ""}`);
            if (rule.styleSheet) visit(rule.styleSheet);
          }
        };
        for (const sheet of root.styleSheets) visit(sheet);
        return found.sort();
      };
      const shadow = document.querySelector("#host")!.shadowRoot!;
      return {
        page: tree(document),
        shadow: tree(shadow),
        imports: [imports(document), imports(shadow)],
      };
    }

    /** What the viewer's frame shows, asked inside it, which a page with scripts on keeps from the window. */
    async function shown() {
      await browser.switchFrame(browser.$(`${ACTIVE} iframe.html-page-viewer__frame`));
      try {
        return await browser.execute(read);
      } finally {
        await browser.switchFrame(null);
      }
    }

    /** What the page shows of each case, in the document and in its shadow root. */
    function cases(result: ReturnType<typeof read>) {
      const plain = result.page.plain.color;
      return [result.page, result.shadow].map((root) => ({
        string: { color: root.string.color, after: root.string.after },
        url: { color: root.url.color, after: root.url.after },
        comment: root.comment.color,
        block: root.block.color,
        ghost: root.ghost.color === plain ? "not applied" : root.ghost.color,
        placed: root.placed.color,
        bom: root.bom.color,
        layered: root.layered.color === plain ? "not applied" : root.layered.color,
        linktail: root.linktail.color,
        styletail: root.styletail.color,
        // Resolved against the stylesheet, in its folder, not against the page.
        urltail: /\/Import%20rules\/target\.png"\)$/.test(root.urltail.background)
          ? "the stylesheet's"
          : root.urltail.background,
        ordered: root.ordered.color,
        declared: root.declared.color,
        conditional: root.conditional.color,
        supported: root.supported.color === plain ? "not applied" : root.supported.color,
        unsupported: root.unsupported.color === plain ? "not applied" : root.unsupported.color,
        scoped: root.scoped.color === plain ? "not applied" : root.scoped.color,
        local: root.local.color,
        webfonts: root.webfonts.color,
        markers: root.markers.color,
        empty: root.empty.color,
        commentname: root.commentname.color,
        printonly: root.printonly.color,
        supportsonly: root.supportsonly.color,
        svgown: root.svgown.color === plain ? "not applied" : root.svgown.color,
        svgimported: root.svgimported.color === plain ? "not applied" : root.svgimported.color,
      }));
    }

    // Whether this host's Chromium applies an import's support conditions,
    // which Chromium 114 never does (#151).
    let importSupports = false;
    // Whether it applies an SVG <style> whose type is not in lowercase, which
    // Chromium 114 does not (#147).
    let svgTypeAnyCase = false;
    before(async function () {
      importSupports = await browser.execute(() => "supportsText" in CSSImportRule.prototype);
      svgTypeAnyCase = await browser.execute(() => {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
        style.setAttribute("type", "TEXT/CSS");
        style.textContent = "#e2e-svg-type-probe {}";
        svg.append(style);
        document.body.append(svg);
        const applies = (style as SVGStyleElement).sheet !== null;
        svg.remove();
        return applies;
      });
    });

    /** What Chromium shows, and the viewer too, on this host. */
    function expected() {
      return {
        string: { color: green, after: '"url(Saved/2026-01-15/figure.png)"' },
        url: { color: green, after: '"x) url(Saved/2026-01-15/figure.png)"' },
        comment: green,
        block: green,
        ghost: "not applied",
        placed: green,
        bom: green,
        layered: green,
        linktail: green,
        styletail: green,
        urltail: "the stylesheet's",
        ordered: green,
        declared: green,
        conditional: green,
        supported: importSupports ? green : "not applied",
        unsupported: "not applied",
        // No version of Chromium in Obsidian applies an import with a scope.
        scoped: "not applied",
        local: green,
        webfonts: green,
        markers: green,
        empty: green,
        commentname: green,
        printonly: green,
        supportsonly: green,
        svgown: svgTypeAnyCase ? green : "not applied",
        svgimported: svgTypeAnyCase ? green : "not applied",
      };
    }

    /**
     * The imports that count in the viewer, in the document and in its shadow
     * root alike: the web ones, the inner one with its importer's media query
     * list (#152), and the vault ones that stay imports, which Obsidian's
     * policy does not load into the page: the missing file, the scoped
     * import, and on Chromium 114, which reads support conditions as a media
     * query, the ones with support conditions (#151).
     */
    function counted() {
      const imports = [
        "fonts.css screen",
        "kept.css",
        "missing.css",
        "scoped.css scope(.scope)",
        // The kept imports of the stylesheets imported into layers.
        "p.css print",
        importSupports ? "s.css" : "s.css supports(display: block)",
        // Only where the SVG <style> applies.
        ...(svgTypeAnyCase ? ["svg.css"] : []),
        ...(importSupports
          ? []
          : [
              "supported.css supports(display: grid)",
              "unsupported.css supports(display: nonsense)",
            ]),
      ].sort();
      return [imports, imports];
    }

    it("is measured against what Chromium shows of the same page outside Obsidian", async function () {
      const chromium = await inServedPage(files, "Import rules.html", () => browser.execute(read));
      // Served, the inner web import counts inside its importer's stylesheet.
      const web = (imports: string[]) =>
        imports.filter((name) => name === "fonts.css" || name === "kept.css");
      expect({ cases: cases(chromium), imports: chromium.imports.map(web) }).toEqual({
        cases: [expected(), expected()],
        imports: [
          ["fonts.css", "kept.css"],
          ["fonts.css", "kept.css"],
        ],
      });
    });

    it("applies only the imports that CSS applies, and the rules after them", async function () {
      await openInActiveTab("Import rules.html");
      await waitForPage();
      const result = await shown();
      expect({ cases: cases(result), imports: result.imports }).toEqual({
        cases: [expected(), expected()],
        imports: counted(),
      });
    });

    it("copies no file that only string text names, with scripts on", async function () {
      await copyLocalFiles(true);
      try {
        await openInActiveTab("Import rules.html");
        await clickToolbarButton("Scripts OFF");
        await waitForPage();
        const result = await shown();
        expect({ cases: cases(result), imports: result.imports }).toEqual({
          cases: [expected(), expected()],
          imports: counted(),
        });
      } finally {
        await clickToolbarButton("Scripts ON");
        await copyLocalFiles(false);
      }
    });
  });

  describe("with stylesheets that import each other many times (#154)", function () {
    const green = "rgb(46, 125, 50)";
    // Eight stylesheets, each importing the next ten times: eleven million
    // stylesheets eight deep, if nothing bounded how many the copy takes in.
    const files: Record<string, string> = Object.fromEntries(
      Array.from({ length: 8 }, (_, level) => [
        `Import fan-out/${level}.css`,
        `${level < 7 ? `@import "${level + 1}.css";\n`.repeat(10) : ""}#level${level} { color: ${green} }`,
      ]),
    );
    files["Import fan-out/late.css"] = "#late { color: rgb(198, 40, 40) }";
    files["Import fan-out.html"] = [
      `<link rel="stylesheet" href="Import fan-out/0.css">`,
      // Imported after the link's stylesheets have taken up the page's limit.
      `<style>@import "Import fan-out/late.css";</style>`,
      ...Array.from({ length: 8 }, (_, level) => `<p id="level${level}">${level}</p>`),
      `<p id="late">late</p>`,
    ].join("");

    before(async function () {
      await browser.executeObsidian(async ({ app }, files) => {
        await app.vault.createFolder("Import fan-out");
        for (const [path, text] of Object.entries(files)) await app.vault.create(path, text);
      }, files);
    });

    after(async function () {
      await browser.executeObsidian(async ({ app }) => {
        for (const path of ["Import fan-out.html", "Import fan-out"]) {
          const file = app.vault.getAbstractFileByPath(path);
          if (file) await app.vault.delete(file, true);
        }
      });
    });

    it("shows the page soon, with the stylesheets up to the limit, and keeps the window responding", async function () {
      await openInActiveTab("Saved/Example article.html");
      await waitForPage();
      // Timers in Obsidian's window, which run only while it responds.
      await browser.execute(() => {
        const state = window as unknown as { e2eTicks?: number[]; e2eTimer?: number };
        state.e2eTicks = [];
        const tick = () => {
          state.e2eTicks!.push(performance.now());
          state.e2eTimer = window.setTimeout(tick, 10);
        };
        tick();
      });
      await openInActiveTab("Import fan-out.html");
      await waitForPage();
      const longest = await browser.execute(() => {
        const state = window as unknown as { e2eTicks: number[]; e2eTimer: number };
        clearTimeout(state.e2eTimer);
        const ticks = [...state.e2eTicks, performance.now()];
        return Math.max(...ticks.slice(1).map((tick, i) => tick - ticks[i]));
      });
      await browser.switchFrame(browser.$(`${ACTIVE} iframe.html-page-viewer__frame`));
      let shown: { colors: string[]; late: string; plain: string; copies: number };
      try {
        shown = await browser.execute((green) => {
          const color = (id: string) => getComputedStyle(document.getElementById(id)!).color;
          const text = [...document.querySelectorAll("style")].map((s) => s.textContent).join("");
          return {
            colors: Array.from({ length: 8 }, (_, level) => color(`level${level}`)),
            late: color("late"),
            plain: getComputedStyle(document.body).color,
            copies: text.split(`{ color: ${green} }`).length - 1,
          };
        }, green);
      } finally {
        await browser.switchFrame(null);
      }
      // At most 0.3 s in Obsidian 1.5.3 and 1.15.1, against 6 to 10 minutes
      // without the limits, by extrapolation from #154's measurements of five
      // imports a stylesheet; the margin is for slower hosts.
      expect(longest).toBeLessThan(2_000);
      expect({
        colors: shown.colors,
        // The import past the limit stays an import, which Obsidian's policy keeps from loading.
        late: shown.late === shown.plain ? "not applied" : shown.late,
        copies: shown.copies,
      }).toEqual({ colors: Array(8).fill(green), late: "not applied", copies: 1_000 });
    });
  });

  before(async function () {
    // An image just outside the vault, which a page must not be able to show.
    const outside = path.join(path.dirname(await vaultFolder()), "outside.png");
    fs.writeFileSync(outside, solidPng(64, RED));
  });

  it("shows a saved page's image from the folder beside it", async function () {
    await openInActiveTab("Saved/Example article.html");
    await waitForPage();
    await saveScreenshot("example-article-image");
    expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
  });

  it("applies a mirrored site's own stylesheet", async function () {
    await openInActiveTab("Mirror/index.html");
    await waitForPage();
    await saveScreenshot("mirror-stylesheet");
    expect(await framePixels(BLUE)).toBeGreaterThan(1000);
  });

  it("shows an image that the page names by file name only, as Obsidian's links do", async function () {
    await openInActiveTab("Saved/By name.html");
    await waitForPage();
    expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
  });

  describe("in shadow DOM (#124)", function () {
    /** Whether the page shows its image, found by name, and a square from each of its stylesheets. */
    async function shadowContent(): Promise<Record<string, boolean>> {
      const shows = async (color: Color) => (await framePixels(color)) >= IMAGE_PIXELS * 0.9;
      return {
        image: await shows(GREEN),
        linked: await shows(BLUE),
        imported: await shows(ORANGE),
      };
    }

    it("shows the files that it names, also by name, and applies its stylesheets", async function () {
      await openInActiveTab("Saved/Shadow resources.html");
      await waitForPage();
      await saveScreenshot("shadow-resources");
      expect(await shadowContent()).toEqual({ image: true, linked: true, imported: true });
    });

    it("copies the files that it names into a page with scripts on", async function () {
      await copyLocalFiles(true);
      try {
        await openInActiveTab("Saved/Shadow resources.html");
        await clickToolbarButton("Scripts OFF");
        await waitForPage();
        await saveScreenshot("shadow-resources-scripts-on");
        expect(await shadowContent()).toEqual({ image: true, linked: true, imported: true });
      } finally {
        await clickToolbarButton("Scripts ON");
        await copyLocalFiles(false);
      }
    });
  });

  describe("with a page's <style> whose imports the copy takes in (#177)", function () {
    // The copy keeps such a <style>'s URLs as written, as it keeps one's
    // without imports, so only its <base> resolves them as the page does:
    // without it, they would resolve against Obsidian's own address.
    const PURPLE: Color = [106, 27, 154];
    const square = (id: string) =>
      `<style>@import "Relative sheet.css"; #${id} { width: 64px; height: 64px; background: url(Relative/purple.png) }</style><div id="${id}"></div>`;
    const page = [
      square("document"),
      `<div><template shadowrootmode="open">${square("shadow")}</template></div>`,
      // A template's content, which the page's script puts in the page.
      `<template id="later">${square("later")}</template>`,
      `<script>document.body.append(document.getElementById("later").content.cloneNode(true));</script>`,
    ].join("");

    before(async function () {
      await browser.executeObsidian(
        async ({ app }, page, image) => {
          await app.vault.createFolder("Saved/Relative");
          const bytes = Uint8Array.from(atob(image), (char) => char.charCodeAt(0));
          await app.vault.createBinary("Saved/Relative/purple.png", bytes.buffer);
          await app.vault.create("Saved/Relative sheet.css", ".unused { color: red }");
          await app.vault.create("Saved/Relative URLs.html", page);
        },
        page,
        solidPng(64, PURPLE).toString("base64"),
      );
    });

    after(async function () {
      await browser.executeObsidian(async ({ app }) => {
        for (const path of [
          "Saved/Relative URLs.html",
          "Saved/Relative sheet.css",
          "Saved/Relative",
        ]) {
          const file = app.vault.getAbstractFileByPath(path);
          if (file) await app.vault.delete(file, true);
        }
      });
    });

    it("resolves its URLs as written, in the document and in a shadow root", async function () {
      await openInActiveTab("Saved/Relative URLs.html");
      await waitForPage();
      await saveScreenshot("relative-style-urls");
      const texts = await browser.execute((active) => {
        const doc = document.querySelector<HTMLIFrameElement>(`${active} iframe`)!.contentDocument!;
        const host = [...doc.querySelectorAll("div")].find((div) => div.shadowRoot !== null)!;
        return [doc.querySelector("style")!, host.shadowRoot!.querySelector("style")!].map(
          (style) => style.textContent,
        );
      }, ACTIVE);
      // The import is taken in, and the URL keeps its text.
      for (const text of texts) {
        expect(text).toContain("url(Relative/purple.png)");
        expect(text).not.toContain("@import");
      }
      expect(await framePixels(PURPLE)).toBeGreaterThanOrEqual(2 * IMAGE_PIXELS * 0.9);
    });

    it("copies the files that they name into a page with scripts on, also in a template's content", async function () {
      await copyLocalFiles(true);
      try {
        await openInActiveTab("Saved/Relative URLs.html");
        await clickToolbarButton("Scripts OFF");
        await waitForPage();
        await saveScreenshot("relative-style-urls-scripts-on");
        expect(await framePixels(PURPLE)).toBeGreaterThanOrEqual(3 * IMAGE_PIXELS * 0.9);
      } finally {
        await clickToolbarButton("Scripts ON");
        await copyLocalFiles(false);
      }
    });
  });

  it("shows nothing from outside the vault", async function () {
    await openInActiveTab("Saved/Outside reference.html");
    await waitForPage();
    expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
    expect(await framePixels(RED)).toBe(0);
  });

  it("isolates the page from the vault's files while scripts are on", async function () {
    await openInActiveTab("Saved/Example article.html");
    await clickToolbarButton("Scripts OFF");
    await waitForPage();
    // A known limit: with scripts, the page has an opaque origin, which
    // Obsidian does not serve vault files to.
    await expectNoPixels(GREEN, "scripts on");
    await clickToolbarButton("Scripts ON");
  });

  it("gives a frame with scripts on an opaque origin in Obsidian's main process from the start (#83)", async function () {
    await openInActiveTab("Saved/Example article.html");
    await waitForPage();
    // Obsidian serves vault files to a frame by the origin its main process
    // records, which it updates only once it learns that the frame's page
    // committed. Read right after the click, the record shows the frame as it
    // was created, before its page loads.
    const created = await recordedFramesAfterClick("Scripts OFF");
    await waitForPage();
    const loaded = await recordedFrames();
    // With scripts off again, the frame keeps Obsidian's origin, which the
    // record shows; the tab is back as the next test expects it.
    await clickToolbarButton("Scripts ON");
    await waitForPage();
    const scriptsOff = await recordedFrames();
    expect({ created, loaded, scriptsOff }).toEqual({
      created: { frames: 1, origins: ["null"] },
      loaded: { frames: 1, origins: ["null"] },
      scriptsOff: { frames: 1, origins: ["app://obsidian.md"] },
    });
  });

  describe("on a page that preparing could fail on", function () {
    // The same image outside the vault, named by its full address, which
    // only the copy's own policy keeps out.
    let outside = "";

    before(async function () {
      outside = await browser.executeObsidian(({ app }) => {
        const file = app.vault.getAbstractFileByPath("Interactive.html");
        if (file === null) throw new Error("No file at Interactive.html");
        return new URL("../outside.png", app.vault.getResourcePath(file as never)).href;
      });
    });

    afterEach(async function () {
      await restoreHost();
    });

    function page(head: string, body = ""): string {
      return [
        `<!doctype html>`,
        `<html lang="en"><head><meta charset="utf-8"><title>Preparation</title>${head}</head>`,
        `<body><p>An image inside the vault, and one outside it.</p>`,
        `<img src="2026-01-15/figure.png" alt="Inside" width="64" height="64">`,
        `<img src="${outside}" alt="Outside" width="64" height="64">${body}`,
        `</body></html>`,
      ].join("\n");
    }

    it("shows a page whose CSS escape names no character with only the vault's files", async function () {
      await writeVaultFile(
        "Saved/Escape.html",
        page(`<style>p { background: url(\\110000.png) }</style>`),
      );
      await openInActiveTab("Saved/Escape.html");
      await waitForPage();
      await saveScreenshot("escape-past-last-code-point");
      expect(await framePixels(RED)).toBe(0);
      expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
    });

    it("leaves out a stylesheet that cannot be read, and shows only the vault's files", async function () {
      await writeVaultFile("Saved/Unreadable.css", "p { font-weight: bold }");
      await writeVaultFile(
        "Saved/Unreadable stylesheet.html",
        page(`<link rel="stylesheet" href="Unreadable.css">`),
      );
      await failRead("Saved/Unreadable.css");
      await openInActiveTab("Saved/Unreadable stylesheet.html");
      await waitForPage();
      expect(await framePixels(RED)).toBe(0);
      expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
    });

    it("shows an error instead of a page it cannot prepare, and the page once it can", async function () {
      const html = page("", `\n<img src="Missing.png" alt="Missing">`);
      await writeVaultFile("Saved/Unprepared.html", html);
      // A host failure that preparing the page cannot work around.
      await failLinkResolution("Missing.png");
      await openInActiveTab("Saved/Unprepared.html");

      const message = browser.$(`${ACTIVE} .html-page-viewer__message`);
      await message.waitForExist();
      expect(await message.getText()).toContain("Unable to prepare this page");
      expect(await browser.$(`${ACTIVE} iframe.html-page-viewer__frame`).isExisting()).toBe(false);
      await saveScreenshot("unprepared-page");
      expect(await viewPixels(RED)).toBe(0);

      await clickToolbarButton("Source");
      expect(await sourceText()).toBe(html);

      await clickToolbarButton("Rendered");
      await browser.$(`${ACTIVE} .html-page-viewer__message`).waitForExist();
      await restoreHost();
      await browser
        .$(`${ACTIVE} .html-page-viewer__toolbar button[aria-label="Refresh preview"]`)
        .click();
      await waitForPage();
      expect(await framePixels(RED)).toBe(0);
      expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
    });
  });

  it("lets the viewer read the rendered page while scripts are off", async function () {
    await openInActiveTab("Saved/Example article.html");
    await waitForPage();
    const heading = await browser.executeObsidian(() => {
      const frame = document.querySelector<HTMLIFrameElement>(
        ".workspace-leaf.mod-active iframe.html-page-viewer__frame",
      );
      return frame?.contentDocument?.querySelector("h1")?.textContent ?? null;
    });
    expect(heading).toBe("Example article");
  });
});

/** Creates or replaces a vault file, as a fixture that needs the vault's address. */
async function writeVaultFile(filePath: string, text: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, filePath, text) => {
      const file = app.vault.getAbstractFileByPath(filePath);
      if (file === null) await app.vault.create(filePath, text);
      else await app.vault.modify(file as never, text);
    },
    filePath,
    text,
  );
}

/**
 * Turns the **Local files with scripts on** setting on or off for the pages
 * that render next, without saving it, which settings.e2e.ts tests.
 */
async function copyLocalFiles(on: boolean): Promise<void> {
  await browser.executeObsidian(
    ({ app }, id, on) => {
      const plugins = (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins;
      (plugins.plugins[id] as { settings: { copyLocalFiles: boolean } }).settings.copyLocalFiles =
        on;
    },
    PLUGIN_ID,
    on,
  );
}

/** Makes Obsidian's reads of one vault file fail, until {@link restoreHost}. */
async function failRead(filePath: string): Promise<void> {
  await browser.executeObsidian(({ app }, filePath) => {
    const vault = app.vault as unknown as {
      cachedRead(file: { path: string }): Promise<string>;
    };
    const own = Object.hasOwn(vault, "cachedRead");
    const read = vault.cachedRead;
    vault.cachedRead = (file) =>
      file.path === filePath
        ? Promise.reject(new Error("synthetic read failure"))
        : read.call(vault, file);
    const state = window as unknown as { e2eRestore?: (() => void)[] };
    (state.e2eRestore ??= []).push(() => {
      if (own) vault.cachedRead = read;
      else delete (vault as { cachedRead?: unknown }).cachedRead;
    });
  }, filePath);
}

/** Makes Obsidian's link resolution throw for one link text, until {@link restoreHost}. */
async function failLinkResolution(linktext: string): Promise<void> {
  await browser.executeObsidian(({ app }, linktext) => {
    const cache = app.metadataCache as unknown as {
      getFirstLinkpathDest(linktext: string, source: string): unknown;
    };
    const own = Object.hasOwn(cache, "getFirstLinkpathDest");
    const resolve = cache.getFirstLinkpathDest;
    cache.getFirstLinkpathDest = (text, source) => {
      if (text === linktext) throw new Error("synthetic failure");
      return resolve.call(cache, text, source);
    };
    const state = window as unknown as { e2eRestore?: (() => void)[] };
    (state.e2eRestore ??= []).push(() => {
      if (own) cache.getFirstLinkpathDest = resolve;
      else delete (cache as { getFirstLinkpathDest?: unknown }).getFirstLinkpathDest;
    });
  }, linktext);
}

/**
 * Records the paths under `folder` that Obsidian's cached reads read, until
 * {@link restoreHost}; {@link recordedReads} returns them. The view reads a
 * page's stylesheets that way.
 */
async function recordReads(folder: string): Promise<void> {
  await browser.executeObsidian(({ app }, folder) => {
    const vault = app.vault as unknown as {
      cachedRead(file: { path: string }): Promise<string>;
    };
    const own = Object.hasOwn(vault, "cachedRead");
    const read = vault.cachedRead;
    const state = window as unknown as { e2eReads?: string[]; e2eRestore?: (() => void)[] };
    state.e2eReads = [];
    vault.cachedRead = (file) => {
      if (file.path.startsWith(folder)) state.e2eReads!.push(file.path);
      return read.call(vault, file);
    };
    (state.e2eRestore ??= []).push(() => {
      if (own) vault.cachedRead = read;
      else delete (vault as { cachedRead?: unknown }).cachedRead;
    });
  }, folder);
}

/** The paths that {@link recordReads} has recorded, each once, sorted. */
async function recordedReads(): Promise<string[]> {
  const reads = await browser.execute(
    () => (window as unknown as { e2eReads?: string[] }).e2eReads ?? [],
  );
  return [...new Set(reads)].sort();
}

/**
 * Serves `files`, by their vault paths, over HTTP from this process, loads
 * `page` from there in a frame of Obsidian's window without a sandbox, and
 * runs `read` inside the frame once the page and its stylesheets have loaded.
 * Chromium then shows the page as a browser does, with neither the plugin nor
 * the policy of Obsidian's that a `srcdoc` frame inherits between them, which
 * allows only inline styles. A vault page cannot show this: Obsidian serves
 * vault files only to its own origin (#147).
 */
async function inServedPage<T>(
  files: Record<string, string>,
  page: string,
  read: () => Promise<T>,
): Promise<T> {
  const server = http.createServer((request, response) => {
    let name = "";
    try {
      name = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.slice(1));
    } catch {
      // A malformed request names no file.
    }
    const text = Object.hasOwn(files, name) ? files[name] : undefined;
    response.writeHead(text === undefined ? 404 : 200, {
      "Content-Type": name.endsWith(".css") ? "text/css" : "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(text ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const src = `http://127.0.0.1:${port}/${page.split("/").map(encodeURIComponent).join("/")}`;
    await browser.execute((src) => {
      const frame = document.createElement("iframe");
      frame.id = "e2e-served";
      frame.style.cssText = "position: fixed; left: 0; top: 0; width: 400px; height: 300px;";
      // The frame's load waits for the page's stylesheets and their imports.
      frame.addEventListener("load", () => (frame.dataset.loaded = "true"), { once: true });
      frame.src = src;
      document.body.append(frame);
    }, src);
    await browser.waitUntil(
      () => browser.execute(() => document.getElementById("e2e-served")?.dataset.loaded === "true"),
      { timeout: 15_000, timeoutMsg: "the served page did not load" },
    );
    await browser.switchFrame(browser.$("#e2e-served"));
    try {
      return await read();
    } finally {
      await browser.switchFrame(null);
    }
  } finally {
    await browser.execute(() => document.getElementById("e2e-served")?.remove());
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Undoes every failure that a test made in Obsidian. */
async function restoreHost(): Promise<void> {
  await browser.executeObsidian(() => {
    const state = window as unknown as { e2eRestore?: (() => void)[] };
    for (const restore of (state.e2eRestore ?? []).reverse()) restore();
    state.e2eRestore = [];
  });
}

/** How many pixels of the active tab's view, toolbar and all, show `color`. */
async function viewPixels(color: Color): Promise<number> {
  const view = await browser.$(`${ACTIVE} .html-page-viewer`);
  const shot = await browser.takeElementScreenshot(await view.elementId);
  return decodePng(Buffer.from(shot, "base64")).count(color);
}

/** The text that the active tab's source view shows, line by line. */
async function sourceText(): Promise<string> {
  await browser.$(`${ACTIVE} .html-page-viewer__source`).waitForExist();
  return browser.execute(
    (active) =>
      [...document.querySelectorAll(`${active} .html-page-viewer__source-code`)]
        .map((line) => line.textContent ?? "")
        .join("\n"),
    ACTIVE,
  );
}
