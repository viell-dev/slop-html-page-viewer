import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./support/dom";
import {
  absoluteUrls,
  COPY_FILE_LIMIT,
  COPY_PAGE_LIMIT,
  inlineStylesheet,
  type LocalFiles,
  type PageContext,
  type PageOptions,
  pagePolicy,
  preparePage,
  vaultPath,
} from "../src/document";
import { READING_STYLE_ID } from "../src/reading";

const VAULT = "app://vault-id/home/user/My%20Vault/";

function context(
  files: Record<string, string>,
  page = "Saved/Example article.html",
): PageContext & { reads: string[] } {
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
    assert.equal(
      vaultPath(`${VAULT}Saved/Other%20page.html?123#top`, VAULT),
      "Saved/Other page.html",
    );
  });

  it("refuses URLs outside the vault, the vault itself, and broken encodings", () => {
    assert.equal(vaultPath("app://vault-id/home/user/secret.png", VAULT), null);
    assert.equal(vaultPath("https://example.com/style.css", VAULT), null);
    assert.equal(vaultPath(VAULT, VAULT), null);
    assert.equal(vaultPath(`${VAULT}bad%E0%A4%A.css`, VAULT), null);
    assert.equal(vaultPath(`${VAULT}Saved/..%2F..%2Fsecret.png`, VAULT), null);
    assert.equal(vaultPath(`${VAULT}Saved/.%2Fa.png`, VAULT), null);
  });
});

