import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./support/dom";
import {
  preparePage,
  SHADOW_ROOT_MARK,
  STYLE_ELEMENT_LIMIT,
  STYLESHEET_COUNT_LIMIT,
  STYLESHEET_TEXT_LIMIT,
} from "../src/document";

// Pages at the sizes that once broke preparing them. Each takes seconds in
// jsdom, so `npm run test:stress` runs them apart from `npm test`; CI runs
// both.

const VAULT = "app://vault-id/home/user/My%20Vault/";
const context = {
  pageUrl: `${VAULT}Saved/Example%20article.html`,
  vaultUrl: VAULT,
  read: () => Promise.resolve(null),
};

describe("preparing a large page", () => {
  it("declares open every shadow root of a page with more of them than a call takes arguments", async () => {
    // V8 refuses a call with about 125,000 arguments or more.
    const count = 130_000;
    const inner = `<template shadowrootmode="closed"></template>`.repeat(count);
    const html = `<div><template shadowrootmode="open">${inner}</template></div>`;
    const { html: output } = await preparePage(html, context, { openShadowRoots: true });
    assert.equal(output.split(`shadowrootmode="open"`).length - 1, count + 1);
    assert.equal(output.split(SHADOW_ROOT_MARK).length - 1, count + 1);
    assert.doesNotMatch(output, /closed/);
  });
});

describe("preparing a page whose stylesheets import each other many times (#154)", () => {
  /** Imports that each stylesheet has, of the next one. */
  const FAN = 10;

  /** The stylesheet at a level of the chain, with `rules` after its own. */
  function sheet(level: number, rules: string): string {
    const imports = Array.from({ length: FAN }, () => `@import "${level + 1}.css";`);
    return `${imports.join("\n")}\n.level${level} { color: red }\n${rules}`;
  }

  /**
   * Eight stylesheets, each importing the next ten times, linked from a page:
   * eleven million stylesheets eight deep, if nothing bounded how many the
   * copy takes in. By extrapolation from the rates measured in #154, that copy
   * would pass V8's longest string within a minute or two and fail there.
   * Each import that preparation looks at asks whether its file exists; past
   * twice as many as the limits allow, the context fails the preparation, so
   * that a missing limit fails the test within a second.
   */
  async function prepareFanOut(rules: string) {
    const reads: string[] = [];
    let looked = 0;
    const most = 2 * FAN * (STYLESHEET_COUNT_LIMIT + 1);
    const ctx = {
      ...context,
      async read(path: string) {
        reads.push(path);
        return sheet(Number(/^Saved\/(\d)\.css$/.exec(path)?.[1]), rules);
      },
      exists() {
        looked += 1;
        if (looked > most) throw new Error(`preparation looked at more than ${most} imports`);
        return true;
      },
      locate: () => null,
    };
    const { html } = await preparePage('<link rel="stylesheet" href="0.css">', ctx);
    const doc = new DOMParser().parseFromString(html, "text/html");
    // The imports past the limits stay imports, each with the stylesheets
    // after it in a <style> of its own (#152).
    const styles = [...doc.querySelectorAll("style")].map((style) => style.textContent);
    const text = styles.join("");
    return { reads, text, styles, copies: text.split("{ color: red }\n").length - 1 };
  }

  it("takes in as many small stylesheets as the limit allows, reading each file once", async () => {
    const { reads, text, styles, copies } = await prepareFanOut("");
    assert.deepEqual(
      reads,
      Array.from({ length: 8 }, (_, i) => `Saved/${i}.css`),
    );
    assert.equal(copies, STYLESHEET_COUNT_LIMIT);
    // A stylesheet's imports left as imports, one after another, share one.
    assert.ok(styles.length <= STYLESHEET_COUNT_LIMIT, `${styles.length} <style> elements`);
    // The rest stay imports, which Obsidian's policy keeps from loading.
    assert.equal(
      text.split('@import url("').length - 1,
      FAN * STYLESHEET_COUNT_LIMIT - (STYLESHEET_COUNT_LIMIT - 1),
    );
    // Depth first: the first chain is whole, eight files deep.
    assert.ok(text.indexOf(".level7") < text.indexOf(".level1 "));
  });

  it("takes in as much of larger stylesheets' text as the limit allows", async () => {
    const rule = 'a.card:hover { color: blue; content: "example"; } /* ordinary comment */\n';
    const rules = rule.repeat(Math.ceil(20_000 / rule.length));
    const { text, copies } = await prepareFanOut(rules);
    // Every level's file has the same length, and each of its imports takes
    // the length that it would have as a kept import, made absolute (#177),
    // so as many fit as the limit holds.
    const kept =
      `@import url("${context.vaultUrl}Saved/1.css");`.length - '@import "1.css";'.length;
    const fit = Math.floor(STYLESHEET_TEXT_LIMIT / (sheet(0, rules).length + FAN * kept));
    assert.ok(fit < STYLESHEET_COUNT_LIMIT);
    assert.equal(copies, fit);
    assert.ok(text.length <= STYLESHEET_TEXT_LIMIT, `${text.length} characters`);
  });

  it("shows whole a page of thousands of components that each link or import the same stylesheet", async () => {
    // Declarative shadow roots that share a stylesheet each link it: work that
    // grows with the page, not with a power of it, which the limits leave alone.
    const rule = ".item > .label { color: rgb(46, 125, 50); padding: 0 4px }\n";
    const item = `@import "tokens.css";\n${rule.repeat(Math.ceil(1_900 / rule.length))}`;
    const tokens = ":host { --gap: 4px; --size: 1rem }";
    const reads: string[] = [];
    const ctx = {
      ...context,
      read(path: string) {
        reads.push(path);
        return Promise.resolve(
          { "Saved/item.css": item, "Saved/tokens.css": tokens }[path] ?? null,
        );
      },
    };
    const count = 4_000;
    const component = (sheet: string) =>
      `<x-item><template shadowrootmode="open">${sheet}<p class="label">x</p></template></x-item>`;
    const html = [
      ...Array<string>(count / 2).fill(component('<link rel="stylesheet" href="item.css">')),
      ...Array<string>(count / 2).fill(component('<style>@import "item.css";</style>')),
    ].join("");
    const { html: output } = await preparePage(html, ctx);
    // Read from the copy's text: parsing it again in jsdom would take longer
    // than preparing it.
    const sheet = `<template shadowrootmode="open"><style>${item.replace('@import "tokens.css";', tokens)}</style><p`;
    assert.equal(output.split(sheet).length - 1, count);
    assert.doesNotMatch(output, /<link|@import/);
    assert.deepEqual(reads, ["Saved/item.css", "Saved/tokens.css"]);
  });
});

