import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";

describe("Scratch: content security policy", function () {
  it("collects details", async function () {
    const details = await browser.executeObsidian(async ({ app }) => {
      const out: Record<string, unknown> = {};
      out.metaPolicies = [...document.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')].map(
        (meta) => meta.getAttribute("content"),
      );
      const violations: unknown[] = [];
      const file = app.vault.getAbstractFileByPath("Mirror/index.html") as never;
      const url = app.vault.getResourcePath(file);
      const base = url.replace(/[?#].*$/, "");
      const directory = base.slice(0, base.lastIndexOf("/") + 1);
      // A frame whose own script reports violations; scripts and same-origin
      // together only in this diagnostic.
      const iframe = document.createElement("iframe");
      const loaded = new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }));
      iframe.srcdoc = `<!doctype html><html><head><base href="${directory}">
<script>document.addEventListener("securitypolicyviolation", (e) => parent.__violations.push({ directive: e.violatedDirective, blocked: e.blockedURI, policy: e.originalPolicy }));</script>
<link rel="stylesheet" href="style.css"></head><body><header class="banner">Banner</header>
<img src="../Saved/2026-01-15/figure.png"><span style="font-family: x; src: url(f.woff)">t</span></body></html>`;
      (window as unknown as { __violations: unknown[] }).__violations = violations;
      document.body.appendChild(iframe);
      await loaded;
      await new Promise((resolve) => setTimeout(resolve, 500));
      out.violations = violations;
      const doc = iframe.contentDocument!;
      out.banner = iframe.contentWindow!.getComputedStyle(doc.querySelector(".banner")!).backgroundColor;
      out.imageWidth = (doc.querySelector("img") as HTMLImageElement).naturalWidth;
      iframe.remove();
      return out;
    });
    const root = path.resolve(import.meta.dirname, "../../..");
    const output = process.env.E2E_OUTPUT_DIR?.trim() || path.join(root, "test-results", "e2e");
    fs.writeFileSync(path.join(output, `scratch-${browser.getObsidianVersion()}.json`), JSON.stringify(details, null, 2));
  });
});
