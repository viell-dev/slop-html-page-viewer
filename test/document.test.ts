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
  SHADOW_ROOT_MARK,
  vaultPath,
} from "../src/document";
import { READING_STYLE_ID } from "../src/reading";

const VAULT = "app://vault-id/home/user/My%20Vault/";

describe("CSS token boundaries (#91)", () => {
  it("preserves strings and comments beside real and escaped URL tokens", () => {
    const text = `a::after { content: 'url(ghost.png) @import "ghost.css";'; } /* url(ghost.png) */`;
    assert.equal(absoluteUrls(text, VAULT + "css/site.css"), text);
    assert.equal(
      absoluteUrls(String.raw`a { background: u\72l(\41 b.png) }`, VAULT + "css/site.css"),
      `a { background: url("${VAULT}css/Ab.png") }`,
    );
  });

  it("respects escaped quotes, continuations, token boundaries and bad URL remnants", () => {
    for (const text of [
      String.raw`p { content: "quote\" url(ghost.png)" }`,
      "p { content: 'continued\\\nurl(ghost.png)' }",
      "#url(ghost.png) { --text: myurl(ghost.png) }",
      "p { background: url(bad url(ghost.png)); }",
      "/* unterminated url(ghost.png)",
    ])
      assert.equal(absoluteUrls(text, VAULT + "css/site.css"), text);
  });

  it("reads only real imports, keeping comments, strings and nested rules", async () => {
    const ctx = context({ "Saved/real.css": "b { color: green }", "Saved/ghost.css": "BAD" });
    const literal = `p::after { content: '@import "ghost.css"; url(ghost.png)'; } /* @import "ghost.css"; */ @media print { @import "ghost.css"; }`;
    const result = await inlineStylesheet(
      '@import/**/"real.css" screen;\n' + literal,
      ctx.pageUrl,
      ctx,
    );
    assert.deepEqual(ctx.reads, ["Saved/real.css"]);
    assert.ok(result.includes(literal));
    assert.ok(result.includes("@media screen"));
  });

  it("copies only URL tokens in style elements and inline styles", async () => {
    const ctx = context({});
    const reads: string[] = [];
    const css = String.raw`content: 'url(ghost.png)'; /* url(ghost.png) */ background: u\72l(real.png)`;
    const result = await preparePage(`<style>p { ${css} }</style><p style="${css}">Text</p>`, ctx, {
      copyFiles: {
        size: () => 1,
        async readBinary(path) {
          reads.push(path);
          return new Uint8Array([1]).buffer;
        },
      },
    });
    assert.deepEqual(reads, ["Saved/real.png"]);
    assert.equal(result.copiedFiles?.copied, 1);
    const doc = parse(result.html);
    for (const value of [
      doc.querySelector("style")!.textContent,
      doc.querySelector("p")!.getAttribute("style")!,
    ]) {
      assert.ok(value.includes("'url(ghost.png)'"));
      assert.ok(value.includes("/* url(ghost.png) */"));
      assert.ok(value.includes("data:image/png;base64,AQ=="));
    }
  });

  it("reads and copies only real imports and URLs in a shadow root's stylesheets (#124)", async () => {
    const literal = `p::after { content: 'url(ghost.png) @import "ghost.css";' } /* @import "ghost.css"; url(ghost.png) */`;
    const css = `@import "real.css"; ${literal} a { background: url(real.png) }`;
    const ctx = context({
      "Saved/sheet.css": css,
      "Saved/real.css": "REAL{}",
      "Saved/ghost.css": "GHOST{}",
    });
    const reads: string[] = [];
    const style = `content: 'url(ghost.png)'; /* url(ghost.png) */ background: url(real.png)`;
    const html = [
      `<div><template shadowrootmode="open">`,
      `<style>${css}</style><link rel="stylesheet" href="sheet.css"><p style="${style}">x</p>`,
      `</template></div>`,
    ].join("");
    const result = await preparePage(html, ctx, {
      copyFiles: {
        size: () => 1,
        async readBinary(path) {
          reads.push(path);
          return new Uint8Array([1]).buffer;
        },
      },
    });
    // The link first, with its import, then the shadow root's own <style>.
    assert.deepEqual(ctx.reads, ["Saved/sheet.css", "Saved/real.css", "Saved/real.css"]);
    assert.deepEqual(reads, ["Saved/real.png"]);
    assert.ok(!result.html.includes("GHOST"));
    const content = parse(result.html).querySelector("template")!.content;
    const sheets = [...content.querySelectorAll("style")].map((element) => element.textContent);
    assert.equal(sheets.length, 2);
    for (const value of [...sheets, content.querySelector("p")!.getAttribute("style")!]) {
      assert.ok(value.includes("'url(ghost.png)"), value);
      assert.ok(value.includes("/* "), value);
      assert.ok(value.includes("data:image/png;base64,AQ=="), value);
    }
    for (const sheet of sheets) {
      assert.ok(sheet.includes(literal), sheet);
      assert.ok(sheet.startsWith("REAL{}"), sheet);
    }
  });
});

