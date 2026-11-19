import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cssDeclarationsEnd,
  cssEnd,
  cssImports,
  cssReferences,
  cssTokens,
  importStop,
} from "../src/css";

it("keeps malformed quoted functions and subsequent literal strings separate", () => {
  for (const css of [
    `a { b: url("x" ")"); } p::after { content: "url(ghost.png)" }`,
    `a { b: url("x" /* ) " */ ); } p::after { content: "url(ghost.png)" }`,
    `@import url("x" ")"); p::after { content: "@import 'ghost.css';" }`,
  ]) {
    const tokens = cssTokens(css);
    assert.deepEqual(
      tokens.filter((t) => t.kind === "url"),
      [],
    );
    assert.deepEqual(cssImports(css, tokens), []);
    assert.equal(tokens.map((t) => css.slice(t.start, t.end)).join(""), css);
    assert.equal(tokens.find((t) => t.value === "url")?.kind, "name");
  }
});

it("distinguishes bad strings, EOF strings and newline recovery", () => {
  assert.deepEqual(cssImports('@import "ghost.css?\\"\nscreen;'), []);
  assert.deepEqual(
    cssTokens('url("ghost.png?\\"\n )').filter((t) => t.kind === "url"),
    [],
  );
  const tokens = cssTokens('"bad\nurl(real.png)');
  assert.equal(tokens[0].kind, "other");
  assert.equal(tokens.find((t) => t.kind === "url")?.value, "real.png");
  assert.deepEqual(cssTokens('"EOF'), [
    { start: 0, end: 4, kind: "string", value: "EOF", open: true },
  ]);
});

it("ends a hex escape before a line continuation, which stands for nothing", () => {
  for (const [css, value] of [
    ['"gh\\6\\\nfst.css"', "gh\u0006fst.css"],
    ['"gh\\6\\\r\nfst.css"', "gh\u0006fst.css"],
    ['"gh\\6 \\\nfst.css"', "gh\u0006fst.css"],
    ['"a\\\nb\\\fc\\\rd"', "abcd"],
  ])
    assert.equal(cssTokens(css)[0].value, value, JSON.stringify(css));
});

it("reads only 0-9, A-F and a-f as hexadecimal escape digits", () => {
  for (let code = 0; code <= 0xffff; code++) {
    const char = String.fromCharCode(code);
    // A hex escape takes the newline after it, so the string still closes. Any
    // other escape leaves the newline to end a bad string, except that a
    // backslash before CRLF is one line continuation.
    const closed = /^[0-9A-Fa-f\r]$/.test(char);
    const kind = cssTokens(`"\\${char}\n"`)[0].kind;
    if (kind !== (closed ? "string" : "other")) assert.fail(`U+${code.toString(16)}: ${kind}`);
  }
});

it("ends a bad string at a newline after any escaped control character", () => {
  const controls = [
    ...Array.from({ length: 0x20 }, (_, code) => code).filter((code) => code !== 0x0d),
    0x7f,
    ...Array.from({ length: 0x20 }, (_, code) => 0x80 + code),
  ];
  for (const char of controls.map((code) => String.fromCharCode(code))) {
    // To CSS, the resource-like text sits inside the string that starts after the newline.
    for (const css of [
      `p::after { content: "\\${char}\n" url(ghost.png) "" }`,
      `p::after { content: "\\${char}\n" } @import "ghost.css"; p::after { content: "" }`,
    ]) {
      const tokens = cssTokens(css);
      assert.deepEqual(
        tokens.filter((t) => t.kind === "url"),
        [],
      );
      assert.deepEqual(cssImports(css, tokens), []);
    }
  }
});

it("uses delimiters only for nesting and prelude boundaries", () => {
  for (const css of [
    'a { b: url(} x); @import "ghost.css"; }',
    '} a { @import "ghost.css"; }',
    // A closer that does not match the innermost open block belongs to that block.
    'a { b: (}); @import "ghost.css"; }',
    'a { b: [}]; @import "ghost.css"; }',
    '@import "ghost.css" ({);',
  ])
    assert.deepEqual(cssImports(css), []);
  const css = '@import "real.css" url(; x) screen;';
  assert.equal(cssImports(css)[0].end, css.length);
  assert.deepEqual(
    cssImports('@import "real.css" ); @import "ghost.css" (}); a { }').map(
      (rule) => rule.reference,
    ),
    ["real.css", "ghost.css"],
  );
});

