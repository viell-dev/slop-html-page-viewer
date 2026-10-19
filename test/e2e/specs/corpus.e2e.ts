// Opens every page of the archive corpus (corpus/generate.mjs) and checks what
// the frame shows against the files on disk: every image that resolves loads,
// by path or, as Obsidian resolves links, by name; none that is missing
// everywhere does; linked stylesheets and imports apply; scripts never run;
// and pages without styles get the reading style. With the frozen prototype
// build installed instead, the spec records the same facts without checking
// them, for corpus/compare.mjs.

import fs from "node:fs";
import path from "node:path";
import { browser, expect } from "@wdio/globals";
import { openInActiveTab } from "../support/viewer.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const corpus = path.join(root, "dist", "e2e-vaults", "archive");
const output = process.env.E2E_OUTPUT_DIR?.trim() || path.join(root, "test-results", "e2e");

function filesUnder(directory: string, prefix = ""): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name === ".obsidian") return [];
    return entry.isDirectory() ? filesUnder(path.join(directory, entry.name), relative) : [relative];
  });
}

const pages = fs.existsSync(corpus) ? filesUnder(corpus).filter((file) => /\.html?$/i.test(file)).sort() : [];

interface Frame {
  images: { src: string; url: string; loaded: boolean }[];
  globals: string[];
  vaultStylesheetLinks: number;
  markers: Record<string, string>;
  readingStyle: boolean;
  script: string | null;
  font: boolean;
}

/** Waits for the active tab's page and all its images, then reads what it shows. */
async function inspectFrame(): Promise<Frame> {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const frame = document.querySelector<HTMLIFrameElement>(".workspace-leaf.mod-active iframe.html-page-viewer__frame");
        const doc = frame?.contentDocument;
        if (!frame?.srcdoc || !doc || doc.readyState !== "complete" || doc.body.childElementCount === 0) return false;
        return [...doc.images].every((image) => image.complete);
      }),
    { timeout: 20_000, interval: 100, timeoutMsg: "the page and its images did not finish loading" },
  );
  return browser.execute(async () => {
    const frame = document.querySelector<HTMLIFrameElement>(".workspace-leaf.mod-active iframe.html-page-viewer__frame")!;
    const doc = frame.contentDocument!;
    const style = frame.contentWindow!.getComputedStyle(doc.documentElement);
    await doc.fonts.ready;
    return {
      images: [...doc.images].map((image) => ({
        src: image.getAttribute("src") ?? "",
        url: image.currentSrc || image.src,
        loaded: image.complete && image.naturalWidth > 0,
      })),
      // What the CDN scripts would define, had they run.
      globals: ["jQuery", "$", "_"].filter((name) => name in frame.contentWindow!),
      vaultStylesheetLinks: [...doc.querySelectorAll<HTMLLinkElement>("link")].filter(
        (link) => /\bstylesheet\b/i.test(link.rel) && !/^https?:/.test(link.href),
      ).length,
      markers: Object.fromEntries(
        ["common", "light", "legacy"].map((name) => [name, style.getPropertyValue(`--fixture-${name}`).trim()]),
      ),
      readingStyle: doc.getElementById("html-page-viewer-reading-style") !== null,
      script: doc.documentElement.dataset.fixtureScript ?? null,
      font: doc.fonts.check('16px "Fixture Sans"') && [...doc.fonts].some((face) => face.family.includes("Fixture Sans") && face.status === "loaded"),
    };
  });
}