describe("preparing a page whose stylesheets name many URLs (#177)", () => {
  /** A vault at an ordinary path, as Obsidian names one on Linux. */
  const vault = `app://${"0123456789abcdef".repeat(2)}/home/user/Documents/My%20Vault/`;

  /**
   * Prepares a page with these files, which must not throw, and returns its
   * copy and how much longer it is than the page and its files.
   */
  async function prepareWith(html: string, files: Record<string, string>) {
    const ctx = {
      pageUrl: `${vault}Saved/Example%20article.html`,
      vaultUrl: vault,
      read: (path: string) => Promise.resolve(files[path.replace(/^Saved\//, "")] ?? null),
    };
    const { html: output } = await preparePage(html, ctx);
    const input = html.length + Object.values(files).reduce((sum, text) => sum + text.length, 0);
    return { output, added: output.length - input };
  }

  it("keeps the copy of stylesheets whose URLs it makes absolute within the text limit", async () => {
    // In #177, a link of the first stylesheet took the copy to 97 million
    // characters, 8.8 times the stylesheet, in 5.6 to 6.6 s; on main at
    // 6acb438, each of these added 78 or 82 million. Each stylesheet's text
    // fits within the limit, but not with its URLs, or its imports that stay
    // imports, made absolute.
    const urls = "a{b:url(c)}".repeat(1_000_000);
    const imports = '@import"a";'.repeat(1_000_000);
    const link = (href: string) => `<link rel="stylesheet" href="${href}">`;
    const kept = `@import url("${vault}Saved/urls.css");`;
    // Each case's page, its files, and the link or import that stays one.
    const cases: [string, string, Record<string, string>, string][] = [
      ["a link of URLs", link("urls.css"), { "urls.css": urls }, link("urls.css")],
      ["an import of URLs", '<style>@import "urls.css";</style>', { "urls.css": urls }, kept],
      [
        "an import of URLs in a linked stylesheet",
        link("main.css"),
        { "main.css": '@import "urls.css";', "urls.css": urls },
        kept,
      ],
      [
        "a link of imports that stay imports",
        link("imports.css"),
        { "imports.css": imports },
        link("imports.css"),
      ],
    ];
    for (const [name, html, files, left] of cases) {
      const { output, added } = await prepareWith(html, files);
      assert.ok(added <= STYLESHEET_TEXT_LIMIT, `${name}: ${added} characters added`);
      // A stylesheet that would pass the limit stays a link or an import, as
      // one too large does.
      assert.ok(output.includes(left), `${name}: no link or import left`);
    }
  });
});

describe("preparing a page whose links have long types (#147)", () => {
  it("trims a link type's whitespace in time that grows with the type's length", async () => {
    // A run of spaces inside the essence, with text after it: a trim that
    // tries the run from each of its positions takes quadratic time. A regular
    // expression that did took 12.7 s for this page in Node.js 24 on Windows,
    // and the scan from each end 52 ms.
    const spaces = " ".repeat(50_000);
    const ctx = {
      ...context,
      read: (path: string) => Promise.resolve(path === "Saved/a.css" ? ".a {}" : null),
    };
    const html = [
      `<link rel="stylesheet" type="x${spaces}x" href="a.css">`,
      `<link rel="stylesheet" type="${spaces}TEXT/CSS${spaces};${spaces}x" href="a.css">`,
    ].join("");
    const start = performance.now();
    const { html: output } = await preparePage(html, ctx);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 1_000, `${Math.round(elapsed)} ms`);
    // The first is not CSS and stays a link; the second is, and is replaced.
    const doc = new DOMParser().parseFromString(output, "text/html");
    assert.equal(doc.querySelectorAll("link").length, 1);
    assert.equal(doc.querySelector("link")!.getAttribute("type"), `x${spaces}x`);
    assert.equal(doc.querySelector("style")!.textContent, ".a {}");
  });
});

describe("preparing a page whose imports have long conditions or many kept imports (#151, #152)", () => {
  const FONTS = "https://fonts.googleapis.com/css2?family=Roboto";
  const WEB = "https://example.com/a.css";
  /** A media query list of about `length` characters. */
  const media = (length: number) => `screen${", print".repeat(Math.ceil(length / 7))}`;

  /**
   * Prepares a page with these files, which must not throw, and returns how
   * long its copy is, how many `<style>` elements it has, and how much longer
   * it is than the page and its files.
   */
  async function prepareWith(html: string, files: Record<string, string>) {
    const ctx = {
      ...context,
      importSupports: true,
      read: (path: string) => Promise.resolve(files[path.replace(/^Saved\//, "")] ?? null),
    };
    const { html: output } = await preparePage(html, ctx);
    const input = html.length + Object.values(files).reduce((sum, text) => sum + text.length, 0);
    return { output, styles: output.split("<style").length - 1, added: output.length - input };
  }

  it("keeps what conditions add to the copy within the text limit", async () => {
    // In the review of #174, these took the copy to 200 to 400 MB, or past
    // V8's longest string, where preparing failed: a long media query list or
    // layer name, written into each kept import of the stylesheet that it
    // imports or around each part of it, or copied onto each <style>.
    const pairs = (count: number) => `@import "e.css";@import "${WEB}";\n`.repeat(count);
    const cases: [string, string, Record<string, string>][] = [
      [
        "a media query list around 2,000 kept imports",
        `<style>@import "x.css" ${media(100_000)};</style>`,
        { "x.css": `@import "${WEB}";\n`.repeat(2_000) },
      ],
      [
        "the same with 6,000 imports on one line",
        `<style>@import "x.css" ${media(100_000)};</style>`,
        { "x.css": `@import "${WEB}";`.repeat(6_000) },
      ],
      [
        "a layer name around 10,000 kept imports",
        `<style>@import "x.css" layer(${"a".repeat(10_000)});</style>`,
        { "x.css": `@import "${WEB}";\n`.repeat(10_000) },
      ],
      [
        "a media query list around 999 parts",
        `<style>@import "x.css" ${media(100_000)};</style>`,
        { "x.css": pairs(999), "e.css": "a{}" },
      ],
      [
        "a media attribute on a <style> of 2,000 kept imports after rules",
        `<style media="${media(100_000)}">${pairs(2_000)}</style>`,
        { "e.css": "a{}" },
      ],
      [
        "the same with Google Fonts, whose imports matter where they are",
        `<style media="${media(100_000)}">${pairs(2_000).replaceAll(WEB, FONTS)}</style>`,
        { "e.css": "a{}" },
      ],
      [
        "a title on such a <style>",
        `<style title="${"t".repeat(100_000)}">${pairs(2_000).replaceAll(WEB, FONTS)}</style>`,
        { "e.css": "a{}" },
      ],
      [
        "a title on a link of such a stylesheet",
        `<link rel="stylesheet" href="main.css" title="${"t".repeat(100_000)}">`,
        { "main.css": pairs(2_000).replaceAll(WEB, FONTS), "e.css": "a{}" },
      ],
      [
        "a media query list around 2,000 Google Fonts imports",
        `<style>@import "x.css" ${media(100_000)};</style>`,
        { "x.css": `@import "${FONTS}";\n`.repeat(2_000) },
      ],
    ];
    for (const [name, html, files] of cases) {
      const { added } = await prepareWith(html, files);
      assert.ok(added <= STYLESHEET_TEXT_LIMIT, `${name}: ${added} characters added`);
    }
  });

  it("adds at most the limit's number of <style> elements", async () => {
    // A kept import that a block of its stylesheet's conditions holds, then
    // one that takes them: each of the second starts a stylesheet of its own.
    const x = `@import "${FONTS}" print;\n@import "${FONTS}";\n`.repeat(3 * STYLE_ELEMENT_LIMIT);
    const { output, styles } = await prepareWith('<style>@import "x.css" screen;</style>', {
      "x.css": x,
    });
    assert.equal(styles, STYLE_ELEMENT_LIMIT + 1);
    // The rest stay where they are.
    assert.equal(
      output.split(`@import url("${FONTS}") screen;`).length - 1,
      3 * STYLE_ELEMENT_LIMIT,
    );
  });

  it("prepares 130,000 kept imports through a link or an import", async () => {
    // In the review of #174, the link failed after 7 s, past the arguments
    // that a call takes, and the import gave 130,000 <style> elements.
    const files = {
      "main.css": '@import "x.css" screen;',
      "x.css": `@import "${WEB}";\n`.repeat(130_000),
    };
    for (const html of [
      '<link rel="stylesheet" href="main.css">',
      '<style>@import "main.css";</style>',
    ]) {
      const start = performance.now();
      const { styles, added } = await prepareWith(html, files);
      const elapsed = performance.now() - start;
      assert.equal(styles, 1, html);
      assert.ok(added <= STYLESHEET_TEXT_LIMIT, `${html}: ${added} characters added`);
      assert.ok(elapsed < 10_000, `${html}: ${Math.round(elapsed)} ms`);
    }
  });

  it("gives back nothing to the text limit for what conditions leave out", async () => {
    // Given the conditions of its import, a kept import is written anew,
    // without the spaces and comments that it has as written. In the review
    // of #174, giving that back let each of 999 imports of a 15 MB
    // stylesheet in again: 216 s, where main took 0.29 s. Each preparation of
    // big.css looks up the file that it imports, and past the first, the
    // context fails the preparation.
    const kept = '@import "kept.css"';
    for (const big of [
      `${kept} layer(a)${" ".repeat(15_000_000)};`,
      `${kept} layer(a)${"/**/".repeat(3_750_000)};`,
      `${kept} layer(/*${"x".repeat(15_000_000)}*/a);`,
    ]) {
      let looked = 0;
      const ctx = {
        ...context,
        importSupports: true,
        read: (path: string) =>
          Promise.resolve(
            { "Saved/main.css": '@import "big.css" screen;\n'.repeat(999), "Saved/big.css": big }[
              path
            ] ?? null,
          ),
        exists(path: string) {
          if (path === "Saved/kept.css" && ++looked > 1)
            throw new Error("big.css was prepared again");
          return true;
        },
        locate: () => null,
      };
      const start = performance.now();
      const { html } = await preparePage('<link rel="stylesheet" href="main.css">', ctx);
      const elapsed = performance.now() - start;
      assert.equal(html.split('/kept.css") layer(a) screen;').length - 1, 1);
      assert.ok(elapsed < 20_000, `${Math.round(elapsed)} ms`);
    }
  });
});