it("decodes real URL tokens and treats backslash-newline as a delimiter", () => {
  for (const [css, value] of [
    ["URL(x.png)", "x.png"],
    [String.raw`url(a\29 b.png)`, "a)b.png"],
    [String.raw`url(a\22 b.png)`, 'a"b.png'],
    [String.raw`url(a\ b.png)`, "a b.png"],
    ["\\\nurl(real.png)", "real.png"],
  ])
    assert.equal(cssTokens(css).find((t) => t.kind === "url")?.value, value);
});

describe("import placement (#136)", () => {
  const imported = (css: string) => cssImports(css).map((rule) => rule.reference);

  it("finds imports only where a top-level rule starts, before other rules", () => {
    for (const css of [
      'a { color: red } @import "ghost.css";',
      // To CSS, an @import inside a qualified rule's prelude is part of its selector.
      'x @import "ghost.css"; a { color: red }',
      ') @import "ghost.css"; a { color: red }',
      '} @import "ghost.css";',
      '; @import "ghost.css";',
      '@media print {} @import "ghost.css";',
      '@namespace svg url(http://www.w3.org/2000/svg); @import "ghost.css";',
      '@layer base {} @import "ghost.css";',
      '@font-face { font-family: X } @import "ghost.css";',
      // Browsers still import after rules that they drop as invalid, which only CSS evaluation tells.
      '@unknown; @import "ghost.css";',
      // U+FEFF in a stylesheet's text is a name character, which starts a rule.
      '\ufeff@import "ghost.css";',
    ])
      assert.deepEqual(imported(css), [], JSON.stringify(css));
    for (const [css, references] of [
      ['@import "real.css";; @import "ghost.css";', ["real.css"]],
      ['@import "real.css"; @layer a; @import "ghost.css";', ["real.css"]],
      ['@import "real.css"; a {} @import "ghost.css";', ["real.css"]],
    ] as const)
      assert.deepEqual(imported(css), references, JSON.stringify(css));
  });

  it("finds imports after @charset, @layer statements, other imports, and HTML comment markers", () => {
    for (const css of [
      '@charset "utf-8"; @import "a.css"; @import url(b.css);',
      '@layer reset, base; @import "a.css"; @import url(b.css);',
      '<!-- @import "a.css"; --> <!-- @import url(b.css); -->',
      '/* first */ @import "a.css";\n@charset "x"; @import url(b.css);',
      '@supports-condition --x { (display: grid) } @import "a.css"; @import url(b.css);',
      // A malformed import is dropped, and leaves the next one in place.
      '@import "a.css"; @import foo; @import "x.css" { } @import "y.css" }; @import url(b.css);',
      String.raw`@IMPORT "a.css"; @\69mport url(b.css);`,
    ])
      assert.deepEqual(imported(css), ["a.css", "b.css"], JSON.stringify(css));
  });

  it("reads HTML comment markers as single tokens", () => {
    const kinds = (css: string) => cssTokens(css).map((t) => [t.kind, css.slice(t.start, t.end)]);
    assert.deepEqual(kinds("<!--url(x)-->"), [
      ["cdo", "<!--"],
      ["url", "url(x)"],
      ["cdc", "-->"],
    ]);
    assert.deepEqual(kinds("a--> --->"), [
      ["name", "a--"],
      ["delim", ">"],
      ["space", " "],
      ["name", "---"],
      ["delim", ">"],
    ]);
  });
});

