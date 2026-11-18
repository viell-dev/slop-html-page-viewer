import fs from "node:fs";
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

  describe("with stylesheet imports (#136, #139, #144)", function () {
    const green = "rgb(46, 125, 50)";
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
    ].join("\n");
    const paragraphs = ["string", "comment", "url", "block", "ghost", "placed", "bom", "layered"]
      .map((id) => `<p id="${id}">${id}</p>`)
      .join("");
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

    /** The colors and generated content of the page's paragraphs, and its shadow root's. */
    async function shown() {
      // Asked inside the frame, which a page with scripts on keeps from the window.
      await browser.switchFrame(browser.$(`${ACTIVE} iframe.html-page-viewer__frame`));
      try {
        return await browser.execute(() => {
          const read = (root: Document | ShadowRoot) =>
            Object.fromEntries(
              [...root.querySelectorAll("p[id]")].map((p) => [
                p.id,
                { color: getComputedStyle(p).color, after: getComputedStyle(p, "::after").content },
              ]),
            );
          const sheets = [...document.querySelectorAll("style")].map((s) => s.textContent ?? "");
          return {
            page: read(document),
            shadow: read(document.querySelector("#host")!.shadowRoot!),
            layered: sheets.find((text) => text.includes("layer;")) ?? null,
          };
        });
      } finally {
        await browser.switchFrame(null);
      }
    }

    /** What the page shows of each case, in the document and in its shadow root. */
    function cases(result: Awaited<ReturnType<typeof shown>>) {
      const plain = result.page.plain.color;
      return [result.page, result.shadow].map((root) => ({
        string: root.string,
        url: root.url,
        comment: root.comment.color,
        block: root.block.color,
        ghost: root.ghost.color === plain ? "not applied" : root.ghost.color,
        placed: root.placed.color,
        bom: root.bom.color,
        layered: root.layered.color === plain ? "not applied" : root.layered.color,
      }));
    }

    const expected = {
      string: { color: green, after: '"url(Saved/2026-01-15/figure.png)"' },
      url: { color: green, after: '"x) url(Saved/2026-01-15/figure.png)"' },
      comment: green,
      block: green,
      ghost: "not applied",
      placed: green,
      bom: green,
      // The layered import stays an import, which Obsidian's policy does not
      // load into the page, as with any import of a vault stylesheet.
      layered: "not applied",
    };

    it("applies only the imports that CSS applies, and the rules after them", async function () {
      await openInActiveTab("Import rules.html");
      await waitForPage();
      const result = await shown();
      expect({
        cases: cases(result),
        layered:
          /^@import url\("app:\/\/[^"]+\/Import%20rules\/layered\.css"\) \/\*\*\/ layer;$/.test(
            result.layered ?? "",
          ),
      }).toEqual({ cases: [expected, expected], layered: true });
    });

    it("copies no file that only string text names, with scripts on", async function () {
      await copyLocalFiles(true);
      try {
        await openInActiveTab("Import rules.html");
        await clickToolbarButton("Scripts OFF");
        await waitForPage();
        expect(cases(await shown())).toEqual([expected, expected]);
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
      // About 0.3 s in Obsidian 1.5.3 and 1.15.1, against hours without the
      // limits; the margin is for slower hosts.
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
