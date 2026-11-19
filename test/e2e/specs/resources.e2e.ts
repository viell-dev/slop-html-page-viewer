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

  describe("with titled stylesheets of several sets (#169)", function () {
    const COLOR = "rgb(46, 125, 50)";
    const FIGURE = "Saved/2026-01-15/figure.png";
    const titled = (title: string | null) => (title === null ? "" : ` title="${title}"`);
    /** A stylesheet link to a file that colors `#id`. */
    const link = (title: string | null, id: string, rel = "stylesheet") =>
      `<link id="${id}-link" rel="${rel}"${titled(title)} href="Style sets/${id}.css">`;
    /** A <style> that colors `#id`, names the figure, and imports a file that colors `#id-imported`. */
    const style = (title: string | null, id: string) =>
      `<style id="${id}-style"${titled(title)}>@import "Style sets/${id}.css";` +
      ` #${id} { color: ${COLOR}; background-image: url("${FIGURE}") }</style>`;
    const svgStyle = (title: string, id: string) =>
      `<svg width="0" height="0">${style(title, id)}</svg>`;
    const meta = (content: string) => `<meta http-equiv="Default-Style" content="${content}">`;
    // The first title is that of a link to a missing file, which still names
    // its set; a <meta> at the end changes nothing. A shadow root applies its
    // stylesheets whatever their titles, but not an alternate link.
    const sets = [
      `<link rel="stylesheet" title="A" href="Style sets/missing.css">`,
      link("B", "b1"),
      link(null, "c1"),
      link("A", "a1"),
      link("A", "alt1", "alternate stylesheet"),
      link("B", "alt2", "alternate stylesheet"),
      link(null, "p1", "alternate stylesheet"),
      link(" ", "sp"),
      style("A", "sa"),
      style("B", "sb"),
      style("a", "sl"),
      svgStyle("A", "svga"),
      svgStyle("B", "svgb"),
    ];
    const shadow = [link("B", "hb"), style("B", "hs"), link("A", "halt", "alternate stylesheet")];
    const defaults = [
      meta("B"),
      link("A", "ma"),
      link("B", "mb"),
      style("A", "msa"),
      style("B", "msb"),
    ];
    // A first titled link whose href is no URL names no set, as Chromium has it.
    const badHref = [
      `<link id="bad-link" rel="stylesheet" title="A" href="http://[bad">`,
      link("B", "bb"),
      link("A", "ba"),
    ];
    const linkIds = [
      ...["b1", "c1", "a1", "alt1", "alt2", "p1", "sp", "hb", "halt", "ma", "mb"],
      ...["bb", "ba"],
    ];
    const styleIds = ["sa", "sb", "sl", "svga", "svgb", "hs", "msa", "msb"];
    const paragraphs = (ids: string[]) =>
      ids
        .flatMap((id) => (styleIds.includes(id) ? [id, `${id}-imported`] : [id]))
        .map((id) => `<p id="${id}">${id}</p>`)
        .join("");
    const files: Record<string, string> = {
      ...Object.fromEntries(
        linkIds.map((id) => [`Style sets/${id}.css`, `#${id} { color: ${COLOR} }`]),
      ),
      ...Object.fromEntries(
        styleIds.map((id) => [`Style sets/${id}.css`, `#${id}-imported { color: ${COLOR} }`]),
      ),
      "Style sets.html": [
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Style sets</title>`,
        sets.join(""),
        `</head><body>`,
        paragraphs([
          "b1",
          "c1",
          "a1",
          "alt1",
          "alt2",
          "p1",
          "sp",
          "sa",
          "sb",
          "sl",
          "svga",
          "svgb",
        ]),
        `<div id="host"><template shadowrootmode="open">${shadow.join("")}${paragraphs(["hb", "hs", "halt"])}</template></div>`,
        meta("B"),
        `</body></html>`,
      ].join(""),
      "Default style.html": [
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Default style</title>`,
        defaults.join(""),
        `</head><body>${paragraphs(["ma", "mb", "msa", "msb"])}</body></html>`,
      ].join(""),
      "Bad href.html": [
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bad href</title>`,
        badHref.join(""),
        `</head><body>${paragraphs(["bb", "ba"])}</body></html>`,
      ].join(""),
    };
    const FRAME = `${ACTIVE} iframe.html-page-viewer__frame`;
    const PAGES = ["Style sets.html", "Default style.html", "Bad href.html"];

    // What Chromium applies in each page, as headless Chrome 158 applied it.
    const APPLIED: Record<string, { page: string[]; shadow: string[] }> = {
      "Style sets.html": {
        page: ["a1", "alt1", "c1", "sa", "sa-imported", "svga", "svga-imported"],
        shadow: ["hb", "hs", "hs-imported"],
      },
      "Default style.html": { page: ["mb", "msb", "msb-imported"], shadow: [] },
      "Bad href.html": { page: ["bb"], shadow: [] },
    };
    /** The vault stylesheets of the elements that apply, which the copy reads. */
    const READS: Record<string, string[]> = {
      "Style sets.html": ["a1", "alt1", "c1", "hb", "hs", "sa", "svga"],
      "Default style.html": ["mb", "msb"],
      "Bad href.html": ["bb"],
    };

    /** What Chromium applies to each page outside Obsidian, on this host. */
    const chromium: Record<string, unknown> = {};

    before(async function () {
      await browser.executeObsidian(async ({ app }) => {
        if (!app.vault.getAbstractFileByPath("Style sets"))
          await app.vault.createFolder("Style sets");
      });
      for (const [path, text] of Object.entries(files)) await writeVaultFile(path, text);
      for (const page of PAGES)
        chromium[page] = await inServedPage(files, page, () => browser.execute(read, COLOR));
    });

    after(async function () {
      await browser.executeObsidian(
        async ({ app }, paths) => {
          for (const path of paths) {
            const file = app.vault.getAbstractFileByPath(path);
            if (file) await app.vault.delete(file, true);
          }
        },
        [...PAGES, "Style sets"],
      );
    });

    afterEach(async function () {
      await restoreHost();
    });

    /**
     * Which paragraphs a stylesheet colors, in the document and in its shadow
     * root, and which <style> and <link> elements are as the page has them: a
     * <style> that keeps its import, and a link. Run inside the frame.
     */
    function read(color: string) {
      const tree = (root: Document | ShadowRoot | null) =>
        root === null
          ? []
          : [...root.querySelectorAll("p[id]")]
              .filter((p) => getComputedStyle(p).color === color)
              .map((p) => p.id)
              .sort();
      const kept = (root: Document | ShadowRoot | null) =>
        root === null
          ? []
          : [
              ...[...root.querySelectorAll("style[id]")]
                .filter((style) => (style.textContent ?? "").includes("@import"))
                .map((style) => style.id),
              ...[...root.querySelectorAll("link")].map(
                (link) => link.id || link.getAttribute("href"),
              ),
            ].sort();
      const shadow = document.getElementById("host")?.shadowRoot ?? null;
      return {
        applied: { page: tree(document), shadow: tree(shadow) },
        kept: { page: kept(document), shadow: kept(shadow) },
      };
    }

    /** What the viewer's frame shows, and how many copied images its copy holds. */
    async function shown() {
      const copy = await browser.execute(
        (selector) => document.querySelector<HTMLIFrameElement>(selector)!.srcdoc,
        FRAME,
      );
      await browser.switchFrame(browser.$(FRAME));
      try {
        return {
          ...(await browser.execute(read, COLOR)),
          copied: copy.split("data:image/png").length - 1,
        };
      } finally {
        await browser.switchFrame(null);
      }
    }

    /**
     * The elements that do not apply, which the copy keeps as the page has
     * them, and the missing file's link, which stays a link.
     */
    const KEPT: Record<string, { page: string[]; shadow: string[] }> = {
      "Style sets.html": {
        page: [
          "Style sets/missing.css",
          ...["b1", "alt2", "p1", "sp"].map((id) => `${id}-link`),
          ...["sb", "sl", "svgb"].map((id) => `${id}-style`),
        ].sort(),
        shadow: ["halt-link"],
      },
      "Default style.html": { page: ["ma-link", "msa-style"], shadow: [] },
      "Bad href.html": { page: ["ba-link", "bad-link"], shadow: [] },
    };

    it("is measured against what Chromium applies to the same pages outside Obsidian", async function () {
      for (const page of PAGES)
        expect({ page, applied: (chromium[page] as ReturnType<typeof read>).applied }).toEqual({
          page,
          applied: APPLIED[page],
        });
    });

    it("reads and prepares only the stylesheets of the set that applies, and keeps the others as written", async function () {
      for (const page of PAGES) {
        await recordReads("Style sets/");
        await openInActiveTab(page);
        await waitForPage();
        await saveScreenshot(`style-sets-${PAGES.indexOf(page)}`);
        const result = { ...(await shown()), reads: await recordedReads() };
        expect({ page, ...result }).toEqual({
          page,
          applied: (chromium[page] as ReturnType<typeof read>).applied,
          kept: KEPT[page],
          copied: 0,
          reads: READS[page].map((id) => `Style sets/${id}.css`).sort(),
        });
        await restoreHost();
      }
    });

    it("copies only the files of the stylesheets of that set into a page with scripts on", async function () {
      await copyLocalFiles(true);
      try {
        await openInActiveTab("Style sets.html");
        await waitForPage();
        await clickToolbarButton("Scripts OFF");
        await waitForPage();
        await saveScreenshot("style-sets-scripts-on");
        const result = await shown();
        // The figure, once for each <style> that applies: sa, svga, and hs.
        expect({ applied: result.applied, copied: result.copied }).toEqual({
          applied: (chromium["Style sets.html"] as ReturnType<typeof read>).applied,
          copied: 3,
        });
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

  describe("with strings that image-set() takes as URLs (#179)", function () {
    // A stylesheet in another folder than the page names its square with
    // strings, which resolve against the stylesheet, as url()s do: the green
    // square beside it, not the red one of the same name beside the page.
    const SHEET = "Set strings/theme/site.css";
    const square = (id: string, css = "") =>
      `<div id="${id}" class="square"${css === "" ? "" : ` style='${css}'`}></div>`;
    const tree = [
      `<link rel="stylesheet" href="../${SHEET}">`,
      `<style>#own { background: image-set("../Set strings/theme/set-square.png" 1x) }</style>`,
      ...["set", "webkit", "typed", "own"].map((id) => square(id)),
      square("attribute", `background: image-set("../Set strings/theme/set-square.png" 1x)`),
      `<p id="text"></p>`,
    ].join("");
    const files: Record<string, string> = {
      [SHEET]: [
        `.square { display: inline-block; width: 64px; height: 64px }`,
        `#set { background: image-set("set-square.png" 1x) }`,
        `#webkit { background: -webkit-image-set("set-square.png" 1x) }`,
        `#typed { background: image-set("set-square.png" type("image/png") 1x) }`,
        // A bare string names nothing, and neither does a font format.
        `#text::after { content: "set-square.png" }`,
        `@font-face { font-family: Set; src: url(set.woff2) format("set-square.png") }`,
      ].join("\n"),
      "Saved/Set strings.html": `${tree}<div id="host"><template shadowrootmode="open">${tree}</template></div>`,
    };
    const IDS = ["set", "webkit", "typed", "own", "attribute"];

    before(async function () {
      await browser.executeObsidian(
        async ({ app }, files, green, red) => {
          for (const folder of ["Set strings", "Set strings/theme"])
            await app.vault.createFolder(folder);
          const binary = (base64: string) =>
            Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)).buffer;
          await app.vault.createBinary("Set strings/theme/set-square.png", binary(green));
          await app.vault.createBinary("Saved/set-square.png", binary(red));
          for (const [path, text] of Object.entries(files)) await app.vault.create(path, text);
        },
        files,
        solidPng(64, GREEN).toString("base64"),
        solidPng(64, RED).toString("base64"),
      );
    });

    after(async function () {
      await browser.executeObsidian(async ({ app }) => {
        for (const path of ["Saved/Set strings.html", "Saved/set-square.png", "Set strings"]) {
          const file = app.vault.getAbstractFileByPath(path);
          if (file) await app.vault.delete(file, true);
        }
      });
    });

    /**
     * Where each square's image comes from, in the document and in its shadow
     * root, and the text after the paragraph. Run inside the frame.
     */
    function read() {
      const where = (value: string) =>
        value.includes("/Set%20strings/theme/set-square.png")
          ? "beside the stylesheet"
          : value.includes("/Saved/set-square.png")
            ? "beside the page"
            : value;
      const tree = (root: Document | ShadowRoot) => ({
        squares: Object.fromEntries(
          [...root.querySelectorAll(".square")].map((square) => [
            square.id,
            where(getComputedStyle(square).backgroundImage),
          ]),
        ),
        text: getComputedStyle(root.querySelector("#text")!, "::after").content,
      });
      return { page: tree(document), shadow: tree(document.getElementById("host")!.shadowRoot!) };
    }

    function expected() {
      const tree = {
        squares: Object.fromEntries(IDS.map((id) => [id, "beside the stylesheet"])),
        text: '"set-square.png"',
      };
      return { page: tree, shadow: tree };
    }

    /** What the viewer's frame shows, asked inside it. */
    async function shown() {
      await browser.switchFrame(browser.$(`${ACTIVE} iframe.html-page-viewer__frame`));
      try {
        return await browser.execute(read);
      } finally {
        await browser.switchFrame(null);
      }
    }

    afterEach(async function () {
      await restoreHost();
    });

    it("is measured against what Chromium shows of the same page outside Obsidian", async function () {
      const served = await inServedPage(files, "Saved/Set strings.html", () =>
        browser.execute(read),
      );
      // The functions that Chromium supports, and a bare string as a font's source.
      const supported = await browser.execute(() => {
        const style = document.createElement("style");
        style.textContent = `@font-face { font-family: Bare; src: "set.woff2" }`;
        document.head.append(style);
        const bare = (style.sheet!.cssRules[0] as CSSFontFaceRule).style.getPropertyValue("src");
        style.remove();
        const image = (value: string) => CSS.supports("background-image", value);
        return {
          imageSet: image('image-set("a.png" 1x)'),
          webkitImageSet: image('-webkit-image-set("a.png" 1x)'),
          image: image('image("a.png")'),
          src: image('src("a.png")'),
          bare,
        };
      });
      expect({ served, supported }).toEqual({
        served: expected(),
        supported: { imageSet: true, webkitImageSet: true, image: false, src: false, bare: "" },
      });
    });

    it("resolves them against their stylesheet", async function () {
      await recordReads("Set strings/");
      await openInActiveTab("Saved/Set strings.html");
      await waitForPage();
      await saveScreenshot("image-set-strings");
      expect(await shown()).toEqual(expected());
      expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(2 * IDS.length * IMAGE_PIXELS * 0.9);
      expect(await framePixels(RED)).toBe(0);
      // Only the stylesheet is read as one.
      expect(await recordedReads()).toEqual([SHEET]);
    });

    it("copies their files into a page with scripts on", async function () {
      await copyLocalFiles(true);
      try {
        await openInActiveTab("Saved/Set strings.html");
        await clickToolbarButton("Scripts OFF");
        await waitForPage();
        await saveScreenshot("image-set-strings-scripts-on");
        expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(
          2 * IDS.length * IMAGE_PIXELS * 0.9,
        );
        expect(await framePixels(RED)).toBe(0);
      } finally {
        await clickToolbarButton("Scripts ON");
        await copyLocalFiles(false);
      }
    });
  });

  describe("with a <base> after the page's stylesheets (#185)", function () {
    // Each square names "Late img/sq.png": green beside the page, and blue in
    // the folder of the page's <base>, which comes after most of them. Two
    // pages have a <base> that Chromium ignores: one inside SVG, whose folder
    // has a red image of that name, and one of a data: URL.
    const url = `url("Late img/sq.png")`;
    const square = (id: string, style = "") =>
      `<div id="${id}" class="sq"${style === "" ? "" : ` style='${style}'`}></div>`;
    const sheets = {
      "Saved/Late sheet.css": `#imported { background: ${url} }`,
      "Saved/Late link.css": `#linked { background: ${url} }`,
      "Saved/Late base/Late sheet.css": `#imported { background: ${url} }`,
      "Saved/Late base/Late link.css": `#linked { background: ${url} }`,
    };
    const page = [
      `<style>.sq { display: inline-block; width: 64px; height: 64px } #own { background: ${url} }</style>`,
      `<style>@import "Late sheet.css";</style>`,
      `<link rel="stylesheet" href="Late link.css">`,
      `<svg width="0" height="0"><style>#svg { background: ${url} }</style></svg>`,
      ...["own", "imported", "linked", "svg"].map((id) => square(id)),
      square("attribute", `background: ${url}`),
      `<div><template shadowrootmode="open"><style>.sq { display: inline-block; width: 64px; height: 64px } #shadow { background: ${url} }</style>`,
      `${square("shadow")}${square("shadowattribute", `background: ${url}`)}</template></div>`,
      `<template id="later"><style>#later { background: ${url} }</style>${square("later")}</template>`,
      `<base href="Late base/">`,
      `<style>#after { background: ${url} }</style>${square("after")}`,
      square("afterattribute", `background: ${url}`),
      `<script>document.body.append(document.getElementById("later").content.cloneNode(true));</script>`,
    ].join("");
    const ignored = (base: string) =>
      `${base}<style>.sq { display: inline-block; width: 64px; height: 64px } #ignored { background: ${url} }</style>${square("ignored")}`;
    const files: Record<string, string> = {
      ...sheets,
      "Saved/Late base.html": page,
      "Saved/SVG base.html": ignored(`<svg width="0" height="0"><base href="Elsewhere/"/></svg>`),
      "Saved/Data base.html": ignored(`<base href="data:text/html,x">`),
    };
    const IGNORED = ["Saved/SVG base.html", "Saved/Data base.html"];
    const BEFORE = ["own", "imported", "linked", "svg", "attribute", "shadow", "shadowattribute"];
    const AFTER = ["after", "afterattribute"];

    before(async function () {
      await browser.executeObsidian(
        async ({ app }, files, green, blue, red) => {
          for (const folder of [
            "Saved/Late img",
            "Saved/Late base",
            "Saved/Late base/Late img",
            "Saved/Elsewhere",
            "Saved/Elsewhere/Late img",
          ])
            await app.vault.createFolder(folder);
          const binary = (base64: string) =>
            Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)).buffer;
          await app.vault.createBinary("Saved/Late img/sq.png", binary(green));
          await app.vault.createBinary("Saved/Late base/Late img/sq.png", binary(blue));
          await app.vault.createBinary("Saved/Elsewhere/Late img/sq.png", binary(red));
          for (const [path, text] of Object.entries(files)) await app.vault.create(path, text);
        },
        files,
        solidPng(64, GREEN).toString("base64"),
        solidPng(64, BLUE).toString("base64"),
        solidPng(64, RED).toString("base64"),
      );
    });

    after(async function () {
      await browser.executeObsidian(async ({ app }) => {
        for (const path of [
          "Saved/Late base.html",
          "Saved/SVG base.html",
          "Saved/Data base.html",
          "Saved/Elsewhere",
          "Saved/Late sheet.css",
          "Saved/Late link.css",
          "Saved/Late img",
          "Saved/Late base",
        ]) {
          const file = app.vault.getAbstractFileByPath(path);
          if (file) await app.vault.delete(file, true);
        }
      });
    });

    /** Which folder each square's image comes from, in the document and its shadow roots. Run inside the frame. */
    function read() {
      const where = (element: Element) => {
        const value = getComputedStyle(element).backgroundImage;
        return value.includes("/Saved/Late%20base/Late%20img/sq.png")
          ? "the <base>'s folder"
          : value.includes("/Saved/Late%20img/sq.png")
            ? "the page's folder"
            : value;
      };
      const squares: Record<string, string> = {};
      const visit = (root: Document | ShadowRoot) => {
        for (const element of root.querySelectorAll(".sq")) squares[element.id] = where(element);
        for (const host of root.querySelectorAll("*"))
          if (host.shadowRoot !== null) visit(host.shadowRoot);
      };
      visit(document);
      return squares;
    }

    /** Where each square's image comes from in Chromium, with or without the template's square. */
    function expected(later: boolean) {
      return Object.fromEntries([
        ...BEFORE.map((id) => [id, "the page's folder"]),
        ...[...AFTER, ...(later ? ["later"] : [])].map((id) => [id, "the <base>'s folder"]),
      ]);
    }

    async function shown() {
      await browser.switchFrame(browser.$(`${ACTIVE} iframe.html-page-viewer__frame`));
      try {
        return await browser.execute(read);
      } finally {
        await browser.switchFrame(null);
      }
    }

    it("is measured against what Chromium shows of the same page outside Obsidian", async function () {
      const late = await inServedPage(files, "Saved/Late base.html", () => browser.execute(read));
      const ignored: Record<string, string>[] = [];
      for (const page of IGNORED)
        ignored.push(await inServedPage(files, page, () => browser.execute(read)));
      expect({ late, ignored }).toEqual({
        late: expected(true),
        ignored: IGNORED.map(() => ({ ignored: "the page's folder" })),
      });
    });

    it("resolves the stylesheets before it against the page, and the others against it", async function () {
      await openInActiveTab("Saved/Late base.html");
      await waitForPage();
      await saveScreenshot("late-base");
      expect(await shown()).toEqual(expected(false));
      expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(BEFORE.length * IMAGE_PIXELS * 0.9);
      expect(await framePixels(BLUE)).toBeGreaterThanOrEqual(AFTER.length * IMAGE_PIXELS * 0.9);
    });

    it("ignores a <base> that Chromium ignores", async function () {
      const shownIn: Record<string, unknown> = {};
      for (const ignored of IGNORED) {
        await openInActiveTab(ignored);
        await waitForPage();
        shownIn[ignored] = await shown();
      }
      expect(shownIn).toEqual(
        Object.fromEntries(IGNORED.map((page) => [page, { ignored: "the page's folder" }])),
      );
    });

    it("copies the files that each resolves to into a page with scripts on, also in a template's content", async function () {
      await copyLocalFiles(true);
      try {
        await openInActiveTab("Saved/Late base.html");
        await clickToolbarButton("Scripts OFF");
        await waitForPage();
        await saveScreenshot("late-base-scripts-on");
        // The template's square, which the page's script adds, resolves against the <base>.
        const green = await framePixels(GREEN);
        const blue = await framePixels(BLUE);
        expect({
          green: Math.round(green / IMAGE_PIXELS),
          blue: Math.round(blue / IMAGE_PIXELS),
        }).toEqual({ green: BEFORE.length, blue: AFTER.length + 1 });
      } finally {
        await clickToolbarButton("Scripts ON");
        await copyLocalFiles(false);
      }
    });
  });

  describe("with a <base> after the page's images, media, frames, and scripts (#187)", function () {
    // Each element names a file of its own in "Late res/": green, or the
    // word "page", beside the page, and blue, or "base", in the folder of the
    // page's <base>, which comes after them, also after a declarative shadow
    // root. After it come a repeat of the first image, which Chromium
    // resolves anew against the <base>, an SVG <image>, and a template's
    // image, which the page's script adds. Chromium resolves media, their
    // sources, text tracks, and SVG <image> when it starts to load them, soon
    // after it parses them: the served page's script, just before the <base>,
    // arrives late, so that Chromium has resolved them before it parses the
    // <base>, as in most measured pages (TESTING.md's limits).
    const res = "Late res";
    const image = (name: string) => `<img src="${res}/${name}.png" width="64" height="64">`;
    const svgImages = (first: string, second: string) =>
      `<svg width="128" height="64"><image href="${res}/${first}.png" width="64" height="64"/>` +
      `<image xlink:href="${res}/${second}.png" x="64" width="64" height="64"/></svg>`;
    const elements = [
      `<style>body { margin: 0 } img, input, video { vertical-align: top; margin: 0; border: 0 }</style>`,
      image("repeat"),
      // Unescaped, a srcset's space would end its URL.
      `<img srcset="Late%20res/srcset.png 1x" width="64" height="64">`,
      `<picture><source srcset="Late%20res/source.png"><img width="64" height="64"></picture>`,
      `<input type="image" src="${res}/input.png" width="64" height="64">`,
      `<video id="poster" poster="${res}/poster.png" width="64" height="64"></video>`,
      `<video id="video" src="${res}/video.webm" width="1" height="1"></video>`,
      `<video id="vsource" width="1" height="1"><source src="${res}/vsource.webm">`,
      `<track id="track" default kind="subtitles" src="${res}/track.vtt"></video>`,
      `<audio id="audio" src="${res}/audio.wav"></audio>`,
      `<iframe id="frame" src="${res}/frame.html" width="1" height="1"></iframe>`,
      `<svg width="0" height="0" style="position: absolute"><use id="use" href="${res}/use.svg#s"/>`,
      `<use id="xuse" xlink:href="${res}/xuse.svg#s"/></svg>`,
      svgImages("image", "ximage"),
      `<div id="host"><template shadowrootmode="open">${image("shadow")}`,
      `<video src="${res}/shadow.webm" width="1" height="1"></video></template></div>`,
      `<template id="later">${image("later")}</template>`,
      `<script src="${res}/script.js"></script>`,
      `<base href="Late attributes/">`,
      image("repeat"),
      svgImages("afterimage", "afterximage"),
      `<script>document.body.append(document.getElementById("later").content.cloneNode(true));</script>`,
    ];
    /** The files that the elements before the <base> name, which Chromium resolves against the page. */
    const BEFORE = [
      ...["srcset.png", "source.png", "input.png", "poster.png", "video.webm", "vsource.webm"],
      ...["track.vtt", "audio.wav", "frame.html", "use.svg", "xuse.svg", "image.png"],
      ...["ximage.png", "shadow.png", "shadow.webm", "script.js"],
    ];
    const files: Record<string, string | Buffer> = {
      "Saved/Late attributes.html": elements.join("\n"),
    };
    for (const [folder, color, word] of [
      [`Saved/${res}`, GREEN, "page"],
      [`Saved/Late attributes/${res}`, BLUE, "base"],
    ] as const) {
      const hex = `#${color.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
      for (const name of [
        ...["repeat", "srcset", "source", "input", "poster", "shadow", "later"],
        ...["image", "ximage", "afterimage", "afterximage"],
      ])
        files[`${folder}/${name}.png`] = solidPng(64, color);
      for (const name of ["use", "xuse"])
        files[`${folder}/${name}.svg`] =
          `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="s"><rect width="8" height="8" fill="${hex}"/></symbol></svg>`;
      for (const name of ["video.webm", "vsource.webm", "shadow.webm", "audio.wav"])
        files[`${folder}/${name}`] = word;
      files[`${folder}/track.vtt`] = `WEBVTT\n\n00:00.000 --> 01:00.000\n${word}\n`;
      files[`${folder}/frame.html`] = `<p>${word}</p>`;
      files[`${folder}/script.js`] = `window.lateScript = "${word}";`;
    }

    before(async function () {
      await createVaultFiles(files);
    });

    after(async function () {
      await deleteVaultPaths([
        "Saved/Late attributes.html",
        `Saved/${res}`,
        "Saved/Late attributes",
      ]);
    });

    /** "page" or "base" for a URL of a file in either folder, or the URL. */
    function folderOf(url: string): string {
      const path = decodeURIComponent(url);
      return path.includes("/Late attributes/Late res/")
        ? "base"
        : path.includes("/Late res/")
          ? "page"
          : url;
    }

    /** Waits in the current frame until its text track has loaded, or failed to. */
    async function trackLoaded(): Promise<void> {
      await browser.waitUntil(
        () =>
          browser.execute(
            () => (document.getElementById("track") as HTMLTrackElement).readyState >= 2,
          ),
        { timeout: 10_000, timeoutMsg: "the text track did not load" },
      );
    }

    it("is measured against what Chromium resolves in the same page outside Obsidian", async function () {
      const requests: string[] = [];
      const shown = await inServedPage(
        files,
        "Saved/Late attributes.html",
        async () => {
          await trackLoaded();
          return browser.execute(() => {
            const repeats = document.querySelectorAll<HTMLImageElement>('img[src$="repeat.png"]');
            const track = document.getElementById("track") as HTMLTrackElement;
            const frame = document.getElementById("frame") as HTMLIFrameElement;
            return {
              repeat: [...repeats].map((repeat) => repeat.currentSrc),
              track: (track.track.cues?.[0] as VTTCue | undefined)?.text ?? null,
              frame: frame.contentDocument?.body.textContent ?? null,
              script: (window as { lateScript?: string }).lateScript ?? null,
            };
          });
        },
        { requests, delayed: [`Saved/${res}/script.js`] },
      );
      // The folders that the requests for each file name.
      const requested: Record<string, string[]> = {};
      for (const request of requests) {
        if (!request.includes(`/${res}/`)) continue;
        const name = request.split("/").at(-1)!;
        requested[name] = [...new Set([...(requested[name] ?? []), folderOf(request)])].sort();
      }
      expect({
        before: Object.fromEntries(BEFORE.map((name) => [name, requested[name]])),
        after: ["later.png", "afterimage.png", "afterximage.png"].map((name) => requested[name]),
        repeat: shown.repeat.map(folderOf),
        track: shown.track,
        frame: shown.frame,
        script: shown.script,
      }).toEqual({
        before: Object.fromEntries(BEFORE.map((name) => [name, ["page"]])),
        after: [["base"], ["base"], ["base"]],
        repeat: ["page", "base"],
        track: "page",
        frame: "page",
        script: "page",
      });
    });

    /**
     * Where each element's URL leads in the viewer's copy, whose own <base>
     * comes first. Run inside the frame.
     */
    function resolved() {
      const at = (selector: string) =>
        document.querySelector(selector) as HTMLElement & Record<string, string>;
      const url = (value: string | null) => new URL(value ?? "", document.baseURI).href;
      const xlink = "http://www.w3.org/1999/xlink";
      const shadow = document.getElementById("host")!.shadowRoot!;
      const repeats = document.querySelectorAll<HTMLImageElement>('img[src$="repeat.png"]');
      return {
        repeat: [...repeats].map((repeat) => repeat.currentSrc),
        srcset: at("img[srcset]").currentSrc,
        source: at("picture img").currentSrc,
        input: at("input").src,
        poster: at("#poster").poster,
        video: at("#video").currentSrc,
        vsource: at("#vsource").currentSrc,
        track: at("#track").src,
        audio: at("#audio").currentSrc,
        frame: at("#frame").src,
        script: at("script[src]").src,
        use: url(at("#use").getAttribute("href")),
        xuse: url(at("#xuse").getAttributeNS(xlink, "href")),
        images: [...document.querySelectorAll("svg image")].map((image) =>
          url(image.getAttribute("href") ?? image.getAttributeNS(xlink, "href")),
        ),
        shadow: (shadow.querySelector("img") as HTMLImageElement).currentSrc,
        shadowvideo: (shadow.querySelector("video") as HTMLVideoElement).currentSrc,
      };
    }

    it("resolves the ones before it against the page, and the others against it", async function () {
      await openInActiveTab("Saved/Late attributes.html");
      await waitForPage();
      await saveScreenshot("late-attributes");
      const shown = await inViewerFrame(() => browser.execute(resolved));
      const folders = Object.fromEntries(
        Object.entries(shown).map(([name, value]) => [
          name,
          Array.isArray(value) ? value.map(folderOf) : folderOf(value),
        ]),
      );
      expect(folders).toEqual({
        repeat: ["page", "base"],
        ...Object.fromEntries(
          [
            ...["srcset", "source", "input", "poster", "video", "vsource", "track", "audio"],
            ...["frame", "script", "use", "xuse", "shadow", "shadowvideo"],
          ].map((name) => [name, "page"]),
        ),
        images: ["page", "page", "base", "base"],
      });
      // The images that load with scripts off: the first, the srcset's, the
      // picture's, the input's, the SVG ones, and the shadow root's from
      // beside the page; the repeat and the SVG ones after the <base> from
      // its folder.
      expect({
        green: Math.round((await framePixels(GREEN)) / IMAGE_PIXELS),
        blue: Math.round((await framePixels(BLUE)) / IMAGE_PIXELS),
      }).toEqual({ green: 7, blue: 3 });
    });

    it("copies the files that each resolves to into a page with scripts on, also in a template's content", async function () {
      await copyLocalFiles(true);
      try {
        await openInActiveTab("Saved/Late attributes.html");
        await clickToolbarButton("Scripts OFF");
        await waitForPage();
        await saveScreenshot("late-attributes-scripts-on");
        const copied = await inViewerFrame(async () => {
          await trackLoaded();
          return browser.execute(() => {
            const word = (url: string) => (url.startsWith("data:") ? atob(url.split(",")[1]) : url);
            const shadow = document.getElementById("host")!.shadowRoot!;
            const media = [
              ...document.querySelectorAll("video[src], video source, audio"),
              ...shadow.querySelectorAll("video"),
            ].map((element) => word((element as HTMLMediaElement | HTMLSourceElement).src));
            const track = document.getElementById("track") as HTMLTrackElement;
            return {
              media,
              track: (track.track.cues?.[0] as VTTCue | undefined)?.text ?? null,
              script: (window as { lateScript?: string }).lateScript ?? null,
            };
          });
        });
        expect({
          ...copied,
          // The repeat, the SVG images after the <base>, and the template's
          // image, which the script adds, come from the <base>'s folder.
          green: Math.round((await framePixels(GREEN)) / IMAGE_PIXELS),
          blue: Math.round((await framePixels(BLUE)) / IMAGE_PIXELS),
        }).toEqual({
          media: ["page", "page", "page", "page"],
          track: "page",
          script: "page",
          green: 8,
          blue: 4,
        });
      } finally {
        await clickToolbarButton("Scripts ON");
        await copyLocalFiles(false);
      }
    });
  });

  describe("with links and URL attributes that hold other spaces than HTML's (#192)", function () {
    // HTML splits a link's rel and a srcset, and strips a URL attribute, on
    // ASCII whitespace only. Each square has a stylesheet of its own, linked
    // with `stylesheet`, a space, and `x`: each of the other spaces that
    // JavaScript's \s matches, and four of ASCII's. An image names a file
    // with U+00A0 before its name, which is blue, as is one with U+00A0 in a
    // srcset's URL; the file of the name without it is green.
    const UNICODE_SPACES = [
      ...[0x0b, 0xa0, 0x1680],
      ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
      ...[0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff],
    ];
    const ASCII_SPACES: Record<string, string> = { space: " ", lf: "\n", tab: "\t", ff: "\f" };
    const spaces: Record<string, string> = {
      ...Object.fromEntries(
        UNICODE_SPACES.map((code) => [`u${code.toString(16)}`, String.fromCodePoint(code)]),
      ),
      ...ASCII_SPACES,
    };
    const nbsp = String.fromCodePoint(0xa0);
    const files: Record<string, string | Buffer> = {
      "Saved/Rel spaces.html": [
        `<style>.sq { display: inline-block; width: 16px; height: 16px }</style>`,
        ...Object.entries(spaces).map(
          ([id, space]) =>
            `<link rel="stylesheet${space}x" href="Rel spaces/${id}.css"><div id="${id}" class="sq"></div>`,
        ),
        `<img id="nbsp" src="${nbsp}Rel nb.png" width="64" height="64">`,
        `<img id="srcset" srcset="Rel${nbsp}set.png 1x" width="64" height="64">`,
      ].join("\n"),
      ...Object.fromEntries(
        Object.keys(spaces).map((id) => [
          `Saved/Rel spaces/${id}.css`,
          `#${id} { background: rgb(0, 128, 0) }`,
        ]),
      ),
      [`Saved/${nbsp}Rel nb.png`]: solidPng(64, BLUE),
      "Saved/Rel nb.png": solidPng(64, GREEN),
      [`Saved/Rel${nbsp}set.png`]: solidPng(64, BLUE),
    };

    before(async function () {
      // Obsidian's API names a file that it creates with a space for U+00A0,
      // so the files of such names are written as a sync tool would.
      const entries = Object.entries(files);
      await createVaultFiles(Object.fromEntries(entries.filter(([path]) => !path.includes(nbsp))));
      await writeFilesAsNamed(
        Object.fromEntries(
          entries.filter((entry): entry is [string, Buffer] => entry[0].includes(nbsp)),
        ),
      );
    });

    after(async function () {
      await deleteVaultPaths(Object.keys(files).filter((path) => !path.includes("/Rel spaces/")));
      await deleteVaultPaths(["Saved/Rel spaces"]);
    });

    afterEach(async function () {
      await restoreHost();
    });

    /** Which squares a stylesheet colors, and the file that each image shows. Run inside the frame. */
    function read() {
      const applied: Record<string, boolean> = {};
      for (const square of document.querySelectorAll(".sq"))
        applied[square.id] = getComputedStyle(square).backgroundColor === "rgb(0, 128, 0)";
      const file = (id: string) => {
        const source = document.querySelector<HTMLImageElement>(`#${id}`)!.currentSrc;
        return decodeURIComponent(new URL(source).pathname.split("/").at(-1)!);
      };
      return {
        applied,
        images: { nbsp: file("nbsp"), srcset: file("srcset") },
        chromium: Number(/Chrome\/(\d+)/.exec(navigator.userAgent)?.[1]),
      };
    }

    /** The squares that ASCII whitespace splits from `stylesheet`, on Chromium of this major version. */
    function applied(chromium: number) {
      // Chromium 114, in Obsidian 1.5.3, splits rel only on spaces and line
      // feeds; 1.15.1 on ASCII whitespace, as the viewer does.
      const split = chromium === 114 ? ["space", "lf"] : Object.keys(ASCII_SPACES);
      return Object.fromEntries(Object.keys(spaces).map((id) => [id, split.includes(id)]));
    }

    it("is measured against what Chromium applies to the same page outside Obsidian", async function () {
      const served = await inServedPage(files, "Saved/Rel spaces.html", () =>
        browser.execute(read),
      );
      expect(served).toEqual({
        applied: applied(served.chromium),
        images: { nbsp: `${nbsp}Rel nb.png`, srcset: `Rel${nbsp}set.png` },
        chromium: served.chromium,
      });
    });

    it("reads and applies only the links whose stylesheet type ASCII whitespace splits off", async function () {
      await recordReads("Saved/Rel spaces/");
      await openInActiveTab("Saved/Rel spaces.html");
      await waitForPage();
      const shown = await inViewerFrame(() => browser.execute(read));
      expect({ ...shown, reads: await recordedReads() }).toEqual({
        applied: applied(0),
        images: { nbsp: `${nbsp}Rel nb.png`, srcset: `Rel${nbsp}set.png` },
        chromium: shown.chromium,
        reads: Object.keys(ASCII_SPACES)
          .map((id) => `Saved/Rel spaces/${id}.css`)
          .sort(),
      });
    });

    it("copies the files that such URLs name into a page with scripts on", async function () {
      await copyLocalFiles(true);
      try {
        await openInActiveTab("Saved/Rel spaces.html");
        await clickToolbarButton("Scripts OFF");
        await waitForPage();
        await saveScreenshot("rel-spaces-scripts-on");
        expect({
          blue: Math.round((await framePixels(BLUE)) / IMAGE_PIXELS),
          green: await framePixels(GREEN),
        }).toEqual({ blue: 2, green: 0 });
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

/** Creates vault files, text or binary, and the folders that they need. */
async function createVaultFiles(files: Record<string, string | Buffer>): Promise<void> {
  const entries = Object.entries(files).map(([path, body]) =>
    typeof body === "string"
      ? { path, text: body, base64: null }
      : { path, text: null, base64: body.toString("base64") },
  );
  await browser.executeObsidian(async ({ app }, entries) => {
    const folders = new Set<string>();
    for (const { path } of entries) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
    }
    for (const folder of [...folders].sort())
      if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
    for (const { path, text, base64 } of entries) {
      if (text !== null) await app.vault.create(path, text);
      else
        await app.vault.createBinary(
          path,
          Uint8Array.from(atob(base64!), (char) => char.charCodeAt(0)).buffer,
        );
    }
  }, entries);
}

/**
 * Writes binary files into the vault's folder by their exact paths, as a tool
 * outside Obsidian would, and waits until the vault lists them. Obsidian's
 * own API would change some characters of a name, such as U+00A0, which it
 * names a file with a space for.
 */
async function writeFilesAsNamed(files: Record<string, Buffer>): Promise<void> {
  const entries = Object.entries(files).map(([path, body]) => ({
    path,
    base64: body.toString("base64"),
  }));
  await browser.executeObsidian(async ({ app }, entries) => {
    const adapter = app.vault.adapter as unknown as {
      writeBinary(path: string, data: ArrayBuffer): Promise<void>;
    };
    for (const { path, base64 } of entries)
      await adapter.writeBinary(
        path,
        Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)).buffer,
      );
  }, entries);
  await browser.waitUntil(
    () =>
      browser.executeObsidian(
        ({ app }, paths) => paths.every((path) => app.vault.getAbstractFileByPath(path) !== null),
        Object.keys(files),
      ),
    { timeout: 10_000, timeoutMsg: "the vault did not list the files written by their names" },
  );
}

