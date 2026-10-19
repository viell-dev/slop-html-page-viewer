import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./support/dom";
import { absoluteUrls, inlineStylesheet, type PageContext, pagePolicy, preparePage, vaultPath } from "../src/document";

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
    const page = parse(await preparePage("<!doctype html><title>T</title><img src='a.png'>", context({})));
    const [policy, base] = [...page.head.children];
    assert.equal(policy.getAttribute("http-equiv"), "Content-Security-Policy");
    assert.equal(policy.getAttribute("content"), pagePolicy(VAULT));
    assert.equal(base.getAttribute("href"), `${VAULT}Saved/Example%20article.html`);
    assert.equal(page.querySelector("img")?.getAttribute("src"), "a.png", "references stay as written");
  });

  it("respects the page's own base, resolved from the file's location", async () => {
    const page = parse(await preparePage(`<base href="../Assets/" target="_self"><img src="a.png">`, context({})));
    const bases = page.querySelectorAll("base");
    assert.equal(bases[0].getAttribute("href"), `${VAULT}Assets/`);
    assert.equal(bases[1].getAttribute("target"), "_self", "the page's own base stays for its target");
  });

  it("copies linked vault stylesheets into the page", async () => {
    const ctx = context({ "Saved/style.css": "body { background: url(bg.png) }" });
    const page = parse(
      await preparePage(
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
    const page = parse(await preparePage(html, ctx));
    assert.equal(page.querySelectorAll("link").length, 5);
    assert.deepEqual(ctx.reads, ["Saved/missing.css"]);
  });

  it("keeps copied stylesheets from closing their style element (#26)", async () => {
    const ctx = context({
      "Saved/evil.css": `/* </STYLE><script>globalThis.injected = true</script> */ body { color: red }`,
      "Saved/imported.css": `a::after { content: "</style><img src=x>" }`,
    });
    const html = `<link rel="stylesheet" href="evil.css"><style>@import "imported.css";</style>`;
    const page = parse(await preparePage(html, ctx));
    assert.equal(page.querySelectorAll("script, img").length, 0, "no markup comes out of a stylesheet");
    const styles = page.querySelectorAll("style");
    assert.equal(styles.length, 2);
    assert.match(styles[0].textContent ?? "", /<\\\/STYLE><script>.*body \{ color: red \}$/);
    assert.match(styles[1].textContent ?? "", /content: "<\\\/style><img src=x>"/);
  });

  it("inlines imports in the page's own style elements", async () => {
    const ctx = context({ "Saved/extra.css": "p { margin: 0 }" });
    const page = parse(await preparePage(`<style>@import "extra.css"; h1 { color: red }</style>`, ctx));
    assert.equal(page.querySelector("style")?.textContent, "p { margin: 0 } h1 { color: red }");
  });

  it("removes refreshes, which would navigate the frame away from the copy", async () => {
    const html = `<meta http-equiv=" Refresh " content="0; url=../../outside.html"><meta http-equiv="content-type" content="text/html">`;
    const page = parse(await preparePage(html, context({})));
    assert.equal(page.querySelectorAll('meta[http-equiv=" Refresh "]').length, 0);
    assert.equal(page.querySelectorAll('meta[http-equiv="content-type"]').length, 1);
  });

  it("keeps the doctype, or its absence", async () => {
    assert.match(await preparePage("<!DOCTYPE html><p>x</p>", context({})), /^<!DOCTYPE html>\n<html>/);
    assert.match(await preparePage("<p>quirks</p>", context({})), /^<html>/);
  });

  it("never runs or loads anything while preparing", async () => {
    const html = `<script>globalThis.ran = true</script><img src="x" onerror="globalThis.ran = true">`;
    const page = parse(await preparePage(html, context({})));
    assert.equal((globalThis as { ran?: boolean }).ran, undefined);
    assert.equal(page.querySelectorAll("script").length, 1, "scripts stay for the sandbox to decide");
  });
});
