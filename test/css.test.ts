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

it("uses delimiters only for nesting and prelude boundaries", () => {
  for (const css of ['a { b: url(} x); @import "ghost.css"; }', '} a { @import "ghost.css"; }'])
    assert.deepEqual(cssImports(cssTokens(css)), []);
  const css = '@import "real.css" url(; x) screen;';
  assert.equal(cssImports(cssTokens(css))[0].end, css.length);
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