describe("import conditions (#144, #151)", () => {
  const conditions = (css: string) => cssImports(`@import "a.css"${css};`)[0].conditions;
  const none = { layer: null, supports: null, media: null };

  it("reads a media query list, which @media takes as it is, by its tokens", () => {
    for (const css of ["", " ", " /**/ ", "\n/* layer */"])
      assert.deepEqual(conditions(css), none, JSON.stringify(css));
    for (const [css, media] of [
      [" screen", "screen"],
      [
        " print, screen and (min-width: calc(10px + 1em))",
        "print, screen and (min-width: calc(10px + 1em))",
      ],
      [" screen /* layer( supports( */", "screen /* layer( supports( */"],
      [' "layer("', '"layer("'],
      [" screen layer", "screen layer"],
      [" (supports(x))", "(supports(x))"],
      // Spaces before it go, comments stay, and its end is as written.
      ["\n /**/ screen\\ ", "/**/ screen\\ "],
    ])
      assert.deepEqual(conditions(css), { ...none, media }, JSON.stringify(css));
  });

  it("reads a layer, support conditions, and a media query list, in that order", () => {
    for (const [css, read] of [
      [" layer", { layer: "" }],
      [" /**/ layer", { layer: "" }],
      [" LAYER screen", { layer: "", media: "screen" }],
      [String.raw` \6c ayer`, { layer: "" }],
      // A comment between `layer` and `(` makes `layer` a keyword, and `(x)` a media query.
      [" layer/**/(x)", { layer: "", media: "/**/(x)" }],
      [" layer(base)", { layer: "base" }],
      [" Layer( base.x--y.-z )", { layer: "base.x--y.-z" }],
      [" layer(/**/a/**/)", { layer: "a" }],
      [String.raw` layer(\31 a.b\.c)`, { layer: String.raw`\31 a.b\.c` }],
      [" layer(initial)", { layer: "initial" }],
      // Comments beside a dot, which Chromium 114 and 150 read as nothing there.
      [" layer(a/**/./**/b)", { layer: "a.b" }],
      [" supports(display: grid)", { supports: "display: grid" }],
      [" SUPPORTS( display: grid )", { supports: " display: grid " }],
      [
        " supports(not (display: grid))screen",
        { supports: "not (display: grid)", media: "screen" },
      ],
      [
        " layer(a) supports((display: grid) and (gap: 1px)) print",
        { layer: "a", supports: "(display: grid) and (gap: 1px)", media: "print" },
      ],
      [" layer supports(a: b)", { layer: "", supports: "a: b" }],
      [
        " layer(a)supports(b:c)(min-width: 1px)",
        { layer: "a", supports: "b:c", media: "(min-width: 1px)" },
      ],
    ] as const)
      assert.deepEqual(conditions(css), { ...none, ...read }, JSON.stringify(css));
  });

  it("finds no block form for conditions that Chromium does not read as these", () => {
    for (const css of [
      " scope",
      " scope(.card) screen",
      " layer(a) scope(.card)",
      // A function in a media query is not read, so the import stays one for the browser.
      " screen, unknown(x)",
      // Chromium 114 and 150 read these as part of a media query list, which never matches.
      " layer()",
      " layer( )",
      " layer(1a)",
      " layer(-1a)",
      " layer(a .b)",
      " layer(a. b)",
      " layer(a.)",
      " layer(.a)",
      " layer(a, b)",
      " layer(a b)",
      " layer(#a)",
      " layer(a) layer(b)",
      " supports(a: b) layer(a)",
      " supports(a: b) supports(c: d)",
      // Chromium 150 drops an import whose support conditions are empty.
      " supports()",
      " supports( /**/ )",
      " layer(a/**/ .b)",
    ])
      assert.equal(conditions(css), null, JSON.stringify(css));
  });
});

describe("what a stylesheet's text keeps later imports from (#152)", () => {
  const stop = (css: string) => importStop(cssTokens(css), 0, css.length);

  it("tells text that imports may follow from text that keeps them from counting", () => {
    for (const css of ["", " /* a */ <!-- -->"])
      assert.equal(stop(css), "blank", JSON.stringify(css));
    for (const css of [
      '@charset "utf-8";',
      "@supports-condition --x { (a: b) }",
      " /**/ @charset 'x';",
    ])
      assert.equal(stop(css), "none", JSON.stringify(css));
    for (const css of ["@layer a;", "@layer a, b; @charset 'x';"])
      assert.equal(stop(css), "after-import", JSON.stringify(css));
    for (const css of [
      "a {}",
      "@layer a {}",
      "@layer a; b {}",
      "@media print {}",
      "@namespace x url(y);",
      "@unknown;",
    ])
      assert.equal(stop(css), "all", JSON.stringify(css));
  });

  it("reads only the range it is given", () => {
    const css = '@layer a; @import "x.css"; b {}';
    const tokens = cssTokens(css);
    const first = cssImports(css, tokens)[0];
    assert.equal(importStop(tokens, 0, first.start), "after-import");
    assert.equal(importStop(tokens, first.end, css.length), "all");
    assert.equal(importStop(tokens, first.start, first.end), "none");
    assert.equal(importStop(tokens, first.end, first.end + 1), "blank");
  });
});

