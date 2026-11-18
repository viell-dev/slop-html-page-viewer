import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cssEnd, cssImports, cssTokens } from "../src/css";

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
    assert.deepEqual(cssImports(tokens), []);
    assert.equal(tokens.map((t) => css.slice(t.start, t.end)).join(""), css);
    assert.equal(tokens.find((t) => t.value === "url")?.kind, "name");
  }
});

it("distinguishes bad strings, EOF strings and newline recovery", () => {
  assert.deepEqual(cssImports(cssTokens('@import "ghost.css?\\"\nscreen;')), []);
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
      assert.deepEqual(cssImports(tokens), []);
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
    assert.deepEqual(cssImports(cssTokens(css)), []);
  const css = '@import "real.css" url(; x) screen;';
  assert.equal(cssImports(cssTokens(css))[0].end, css.length);
  assert.deepEqual(
    cssImports(cssTokens('@import "real.css" ); @import "ghost.css" (}); a { }')).map(
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
  const imported = (css: string) => cssImports(cssTokens(css)).map((rule) => rule.reference);

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

describe("import conditions (#144)", () => {
  const conditions = (css: string) => cssImports(cssTokens(`@import "a.css"${css};`))[0].conditions;

  it("tells a media query list from conditions that @media cannot take, by their tokens", () => {
    for (const css of ["", " ", " /**/ ", "\n/* layer */"]) assert.equal(conditions(css), "none");
    for (const css of [
      " screen",
      " print, screen and (min-width: calc(10px + 1em))",
      " screen /* layer( supports( */",
      ' "layer("',
      " screen layer",
      " (supports(x))",
    ])
      assert.equal(conditions(css), "media", JSON.stringify(css));
    for (const css of [
      " layer",
      " /**/ layer",
      " LAYER screen",
      String.raw` \6c ayer`,
      " layer/**/(x)",
      " layer(base)",
      " scope",
      " scope(.card) screen",
      " supports(display: grid)",
      " layer(a) supports((display: grid) and (gap: 1px)) print",
      // A function in a media query is not read, so the import stays one for the browser.
      " screen, unknown(x)",
    ])
      assert.equal(conditions(css), "other", JSON.stringify(css));
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
});
