import assert from "node:assert/strict";
import { it } from "node:test";
import { cssTokens, cssImports } from "../src/css";

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
  assert.deepEqual(cssTokens('"EOF'), [{ start: 0, end: 4, kind: "string", value: "EOF" }]);
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
