// Scratch measurements for #147 and #148, not part of the suite: what
// Obsidian's Chromium does with the `type` of <style> and <link> elements and
// with a link's `disabled`, how a frame parses <noscript> with scripts off and
// on, and whether a refresh that only the frame's own parse creates navigates
// the frame. Each test records what it saw in measure-<version>.json among the
// run's results, and asserts nothing.
//
// Contexts:
// - "A": a frame built here, not by the plugin, with the view's scripts-off
//   sandbox (allow-same-origin) and the page written into its srcdoc, read
//   from Obsidian's window.
// - "B": the same with the scripts-on sandbox (allow-scripts), read inside.
// - "D": a test page that a server in this process serves over HTTP, in a
//   frame without a sandbox, with each sandbox, so that Obsidian's own policy,
//   which a srcdoc frame inherits and which allows only inline styles, does not
//   decide whether a link loads. The server records each request. (A vault page
//   in such a frame does not work: Obsidian refuses vault files to frames that
//   are not at its own origin, and on 1.5.3 refuses the page itself.)
// - "plugin": the plugin's view of the same page.

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { browser } from "@wdio/globals";
import { solidPng } from "../support/pixels.ts";
import {
  ACTIVE,
  clickToolbarButton,
  openInActiveTab,
  PLUGIN_ID,
  waitForPage,
} from "../support/viewer.ts";

/* eslint-disable @typescript-eslint/no-explicit-any -- scratch measurements */

const FRAME = `${ACTIVE} iframe.html-page-viewer__frame`;
const DIR = "Measure";
const GREEN = "rgb(0, 128, 0)";

const TYPES: readonly { label: string; value: string | null }[] = [
  { label: "absent", value: null },
  { label: "empty", value: "" },
  { label: "text/css", value: "text/css" },
  { label: "TEXT/CSS", value: "TEXT/CSS" },
  { label: "text/css; charset=utf-8", value: "text/css; charset=utf-8" },
  { label: '" text/css" (leading space)', value: " text/css" },
  { label: '"text/css " (trailing space)', value: "text/css " },
  { label: "text/x-scss", value: "text/x-scss" },
  { label: "text/css;charset=utf-8", value: "text/css;charset=utf-8" },
  { label: '" TEXT/CSS ; a=b"', value: " TEXT/CSS ; a=b" },
  { label: "text/css;", value: "text/css;" },
  { label: "text/plain", value: "text/plain" },
  { label: "text/css2", value: "text/css2" },
  { label: '" " (a space)', value: " " },
  { label: '";"', value: ";" },
  { label: "tab, text/css, line feed", value: "\ttext/css\n" },
];

function attribute(name: string, value: string | null): string {
  return value === null ? "" : ` ${name}="${value}"`;
}

/**
 * The <style> and <link> cases, each with a paragraph whose color shows
 * whether its rule applies. Each <style> also imports a file, whose paragraph
 * shows whether the import applies. `prefix` keeps the ids of inserted copies
 * apart.
 */
function cases147(prefix = "", query = ""): string {
  let html = "";
  TYPES.forEach(({ value }, i) => {
    html += `<style id="${prefix}st${i}"${attribute("type", value)}>@import "si${i}.css${query}"; .s${i} { color: ${GREEN} }</style>`;
    html += `<link id="${prefix}ln${i}" rel="stylesheet"${attribute("type", value)} href="l${i}.css${query}">`;
  });
  html += `<style id="${prefix}std" disabled>.sd { color: ${GREEN} }</style>`;
  html += `<link id="${prefix}lnd" rel="stylesheet" href="ld.css${query}" disabled>`;
  html += `<link id="${prefix}lndr" rel="stylesheet" href="ldr.css${query}" disabled>`;
  return html;
}

function probes147(): string {
  const names = [...TYPES.flatMap((_, i) => [`s${i}`, `si${i}`, `l${i}`]), "sd", "ld", "ldr"];
  return names.map((name) => `<p class="${name}">${name}</p>`).join("");
}