describe("pagePolicy", () => {
  it("allows the vault and the web, and nothing else of Obsidian's", () => {
    const policy = pagePolicy(VAULT);
    for (const directive of ["img-src", "media-src", "font-src", "frame-src"]) {
      assert.match(
        policy,
        new RegExp(
          `${directive} ${VAULT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} https: http: data: blob:`,
        ),
      );
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
    assert.equal(
      absoluteUrls(`a { background: url("we\\"ird.png") }`, sheet),
      `a { background: url("${VAULT}Mirror/css/we%22ird.png") }`,
    );
  });
});

describe("inlineStylesheet", () => {
  it("replaces imports of vault stylesheets with their text, recursively", async () => {
    const ctx = context({
      "Mirror/css/base.css": `@import "fonts.css";\nbody { background: url(bg.png) }`,
      "Mirror/css/fonts.css": `@font-face { font-family: X; src: url(x.woff2) }`,
    });
    const css = await inlineStylesheet(
      `@import url(css/base.css);\nh1 { color: red }`,
      `${VAULT}Mirror/index.css`,
      ctx,
    );
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
    const ctx = context({
      "a.css": `@import "b.css"; a { x: 1 }`,
      "b.css": `@import "a.css"; b { x: 2 }`,
    });
    const css = await inlineStylesheet(`@import "a.css";`, `${VAULT}main.css`, ctx);
    assert.equal(css, `@import url("${VAULT}a.css"); b { x: 2 } a { x: 1 }`);
  });

  it("never reads outside the vault", async () => {
    const ctx = context({});
    await inlineStylesheet(`@import "../../../etc/style.css";`, `${VAULT}Mirror/main.css`, ctx);
    assert.deepEqual(ctx.reads, []);
  });

  it("reads only CSS files, and leaves imports of other files as absolute imports", async () => {
    const ctx = context({ "notes.md": "Private text", "Upper.CSS": "a { x: 1 }" });
    const css = await inlineStylesheet(
      `@import "notes.md";\n@import "Upper.CSS";`,
      `${VAULT}main.css`,
      ctx,
    );
    assert.equal(css, `@import url("${VAULT}notes.md");\na { x: 1 }`);
    assert.deepEqual(ctx.reads, ["Upper.CSS"]);
  });
});

describe("preparePage", () => {
  it("sets the base to the page's location and adds the vault policy first", async () => {
    const page = parse(
      await prepare("<!doctype html><title>T</title><img src='a.png'>", context({})),
    );
    const [policy, base] = [...page.head.children];
    assert.equal(policy.getAttribute("http-equiv"), "Content-Security-Policy");
    assert.equal(policy.getAttribute("content"), pagePolicy(VAULT));
    assert.equal(base.getAttribute("href"), `${VAULT}Saved/Example%20article.html`);
    assert.equal(
      page.querySelector("img")?.getAttribute("src"),
      "a.png",
      "references stay as written",
    );
  });

  it("respects the page's own base, resolved from the file's location", async () => {
    const page = parse(
      await prepare(`<base href="../Assets/" target="_self"><img src="a.png">`, context({})),
    );
    const bases = page.querySelectorAll("base");
    assert.equal(bases[0].getAttribute("href"), `${VAULT}Assets/`);
    assert.equal(
      bases[1].getAttribute("target"),
      "_self",
      "the page's own base stays for its target",
    );
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

  it("copies only CSS files, never another vault file that a page links as a stylesheet", async () => {
    const ctx = context({
      "Saved/notes.md": "Private text",
      "Saved/data.json": "{}",
      "Saved/Upper.CSS": "a { x: 1 }",
    });
    const html = [
      `<link rel="stylesheet" href="notes.md">`,
      `<link rel="stylesheet" href="data.json">`,
      `<link rel="stylesheet" href="Upper.CSS">`,
      `<style>@import "notes.md";</style>`,
    ].join("");
    const page = await prepare(html, ctx);
    assert.doesNotMatch(page, /Private text/);
    assert.equal(parse(page).querySelectorAll("link").length, 2);
    assert.deepEqual(ctx.reads, ["Saved/Upper.CSS"]);
  });

  it("keeps copied stylesheets from closing their style element (#26)", async () => {
    const ctx = context({
      "Saved/evil.css": `/* </STYLE><script>globalThis.injected = true</script> */ body { color: red }`,
      "Saved/imported.css": `a::after { content: "</style><img src=x>" }`,
    });
    const html = `<link rel="stylesheet" href="evil.css"><style>@import "imported.css";</style>`;
    const page = parse(await prepare(html, ctx));
    assert.equal(
      page.querySelectorAll("script, img").length,
      0,
      "no markup comes out of a stylesheet",
    );
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
    assert.equal(
      page.querySelectorAll("script").length,
      1,
      "scripts stay for the sandbox to decide",
    );
  });

  describe("reading style", () => {
    const READING = "body { color: lime }";

    it("is added to a page without styles of its own, after the base", async () => {
      const prepared = await preparePage(
        "<h1>Plain</h1><p style='width: 100%'>x</p>",
        context({}),
        { readingStyle: READING },
      );
      const page = parse(prepared.html);
      const style = page.getElementById(READING_STYLE_ID);
      assert.equal(prepared.ownStyles, false);
      assert.equal(style?.textContent, READING);
      assert.equal(style?.previousElementSibling?.tagName, "BASE");
    });

    for (const [name, html] of [
      ["a <style> element", "<style>p { margin: 0 }</style><p>x</p>"],
      ["a linked vault stylesheet", `<link rel="stylesheet" href="style.css"><p>x</p>`],
      [
        "a stylesheet from the web",
        `<link rel="stylesheet" href="https://cdn.example.com/a.css"><p>x</p>`,
      ],
    ]) {
      it(`is not added to a page with ${name}`, async () => {
        const prepared = await preparePage(html, context({ "Saved/style.css": "p {}" }), {
          readingStyle: READING,
        });
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
      const prepared = await preparePage("<p>x</p>", context({}), {
        readingStyle: "</style><script>x()</script>",
      });
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
      "Shared/app.js": "",
    };

    function locating(): PageContext & { reads: string[] } {
      const ctx = context(FILES);
      return {
        ...ctx,
        exists: (path: string) => path in FILES || path === "Saved",
        locate: (linktext: string) =>
          Object.keys(FILES).find((path) => path === linktext || path.endsWith(`/${linktext}`)) ??
          null,
      };
    }

    const url = (path: string) => `${VAULT}${path.split("/").map(encodeURIComponent).join("/")}`;

    it("points references that do not resolve as paths at the file found by name", async () => {
      const html = `<img src="card.png"><img src="present.png"><img src="2026/missing.png"><img src="https://example.com/a.png">`;
      const sources = [...parse(await prepare(html, locating())).images].map((image) =>
        image.getAttribute("src"),
      );
      assert.deepEqual(sources, [
        url("Shared/card.png"),
        "present.png",
        "2026/missing.png",
        "https://example.com/a.png",
      ]);
    });

    it("finds a partial path and keeps a fragment", async () => {
      const html = `<svg><use href="sprites/025.png#icon"></use></svg>`;
      assert.equal(
        parse(await prepare(html, locating()))
          .querySelector("use")
          ?.getAttribute("href"),
        `${url("Assets/sprites/025.png")}#icon`,
      );
    });

    it("locates each candidate of a srcset, keeping its descriptors", async () => {
      const html = `<img srcset="card.png 1x, present.png 2x">`;
      assert.equal(
        parse(await prepare(html, locating()))
          .querySelector("img")
          ?.getAttribute("srcset"),
        `${url("Shared/card.png")} 1x, present.png 2x`,
      );
    });

    it("locates a stylesheet by name, and its own references from its real location", async () => {
      const page = parse(await prepare(`<link rel="stylesheet" href="site.css">`, locating()));
      assert.equal(
        page.querySelector("style")?.textContent,
        `body { background: url("${url("Theme/bg.png")}") }`,
      );
    });

    it("locates every URL of a srcset, also after one without a descriptor, and scripts", async () => {
      const html = `<img srcset="card.png, sprites/025.png 2x"><script src="app.js"></script>`;
      const page = parse(await prepare(html, locating()));
      assert.equal(
        page.querySelector("img")?.getAttribute("srcset"),
        `${url("Shared/card.png")}, ${url("Assets/sprites/025.png")} 2x`,
      );
      assert.equal(page.querySelector("script")?.getAttribute("src"), url("Shared/app.js"));
    });

    it("never copies a note that a stylesheet link finds by name", async () => {
      const files: Record<string, string> = { "Private/diary.md": "Private text" };
      const ctx: PageContext = {
        ...context(files),
        exists: (path) => path in files,
        locate: (linktext) =>
          Object.keys(files).find((path) => path.endsWith(`/${linktext}`)) ?? null,
      };
      assert.doesNotMatch(
        await prepare(`<link rel="stylesheet" href="diary.md">`, ctx),
        /Private text/,
      );
    });

    it("locates url()s in style attributes and style elements, and leaves the rest", async () => {
      const html = `<p style="background: url('card.png')">x</p><style>p { background: url(card.png) } q { background: url(present.png) }</style>`;
      const page = parse(await prepare(html, locating()));
      assert.equal(
        page.querySelector("p")?.getAttribute("style"),
        `background: url("${url("Shared/card.png")}")`,
      );
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

describe("tooltips", () => {
  const FILES: Record<string, string> = { "Saved/Other page.html": "", "Shared/glossary.html": "" };
  const page = (): PageContext => ({
    ...context(FILES),
    exists: (path: string) => path in FILES,
    locate: (linktext: string) =>
      Object.keys(FILES).find((path) => path.endsWith(`/${linktext}`)) ?? null,
  });

  async function titles(html: string, selector: string): Promise<(string | null)[]> {
    return [...parse(await prepare(html, page())).querySelectorAll(selector)].map((element) =>
      element.getAttribute("title"),
    );
  }

  it("shows a web link's address and a vault link's path, as the link would open it", async () => {
    const html = [
      `<a href="https://example.com/wiki/Page?x=1#part">web</a>`,
      `<a href="mailto:someone@example.com">mail</a>`,
      `<a href="Other%20page.html#top">vault</a>`,
      `<a href="glossary.html">by name</a>`,
      `<map><area href="../Shared/glossary.html"></map>`,
    ].join("");
    assert.deepEqual(await titles(html, "a, area"), [
      "https://example.com/wiki/Page?x=1#part",
      "mailto:someone@example.com",
      "Saved/Other page.html",
      "Shared/glossary.html",
      "Shared/glossary.html",
    ]);
  });

  it("shows none for a link within the page, a javascript: link, or the vault's own folder", async () => {
    const html = `<a href="#fn1">1</a><a href="javascript:void(0)">js</a><a href="../">vault</a><a>no href</a>`;
    assert.deepEqual(await titles(html, "a"), [null, null, null, null]);
  });

  it("shows an image's alt text, and keeps every title the page has", async () => {
    const html = [
      `<img src="a.png" alt=" A photo ">`,
      `<img src="b.png" alt="">`,
      `<img src="c.png">`,
      `<img src="d.png" alt="Alt" title="The page's own">`,
      `<a href="https://example.com/" title="Its own">web</a>`,
    ].join("");
    assert.deepEqual(await titles(html, "img, a"), [
      "A photo",
      null,
      null,
      "The page's own",
      "Its own",
    ]);
  });

  it("resolves links against the page's own base, as the frame does", async () => {
    const html = `<base href="https://example.com/docs/"><a href="guide.html">guide</a>`;
    assert.deepEqual(await titles(html, "a"), ["https://example.com/docs/guide.html"]);
  });
});
describe("copying local files (#11)", () => {
  function localFiles(
    files: Record<string, string>,
    sizes: Record<string, number> = {},
  ): LocalFiles & { reads: string[]; asked: string[] } {
    const reads: string[] = [];
    const asked: string[] = [];
    return {
      reads,
      asked,
      size: (path) => {
        asked.push(path);
        return sizes[path] ?? (path in files ? new TextEncoder().encode(files[path]).length : null);
      },
      async readBinary(path) {
        reads.push(path);
        return path in files ? new TextEncoder().encode(files[path]).buffer : null;
      },
    };
  }

  const data = (type: string, text: string): string => `data:${type};base64,${btoa(text)}`;

  async function copied(
    html: string,
    files: Record<string, string>,
    stylesheets: Record<string, string> = {},
  ) {
    const copy = localFiles(files);
    const prepared = await preparePage(html, context(stylesheets), { copyFiles: copy });
    return { page: parse(prepared.html), copy, prepared };
  }

  it("copies images, media, text tracks, and scripts as data: URLs of their types", async () => {
    const files = {
      "Saved/a.png": "A",
      "Saved/b.webp": "B",
      "Saved/clip.mp4": "M",
      "Saved/poster.jpg": "P",
      "Saved/song.mp3": "S",
      "Saved/subs.vtt": "V",
      "Saved/icons.svg": "<svg/>",
      "Saved/app.mjs": "export {}",
    };
    const html = [
      `<img src="a.png" srcset="a.png 1x, b.webp 2x, data:image/gif;base64,R0lG 3x">`,
      `<video src="clip.mp4" poster="poster.jpg"><track src="subs.vtt"></video>`,
      `<audio><source src="song.mp3"></audio>`,
      `<svg><image href="icons.svg#home"></image></svg>`,
      `<script type="module" src="app.mjs"></script>`,
    ].join("");
    const { page, prepared } = await copied(html, files);
    const img = page.querySelector("img");
    assert.equal(img?.getAttribute("src"), data("image/png", "A"));
    assert.equal(
      img?.getAttribute("srcset"),
      `${data("image/png", "A")} 1x, ${data("image/webp", "B")} 2x, data:image/gif;base64,R0lG 3x`,
    );
    assert.equal(page.querySelector("video")?.getAttribute("src"), data("video/mp4", "M"));
    assert.equal(page.querySelector("video")?.getAttribute("poster"), data("image/jpeg", "P"));
    assert.equal(page.querySelector("track")?.getAttribute("src"), data("text/vtt", "V"));
    assert.equal(page.querySelector("source")?.getAttribute("src"), data("audio/mpeg", "S"));
    assert.equal(
      page.querySelector("image")?.getAttribute("href"),
      `${data("image/svg+xml", "<svg/>")}#home`,
    );
    const script = page.querySelector("script");
    assert.equal(script?.getAttribute("src"), data("text/javascript", "export {}"));
    assert.equal(script?.getAttribute("type"), "module");
    assert.deepEqual(prepared.copiedFiles, { copied: 8, leftOut: 0 });
  });

  it("copies the images and fonts that CSS refers to, in copied stylesheets too", async () => {
    const files = { "Saved/bg.png": "G", "Saved/fonts/x.woff2": "F" };
    const html = [
      `<link rel="stylesheet" href="site.css">`,
      `<style>body { background: url("bg.png") }</style>`,
      `<p style="background: url(bg.png)">x</p>`,
    ].join("");
    const { page, copy } = await copied(html, files, {
      "Saved/site.css": "@font-face { src: url(fonts/x.woff2) }",
    });
    const styles = [...page.querySelectorAll("style")].map((style) => style.textContent);
    assert.ok(styles.includes(`@font-face { src: url("${data("font/woff2", "F")}") }`));
    assert.ok(styles.includes(`body { background: url("${data("image/png", "G")}") }`));
    assert.equal(
      page.querySelector("p")?.getAttribute("style"),
      `background: url("${data("image/png", "G")}")`,
    );
    assert.deepEqual(
      copy.reads.sort(),
      ["Saved/bg.png", "Saved/fonts/x.woff2"],
      "each file is read once",
    );
  });

  it("copies no other kind of file, and nothing that is not a vault file", async () => {
    const files = {
      "Saved/notes.md": "Private text",
      "Saved/data.json": "{}",
      "Saved/a.png": "A",
      "Saved/other.html": "<p>",
    };
    const html = [
      `<img src="notes.md"><img src="data.json"><script src="notes.md"></script>`,
      `<a href="a.png">link</a><iframe src="other.html"></iframe>`,
      `<img src="https://example.com/a.png"><img src="../../../../outside.png"><img src="missing.png">`,
    ].join("");
    const { page, copy, prepared } = await copied(html, files);
    assert.doesNotMatch(prepared.html, /;base64,/);
    assert.equal(page.querySelector("a")?.getAttribute("href"), "a.png");
    assert.deepEqual(copy.reads, []);
    assert.deepEqual(prepared.copiedFiles, { copied: 0, leftOut: 0 });
  });

  it("leaves out files over the limits, and says how many", async () => {
    // Within the page's limit, four files of 7 MB fit, a fifth does not, and a small one still does.
    const names = ["huge", "a", "b", "c", "d", "e", "small"];
    const files = Object.fromEntries(names.map((name) => [`Saved/${name}.png`, name]));
    const sizes: Record<string, number> = {
      "Saved/huge.png": COPY_FILE_LIMIT + 1,
      "Saved/small.png": 1,
    };
    for (const name of ["a", "b", "c", "d", "e"]) sizes[`Saved/${name}.png`] = 7_000_000;
    assert.ok(
      4 * 7_000_000 <= COPY_PAGE_LIMIT &&
        5 * 7_000_000 > COPY_PAGE_LIMIT &&
        7_000_000 <= COPY_FILE_LIMIT,
    );
    const copy = localFiles(files, sizes);
    const html = names.map((name) => `<img src="${name}.png">`).join("");
    const prepared = await preparePage(html, context({}), { copyFiles: copy });
    const sources = [...parse(prepared.html).images].map((image) => image.getAttribute("src"));
    const copiedSource = (name: string) => data("image/png", name);
    assert.deepEqual(sources, [
      "huge.png",
      ...["a", "b", "c", "d"].map(copiedSource),
      "e.png",
      copiedSource("small"),
    ]);
    assert.deepEqual(prepared.copiedFiles, { copied: 5, leftOut: 2 });
    assert.deepEqual(copy.reads, [
      "Saved/a.png",
      "Saved/b.png",
      "Saved/c.png",
      "Saved/d.png",
      "Saved/small.png",
    ]);
  });

  it("gives scripts and fonts the page's limit before images", async () => {
    const files = {
      "Saved/app.js": "J",
      "Saved/x.woff2": "F",
      ...Object.fromEntries(["a", "b", "c", "d", "e"].map((name) => [`Saved/${name}.png`, name])),
    };
    const sizes: Record<string, number> = {};
    for (const name of ["a", "b", "c", "d", "e"]) sizes[`Saved/${name}.png`] = 7_000_000;
    const copy = localFiles(files, sizes);
    const html = [
      ...["a", "b", "c", "d", "e"].map((name) => `<img src="${name}.png">`),
      `<script src="app.js"></script><style>@font-face { src: url(x.woff2) }</style>`,
    ].join("");
    const prepared = await preparePage(html, context({}), { copyFiles: copy });
    const page = parse(prepared.html);
    assert.equal(page.querySelector("script")?.getAttribute("src"), data("text/javascript", "J"));
    assert.match(page.querySelector("style")?.textContent ?? "", /url\("data:font\/woff2;base64,/);
    assert.deepEqual(
      [...page.images].map((image) => image.getAttribute("src")?.startsWith("data:")),
      [true, true, true, true, false],
    );
    assert.deepEqual(prepared.copiedFiles, { copied: 6, leftOut: 1 });
  });

  it("counts each reference against the page's limit, and reads each file once", async () => {
    const copy = localFiles({ "Saved/sprite.png": "S" }, { "Saved/sprite.png": 7_000_000 });
    const rules = Array.from(
      { length: 6 },
      (_, index) => `.icon${index} { background: url(sprite.png) }`,
    ).join("\n");
    const prepared = await preparePage(`<style>${rules}</style>`, context({}), { copyFiles: copy });
    const css = parse(prepared.html).querySelector("style")?.textContent ?? "";
    // Four copies of 7 MB fit in the page's 32 MB, a fifth does not.
    assert.equal(css.split("data:image/png;base64,").length - 1, 4);
    assert.equal(css.split("url(sprite.png)").length - 1, 2);
    assert.deepEqual(copy.reads, ["Saved/sprite.png"]);
    assert.deepEqual(prepared.copiedFiles, { copied: 1, leftOut: 1 });
  });

  it("copies every URL of a srcset, also after one without a descriptor", async () => {
    const { page } = await copied(`<img srcset="a.png, b.png 2x">`, {
      "Saved/a.png": "A",
      "Saved/b.png": "B",
    });
    assert.equal(
      page.querySelector("img")?.getAttribute("srcset"),
      `${data("image/png", "A")}, ${data("image/png", "B")} 2x`,
    );
  });

  it("leaves a reference as it is when its file cannot be read", async () => {
    const copy: LocalFiles = { size: () => 1, readBinary: async () => null };
    const prepared = await preparePage(`<img src="gone.png">`, context({}), { copyFiles: copy });
    assert.equal(parse(prepared.html).querySelector("img")?.getAttribute("src"), "gone.png");
    assert.deepEqual(prepared.copiedFiles, { copied: 0, leftOut: 0 });
  });

  it("asks only for files of the copied types inside the vault, whatever a reference looks like", async () => {
    const files = {
      "Saved/notes.md": "Private text",
      "Saved/x.png.md": "Private text",
      "Saved/NOTES.MD": "Private text",
    };
    const html = [
      `<img src="%2e%2e/%2e%2e/%2e%2e/%2e%2e/outside.png"><img src="..%2F..%2Fsecret.png"><img src="..\\..\\top.png">`,
      `<img src="notes.md#.png"><img src="notes.md?x=.png"><img src="notes.md%23.png"><img src="x.png.md"><img src="NOTES.MD">`,
      `<img src="app://vault-id/home/user/other.png"><img src="file:///etc/passwd.png"><script src="notes.md"></script>`,
    ].join("");
    const { copy, prepared } = await copied(html, files);
    assert.doesNotMatch(prepared.html, /;base64,/);
    assert.deepEqual(copy.reads, []);
    for (const path of copy.asked) {
      assert.match(path, /^Saved\/[^/]+\.png$/, `asked about ${path}`);
    }

    const elsewhere = localFiles({ "a.png": "A" });
    const outside = await preparePage(
      `<base href="app://vault-id/home/user/"><img src="a.png">`,
      context({}),
      { copyFiles: elsewhere },
    );
    assert.doesNotMatch(outside.html, /;base64,/);
    assert.deepEqual(elsewhere.asked, [], "nothing outside the vault is asked about");
  });

  it("copies nothing unless asked", async () => {
    const prepared = await preparePage(`<img src="a.png">`, context({}));
    assert.equal(prepared.copiedFiles, undefined);
    assert.equal(parse(prepared.html).querySelector("img")?.getAttribute("src"), "a.png");
  });
});
