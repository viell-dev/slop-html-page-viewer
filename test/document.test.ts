import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./support/dom";
import {
  absoluteUrls,
  COPY_FILE_LIMIT,
  COPY_PAGE_LIMIT,
  DISCARD_LIMIT,
  inlineStylesheet,
  type LocalFiles,
  type PageContext,
  type PageOptions,
  pagePolicy,
  preparePage,
  SHADOW_ROOT_MARK,
  STYLE_ELEMENT_LIMIT,
  STYLESHEET_COUNT_LIMIT,
  STYLESHEET_TEXT_LIMIT,
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
    const [result, ...more] = await inlineStylesheet(
      '@import/**/"real.css" screen;\n' + literal,
      ctx.pageUrl,
      ctx,
    );
    assert.deepEqual(ctx.reads, ["Saved/real.css"]);
    assert.deepEqual(more, []);
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
    // The link first, with its import, then the shadow root's own <style>,
    // whose import of the same file reads it no more (#154).
    assert.deepEqual(ctx.reads, ["Saved/sheet.css", "Saved/real.css"]);
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
    for (const [html, kept = html] of [
      [
        '<svg><style><desc>@import "ghost.css";</desc>circle { fill: red }<desc>a { b: url(ghost.png) }</desc></style></svg>',
      ],
      ['<math><style>@import "ghost.css"; a { b: url(ghost.png) }</style></math>'],
      // The child element's quote is not the <style>'s text, so the string stays a string (#91).
      // The copy closes that string and its block, as CSS does at the end of the text (#155).
      [
        '<svg><style>a{}<desc>"</desc> b::after { content: "url(ghost.png)" } c { d: "</style></svg>',
        '<svg><style>a{} b::after { content: "url(ghost.png)" } c { d: ""}<desc>"</desc></style></svg>',
      ],
    ]) {
      for (const place of places) {
        for (const { copying, reads, copies, html: copy } of await prepared(place(html))) {
          const what = `${place(html)}, copying: ${copying}`;
          assert.deepEqual({ reads, copies }, { reads: [], copies: [] }, what);
          assert.ok(copy.includes(kept), what);
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
        // Without copying, the URL keeps its text, which the copy's <base> resolves (#177).
        const url = copying ? 'url("data:image/png;base64,AQ==")' : "url(real.png)";
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
            text: `REAL{} c { d: ${url} }`,
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

describe("<style> and <link> elements that Chromium applies, by type and disabled (#147)", () => {
  // As #147 measured in Obsidian 1.5.3 and 1.15.1, and resources.e2e.ts checks
  // against Chromium: a <style> applies only with exactly text/css, and a link
  // loads with a MIME type whose essence is empty or text/css, unless disabled.
  const shadow = (html: string) => `<div><template shadowrootmode="open">${html}</template></div>`;
  const places = [(html: string) => html, shadow];
  const typed = (type: string | null) => (type === null ? "" : ` type="${type}"`);
  const emSpace = String.fromCodePoint(0x2003);
  const noBreakSpace = String.fromCodePoint(0xa0);

  /** Prepares a page in the document and in a shadow root, without and with copying files. */
  async function prepared(html: string) {
    const results = [];
    for (const place of places) {
      for (const copying of [false, true]) {
        const ctx = context({ "Saved/real.css": "REAL{}" });
        const copies: string[] = [];
        const copyFiles: LocalFiles = {
          size: () => 1,
          async readBinary(path) {
            copies.push(path);
            return new Uint8Array([1]).buffer;
          },
        };
        const result = await preparePage(place(html), ctx, copying ? { copyFiles } : {});
        const page = parse(result.html);
        const root = page.querySelector("template")?.content ?? page;
        const what = `${place(html)}, copying: ${copying}`;
        results.push({ what, copying, reads: ctx.reads, copies, html: result.html, root });
      }
    }
    return results;
  }

  it("prepares a <style> whose type is CSS, and leaves any other as the page has it", async () => {
    const css = '@import "real.css"; p { b: url(real.png) }';
    for (const type of [null, "", "text/css", "TEXT/CSS", "Text/Css"]) {
      for (const { what, copying, reads, copies, root } of await prepared(
        `<style${typed(type)}>${css}</style>`,
      )) {
        // Without copying, the URL keeps its text, which the copy's <base> resolves (#177).
        const url = copying ? 'url("data:image/png;base64,AQ==")' : "url(real.png)";
        assert.deepEqual(
          { reads, copies, text: root.querySelector("style")!.textContent },
          {
            reads: ["Saved/real.css"],
            copies: copying ? ["Saved/real.png"] : [],
            text: `REAL{} p { b: ${url} }`,
          },
          what,
        );
      }
    }
    for (const type of [
      "text/css; charset=utf-8",
      "text/css;",
      " text/css",
      "text/css ",
      "\ttext/css\n",
      `${emSpace}text/css`,
      " ",
      ";",
      "text/x-scss",
      "text/plain",
      "text/css2",
    ]) {
      // Its text stays as written, for the page's scripts to read, with an
      // unquoted URL at its end left open.
      const style = `<style${typed(type)}>${css} q { r: url(open.png</style>`;
      for (const { what, reads, copies, html } of await prepared(style)) {
        assert.deepEqual({ reads, copies }, { reads: [], copies: [] }, what);
        assert.ok(html.includes(style), what);
      }
    }
  });

  it("prepares an SVG <style> by the same type rule as an HTML one", async () => {
    // As Chromium 150 (Obsidian 1.15.1) applies it. Chromium 114 (Obsidian
    // 1.5.3) applies TEXT/CSS on an SVG <style> only in lowercase.
    const css = '@import "real.css"; circle { fill: red }';
    for (const [type, applies] of [
      [null, true],
      ["", true],
      ["text/css", true],
      ["TEXT/CSS", true],
      ["text/css; charset=utf-8", false],
      [" text/css", false],
    ] as const) {
      const svg = `<svg><style${typed(type)}>${css}</style></svg>`;
      for (const { what, reads, html } of await prepared(svg)) {
        assert.deepEqual(reads, applies ? ["Saved/real.css"] : [], what);
        assert.equal(html.includes(svg), !applies, what);
      }
    }
  });

  it("ignores a <style>'s disabled attribute, which applies it as any other", async () => {
    for (const { what, reads, root } of await prepared(
      '<style disabled>@import "real.css";</style>',
    )) {
      assert.deepEqual(reads, ["Saved/real.css"], what);
      assert.equal(root.querySelector("style")!.textContent, "REAL{}", what);
    }
  });

  it("replaces a link whose type is CSS, and keeps a disabled one or any other as it is", async () => {
    for (const type of [
      null,
      "",
      "text/css",
      "TEXT/CSS",
      "text/css; charset=utf-8",
      "text/css;charset=utf-8",
      " TEXT/CSS ; a=b",
      "text/css;",
      " text/css",
      "text/css ",
      " ",
      ";",
      "\ttext/css\n",
      "\vtext/css",
      `${emSpace}text/css${emSpace}`,
    ]) {
      const link = `<link rel="stylesheet"${typed(type)} href="real.css">`;
      for (const { what, reads, root } of await prepared(link)) {
        assert.deepEqual(
          { reads, links: root.querySelectorAll("link").length },
          { reads: ["Saved/real.css"], links: 0 },
          what,
        );
        assert.equal(root.querySelector("style")!.outerHTML, "<style>REAL{}</style>", what);
      }
    }
    for (const link of [
      ...["text/x-scss", "text/plain", "text/css2", `${noBreakSpace}text/css`, "css"].map(
        (type) => `<link rel="stylesheet"${typed(type)} href="real.css">`,
      ),
      // Only whether it has the attribute counts, whatever its value.
      ...["", '=""', '="false"'].map(
        (value) => `<link rel="stylesheet" type="text/css" href="real.css" disabled${value}>`,
      ),
    ]) {
      for (const { what, reads, root } of await prepared(link)) {
        assert.deepEqual(
          {
            reads,
            links: root.querySelectorAll("link").length,
            styles: root.querySelectorAll("style").length,
          },
          { reads: [], links: 1, styles: 0 },
          what,
        );
        assert.equal(
          root.querySelector("link")!.outerHTML,
          parse(link).querySelector("link")!.outerHTML,
          what,
        );
      }
    }
  });

  it("trims exactly the whitespace that Chromium trims from around a link type's essence", async () => {
    // As headless Chrome 158 loads a link with each on both sides of text/css;
    // TESTING.md names the ones measured in Obsidian.
    const trimmed = [
      ...[0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x1680],
      ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
      ...[0x2028, 0x205f, 0x3000],
    ];
    const kept = [
      ...[0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0xa0, 0x180e],
      ...[0x200b, 0x200c, 0x200e, 0x2029, 0x202f, 0x2060, 0xfeff],
    ];
    for (const code of [...trimmed, ...kept]) {
      const space = String.fromCodePoint(code);
      const name = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
      const link = `<link rel="stylesheet" type="${space}text/css${space}" href="real.css">`;
      for (const { what, reads } of await prepared(link)) {
        assert.deepEqual(
          reads,
          trimmed.includes(code) ? ["Saved/real.css"] : [],
          `${name}: ${what}`,
        );
      }
    }
  });
});

describe("attributes that HTML splits or strips on ASCII whitespace (#192)", () => {
  // HTML splits a link's rel and a srcset, and strips a URL attribute, on
  // ASCII whitespace only, as resources.e2e.ts checks against Chromium.
  // JavaScript's \s also matches each of these.
  const unicodeSpaces = [
    ...[0x0b, 0xa0, 0x1680],
    ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
    ...[0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff],
  ];
  const named = (code: number) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  const nbsp = String.fromCodePoint(0xa0);
  const emSpace = String.fromCodePoint(0x2003);

  /** What preparing a page reads, and how many links the copy keeps. */
  async function linkPage(html: string) {
    const ctx = context({ "Saved/real.css": "REAL{}" });
    const copy = parse(await prepare(html, ctx));
    return { reads: ctx.reads, links: copy.querySelectorAll("link").length };
  }

  it("reads a link only when ASCII whitespace separates stylesheet from its other types", async () => {
    for (const code of unicodeSpaces) {
      const space = String.fromCodePoint(code);
      for (const rel of [`stylesheet${space}x`, `x${space}stylesheet`, `${space}stylesheet`]) {
        assert.deepEqual(
          await linkPage(`<link rel="${rel}" href="real.css">`),
          { reads: [], links: 1 },
          `${named(code)} in ${JSON.stringify(rel)}`,
        );
      }
    }
    // A tab, a form feed, or a carriage return, which the parser keeps only
    // from a character reference, splits it as in Chromium 150; Chromium 114
    // takes them for part of a type (TESTING.md's limits).
    for (const rel of [
      "stylesheet x",
      "x\tstylesheet",
      "x\nstylesheet",
      "x\fstylesheet",
      "x&#13;stylesheet",
    ]) {
      assert.deepEqual(
        await linkPage(`<link rel="${rel}" href="real.css">`),
        { reads: ["Saved/real.css"], links: 0 },
        JSON.stringify(rel),
      );
    }
    // The parser reads a literal carriage return as a line feed.
    for (const rel of ["STYLESHEET", " StyleSheet\r"]) {
      assert.deepEqual(
        await linkPage(`<link rel="${rel}" href="real.css">`),
        { reads: ["Saved/real.css"], links: 0 },
        JSON.stringify(rel),
      );
    }
  });

  it("names no stylesheet set, and applies no alternate one, with such a link", async () => {
    const files = { "Saved/a.css": "A{}", "Saved/b.css": "B{}", "Saved/c.css": "C{}" };
    const ctx = context(files);
    await prepare(
      [
        `<link rel="stylesheet${nbsp}x" title="A" href="a.css">`,
        `<link rel="stylesheet" title="B" href="b.css">`,
        `<style title="A">@import "c.css";</style>`,
        `<link rel="alternate${nbsp}stylesheet" title="B" href="c.css">`,
      ].join(""),
      ctx,
    );
    assert.deepEqual(ctx.reads, ["Saved/b.css"]);
  });

  it("copies the file of a URL attribute or a srcset candidate that holds such a space, and splits a srcset on ASCII whitespace", async () => {
    const copies: string[] = [];
    const copyFiles: LocalFiles = {
      size: () => 1,
      async readBinary(path) {
        copies.push(path);
        return new Uint8Array([1]).buffer;
      },
    };
    const copy = parse(
      await prepare(
        [
          `<img src=" ${nbsp}nb.png "><img srcset="a${nbsp}b.png 2x, c.png 1x">`,
          `<img srcset="ff.png\f1x, tab.png\t2x"><script src="${emSpace}s.js"></script>`,
        ].join(""),
        context({}),
        { copyFiles },
      ),
    );
    assert.deepEqual(
      copies.sort(),
      [
        ...[`Saved/${nbsp}nb.png`, `Saved/a${nbsp}b.png`, "Saved/c.png"],
        ...["Saved/ff.png", "Saved/tab.png", `Saved/${emSpace}s.js`],
      ].sort(),
    );
    const data = (type: string) => `data:${type};base64,AQ==`;
    assert.deepEqual(
      [...copy.images].map((image) => image.getAttribute("src") ?? image.getAttribute("srcset")),
      [
        data("image/png"),
        `${data("image/png")} 2x, ${data("image/png")} 1x`,
        `${data("image/png")}\f1x, ${data("image/png")}\t2x`,
      ],
    );
  });

  it("finds by name only the reference that such an attribute names, with its spaces", async () => {
    const ctx: PageContext = {
      ...context({}),
      exists: () => false,
      locate: (linktext) => (linktext === "nb.png" ? "Found/nb.png" : null),
    };
    const html = `<img src="${nbsp}nb.png"><img srcset="${nbsp}nb.png 2x">`;
    const copy = parse(await prepare(html, ctx));
    assert.deepEqual(
      [...copy.images].map((image) => image.getAttribute("src") ?? image.getAttribute("srcset")),
      [`${nbsp}nb.png`, `${nbsp}nb.png 2x`],
    );
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
  assert.deepEqual(result, ["@media ) {\nREAL{}\n} GHOST{}"]);
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

describe("stylesheet limits (#154)", () => {
  /** A <style> that imports each of `names` once, in order. */
  const importing = (names: string[]) =>
    `<style>${names.map((name) => `@import "${name}";`).join("\n")}</style>`;

  it("follows at most the limit's number of imports, leaving the rest as imports", async () => {
    const names = Array.from({ length: STYLESHEET_COUNT_LIMIT + 1 }, (_, i) => `s${i}.css`);
    const ctx = context(Object.fromEntries(names.map((name, i) => [`Saved/${name}`, `.s${i}{}`])));
    const text = parse(await prepare(importing(names), ctx)).querySelector("style")!.textContent;
    assert.equal(ctx.reads.length, STYLESHEET_COUNT_LIMIT);
    assert.equal(text.split("{}").length - 1, STYLESHEET_COUNT_LIMIT);
    // The one past the limit is not read, and stays an import, which
    // Obsidian's policy keeps from loading. It declares no layer, so where it
    // stands does not matter, and it needs no stylesheet of its own (#152).
    assert.ok(text.endsWith(`\n@import url("${VAULT}Saved/s${STYLESHEET_COUNT_LIMIT}.css");`));
  });

  it("shares the count between links and imports, in the document and shadow roots alike", async () => {
    const names = Array.from({ length: STYLESHEET_COUNT_LIMIT - 2 }, (_, i) => `d${i}.css`);
    const ctx = context({
      ...Object.fromEntries(names.map((name) => [`Saved/${name}`, ".d {}"])),
      "Saved/x.css": ".x {}",
      "Saved/y.css": ".y {}",
      "Saved/z.css": ".z {}",
      "Saved/w.css": ".w {}",
    });
    // The document's link and its <style>'s imports take all but one;
    // a shadow root's first link takes the last.
    const html = [
      '<link rel="stylesheet" href="y.css">',
      importing(names),
      '<div><template shadowrootmode="open">',
      '<link rel="stylesheet" href="z.css"><link rel="stylesheet" href="w.css">',
      '<style>@import "x.css";</style>',
      "</template></div>",
    ].join("");
    const copy = parse(await prepare(html, ctx));
    const content = copy.querySelector("template")!.content;
    assert.equal(copy.querySelectorAll("link").length, 0);
    // A link past the limit stays a link, which Obsidian's policy keeps from loading.
    assert.deepEqual(
      [...content.children].map((element) => element.outerHTML),
      [
        "<style>.z {}</style>",
        '<link rel="stylesheet" href="w.css">',
        `<style>@import url("${VAULT}Saved/x.css");</style>`,
      ],
    );
    assert.equal(ctx.reads.length, STYLESHEET_COUNT_LIMIT);
    assert.ok(!ctx.reads.includes("Saved/w.css") && !ctx.reads.includes("Saved/x.css"));
  });

  it("shows whole a page of components that each link or import the same stylesheet", async () => {
    // Shadow roots that share a stylesheet each link it, as declarative shadow
    // DOM has them do. 550 link it and 550 import it, each stylesheet with an
    // import of its own: each kind alone follows more links and imports than
    // the limit allows, but the page's repeats of a stylesheet that it has
    // prepared whole take nothing from the count.
    const ctx = context({
      "Saved/item.css": `@import "tokens.css";\n.item { color: red }`,
      "Saved/tokens.css": ":host { --gap: 4px }",
    });
    const component = (sheet: string) =>
      `<x-item><template shadowrootmode="open">${sheet}<p class="item">x</p></template></x-item>`;
    const html = [
      ...Array<string>(550).fill(component('<link rel="stylesheet" href="item.css">')),
      ...Array<string>(550).fill(component('<style>@import "item.css";</style>')),
    ].join("");
    const copy = parse(await prepare(html, ctx));
    const sheets = [...copy.querySelectorAll("template")].map(({ content }) =>
      [...content.querySelectorAll("link, style")].map((e) => e.textContent),
    );
    assert.equal(sheets.length, 1_100);
    assert.deepEqual(
      new Set(sheets.map((sheet) => JSON.stringify(sheet))),
      new Set([JSON.stringify([":host { --gap: 4px }\n.item { color: red }"])]),
    );
    assert.deepEqual(ctx.reads, ["Saved/item.css", "Saved/tokens.css"]);
  });

  it("counts a repeated link or import of a stylesheet that cannot be read once", async () => {
    const ctx = context({ "Saved/footer.css": ".footer {}", "Saved/end.css": ".end {}" });
    const read = ctx.read.bind(ctx);
    ctx.read = async (path) => {
      if (path !== "Saved/broken.css") return read(path);
      ctx.reads.push(path);
      throw new Error("unreadable");
    };
    const component = (sheet: string) =>
      `<x-item><template shadowrootmode="open">${sheet}</template></x-item>`;
    const html = [
      // More components than the limit, each linking a stylesheet that is
      // missing, then one whose stylesheet is there.
      ...Array<string>(STYLESHEET_COUNT_LIMIT).fill(
        component('<link rel="stylesheet" href="missing.css">'),
      ),
      component('<link rel="stylesheet" href="footer.css">'),
      // As many imports of a stylesheet whose read fails, then one that is there.
      importing([...Array<string>(STYLESHEET_COUNT_LIMIT).fill("broken.css"), "end.css"]),
    ].join("");
    const copy = parse(await prepare(html, ctx));
    const last = [...copy.querySelectorAll("template")].at(-1)!.content;
    assert.equal(last.querySelector("style")?.textContent, ".footer {}");
    assert.ok(copy.querySelector("body > style")!.textContent.endsWith("\n.end {}"));
    // The document's <style> is prepared before the templates' content.
    assert.deepEqual(ctx.reads, [
      "Saved/broken.css",
      "Saved/end.css",
      "Saved/missing.css",
      "Saved/footer.css",
    ]);
  });

  it("gives a link and an import of the same stylesheet one text, closed at its end (#155)", async () => {
    // The rules after the import stay outside the stylesheet's block. The
    // document's link is prepared first, and its import before a shadow
    // root's link, so each kind repeats the other.
    const sheets = [
      '<link rel="stylesheet" href="open.css">',
      '<style>@import "open.css";</style>',
    ];
    for (const [first, second] of [sheets, [...sheets].reverse()]) {
      const ctx = context({ "Saved/open.css": ".open { color: blue" });
      const html = `${first}<div><template shadowrootmode="open">${second}</template></div>`;
      const copy = parse(
        await prepare(html.replace("</style>", "\n.after { color: red }</style>"), ctx),
      );
      const texts = [copy, copy.querySelector("template")!.content].flatMap((root) =>
        [...root.querySelectorAll("style")].map((style) => style.textContent),
      );
      const imported = ".open { color: blue}\n.after { color: red }";
      assert.deepEqual(
        texts,
        first === sheets[0]
          ? [".open { color: blue}", imported]
          : [imported, ".open { color: blue}"],
      );
      assert.deepEqual(ctx.reads, ["Saved/open.css"]);
    }
  });

  it("counts a link and an import of the same stylesheet once (#155)", async () => {
    // The link, its import's repeat, and the other imports take the whole
    // count, so last.css fits only if the repeat takes nothing from it.
    const names = Array.from({ length: STYLESHEET_COUNT_LIMIT - 2 }, (_, i) => `d${i}.css`);
    const ctx = context({
      ...Object.fromEntries(names.map((name) => [`Saved/${name}`, ".d {}"])),
      "Saved/x.css": ".x {}",
      "Saved/last.css": ".last {}",
    });
    const html = `<link rel="stylesheet" href="x.css">${importing([...names, "x.css", "last.css"])}`;
    const styles = [...parse(await prepare(html, ctx)).querySelectorAll("style")];
    assert.equal(styles[0].textContent, ".x {}");
    assert.ok(
      styles[1].textContent.endsWith("\n.x {}\n.last {}"),
      styles[1].textContent.slice(-60),
    );
  });

  it("keeps a linked stylesheet's stray } for a repeated import of it with media conditions", async () => {
    // The link's stylesheet is kept with its stray "}", so the import that
    // repeats it stays an import, as it would on its own.
    const ctx = context({ "Saved/stray.css": "} .stray { color: blue }" });
    const html =
      '<link rel="stylesheet" href="stray.css"><style>@import "stray.css" screen;</style>';
    const copy = parse(await prepare(html, ctx));
    assert.deepEqual(
      [...copy.querySelectorAll("style")].map((style) => style.textContent),
      ["} .stray { color: blue }", `@import url("${VAULT}Saved/stray.css") screen;`],
    );
    assert.deepEqual(ctx.reads, ["Saved/stray.css"]);
  });

  it("leaves a repeated import of a stylesheet with a stray } in media conditions an import", async () => {
    // In an @media block, the "}" would end the block early, so each import
    // of the stylesheet stays an import, the repeat as the first.
    const ctx = context({ "Saved/stray.css": "} .stray { color: blue }" });
    const imports = '@import "stray.css" screen;\n'.repeat(2);
    const copy = parse(await prepare(`<style>${imports}</style>`, ctx));
    assert.equal(
      copy.querySelector("style")!.textContent,
      `@import url("${VAULT}Saved/stray.css") screen;\n`.repeat(2),
    );
  });

  it("takes a repeated link or import's text from the text limit each time", async () => {
    // Three copies of this stylesheet would take the page past the text
    // limit, as three files of the same size would; a smaller one still fits.
    const third = `/*${"x".repeat(STYLESHEET_TEXT_LIMIT / 3 - 3)}*/`;
    const ctx = context({ "Saved/third.css": third, "Saved/small.css": ".small {}" });
    const links = [...Array<string>(6).fill("third"), "small", "small"].map(
      (name) => `<link rel="stylesheet" href="${name}.css">`,
    );
    const copy = await prepare(links.join(""), ctx);
    assert.equal(copy.split(`<style>${third}</style>`).length - 1, 2);
    assert.equal(copy.split('<link rel="stylesheet" href="third.css">').length - 1, 4);
    assert.equal(copy.split("<style>.small {}</style>").length - 1, 2);
    assert.deepEqual(ctx.reads, ["Saved/third.css", "Saved/small.css"]);
  });

  it("prepares again a repeated link or import whose stylesheets the count cut short", async () => {
    // all.css imports more stylesheets than the limit allows. Kept as it was
    // first prepared, a repeat of it would hold what the limit has left out
    // since, so the repeat is prepared again, which the limit refuses.
    const names = Array.from({ length: STYLESHEET_COUNT_LIMIT }, (_, i) => `s${i}.css`);
    const ctx = context({
      ...Object.fromEntries(names.map((name, i) => [`Saved/${name}`, `.s${i} {}`])),
      "Saved/all.css": names.map((name) => `@import "${name}";`).join("\n"),
    });
    const link = '<link rel="stylesheet" href="all.css">';
    const copy = parse(await prepare(link + link, ctx));
    const styles = [...copy.querySelectorAll("style")].map((style) => style.textContent);
    assert.equal(styles.length, 1);
    assert.equal(styles[0].split(" {}").length - 1, STYLESHEET_COUNT_LIMIT - 1);
    assert.equal(copy.querySelectorAll("link").length, 1);
  });

  it("prepares again a repeated link or import whose stylesheets the text limit cut short", async () => {
    // wrap.css imports big.css twice, which fits once. Prepared again, the
    // repeat keeps its own rules, with both imports left as imports.
    const big = `/*${"x".repeat(STYLESHEET_TEXT_LIMIT / 2)}*/`;
    const ctx = context({
      "Saved/wrap.css": '@import "big.css";\n@import "big.css";\n.wrap {}',
      "Saved/big.css": big,
    });
    const link = '<link rel="stylesheet" href="wrap.css">';
    const copy = await prepare(link + link, ctx);
    const left = `@import url("${VAULT}Saved/big.css");`;
    assert.equal(copy.split(`<style>${big}\n${left}\n.wrap {}</style>`).length - 1, 1);
    assert.equal(copy.split(`<style>${left}\n${left}\n.wrap {}</style>`).length - 1, 1);
    assert.ok(!copy.includes("<link"));
  });

  it("copies a repeated stylesheet's files once for each place, within the copy limits", async () => {
    const ctx = context({ "Saved/item.css": ".item { background: url(dot.png) }" });
    const component = `<x-item><template shadowrootmode="open"><link rel="stylesheet" href="item.css"></template></x-item>`;
    const copies: string[] = [];
    const copyFiles: LocalFiles = {
      size: () => 1_000_000,
      async readBinary(path) {
        copies.push(path);
        return new Uint8Array([1]).buffer;
      },
    };
    const result = await preparePage(component.repeat(40), ctx, { copyFiles });
    // Each place counts against the page's limit, so 32 of the 40 fit in 32 MB.
    assert.equal(result.html.split('url("data:image/png;base64,AQ==")').length - 1, 32);
    assert.equal(result.html.split(`url("${VAULT}Saved/dot.png")`).length - 1, 8);
    assert.deepEqual(result.copiedFiles, { copied: 1, leftOut: 1 });
    assert.deepEqual(copies, ["Saved/dot.png"]);
  });

  it("counts every link and import that it follows, also of missing, too large, and left out stylesheets", async () => {
    // The page's repeated links and imports of a stylesheet prepared whole
    // count once, so these are imports in a linked stylesheet, which count
    // each time.
    const over = 200;
    const stray = 200;
    // The link and its stylesheet's imports take the whole count.
    const missing = STYLESHEET_COUNT_LIMIT - 1 - over - 2 * stray;
    const first = (missing: number) =>
      [
        ...Array<string>(missing).fill('@import "missing.css";'),
        ...Array<string>(over).fill('@import "over.css";'),
        // An import with media conditions of a stylesheet with a "}" outside
        // any block stays an import, after following that stylesheet's own.
        ...Array<string>(stray).fill('@import "stray.css" screen;'),
        '@import "real.css";',
      ].join("\n");
    const ctx = context({
      "Saved/counted.css": first(missing),
      "Saved/fits.css": first(missing - 1),
      "Saved/over.css": `/*${"x".repeat(STYLESHEET_TEXT_LIMIT)}*/`,
      "Saved/stray.css": '@import "child.css"; } .stray {}',
      "Saved/child.css": ".child {}",
      "Saved/real.css": ".real {}",
    });
    const sheet = async (name: string) => {
      const copy = parse(await prepare(`<link rel="stylesheet" href="${name}.css">`, ctx));
      return copy.querySelector("style")!.textContent;
    };
    // Each of them counts, so real.css is past the limit and not read.
    const counted = await sheet("counted");
    assert.ok(counted.endsWith(`\n@import url("${VAULT}Saved/real.css");`));
    assert.ok(!counted.includes(".stray"));
    assert.deepEqual(ctx.reads, [
      "Saved/counted.css",
      "Saved/missing.css",
      "Saved/over.css",
      "Saved/stray.css",
      "Saved/child.css",
    ]);
    // With one fewer, real.css fits.
    assert.ok((await sheet("fits")).endsWith("\n.real {}"));
  });

  it("leaves out a stylesheet whose text would take the page past its limit, but not one after it", async () => {
    const comment = (length: number) => `/*${"x".repeat(length - 4)}*/`;
    const ctx = context({
      "Saved/exact.css": comment(STYLESHEET_TEXT_LIMIT),
      "Saved/over.css": comment(STYLESHEET_TEXT_LIMIT + 1),
      "Saved/small.css": ".small {}",
    });
    // A stylesheet of exactly the limit fits, alone.
    const exact = await prepare('<link rel="stylesheet" href="exact.css">', ctx);
    assert.ok(!exact.includes("<link"));
    assert.ok(exact.includes(`<style>${comment(STYLESHEET_TEXT_LIMIT)}</style>`));

    const html = [
      '<link rel="stylesheet" href="over.css">',
      '<link rel="stylesheet" href="small.css">',
      '<style>@import "over.css"; @import "small.css";</style>',
    ].join("");
    ctx.reads.length = 0;
    const copy = parse(await prepare(html, ctx));
    assert.equal(copy.querySelector("link")?.getAttribute("href"), "over.css");
    assert.deepEqual(
      [...copy.querySelectorAll("style")].map((style) => style.textContent),
      [".small {}", `@import url("${VAULT}Saved/over.css"); .small {}`],
    );
    // Each file is read once, however often the page names it.
    assert.deepEqual(ctx.reads, ["Saved/over.css", "Saved/small.css"]);
  });
});

it("handles repeated malformed URL openers without quadratic work", () => {
  const css = "url(".repeat(20_000);
  const start = performance.now();
  assert.equal(absoluteUrls(css, VAULT + "site.css"), css);
  assert.ok(performance.now() - start < 2_000, "80 KB of malformed CSS must finish within 2 s");
});

/**
 * Prepares a stylesheet in each place that a page can have one: a <style>, a
 * linked file, and both of those in a shadow root (#124), each with and
 * without copying local files. Reports, for each, the stylesheets read apart
 * from the linked one, the files copied, and the prepared stylesheet's text.
 */
async function everyPlace(css: string, files: Record<string, string>) {
  const results: {
    place: string;
    reads: string[];
    copies: string[];
    text: string;
    texts: string[];
  }[] = [];
  const sheets = [`<style>${css}</style>`, '<link rel="stylesheet" href="sheet.css">'];
  const shadow = (sheet: string) =>
    `<div><template shadowrootmode="open">${sheet}</template></div>`;
  for (const html of [...sheets, ...sheets.map(shadow)]) {
    for (const copying of [false, true]) {
      const ctx = context({ ...files, "Saved/sheet.css": css });
      const copies: string[] = [];
      const copyFiles: LocalFiles = {
        size: () => 1,
        async readBinary(path) {
          copies.push(path);
          return new Uint8Array([1]).buffer;
        },
      };
      const result = await preparePage(html, ctx, copying ? { copyFiles } : {});
      const doc = parse(result.html);
      const root = html.includes("<template") ? doc.querySelector("template")!.content : doc;
      results.push({
        place: `${html}${copying ? ", copying" : ""}`,
        reads: ctx.reads.filter((path) => path !== "Saved/sheet.css"),
        copies,
        text: root.querySelector("style")!.textContent,
        texts: [...root.querySelectorAll("style")].map((style) => style.textContent),
      });
    }
  }
  return results;
}

describe("what rewriting a stylesheet adds to the text limit (#177)", () => {
  const LIMIT = STYLESHEET_TEXT_LIMIT;
  // In a folder with a long name, each URL made absolute takes the name, so
  // that a short stylesheet can take the whole limit.
  const folder = "f".repeat(2_000);
  const file = `${folder}/sheet.css`;
  const link = (href: string) => `<link rel="stylesheet" href="${href}">`;
  const rule = "a{b:url(c)}";
  /** How long the copy writes `rule`, in the folder or in another. */
  const ruleIn = (path: string) => `a{b:url("${VAULT}${path}/c")}`.length;
  /** How long the copy writes `rule` in the folder. */
  const copied = ruleIn(`Saved/${folder}`);

  /**
   * A stylesheet of `unit`s, each `copied` characters long in the copy, then a
   * comment, which takes it to `length` characters in the copy: closed in the
   * file, or left open, for CSS to close with `*\/` (#155).
   */
  function sheetOf(unit: string, copied: number, length: number, open = false): string {
    const count = Math.floor((length - 4) / copied);
    const comment = `/*${"x".repeat(length - 4 - count * copied)}`;
    return unit.repeat(count) + comment + (open ? "" : "*/");
  }

  /** A stylesheet of a comment, `length` characters long. */
  const comment = (length: number) => `/*${"x".repeat(length - 4)}*/`;

  /** The text of the copy's only `<style>`, read from the copy's text, or null if there is none. */
  function onlyStyle(copy: string): string | null {
    const start = copy.indexOf("<style>");
    if (start === -1) return null;
    assert.equal(copy.indexOf("<style", start + 1), -1);
    return copy.slice(start + "<style>".length, copy.indexOf("</style>"));
  }

  /** Links a stylesheet in a page of its own, and returns its text in the copy, or null for a link. */
  async function linked(css: string, ctx: PageContext = context({ [`Saved/${file}`]: css })) {
    const copy = await prepare(link(file), ctx);
    return copy.includes("<link") ? null : onlyStyle(copy)?.length;
  }

  /**
   * A context that counts how often preparing asks whether each path exists:
   * once for each URL and import that it rewrites, and each link that it
   * resolves. Every path exists, so nothing is found by name.
   */
  function counting(files: Record<string, string>, page?: string) {
    const asked = new Map<string, number>();
    const ctx: PageContext & { reads: string[] } = {
      ...context(files, page),
      exists(path) {
        asked.set(path, (asked.get(path) ?? 0) + 1);
        return true;
      },
      locate: () => null,
    };
    return { ctx, looked: (path: string) => asked.get(path) ?? 0 };
  }

  it("counts its URLs as made absolute, wherever the page has it", async () => {
    // At the limit, its text takes less than 1 % of it; past it, it stays a
    // link or an import. What the page's <style> and the linked stylesheet
    // add to their imports counts before it.
    const kept = `@import url("${VAULT}Saved/${file}");`;
    const places = [
      {
        place: "a link",
        html: link(file),
        files: {} as Record<string, string>,
        room: LIMIT,
        left: "<link",
      },
      {
        place: "an import in a <style>",
        html: `<style>@import "${file}";</style>`,
        files: {},
        room: LIMIT - (kept.length - `@import "${file}";`.length),
        left: kept,
      },
      {
        place: "an import in a linked stylesheet",
        html: link("main.css"),
        files: { "Saved/main.css": `@import "${file}";` },
        room: LIMIT - kept.length,
        left: kept,
      },
    ];
    for (const { place, html, files, room, left } of places) {
      const fits = sheetOf(rule, copied, room);
      assert.ok(fits.length < LIMIT / 100, place);
      const copy = await prepare(html, context({ ...files, [`Saved/${file}`]: fits }));
      assert.equal(onlyStyle(copy)?.length, room, place);
      assert.ok(!copy.includes(left), place);
      const over = context({ ...files, [`Saved/${file}`]: sheetOf(rule, copied, room + 1) });
      assert.ok((await prepare(html, over)).includes(left), place);
    }
  });

  it("counts its URLs found by name as the copy writes them", async () => {
    const found = `Found/${folder}`;
    const located = (css: string): PageContext => ({
      ...context({ [`Saved/${file}`]: css }),
      exists: (path) => path === `${found}/c`,
      locate: (linktext) => (linktext === "c" ? `${found}/c` : null),
    });
    const copied = ruleIn(found);
    assert.equal(await linked("", located(sheetOf(rule, copied, LIMIT))), LIMIT);
    assert.equal(await linked("", located(sheetOf(rule, copied, LIMIT + 1))), null);
  });

  it("counts its strings that image-set() takes as URLs as made absolute (#179)", async () => {
    const unit = 'a{b:image-set("c")}';
    const copied = `a{b:image-set("${VAULT}Saved/${folder}/c")}`.length;
    assert.equal(await linked(sheetOf(unit, copied, LIMIT)), LIMIT);
    assert.equal(await linked(sheetOf(unit, copied, LIMIT + 1)), null);
  });

  it("counts its imports that stay imports as the copy writes them", async () => {
    // Imports of a file that is not a stylesheet, which stay imports.
    const unit = '@import "c";';
    const copied = `@import url("${VAULT}Saved/${folder}/c");`.length;
    assert.equal(await linked(sheetOf(unit, copied, LIMIT)), LIMIT);
    assert.equal(await linked(sheetOf(unit, copied, LIMIT + 1)), null);
  });

  it("counts the text that closes it at its end", async () => {
    // Its comment is left open, so CSS closes it with two characters.
    assert.equal(await linked(sheetOf(rule, copied, LIMIT, true)), LIMIT);
    assert.equal(await linked(sheetOf(rule, copied, LIMIT + 1, true)), null);
  });

  it("checks the text that closes it against the room, also without URLs", async () => {
    // After a stylesheet that leaves 100 characters, 50 "{" closed with 50
    // "}" fit, and 51 do not.
    for (const [open, fits] of [
      [50, true],
      [51, false],
    ] as const) {
      const ctx = context({
        "Saved/fill.css": comment(LIMIT - 100),
        [`Saved/${file}`]: "{".repeat(open),
      });
      const copy = await prepare(link("fill.css") + link(file), ctx);
      assert.equal(copy.includes(`<style>${"{".repeat(open)}${"}".repeat(open)}</style>`), fits);
      assert.equal(copy.includes(link(file)), !fits);
    }
  });

  it("stops rewriting once its text passes the room", async () => {
    // After a stylesheet that leaves 100,000 characters, a stylesheet of
    // 1,000 URLs, each 2 KB longer when made absolute, has rewritten about 45
    // of them when it passes the room.
    const room = 100_000;
    const { ctx, looked } = counting({
      "Saved/fill.css": comment(LIMIT - room),
      [`Saved/${file}`]: rule.repeat(1_000),
    });
    const copy = await prepare(link("fill.css") + link(file), ctx);
    assert.ok(copy.includes(link(file)));
    const most = Math.ceil(room / (copied - rule.length)) + 1;
    const rewritten = looked(`Saved/${folder}/c`);
    assert.ok(rewritten > 0 && rewritten <= most, `${rewritten} URLs rewritten`);
  });

  it("gives nothing back for a rewrite that shortens its text", async () => {
    // Made absolute, `url(  https://e.example/a  )` loses its two spaces on
    // each side but gains two quotes. The copy would be 2,000 characters
    // shorter than what counts, but a stylesheet that counts one more than
    // the limit still stays a link.
    const short = "a{b:url(  https://e.example/a  )}";
    const shorts = short.repeat(1_000);
    const sheet = (length: number) => shorts + sheetOf(rule, copied, length - shorts.length);
    const fits = await linked(sheet(LIMIT));
    assert.equal(fits, LIMIT - 2_000);
    assert.equal(await linked(sheet(LIMIT + 1)), null);
  });

  it("counts a repeat of the page's link of it as copied, each time", async () => {
    // Its text takes little of the limit, and its copy two fifths: the
    // first link takes its copy as each repeat does, so two fit.
    const css = sheetOf(rule, copied, (2 * LIMIT) / 5);
    const ctx = context({ [`Saved/${file}`]: css });
    const copy = await prepare(link(file).repeat(3), ctx);
    assert.equal(copy.split("<style>").length - 1, 2);
    assert.equal(copy.split("<link").length - 1, 1);
    assert.deepEqual(ctx.reads, [`Saved/${file}`]);
  });

  it("takes nothing from the text limit for one that stays a link, and its rewriting from the discard limit", async () => {
    // Its text, rewritten, reached one more than the limit when preparing it
    // stopped. A stylesheet after it may take what remains of the discard
    // limit, one less than the whole text limit, which it would have left
    // whole.
    const over = sheetOf(rule, copied, LIMIT + 1);
    const remains = DISCARD_LIMIT - (LIMIT + 1);
    assert.ok(remains < LIMIT);
    for (const [length, fits] of [
      [remains, true],
      [remains + 1, false],
    ] as const) {
      const ctx = context({ [`Saved/${file}`]: over, "Saved/after.css": comment(length) });
      const copy = await prepare(link(file) + link("after.css"), ctx);
      assert.ok(copy.includes(link(file)));
      assert.equal(onlyStyle(copy)?.length, fits ? length : undefined);
      assert.deepEqual(ctx.reads, [`Saved/${file}`, "Saved/after.css"]);
    }
  });

  it("refuses one too long for what remains of the discard limit without scanning it", async () => {
    // After a stylesheet that reached one more than the text limit, a
    // stylesheet of the whole text limit fits in that limit but not in what
    // remains of the discard limit. A scan of it, which would find that it
    // does not fit, would take its length from the discard limit: scanning
    // each of its URLs again took 121 s for 1,000 links of #177's stylesheet.
    // Refused before it is scanned, under each of three URLs, it takes
    // nothing, so a stylesheet of all that remains is still copied after them.
    const over = sheetOf(rule, copied, LIMIT + 1);
    const remains = DISCARD_LIMIT - (LIMIT + 1);
    const ctx = context({
      [`Saved/${file}`]: over,
      "Saved/whole.css": comment(LIMIT),
      "Saved/after.css": comment(remains),
    });
    const wholes = ["whole.css", "whole.css?1", "whole.css?2"].map(link).join("");
    const copy = await prepare(link(file) + wholes + link("after.css"), ctx);
    assert.equal(copy.split("<link").length - 1, 4);
    assert.equal(onlyStyle(copy)?.length, remains);
  });

  it("refuses a repeat of one that stays a link without preparing it again, and prepares its importer again", async () => {
    // Its importer's first link finds that it does not fit, and each later
    // one is refused it as remembered, which touches the importer's result
    // too: each of its three links prepares it, and rewrites its URL. The
    // stylesheet's own URLs are rewritten once, for all six.
    const over = sheetOf(rule, copied, LIMIT + 1);
    const { ctx, looked } = counting({
      [`Saved/${file}`]: over,
      "Saved/wrap.css": `@import "${file}"; w { b: url(w.png) }`,
    });
    const copy = await prepare(link("wrap.css").repeat(3) + link(file).repeat(3), ctx);
    // At most once: after what the importer takes, it passes the room a URL
    // or so before its end.
    const rewritten = looked(`Saved/${folder}/c`);
    assert.ok(rewritten > 0 && rewritten <= over.split("url(c)").length - 1, `${rewritten}`);
    assert.equal(looked("Saved/w.png"), 3);
    assert.equal(copy.split(link(file)).length - 1, 3);
    const wrap = `<style>@import url("${VAULT}Saved/${file}"); w { b: url("${VAULT}Saved/w.png") }</style>`;
    assert.equal(copy.split(wrap).length - 1, 3);
  });

  it("counts each link of one that stays a link toward the links and imports followed", async () => {
    // Its repeats are refused without preparing it, but each is followed, as
    // a repeat of one too large is: after the count's worth of links of it, a
    // small stylesheet stays a link, and after one fewer, it is copied.
    const over = sheetOf(rule, copied, LIMIT + 1);
    for (const [links, fits] of [
      [STYLESHEET_COUNT_LIMIT - 1, true],
      [STYLESHEET_COUNT_LIMIT, false],
    ] as const) {
      const ctx = context({ [`Saved/${file}`]: over, "Saved/small.css": "p{}" });
      const copy = await prepare(link(file).repeat(links) + link("small.css"), ctx);
      assert.equal(copy.includes("<style>p{}</style>"), fits, `${links} links`);
    }
  });

  it("prepares another URL of its file only within the discard limit", async () => {
    // Each URL of the file with a query of its own is another stylesheet's.
    // Two of them reach the limit, which leaves nothing of the discard limit:
    // the rest, and a small stylesheet after them, stay links unprepared.
    const over = sheetOf(rule, copied, LIMIT + 1);
    const { ctx, looked } = counting({ [`Saved/${file}`]: over, "Saved/after.css": "p{}" });
    const links = Array.from({ length: 5 }, (_, i) => link(`${file}?${i}`));
    const copy = await prepare(links.join("") + link("after.css"), ctx);
    assert.equal(looked(`Saved/${folder}/c`), 2 * (over.split("url(c)").length - 1));
    assert.equal(copy.split("<link").length - 1, 6);
    assert.equal(onlyStyle(copy), null);
  });

  it("counts what copying a <style>'s imports writes, but not its own text or its URLs", async () => {
    // A page in the folder. Its <style> keeps its URLs as written, which the
    // copy's <base> resolves as the page does, so 10,000 of them, which would
    // take 20 million characters made absolute, take nothing.
    const page = `Saved/${folder}/page.html`;
    const ctx = context({ [`Saved/${folder}/e.css`]: "" }, page);
    const urls = rule.repeat(10_000);
    assert.equal(onlyStyle(await prepare(`<style>@import "e.css";${urls}</style>`, ctx)), urls);
    assert.deepEqual(ctx.reads, [`Saved/${folder}/e.css`]);
    // Its imports that stay imports count as the copy writes them: past the
    // limit, they stay as written, and so does its text.
    const unit = '@import "c";';
    const each = `@import url("${VAULT}Saved/${folder}/c");`.length - unit.length;
    const most = Math.floor(LIMIT / each);
    const kept = `@import url("${VAULT}Saved/${folder}/c");`;
    const style = (count: number) => `<style>${unit.repeat(count)}</style>`;
    assert.equal(onlyStyle(await prepare(style(most), context({}, page))), kept.repeat(most));
    assert.equal(
      onlyStyle(await prepare(style(most + 1), context({}, page))),
      unit.repeat(most + 1),
    );
  });

  it("finds by name against its own base a <style> or a style attribute before a <base> that does not fit (#185)", async () => {
    // Past the limit, each keeps its URLs as written. A reference that does
    // not resolve as a path against the page is found by name, though one of
    // that name exists in the folder of the copy's <base>.
    const page = `Saved/${folder}/page.html`;
    const most = Math.floor(LIMIT / (copied - rule.length));
    const declaration = "b:url(c);";
    const most2 = Math.floor(
      LIMIT / (`b:url("${VAULT}Saved/${folder}/c");`.length - declaration.length),
    );
    const ctx: PageContext = {
      ...context({}, page),
      exists: (path) => path !== `Saved/${folder}/f.png`,
      locate: (linktext) => (linktext === "f.png" ? "Found/f.png" : null),
    };
    const found = `url("${VAULT}Found/f.png")`;
    const copy = parse(
      await prepare(
        `<style>${rule.repeat(most + 1)}p{b:url(f.png)}</style>` +
          `<p style='${declaration.repeat(most2 + 1)}b:url(f.png)'>x</p><base href="sub/">`,
        ctx,
      ),
    );
    assert.equal(copy.querySelector("style")!.textContent, `${rule.repeat(most + 1)}p{b:${found}}`);
    assert.equal(
      copy.querySelector("p")!.getAttribute("style"),
      `${declaration.repeat(most2 + 1)}b:${found}`,
    );
  });

  it("gives no room back for a rewrite that shortens a style attribute before a <base>, and stops at the room (#185)", async () => {
    const page = `Saved/${folder}/page.html`;
    const late = '<base href="sub/">';
    const declaration = "b:url(c);";
    const each = `b:url("${VAULT}Saved/${folder}/c");`.length - declaration.length;
    const most = Math.floor(LIMIT / each);
    // Made absolute, each of these loses 100 spaces. Before URLs that pass
    // the limit by less than 30 of them save, the attribute still does not fit.
    const short = `b:url(${" ".repeat(50)}"https://e.example/a"${" ".repeat(50)});`;
    assert.ok(30 * 100 > each);
    const attribute = short.repeat(30) + declaration.repeat(most + 1);
    const copy = parse(await prepare(`<p style='${attribute}'>x</p>${late}`, context({}, page)));
    assert.equal(copy.querySelector("p")!.getAttribute("style"), attribute);
    // Rewriting stops once the attribute passes the room: about half of
    // twice as many URLs as fit are rewritten, and then each is asked about
    // once more, to be found by name as the attribute stays as written.
    const { ctx, looked } = counting({}, page);
    await prepare(`<p style='${declaration.repeat(2 * most)}'>x</p>${late}`, ctx);
    const asked = looked(`Saved/${folder}/c`);
    assert.ok(asked <= most + 1 + 2 * most, `${asked} lookups`);
  });

  it("counts what making the URLs of a <style> or a style attribute before a <base> absolute adds (#185)", async () => {
    // A page in the folder, whose <base> comes after them: Chromium resolves
    // them against the page's address, so the copy makes them absolute, as
    // far as the limit allows, and past it keeps them as written.
    const page = `Saved/${folder}/page.html`;
    const each = copied - rule.length;
    const most = Math.floor(LIMIT / each);
    const late = '<base href="sub/">';
    const made = `a{b:url("${VAULT}Saved/${folder}/c")}`;
    const style = (count: number) => `<style>${rule.repeat(count)}</style>${late}`;
    assert.equal(onlyStyle(await prepare(style(most), context({}, page))), made.repeat(most));
    assert.equal(
      onlyStyle(await prepare(style(most + 1), context({}, page))),
      rule.repeat(most + 1),
    );
    const declaration = "b:url(c);";
    const absolute = `b:url("${VAULT}Saved/${folder}/c");`;
    const most2 = Math.floor(LIMIT / (absolute.length - declaration.length));
    const attribute = async (count: number) =>
      parse(
        await prepare(`<p style='${declaration.repeat(count)}'>x</p>${late}`, context({}, page)),
      )
        .querySelector("p")!
        .getAttribute("style");
    assert.equal(await attribute(most2), absolute.repeat(most2));
    assert.equal(await attribute(most2 + 1), declaration.repeat(most2 + 1));
    // What one takes, the next cannot: of two that each take three fifths, the second stays.
    const three = Math.floor((most2 * 3) / 5);
    const both = parse(
      await prepare(
        `<p style='${declaration.repeat(three)}'>x</p><p style='${declaration.repeat(three)}'>y</p>${late}`,
        context({}, page),
      ),
    );
    assert.deepEqual(
      [...both.querySelectorAll("p")].map((p) => p.getAttribute("style")),
      [absolute.repeat(three), declaration.repeat(three)],
    );
    // With copying, the files of those kept as written come from the page's
    // folder still, where Chromium finds them.
    const copies = new Set<string>();
    const copyFiles: LocalFiles = {
      size: () => 1,
      async readBinary(path) {
        copies.add(path);
        return new Uint8Array([1]).buffer;
      },
    };
    const png = "a{b:url(c.png)}";
    const pngs = Math.floor(
      LIMIT / (`a{b:url("${VAULT}Saved/${folder}/c.png")}`.length - png.length),
    );
    const d = "b:url(d.png);";
    const ds = Math.floor(LIMIT / (`b:url("${VAULT}Saved/${folder}/d.png");`.length - d.length));
    await prepare(
      `<style>${png.repeat(pngs + 1)}</style><p style="${d.repeat(ds + 1)}">x</p>${late}`,
      context({}, page),
      { copyFiles },
    );
    assert.deepEqual([...copies].sort(), [`Saved/${folder}/c.png`, `Saved/${folder}/d.png`]);
  });

  it("finds by name the references of a <style> whose imports stay as written", async () => {
    // Past the limit, as without imports, its references found by name change.
    const page = `Saved/${folder}/page.html`;
    const unit = '@import "c";';
    const each = `@import url("${VAULT}Saved/${folder}/c");`.length - unit.length;
    const ctx: PageContext = {
      ...context({}, page),
      exists: (path) => path !== `Saved/${folder}/f.png`,
      locate: (linktext) => (linktext === "f.png" ? "Found/f.png" : null),
    };
    const imports = unit.repeat(Math.floor(LIMIT / each) + 1);
    const text = onlyStyle(await prepare(`<style>${imports} p { b: url(f.png) }</style>`, ctx));
    assert.equal(text, `${imports} p { b: url("${VAULT}Found/f.png") }`);
  });

  it("takes from the discard limit for a <style> whose imports would not fit", async () => {
    // Such a <style> reaches the room before preparing it stops, as a
    // stylesheet that stays a link does. Two of them spend the discard limit,
    // after which the import of a small stylesheet in the next <style> stays
    // an import; after one, it is copied. (A page's links come before its
    // <style> elements.)
    const page = `Saved/${folder}/page.html`;
    const unit = '@import "c";';
    const each = `@import url("${VAULT}Saved/${folder}/c");`.length - unit.length;
    const style = `<style>${unit.repeat(Math.floor(LIMIT / each) + 1)}</style>`;
    for (const [styles, fits] of [
      [1, true],
      [2, false],
    ] as const) {
      const ctx = context({ [`Saved/${folder}/small.css`]: "p{}" }, page);
      const copy = await prepare(`${style.repeat(styles)}<style>@import "small.css";</style>`, ctx);
      assert.equal(copy.includes("<style>p{}</style>"), fits, `${styles} <style> elements`);
    }
  });

  it("keeps the closed text of a stylesheet given alone whose URLs would not fit made absolute", async () => {
    const sheetUrl = `${VAULT}Saved/${folder}/main.css`;
    const most = Math.floor(LIMIT / (copied - rule.length));
    const ctx: PageContext = {
      ...context({}),
      exists: (path) => path !== `Saved/${folder}/f.png`,
      locate: (linktext) => (linktext === "f.png" ? "Found/f.png" : null),
    };
    const made = `a{b:url("${VAULT}Saved/${folder}/c")}`;
    assert.deepEqual(await inlineStylesheet(rule.repeat(most), sheetUrl, ctx), [made.repeat(most)]);
    // Past the limit, it is closed as CSS closes it, and its references found
    // by name change, as in a page's <style>.
    const over = rule.repeat(most + 1);
    assert.deepEqual(await inlineStylesheet(`${over}p{b:url(f.png)}a{`, sheetUrl, ctx), [
      `${over}p{b:url("${VAULT}Found/f.png")}a{}`,
    ]);
  });

  it("counts nothing for the references found by name in the page's own text", async () => {
    // A <style>, with or without imports, and a style attribute change only
    // their references found by name. A stylesheet of the whole limit still
    // fits after them.
    const found = `Found/${folder}/c`;
    // What the <style>'s import counts, as the copy writes one that stays an import.
    const importing = `@import url("${VAULT}Saved/e.css");`.length - '@import "e.css";'.length;
    const ctx: PageContext = {
      ...context({ "Saved/full.css": comment(LIMIT - importing), "Saved/e.css": "" }),
      exists: (path) => path === found || path === "Saved/e.css" || path === "Saved/full.css",
      locate: (linktext) => (linktext === "c" ? found : null),
    };
    const html = [
      `<style>${rule}</style>`,
      `<style>@import "e.css";${rule}</style>`,
      `<p style="b:url(c)">x</p>`,
      link("full.css"),
    ].join("");
    const copy = await prepare(html, ctx);
    assert.equal(copy.split(`<style>a{b:url("${VAULT}${found}")}</style>`).length - 1, 2);
    assert.ok(copy.includes(`style="b:url(&quot;${VAULT}${found}&quot;)"`));
    assert.ok(!copy.includes("<link"));
  });
});

describe("import placement (#136)", () => {
  it("reads no import that CSS ignores, in every place that a page has a stylesheet", async () => {
    for (const css of [
      'a { color: red } @import "ghost.css";',
      // To CSS, the import is part of the qualified rule's prelude: its selector.
      'x @import "ghost.css"; a { color: red }',
      ') @import "ghost.css"; a { color: red }',
      '} @import "ghost.css";',
      // A stray ";" starts a qualified rule too.
      '@import "real.css";; @import "ghost.css";',
      // An @layer statement after an import ends the imports.
      '@import "real.css"; @layer a; @import "ghost.css";',
    ]) {
      for (const { place, reads, text } of await everyPlace(css, {
        "Saved/real.css": "REAL{}",
        "Saved/ghost.css": "GHOST{}",
      })) {
        assert.deepEqual(
          reads,
          css.includes("real.css") ? ["Saved/real.css"] : [],
          `${css} in ${place}`,
        );
        assert.ok(text.includes('@import "ghost.css";'), `${css} in ${place}: ${text}`);
      }
    }
  });

  it("imports after @charset, @layer statements, and HTML comment markers", async () => {
    const css = '<!--\n@charset "utf-8"; @layer base; @import "real.css";\n-->';
    for (const { place, reads, text } of await everyPlace(css, { "Saved/real.css": "REAL{}" })) {
      assert.deepEqual(reads, ["Saved/real.css"], place);
      // A stylesheet file's markers become spaces, which CSS reads alike there (#152).
      const [open, close] = place.includes("<link") ? [" ", " "] : ["<!--", "-->"];
      assert.equal(text, `${open}\n@charset "utf-8"; @layer base; REAL{}\n${close}`, place);
    }
  });
});

describe("import conditions (#144, #151)", () => {
  const inline = (css: string, ctx: PageContext) => inlineStylesheet(css, `${VAULT}main.css`, ctx);

  it("puts imports into cascade layers and with support conditions in their block forms", async () => {
    for (const [conditions, result] of [
      ["/**/ layer", "@layer {\nREAL{}\n}"],
      [String.raw`\6c ayer`, "@layer {\nREAL{}\n}"],
      ["layer(base)", "@layer base {\nREAL{}\n}"],
      ["LAYER( /**/ base.x )", "@layer base.x {\nREAL{}\n}"],
      ["supports(display: grid)", "@supports (display: grid) {\nREAL{}\n}"],
      ["supports((a: b) or (c: d))", "@supports ((a: b) or (c: d)) {\nREAL{}\n}"],
      ["layer screen", "@media screen {\n@layer {\nREAL{}\n}\n}"],
      // The conditions go outside the layer, which they decide whether to declare.
      [
        "layer(base) supports(display: grid) screen",
        "@media screen {\n@supports (display: grid) {\n@layer base {\nREAL{}\n}\n}\n}",
      ],
    ]) {
      const ctx = { ...context({ "real.css": "REAL{}" }), importSupports: true };
      const css = await inline(`@import "real.css" ${conditions};`, ctx);
      assert.deepEqual(css, [result], conditions);
      assert.deepEqual(ctx.reads, ["real.css"], conditions);
    }
  });

  it("nests the blocks of an imported stylesheet's own imports inside its own", async () => {
    const ctx = {
      ...context({ "a.css": '@import "b.css" layer(inner) print; A{}', "b.css": "B{}" }),
      importSupports: true,
    };
    assert.deepEqual(await inline('@import "a.css" layer(outer) supports(x: y);', ctx), [
      "@supports (x: y) {\n@layer outer {\n@media print {\n@layer inner {\nB{}\n}\n} A{}\n}\n}",
    ]);
  });

  it("keeps imports that Chromium does not read as these, reading nothing", async () => {
    for (const [conditions, importSupports] of [
      // Chromium 114 never applies an import with support conditions.
      ["supports(display: grid)", false],
      ["layer(base) supports(display: grid) screen", false],
      // No version of Chromium that Obsidian has applies a scoped import.
      ["scope(.card)", true],
      ["scope", true],
      ["layer()", true],
      ["layer(1a)", true],
      ["layer(a .b)", true],
      ["supports()", true],
    ] as const) {
      const ctx = { ...context({ "real.css": "REAL{}" }), importSupports };
      assert.deepEqual(
        await inline(`@import "real.css" ${conditions};`, ctx),
        [`@import url("${VAULT}real.css") ${conditions};`],
        conditions,
      );
      assert.deepEqual(ctx.reads, [], conditions);
    }
  });

  it("finds whether the host applies support conditions by its CSSImportRule", async () => {
    // jsdom's CSSImportRule has supportsText, as Chromium 150's does.
    const own = Object.getOwnPropertyDescriptor(window, "CSSImportRule");
    for (const [rule, inlined] of [
      [undefined, false],
      [class {}, false],
      [
        class {
          supportsText = null;
        },
        false,
      ],
      [
        class {
          get supportsText() {
            return null;
          }
        },
        true,
      ],
    ] as const) {
      Object.defineProperty(window, "CSSImportRule", { configurable: true, value: rule });
      try {
        const ctx = context({ "real.css": "REAL{}" });
        const [css] = await inline('@import "real.css" supports(a: b);', ctx);
        assert.equal(css.startsWith("@supports"), inlined, String(rule));
      } finally {
        if (own) Object.defineProperty(window, "CSSImportRule", own);
        else Reflect.deleteProperty(window, "CSSImportRule");
      }
    }
    const [css] = await inline(
      '@import "real.css" supports(a: b);',
      context({ "real.css": "R{}" }),
    );
    assert.equal(css, "@supports (a: b) {\nR{}\n}");
  });

  it("puts imports with only a media query list in @media, whatever its comments say", async () => {
    const ctx = context({ "real.css": "REAL{}" });
    for (const [source, result] of [
      [
        '@import "real.css" screen /* supports( layer */;',
        "@media screen /* supports( layer */ {\nREAL{}\n}",
      ],
      ['@import "real.css" /* layer */;', "REAL{}"],
    ])
      assert.deepEqual(await inlineStylesheet(source, `${VAULT}main.css`, ctx), [result]);
  });
});

describe("what inlining keeps of each stylesheet's context (#152)", () => {
  const FONTS = "https://fonts.googleapis.com/css2?family=Roboto";
  const FONTS2 = "https://fonts.googleapis.com/css2?family=Inter";
  const WEB = "https://example.com/x.css";
  const inline = (css: string, files: Record<string, string>, importSupports = true) =>
    inlineStylesheet(css, `${VAULT}main.css`, { ...context(files), importSupports });

  it("starts a stylesheet at an import kept after an inlined stylesheet's rules, where its place matters", async () => {
    const files = {
      "a.css": "A{}",
      "fonts.css": `@import url("${FONTS}"); F{}`,
      "c.css": `@layer y; @import url("${FONTS}"); C{}`,
      "d.css": `@charset "x"; @import url("${FONTS}"); D{}`,
      "self.css": '@import "self.css"; S{}',
      "comment.css": "/* nothing */",
      "statements.css": "@layer a, b;",
    };
    for (const [css, sheets] of [
      // An import of Google Fonts, which Obsidian's policy loads, and one
      // into a layer, which it declares where it counts.
      [`@import "a.css"; @import url("${FONTS}"); p {}`, ["A{} ", `@import url("${FONTS}"); p {}`]],
      [
        '@import "a.css"; @import "missing.css" layer(m);',
        ["A{} ", `@import url("${VAULT}missing.css") layer(m);`],
      ],
      // And one with conditions that the viewer does not read, which may.
      [
        '@import "a.css"; @import "s.css" scope(.a); p {}',
        ["A{} ", `@import url("${VAULT}s.css") scope(.a); p {}`],
      ],
      [
        '@import "a.css"; @import "s.css" layer(a .b);',
        ["A{} ", `@import url("${VAULT}s.css") layer(a .b);`],
      ],
      // Any other does nothing, whether it counts or not: it stays where it is.
      [`@import "a.css"; @import url("${WEB}"); p {}`, [`A{} @import url("${WEB}"); p {}`]],
      [
        '@import "a.css"; @import url("https://fonts.googleapis.com.example.com/x.css");',
        ['A{} @import url("https://fonts.googleapis.com.example.com/x.css");'],
      ],
      ['@import "a.css"; @import "self.css";', [`A{} @import url("${VAULT}self.css"); S{}`]],
      ['@import "a.css"; @import "missing.css";', [`A{} @import url("${VAULT}missing.css");`]],
      // One in an inlined stylesheet, after another's rules.
      ['@import "a.css"; @import "fonts.css";', ["A{} ", `@import url("${FONTS}"); F{}`]],
      // Before any rules, they stay together.
      [`@import url("${FONTS}"); @import "a.css";`, [`@import url("${FONTS}"); A{}`]],
      ['@layer x; @import "fonts.css";', [`@layer x; @import url("${FONTS}"); F{}`]],
      [
        `@charset "x"; @import url("${FONTS}"); @import "d.css";`,
        [`@charset "x"; @import url("${FONTS}"); @charset "x"; @import url("${FONTS}"); D{}`],
      ],
      // So they do after a stylesheet with no rules, imported with
      // conditions, which takes no block.
      [
        `@import "comment.css" screen; @import url("${FONTS}");`,
        [`/* nothing */ @import url("${FONTS}");`],
      ],
      // An @layer statement after an import ends the imports, and so does one
      // in a block.
      [
        `@import url("${FONTS}"); @import "c.css";`,
        [`@import url("${FONTS}"); @layer y; `, `@import url("${FONTS}"); C{}`],
      ],
      [
        `@import "statements.css" layer(t); @import url("${FONTS}");`,
        ["@layer t {\n@layer a, b;\n} ", `@import url("${FONTS}");`],
      ],
      // Rules after a kept import go with it; another one after them starts
      // another, and one right after it does not.
      [
        `@import "a.css"; @import url("${FONTS}"); @import url("${FONTS2}"); @import "a.css"; @import "fonts.css";`,
        [
          "A{} ",
          `@import url("${FONTS}"); @import url("${FONTS2}"); A{} `,
          `@import url("${FONTS}"); F{}`,
        ],
      ],
    ] as const)
      assert.deepEqual(await inline(css, files), sheets, css);
  });

  it("spends the limit of <style> elements only on imports that start one", async () => {
    // More imports that stay where they are than the limit allows, then one
    // that starts a stylesheet of its own.
    const others = `@import url("${WEB}");`.repeat(STYLE_ELEMENT_LIMIT + 1);
    const sheets = await inline(`@import "a.css"; ${others} @import url("${FONTS}");`, {
      "a.css": "A{}",
    });
    assert.equal(sheets.length, 2);
    assert.equal(sheets[1], `@import url("${FONTS}");`);
  });

  it("adds an import's conditions to the imports kept in its stylesheet", async () => {
    for (const [fonts, conditions, sheets] of [
      // A media query list, a layer, and support conditions, or more than one.
      ["", "screen", [`@import url("${FONTS}") screen;@media screen {\n F{}\n}`]],
      ["", "layer(theme)", [`@import url("${FONTS}") layer(theme);@layer theme {\n F{}\n}`]],
      [
        "layer(g)",
        "layer(theme)",
        [`@import url("${FONTS}") layer(theme.g);@layer theme {\n F{}\n}`],
      ],
      ["layer", "screen", [`@import url("${FONTS}") layer screen;@media screen {\n F{}\n}`]],
      [
        "supports(c: d) print",
        "layer(theme) supports(a: b)",
        [
          `@import url("${FONTS}") layer(theme) supports((a: b) and (c: d)) print;@supports (a: b) {\n@layer theme {\n F{}\n}\n}`,
        ],
      ],
      // An anonymous layer has no name for another rule to add to, and two
      // media query lists no form for both: the import goes in the blocks,
      // where it never counts, as before.
      ["", "layer", [`@layer {\n@import url("${FONTS}"); F{}\n}`]],
      ["layer", "layer(theme)", [`@layer theme {\n@import url("${FONTS}") layer; F{}\n}`]],
      ["print", "screen", [`@media screen {\n@import url("${FONTS}") print; F{}\n}`]],
      ["scope(.a)", "screen", [`@media screen {\n@import url("${FONTS}") scope(.a); F{}\n}`]],
    ] as const) {
      const files = { "fonts.css": `@import url("${FONTS}") ${fonts}; F{}`.replace(" ;", ";") };
      assert.deepEqual(
        await inline(`@import "fonts.css" ${conditions};`, files),
        sheets,
        conditions,
      );
    }
    // Support conditions as written, also where the host never applies
    // them, and an import whose place does not matter, which takes them too.
    assert.deepEqual(
      await inline(
        '@import "x.css" screen;',
        { "x.css": `@import url("${FONTS}") supports(a: b);\n@import url("${WEB}"); X{}` },
        false,
      ),
      [
        `@import url("${FONTS}") supports(a: b) screen;\n@import url("${WEB}") screen;@media screen {\n X{}\n}`,
      ],
    );
    // A reference that does not resolve stays as written, in the blocks.
    assert.deepEqual(
      await inline('@import "bad.css" screen;', { "bad.css": '@import "http://[";' }),
      ['@media screen {\n@import "http://[";\n}'],
    );
  });

  it("puts no block around text of only what CSS discards between rules", async () => {
    // Two Google Fonts imports, each on a line of its own after a comment.
    const fonts = `/* Fonts */\n@import url("${FONTS}");\n@import url("${FONTS2}");\n.t {}\n`;
    assert.deepEqual(await inline('@import "fonts.css" screen;\np {}', { "fonts.css": fonts }), [
      `/* Fonts */\n@import url("${FONTS}") screen;\n@import url("${FONTS2}") screen;@media screen {\n\n.t {}\n\n}\np {}`,
    ]);
    // Any rule takes one, as one that CSS allows among imports does.
    assert.deepEqual(
      await inline('@import "charset.css" screen;', { "charset.css": '@charset "x";' }),
      ['@media screen {\n@charset "x";\n}'],
    );
  });

  it("declares the layer of an import whose stylesheet declares none, as Chromium does", async () => {
    for (const [empty, conditions, sheet] of [
      ["", "layer(ra)", "@layer ra; @layer rb {\nB{}\n} @layer ra { E{} }"],
      ["\n/* c */", "layer(ra)", "@layer ra;\n/* c */ @layer rb {\nB{}\n} @layer ra { E{} }"],
      [
        "",
        "layer(ra) screen",
        "@media screen {\n@layer ra;\n} @layer rb {\nB{}\n} @layer ra { E{} }",
      ],
      [
        "",
        "layer(ra) supports(x: y)",
        "@supports (x: y) {\n@layer ra;\n} @layer rb {\nB{}\n} @layer ra { E{} }",
      ],
      // An anonymous layer holds nothing that can be told apart.
      ["", "layer", " @layer rb {\nB{}\n} @layer ra { E{} }"],
      // A kept import declares the layer only where its own conditions hold,
      // which they may not: a media query list, or support conditions.
      [
        `@import url("${WEB}") print;`,
        "layer(ra)",
        `@layer ra;@import url("${WEB}") layer(ra) print; @layer rb {\nB{}\n} @layer ra { E{} }`,
      ],
      [
        `/* fonts */\n@import url("${FONTS}") supports(not (display: block));`,
        "layer(ra)",
        `@layer ra;/* fonts */\n@import url("${FONTS}") layer(ra) supports(not (display: block)); @layer rb {\nB{}\n} @layer ra { E{} }`,
      ],
      // One without them declares it, as text in a block does.
      [
        `@import url("${WEB}");`,
        "layer(ra)",
        `@import url("${WEB}") layer(ra); @layer rb {\nB{}\n} @layer ra { E{} }`,
      ],
      [
        `@import url("${WEB}") layer(z);`,
        "layer(ra) screen",
        `@import url("${WEB}") layer(ra.z) screen; @layer rb {\nB{}\n} @layer ra { E{} }`,
      ],
    ] as const)
      assert.deepEqual(
        await inline(
          `@import "empty.css" ${conditions}; @import "b.css" layer(rb); @layer ra { E{} }`,
          { "empty.css": empty, "b.css": "B{}" },
        ),
        [sheet],
        `${JSON.stringify(empty)} ${conditions}`,
      );
    // Chromium 114 never applies an import with support conditions, whatever they say.
    assert.deepEqual(
      await inline(
        '@import "x.css" layer(ra);',
        { "x.css": `@import url("${WEB}") supports(display: block);` },
        false,
      ),
      [`@layer ra;@import url("${WEB}") layer(ra) supports(display: block);`],
    );
  });

  it("stops later imports with the @layer statement, as CSS does", async () => {
    const files = { "empty.css": "" };
    for (const [css, sheets] of [
      // A statement after an import ends the imports, and one in a block ends them all.
      [
        `@import url("${WEB}"); @import "empty.css" layer(a); @import url("${FONTS}");`,
        [`@import url("${WEB}"); @layer a; `, `@import url("${FONTS}");`],
      ],
      [
        `@import "empty.css" layer(a) screen; @import url("${FONTS}");`,
        ["@media screen {\n@layer a;\n} ", `@import url("${FONTS}");`],
      ],
      // Before any import, it ends none.
      [
        `@import "empty.css" layer(a); @import url("${FONTS}");`,
        [`@layer a; @import url("${FONTS}");`],
      ],
    ] as const)
      assert.deepEqual(await inline(css, files), sheets, css);
  });

  it("keeps what it adds for conditions within the text limit, and adds one block past it", async () => {
    // Twenty kept imports, each of which would take a media query list of a
    // million characters: one block takes it once.
    const media = `screen${", print".repeat(150_000)}`;
    const imports = `@import url("${FONTS}");\n`.repeat(20);
    const [css, ...more] = await inline(`@import "x.css" ${media};`, { "x.css": `${imports}X{}` });
    assert.deepEqual(more, []);
    assert.equal(css, `@media ${media} {\n${imports}X{}\n}`);
    // Its block counts, so a stylesheet that would have fit after it no longer does.
    const big = "a{}".repeat((STYLESHEET_TEXT_LIMIT - 500_000) / 3);
    const both = await inline(`@import "x.css" ${media}; @import "big.css";`, {
      "x.css": "X{}",
      "big.css": big,
    });
    assert.deepEqual(both, [`@media ${media} {\nX{}\n} @import url("${VAULT}big.css");`]);
    // What other stylesheets took is no longer room for conditions: after
    // one that leaves half a million characters, twenty imports that would
    // each take a list of 100,000 take one block, which fits.
    const short = `screen${", print".repeat(15_000)}`;
    const [after, ...rest] = await inline(`@import "big.css"; @import "x.css" ${short};`, {
      "x.css": `${imports}X{}`,
      "big.css": big,
    });
    assert.deepEqual(rest, []);
    assert.equal(after.slice(big.length), ` @media ${short} {\n${imports}X{}\n}`);
    // With no room even for that block, the import stays an import.
    const huge = `screen${", print".repeat(STYLESHEET_TEXT_LIMIT / 7)}`;
    assert.deepEqual(await inline(`@import "x.css" ${huge};`, { "x.css": "X{}" }), [
      `@import url("${VAULT}x.css") ${huge};`,
    ]);
  });

  it("puts each stylesheet in a <style> of the element's own, which keeps the last", async () => {
    const ctx = context({
      "Saved/a.css": "A{}",
      "Saved/sheet.css": `@import "a.css"; @import url(${FONTS}); L{}`,
    });
    const page = parse(
      await prepare(
        [
          `<style id="own" class="c" media="screen" title="Set">@import "a.css"; @import url(${FONTS}); p {}</style>`,
          '<link rel="stylesheet" href="sheet.css" media="print" title="Set" id="link" type="text/css; charset=utf-8">',
          // Chromium 114 applies an SVG <style> only with a lowercase type.
          `<svg><style type="TEXT/CSS">@import "a.css"; @import url(${FONTS}); q {}</style></svg>`,
        ].join(""),
        ctx,
      ),
    );
    const styles = [...page.querySelectorAll("style")].map((style) => ({
      svg: style.namespaceURI === "http://www.w3.org/2000/svg",
      attributes: [...style.attributes].map(({ name, value }) => `${name}=${value}`),
      text: style.textContent,
    }));
    const kept = `@import url("${FONTS}");`;
    assert.deepEqual(styles, [
      { svg: false, attributes: ["media=screen", "title=Set"], text: "A{} " },
      {
        svg: false,
        attributes: ["id=own", "class=c", "media=screen", "title=Set"],
        text: `${kept} p {}`,
      },
      { svg: false, attributes: ["media=print", "title=Set"], text: "A{} " },
      { svg: false, attributes: ["media=print", "title=Set"], text: `${kept} L{}` },
      { svg: true, attributes: ["type=TEXT/CSS"], text: "A{} " },
      { svg: true, attributes: ["type=TEXT/CSS"], text: `${kept} q {}` },
    ]);
    // A repeat of the link gets the same stylesheets, prepared once (#154).
    const repeat = context({
      "Saved/a.css": "A{}",
      "Saved/sheet.css": `@import "a.css"; @import url(${FONTS});`,
    });
    const link = '<link rel="stylesheet" href="sheet.css">';
    const copy = parse(await prepare(link + link, repeat));
    assert.deepEqual(
      [...copy.querySelectorAll("style")].map((style) => style.textContent),
      ["A{} ", kept, "A{} ", kept],
    );
    assert.deepEqual(repeat.reads, ["Saved/sheet.css", "Saved/a.css"]);
  });

  it("keeps a kept import after an inlined one in every place, and copies files alike", async () => {
    for (const [kept, count] of [
      [FONTS, 2],
      [WEB, 1],
    ] as const) {
      const css = `@import "a.css"; @import url(${kept}); p { background: url(dot.png) }`;
      for (const { place, texts, copies } of await everyPlace(css, {
        "Saved/a.css": "a { background: url(dot.png) }",
      })) {
        assert.equal(texts.length, count, place);
        assert.ok(texts.at(-1)!.includes(`@import url("${kept}");`), place);
        assert.deepEqual(copies, place.includes("copying") ? ["Saved/dot.png"] : [], place);
      }
    }
  });

  it("turns <!-- and --> between a stylesheet file's rules into spaces, which a block keeps", async () => {
    const files = {
      "old.css": '<!-- p { color: green } --> a { b: "<!--" } <!--',
      "open.css": "<!-- p { color: green } --> a {",
    };
    assert.deepEqual(await inline('@import "old.css" screen;', files), [
      '@media screen {\n  p { color: green }   a { b: "<!--" }  \n}',
    ]);
    // Also in a file that CSS closes at its end.
    assert.deepEqual(await inline('@import "open.css" screen;', files), [
      "@media screen {\n  p { color: green }   a {}\n}",
    ]);
    // The importing stylesheet's own stay, where CSS discards them.
    assert.deepEqual(await inline('<!-- @import "old.css"; -->', files), [
      '<!--   p { color: green }   a { b: "<!--" }   -->',
    ]);
  });
});

describe("the end of an imported stylesheet (#139)", () => {
  it("copies no file that the importing sheet names only in a string, in every place", async () => {
    for (const [imported, css] of [
      ['"', '@import "a.css"; p { content: "url(ghost.png)" }'],
      ["/*", '@import "a.css"; p { content: "*/ url(ghost.png)" }'],
      ["a { b: url(", '@import "a.css"; p { content: "x) url(ghost.png)" }'],
      ["a { b: 'c\\", `@import "a.css"; p { content: "' url(ghost.png)" }`],
      ['"', '@import "a.css" screen; p { content: "url(ghost.png)" }'],
    ]) {
      for (const { place, reads, copies, text } of await everyPlace(css, {
        "Saved/a.css": imported,
      })) {
        assert.deepEqual(reads, ["Saved/a.css"], `${imported} in ${place}`);
        assert.deepEqual(copies, [], `${imported} in ${place}`);
        assert.ok(
          text.endsWith(css.slice(css.indexOf(";") + 1)),
          `${imported} in ${place}: ${text}`,
        );
      }
    }
  });

  it("keeps the rules after an import whose sheet ends in a comment, a block, or a prelude", async () => {
    const css = '@import "a.css"; p { background: url(real.png) }';
    for (const [imported, closed] of [
      ["/*", "/**/"],
      ["a {", "a {}"],
      ["a", "a{}"],
      ["@media print", "@media print;"],
      ["a:is(b", "a:is(b){}"],
      // "@1" starts a qualified rule, which a block ends, not a ";".
      ["@1;", "@1;{}"],
    ]) {
      for (const { place, copies, text } of await everyPlace(css, { "Saved/a.css": imported })) {
        // A linked stylesheet's URL is made absolute; a <style>'s keeps its text (#177).
        const url = place.endsWith("copying")
          ? 'url("data:image/png;base64,AQ==")'
          : place.includes("<link")
            ? `url("${VAULT}Saved/real.png")`
            : "url(real.png)";
        assert.equal(text, `${closed} p { background: ${url} }`, place);
        assert.deepEqual(copies, place.endsWith("copying") ? ["Saved/real.png"] : [], place);
      }
    }
  });

  it("closes an imported sheet before resolving its own URLs", async () => {
    // To CSS, an unquoted URL at the end of a stylesheet is a URL, of that stylesheet's.
    const files = { "Saved/css/a.css": "p { background: url(img.png" };
    for (const { place, copies, text } of await everyPlace('@import "css/a.css";', files)) {
      if (place.endsWith("copying")) assert.deepEqual(copies, ["Saved/css/img.png"], place);
      else assert.equal(text, `p { background: url("${VAULT}Saved/css/img.png")}`, place);
    }
  });

  it("closes a sheet inside @media, and keeps one with a } outside any block an import", async () => {
    const ctx = context({
      "a.css": "a {",
      "stray.css": "} x {}",
      "outer.css": '@import "stray.css";',
    });
    const inline = (css: string) => inlineStylesheet(css, `${VAULT}main.css`, ctx);
    assert.deepEqual(await inline('@import "a.css" screen; p {}'), [
      "@media screen {\na {}\n} p {}",
    ]);
    // Inside @media, the stray "}" would end the block, and the block's own
    // "}" would take the next rule. So would it in the other block forms (#151).
    for (const sheet of ["stray.css", "outer.css"])
      for (const conditions of ["screen", "layer", "layer(a)", "supports(a: b)"])
        assert.deepEqual(await inline(`@import "${sheet}" ${conditions}; p {}`), [
          `@import url("${VAULT}${sheet}") ${conditions}; p {}`,
        ]);
    // At the top level, it is part of a rule's prelude, as in the sheet itself.
    assert.deepEqual(await inline('@import "outer.css"; p {}'), ["} x {} p {}"]);
  });
});

describe("the end of a page's own stylesheet (#155)", () => {
  it("imports the file of a last import without its ;, in every place", async () => {
    for (const { place, reads, text } of await everyPlace('@import "a.css"', {
      "Saved/a.css": "A{}",
    })) {
      assert.deepEqual({ reads, text }, { reads: ["Saved/a.css"], text: "A{}" }, place);
    }
    const ctx = context({ "Saved/a.css": "A{}" });
    assert.deepEqual(await inlineStylesheet('@import "a.css"', ctx.pageUrl, ctx), ["A{}"]);
  });

  it("resolves an unquoted URL at the end of a linked stylesheet against that stylesheet", async () => {
    const link = '<link rel="stylesheet" href="css/a.css">';
    for (const html of [link, `<div><template shadowrootmode="open">${link}</template></div>`]) {
      for (const copying of [false, true]) {
        const ctx = context({ "Saved/css/a.css": "p { background: url(img.png" });
        const copies: string[] = [];
        const copyFiles: LocalFiles = {
          size: () => 1,
          async readBinary(path) {
            copies.push(path);
            return new Uint8Array([1]).buffer;
          },
        };
        const result = await preparePage(html, ctx, copying ? { copyFiles } : {});
        const doc = parse(result.html);
        const root = html.includes("<template") ? doc.querySelector("template")!.content : doc;
        const url = copying ? "data:image/png;base64,AQ==" : `${VAULT}Saved/css/img.png`;
        assert.deepEqual(
          { copies, text: root.querySelector("style")!.textContent },
          {
            copies: copying ? ["Saved/css/img.png"] : [],
            text: `p { background: url("${url}")}`,
          },
          `${html}, copying: ${copying}`,
        );
      }
    }
  });

  it("copies the file of an unquoted URL at the end of a <style>", async () => {
    const ctx = context({});
    const copies: string[] = [];
    const result = await preparePage("<style>p { background: url(img.png</style>", ctx, {
      copyFiles: {
        size: () => 1,
        async readBinary(path) {
          copies.push(path);
          return new Uint8Array([1]).buffer;
        },
      },
    });
    assert.deepEqual(copies, ["Saved/img.png"]);
    assert.equal(
      parse(result.html).querySelector("style")!.textContent,
      'p { background: url("data:image/png;base64,AQ==")}',
    );
  });

  it("locates the file of an unquoted URL at the end of a <style> by name", async () => {
    const ctx: PageContext = {
      ...context({}),
      exists: (path) => path === "Images/img.png",
      locate: (linktext) => (linktext === "img.png" ? "Images/img.png" : null),
    };
    const page = parse(await prepare("<style>p { background: url(img.png</style>", ctx));
    assert.equal(
      page.querySelector("style")!.textContent,
      `p { background: url("${VAULT}Images/img.png")}`,
    );
  });

  it("keeps the closed text of a <style> that CSS leaves open, and one that it does not as it is", async () => {
    const page = parse(
      await prepare("<style>p { color: red</style><style>q { color: blue }</style>", context({})),
    );
    assert.deepEqual(
      [...page.querySelectorAll("style")].map((style) => style.textContent),
      ["p { color: red}", "q { color: blue }"],
    );
  });
});

describe("strings that image-set() takes as URLs (#179)", () => {
  // A stylesheet in another folder than the page, whose strings resolve
  // against it, as its url()s do.
  const sheetUrl = `${VAULT}Theme/site.css`;
  const css = [
    `a { background: image-set("icon.png" 1x, "icon@2x.png" type("image/png") 2x) }`,
    `b { background: -webkit-image-set('x.png' 1x), url(y.png) }`,
  ].join("\n");
  const absolute = [
    `a { background: image-set("${VAULT}Theme/icon.png" 1x, "${VAULT}Theme/icon@2x.png" type("image/png") 2x) }`,
    `b { background: -webkit-image-set("${VAULT}Theme/x.png" 1x), url("${VAULT}Theme/y.png") }`,
  ].join("\n");

  function copying(): LocalFiles & { copies: string[] } {
    const copies: string[] = [];
    return {
      copies,
      size: () => 1,
      async readBinary(path) {
        copies.push(path);
        return new Uint8Array([1]).buffer;
      },
    };
  }

  it("makes them absolute against their stylesheet, keeping them strings", async () => {
    assert.equal(absoluteUrls(css, sheetUrl), absolute);
    assert.deepEqual(await inlineStylesheet(css, sheetUrl, context({})), [absolute]);
  });

  it("makes them absolute in every place that a page links or imports a stylesheet, and copies their files", async () => {
    const shadow = (html: string) =>
      `<div><template shadowrootmode="open">${html}</template></div>`;
    const sheets = [
      '<link rel="stylesheet" href="../Theme/site.css">',
      '<style>@import "../Theme/site.css";</style>',
      '<link rel="stylesheet" href="../Theme/main.css">',
    ];
    for (const html of [...sheets, ...sheets.map(shadow)]) {
      for (const copy of [undefined, copying()]) {
        const ctx = context({ "Theme/site.css": css, "Theme/main.css": '@import "site.css";' });
        const page = parse(await prepare(html, ctx, { copyFiles: copy }));
        const root = page.querySelector("template")?.content ?? page;
        const text = root.querySelector("style")!.textContent;
        const what = `${html}, copying: ${copy !== undefined}`;
        if (copy === undefined) assert.equal(text, absolute, what);
        else {
          // The 2x image is copied too: Chromium loads the one for the screen's density.
          assert.deepEqual(
            copy.copies.sort(),
            ["Theme/icon.png", "Theme/icon@2x.png", "Theme/x.png", "Theme/y.png"],
            what,
          );
          assert.ok(text.includes(`image-set("data:image/png;base64,AQ==" 1x`), what);
          assert.ok(text.includes(`-webkit-image-set("data:image/png;base64,AQ==" 1x)`), what);
        }
      }
    }
  });

  it("copies the files of the page's own <style> and style attributes, and finds them by name", async () => {
    const own = `background: image-set("icon.png" 1x, "found.png" 2x)`;
    const html = `<style>a { ${own} }</style><p style='${own}'>x</p>`;
    const ctx: PageContext = {
      ...context({}),
      exists: (path) => path !== "Saved/found.png",
      locate: (linktext) => (linktext === "found.png" ? "Elsewhere/found.png" : null),
    };
    // Found by name, and otherwise as written, for the copy's <base>.
    const located = `background: image-set("icon.png" 1x, "${VAULT}Elsewhere/found.png" 2x)`;
    const page = parse(await prepare(html, ctx));
    assert.equal(page.querySelector("style")!.textContent, `a { ${located} }`);
    assert.equal(page.querySelector("p")!.getAttribute("style"), located);
    const copy = copying();
    await prepare(html, ctx, { copyFiles: copy });
    assert.deepEqual(copy.copies.sort(), ["Elsewhere/found.png", "Saved/icon.png"]);
  });

  it("leaves the other strings as they are, and reads and copies nothing for them", async () => {
    const strings = [
      `a::after { content: "ghost.png" }`,
      `@font-face { font-family: X; src: url(font.woff2) format("ghost.woff2"), local("ghost.ttf") }`,
      `b { background: image("ghost.png"); c: src("ghost.png"); d: cross-fade("ghost.png", "ghost.png") }`,
      `e { background: image-set(url(real.png) type("ghost.png") 1x) }`,
    ].join("\n");
    const ctx = context({ "Theme/site.css": strings });
    const copy = copying();
    const page = parse(
      await prepare('<link rel="stylesheet" href="../Theme/site.css">', ctx, { copyFiles: copy }),
    );
    assert.deepEqual(copy.copies.sort(), ["Theme/font.woff2", "Theme/real.png"]);
    const text = page.querySelector("style")!.textContent;
    for (const kept of strings.match(/"ghost[^"]*"/g)!) assert.ok(text.includes(kept), kept);
  });
});

describe("a <base> after the page's stylesheets (#185)", () => {
  // As headless Chrome 158 and Obsidian 1.5.3 and 1.15.1 resolve them, and
  // resources.e2e.ts checks: the stylesheets that Chromium parses before the
  // <base> resolve against the page's own address, and the rest against the
  // <base>, which the copy's own <base> gives them. Each tree's elements have
  // attributes of their own: Chromium can resolve an element that repeats one
  // before the <base> against the page, as the last test here says (#191).
  const page = `${VAULT}Saved/`;
  const sub = `${VAULT}Saved/sub/`;
  const files = {
    "Saved/css/s.css": "#l { background: url(../img/l.png) }",
    "Saved/sub/css/s.css": "#l { color: red }",
    "Saved/css/i.css": "#i { background: url(../img/i.png) }",
    "Saved/sub/css/i.css": "#i { color: red }",
  };
  const tree = (id: string) =>
    [
      `<style>#${id}a { background: url(img/a.png) }</style>`,
      `<style>@import "css/i.css"; #${id}b { background: image-set("img/b.png" 1x) }</style>`,
      `<link rel="stylesheet" href="css/s.css">`,
      `<svg><style>#${id}c { fill: url(img/c.svg#p) }</style></svg>`,
      `<p style="background: url(img/${id}d.png)">x</p>`,
    ].join("");
  const html = [
    `<body style="background: url(img/body.png)">`,
    tree("doc"),
    `<div><template shadowrootmode="open">${tree("shadow")}<div><template shadowrootmode="open">${tree("nested")}</template></div></template></div>`,
    `<template id="later">${tree("later")}</template>`,
    `<base href="sub/">`,
    tree("after"),
    `<div><template shadowrootmode="open">${tree("shadowafter")}</template></div>`,
  ].join("");

  /** The texts of a root's `<style>` elements, and of its `style` attributes, in order. */
  function texts(root: ParentNode) {
    return {
      styles: [...root.querySelectorAll("style")].map((style) => style.textContent),
      attributes: [...root.querySelectorAll("[style]")].map((element) =>
        element.getAttribute("style"),
      ),
    };
  }

  /**
   * What the copy makes of a `tree`: its `<style>` elements, the link's in
   * its place, and its `style` attribute, made absolute against `base`, or
   * kept as written, for the copy's <base>.
   */
  function expected(id: string, base: string | null) {
    if (base === null)
      return {
        styles: [
          `#${id}a { background: url(img/a.png) }`,
          `#i { color: red } #${id}b { background: image-set("img/b.png" 1x) }`,
          "#l { color: red }",
          `#${id}c { fill: url(img/c.svg#p) }`,
        ],
        attributes: [`background: url(img/${id}d.png)`],
      };
    return {
      styles: [
        `#${id}a { background: url("${base}img/a.png") }`,
        `#i { background: url("${base}img/i.png") } #${id}b { background: image-set("${base}img/b.png" 1x) }`,
        `#l { background: url("${base}img/l.png") }`,
        `#${id}c { fill: url("${base}img/c.svg#p") }`,
      ],
      attributes: [`background: url("${base}img/${id}d.png")`],
    };
  }

  it("resolves the stylesheets before it against the page, and gives the copy its address", async () => {
    const copy = parse(await prepare(html, context(files)));
    assert.equal(copy.querySelector("base")!.getAttribute("href"), sub);
    const [shadow, later, shadowAfter] = [...copy.querySelectorAll("template")].map(
      (template) => template.content,
    );
    const nested = shadow.querySelector("template")!.content;
    const own = texts(copy);
    const before = expected("doc", page);
    const after = expected("after", null);
    assert.deepEqual(
      {
        document: own,
        shadow: texts(shadow),
        nested: texts(nested),
        later: texts(later),
        shadowAfter: texts(shadowAfter),
      },
      {
        // The body is an ancestor of the <base>, which Chromium parses first.
        document: {
          styles: [...before.styles, ...after.styles],
          attributes: [
            `background: url("${page}img/body.png")`,
            ...before.attributes,
            ...after.attributes,
          ],
        },
        shadow: expected("shadow", page),
        nested: expected("nested", page),
        later: expected("later", null),
        shadowAfter: expected("shadowafter", null),
      },
    );
  });

  it("copies the files that each resolves to into a page with scripts on", async () => {
    const copies: string[] = [];
    const copyFiles: LocalFiles = {
      size: () => 1,
      async readBinary(path) {
        copies.push(path);
        return new Uint8Array([1]).buffer;
      },
    };
    await prepare(html, context(files), { copyFiles });
    const each = ["a.png", "b.png", "c.svg"];
    const attributes = (ids: string[], folder: string) =>
      ids.map((id) => `${folder}img/${id}d.png`);
    // Each root's own files, and the imported and linked stylesheets' in their folder.
    const before = [
      ...each.map((name) => `Saved/img/${name}`),
      ...attributes(["doc", "shadow", "nested"], "Saved/"),
      "Saved/img/i.png",
      "Saved/img/l.png",
    ];
    const after = [
      ...each.map((name) => `Saved/sub/img/${name}`),
      ...attributes(["later", "after", "shadowafter"], "Saved/sub/"),
    ];
    assert.deepEqual(
      [...new Set(copies)].sort(),
      [...before, ...after, "Saved/img/body.png"].sort(),
    );
  });

  it("applies the base that Chromium applies, or none", async () => {
    const style = `<style>a { b: url(img/x.png) }</style>`;
    for (const [head, base, text] of [
      // The first HTML <base> with an href, also an empty one, which is the page's address.
      [
        `<base href="">${style}<base href="sub/">`,
        `${page}Example%20article.html`,
        "url(img/x.png)",
      ],
      [`${style}<base href="sub/"><base href="other/">`, sub, `url("${page}img/x.png")`],
      // Chromium ignores a <base> in SVG, of a data: or javascript: URL, and in a template.
      [`<svg><base href="svg/"/></svg>${style}<base href="sub/">`, sub, `url("${page}img/x.png")`],
      [`${style}<base href="data:text/html,x">`, `${page}Example%20article.html`, "url(img/x.png)"],
      // An ignored first <base> lets no later one apply.
      [
        `<base href="data:text/html,x">${style}<base href="sub/">`,
        `${page}Example%20article.html`,
        "url(img/x.png)",
      ],
      [
        `${style}<base href="JavaScript:void(0)">`,
        `${page}Example%20article.html`,
        "url(img/x.png)",
      ],
      [
        `<template><base href="sub/"></template>${style}`,
        `${page}Example%20article.html`,
        "url(img/x.png)",
      ],
      // One at the top of the <head> comes before the stylesheets, as most do.
      [`<base href="../Other/">${style}`, `${VAULT}Other/`, "url(img/x.png)"],
    ]) {
      const copy = parse(await prepare(head, context({})));
      assert.equal(copy.querySelector("base")!.getAttribute("href"), base, head);
      assert.equal(copy.querySelector("style")!.textContent, `a { b: ${text} }`, head);
    }
  });

  it("resolves the style attribute of an element around the <base>, which Chromium parses first", async () => {
    const copy = parse(
      await prepare(
        `<html style="b: url(img/x.png)"><head><base href="sub/"></head><body style="b: url(img/y.png)">`,
        context({}),
      ),
    );
    assert.equal(copy.documentElement.getAttribute("style"), `b: url("${page}img/x.png")`);
    assert.equal(copy.body.getAttribute("style"), "b: url(img/y.png)");
  });

  it("finds by name a reference before it that does not resolve as a path against the page", async () => {
    const ctx: PageContext = {
      ...context({}),
      exists: (path) => path === "Saved/img/here.png" || path === "Saved/sub/img/there.png",
      locate: (linktext) => (linktext.endsWith(".png") ? `Found/${linktext}` : null),
    };
    const copy = parse(
      await prepare(
        `<style>a { b: url(img/here.png) } c { d: url(img/there.png) }</style><p style="b: url(img/there.png)">x</p><base href="sub/">`,
        ctx,
      ),
    );
    const found = `${VAULT}Found/img/there.png`;
    assert.equal(
      copy.querySelector("style")!.textContent,
      `a { b: url("${page}img/here.png") } c { d: url("${found}") }`,
    );
    assert.equal(copy.querySelector("p")!.getAttribute("style"), `b: url("${found}")`);
  });

  it("resolves an element after it against it, also one that repeats an element before it (#191)", async () => {
    // Chromium can resolve the second <p> against the page: it reuses the
    // attributes that it parsed for an element of the same tag with the same
    // attributes, in the same order, with their parsed style. Chromium 114
    // also reuses them for another tag, and the stylesheet of a <style> with
    // the same text and no import. The copy does not imitate this caching,
    // which differs between Chromium versions: the element after the <base>
    // resolves against the <base>, as every other one there does.
    const copy = parse(
      await prepare(
        `<p style="b: url(img/1.png)">a</p><base href="sub/"><p style="b: url(img/1.png)">b</p>`,
        context({}),
      ),
    );
    assert.deepEqual(
      [...copy.querySelectorAll("p")].map((p) => p.getAttribute("style")),
      [`b: url("${page}img/1.png")`, "b: url(img/1.png)"],
    );
  });
});

describe("a <base> after the page's resource attributes (#187)", () => {
  // As Obsidian 1.5.3 and 1.15.1 resolve them, and resources.e2e.ts checks:
  // Chromium resolves resource attributes as it parses their element, or
  // soon after, so that those before a later <base> resolve against the
  // page's address, also in a declarative shadow root (TESTING.md's limits
  // say when the ones that it resolves later do not).
  const page = `${VAULT}Saved/`;
  /** An element of each kind that names a resource, with files of its own. */
  const tree = (id: string) =>
    [
      `<img src="r/${id}-img.png" srcset="r/${id}-a.png 1x, r/${id}-b.png 2x">`,
      `<picture><source srcset="r/${id}-source.png"><img></picture>`,
      `<video src="r/${id}-video.webm" poster="r/${id}-poster.png">`,
      `<source src="r/${id}-vsource.webm"><track src="r/${id}-track.vtt"></video>`,
      `<audio src="r/${id}-audio.wav"></audio><input type="image" src="r/${id}-input.png">`,
      `<iframe src="r/${id}-frame.html"></iframe><script src="r/${id}-script.js"></script>`,
      `<svg><use href="r/${id}-use.svg#s"/><use xlink:href="r/${id}-xuse.svg#s"/>`,
      `<image href="r/${id}-image.png"/><image xlink:href="r/${id}-ximage.png"/></svg>`,
      `<embed src="r/${id}-embed.svg"><object data="r/${id}-object.svg"></object>`,
      // The backgrounds, SVG filter images, and SVG scripts of #198.
      `<table background="r/${id}-table.png"><colgroup background="r/${id}-colgroup.png">`,
      `<col background="r/${id}-col.png"></colgroup><thead background="r/${id}-thead.png">`,
      `<tr background="r/${id}-tr.png"><th background="r/${id}-th.png"></th></tr></thead>`,
      `<tbody background="r/${id}-tbody.png"><tr><td background="r/${id}-td.png"></td></tr>`,
      `</tbody><tfoot background="r/${id}-tfoot.png"></tfoot></table>`,
      `<svg><filter><feImage href="r/${id}-fe.png"/><feImage xlink:href="r/${id}-xfe.png"/>`,
      `</filter><script href="r/${id}-svgscript.js"></script>`,
      `<script xlink:href="r/${id}-xsvgscript.js"></script></svg>`,
    ].join("");
  const html = [
    tree("doc"),
    `<div><template shadowrootmode="open">${tree("shadow")}</template></div>`,
    `<template id="later">${tree("later")}</template>`,
    `<base href="sub/">`,
    tree("after"),
    `<div><template shadowrootmode="open">${tree("shadowafter")}</template></div>`,
  ].join("");

  /** The attributes of a root that name a `tree`'s files, by element and attribute. */
  function references(root: ParentNode, id: string): Record<string, string> {
    const found: Record<string, string> = {};
    for (const element of root.querySelectorAll("*"))
      for (const { name, value } of element.attributes)
        if (value.includes(`r/${id}-`)) found[`${element.localName} ${name}`] = value;
    return found;
  }

  /** What the copy makes of a `tree`'s attributes: made absolute against the page, or as written. */
  function expected(id: string, absolute: boolean): Record<string, string> {
    const url = (name: string) => `${absolute ? page : ""}r/${id}-${name}`;
    return {
      "img src": url("img.png"),
      "img srcset": `${url("a.png")} 1x, ${url("b.png")} 2x`,
      "source srcset": url("source.png"),
      "video src": url("video.webm"),
      "video poster": url("poster.png"),
      "source src": url("vsource.webm"),
      "track src": url("track.vtt"),
      "audio src": url("audio.wav"),
      "input src": url("input.png"),
      "iframe src": url("frame.html"),
      "script src": url("script.js"),
      "use href": url("use.svg#s"),
      "use xlink:href": url("xuse.svg#s"),
      "image href": url("image.png"),
      "image xlink:href": url("ximage.png"),
      "embed src": url("embed.svg"),
      "object data": url("object.svg"),
      "table background": url("table.png"),
      "colgroup background": url("colgroup.png"),
      "col background": url("col.png"),
      "thead background": url("thead.png"),
      "tr background": url("tr.png"),
      "th background": url("th.png"),
      "tbody background": url("tbody.png"),
      "td background": url("td.png"),
      "tfoot background": url("tfoot.png"),
      "feImage href": url("fe.png"),
      "feImage xlink:href": url("xfe.png"),
      "script href": url("svgscript.js"),
      "script xlink:href": url("xsvgscript.js"),
    };
  }

  it("makes absolute against the page those that Chromium resolves before it", async () => {
    const copy = parse(await prepare(html, context({})));
    const [shadow, later, shadowAfter] = [...copy.querySelectorAll("template")].map(
      (template) => template.content,
    );
    assert.deepEqual(
      {
        doc: references(copy, "doc"),
        shadow: references(shadow, "shadow"),
        later: references(later, "later"),
        after: references(copy, "after"),
        shadowafter: references(shadowAfter, "shadowafter"),
      },
      {
        doc: expected("doc", true),
        shadow: expected("shadow", true),
        later: expected("later", false),
        after: expected("after", false),
        shadowafter: expected("shadowafter", false),
      },
    );
  });

  it("copies the files that each resolves to into a page with scripts on", async () => {
    const copies: string[] = [];
    const copyFiles: LocalFiles = {
      size: () => 1,
      async readBinary(path) {
        copies.push(path);
        return new Uint8Array([1]).buffer;
      },
    };
    await prepare(html, context({}), { copyFiles });
    const names = [
      ...["img.png", "a.png", "b.png", "source.png", "video.webm", "poster.png"],
      ...["vsource.webm", "track.vtt", "audio.wav", "input.png", "script.js"],
      ...["image.png", "ximage.png"],
      ...["table.png", "colgroup.png", "col.png", "thead.png", "tr.png", "th.png"],
      ...["tbody.png", "td.png", "tfoot.png", "fe.png", "xfe.png"],
      ...["svgscript.js", "xsvgscript.js"],
    ];
    const files = (id: string, folder: string) =>
      names.map((name) => `Saved/${folder}r/${id}-${name}`);
    assert.deepEqual(
      [...new Set(copies)].sort(),
      [
        ...["doc", "shadow"].flatMap((id) => files(id, "")),
        ...["later", "after", "shadowafter"].flatMap((id) => files(id, "sub/")),
      ].sort(),
    );
  });

  it("finds by name a reference before it that does not resolve as a path against the page", async () => {
    const ctx: PageContext = {
      ...context({}),
      exists: (path) => path === "Saved/r/here.png" || path === "Saved/sub/r/there.png",
      locate: (linktext) => (linktext.endsWith(".png") ? `Found/${linktext}` : null),
    };
    const copy = parse(
      await prepare(
        `<img src="r/here.png"><img srcset="r/there.png 2x"><base href="sub/"><img src="r/there.png">`,
        ctx,
      ),
    );
    assert.deepEqual(
      [...copy.images].map((image) => image.getAttribute("src") ?? image.getAttribute("srcset")),
      [`${page}r/here.png`, `${VAULT}Found/r/there.png 2x`, "r/there.png"],
    );
  });

  it("keeps as written a reference that the page and the <base> resolve alike, or names no file", async () => {
    const kept = [
      "/root.png",
      "https://example.com/web.png",
      "data:image/png;base64,AQ==",
      "#fragment",
      "",
      "  ",
    ];
    const images = kept.map((src) => `<img src="${src}">`).join("");
    const copy = parse(
      await prepare(
        `${images}<svg><use href="#s"/></svg><img src="?query"><base href="sub/">`,
        context({}),
      ),
    );
    assert.deepEqual(
      [...copy.images].map((image) => image.getAttribute("src")),
      [...kept, `${page}Example%20article.html?query`],
    );
    assert.equal(copy.querySelector("use")!.getAttribute("href"), "#s");
    // A <base> of another origin resolves a path from its root elsewhere.
    const other = parse(
      await prepare(`<img src="/root.png"><base href="https://example.com/">`, context({})),
    );
    assert.equal(other.images[0].getAttribute("src"), "app://vault-id/root.png");
  });

  it("resolves an element after it against it, also one that repeats an element before it", async () => {
    // Chromium resolves a resource attribute anew for each element, unlike
    // the style attribute that it can reuse (#191).
    const copy = parse(
      await prepare(`<img src="r/1.png"><base href="sub/"><img src="r/1.png">`, context({})),
    );
    assert.deepEqual(
      [...copy.images].map((image) => image.getAttribute("src")),
      [`${page}r/1.png`, "r/1.png"],
    );
  });
});

describe("background attributes, SVG filter images, and SVG scripts (#198)", () => {
  // Chromium loads the images of the background attributes of a table's
  // elements and the <body>, and the files of an SVG <feImage> and <script>,
  // as resources.e2e.ts checks. The tests of #187 above cover each kind before
  // and after a later <base>, in shadow roots and templates, and copied.
  const page = `${VAULT}Saved/`;

  it("makes a <body>'s background absolute before a later <base>, around which it is", async () => {
    const around = parse(
      await prepare(`<body background="r/body.png"><p>x</p><base href="sub/">`, context({})),
    );
    assert.equal(around.body.getAttribute("background"), `${page}r/body.png`);
    const after = parse(
      await prepare(
        `<head><base href="sub/"></head><body background="r/body.png"><p>x</p>`,
        context({}),
      ),
    );
    assert.equal(after.body.getAttribute("background"), "r/body.png");
  });

  it("reads each attribute only on the elements of the namespace that Chromium reads it on", async () => {
    const html = [
      `<div background="r/div.png"></div><span background="r/span.png"></span>`,
      `<script href="r/html.js"></script><use href="r/html-use.svg#s"></use>`,
      `<svg><script src="r/svg.js"></script><video src="r/svg.webm"/><rect background="r/rect.png"/>`,
      `<use href="r/svg-use.svg#s"/></svg><base href="sub/">`,
    ].join("");
    const copies: string[] = [];
    const copyFiles: LocalFiles = {
      size: () => 1,
      async readBinary(path) {
        copies.push(path);
        return new Uint8Array([1]).buffer;
      },
    };
    const copy = parse(await prepare(html, context({}), { copyFiles }));
    assert.deepEqual(
      [...copy.body.querySelectorAll("*")].flatMap((element) =>
        [...element.attributes]
          .filter(({ value }) => value.includes("r/"))
          .map(({ name, value }) => `${element.localName} ${name} ${value}`),
      ),
      [
        "div background r/div.png",
        "span background r/span.png",
        "script href r/html.js",
        "use href r/html-use.svg#s",
        "script src r/svg.js",
        "video src r/svg.webm",
        "rect background r/rect.png",
        `use href ${page}r/svg-use.svg#s`,
      ],
    );
    assert.deepEqual(copies, [], "nothing of these is copied");
  });

  it("copies their files as data: URLs of their types, by the same checks and limits", async () => {
    const files: Record<string, string> = {
      "Saved/bg.png": "B",
      "Saved/fe.svg": "<svg/>",
      "Saved/run.js": "J",
      "Saved/notes.md": "Private text",
      "Saved/huge.png": "H",
    };
    const sizes: Record<string, number> = { "Saved/huge.png": COPY_FILE_LIMIT + 1 };
    const asked: string[] = [];
    const reads: string[] = [];
    const copyFiles: LocalFiles = {
      size: (path) => {
        asked.push(path);
        return sizes[path] ?? (path in files ? files[path].length : null);
      },
      async readBinary(path) {
        reads.push(path);
        return path in files ? new TextEncoder().encode(files[path]).buffer : null;
      },
    };
    const html = [
      `<table background="bg.png"><tr><td background="notes.md"></td>`,
      `<td background="https://example.com/x.png"></td><td background="../../../../outside.png"></td>`,
      `<td background="huge.png"></td><td background=""></td></tr></table>`,
      `<svg><filter><feImage href="fe.svg#x"/><feImage href="#local"/></filter>`,
      `<script href="run.js"></script></svg>`,
    ].join("");
    const prepared = await preparePage(html, context({}), { copyFiles });
    const copy = parse(prepared.html);
    const data = (type: string, text: string): string => `data:${type};base64,${btoa(text)}`;
    assert.deepEqual(
      [copy.querySelector("table"), ...copy.querySelectorAll("td")].map((element) =>
        element?.getAttribute("background"),
      ),
      [
        data("image/png", "B"),
        "notes.md",
        "https://example.com/x.png",
        "../../../../outside.png",
        "huge.png",
        "",
      ],
    );
    assert.deepEqual(
      [...copy.querySelectorAll("feImage")].map((image) => image.getAttribute("href")),
      [`${data("image/svg+xml", "<svg/>")}#x`, "#local"],
    );
    assert.equal(
      copy.querySelector("svg script")?.getAttribute("href"),
      data("text/javascript", "J"),
    );
    assert.deepEqual(reads.sort(), ["Saved/bg.png", "Saved/fe.svg", "Saved/run.js"]);
    for (const path of asked)
      assert.match(path, /^Saved\/[^/]+\.(png|svg|js)$/, `asked about ${path}`);
    assert.deepEqual(prepared.copiedFiles, { copied: 3, leftOut: 1 });
  });

  it("finds by name one that does not resolve as a path", async () => {
    const ctx: PageContext = {
      ...context({}),
      exists: () => false,
      locate: (linktext) => `Found/${linktext}`,
    };
    const html = [
      `<table><tr><td background="bg.png"></td></tr></table>`,
      `<svg><filter><feImage xlink:href="fe.png"/></filter><script href="run.js"></script></svg>`,
    ].join("");
    const copy = parse(await prepare(html, ctx));
    assert.deepEqual(
      [
        copy.querySelector("td")?.getAttribute("background"),
        copy.querySelector("feImage")?.getAttribute("xlink:href"),
        copy.querySelector("svg script")?.getAttribute("href"),
      ],
      [`${VAULT}Found/bg.png`, `${VAULT}Found/fe.png`, `${VAULT}Found/run.js`],
    );
  });
});

describe("a string or url( left open at the end of a style attribute (#194)", () => {
  // CSS closes what the end of a style attribute leaves open, as headless
  // Chrome 158 and Obsidian 1.5.3 and 1.15.1 load the file of such a string
  // or url(, and resources.e2e.ts checks.
  const page = `${VAULT}Saved/`;
  const open = (id: string) => [
    `b: image-set("img/${id}a.png`,
    `b: url("img/${id}b.png`,
    `b: url(img/${id}c.png`,
    `b: url('img/${id}d.png`,
  ];
  /** Elements whose style attributes are these, as the page writes them. */
  const styled = (styles: string[]) =>
    styles.map((style) => `<p style='${style.replaceAll("'", "&#39;")}'>x</p>`).join("");
  const styles = (root: ParentNode) =>
    [...root.querySelectorAll("p")].map((p) => p.getAttribute("style"));

  it("makes such a reference absolute before a later <base>, keeping the rest as written", async () => {
    const copy = parse(
      await prepare(
        `${styled([...open("x"), "color: red /* x"])}<base href="sub/">${styled(open("y"))}`,
        context({}),
      ),
    );
    assert.deepEqual(styles(copy), [
      `b: image-set("${page}img/xa.png"`,
      `b: url("${page}img/xb.png")`,
      `b: url("${page}img/xc.png")`,
      `b: url("${page}img/xd.png")`,
      "color: red /* x",
      ...open("y"),
    ]);
  });

  it("copies the file of such a reference into a page with scripts on, in every place", async () => {
    const copies: string[] = [];
    const copyFiles: LocalFiles = {
      size: () => 1,
      async readBinary(path) {
        copies.push(path);
        return new Uint8Array([1]).buffer;
      },
    };
    const html = [
      styled(open("doc")),
      `<div><template shadowrootmode="open">${styled(open("shadow"))}</template></div>`,
      `<base href="sub/">`,
      styled(open("after")),
    ].join("");
    const copy = parse(await prepare(html, context({}), { copyFiles }));
    const files = (id: string, folder: string) =>
      ["a", "b", "c", "d"].map((name) => `Saved/${folder}img/${id}${name}.png`);
    assert.deepEqual(
      [...new Set(copies)].sort(),
      [...files("doc", ""), ...files("shadow", ""), ...files("after", "sub/")].sort(),
    );
    const data = "data:image/png;base64,AQ==";
    assert.deepEqual(styles(copy).slice(0, 4), [
      `b: image-set("${data}"`,
      `b: url("${data}")`,
      `b: url("${data}")`,
      `b: url("${data}")`,
    ]);
  });

  it("finds the file of such a reference by name", async () => {
    const ctx: PageContext = {
      ...context({}),
      exists: () => false,
      locate: (linktext) => `Found/${linktext}`,
    };
    const copy = parse(await prepare(styled(open("n")), ctx));
    const found = (name: string) => `${VAULT}Found/img/n${name}.png`;
    assert.deepEqual(styles(copy), [
      `b: image-set("${found("a")}"`,
      `b: url("${found("b")}")`,
      `b: url("${found("c")}")`,
      `b: url("${found("d")}")`,
    ]);
  });
});

describe("stylesheet sets (#169)", () => {
  // As headless Chrome 158 and Obsidian 1.5.3 and 1.15.1 apply them, and
  // resources.e2e.ts checks: in a document, untitled stylesheets and those of
  // the set that the first title names. Each link names a file of its own,
  // and each <style> imports one, so that the reads show what is prepared.
  const titled = (title: string | null) => (title === null ? "" : ` title="${title}"`);
  const link = (title: string | null, name: string, extra = "") =>
    `<link rel="stylesheet"${titled(title)} href="${name}.css"${extra}>`;
  const alternate = (title: string | null, name: string) =>
    `<link rel="alternate stylesheet"${titled(title)} href="${name}.css">`;
  const style = (title: string | null, name: string, extra = "") =>
    `<style${titled(title)}${extra}>@import "${name}.css";</style>`;
  const meta = (content: string) => `<meta http-equiv="Default-Style" content="${content}">`;

  /** The names of the files that preparing the page reads, sorted: each exists but missing.css. */
  async function read(html: string): Promise<string[]> {
    const reads: string[] = [];
    await prepare(html, {
      ...context({}),
      async read(path) {
        reads.push(path);
        return path.endsWith("/missing.css") ? null : "p{}";
      },
    });
    return reads.map((path) => path.replace(/^Saved\/(.*)\.css$/, "$1")).sort();
  }

  it("prepares untitled stylesheets and those of the set that the first title names", async () => {
    for (const [what, html, expected] of [
      [
        "links, with alternate ones, a repeat of the first title, and a title of a space",
        [
          link("A", "a1"),
          link("B", "b1"),
          link(null, "c1"),
          link("A", "a2"),
          alternate("A", "alt1"),
          alternate("B", "alt2"),
          alternate(null, "p1"),
          link(" ", "sp"),
          link("B", "b2"),
        ],
        ["a1", "a2", "alt1", "c1"],
      ],
      [
        "a <style> first",
        [style("B", "sb"), link("A", "a1"), link("B", "b1"), style("A", "sa"), style(null, "ss")],
        ["b1", "sb", "ss"],
      ],
      [
        "a link first, which names its set before it loads",
        [link("A", "a1"), style("B", "sb"), link("B", "b1"), style("A", "sa")],
        ["a1", "sa"],
      ],
      [
        "a missing first link, which names its set too",
        [link("A", "missing"), link("B", "b1"), link("A", "a1")],
        ["a1", "missing"],
      ],
      [
        "a disabled first link, which names none",
        [link("A", "a1", " disabled"), link("B", "b1"), link("A", "a2")],
        ["b1"],
      ],
      [
        "a Default-Style <meta> first",
        [meta("B"), link("A", "a1"), link("B", "b1"), style("A", "sa"), style("B", "sb")],
        ["b1", "sb"],
      ],
      ["a Default-Style <meta> after", [link("A", "a1"), style("B", "sb"), meta("B")], ["a1"]],
      [
        "an empty Default-Style <meta>, then two",
        [meta(""), meta("B"), meta("A"), link("A", "a1"), link("B", "b1")],
        ["b1"],
      ],
      [
        "titled elements that name no set: a link of another type or without an href, an alternate link, and a <style> of another type",
        [
          link("A", "t1", ' type="text/plain"'),
          `<link rel="stylesheet" title="A" href="">`,
          `<link rel="stylesheet" title="A" href=" \t">`,
          alternate("A", "alt1"),
          style("A", "sx", ' type="text/x-scss"'),
          link("B", "b1"),
          link("A", "a2"),
        ],
        ["b1"],
      ],
      [
        "SVG <style> elements",
        [
          `<svg><style title="B">@import "svgb.css";</style><style title="A">@import "svga.css";</style></svg>`,
          link("A", "a1"),
          link("B", "b1"),
        ],
        ["b1", "svgb"],
      ],
      [
        "a Default-Style <meta> whose http-equiv is in another case",
        [`<meta http-equiv="DEFAULT-style" content="B">`, link("A", "a1"), link("B", "b1")],
        ["b1"],
      ],
      [
        "a Default-Style <meta> in the <body>, before the titles",
        [`<p>x</p>`, meta("B"), link("A", "a1"), link("B", "b1")],
        ["b1"],
      ],
      [
        "a first link whose href is no URL, which names no set",
        [`<link rel="stylesheet" title="A" href="http://[bad">`, link("B", "b1"), link("A", "a2")],
        ["b1"],
      ],
      [
        "titles that differ in case or spaces",
        [link("a", "lower"), link("A", "upper"), link(" a ", "spaced"), meta("A")],
        ["lower"],
      ],
      [
        "a Default-Style <meta> with spaces",
        [meta(" B "), link(" B ", "spaced"), link("B", "b1")],
        ["spaced"],
      ],
    ] as const) {
      assert.deepEqual(await read(html.join("")), [...expected].sort(), what);
    }
  });

  it("prepares every stylesheet but alternate links in shadow roots and templates, whose titles name no set", async () => {
    const html = [
      link("A", "a1"),
      `<div><template shadowrootmode="open">`,
      [link("B", "b2"), style("B", "sb"), alternate("A", "alt1"), link(null, "c1"), meta("B")].join(
        "",
      ),
      `</template></div>`,
      `<template>${link("B", "t1")}${alternate("A", "t2")}</template>`,
      link("B", "b1"),
    ].join("");
    assert.deepEqual(await read(html), ["a1", "b2", "c1", "sb", "t1"]);
  });

  it("keeps the others as the page has them, and copies nothing for them", async () => {
    const copies: string[] = [];
    const copyFiles: LocalFiles = {
      size: () => 1,
      async readBinary(path) {
        copies.push(path);
        return new Uint8Array([1]).buffer;
      },
    };
    const html = [
      `<style title="A">a { b: url(a.png) }</style>`,
      `<style title="B">c { d: url(b.png) }</style>`,
      `<style>e { f: url(c.png) }</style>`,
      link("B", "b1"),
      alternate("B", "alt2"),
    ].join("");
    const copy = parse(await prepare(html, context({ "Saved/b1.css": "g{}" }), { copyFiles }));
    assert.deepEqual(copies.sort(), ["Saved/a.png", "Saved/c.png"]);
    assert.equal(copy.querySelector('style[title="B"]')!.textContent, "c { d: url(b.png) }");
    assert.deepEqual(
      [...copy.querySelectorAll("link")].map((element) => element.outerHTML),
      [link("B", "b1"), alternate("B", "alt2")],
    );
  });

  it("gives the reading style to a page whose only stylesheets are outside the set", async () => {
    for (const [html, own] of [
      [`<style title="A">p{}</style>`, true],
      [`${meta("X")}<style title="A">p{}</style>`, false],
      [`${meta("X")}${link("A", "a1")}${alternate("X", "x")}`, true],
      [`${style("A", "sa")}${alternate("B", "alt")}`, true],
      [`${style(null, "plain")}${meta("X")}`, true],
      [`${link("A", "a1")}${link("B", "b1")}`, true],
      [`${meta("X")}${link("A", "a1")}`, false],
    ] as const) {
      const prepared = await preparePage(html, context({}), { readingStyle: "p{}" });
      assert.equal(prepared.ownStyles, own, html);
    }
  });
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
    assert.deepEqual(css, [
      `@font-face { font-family: X; src: url("${VAULT}Mirror/css/x.woff2") }\nbody { background: url("${VAULT}Mirror/css/bg.png") }\nh1 { color: red }`,
    ]);
  });

  it("wraps an import with media conditions in @media", async () => {
    const ctx = context({ "print.css": "body { color: black }" });
    const css = await inlineStylesheet(`@import "print.css" print;`, `${VAULT}main.css`, ctx);
    assert.deepEqual(css, ["@media print {\nbody { color: black }\n}"]);
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
      assert.deepEqual(await inlineStylesheet(source, `${VAULT}main.css`, ctx), [result]);
  });

  it("leaves imports it cannot inline as absolute imports", async () => {
    const ctx = context({});
    const css = await inlineStylesheet(
      `@import "missing.css";\n@import url(https://example.com/x.css);\n@import "scoped.css" scope(.card);`,
      `${VAULT}main.css`,
      ctx,
    );
    assert.deepEqual(css, [
      `@import url("${VAULT}missing.css");\n@import url("https://example.com/x.css");\n@import url("${VAULT}scoped.css") scope(.card);`,
    ]);
  });

  it("stops at an import cycle", async () => {
    const ctx = context({
      "a.css": `@import "b.css"; a { x: 1 }`,
      "b.css": `@import "a.css"; b { x: 2 }`,
    });
    const css = await inlineStylesheet(`@import "a.css";`, `${VAULT}main.css`, ctx);
    assert.deepEqual(css, [`@import url("${VAULT}a.css"); b { x: 2 } a { x: 1 }`]);
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
    assert.deepEqual(css, [`@import url("${VAULT}unreadable.css"); a { x: 1 }`]);
  });

  it("reads only CSS files, and leaves imports of other files as absolute imports", async () => {
    const ctx = context({ "notes.md": "Private text", "Upper.CSS": "a { x: 1 }" });
    const css = await inlineStylesheet(
      `@import "notes.md";\n@import "Upper.CSS";`,
      `${VAULT}main.css`,
      ctx,
    );
    // The kept import comes before the inlined text, so it stays one stylesheet.
    assert.deepEqual(css, [`@import url("${VAULT}notes.md");\na { x: 1 }`]);
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
    const sized: string[] = [];
    const copyFiles: LocalFiles = {
      size(path) {
        sized.push(path);
        return null;
      },
      readBinary: async () => null,
    };
    const html = [
      `<style>@import "\\D800.css"; p { background: url(\\110000.png) }</style>`,
      `<p style="background: url('\\FFFFFF.png')">Text</p>`,
    ].join("");
    const page = parse(await prepare(html, ctx, { copyFiles }));
    const [policy, base] = [...page.head.children];
    assert.equal(policy.getAttribute("content"), pagePolicy(VAULT));
    assert.equal(base.getAttribute("href"), ctx.pageUrl);
    // The import stays one, made absolute; the URL keeps its text (#177).
    assert.equal(
      page.querySelector("style")?.textContent,
      `@import url("${VAULT}Saved/%EF%BF%BD.css"); p { background: url(\\110000.png) }`,
    );
    assert.deepEqual(sized, ["Saved/\uFFFD.png", "Saved/\uFFFD.png"]);
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

    it("is added to a page whose only styles are of another type, or disabled links (#147)", async () => {
      for (const [html, own] of [
        ["<style type='text/x-scss'>p { margin: 0 }</style><p>x</p>", false],
        ["<svg><style type='text/css;'>p { margin: 0 }</style></svg><p>x</p>", false],
        [`<link rel="stylesheet" type="text/plain" href="style.css"><p>x</p>`, false],
        [`<link rel="stylesheet" href="style.css" disabled><p>x</p>`, false],
        ["<style type='TEXT/CSS'>p { margin: 0 }</style><p>x</p>", true],
        [`<link rel="stylesheet" type="text/css; charset=utf-8" href="style.css"><p>x</p>`, true],
      ] as const) {
        const prepared = await preparePage(html, context({ "Saved/style.css": "p {}" }), {
          readingStyle: READING,
        });
        assert.equal(prepared.ownStyles, own, html);
        assert.equal(parse(prepared.html).getElementById(READING_STYLE_ID) === null, own, html);
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
      // Linked and imported, the file is read once (#154).
      assert.deepEqual(ctx.reads, ["Theme/site.css"]);
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

  it("names the file of an href stripped of ASCII whitespace only, as a click opens it (#199)", async () => {
    // Chromium keeps U+00A0 at an end of a link's URL, which trim would remove.
    const html = [
      `<a href="&nbsp;Other%20page.html">no-break space</a>`,
      `<a href="&#10; Other%20page.html&#9;&#12;">ASCII whitespace</a>`,
      `<a href="&nbsp;glossary.html">by name, only without the space</a>`,
      `<a href="glossary.html&#8195;">an em space at its end</a>`,
    ].join("");
    assert.deepEqual(await titles(html, "a"), [
      "Saved/ Other page.html",
      "Saved/Other page.html",
      "Saved/ glossary.html",
      "Saved/glossary.html ",
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

  it("copies no file whose extension names a property of every object", async () => {
    const files = { "Saved/x.constructor": "C", "Saved/x.__proto__": "P", "Saved/x.png": "A" };
    const html = `<img src="x.constructor"><img src="x.__proto__"><img src="x.png">`;
    const { page, copy, prepared } = await copied(html, files);
    assert.deepEqual(
      [...page.images].map((image) => image.getAttribute("src")),
      ["x.constructor", "x.__proto__", data("image/png", "A")],
    );
    assert.deepEqual(copy.reads, ["Saved/x.png"]);
    assert.deepEqual(prepared.copiedFiles, { copied: 1, leftOut: 0 });
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

  describe("text tracks in a page with scripts off (#196)", () => {
    // Obsidian 1.5.3 and 1.15.1 load a text track into a frame with scripts
    // off only from the frame's own origin, which no vault file has, or as a
    // data: URL, as resources.e2e.ts checks.
    const FILES = {
      "Saved/subs.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nHello",
      "Saved/a.png": "A",
      "Saved/clip.mp4": "M",
      "Saved/poster.jpg": "P",
      "Saved/app.js": "J",
      "Saved/x.woff2": "F",
      "Saved/notes.md": "Private text",
      "Saved/icons.svg": "<svg/>",
    };

    async function tracksCopied(html: string, files: Record<string, string> = FILES) {
      const copy = localFiles(files);
      const prepared = await preparePage(html, context({}), { copyTracks: copy });
      return { page: parse(prepared.html), copy, prepared };
    }

    it("copies the page's text tracks as data: URLs, and nothing else", async () => {
      const html = [
        `<img src="a.png"><video src="clip.mp4" poster="poster.jpg">`,
        `<track src="subs.vtt"><track src="notes.md"><track src="a.png"><track src="missing.vtt">`,
        `<track src="https://example.com/subs.vtt"><track src="../../../../outside.vtt"></video>`,
        `<script src="app.js"></script><svg><use href="icons.svg#home"/><image href="icons.svg"/></svg>`,
        `<style>@font-face { src: url(x.woff2) } body { background: url(a.png) }</style>`,
        `<p style="background: url(a.png)">x</p>`,
        // Only a track's file is copied, also of a track's type.
        `<img src="subs.vtt"><p style="background: url(subs.vtt)">x</p>`,
        `<style>p { background: url(subs.vtt) }</style>`,
      ].join("");
      const { page, copy, prepared } = await tracksCopied(html);
      assert.deepEqual(
        [...page.querySelectorAll("track")].map((track) => track.getAttribute("src")),
        [
          data("text/vtt", FILES["Saved/subs.vtt"]),
          "notes.md",
          "a.png",
          "missing.vtt",
          "https://example.com/subs.vtt",
          "../../../../outside.vtt",
        ],
      );
      assert.equal(prepared.html.split(";base64,").length - 1, 1, "only the track is copied");
      assert.deepEqual(copy.reads, ["Saved/subs.vtt"]);
      for (const path of copy.asked)
        assert.match(path, /^Saved\/[^/]+\.vtt$/, `asked about ${path}`);
      assert.deepEqual(prepared.copiedFiles, { copied: 1, leftOut: 0 });
    });

    it("copies those of shadow roots and templates, and those before a later <base> from the page's folder", async () => {
      const files = { "Saved/subs.vtt": "page", "Saved/sub/subs.vtt": "base" };
      const track = `<video><track src="subs.vtt"></video>`;
      const html = [
        track,
        `<div><template shadowrootmode="open">${track}</template></div>`,
        `<base href="sub/">${track}<template>${track}</template>`,
      ].join("");
      const { page, prepared } = await tracksCopied(html, files);
      const [shadow, later] = [...page.querySelectorAll("template")].map(({ content }) => content);
      assert.deepEqual(
        [page, shadow, later].flatMap((root) =>
          [...root.querySelectorAll("track")].map((element) => element.getAttribute("src")),
        ),
        [
          data("text/vtt", "page"),
          data("text/vtt", "base"),
          data("text/vtt", "page"),
          data("text/vtt", "base"),
        ],
      );
      assert.deepEqual(prepared.copiedFiles, { copied: 2, leftOut: 0 });
    });

    it("leaves out a track over the limits, and says how many", async () => {
      const copy = localFiles(
        { "Saved/huge.vtt": "H", "Saved/subs.vtt": "S" },
        { "Saved/huge.vtt": COPY_FILE_LIMIT + 1 },
      );
      const html = `<video><track src="huge.vtt"><track src="subs.vtt"></video>`;
      const prepared = await preparePage(html, context({}), { copyTracks: copy });
      assert.deepEqual(
        [...parse(prepared.html).querySelectorAll("track")].map((track) =>
          track.getAttribute("src"),
        ),
        ["huge.vtt", data("text/vtt", "S")],
      );
      assert.deepEqual(prepared.copiedFiles, { copied: 1, leftOut: 1 });
      assert.deepEqual(copy.reads, ["Saved/subs.vtt"]);
    });

    it("copies every file of the copied types instead when copyFiles is given too", async () => {
      const tracks = localFiles(FILES);
      const every = localFiles(FILES);
      const html = `<img src="a.png"><video><track src="subs.vtt"></video>`;
      const prepared = await preparePage(html, context({}), {
        copyFiles: every,
        copyTracks: tracks,
      });
      const page = parse(prepared.html);
      assert.equal(page.querySelector("img")?.getAttribute("src"), data("image/png", "A"));
      assert.equal(
        page.querySelector("track")?.getAttribute("src"),
        data("text/vtt", FILES["Saved/subs.vtt"]),
      );
      assert.deepEqual(tracks.asked, []);
      assert.deepEqual(every.reads.sort(), ["Saved/a.png", "Saved/subs.vtt"]);
    });
  });
});