const RECORDER = `<script>
window.e2eEvents = [];
const e2eNote = (kind) => (event) => {
  const target = event.target;
  if (target && target.localName === "link")
    e2eEvents.push([kind, target.id, target.getRootNode() === document ? "page" : "shadow"]);
};
document.addEventListener("load", e2eNote("load"), true);
document.addEventListener("error", e2eNote("error"), true);
document.addEventListener("securitypolicyviolation", (event) =>
  e2eEvents.push(["csp", event.blockedURI, event.effectiveDirective]));
</script>`;

const SHADOW_RECORDER = `<script>
{
  const root = document.getElementById("host").shadowRoot;
  if (root) {
    root.addEventListener("load", e2eNote("load"), true);
    root.addEventListener("error", e2eNote("error"), true);
  }
}
</script>`;

/** A page with the cases in the document and in a declared open shadow root. */
function page147(base: string | null, scripts: boolean, queries = false): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Types</title>` +
    (base === null ? "" : `<base href="${base}">`) +
    (scripts ? RECORDER : "") +
    `</head><body>${cases147("", queries ? "?in=page" : "")}${probes147()}` +
    `<div id="host"><template shadowrootmode="open" shadowroot="open">${cases147("", queries ? "?in=shadow" : "")}${probes147()}</template></div>` +
    (scripts ? SHADOW_RECORDER : "") +
    `</body></html>`
  );
}

const PNG = solidPng(8, [46, 125, 50]).toString("base64");

const NOSCRIPT_BODY =
  `<p id="before">before</p>` +
  `<noscript><p id="ns-p">inside noscript</p><style>.ns-after { color: ${GREEN} } .ns-bg { background-image: url(nsbg.png) }</style>` +
  `<img id="ns-img" src="ns.png" width="8" height="8" alt="n"><link rel="stylesheet" href="nsl.css"></noscript>` +
  `<p class="ns-after">after</p><p class="ns-link">link</p><p class="ns-bg">bg</p>`;

function noscriptPage(base: string | null): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Noscript</title>` +
    (base === null ? "" : `<base href="${base}">`) +
    `<noscript><style>.hn-style { color: ${GREEN} }</style><img id="hn-img" src="ns.png" width="8" height="8" alt="h"></noscript>` +
    `</head><body>${NOSCRIPT_BODY}<p class="hn-style">head noscript style</p></body></html>`
  );
}

/** A page whose refresh only a second parse creates: the first makes it a <style>'s text. */
function reparseRefresh(base: string | null, delay: number): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reparse refresh</title>` +
    (base === null ? "" : `<base href="${base}">`) +
    `</head><body><p id="start">start</p>` +
    `<math><mtext><table><mglyph><style><meta http-equiv="refresh" content="${delay}; url=Refreshed.html"></style></mglyph></table></mtext></math>` +
    `</body></html>`
  );
}

/** The same through the issue's own form: the text ends the <math> and then has the refresh. */
function reparseRefreshBreakout(base: string | null, delay: number): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reparse refresh</title>` +
    (base === null ? "" : `<base href="${base}">`) +
    `</head><body><p id="start">start</p>` +
    `<math><mtext><table><mglyph><style>a::after { content: "</math><meta http-equiv=refresh content='${delay}; url=Refreshed.html'>" }</style></mglyph></table></mtext></math>` +
    `</body></html>`
  );
}

function directRefresh(base: string | null, delay: number): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Direct refresh</title>` +
    (base === null ? "" : `<base href="${base}">`) +
    `<meta http-equiv="refresh" content="${delay}; url=Refreshed.html">` +
    `</head><body><p id="start">start</p></body></html>`
  );
}

const results: Record<string, unknown> = {};

function outputDir(): string {
  const root = path.resolve(import.meta.dirname, "../../..");
  return process.env.E2E_OUTPUT_DIR?.trim() || path.join(root, "test-results", "e2e");
}

function record(key: string, value: unknown): void {
  results[key] = value;
  const file = path.join(outputDir(), `measure-${browser.getObsidianVersion()}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
}

