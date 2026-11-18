import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./support/dom";
import {
  preparePage,
  SHADOW_ROOT_MARK,
  STYLESHEET_PAGE_LIMIT,
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
   * copy takes in. Each import that preparation looks at asks whether its
   * file exists; past twice as many as the limits allow, the context fails
   * the preparation, so that a missing limit fails the test quickly rather
   * than run for hours.
   */
  async function prepareFanOut(rules: string) {
    const reads: string[] = [];
    let looked = 0;
    const most = 2 * FAN * (STYLESHEET_PAGE_LIMIT + 1);
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
    const text = doc.querySelector("style")!.textContent;
    return { reads, text, copies: text.split("{ color: red }\n").length - 1 };
  }

  it("takes in as many small stylesheets as the limit allows, reading each file once", async () => {
    const { reads, text, copies } = await prepareFanOut("");
    assert.deepEqual(
      reads,
      Array.from({ length: 8 }, (_, i) => `Saved/${i}.css`),
    );
    assert.equal(copies, STYLESHEET_PAGE_LIMIT);
    // The rest stay imports, which Obsidian's policy keeps from loading.
    assert.equal(
      text.split('@import url("').length - 1,
      FAN * STYLESHEET_PAGE_LIMIT - (STYLESHEET_PAGE_LIMIT - 1),
    );
    // Depth first: the first chain is whole, eight files deep.
    assert.ok(text.indexOf(".level7") < text.indexOf(".level1 "));
  });

  it("takes in as much of larger stylesheets' text as the limit allows", async () => {
    const rule = 'a.card:hover { color: blue; content: "example"; } /* ordinary comment */\n';
    const rules = rule.repeat(Math.ceil(20_000 / rule.length));
    const { text, copies } = await prepareFanOut(rules);
    // Every level's file has the same length, so as many fit as the limit holds.
    const fit = Math.floor(STYLESHEET_TEXT_LIMIT / sheet(0, rules).length);
    assert.ok(fit < STYLESHEET_PAGE_LIMIT);
    assert.equal(copies, fit);
    // The imports left, made absolute, add a little to the text taken in.
    assert.ok(text.length < STYLESHEET_TEXT_LIMIT + 1_000_000, `${text.length} characters`);
  });
});