describe("the end of a stylesheet (#139)", () => {
  it("closes what a stylesheet leaves open, as its end does", () => {
    for (const [css, closers] of [
      ["a { color: red }", ""],
      ["a {} /* done */ <!-- -->", ""],
      ["", ""],
      ['"', '"{}'],
      // In a string, a "\" at the end stands for nothing, as before a newline.
      ["'a\\", "\n'{}"],
      ["/*", "*/"],
      ["a { /* \\", "*/}"],
      ["a { b: url(", ")}"],
      ["a { b: url(x\\", "\ufffd)}"],
      ['a { b: url(x"y', ")}"],
      ['a { b: url("x', '")}'],
      ["a {", "}"],
      ["@media print { a { b: (c [d", "])}}"],
      ["a, b", "{}"],
      ["a:is(b", "){}"],
      ["@media screen", ";"],
      ["@import 'x.css'", ";"],
      ["a { b: c\\", "\ufffd}"],
      ["\\", "\ufffd{}"],
      ["a { b: c\\\\", "}"],
      ["a{}-", "{}"],
      ["a{}<!-", "{}"],
      // "@" starts an at-rule only before an identifier; "@1" starts a qualified rule.
      ["@1", "{}"],
      ["a{} @1;", "{}"],
      ["@-", "{}"],
      ["@-x", ";"],
      ["@--", ";"],
    ])
      assert.equal(cssEnd(css, cssTokens(css)).closers, closers, JSON.stringify(css));
  });

  it("reads '@' as an at-keyword only before an identifier", () => {
    const kinds = (css: string) => cssTokens(css).map((token) => token.kind);
    assert.deepEqual(kinds("@1"), ["delim", "name"]);
    assert.deepEqual(kinds("@-1"), ["delim", "name"]);
    for (const css of ["@-x", "@--x", "@\\31", "@x"])
      assert.deepEqual(kinds(css), ["at-keyword"], css);
  });

  it("leaves nothing open once closed", () => {
    for (const css of [
      '"',
      "/*",
      "a { b: url(x\\",
      "@media print { a { b: (c",
      "x",
      "a { b: 'c\\",
    ]) {
      const closed = css + cssEnd(css, cssTokens(css)).closers;
      const tokens = cssTokens(closed);
      assert.ok(!tokens.some((token) => token.open), JSON.stringify(closed));
      assert.equal(cssEnd(closed, tokens).closers, "", JSON.stringify(closed));
    }
  });

  it("finds a } outside any block", () => {
    for (const [css, stray] of [
      ["a { b: c } }", true],
      ["} a {}", true],
      ['@import "x" };', true],
      ["a { b: (}) }", false],
      ["a { } b { [}] }", false],
      ['a { content: "}" } /* } */', false],
    ] as const)
      assert.equal(cssEnd(css, cssTokens(css)).strayCloser, stray, css);
  });

  it("finds the <!-- and --> that CSS discards between top-level rules (#152)", () => {
    const markers = (css: string) =>
      cssEnd(css, cssTokens(css)).markers.map(({ start, end }) => css.slice(start, end));
    assert.deepEqual(markers("<!-- a {} --> <!--@import 'x';-->"), ["<!--", "-->", "<!--", "-->"]);
    // In a rule, they are tokens like any other.
    for (const css of [
      "a <!-- {}",
      "a { <!-- b {} --> }",
      "@media print { <!-- }",
      "a--> {}",
      '"<!--"',
    ])
      assert.deepEqual(markers(css), [], JSON.stringify(css));
  });
});