async function attempt<T>(read: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await read();
  } catch (error) {
    return { error: (error instanceof Error ? error.message : String(error)).slice(0, 400) };
  }
}

/** Reads the cases in a document: in the frame that `selector` selects, or in the current one. */
function read147(selector: string | null, green: string) {
  const frame = selector === null ? null : document.querySelector<HTMLIFrameElement>(selector);
  const doc = frame === null ? document : frame.contentDocument!;
  const win = doc.defaultView!;
  const tree = (root: Document | ShadowRoot) => ({
    probes: Object.fromEntries(
      [...root.querySelectorAll("p[class]")].map((p) => [
        p.className,
        win.getComputedStyle(p).color === green,
      ]),
    ),
    elements: [...root.querySelectorAll("style, link")].map((element) => ({
      id: element.id,
      tag: element.localName,
      type: element.getAttribute("type"),
      disabled: element.hasAttribute("disabled"),
      sheet: (element as any).sheet != null,
      text:
        element.localName === "style"
          ? (element.textContent ?? "").slice(0, 120)
          : element.getAttribute("href"),
    })),
  });
  const host = doc.getElementById("host");
  return {
    url: doc.URL,
    page: tree(doc),
    shadow: host?.shadowRoot ? tree(host.shadowRoot) : null,
    events: (win as any).e2eEvents ?? null,
  };
}

/** Removes `disabled` from the links with id `lndr`, in the document and its shadow root. */
function enableLater(selector: string | null) {
  const frame = selector === null ? null : document.querySelector<HTMLIFrameElement>(selector);
  const doc = frame === null ? document : frame.contentDocument!;
  doc.getElementById("lndr")?.removeAttribute("disabled");
  doc.getElementById("host")?.shadowRoot?.getElementById("lndr")?.removeAttribute("disabled");
}

/** Adds a frame built here to Obsidian's window, and waits until it has loaded. */
async function addFrame(
  id: string,
  sandbox: string | null,
  source: { srcdoc: string } | { src: string },
): Promise<void> {
  await browser.execute(
    (id, sandbox, source) => {
      document.getElementById(id)?.remove();
      const frame = document.createElement("iframe");
      frame.id = id;
      if (sandbox !== null) frame.setAttribute("sandbox", sandbox);
      frame.style.cssText =
        "position: fixed; left: 0; top: 0; width: 500px; height: 400px; z-index: 10000; background: white;";
      frame.dataset.loads = "0";
      frame.addEventListener("load", () => {
        frame.dataset.loads = String(Number(frame.dataset.loads) + 1);
      });
      if ("srcdoc" in source) frame.srcdoc = source.srcdoc;
      else frame.src = source.src;
      document.body.append(frame);
    },
    id,
    sandbox,
    source,
  );
  await browser.waitUntil(
    async () => browser.execute((id) => document.getElementById(id)?.dataset.loads !== "0", id),
    { timeout: 15_000, timeoutMsg: `frame ${id} did not load` },
  );
  // A moment for stylesheets that load after the page.
  await browser.pause(1000);
}

async function removeFrames(): Promise<void> {
  await browser.execute(() => {
    for (const frame of document.querySelectorAll("iframe[id^='m-']")) frame.remove();
  });
}

/** Runs `read` inside the frame with id `id`, for frames that Obsidian's window cannot reach. */
async function inside<T>(id: string, read: () => Promise<T>): Promise<T | { error: string }> {
  return attempt(async () => {
    await browser.switchFrame(browser.$(`#${id}`));
    try {
      return await read();
    } finally {
      await browser.switchFrame(null);
    }
  });
}