/** Deletes vault files and folders, with what the folders hold. */
async function deleteVaultPaths(paths: string[]): Promise<void> {
  await browser.executeObsidian(async ({ app }, paths) => {
    for (const path of paths) {
      const file = app.vault.getAbstractFileByPath(path);
      if (file) await app.vault.delete(file, true);
    }
  }, paths);
}

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

/** The content types that {@link inServedPage} serves files with, by extension; HTML otherwise. */
const SERVED_TYPES: Readonly<Record<string, string>> = {
  css: "text/css",
  js: "text/javascript",
  png: "image/png",
  svg: "image/svg+xml",
  vtt: "text/vtt",
};

/**
 * Serves `files`, by their vault paths, over HTTP from this process, loads
 * `page` from there in a frame of Obsidian's window without a sandbox, and
 * runs `read` inside the frame once the page and its stylesheets have loaded.
 * Chromium then shows the page as a browser does, with neither the plugin nor
 * the policy of Obsidian's that a `srcdoc` frame inherits between them, which
 * allows only inline styles. A vault page cannot show this: Obsidian serves
 * vault files only to its own origin (#147). `requests` gets the vault path
 * that each request names, in order. The files that `delayed` names are
 * served 0.3 s late, as over a slow network: the parser waits for a script
 * among them.
 */
async function inServedPage<T>(
  files: Record<string, string | Buffer>,
  page: string,
  read: () => Promise<T>,
  { requests = [], delayed = [] }: { requests?: string[]; delayed?: readonly string[] } = {},
): Promise<T> {
  const server = http.createServer((request, response) => {
    let name = "";
    try {
      name = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.slice(1));
    } catch {
      // A malformed request names no file.
    }
    requests.push(name);
    const body = Object.hasOwn(files, name) ? files[name] : undefined;
    const send = () => {
      response.writeHead(body === undefined ? 404 : 200, {
        "Content-Type": SERVED_TYPES[path.extname(name).slice(1)] ?? "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(body ?? "");
    };
    if (delayed.includes(name)) setTimeout(send, 300);
    else send();
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

/**
 * Runs `read` inside the active tab's frame, which a page with scripts on
 * keeps from the window, but not from WebDriver.
 */
async function inViewerFrame<T>(read: () => Promise<T>): Promise<T> {
  await browser.switchFrame(browser.$(`${ACTIVE} iframe.html-page-viewer__frame`));
  try {
    return await read();
  } finally {
    await browser.switchFrame(null);
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
