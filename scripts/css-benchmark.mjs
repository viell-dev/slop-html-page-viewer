// One warm-up, then three timed runs of each case; then each case's peak memory, measured
// alone in a fresh process. Compare revisions with node scripts/css-benchmark.mjs REF.
// Ordinary synthetic CSS only; this reports observations, not a regression gate.
import esbuild from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ref = process.argv[2];
// Set for a child process that measures one case: "<bytes> <name>".
const only = process.env.CSS_BENCHMARK_CASE;
const source = (file) =>
  ref ? execFileSync("git", ["show", `${ref}:src/${file}`], { encoding: "utf8" }) : null;
const hasScanner = ref
  ? spawnSync("git", ["cat-file", "-e", `${ref}:src/css.ts`]).status === 0
  : fs.existsSync("src/css.ts");

if (!only) {
  await esbuild.build({
    stdin: {
      contents: [
        'import "./test/support/dom";',
        'export * from "./src/document";',
        hasScanner ? 'export { cssTokens } from "./src/css";' : "",
      ].join("\n"),
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: "dist/css-bench.mjs",
    plugins: ref
      ? [
          {
            name: "revision",
            setup(b) {
              b.onLoad({ filter: /src[\\/](document|css)\.ts$/ }, ({ path: p }) => ({
                contents: source(path.basename(p)),
                loader: "ts",
              }));
            },
          },
        ]
      : [],
  });
}
const { preparePage, absoluteUrls, inlineStylesheet, cssTokens } =
  await import("../dist/css-bench.mjs");

const base = "app://vault-id/vault/";
const rule =
  'a.card:hover { color: red; background: url(img.png); content: "example"; } /* ordinary comment */\n';
const copyFiles = { size: () => 1, readBinary: async () => new Uint8Array([1]).buffer };
const sizes = [300_000, 4_000_000];

function cases(size) {
  const css = rule.repeat(Math.ceil(size / rule.length));
  const ctx = { pageUrl: base + "index.html", vaultUrl: base, read: async () => css };
  const linked = '<link rel="stylesheet" href="site.css">';
  return {
    css,
    runs: {
      absoluteUrls: () => absoluteUrls(css, base + "site.css"),
      inlineStylesheet: () => inlineStylesheet(css, base + "site.css", ctx),
      "linked preparePage": () => preparePage(linked, ctx),
      "linked + copyFiles": () => preparePage(linked, ctx, { copyFiles }),
      "<style> + copyFiles": () => preparePage(`<style>${css}</style>`, ctx, { copyFiles }),
    },
  };
}

if (only) {
  const [bytes, name] = [only.slice(0, only.indexOf(" ")), only.slice(only.indexOf(" ") + 1)];
  const { css, runs } = cases(Number(bytes));
  const result = { ref: ref ?? "working", bytes: css.length, name };
  if (name === "cssTokens") {
    // The heap that one token list keeps alive.
    globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    const tokens = cssTokens(css);
    globalThis.gc();
    result.tokens = tokens.length;
    result.retainedMB = Math.round((process.memoryUsage().heapUsed - before) / 2 ** 20);
  } else {
    // How far one run raises the process's peak resident memory (maxRSS is in KiB).
    const before = process.resourceUsage().maxRSS;
    await runs[name]();
    result.peakMB = Math.round((process.resourceUsage().maxRSS - before) / 1024);
  }
  console.log(JSON.stringify(result));
  process.exit(0);
}

for (const size of sizes) {
  const { css, runs } = cases(size);
  for (const [name, run] of Object.entries(runs)) {
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
const script = fileURLToPath(import.meta.url);
for (const size of sizes) {
  const names = [...Object.keys(cases(0).runs), ...(cssTokens ? ["cssTokens"] : [])];
  for (const name of names) {
    const child = spawnSync(process.execPath, ["--expose-gc", script, ...(ref ? [ref] : [])], {
      encoding: "utf8",
      env: { ...process.env, CSS_BENCHMARK_CASE: `${size} ${name}` },
    });
    process.stdout.write(child.status === 0 ? child.stdout : child.stderr);
  }
}