/** Opens a fresh tab and closes the others, as links.e2e.ts does. */
async function freshTab(): Promise<void> {
  await browser.executeObsidian(({ app }) => {
    const fresh = app.workspace.getLeaf("tab");
    app.workspace.setActiveLeaf(fresh, { focus: true });
    const old: (typeof fresh)[] = [];
    app.workspace.iterateRootLeaves((leaf) => {
      if (leaf !== fresh) old.push(leaf);
    });
    for (const leaf of old) leaf.detach();
  });
}

async function setting(name: "scriptsOn" | "copyLocalFiles", on: boolean): Promise<void> {
  await browser.executeObsidian(
    ({ app }, id, name, on) => {
      const plugins = (app as unknown as { plugins: { plugins: Record<string, any> } }).plugins;
      plugins.plugins[id].settings[name] = on;
    },
    PLUGIN_ID,
    name,
    on,
  );
}

async function srcdoc(): Promise<string> {
  return browser.execute(
    (selector) => document.querySelector<HTMLIFrameElement>(selector)?.srcdoc ?? "",
    FRAME,
  );
}

let measureUrl = "";

describe("Measurements for #147 and #148", function () {
  before(async function () {
    const texts: Record<string, string> = {
      [`${DIR}/t147.html`]: page147(null, false),
      [`${DIR}/p147.html`]: page147(null, false),
      [`${DIR}/ld.css`]: `.ld { color: ${GREEN} }`,
      [`${DIR}/ldr.css`]: `.ldr { color: ${GREEN} }`,
      [`${DIR}/nsl.css`]: `.ns-link { color: ${GREEN} }`,
      [`${DIR}/noscript.html`]: noscriptPage(null),
      [`${DIR}/Refreshed.html`]: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Refreshed</title></head><body><p id="refreshed">Refreshed</p></body></html>`,
      [`${DIR}/Reparse refresh.html`]: reparseRefresh(null, 1),
      [`${DIR}/Reparse refresh zero.html`]: reparseRefresh(null, 0),
      [`${DIR}/Breakout refresh.html`]: reparseRefreshBreakout(null, 1),
      [`${DIR}/Direct refresh.html`]: directRefresh(null, 1),
    };
    TYPES.forEach((_, i) => {
      texts[`${DIR}/l${i}.css`] = `.l${i} { color: ${GREEN} }`;
      texts[`${DIR}/si${i}.css`] = `.si${i} { color: ${GREEN} }`;
    });
    const binaries = { [`${DIR}/ns.png`]: PNG, [`${DIR}/nsbg.png`]: PNG };
    measureUrl = await browser.executeObsidian(
      async ({ app }, dir, texts, binaries) => {
        if (!app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
        for (const [path, text] of Object.entries(texts)) {
          const existing = app.vault.getAbstractFileByPath(path);
          if (existing) await app.vault.modify(existing as never, text);
          else await app.vault.create(path, text);
        }
        for (const [path, base64] of Object.entries(binaries)) {
          if (app.vault.getAbstractFileByPath(path)) continue;
          const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
          await app.vault.createBinary(path, bytes.buffer);
        }
        const url = app.vault.adapter.getResourcePath(`${dir}/t147.html`).replace(/\?.*$/, "");
        return url.slice(0, url.lastIndexOf("/") + 1);
      },
      DIR,
      texts,
      binaries,
    );
    const host = await browser.execute(() => ({
      userAgent: navigator.userAgent,
      policies: [...document.querySelectorAll("meta[http-equiv]")].map((meta) => ({
        httpEquiv: meta.getAttribute("http-equiv"),
        content: meta.getAttribute("content"),
      })),
      location: location.href,
    }));
    record("host", { obsidian: browser.getObsidianVersion(), measureUrl, ...host });
  });

  afterEach(async function () {
    await removeFrames();
  });

  it("#147 A: scripts-off srcdoc frame", async function () {
    await addFrame("m-a", "allow-same-origin", { srcdoc: page147(measureUrl, false) });
    const first = await attempt(() => browser.execute(read147, "#m-a", GREEN));
    await browser.execute(enableLater, "#m-a");
    await browser.pause(1500);
    const later = await attempt(() => browser.execute(read147, "#m-a", GREEN));
    // Which links Chromium fetches, whatever Obsidian's policy then does with
    // the request: links inserted after listeners for their load, error, and
    // policy violation events.
    await browser.execute((cases) => {
      const doc = document.querySelector<HTMLIFrameElement>("#m-a")!.contentDocument!;
      const events: unknown[] = [];
      (window as any).e2eInserted = events;
      const note = (kind: string) => (event: Event) => {
        const target = event.target as Element | null;
        if (target?.localName === "link") events.push([kind, target.id]);
      };
      doc.addEventListener("load", note("load"), true);
      doc.addEventListener("error", note("error"), true);
      doc.addEventListener("securitypolicyviolation", (event) =>
        events.push(["csp", event.blockedURI, event.effectiveDirective]),
      );
      const div = doc.createElement("div");
      div.innerHTML = cases;
      doc.body.append(div);
    }, cases147("x"));
    await browser.pause(2000);
    const inserted = await browser.execute(() => (window as any).e2eInserted);
    record("147-A", { first, later, inserted });
  });

  it("#147 B: scripts-on srcdoc frame", async function () {
    await addFrame("m-b", "allow-scripts", { srcdoc: page147(measureUrl, true) });
    const first = await inside("m-b", () => browser.execute(read147, null, GREEN));
    await inside("m-b", () => browser.execute(enableLater, null));
    await browser.pause(1500);
    const later = await inside("m-b", () => browser.execute(read147, null, GREEN));
    record("147-B", { first, later });
  });

  it("#147 D: a test page served over HTTP, with each sandbox", async function () {
    const requested: string[] = [];
    const files: Record<string, { type: string; body: string }> = {
      "/t147.html": { type: "text/html", body: page147(null, true, true) },
      "/ld.css": { type: "text/css", body: `.ld { color: ${GREEN} }` },
      "/ldr.css": { type: "text/css", body: `.ldr { color: ${GREEN} }` },
    };
    TYPES.forEach((_, i) => {
      files[`/l${i}.css`] = { type: "text/css", body: `.l${i} { color: ${GREEN} }` };
      files[`/si${i}.css`] = { type: "text/css", body: `.si${i} { color: ${GREEN} }` };
    });
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      requested.push(url.pathname.slice(1) + url.search);
      const file = files[url.pathname];
      response.writeHead(file ? 200 : 404, {
        "Content-Type": file?.type ?? "text/plain",
        "Cache-Control": "no-store",
      });
      response.end(file?.body ?? "");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      for (const [id, sandbox] of [
        ["m-d", null],
        ["m-d-off", "allow-same-origin"],
        ["m-d-on", "allow-scripts"],
      ] as const) {
        requested.length = 0;
        const added = await attempt(() =>
          addFrame(id, sandbox, { src: `http://127.0.0.1:${port}/t147.html?frame=${id}` }),
        );
        const first = await inside(id, () => browser.execute(read147, null, GREEN));
        const before = [...requested];
        await inside(id, () => browser.execute(enableLater, null));
        await browser.pause(1500);
        const later = await inside(id, () => browser.execute(read147, null, GREEN));
        record(`147-${id}`, {
          sandbox,
          added: added ?? "loaded",
          first,
          later,
          requested: before,
          requestedLater: requested.slice(before.length),
        });
        await removeFrames();
      }
    } finally {
      server.close();
    }
  });

  it("#147 plugin: the view's copy, scripts off and on", async function () {
    await freshTab();
    await openInActiveTab(`${DIR}/p147.html`);
    await waitForPage();
    await browser.pause(1000);
    const copy = await srcdoc();
    const read = (text: string) => ({
      importsInlined: TYPES.map((_, i) => text.includes(`.si${i} { color`)),
      linksInlined: TYPES.map((_, i) => text.includes(`.l${i} { color`)),
      disabledInlined: text.includes(".ld { color"),
      disabledLaterInlined: text.includes(".ldr { color"),
    });
    const off = await attempt(() => browser.execute(read147, FRAME, GREEN));
    await clickToolbarButton("Scripts OFF");
    await waitForPage();
    await browser.pause(1000);
    const onCopy = await srcdoc();
    const on = await attempt(async () => {
      await browser.switchFrame(browser.$(FRAME));
      try {
        return await browser.execute(read147, null, GREEN);
      } finally {
        await browser.switchFrame(null);
      }
    });
    await clickToolbarButton("Scripts ON");
    record("147-plugin", { copyOff: read(copy), off, copyOn: read(onCopy), on });
  });

  it("#148a: <noscript> in srcdoc frames built here", async function () {
    const readNoscript = (selector: string | null, green: string) => {
      const frame = selector === null ? null : document.querySelector<HTMLIFrameElement>(selector);
      const doc = frame === null ? document : frame.contentDocument!;
      const win = doc.defaultView!;
      const noscript = doc.querySelector("noscript")!;
      const color = (selector: string) => {
        const element = doc.querySelector(selector);
        return element ? win.getComputedStyle(element).color === green : null;
      };
      return {
        childNodes: [...noscript.childNodes].map((node) =>
          node.nodeType === 1 ? (node as Element).localName : "#text",
        ),
        text: (noscript.textContent ?? "").slice(0, 200),
        display: win.getComputedStyle(noscript).display,
        nsParagraph: doc.getElementById("ns-p") !== null,
        images: [...doc.images].map((image) => ({
          id: image.id,
          complete: image.complete,
          width: image.naturalWidth,
        })),
        styleSheets: doc.styleSheets.length,
        afterStyled: color(".ns-after"),
        head: {
          noscripts: doc.head.querySelectorAll("noscript").length,
          text: (doc.head.querySelector("noscript")?.textContent ?? "").slice(0, 160),
          image: doc.getElementById("hn-img")?.parentElement?.localName ?? null,
          styled: color(".hn-style"),
        },
        linkStyled: color(".ns-link"),
        resources: win.performance
          .getEntriesByType("resource")
          .map((entry) => entry.name.split("/").at(-1)),
      };
    };
    await addFrame("m-ns-off", "allow-same-origin", { srcdoc: noscriptPage(measureUrl) });
    const off = await attempt(() => browser.execute(readNoscript, "#m-ns-off", GREEN));
    await addFrame("m-ns-on", "allow-scripts", { srcdoc: noscriptPage(measureUrl) });
    const on = await inside("m-ns-on", () => browser.execute(readNoscript, null, GREEN));
    await addFrame("m-ns-none", null, { srcdoc: noscriptPage(measureUrl) });
    const none = await attempt(() => browser.execute(readNoscript, "#m-ns-none", GREEN));
    record("148a-frames", { off, on, none });

    // The plugin's view.
    await freshTab();
    await openInActiveTab(`${DIR}/noscript.html`);
    await waitForPage();
    await browser.pause(1000);
    const copyOff = await srcdoc();
    const viewOff = await attempt(() => browser.execute(readNoscript, FRAME, GREEN));
    await setting("copyLocalFiles", true);
    await clickToolbarButton("Scripts OFF");
    await waitForPage();
    await browser.pause(1000);
    const copyOn = await srcdoc();
    const viewOn = await attempt(async () => {
      await browser.switchFrame(browser.$(FRAME));
      try {
        return await browser.execute(readNoscript, null, GREEN);
      } finally {
        await browser.switchFrame(null);
      }
    });
    await clickToolbarButton("Scripts ON");
    await setting("copyLocalFiles", false);
    const summary = (text: string) => ({
      pngDataUrls: text.match(/data:image\/png/g)?.length ?? 0,
      linkInlined: text.includes(".ns-link { color"),
      noscript: /<noscript>[\s\S]*?<\/noscript>/.exec(text)?.[0].slice(0, 400) ?? null,
    });
    record("148a-plugin", {
      off: { copy: summary(copyOff), frame: viewOff },
      on: { copy: summary(copyOn), frame: viewOn },
    });
  });

  it("#148b: refreshes in frames built here", async function () {
    // The copy that the plugin would give a frame is DOMParser's tree,
    // serialized; build each frame's srcdoc the same way.
    const serialize = (html: string) =>
      browser.execute((html) => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        return {
          html: `<!doctype html>\n${doc.documentElement.outerHTML}`,
          firstParseRefreshes: doc.querySelectorAll("meta[http-equiv]").length,
        };
      }, html);
    const reparse = await serialize(reparseRefresh(measureUrl, 1));
    const breakout = await serialize(reparseRefreshBreakout(measureUrl, 1));
    const direct = { html: directRefresh(measureUrl, 1), firstParseRefreshes: 1 };
    const directZero = { html: directRefresh(measureUrl, 0), firstParseRefreshes: 1 };
    const variants = { direct, "direct-zero": directZero, reparse, breakout };
    const sandboxes = {
      off: { sandbox: "allow-same-origin", cancel: false },
      "off-cancel": { sandbox: "allow-same-origin", cancel: true },
      on: { sandbox: "allow-scripts", cancel: false },
      none: { sandbox: null, cancel: false },
      "none-cancel": { sandbox: null, cancel: true },
    };
    const specs = Object.entries(variants).flatMap(([variant, { html }]) =>
      Object.entries(sandboxes).map(([name, { sandbox, cancel }]) => ({
        id: `m-r-${variant}-${name}`,
        sandbox,
        cancel,
        srcdoc: html,
      })),
    );
    await browser.execute((specs) => {
      const state: Record<string, any> = {};
      (window as any).e2eRefresh = state;
      for (const spec of specs) {
        const frame = document.createElement("iframe");
        frame.id = spec.id;
        if (spec.sandbox !== null) frame.setAttribute("sandbox", spec.sandbox);
        frame.style.cssText =
          "position: fixed; left: 0; top: 0; width: 300px; height: 200px; z-index: 10000;";
        const seen = (state[spec.id] = { loads: 0, watched: false, navigations: [] as unknown[] });
        frame.addEventListener("load", () => (seen.loads += 1));
        frame.srcdoc = spec.srcdoc;
        document.body.append(frame);
        // Watches the srcdoc document as soon as it exists, as the view does.
        const started = Date.now();
        const poll = () => {
          let doc: Document | null = null;
          try {
            doc = frame.contentDocument;
          } catch {
            doc = null;
          }
          if (doc && doc.URL === "about:srcdoc" && doc.documentElement) {
            seen.watched = true;
            const navigation = (doc.defaultView as any)?.navigation;
            navigation?.addEventListener("navigate", (event: any) => {
              if (spec.cancel) event.preventDefault();
              seen.navigations.push({
                url: event.destination.url,
                canceled: event.defaultPrevented,
                cancelable: event.cancelable,
                type: event.navigationType,
              });
            });
            return;
          }
          if (Date.now() - started < 10_000) setTimeout(poll, 10);
        };
        poll();
      }
    }, specs);
    await browser.pause(6000);
    const outcome = await browser.execute(() => {
      const state = (window as any).e2eRefresh as Record<string, any>;
      return Object.fromEntries(
        Object.entries(state).map(([id, seen]) => {
          const frame = document.getElementById(id) as HTMLIFrameElement;
          let href: string;
          let metas: number | null = null;
          try {
            href = frame.contentWindow!.location.href;
            metas = frame.contentDocument!.querySelectorAll("meta[http-equiv]").length;
          } catch {
            href = "unreachable";
          }
          return [id, { ...seen, href, metas }];
        }),
      );
    });
    for (const id of Object.keys(outcome)) {
      if (!id.endsWith("-on")) continue;
      outcome[id].inside = await inside(id, () =>
        browser.execute(() => ({
          href: location.href,
          metas: document.querySelectorAll("meta[http-equiv]").length,
          refreshed: document.getElementById("refreshed") !== null,
        })),
      );
    }
    record("148b-frames", {
      serialized: { reparse: reparse.html, breakout: breakout.html },
      firstParseRefreshes: {
        reparse: reparse.firstParseRefreshes,
        breakout: breakout.firstParseRefreshes,
      },
      outcome,
    });
  });

  for (const [name, file] of [
    ["reparse", "Reparse refresh.html"],
    ["reparse-zero", "Reparse refresh zero.html"],
    ["breakout", "Breakout refresh.html"],
    ["direct", "Direct refresh.html"],
  ] as const) {
    for (const scriptsOn of [false, true]) {
      it(`#148b plugin: ${name}, scripts ${scriptsOn ? "on" : "off"}`, async function () {
        await freshTab();
        await setting("scriptsOn", scriptsOn);
        try {
          await openInActiveTab(`${DIR}/${file}`);
          await browser.$(FRAME).waitForExist();
          await browser.execute((selector) => {
            const frame = document.querySelector<HTMLIFrameElement>(selector)!;
            frame.dataset.e2eLoads = "0";
            frame.addEventListener("load", () => {
              frame.dataset.e2eLoads = String(Number(frame.dataset.e2eLoads) + 1);
            });
          }, FRAME);
          const loaded = await attempt(() => waitForPage());
          // Records the navigations that the frame starts, after the view's own listener.
          if (!scriptsOn)
            await attempt(() =>
              browser.execute((selector) => {
                const frame = document.querySelector<HTMLIFrameElement>(selector)!;
                const seen: unknown[] = [];
                (window as any).e2eNavigations = seen;
                (frame.contentWindow as any).navigation.addEventListener("navigate", (event: any) =>
                  seen.push({
                    url: event.destination.url,
                    canceled: event.defaultPrevented,
                    type: event.navigationType,
                  }),
                );
              }, FRAME),
            );
          await browser.pause(5000);
          const copy = await srcdoc();
          const parent = await browser.execute((selector) => {
            const frame = document.querySelector<HTMLIFrameElement>(selector);
            let href: string;
            let metas: number | null = null;
            let inert: boolean | null = null;
            try {
              href = frame?.contentWindow?.location.href ?? "none";
              metas = frame!.contentDocument!.querySelectorAll("meta[http-equiv]").length;
              inert = frame!.contentDocument!.documentElement.hasAttribute("inert");
            } catch {
              href = "unreachable";
            }
            return {
              href,
              metas,
              inert,
              loadsAfterOpen: frame?.dataset.e2eLoads ?? null,
              navigations: (window as any).e2eNavigations ?? null,
            };
          }, FRAME);
          const inFrame = scriptsOn
            ? await attempt(async () => {
                await browser.switchFrame(browser.$(FRAME));
                try {
                  return await browser.execute(() => ({
                    href: location.href,
                    metas: [...document.querySelectorAll("meta[http-equiv]")].map((meta) =>
                      meta.getAttribute("http-equiv"),
                    ),
                    refreshed: document.getElementById("refreshed") !== null,
                  }));
                } finally {
                  await browser.switchFrame(null);
                }
              })
            : null;
          const active = await browser.executeObsidian(({ app }) => {
            const view = app.workspace.getMostRecentLeaf()?.view as any;
            return { type: view?.getViewType?.() ?? null, path: view?.file?.path ?? null };
          });
          record(`148b-plugin-${name}-${scriptsOn ? "on" : "off"}`, {
            loaded: loaded ?? "loaded",
            copyHasRefreshText: /http-equiv=["']?refresh/i.test(copy),
            copyRefreshElementsByDomParser: await browser.execute((copy) => {
              const doc = new DOMParser().parseFromString(copy, "text/html");
              return [...doc.querySelectorAll("meta[http-equiv]")].map((meta) =>
                meta.getAttribute("http-equiv"),
              );
            }, copy),
            parent,
            inFrame,
            active,
          });
        } finally {
          await setting("scriptsOn", false);
        }
      });
    }
  }
});