/** What the page's source says about it, read from disk. */
function expectations(page: string): { images: { src: string; path: string | null }[]; ownStyles: boolean; sheets: string[] } {
  const text = fs.readFileSync(path.join(corpus, page), "utf8");
  const directory = path.posix.dirname(page);
  const images = [...text.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map(([, src]) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return { src, path: null };
    const relative = path.posix.normalize(path.posix.join(directory, decodeURIComponent(src.replace(/[?#].*$/, ""))));
    return { src, path: fs.existsSync(path.join(corpus, relative)) ? relative : null };
  });
  const sheets = [...text.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]*)"/g)].map(([, href]) => href);
  const imports = [...text.matchAll(/@import\s+url\("([^"]+)"\)/g)].map(([, href]) => href);
  return { images, ownStyles: /<style\b/.test(text) || sheets.length > 0, sheets: [...sheets, ...imports] };
}

async function build(): Promise<"viewer" | "prototype"> {
  return browser.executeObsidian(({ app }) => {
    const plugins = (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins;
    return "viell-html-page-viewer" in plugins ? "viewer" : "prototype";
  });
}

/** The vault path a resource URL leads to, or null for a URL elsewhere. */
function vaultPathOf(url: string, vaultUrl: string): string | null {
  const plain = url.replace(/[?#].*$/, "");
  if (!plain.startsWith(vaultUrl)) return null;
  try {
    return decodeURIComponent(plain.slice(vaultUrl.length));
  } catch {
    return null;
  }
}

describe("The archive corpus", function () {
  const results: Record<string, unknown> = {};
  let which: "viewer" | "prototype" = "viewer";
  let vaultUrl = "";

  before(async function () {
    which = await build();
    // The adapter's resource URL for the vault root, without its query.
    vaultUrl = `${(await browser.executeObsidian(({ app }) => app.vault.adapter.getResourcePath(""))).replace(/[?#].*$/, "")}/`;
  });

  after(async function () {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(
      path.join(output, `corpus-${which}-${browser.getObsidianVersion()}.json`),
      JSON.stringify({ build: which, version: browser.getObsidianVersion(), pages: results }, null, 2),
    );
  });

  it("has pages", function () {
    expect(pages.length).toBeGreaterThan(20);
  });

  for (const page of pages) {
    it(page, async function () {
      const started = Date.now();
      await openInActiveTab(page);
      const frame = await inspectFrame();
      const milliseconds = Date.now() - started;
      const expected = expectations(page);

      // An image whose path does not resolve may still resolve as Obsidian
      // resolves a link: by name, or by a partial path.
      const byName = await browser.executeObsidian(
        ({ app }, page, sources) =>
          sources.map((src) => {
            const linktext = decodeURIComponent(src.replace(/[?#].*$/, "")).replace(/^\/+/, "");
            return app.metadataCache.getFirstLinkpathDest(linktext, page)?.path ?? null;
          }),
        page,
        expected.images.map((image) => image.src),
      );
      const images = frame.images.map((image) => ({ ...image, path: vaultPathOf(image.url, vaultUrl) }));
      const wanted = expected.images.map((image, index) => image.path ?? byName[index]);
      results[page] = { milliseconds, ...frame, images, expected: wanted };
      if (which === "prototype") return;

      // Each image shows the file it should, or nothing when there is none.
      expect(images.length).toBe(expected.images.length);
      expected.images.forEach((image, index) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(image.src)) return;
        const shown = images[index].loaded ? images[index].path : null;
        expect({ src: image.src, shown }).toEqual({ src: image.src, shown: wanted[index] });
      });
      expect(frame.vaultStylesheetLinks).toBe(0);
      expect(frame.script).toBe(null);
      expect(frame.globals).toEqual([]);
      expect(frame.readingStyle).toBe(!expected.ownStyles);
      if (expected.sheets.some((sheet) => /common\.css|legacy\.css/.test(sheet))) {
        expect(frame.markers.common).toBe("loaded");
        if (fs.existsSync(path.join(corpus, "Cache/Repositories/Example's Créature Site/fonts/FixtureSans.ttf"))) {
          expect(frame.font).toBe(true);
        }
      }
      if (expected.sheets.some((sheet) => sheet.includes("light.css"))) expect(frame.markers.light).toBe("loaded");
      if (expected.sheets.some((sheet) => sheet.includes("legacy.css"))) expect(frame.markers.legacy).toBe("loaded");
      expect(milliseconds).toBeLessThan(15_000);
    });
  }
});
