// A measurement, not a test: how Obsidian loads a page's local resources in
// a frame, for each way of loading the page and each sandbox. It writes its
// results to probe-<version>.json in the output directory.

import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { decodePng, type Color } from "../support/pixels.ts";

const GREEN: Color = [46, 125, 50];
const BLUE: Color = [21, 101, 192];

interface Probe {
  reachable: boolean;
  origin: string | null;
  url: string;
}

async function probe(filePath: string, loading: "src" | "srcdoc", sandbox: string): Promise<Probe> {
  return browser.executeObsidian(
    async ({ app }, filePath, loading, sandbox) => {
      document.getElementById("probe")?.remove();
      const file = app.vault.getAbstractFileByPath(filePath) as never;
      const url = app.vault.getResourcePath(file);
      const container = document.createElement("div");
      container.id = "probe";
      Object.assign(container.style, {
        position: "fixed",
        left: "0",
        top: "0",
        width: "420px",
        height: "320px",
        zIndex: "100000",
        background: "white",
      });
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", sandbox);
      Object.assign(iframe.style, { width: "400px", height: "300px", border: "0" });
      const loaded = new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }));
      if (loading === "src") {
        iframe.src = url;
      } else {
        const base = url.replace(/[?#].*$/, "");
        const directory = base.slice(0, base.lastIndexOf("/") + 1);
        const html = await app.vault.read(file);
        iframe.srcdoc = html.replace(/<head>/i, `<head><base href="${directory}">`);
      }
      container.appendChild(iframe);
      document.body.appendChild(container);
      await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 5000))]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      let reachable = false;
      let origin: string | null = null;
      try {
        reachable = iframe.contentDocument?.body != null;
        origin = iframe.contentWindow?.origin ?? null;
      } catch {
        // A cross-origin frame's document and origin are not readable.
      }
      return { reachable, origin, url };
    },
    filePath,
    loading,
    sandbox,
  );
}

async function frameShows(color: Color): Promise<number> {
  const frame = await browser.$("#probe iframe");
  const shot = await browser.takeElementScreenshot(await frame.elementId);
  return decodePng(Buffer.from(shot, "base64")).count(color);
}

const cases: [string, "src" | "srcdoc", string][] = [
  ["src, no permissions (upstream)", "src", ""],
  ["src, allow-same-origin", "src", "allow-same-origin"],
  ["src, allow-scripts", "src", "allow-scripts"],
  ["srcdoc with base, no permissions", "srcdoc", ""],
  ["srcdoc with base, allow-same-origin", "srcdoc", "allow-same-origin"],
  ["srcdoc with base, allow-scripts", "srcdoc", "allow-scripts"],
];

describe("Probe: local resources in frames", function () {
  const results: Record<string, unknown>[] = [];

  after(async function () {
    const root = path.resolve(import.meta.dirname, "../../..");
    const output = process.env.E2E_OUTPUT_DIR?.trim() || path.join(root, "test-results", "e2e");
    const obsidianOrigin = await browser.executeObsidian(() => window.origin);
    fs.writeFileSync(
      path.join(output, `probe-${browser.getObsidianVersion()}.json`),
      JSON.stringify({ obsidianOrigin, results }, null, 2),
    );
  });

  for (const [name, loading, sandbox] of cases) {
    it(name, async function () {
      const image = await probe("Saved/Example article.html", loading, sandbox);
      const green = await frameShows(GREEN);
      const style = await probe("Mirror/index.html", loading, sandbox);
      const blue = await frameShows(BLUE);
      results.push({
        name,
        image: { greenPixels: green, reachable: image.reachable, origin: image.origin },
        stylesheet: { bluePixels: blue, reachable: style.reachable, origin: style.origin },
        url: image.url,
      });
    });
  }
});
