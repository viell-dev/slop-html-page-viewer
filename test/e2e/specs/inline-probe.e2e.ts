// A probe for #11, removed by the next commit: which ways of embedding a
// vault file a frame with an opaque origin can use, in Obsidian.

import { browser } from "@wdio/globals";
import { type Color, decodePng, solidPng } from "../support/pixels.ts";
import { openInActiveTab } from "../support/viewer.ts";

const GREEN: Color = [46, 125, 50];

/** A 24-bit BMP of one colour: uncompressed, so its size is predictable. */
function solidBmp(size: number, [red, green, blue]: Color): Buffer {
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
  const pixels = Buffer.alloc(row * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      pixels[y * row + x * 3] = blue;
      pixels[y * row + x * 3 + 1] = green;
      pixels[y * row + x * 3 + 2] = red;
    }
  }
  return Buffer.concat([header, pixels]);
}

describe("Probe: what a frame with an opaque origin loads (#11)", function () {
  it("measures", async function () {
    this.timeout(180_000);
    await openInActiveTab("Saved/Example article.html");

    const png = solidPng(64, GREEN).toString("base64");
    const bmp = solidBmp(1024, GREEN).toString("base64");
    const draw =
      "const d=document.createElement('div');d.style.cssText='position:fixed;left:0;top:0;width:64px;height:64px;background:rgb(46,125,50)';document.documentElement.appendChild(d);";
    const drawBase64 = Buffer.from(draw).toString("base64");
    const policy =
      "default-src https: http: data: blob: 'unsafe-inline' 'unsafe-eval'; img-src https: http: data: blob:; media-src https: http: data: blob:; font-src https: http: data: blob:; frame-src https: http: data: blob:; object-src 'none'";

    const obsidianPolicy = await browser.execute(() =>
      [...document.querySelectorAll("meta[http-equiv]")].map(
        (meta) => `${meta.getAttribute("http-equiv")}: ${meta.getAttribute("content")}`,
      ),
    );
    console.log(`PROBE Obsidian ${browser.getObsidianVersion()} meta: ${JSON.stringify(obsidianPolicy)}`);

    const cases: [name: string, sandbox: string, body: string][] = [
      ["img data: png", "", `<img src="data:image/png;base64,${png}">`],
      ["img data: png", "allow-scripts", `<img src="data:image/png;base64,${png}">`],
      ["img data: bmp 3 MiB", "allow-scripts", `<img src="data:image/bmp;base64,${bmp}" style="width:64px;height:64px">`],
      ["img blob: png", "allow-scripts", '<img src="BLOB_PNG">'],
      ["img blob: bmp 3 MiB", "allow-scripts", '<img src="BLOB_BMP" style="width:64px;height:64px">'],
      ["css url(data:)", "allow-scripts", `<div style="width:64px;height:64px;background:url(data:image/png;base64,${png})"></div>`],
      ["inline script", "allow-scripts", `<script>${draw}</script>`],
      ["script src data:", "allow-scripts", `<script src="data:text/javascript;base64,${drawBase64}"></script>`],
      ["module src data:", "allow-scripts", `<script type="module" src="data:text/javascript;base64,${drawBase64}"></script>`],
      ["script src blob:", "allow-scripts", '<script src="BLOB_JS"></script>'],
    ];

    for (const [name, sandbox, body] of cases) {
      const started = Date.now();
      await browser.execute(
        (sandbox, body, policy, png, bmp, draw) => {
          document.querySelector("#inline-probe")?.remove();
          const bytes = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
          const filled = body
            .replace("BLOB_PNG", URL.createObjectURL(new Blob([bytes(png)], { type: "image/png" })))
            .replace("BLOB_BMP", URL.createObjectURL(new Blob([bytes(bmp)], { type: "image/bmp" })))
            .replace("BLOB_JS", URL.createObjectURL(new Blob([draw], { type: "text/javascript" })));
          const frame = document.createElement("iframe");
          frame.id = "inline-probe";
          frame.setAttribute("sandbox", sandbox);
          frame.style.cssText = "position:fixed;left:0;top:0;width:100px;height:100px;z-index:99999;border:0;background:white";
          frame.srcdoc = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"></head><body style="margin:0;background:white">${filled}</body></html>`;
          document.body.append(frame);
        },
        sandbox,
        body,
        policy,
        png,
        bmp,
        draw,
      );
      await browser.pause(1500);
      const frame = await browser.$("#inline-probe");
      const shot = await browser.takeElementScreenshot(await frame.elementId);
      const green = decodePng(Buffer.from(shot, "base64")).count(GREEN);
      console.log(
        `PROBE Obsidian ${browser.getObsidianVersion()} | ${name} | sandbox "${sandbox}" | green pixels ${green} of 4096 | ${Date.now() - started} ms`,
      );
    }
    await browser.execute(() => document.querySelector("#inline-probe")?.remove());
  });
});