it("does not read or copy literal resources after malformed quoted functions", async () => {
  for (const css of [
    `a { b: url("x" ")"); } p::after { content: "url(ghost.png)" }`,
    `a { b: url("x" /* ) " */ ); } p::after { content: "url(ghost.png)" }`,
    `@import url("x" ")"); p::after { content: "@import 'ghost.css';" }`,
    '@import "ghost.css?\\"\nscreen;',
    'a { b: url("ghost.png?\\"\n ) }',
    // U+0010 is not a hex digit: the escape ends before the newline, which ends a bad string.
    'p::after { content: "\\\u0010\n" url(ghost.png) "" }',
    'p::after { content: "\\\u0010\n" } @import "ghost.css"; p::after { content: "" }',
    'a { b: url(} x); @import "ghost.css"; }',
    '} a { @import "ghost.css"; }',
    // A brace inside parentheses or brackets belongs to them, not to the rule.
    'a { b: (}); @import "ghost.css"; }',
    'a { b: [}]; @import "ghost.css"; }',
    'a { b: calc(}); @import "ghost.css"; }',
    // "\6" is U+0006, and the line continuation after it stands for nothing.
    'a { b: url("ghost.pn\\6\\\n7") }',
    // The newline that ends the media list's bad string must stay in the copy.
    '@import "https://example.com/x.css" "bad\n; p::after { content: "url(ghost.png)" }',
    // To CSS, U+FEFF starts a name here, not space, so this is no URL.
    '@import "https://example.com/x.css" ﻿url("ghost.png");',
  ]) {
    const sheets = [`<style>${css}</style>`, '<link rel="stylesheet" href="sheet.css">'];
    // A shadow root's stylesheets are prepared as the document's (#124).
    const shadow = (sheet: string) =>
      `<div><template shadowrootmode="open">${sheet}</template></div>`;
    for (const html of [...sheets, ...sheets.map(shadow)]) {
      const ctx = context({ "Saved/sheet.css": css, "Saved/ghost.css": "GHOST{}" });
      const reads: string[] = [];
      const result = await preparePage(html, ctx, {
        copyFiles: {
          size: () => 1,
          async readBinary(path) {
            reads.push(path);
            return new Uint8Array([1]).buffer;
          },
        },
      });
      assert.deepEqual(ctx.reads, html.includes("<link") ? ["Saved/sheet.css"] : [], css);
      assert.deepEqual(reads, [], css);
      assert.ok(!result.html.includes("GHOST"), css);
    }
  }
});

it("imports the name that a hex escape before a line continuation makes", async () => {
  // "\6" is U+0006, and the continuation after it stands for nothing.
  const ctx = context({ "Saved/ghost.css": "GHOST{}" });
  const result = await preparePage('<style>@import "gh\\6\\\nfst.css";</style>', ctx);
  assert.deepEqual(ctx.reads, ["Saved/gh\u0006fst.css"]);
  assert.ok(!result.html.includes("GHOST"));
});

