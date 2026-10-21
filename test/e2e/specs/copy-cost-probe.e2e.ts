// A probe for #11, removed by the next commit: how long a page with scripts on
// takes to be prepared when its local files are copied into it, in Obsidian.

import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { openInActiveTab, vaultFolder } from "../support/viewer.ts";

const PLUGIN_ID = "viell-html-page-viewer";

/** An uncompressed BMP of about `bytes` bytes. */
function bmp(bytes: number): Buffer {
  const size = Math.max(1, Math.floor(Math.sqrt(bytes / 3)));
  const row = Math.ceil((size * 3) / 4) * 4;
  const header = Buffer.alloc(54);
  header.write("BM", 0, "latin1");
  header.writeUInt32LE(54 + row * size, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(size, 18);
  header.writeInt32LE(size, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(row * size, 34);
  return Buffer.concat([header, Buffer.alloc(row * size, 0x80)]);
}

async function setCopying(on: boolean): Promise<void> {
  await browser.executeObsidian(async ({ app }, id, on) => {
    const plugin = (app as unknown as { plugins: { plugins: Record<string, { updateSettings(change: object): Promise<void> }> } })
      .plugins.plugins[id];
    await plugin.updateSettings({ copyLocalFiles: on });
  }, PLUGIN_ID, on);
}

/** Turns scripts on in the active tab and returns how long until the frame has its page, and the page's length. */
async function timeScriptsOn(): Promise<{ ms: number; length: number }> {
  return browser.execute(async () => {
    const active = ".workspace-leaf.mod-active";
    const button = [...document.querySelectorAll<HTMLButtonElement>(`${active} .html-page-viewer__toolbar button`)].find(
      (candidate) => candidate.textContent === "Scripts OFF",
    );
    if (!button) throw new Error("No Scripts OFF button");
    const started = performance.now();
    button.click();
    for (;;) {
      const frame = document.querySelector<HTMLIFrameElement>(`${active} iframe.html-page-viewer__frame`);
      if (frame?.srcdoc) return { ms: Math.round(performance.now() - started), length: frame.srcdoc.length };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
}

async function turnScriptsOff(): Promise<void> {
  await browser.execute(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".workspace-leaf.mod-active .html-page-viewer__toolbar button")].find(
      (candidate) => candidate.textContent === "Scripts ON",
    );
    button?.click();
  });
}

describe("Probe: the cost of copying a page's local files (#11)", function () {
  it("measures", async function () {
    this.timeout(600_000);
    const vault = await vaultFolder();
    const cases: [name: string, count: number, bytes: number][] = [
      ["10 images of 100 kB", 10, 100_000],
      ["100 images of 100 kB", 100, 100_000],
      ["300 images of 100 kB", 300, 100_000],
      ["4 images of 7 MB", 4, 7_000_000],
    ];
    for (const [name, count, bytes] of cases) {
      const folder = path.join(vault, "Probe", `${count}x${bytes}`);
      fs.mkdirSync(folder, { recursive: true });
      const image = bmp(bytes);
      for (let index = 0; index < count; index += 1) fs.writeFileSync(path.join(folder, `${index}.bmp`), image);
      const images = Array.from({ length: count }, (_, index) => `<img src="${index}.bmp" width="16" height="16">`).join("\n");
      fs.writeFileSync(path.join(folder, "page.html"), `<!doctype html><title>${name}</title>\n${images}\n`);
      const pagePath = `Probe/${count}x${bytes}/page.html`;
      await browser.waitUntil(
        async () =>
          browser.executeObsidian(
            ({ app }, pagePath, count) =>
              app.vault.getAbstractFileByPath(pagePath) !== null &&
              app.vault.getFiles().filter((file) => file.path.startsWith(pagePath.replace("page.html", ""))).length === count + 1,
            pagePath,
            count,
          ),
        { timeout: 60_000, timeoutMsg: `Obsidian did not index ${pagePath}` },
      );

      for (const copying of [false, true, true, true]) {
        await setCopying(copying);
        await openInActiveTab(pagePath);
        await browser.pause(300);
        const { ms, length } = await timeScriptsOn();
        console.log(
          `PROBE Obsidian ${browser.getObsidianVersion()} | ${name} | copying ${copying} | ${ms} ms to prepare | page ${(length / 1e6).toFixed(1)} M characters`,
        );
        await browser.pause(500);
        await turnScriptsOff();
      }
    }
    await setCopying(false);
  });
});
