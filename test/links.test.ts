import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import "./support/dom";
import { type LinkActions, linkTarget, paneFor, type PaneChoice, watchLinks } from "../src/links";
import { Harness, loadFrame, settle } from "./support/harness";
import { WorkspaceLeaf } from "./support/obsidian";

const VAULT = "app://vault-id/home/user/Vault/";
const PAGE = `${VAULT}Saved/Example%20article.html`;

describe("linkTarget", () => {
  const cases: [string, ReturnType<typeof linkTarget>][] = [
    [`${PAGE}#details`, { kind: "fragment", id: "details" }],
    [`${PAGE}?1700000000#Caf%C3%A9`, { kind: "fragment", id: "Café" }],
    [`${PAGE}#`, { kind: "fragment", id: "" }],
    [`${VAULT}Saved/Other%20page.html`, { kind: "vault", path: "Saved/Other page.html" }],
    [`${VAULT}Saved/Other%20page.html#part`, { kind: "vault", path: "Saved/Other page.html" }],
    [`${VAULT}Notes/Topic.md`, { kind: "vault", path: "Notes/Topic.md" }],
    [`${VAULT}Mirror/`, { kind: "vault", path: "Mirror/" }],
    [VAULT, { kind: "vault", path: "" }],
    [
      "app://vault-id/home/user/secret.html",
      { kind: "outside", url: "app://vault-id/home/user/secret.html" },
    ],
    ["https://example.com/article", { kind: "external", url: "https://example.com/article" }],
    ["mailto:someone@example.com", { kind: "external", url: "mailto:someone@example.com" }],
    ["obsidian://open?vault=Other", { kind: "external", url: "obsidian://open?vault=Other" }],
    ["app://another-id/file.html", { kind: "external", url: "app://another-id/file.html" }],
    ["javascript:alert(1)", { kind: "none" }],
    ["not a url", { kind: "none" }],
  ];
  for (const [href, expected] of cases) {
    it(`classifies ${href}`, () => {
      assert.deepEqual(linkTarget(href, PAGE, VAULT), expected);
    });
  }
});

describe("paneFor", () => {
  const click = (init: MouseEventInit): MouseEvent => new window.MouseEvent("click", init);

  it("opens in the same tab without a modifier, and in a new one with Ctrl or a middle click", () => {
    assert.equal(paneFor(click({}), false), false);
    assert.equal(paneFor(click({ ctrlKey: true }), false), "tab");
    assert.equal(paneFor(click({ button: 1 }), false), "tab");
  });

  it("uses Cmd on macOS, and Alt and Shift for a split or a window", () => {
    assert.equal(paneFor(click({ ctrlKey: true }), true), false);
    assert.equal(paneFor(click({ metaKey: true }), true), "tab");
    assert.equal(paneFor(click({ ctrlKey: true, altKey: true }), false), "split");
    assert.equal(paneFor(click({ ctrlKey: true, altKey: true, shiftKey: true }), false), "window");
  });
});

