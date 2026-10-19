import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./support/dom";
import {
  absoluteUrls,
  inlineStylesheet,
  type PageContext,
  type PageOptions,
  pagePolicy,
  preparePage,
  vaultPath,
} from "../src/document";
import { READING_STYLE_ID } from "../src/reading";

const VAULT = "app://vault-id/home/user/My%20Vault/";

function context(files: Record<string, string>, page = "Saved/Example article.html"): PageContext & { reads: string[] } {
  const reads: string[] = [];
  return {
    pageUrl: `${VAULT}${page.split("/").map(encodeURIComponent).join("/")}`,
    vaultUrl: VAULT,
    reads,
    async read(path) {
      reads.push(path);
      return files[path] ?? null;
    },
  };
}

async function prepare(html: string, ctx: PageContext, options?: PageOptions): Promise<string> {
  return (await preparePage(html, ctx, options)).html;
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("vaultPath", () => {
  it("maps a resource URL inside the vault to its vault path", () => {
    assert.equal(vaultPath(`${VAULT}Saved/Other%20page.html?123#top`, VAULT), "Saved/Other page.html");
  });

  it("refuses URLs outside the vault, the vault itself, and broken encodings", () => {
    assert.equal(vaultPath("app://vault-id/home/user/secret.png", VAULT), null);
    assert.equal(vaultPath("https://example.com/style.css", VAULT), null);
    assert.equal(vaultPath(VAULT, VAULT), null);
    assert.equal(vaultPath(`${VAULT}bad%E0%A4%A.css`, VAULT), null);
  });
});

describe("pagePolicy", () => {
  it("allows the vault and the web, and nothing else of Obsidian's", () => {
    const policy = pagePolicy(VAULT);
    for (const directive of ["img-src", "media-src", "font-src", "frame-src"]) {
      assert.match(policy, new RegExp(`${directive} ${VAULT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} https: http: data: blob:`));
    }
    assert.match(policy, /object-src 'none'/);
    assert.doesNotMatch(policy, /app:(?!\/\/vault-id\/home\/user\/My%20Vault\/)/);
  });

  it("escapes characters in the vault's path that would end or split a source", () => {
    const policy = pagePolicy("app://vault-id/home/o'neil;notes,[1]/");
    assert.match(policy, /img-src app:\/\/vault-id\/home\/o%27neil%3Bnotes%2C%5B1%5D\/ https:/);
  });
});

describe("absoluteUrls", () => {
  const sheet = `${VAULT}Mirror/css/site.css`;

  it("resolves every form of url() against the stylesheet", () => {
    const css = `a { background: url(img/a.png); } b { background: url( "../b c.png" ); } c { src: url('/x.woff') }`;
    assert.equal(
      absoluteUrls(css, sheet),
      `a { background: url("${VAULT}Mirror/css/img/a.png"); } b { background: url("${VAULT}Mirror/b%20c.png"); } c { src: url("app://vault-id/x.woff") }`,
    );
  });

  it("leaves absolute, data, and fragment references as they mean", () => {
    const css = `a { background: url(https://example.com/a.png) } b { filter: url(#blur) } c { background: url("data:image/png;base64,AAAA") }`;
    assert.equal(
      absoluteUrls(css, sheet),
      `a { background: url("https://example.com/a.png") } b { filter: url(#blur) } c { background: url("data:image/png;base64,AAAA") }`,
    );
  });

  it("keeps quotes and escapes valid", () => {
    assert.equal(absoluteUrls(`a { background: url("we\\"ird.png") }`, sheet), `a { background: url("${VAULT}Mirror/css/we%22ird.png") }`);
  });
});

describe("inlineStylesheet", () => {
  it("replaces imports of vault stylesheets with their text, recursively", async () => {
    const ctx = context({
      "Mirror/css/base.css": `@import "fonts.css";\nbody { background: url(bg.png) }`,
      "Mirror/css/fonts.css": `@font-face { font-family: X; src: url(x.woff2) }`,
    });
    const css = await inlineStylesheet(`@import url(css/base.css);\nh1 { color: red }`, `${VAULT}Mirror/index.css`, ctx);
    assert.equal(
      css,
      `@font-face { font-family: X; src: url("${VAULT}Mirror/css/x.woff2") }\nbody { background: url("${VAULT}Mirror/css/bg.png") }\nh1 { color: red }`,
    );
  });

  it("wraps an import with media conditions in @media", async () => {
    const ctx = context({ "print.css": "body { color: black }" });
    const css = await inlineStylesheet(`@import "print.css" print;`, `${VAULT}main.css`, ctx);
    assert.equal(css, "@media print {\nbody { color: black }\n}");
  });

  it("leaves imports it cannot inline as absolute imports", async () => {
    const ctx = context({ "layered.css": "a {}" });
    const css = await inlineStylesheet(
      `@import "missing.css";\n@import url(https://example.com/x.css);\n@import "layered.css" layer(base);`,
      `${VAULT}main.css`,
      ctx,
    );
    assert.equal(
      css,
      `@import url("${VAULT}missing.css");\n@import url("https://example.com/x.css");\n@import url("${VAULT}layered.css") layer(base);`,
    );
  });

  it("stops at an import cycle", async () => {
    const ctx = context({ "a.css": `@import "b.css"; a { x: 1 }`, "b.css": `@import "a.css"; b { x: 2 }` });
    const css = await inlineStylesheet(`@import "a.css";`, `${VAULT}main.css`, ctx);
    assert.equal(css, `@import url("${VAULT}a.css"); b { x: 2 } a { x: 1 }`);
  });

  it("never reads outside the vault", async () => {
    const ctx = context({});
    await inlineStylesheet(`@import "../../../etc/style.css";`, `${VAULT}Mirror/main.css`, ctx);
    assert.deepEqual(ctx.reads, []);
  });
});

describe("preparePage", () => {
  it("sets the base to the page's location and adds the vault policy first", async () => {
    const page = parse(await prepare("<!doctype html><title>T</title><img src='a.png'>", context({})));
    const [policy, base] = [...page.head.children];
    assert.equal(policy.getAttribute("http-equiv"), "Content-Security-Policy");
    assert.equal(policy.getAttribute("content"), pagePolicy(VAULT));
    assert.equal(base.getAttribute("href"), `${VAULT}Saved/Example%20article.html`);
    assert.equal(page.querySelector("img")?.getAttribute("src"), "a.png", "references stay as written");
  });

  it("respects the page's own base, resolved from the file's location", async () => {
    const page = parse(await prepare(`<base href="../Assets/" target="_self"><img src="a.png">`, context({})));
    const bases = page.querySelectorAll("base");
    assert.equal(bases[0].getAttribute("href"), `${VAULT}Assets/`);
    assert.equal(bases[1].getAttribute("target"), "_self", "the page's own base stays for its target");
  });

  it("copies linked vault stylesheets into the page", async () => {
    const ctx = context({ "Saved/style.css": "body { background: url(bg.png) }" });
    const page = parse(
      await prepare(
        `<link rel="stylesheet" href="style.css" media="screen"><link rel="StyleSheet preload" href="style.css">`,
        ctx,
      ),
    );
    const styles = page.querySelectorAll("style");
    assert.equal(page.querySelectorAll("link").length, 0);
    assert.equal(styles.length, 2);
    assert.equal(styles[0].getAttribute("media"), "screen");
    assert.equal(styles[0].textContent, `body { background: url("${VAULT}Saved/bg.png") }`);
  });

  it("leaves other links as they are", async () => {
    const ctx = context({ "Saved/alt.css": "a {}" });
    const html = [
      `<link rel="stylesheet" href="https://cdn.example.com/site.css">`,
      `<link rel="alternate stylesheet" href="alt.css" title="Alt">`,
      `<link rel="stylesheet" href="missing.css">`,
      `<link rel="icon" href="favicon.ico">`,
      `<link rel="stylesheet" href="../../../../outside.css">`,
    ].join("");
    const page = parse(await prepare(html, ctx));
    assert.equal(page.querySelectorAll("link").length, 5);
    assert.deepEqual(ctx.reads, ["Saved/missing.css"]);
  });

  it("keeps copied stylesheets from closing their style element (#26)", async () => {
    const ctx = context({
      "Saved/evil.css": `/* </STYLE><script>globalThis.injected = true</script> */ body { color: red }`,
      "Saved/imported.css": `a::after { content: "</style><img src=x>" }`,
    });
    const html = `<link rel="stylesheet" href="evil.css"><style>@import "imported.css";</style>`;
    const page = parse(await prepare(html, ctx));
    assert.equal(page.querySelectorAll("script, img").length, 0, "no markup comes out of a stylesheet");
    const styles = page.querySelectorAll("style");
    assert.equal(styles.length, 2);
    assert.match(styles[0].textContent ?? "", /<\\\/STYLE><script>.*body \{ color: red \}$/);
    assert.match(styles[1].textContent ?? "", /content: "<\\\/style><img src=x>"/);
  });

  it("inlines imports in the page's own style elements", async () => {
    const ctx = context({ "Saved/extra.css": "p { margin: 0 }" });
    const page = parse(await prepare(`<style>@import "extra.css"; h1 { color: red }</style>`, ctx));
    assert.equal(page.querySelector("style")?.textContent, "p { margin: 0 } h1 { color: red }");
  });

  it("removes refreshes, which would navigate the frame away from the copy", async () => {
    const html = `<meta http-equiv=" Refresh " content="0; url=../../outside.html"><meta http-equiv="content-type" content="text/html">`;
    const page = parse(await prepare(html, context({})));
    assert.equal(page.querySelectorAll('meta[http-equiv=" Refresh "]').length, 0);
    assert.equal(page.querySelectorAll('meta[http-equiv="content-type"]').length, 1);
  });

  it("keeps the doctype, or its absence", async () => {
    assert.match(await prepare("<!DOCTYPE html><p>x</p>", context({})), /^<!DOCTYPE html>\n<html>/);
    assert.match(await prepare("<p>quirks</p>", context({})), /^<html>/);
  });

  it("never runs or loads anything while preparing", async () => {
    const html = `<script>globalThis.ran = true</script><img src="x" onerror="globalThis.ran = true">`;
    const page = parse(await prepare(html, context({})));
    assert.equal((globalThis as { ran?: boolean }).ran, undefined);
    assert.equal(page.querySelectorAll("script").length, 1, "scripts stay for the sandbox to decide");
  });

  describe("reading style", () => {
    const READING = "body { color: lime }";

    it("is added to a page without styles of its own, after the base", async () => {
      const prepared = await preparePage("<h1>Plain</h1><p style='width: 100%'>x</p>", context({}), { readingStyle: READING });
      const page = parse(prepared.html);
      const style = page.getElementById(READING_STYLE_ID);
      assert.equal(prepared.ownStyles, false);
      assert.equal(style?.textContent, READING);
      assert.equal(style?.previousElementSibling?.tagName, "BASE");
    });

    for (const [name, html] of [
      ["a <style> element", "<style>p { margin: 0 }</style><p>x</p>"],
      ["a linked vault stylesheet", `<link rel="stylesheet" href="style.css"><p>x</p>`],
      ["a stylesheet from the web", `<link rel="stylesheet" href="https://cdn.example.com/a.css"><p>x</p>`],
    ]) {
      it(`is not added to a page with ${name}`, async () => {
        const prepared = await preparePage(html, context({ "Saved/style.css": "p {}" }), { readingStyle: READING });
        assert.equal(prepared.ownStyles, true);
        assert.equal(parse(prepared.html).getElementById(READING_STYLE_ID), null);
      });
    }

    it("is not added when the view does not ask for it", async () => {
      const prepared = await preparePage("<p>x</p>", context({}));
      assert.equal(prepared.ownStyles, false);
      assert.equal(parse(prepared.html).getElementById(READING_STYLE_ID), null);
    });

    it("cannot close its style element", async () => {
      const prepared = await preparePage("<p>x</p>", context({}), { readingStyle: "</style><script>x()</script>" });
      assert.equal(parse(prepared.html).querySelectorAll("script").length, 0);
    });
  });

  describe("locating references by name", () => {
    const FILES: Record<string, string> = {
      "Shared/card.png": "",
      "Saved/present.png": "",
      "Assets/sprites/025.png": "",
      "Theme/site.css": "body { background: url(bg.png) }",
      "Theme/bg.png": "",
    };

    function locating(): PageContext & { reads: string[] } {
      const ctx = context(FILES);
      return {
        ...ctx,
        exists: (path: string) => path in FILES || path === "Saved",
        locate: (linktext: string) =>
          Object.keys(FILES).find((path) => path === linktext || path.endsWith(`/${linktext}`)) ?? null,
      };
    }

    const url = (path: string) => `${VAULT}${path.split("/").map(encodeURIComponent).join("/")}`;

    it("points references that do not resolve as paths at the file found by name", async () => {
      const html = `<img src="card.png"><img src="present.png"><img src="2026/missing.png"><img src="https://example.com/a.png">`;
      const sources = [...parse(await prepare(html, locating())).images].map((image) => image.getAttribute("src"));
      assert.deepEqual(sources, [url("Shared/card.png"), "present.png", "2026/missing.png", "https://example.com/a.png"]);
    });

    it("finds a partial path and keeps a fragment", async () => {
      const html = `<svg><use href="sprites/025.png#icon"></use></svg>`;
      assert.equal(
        parse(await prepare(html, locating())).querySelector("use")?.getAttribute("href"),
        `${url("Assets/sprites/025.png")}#icon`,
      );
    });

    it("locates each candidate of a srcset, keeping its descriptors", async () => {
      const html = `<img srcset="card.png 1x, present.png 2x">`;
      assert.equal(
        parse(await prepare(html, locating())).querySelector("img")?.getAttribute("srcset"),
        `${url("Shared/card.png")} 1x, present.png 2x`,
      );
    });

    it("locates a stylesheet by name, and its own references from its real location", async () => {
      const page = parse(await prepare(`<link rel="stylesheet" href="site.css">`, locating()));
      assert.equal(page.querySelector("style")?.textContent, `body { background: url("${url("Theme/bg.png")}") }`);
    });

    it("locates url()s in style attributes and style elements, and leaves the rest", async () => {
      const html = `<p style="background: url('card.png')">x</p><style>p { background: url(card.png) } q { background: url(present.png) }</style>`;
      const page = parse(await prepare(html, locating()));
      assert.equal(page.querySelector("p")?.getAttribute("style"), `background: url("${url("Shared/card.png")}")`);
      assert.equal(
        page.querySelector("style")?.textContent,
        `p { background: url("${url("Shared/card.png")}") } q { background: url(present.png) }`,
      );
    });

    it("changes nothing without link resolution", async () => {
      const page = parse(await prepare(`<img src="card.png">`, context(FILES)));
      assert.equal(page.querySelector("img")?.getAttribute("src"), "card.png");
    });
  });
});