describe("<style> text that Chromium applies (#143)", () => {
  // Chromium applies an HTML or SVG <style>'s own text nodes, joined, and
  // nothing inside an SVG <style>'s child elements, in a MathML <style>, or
  // from a <link> inside SVG or MathML, which is an element of theirs.
  const shadow = (html: string) => `<div><template shadowrootmode="open">${html}</template></div>`;
  const places = [(html: string) => html, shadow];

  /** Prepares a page without and with copying files, recording what each reads and copies. */
  async function prepared(html: string) {
    const results = [];
    for (const copying of [false, true]) {
      const ctx = context({
        "Saved/real.css": "REAL{}",
        "Saved/ghost.css": "GHOST{}",
        "Saved/markup.css": 'a::after { content: "</svg></math><p id=escaped>x</p>" }',
      });
      const copies: string[] = [];
      const result = await preparePage(html, ctx, {
        copyFiles: copying
          ? {
              size: () => 1,
              async readBinary(path) {
                copies.push(path);
                return new Uint8Array([1]).buffer;
              },
            }
          : undefined,
      });
      const page = parse(result.html);
      const root = page.querySelector("template")?.content ?? page;
      results.push({ copying, reads: ctx.reads, copies, html: result.html, root });
    }
    return results;
  }

  it("reads and copies nothing that only an SVG <style>'s child elements or a MathML <style> name", async () => {
    for (const html of [
      '<svg><style><desc>@import "ghost.css";</desc>circle { fill: red }<desc>a { b: url(ghost.png) }</desc></style></svg>',
      '<math><style>@import "ghost.css"; a { b: url(ghost.png) }</style></math>',
    ]) {
      for (const place of places) {
        for (const { copying, reads, copies, html: copy } of await prepared(place(html))) {
          const what = `${place(html)}, copying: ${copying}`;
          assert.deepEqual({ reads, copies }, { reads: [], copies: [] }, what);
          assert.ok(copy.includes(html), what);
        }
      }
    }
  });

  it("rewrites only an SVG <style>'s own text, joined, keeping its child elements", async () => {
    // CSS reads the text on either side of the <g> as one, so it names real.png.
    const html =
      '<svg><style>@import "real.css";<desc>a { b: url(ghost.png) }</desc> c { d: url(re<g></g>al.png) }</style></svg>';
    for (const place of places) {
      for (const { copying, reads, copies, root } of await prepared(place(html))) {
        const style = root.querySelector("style")!;
        const url = copying ? "data:image/png;base64,AQ==" : `${VAULT}Saved/real.png`;
        assert.deepEqual(
          {
            reads,
            copies,
            nodes: [...style.childNodes].map((node) => node.nodeName),
            text: style.firstChild!.textContent,
            desc: style.querySelector("desc")!.textContent,
          },
          {
            reads: ["Saved/real.css"],
            copies: copying ? ["Saved/real.png"] : [],
            nodes: ["#text", "desc", "g"],
            text: `REAL{} c { d: url("${url}") }`,
            desc: "a { b: url(ghost.png) }",
          },
          `${place(html)}, copying: ${copying}`,
        );
      }
    }
  });

  it("keeps the text that it puts in an SVG <style> there when the copy is parsed again", async () => {
    // The copy's serialization escapes markup in an SVG <style>'s text, which
    // the HTML parser reads as markup there, not as text.
    for (const place of places) {
      for (const { root } of await prepared(
        place('<svg><style>@import "markup.css";</style></svg>'),
      )) {
        assert.equal(root.querySelector("#escaped"), null);
        assert.equal(
          root.querySelector("svg style")!.textContent,
          'a::after { content: "</svg></math><p id=escaped>x</p>" }',
        );
      }
    }
  });

  it("turns only HTML stylesheet links into <style> elements", async () => {
    for (const html of [
      '<svg><link rel="stylesheet" href="markup.css"></svg>',
      '<math><link rel="stylesheet" href="markup.css"></math>',
    ]) {
      for (const place of places) {
        for (const { copying, reads, root } of await prepared(place(html))) {
          const what = `${place(html)}, copying: ${copying}`;
          assert.deepEqual(reads, [], what);
          assert.equal(root.querySelector("#escaped"), null, what);
          assert.equal(root.querySelectorAll("link").length, 1, what);
        }
      }
    }
    // HTML inside SVG has HTML elements, as the frame parses them.
    const html =
      '<svg><foreignObject><link rel="stylesheet" href="real.css"></foreignObject></svg>';
    for (const place of places) {
      for (const { reads, root } of await prepared(place(html))) {
        assert.deepEqual(reads, ["Saved/real.css"]);
        assert.equal(root.querySelector("foreignObject > style")!.textContent, "REAL{}");
      }
    }
  });
});

it("leaves a style element that needs no change as it is", async () => {
  // An SVG <style> can hold elements, which assigning its text would remove.
  const ctx = context({});
  const result = await preparePage(
    '<svg><style>circle { fill: red }<g id="kept"></g></style></svg>',
    ctx,
  );
  assert.ok(parse(result.html).querySelector("svg style #kept"), result.html);
});

it("leaves a NUL before url( in a linked stylesheet a function name, as CSS reads it", async () => {
  // CSS reads U+0000 as U+FFFD, an identifier character; the HTML parser
  // already does that for <style> text, but linked files keep it.
  const css = "a { b: \0url(ghost.png) } c { d: url(real\0.png) }";
  const link = '<link rel="stylesheet" href="sheet.css">';
  for (const html of [link, `<div><template shadowrootmode="open">${link}</template></div>`]) {
    const ctx = context({ "Saved/sheet.css": css });
    const reads: string[] = [];
    const result = await preparePage(html, ctx, {
      copyFiles: {
        size: () => 1,
        async readBinary(path) {
          reads.push(path);
          return new Uint8Array([1]).buffer;
        },
      },
    });
    assert.deepEqual(reads, ["Saved/real�.png"], html);
    assert.ok(result.html.includes("url(ghost.png)"), html);
  }
});