describe("the end of a style attribute (#194)", () => {
  it("closes what a list of declarations leaves open, with no rule to end", () => {
    for (const [css, closers] of [
      ["color: red", ""],
      ["color: red;", ""],
      ["", ""],
      ['b: image-set("a.png', '")'],
      ['b: image-set("a.png" 1x', ")"],
      ['b: url("a.png', '")'],
      ["b: url('a.png", "')"],
      ["b: url(a.png", ")"],
      ["b: url(a.png\\", "\ufffd)"],
      // In a string, a "\" at the end stands for nothing, as before a newline.
      ['b: "a\\', '\n"'],
      ["b: c\\", "\ufffd"],
      ["b: c /* d", "*/"],
      ["b: f(g [h", "])"],
      ["--x: { a: (b", ")}"],
      // A closer that matches no open block closes nothing.
      ["b: c }", ""],
    ])
      assert.equal(cssDeclarationsEnd(css, cssTokens(css)), closers, JSON.stringify(css));
  });

  it("makes whole the references that the end leaves open", () => {
    for (const [css, open, closed] of [
      ['b: image-set("a.png', [], ["a.png"]],
      ['b: url("a.png', [], ["a.png"]],
      ["b: url(a.png", [], ["a.png"]],
      [`b: image-set('a.png' 1x, "b.png`, ["a.png"], ["a.png", "b.png"]],
      ["b: url(a.png) /* url(c.png)", ["a.png"], ["a.png"]],
    ] as const) {
      const values = (text: string) => cssReferences(cssTokens(text)).map(({ value }) => value);
      assert.deepEqual(
        { open: values(css), closed: values(css + cssDeclarationsEnd(css, cssTokens(css))) },
        { open, closed },
        css,
      );
    }
  });
});

describe("the tokens that name resources (#179)", () => {
  /** The text of each token that names a resource, and what it names. */
  const references = (css: string) =>
    cssReferences(cssTokens(css)).map((token) => [css.slice(token.start, token.end), token.value]);

  it("finds URL tokens and the strings directly in image-set() and -webkit-image-set()", () => {
    assert.deepEqual(
      references(
        'a { b: url(a.png); c: image-set("b.png" 1x, url(c.png) 2x, \'d.png\' 3x); d: -webkit-image-set("e.png" 1x) }',
      ),
      [
        ["url(a.png)", "a.png"],
        ['"b.png"', "b.png"],
        ["url(c.png)", "c.png"],
        ["'d.png'", "d.png"],
        ['"e.png"', "e.png"],
      ],
    );
    // CSS compares function names ASCII case-insensitively, after their escapes.
    for (const name of ["IMAGE-SET", "Image-Set", "-WebKit-Image-Set", String.raw`im\61ge-set`]) {
      assert.deepEqual(references(`a { b: ${name}("x.png" 1x) }`), [['"x.png"', "x.png"]], name);
    }
    assert.deepEqual(references(String.raw`a { b: image-set("a\22 b.png") }`), [
      [String.raw`"a\22 b.png"`, 'a"b.png'],
    ]);
    // Wherever a value can have one, also in a fallback of var().
    assert.deepEqual(references('a { --x: var(--y, image-set("v.png" 1x)) }'), [
      ['"v.png"', "v.png"],
    ]);
  });

  it("finds no other string", () => {
    for (const css of [
      // Bare strings, also those that look like files.
      'a::after { content: "a.png" } @font-face { src: "b.woff" }',
      // Strings in other functions: a type, a font format, a font's name.
      'a { b: image-set(url(a.png) type("image/png") 1x) }',
      '@font-face { src: url(a.woff2) format("woff2"), local("Font") }',
      // Functions that Chromium does not support, or a block that a name before a space starts.
      'a { b: image("a.png"); c: src("b.png"); d: cross-fade("c.png", "d.png"); e: image-set ("e.png") }',
      // After the function's ")", and in a block inside it.
      'a { b: image-set(url(a.png) 1x) "b.png"; c: image-set(("c.png") [ "d.png" ] {"e.png"}) }',
      // An at-keyword or a hash of that name is no function, nor is a name
      // before a block other than "(", as in the selectors of a custom element.
      '@image-set("a.png"); #image-set("b.png") {}',
      'image-set{content:"a.png"} image-set[title="b.png"] {}',
      // A string that the end of the text left open, as a quoted url( there.
      'a { b: image-set("a.png',
    ])
      assert.deepEqual(
        references(css).filter(([text]) => !text.startsWith("url(")),
        [],
        css,
      );
  });

  it("follows the blocks as CSS nests them, with a closer that does not match left inside", () => {
    // The "}" and "]" are part of the function, which only ")" ends.
    assert.deepEqual(references('a { b: image-set(] "x.png" } "y.png") "z.png" }'), [
      ['"x.png"', "x.png"],
      ['"y.png"', "y.png"],
    ]);
    // A function inside a block inside image-set() takes its own strings.
    assert.deepEqual(references('a { b: image-set(-webkit-image-set("x.png") "y.png") }'), [
      ['"x.png"', "x.png"],
      ['"y.png"', "y.png"],
    ]);
  });
});
