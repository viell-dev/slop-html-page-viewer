// One warm-up, then three observations; compare revisions with node scripts/css-benchmark.mjs REF.
// Ordinary synthetic CSS only; this reports timings, not a regression gate.
import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import path from "node:path";
const ref = process.argv[2];
const plugins = ref
  ? [
      {
        name: "revision",
        setup(b) {
          b.onLoad({ filter: /src[\\/](document|css)\.ts$/ }, ({ path: p }) => ({
            contents: execFileSync("git", ["show", `${ref}:src/${path.basename(p)}`], {
              encoding: "utf8",
            }),
            loader: "ts",
          }));
        },
      },
    ]
  : [];
await esbuild.build({
  stdin: {
    contents: 'import "./test/support/dom"; export * from "./src/document";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: "dist/css-bench.mjs",
  plugins,
});
const { preparePage, absoluteUrls, inlineStylesheet } = await import("../dist/css-bench.mjs");
const base = "app://vault-id/vault/";
const rule =
  'a.card:hover { color: red; background: url(img.png); content: "example"; } /* ordinary comment */\n';
for (const size of [300_000, 4_000_000]) {
  const css = rule.repeat(Math.ceil(size / rule.length));
  const ctx = { pageUrl: base + "index.html", vaultUrl: base, read: async () => css };
  for (const [name, run] of [
    ["absoluteUrls", () => absoluteUrls(css, base + "site.css")],
    ["inlineStylesheet", () => inlineStylesheet(css, base + "site.css", ctx)],
    ["linked preparePage", () => preparePage('<link rel="stylesheet" href="site.css">', ctx)],
  ]) {
    await run();
    const times = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      await run();
      times.push(Math.round(performance.now() - start));
    }
    console.log(JSON.stringify({ ref: ref ?? "working", bytes: css.length, name, ms: times }));
  }
}