it("ignores closers that do not match the innermost open block in an import's prelude", async () => {
  // To CSS, the stray ")" is part of the first import's media list, which is
  // then invalid, and the second import is unaffected.
  const ctx = context({ "Saved/real.css": "REAL{}", "Saved/ghost.css": "GHOST{}" });
  const result = await inlineStylesheet(
    '@import "real.css" ); @import "ghost.css";',
    ctx.pageUrl,
    ctx,
  );
  assert.deepEqual(ctx.reads, ["Saved/real.css", "Saved/ghost.css"]);
  assert.equal(result, "@media ) {\nREAL{}\n} GHOST{}");
});

it("processes linked stylesheet imports once, retaining the eight-file depth limit", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [
      `Saved/${i}.css`,
      `@import "${i + 1}.css"; .n${i} { color: red }`,
    ]),
  );
  // A shadow root's links are prepared as the document's, with the same limits (#124).
  const shadow = (html: string) => `<div><template shadowrootmode="open">${html}</template></div>`;
  for (const place of [(html: string) => html, shadow]) {
    const ctx = context(files);
    await preparePage(place('<link rel="stylesheet" href="0.css">'), ctx);
    assert.deepEqual(
      ctx.reads,
      Array.from({ length: 8 }, (_, i) => `Saved/${i}.css`),
    );
    const self = context({ "Saved/self.css": '@import "self.css"; .self { color: red }' });
    const result = await preparePage(place('<link rel="stylesheet" href="self.css">'), self);
    assert.deepEqual(self.reads, ["Saved/self.css"]);
    assert.equal(result.html.split(".self").length - 1, 1);
  }
});

