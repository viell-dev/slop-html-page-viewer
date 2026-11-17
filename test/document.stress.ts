import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./support/dom";
import { preparePage, SHADOW_ROOT_MARK } from "../src/document";

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