describe("watchLinks", () => {
  const BODY = `
    <a id="external" href="https://example.com/article">site</a>
    <a id="other" href="Other%20page.html"><span id="inner">another page</span></a>
    <a id="note" href="../Notes/Topic.md">note</a>
    <a id="escape" href="../../../secret.html">outside</a>
    <a id="fragment" href="#details">details</a>
    <a id="script" href="javascript:void 0">script</a>
    <map name="m"><area id="area" href="Other%20page.html"></map>
    <h2 id="details">Details</h2>
    <p id="plain">text</p>`;

  function setUp(extra = ""): {
    doc: Document;
    calls: string[];
    scrolled: string[];
    click: (id: string, init?: MouseEventInit) => boolean;
  } {
    const doc = new DOMParser().parseFromString(
      `<base href="${PAGE}">${BODY}${extra}`,
      "text/html",
    );
    const calls: string[] = [];
    const scrolled: string[] = [];
    Object.defineProperty(window.Element.prototype, "scrollIntoView", {
      configurable: true,
      value(this: Element) {
        scrolled.push(this.id || this.localName);
      },
    });
    const actions: LinkActions = {
      openVault: (path: string, pane: PaneChoice, reference: string) =>
        calls.push(`vault ${path} ${String(pane)} ${reference}`),
      openExternal: (url: string) => calls.push(`external ${url}`),
      refuse: (url: string) => calls.push(`refuse ${url}`),
    };
    watchLinks(doc, PAGE, VAULT, false, actions);
    const click = (id: string, init: MouseEventInit = {}): boolean => {
      // Browsers fire click for the main button only, and auxclick for the others.
      const event = new window.MouseEvent((init.button ?? 0) === 0 ? "click" : "auxclick", {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      doc.getElementById(id)?.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return { doc, calls, scrolled, click };
  }

  it("opens web links outside Obsidian and keeps the frame on the page", () => {
    const { calls, click } = setUp();
    assert.equal(click("external"), true);
    assert.deepEqual(calls, ["external https://example.com/article"]);
  });

  it("opens vault files in Obsidian, in a new tab with a modifier or a middle click", () => {
    const { calls, click } = setUp();
    assert.equal(click("inner"), true, "a click inside the link counts");
    click("note", { ctrlKey: true });
    click("area", { button: 1 });
    assert.deepEqual(calls, [
      "vault Saved/Other page.html false Other%20page.html",
      "vault Notes/Topic.md tab ../Notes/Topic.md",
      "vault Saved/Other page.html tab Other%20page.html",
    ]);
  });

  it("opens the reference that HTML strips of its ASCII whitespace, keeping other spaces (#199)", () => {
    const { calls, click } = setUp(
      `<a id="ascii" href="&#10; Other%20page.html&#9;&#12;">ascii</a><a id="nbsp" href="&nbsp;Other%20page.html">nbsp</a>`,
    );
    click("ascii");
    click("nbsp");
    assert.deepEqual(calls, [
      "vault Saved/Other page.html false Other%20page.html",
      "vault Saved/ Other page.html false  Other%20page.html",
    ]);
  });

  it("refuses links outside the vault", () => {
    const { calls, click } = setUp();
    assert.equal(click("escape"), true);
    assert.deepEqual(calls, ["refuse app://vault-id/home/secret.html"]);
  });

  it("scrolls to a part of the page", () => {
    const { calls, scrolled, click } = setUp();
    assert.equal(click("fragment"), true);
    assert.deepEqual(scrolled, ["details"]);
    assert.deepEqual(calls, []);
  });

  it("resolves SVG links with the effective base and preserves their reference", () => {
    const { doc, calls, click, scrolled } = setUp(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <a id="svg" href="Other%20page.html"><text id="svg-inner">other</text></a>
      <a id="legacy" xlink:href="../Notes/Topic.md"/>
      <a id="svg-web" href="https://example.com/"/>
      <a id="svg-out" href="../../../secret.html"/>
      <a id="svg-fragment" href="#details"/>
      <a id="precedence" href="Other%20page.html" xlink:href="wrong"/>
    </svg>`,
    );
    click("svg-inner", { ctrlKey: true });
    click("legacy", { button: 1 });
    click("svg-web");
    click("svg-out");
    click("svg-fragment");
    click("precedence");
    assert.deepEqual(calls, [
      "vault Saved/Other page.html tab Other%20page.html",
      "vault Notes/Topic.md tab ../Notes/Topic.md",
      "external https://example.com/",
      "refuse app://vault-id/home/secret.html",
      "vault Saved/Other page.html false Other%20page.html",
    ]);
    assert.deepEqual(scrolled, ["details"]);
    doc.querySelector("base")!.setAttribute("href", "https://example.com/base/");
    click("svg");
    assert.equal(calls.at(-1), "external https://example.com/base/Other%20page.html");
  });

  it("scrolls empty fragments and resolves real targets before the top fallback", () => {
    const { doc, calls, click, scrolled } = setUp(
      `<a id="empty" href="#">top</a><a id="top-link" href="#top">top</a><h2 id="top">Top target</h2><a id="encoded" href="#Caf%C3%A9">cafe</a><h2 id="Café"></h2>`,
    );
    click("empty");
    click("top-link");
    click("encoded");
    doc.getElementById("top")!.remove();
    const named = doc.createElement("a");
    named.setAttribute("name", "top");
    doc.body.append(named);
    click("top-link");
    doc.querySelector('[name="top"]')!.remove();
    click("top-link");
    assert.deepEqual(scrolled, ["html", "top", "Café", "a", "html"]);
    assert.deepEqual(calls, []);
  });

  it("handles outer links when nested HTML or SVG anchors have no reference", () => {
    const { calls, click } = setUp(
      `<a href="https://example.com/"><table><tr><td><a id="nested" name="x">text</a></td></tr></table></a><a href="Other%20page.html"><svg><a><text id="svg-nested">text</text></a></svg></a>`,
    );
    assert.equal(click("nested"), true);
    assert.equal(click("svg-nested"), true);
    assert.deepEqual(calls, [
      "external https://example.com/",
      "vault Saved/Other page.html false Other%20page.html",
    ]);
  });

  it("ignores named form fields and tries raw fragments before decoded fragments", () => {
    const { click, scrolled } = setUp(
      `<input name="top"><a id="top-link" href="#top">top</a><a id="raw" href="#a%20b">raw</a><h2 id="a%20b"></h2><h2 id="a b"></h2><a id="named" href="#section">section</a><input name="section"><a name="section" id="anchor"></a>`,
    );
    click("top-link");
    click("raw");
    click("named");
    assert.deepEqual(scrolled, ["html", "a%20b", "anchor"]);
  });

  it("prevents an unparsable reference without taking an action", () => {
    const { calls, click } = setUp('<a id="bad" href="http://[bad">bad</a>');
    assert.equal(click("bad"), true);
    assert.deepEqual(calls, []);
  });

  it("follows links in open shadow roots, nested ones, and around slotted content", () => {
    const { doc, calls } = setUp(
      `<div id="host"></div><div id="slots"><b id="slotted">x</b></div>`,
    );
    const outer = doc.getElementById("host")!.attachShadow({ mode: "open" });
    outer.innerHTML = `<a href="Other%20page.html"><span id="in-shadow">other</span></a><p id="inner-host"></p>`;
    const inner = outer.getElementById("inner-host")!.attachShadow({ mode: "open" });
    inner.innerHTML = `<a href="https://example.com/nested"><i>web</i></a>`;
    doc.getElementById("slots")!.attachShadow({ mode: "open" }).innerHTML =
      `<a href="../Notes/Topic.md"><slot></slot></a>`;
    // A click from within a shadow root reaches the document as its host's.
    const click = (target: Element, init: MouseEventInit = {}): boolean => {
      const event = new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
        ...init,
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    assert.equal(click(outer.getElementById("in-shadow")!), true);
    assert.equal(click(inner.querySelector("i")!, { ctrlKey: true }), true);
    assert.equal(click(doc.getElementById("slotted")!), true);
    assert.deepEqual(calls, [
      "vault Saved/Other page.html false Other%20page.html",
      "external https://example.com/nested",
      "vault Notes/Topic.md false ../Notes/Topic.md",
    ]);
  });

  it("cancels the frame's navigations, as one from a link in a closed shadow root", () => {
    // The Navigation API, which jsdom lacks, as the frame's window has it.
    const frame = new JSDOM(`<!doctype html><base href="${PAGE}"><div id="host"></div>`).window;
    const navigation = new frame.EventTarget();
    Object.defineProperty(frame, "navigation", { value: navigation });
    const calls: string[] = [];
    watchLinks(frame.document, PAGE, VAULT, false, {
      openVault: (path) => calls.push(`vault ${path}`),
      openExternal: (url) => calls.push(`external ${url}`),
      refuse: (url) => calls.push(`refuse ${url}`),
    });
    const root = frame.document.getElementById("host")!.attachShadow({ mode: "closed" });
    root.innerHTML = `<a href="Other%20page.html"><span>other</span></a>`;
    const click = new frame.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    root.querySelector("span")!.dispatchEvent(click);
    assert.equal(click.defaultPrevented, false, "no event path shows a closed root's insides");
    const navigate = new frame.Event("navigate", { cancelable: true });
    navigation.dispatchEvent(navigate);
    assert.equal(navigate.defaultPrevented, true);
    assert.deepEqual(calls, []);
  });

  it("does nothing for javascript: links, other clicks, and other buttons", () => {
    const { calls, click } = setUp();
    assert.equal(click("script"), true, "the frame does not follow it either");
    assert.equal(click("plain"), false);
    assert.equal(click("external", { button: 2 }), false);
    assert.deepEqual(calls, []);
  });
});

describe("the tab that a vault link opens in", () => {
  const ARTICLE = `<!doctype html><title>Article</title>
<p><a id="other" href="Other%20page.html">another page</a>
<a id="by-name" href="Topic.md">a note named by its file name</a></p>`;

  /**
   * A page in a view whose tab is not Obsidian's active one, as when another
   * tab group or window is, and a click on one of its links.
   */
  async function setUp(): Promise<{
    harness: Harness;
    own: WorkspaceLeaf;
    active: WorkspaceLeaf;
    click: (id: string, init?: MouseEventInit) => void;
  }> {
    const harness = await Harness.load();
    const own = new WorkspaceLeaf(harness.app);
    const view = harness.newView(own);
    harness.app.files.set("Saved/Other page.html", "<p>Other page</p>");
    harness.app.files.set("Notes/Topic.md", "# Topic");
    harness.open(view, "Saved/Article.html", ARTICLE);
    const page = await loadFrame(view);
    const active = new WorkspaceLeaf(harness.app);
    harness.app.workspace.setActiveLeaf(active);
    const click = (id: string, init: MouseEventInit = {}): void => {
      const win = page.defaultView!;
      const event = new win.MouseEvent((init.button ?? 0) === 0 ? "click" : "auxclick", {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      page.getElementById(id)!.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    };
    return { harness, own, active, click };
  }

  it("is the view's own tab, not Obsidian's active one (#141)", async () => {
    const { harness, own, active, click } = await setUp();
    click("other");
    await settle();
    assert.deepEqual(own.openedFiles, ["Saved/Other page.html"]);
    assert.deepEqual(active.openedFiles, []);
    assert.deepEqual(harness.app.leaves, []);
    // The view changes only which tab is active, and leaves the focus where it is.
    assert.deepEqual(harness.app.activations.at(-1), { focus: false });
  });

  it("is the view's own tab for a file that the link names by name only (#141)", async () => {
    const { own, active, click } = await setUp();
    click("by-name");
    await settle();
    assert.deepEqual(own.openedFiles, ["Notes/Topic.md"]);
    assert.deepEqual(active.openedFiles, []);
  });

  it("is the tab that Obsidian chooses for a pinned tab, never the pinned view's own (#141)", async () => {
    const { own, active, click } = await setUp();
    own.pinned = true;
    click("other");
    await settle();
    assert.deepEqual(own.openedFiles, []);
    assert.deepEqual(active.openedFiles, ["Saved/Other page.html"]);
  });

  it("is a new tab, split, or window that Obsidian places from the view's own tab with a modifier (#141)", async () => {
    const { harness, own, active, click } = await setUp();
    click("other", { ctrlKey: true });
    click("other", { button: 1 });
    click("other", { ctrlKey: true, altKey: true });
    click("other", { ctrlKey: true, altKey: true, shiftKey: true });
    await settle();
    assert.deepEqual(
      harness.app.leaves.map((leaf) => [leaf.pane, leaf.openedFrom === own, leaf.openedFiles]),
      [
        ["tab", true, ["Saved/Other page.html"]],
        ["tab", true, ["Saved/Other page.html"]],
        ["split", true, ["Saved/Other page.html"]],
        ["window", true, ["Saved/Other page.html"]],
      ],
    );
    assert.deepEqual(own.openedFiles, []);
    assert.deepEqual(active.openedFiles, []);
  });
});