it("handles repeated malformed URL openers without quadratic work", () => {
  const css = "url(".repeat(20_000);
  const start = performance.now();
  assert.equal(absoluteUrls(css, VAULT + "site.css"), css);
  assert.ok(performance.now() - start < 2_000, "80 KB of malformed CSS must finish within 2 s");
});

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

  it("decodes escapes as CSS does, as U+FFFD where they name no character", () => {
    const css = [
      `a { background: url(\\110000.png) }`,
      `b { background: url("\\0 x\\D800 y\\DFFF.png") }`,
      `c { background: url(\\FFFFFF.png) }`,
      `d { background: url(\\10FFFF.png) }`,
      `e { background: url("\\41 b\\26 c\\(1\\).png") }`,
      `f { background: url('\\0000411.png') }`,
      `g { background: url("\\41\tb.png") }`,
    ].join("\n");
    const replacement = "%EF%BF%BD";
    assert.equal(
      absoluteUrls(css, sheet),
      [
        `a { background: url("${VAULT}Mirror/css/${replacement}.png") }`,
        `b { background: url("${VAULT}Mirror/css/${replacement}x${replacement}y${replacement}.png") }`,
        `c { background: url("${VAULT}Mirror/css/${replacement}.png") }`,
        `d { background: url("${VAULT}Mirror/css/%F4%8F%BF%BF.png") }`,
        `e { background: url("${VAULT}Mirror/css/Ab&c(1).png") }`,
        `f { background: url("${VAULT}Mirror/css/A1.png") }`,
        `g { background: url("${VAULT}Mirror/css/Ab.png") }`,
      ].join("\n"),
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

  it("keeps the end of an import's media list as written", async () => {
    // A newline there ends a bad string, and a space keeps a backslash from escaping the ";".
    const ctx = context({ "print.css": "body { color: black }" });
    for (const [source, result] of [
      ['@import "print.css" "bad\n;', '@media "bad\n {\nbody { color: black }\n}'],
      [
        '@import "https://example.com/x.css" "bad\n;',
        '@import url("https://example.com/x.css") "bad\n;',
      ],
      [
        '@import "https://example.com/x.css" screen\\ ;',
        '@import url("https://example.com/x.css") screen\\ ;',
      ],
      // Only CSS whitespace is trimmed at the start: U+00A0 and U+FEFF are name characters.
      [
        '@import "https://example.com/x.css"  ﻿url("x.png");',
        '@import url("https://example.com/x.css")  ﻿url("x.png");',
      ],
    ])
      assert.equal(await inlineStylesheet(source, `${VAULT}main.css`, ctx), result);
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

  it("leaves an import whose file cannot be read as an absolute import, as a missing one", async () => {
    const ctx: PageContext = {
      ...context({}),
      read: () => Promise.reject(new Error("synthetic read failure")),
    };
    const css = await inlineStylesheet(
      `@import "unreadable.css"; a { x: 1 }`,
      `${VAULT}main.css`,
      ctx,
    );
    assert.equal(css, `@import url("${VAULT}unreadable.css"); a { x: 1 }`);
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

  it("leaves out a stylesheet that cannot be read, as one that is missing", async () => {
    const ctx: PageContext = {
      ...context({}),
      read: (path) =>
        path === "Saved/readable.css"
          ? Promise.resolve(`@import "unreadable.css"; p { margin: 0 }`)
          : Promise.reject(new Error("synthetic read failure")),
    };
    const html = `<link rel="stylesheet" href="unreadable.css"><link rel="stylesheet" href="readable.css">`;
    const page = parse(await prepare(html, ctx));
    assert.equal(
      page.head.firstElementChild?.getAttribute("http-equiv"),
      "Content-Security-Policy",
    );
    assert.deepEqual(
      [...page.querySelectorAll("link")].map((link) => link.getAttribute("href")),
      ["unreadable.css"],
    );
    assert.equal(
      page.querySelector("style")?.textContent,
      `@import url("${VAULT}Saved/unreadable.css"); p { margin: 0 }`,
    );
  });

  it("prepares a page whose CSS escapes name no character, in each place it reads CSS", async () => {
    const ctx: PageContext = { ...context({}), exists: () => false, locate: () => null };
    const copyFiles: LocalFiles = { size: () => null, readBinary: async () => null };
    const html = [
      `<style>@import "\\D800.css"; p { background: url(\\110000.png) }</style>`,
      `<p style="background: url('\\FFFFFF.png')">Text</p>`,
    ].join("");
    const page = parse(await prepare(html, ctx, { copyFiles }));
    const [policy, base] = [...page.head.children];
    assert.equal(policy.getAttribute("content"), pagePolicy(VAULT));
    assert.equal(base.getAttribute("href"), ctx.pageUrl);
    assert.equal(
      page.querySelector("style")?.textContent,
      `@import url("${VAULT}Saved/%EF%BF%BD.css"); p { background: url("${VAULT}Saved/%EF%BF%BD.png") }`,
    );
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

  it("declares the shadow roots in a page with scripts off open, also nested ones", async () => {
    const html = [
      `<div><template shadowrootmode="closed"><a href="a.html">a</a>`,
      `<div><template shadowrootmode="Closed"><a href="b.html">b</a></template></div></template></div>`,
      `<div><template shadowroot="CLOSED"><a href="c.html">c</a></template></div>`,
      `<div><template shadowrootmode="open"></template></div>`,
      // Not a keyword, so the browser attaches no shadow root.
      `<div><template shadowrootmode="closed "></template></div>`,
      `<template><div><template shadowrootmode="closed"></template></div></template>`,
      `<svg><template shadowrootmode="closed"></template></svg>`,
    ].join("");
    const modes = (output: string): (string | null)[] => {
      const found: (string | null)[] = [];
      const visit = (root: ParentNode): void => {
        for (const element of root.querySelectorAll("template")) {
          found.push(element.getAttribute("shadowrootmode") ?? element.getAttribute("shadowroot"));
          if (element instanceof window.HTMLTemplateElement) visit(element.content);
        }
      };
      visit(parse(output));
      return found;
    };
    assert.deepEqual(modes(await prepare(html, context({}), { openShadowRoots: true })), [
      "open",
      "open",
      "open",
      "open",
      "closed ",
      null,
      "open",
      "closed",
    ]);
    // With scripts on, the page's own scripts may depend on them being closed.
    assert.deepEqual(modes(await prepare(html, context({}))), [
      "closed",
      "Closed",
      "CLOSED",
      "open",
      "closed ",
      null,
      "closed",
      "closed",
    ]);
  });

  it("marks where each shadow root is declared in a page with scripts off (#124)", async () => {
    const html = [
      `<div><p>light</p><template shadowrootmode="closed">`,
      `<span><template shadowrootmode="open"></template></span></template></div>`,
      `<div><template shadowroot="open"></template></div>`,
      `<div><template shadowrootmode="closed "></template><template></template></div>`,
    ].join("");
    const marks = (output: string): [string | null, boolean][] => {
      const found: [string | null, boolean][] = [];
      const visit = (root: ParentNode): void => {
        for (const template of root.querySelectorAll("template")) {
          const before = template.previousSibling;
          found.push([
            template.getAttribute("shadowrootmode") ?? template.getAttribute("shadowroot"),
            before?.nodeType === Node.COMMENT_NODE && (before as Comment).data === SHADOW_ROOT_MARK,
          ]);
          if (template instanceof window.HTMLTemplateElement) visit(template.content);
        }
      };
      visit(parse(output));
      return found;
    };
    assert.deepEqual(marks(await prepare(html, context({}), { openShadowRoots: true })), [
      ["open", true],
      ["open", true],
      ["open", true],
      ["closed ", false],
      [null, false],
    ]);
    // With scripts on, the page's scripts would see the comments.
    assert.doesNotMatch(await prepare(html, context({})), new RegExp(SHADOW_ROOT_MARK));
  });

  it("changes a page's own comments with the mark's text, so that only marks have it (#124)", async () => {
    const html = [
      `<div><!--${SHADOW_ROOT_MARK}--><p>light</p>`,
      `<template shadowrootmode="open"><span><!--${SHADOW_ROOT_MARK}--></span></template>`,
      `<!-- ${SHADOW_ROOT_MARK} --></div>`,
    ].join("");
    const comments = (output: string): string[] => {
      const found: string[] = [];
      const visit = (root: Document | DocumentFragment): void => {
        const doc = root.ownerDocument ?? root;
        const walker = doc.createTreeWalker(root, window.NodeFilter.SHOW_COMMENT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
          found.push((node as Comment).data);
        for (const template of root.querySelectorAll("template"))
          if (template instanceof window.HTMLTemplateElement) visit(template.content);
      };
      visit(parse(output));
      return found;
    };
    assert.deepEqual(comments(await prepare(html, context({}), { openShadowRoots: true })), [
      `${SHADOW_ROOT_MARK} `,
      SHADOW_ROOT_MARK,
      ` ${SHADOW_ROOT_MARK} `,
      `${SHADOW_ROOT_MARK} `,
    ]);
    // With scripts on, nothing is marked, and the page's scripts may read its comments.
    assert.deepEqual(comments(await prepare(html, context({}))), [
      SHADOW_ROOT_MARK,
      ` ${SHADOW_ROOT_MARK} `,
      SHADOW_ROOT_MARK,
    ]);
  });

  it("makes the copy's root inert only when asked, and leaves a page's own inert root", async () => {
    const asked = await preparePage("<p>x</p>", context({}), { inertUntilWatched: true });
    assert.equal(asked.madeInert, true);
    assert.equal(parse(asked.html).documentElement.getAttribute("inert"), "");

    const own = await preparePage(`<html inert><p>x</p>`, context({}), {
      inertUntilWatched: true,
    });
    assert.equal(own.madeInert, false, "the view must not make the page act");
    assert.equal(parse(own.html).documentElement.hasAttribute("inert"), true);

    const unasked = await preparePage("<p>x</p>", context({}));
    assert.equal(unasked.madeInert, false);
    assert.equal(parse(unasked.html).documentElement.hasAttribute("inert"), false);
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
      ["an SVG <style> element", "<svg><style>p { margin: 0 }</style></svg><p>x</p>"],
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

    it("is added to a page whose only styles Chromium does not apply (#143)", async () => {
      for (const html of [
        "<math><style>p { margin: 0 }</style></math><p>x</p>",
        `<svg><link rel="stylesheet" href="style.css"></svg><p>x</p>`,
      ]) {
        const prepared = await preparePage(html, context({ "Saved/style.css": "p {}" }), {
          readingStyle: READING,
        });
        assert.equal(prepared.ownStyles, false, html);
        assert.notEqual(parse(prepared.html).getElementById(READING_STYLE_ID), null, html);
      }
    });

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
      const shadow = `<div><template shadowrootmode="open"><link rel="stylesheet" href="diary.md"><style>@import "diary.md";</style></template></div>`;
      assert.doesNotMatch(await prepare(shadow, ctx), /Private text/);
    });

    it("prepares the content of shadow roots and templates as the document's (#124)", async () => {
      const html = [
        `<div><template shadowrootmode="open">`,
        `<link rel="stylesheet" href="site.css"><style>@import "site.css";</style>`,
        `<img src="card.png"><p style="background: url(card.png)">x</p>`,
        `<div><template shadowrootmode="closed"><img srcset="sprites/025.png 2x"></template></div>`,
        `</template></div>`,
      ].join("");
      const ctx = locating();
      const copy = parse(await prepare(html, ctx));
      const outer = copy.querySelector("template")?.content;
      const inner = outer?.querySelector("template")?.content;
      const sheet = `body { background: url("${url("Theme/bg.png")}") }`;
      assert.equal(outer?.querySelector("link"), null);
      assert.deepEqual(
        [...(outer?.querySelectorAll("style") ?? [])].map((style) => style.textContent),
        [sheet, sheet],
      );
      assert.equal(outer?.querySelector("img")?.getAttribute("src"), url("Shared/card.png"));
      assert.equal(
        outer?.querySelector("p")?.getAttribute("style"),
        `background: url("${url("Shared/card.png")}")`,
      );
      assert.equal(
        inner?.querySelector("img")?.getAttribute("srcset"),
        `${url("Assets/sprites/025.png")} 2x`,
      );
      assert.deepEqual(ctx.reads, ["Theme/site.css", "Theme/site.css"]);
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
    const html = `<a href="#">top</a><a href="#fn1">1</a><a href="javascript:void(0)">js</a><a href="../">vault</a><a>no href</a>`;
    assert.deepEqual(await titles(html, "a"), [null, null, null, null, null]);
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

  it("gives links and images in shadow roots and templates theirs, also nested ones (#124)", async () => {
    const html = [
      `<div><template shadowrootmode="closed"><a href="https://example.com/a">a</a>`,
      `<img src="a.png" alt="In a shadow root">`,
      `<p><template shadowrootmode="open"><a href="glossary.html">b</a></template></p></template></div>`,
      `<template><area href="Other%20page.html"></template>`,
    ].join("");
    const copy = parse(await prepare(html, page()));
    const found: (string | null)[] = [];
    const visit = (root: ParentNode): void => {
      for (const element of root.querySelectorAll("a, area, img, template")) {
        if (element instanceof window.HTMLTemplateElement) visit(element.content);
        else found.push(element.getAttribute("title"));
      }
    };
    visit(copy);
    assert.deepEqual(found, [
      "https://example.com/a",
      "In a shadow root",
      "Shared/glossary.html",
      "Saved/Other page.html",
    ]);
  });

  describe("SVG links (#117)", () => {
    const XLINK = "http://www.w3.org/1999/xlink";

    async function svgTitles(html: string): Promise<[string, string | null, string | null][]> {
      const copy = parse(await prepare(`<svg>${html}</svg>`, page()));
      return [...copy.querySelectorAll("svg a")].map((link) => [
        link.id,
        link.getAttributeNS(XLINK, "title"),
        link.getAttribute("title"),
      ]);
    }

    it("shows where a link without text leads, as Chromium shows it, with href winning", async () => {
      const html = [
        `<a id="web" href="https://example.com/"><rect/></a>`,
        `<a id="legacy" xlink:href="Other%20page.html"><circle/></a>`,
        `<a id="both" href="glossary.html" xlink:href="https://example.com/"> <path/> </a>`,
        `<a id="fragment" href="#part"><rect/></a>`,
        `<a id="none"><rect/></a>`,
      ].join("");
      assert.deepEqual(await svgTitles(html), [
        ["web", "https://example.com/", null],
        ["legacy", "Saved/Other page.html", null],
        ["both", "Shared/glossary.html", null],
        ["fragment", null, null],
        ["none", null, null],
      ]);
    });

    it("leaves a link with text, whose name a tooltip would replace, or with a title of its own", async () => {
      const html = [
        `<a id="text" href="https://example.com/"><text>A label</text></a>`,
        `<a id="child" href="https://example.com/"><title>Its own</title><rect/></a>`,
        `<a id="xlink" href="https://example.com/" xlink:title="Its own"><rect/></a>`,
        `<a id="attribute" href="https://example.com/" title="Its own"><rect/></a>`,
      ].join("");
      assert.deepEqual(await svgTitles(html), [
        ["text", null, null],
        ["child", null, null],
        ["xlink", "Its own", null],
        ["attribute", null, "Its own"],
      ]);
    });

    it("leaves a link whose content may name it otherwise, as labels and titles inside do", async () => {
      const html = [
        `<symbol id="icon"><title>Home</title><rect/></symbol>`,
        `<a id="labelled" href="https://example.com/"><rect aria-label="Home"/></a>`,
        `<a id="labelledby" href="https://example.com/"><g><rect aria-labelledby="x"/></g></a>`,
        `<a id="nested-title" href="https://example.com/"><rect><title></title></rect></a>`,
        `<a id="described" href="https://example.com/"><g title="Home"><rect/></g></a>`,
        `<a id="image" href="https://example.com/"><foreignObject><img alt="Home"></foreignObject></a>`,
        `<a id="use" href="https://example.com/"><use href="#icon"/></a>`,
        `<a id="unlabelled" href="https://example.com/"><g><rect/></g></a>`,
        // The link's own label names it before a title, which then only describes it.
        `<a id="own-label" href="https://example.com/" aria-label="Home"><rect/></a>`,
      ].join("");
      assert.deepEqual(await svgTitles(html), [
        ["labelled", null, null],
        ["labelledby", null, null],
        ["nested-title", null, null],
        ["described", null, null],
        ["image", null, null],
        ["use", null, null],
        ["unlabelled", "https://example.com/", null],
        ["own-label", "https://example.com/", null],
      ]);
    });

    it("leaves a link around HTML content, whose names the copy cannot see", async () => {
      const html = [
        `<a id="shadow-text" href="https://example.com/"><foreignObject><div>`,
        `<template shadowrootmode="open"><span>Home</span></template></div></foreignObject></a>`,
        `<a id="shadow-label" href="https://example.com/"><foreignObject><div>`,
        `<template shadowrootmode="open"><span role="img" aria-label="Home"></span></template>`,
        `</div></foreignObject></a>`,
        `<a id="control" href="https://example.com/"><foreignObject>`,
        `<input type="submit"></foreignObject></a>`,
        `<style>.home::before { content: "Home" }</style>`,
        `<a id="generated" href="https://example.com/"><foreignObject>`,
        `<span class="home"></span></foreignObject></a>`,
        `<a id="empty" href="https://example.com/"><foreignObject></foreignObject></a>`,
      ].join("");
      assert.deepEqual(await svgTitles(html), [
        ["shadow-text", null, null],
        ["shadow-label", null, null],
        ["control", null, null],
        ["generated", null, null],
        ["empty", null, null],
      ]);
    });
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

  it("leaves a reference as it is when reading its file fails", async () => {
    const copy: LocalFiles = {
      size: () => 1,
      readBinary: () => Promise.reject(new Error("synthetic read failure")),
    };
    const html = `<img src="unreadable.png"><img src="unreadable.png">`;
    const prepared = await preparePage(html, context({}), { copyFiles: copy });
    const page = parse(prepared.html);
    assert.deepEqual(
      [...page.querySelectorAll("img")].map((image) => image.getAttribute("src")),
      ["unreadable.png", "unreadable.png"],
    );
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

  it("copies the files that shadow roots and templates name, within the page's limits (#124)", async () => {
    const files = {
      "Saved/a.png": "A",
      "Saved/b.png": "B",
      "Saved/x.woff2": "F",
      "Saved/notes.md": "Private text",
    };
    const copy = localFiles(files, { "Saved/b.png": 7_000_000 });
    const html = [
      `<img src="a.png">`,
      `<div><template shadowrootmode="closed"><img src="a.png"><img src="notes.md">`,
      `<style>@font-face { src: url(x.woff2) }</style>`,
      `<div><template shadowrootmode="open">${`<img src="b.png">`.repeat(5)}</template></div>`,
      `</template></div>`,
    ].join("");
    const prepared = await preparePage(html, context({}), { copyFiles: copy });
    const page = parse(prepared.html);
    const outer = page.querySelector("template")?.content;
    const inner = outer?.querySelector("template")?.content;
    assert.equal(page.querySelector("img")?.getAttribute("src"), data("image/png", "A"));
    assert.deepEqual(
      [...(outer?.querySelectorAll("img") ?? [])].map((image) => image.getAttribute("src")),
      [data("image/png", "A"), "notes.md"],
    );
    assert.equal(
      outer?.querySelector("style")?.textContent,
      `@font-face { src: url("${data("font/woff2", "F")}") }`,
    );
    // Four copies of 7 MB fit in the page's 32 MB, a fifth does not.
    assert.deepEqual(
      [...(inner?.querySelectorAll("img") ?? [])].map((image) =>
        image.getAttribute("src")?.startsWith("data:"),
      ),
      [true, true, true, true, false],
    );
    assert.deepEqual(prepared.copiedFiles, { copied: 3, leftOut: 1 });
    assert.deepEqual(copy.reads.sort(), ["Saved/a.png", "Saved/b.png", "Saved/x.woff2"]);
  });

  it("copies nothing unless asked", async () => {
    const prepared = await preparePage(`<img src="a.png">`, context({}));
    assert.equal(prepared.copiedFiles, undefined);
    assert.equal(parse(prepared.html).querySelector("img")?.getAttribute("src"), "a.png");
  });
});
