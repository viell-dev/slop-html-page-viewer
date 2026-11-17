import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import "./support/dom";
import { placeTop, scrollPlace } from "../src/main";

/**
 * A page laid out as its elements' `data-top` and `data-height` say, in page
 * pixels, scrolled down by `scrollY`. jsdom lays nothing out itself, and
 * Obsidian's frames are measured in Obsidian (move.e2e.ts).
 */
function laidOut(body: string, scrollY: number): Document {
  const { window } = new JSDOM(`<!doctype html><html><body>${body}</body></html>`);
  Object.defineProperty(window, "scrollY", { configurable: true, value: scrollY });
  Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
  Object.defineProperty(window.Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Element) {
      const top = Number(this.getAttribute("data-top") ?? 0) - scrollY;
      const height = Number(this.getAttribute("data-height") ?? 0);
      return { top, bottom: top + height, height, width: height > 0 ? 100 : 0 };
    },
  });
  return window.document;
}

const PAGE = `<section data-top="0" data-height="900"><p data-top="0" data-height="900">One</p></section>
<section data-top="900" data-height="1000">
  <h2 data-top="900" data-height="100">Two</h2>
  <p data-top="1000" data-height="400">Two's first</p>
  <p data-top="1400" data-height="500">Two's second</p>
</section>`;

describe("a page's place across a move to another tab group or window (#126)", () => {
  it("is the innermost element at the window's top, and how far into it the top is", () => {
    assert.deepEqual(scrollPlace(laidOut(PAGE, 1100)), { path: [1, 1], into: 0.25, left: 0 });
  });

  it("passes over fixed and sticky elements, which are where the window is", () => {
    const doc = laidOut(
      `<header style="position: fixed" data-top="1100" data-height="50">Header</header>
<nav style="position: sticky" data-top="1100" data-height="50">Menu</nav>${PAGE}`,
      1100,
    );
    assert.deepEqual(scrollPlace(doc), { path: [3, 1], into: 0.25, left: 0 });
  });

  it("is in the element whose content holds the top, between its children", () => {
    // The top is in the space between the heading and the paragraph after it.
    const doc = laidOut(
      PAGE.replace('data-top="1000" data-height="400"', 'data-top="1100" data-height="300"'),
      1050,
    );
    assert.deepEqual(scrollPlace(doc), { path: [1], into: 0.15, left: 0 });
  });

  it("is nothing at the page's top", () => {
    assert.equal(scrollPlace(laidOut(PAGE, 0)), null);
  });

  it("is as far into the same element in a page laid out narrower", () => {
    const place = scrollPlace(laidOut(PAGE, 1100));
    assert.ok(place);
    // The same elements, wrapped onto more lines: twice as tall.
    const narrower = PAGE.replace(
      /data-(top|height)="(\d+)"/g,
      (_, name: string, value: string) => `data-${name}="${Number(value) * 2}"`,
    );
    assert.equal(placeTop(laidOut(narrower, 0), place), 2200);
    assert.equal(placeTop(laidOut(narrower, 300), place), 2200);
  });

  it("falls back to the deepest parent that the other document has", () => {
    assert.equal(
      placeTop(laidOut(PAGE, 0), { path: [1, 7, 2], into: 0.5, left: 0 }),
      900 + 0.5 * 1000,
    );
  });
});
