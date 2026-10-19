// Builds the archive corpus: a synthetic vault in the layout of a vault that
// caches web pages as archival semantic HTML. It copies the hand-written pages
// in vault/, adds generated ones at the sizes such a vault reaches, and writes
// every asset the pages refer to, so that the repository holds no binaries.
//
// Usage: node test/e2e/corpus/generate.mjs <output directory>

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

const here = import.meta.dirname;
const output = path.resolve(process.argv[2] ?? path.join(here, "../../../dist/e2e-vaults/archive"));

/** References that stand for assets the cache could not retrieve. */
const UNAVAILABLE = new Set(["Cache/Websites/Example Encyclopedia/Event Gallery - Unavailable Asset/2026-05-01/card-summer.png"]);

/**
 * Assets that pages refer to by a path that does not exist, stored where
 * Obsidian's link resolution finds them: by name, or by a partial path.
 */
const ELSEWHERE = {
  "Cache/Websites/Example Encyclopedia/Event Gallery - Unavailable Asset/card-autumn.png":
    "Cache/Websites/Example Encyclopedia/Shared Assets/card-autumn.png",
  "Cache/Websites/Example Encyclopedia/Event Gallery - Unavailable Asset/Shared Assets/card-winter.png":
    "Cache/Websites/Example Encyclopedia/Shared Assets/card-winter.png",
  "Cache/Repositories/Example's Créature Site/Main-Series/Gen 2/legacy-sprites/025.png":
    "Cache/Repositories/Example's Créature Site/sprites/legacy-sprites/025.png",
};

// --- Binary assets ---------------------------------------------------------

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type, body) {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
  let crc = 0xffffffff;
  for (const byte of typed) crc = CRC[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, typed, check]);
}

function png(width, height, seed) {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const color = [hash & 0xff, (hash >>> 8) & 0xff, (hash >>> 16) & 0xff];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => color).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A one-pixel GIF of two frames, green and red, looping every half second.
// Browsers decode images by their content, so other raster formats are written
// as PNG data under their own extensions.
const GIF = Buffer.from([
  ...Buffer.from("GIF89a", "latin1"),
  0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, // 1 × 1, a global table of two colors
  0x2e, 0x7d, 0x32, 0xc6, 0x28, 0x28, // green, red
  0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0", "latin1"), 0x03, 0x01, 0x00, 0x00, 0x00, // loop forever
  ...[0x44, 0x4c].flatMap((pixels) => [
    0x21, 0xf9, 0x04, 0x00, 0x32, 0x00, 0x00, 0x00, // 50 hundredths of a second
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // the whole image
    0x02, 0x02, pixels, 0x01, 0x00, // LZW: clear, color 0 or 1, end
  ]),
  0x3b,
]);

function asset(file, width = 16, height = 16) {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".gif") return GIF;
  if ([".png", ".jpg", ".jpeg", ".webp", ".ico"].includes(extension)) return png(width, height, file);
  if (extension === ".pdf") return Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
  if (extension === ".zip") return Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
  return Buffer.from(`Synthetic ${extension} file for the test corpus: ${file}\n`);
}

// --- Generated pages ----------------------------------------------------------

function write(relative, content) {
  const target = path.resolve(output, relative);
  if (!target.startsWith(output + path.sep)) throw new Error(`${relative} leads outside the corpus`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function archivePage(title, body, lang = "en") {
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
</head>
<body>
  <main>
    <h1>${title}</h1>
${body}
  </main>
</body>
</html>
`;
}

const DESCRIPTION = [
  "Creature NUMBER is described here at the length of a cached encyclopedia entry, which often runs",
  "to several sentences: where it lives, how it evolves, what its type matchups are, and which games",
  "it appears in. The description wraps across several lines in a narrow view, and the table as a",
  "whole reaches the size of the largest pages in a cache of this kind, so that preparing the copy",
  "and laying it out are measured at that size rather than at the size of a short test page. It also",
  "mentions the creature's number, NUMBER, so that every row differs from the others.",
].join(" ");

function largePage() {
  const directory = "Cache/Websites/Example Encyclopedia/Every Creature, 1–500";
  const rows = Array.from({ length: 500 }, (_, index) => {
    const number = String(index + 1).padStart(3, "0");
    return `        <tr>
          <th scope="row">
            <img src="2026-04-01/sprite-${number}.png" alt="Creature ${number}" width="32" height="32">
            Creature ${number}
          </th>
          <td>${(index % 18) + 1}</td>
          <td><a href="https://encyclopedia.example.org/wiki/Creature_${number}">Creature ${number} on the encyclopedia</a></td>
          <td>${DESCRIPTION.replaceAll("NUMBER", number)}</td>
          <td>${DESCRIPTION.slice(0, 330).replaceAll("NUMBER", number)}</td>
        </tr>`;
  });
  write(
    `${directory}/2026-04-01.html`,
    archivePage(
      "Every Creature, 1–500",
      `    <table style="width: 100%">
      <caption>Every creature, by index number</caption>
      <thead>
        <tr>
          <th scope="col">Creature</th>
          <th scope="col">Type number</th>
          <th scope="col">Article</th>
          <th scope="col">Description</th>
          <th scope="col">Summary</th>
        </tr>
      </thead>
      <tbody>
${rows.join("\n")}
      </tbody>
    </table>`,
    ),
  );
  write(
    `${directory}/README.md`,
    "# Every Creature, 1–500\n\nA generated test page at the size of the largest cached pages: one table of 500 rows, each\nwith its own sprite.\n",
  );
}

function mirroredSite() {
  const site = "Cache/Repositories/Example's Créature Site";
  const games = {
    "Gen 1": [["Red & Blue", "rgby"], ["Yellow", "rgby"]],
    "Gen 2": [["Gold & Silver", "gsc"], ["Crystal", "gsc"]],
    "Gen 3": [["Ruby & Sapphire", "rse"], ["FireRed & LeafGreen", "frlg"]],
    "Gen 4": [["Diamond & Pearl", "dppt"], ["HeartGold & SoulSilver", "hgss"]],
  };
  const head = (title, depth, extra = "") => {
    const up = "../".repeat(depth);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title} | Example's Créature Site</title>
<link rel="icon" href="${up}favicon.ico">
<link rel="stylesheet" href="${up}common.css">
<link rel="stylesheet" href="${up}light.css?v=4" id="theme">
<script src="https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js"></script>
<script src="${up}colors.js"></script>
${extra}</head>
<body>
<header class="banner"><a href="${up}index.html">Example's Créature Site</a></header>
<nav><a href="${up}General/">General</a> · <a href="${up}Main-Series/">Main series</a></nav>
`;
  };
  write(
    `${site}/index.html`,
    `${head("Home", 0, "<style>.welcome { border: 2px solid rgb(120, 60, 200); }</style>\n")}<main>
<h1>Welcome</h1>
<p class="welcome">A synthetic mirror of a fan site, for tests. <img src="sprites/000.png?v=2" alt="Logo" width="48" height="48"></p>
<ul>
${Object.entries(games)
  .flatMap(([generation, list]) =>
    list.map(([game, query]) => `<li><a href="Main-Series/${generation}/${game}.html?${query}">${game}</a></li>`),
  )
  .join("\n")}
</ul>
<p><a href="https://github.com/example/creature-site">Source on GitHub</a></p>
</main>
<script>document.documentElement.dataset.fixtureScript = "inline";</script>
</body>
</html>
`,
  );
  write(
    `${site}/General/index.html`,
    `${head("General", 1)}<main><h1>General</h1><p><a href="Types.html">Types</a> · <a href="Legacy.html">Legacy page</a></p></main></body></html>\n`,
  );
  write(
    `${site}/General/Types.html`,
    `${head("Types", 1)}<main><h1>Types</h1>
<h2 id="fire">Fire</h2><p><img src="../sprites/type-fire.png" alt="Fire" width="64" height="24"></p>
<h2 id="water">Water</h2><p><img src="../sprites/type-water.png" alt="Water" width="64" height="24"></p>
<p><a href="#fire">Back to fire</a></p></main></body></html>\n`,
  );
  write(
    `${site}/General/Legacy.html`,
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Legacy page | Example's Créature Site</title>
<style>@import url("../legacy.css");</style>
</head>
<body>
<header class="banner">Legacy page, styled through an import</header>
<p><a href="../index.html">Home</a></p>
</body>
</html>
`,
  );
  write(`${site}/Main-Series/index.html`, `${head("Main series", 1)}<main><h1>Main series</h1><ul>
${Object.keys(games)
  .map((generation) => `<li><a href="${generation}/">${generation}</a></li>`)
  .join("\n")}
</ul></main></body></html>\n`);
  let number = 1;
  for (const [generation, list] of Object.entries(games)) {
    write(
      `${site}/Main-Series/${generation}/index.html`,
      `${head(generation, 2)}<main><h1>${generation}</h1><ul>
${list.map(([game, query]) => `<li><a href="${game}.html?${query}">${game}</a></li>`).join("\n")}
</ul><p><a href="../">Up</a></p></main></body></html>\n`,
    );
    for (const [game, query] of list) {
      const sprites = Array.from({ length: 30 }, () => {
        const id = String(number++).padStart(3, "0");
        return `<tr><td><img src="../../sprites/${id}.png?v=2" alt="Creature ${id}" width="40" height="40"></td><td>Creature ${id}</td><td><a href="../../General/Types.html?${query}#fire">Fire</a></td></tr>`;
      });
      const byName =
        generation === "Gen 2" && game === "Gold & Silver"
          ? `<p><img src="legacy-sprites/025.png" alt="Legacy sprite" width="40" height="40"> <a href="Types.html">Types, by name</a></p>\n`
          : "";
      write(
        `${site}/Main-Series/${generation}/${game}.html`,
        `${head(game, 2)}<main><h1>${game}</h1>
<p><a href="#evolutions">Evolutions</a> · <a href="https://bulbapedia.example.org/wiki/${encodeURIComponent(game)}">Encyclopedia</a></p>
${byName}<table><thead><tr><th>Sprite</th><th>Name</th><th>Type</th></tr></thead><tbody>
${sprites.join("\n")}
</tbody></table>
<h2 id="evolutions">Evolutions</h2><p>Listed by the site's script, which needs JavaScript.</p>
<div id="evolution-list"></div>
</main>
<script src="https://unpkg.com/lodash@4.17.21/lodash.min.js"></script>
<script>document.getElementById("evolution-list").textContent = "Filled in by a script";</script>
</body>
</html>
`,
      );
    }
  }
  write(
    `${site}/common.css`,
    `/* The fixture's main stylesheet. */
@font-face {
  font-family: "Fixture Sans";
  src: url("fonts/FixtureSans.ttf") format("truetype");
}
:root { --fixture-common: loaded; }
body { margin: 0; font-family: "Fixture Sans", sans-serif; }
.banner { background: rgb(21, 101, 192) url("sprites/banner.png?v=3") no-repeat right center; color: white; padding: 16px; }
.banner a { color: white; }
nav { padding: 8px 16px; }
`,
  );
  write(`${site}/light.css`, `:root { --fixture-light: loaded; }\nbody { background: rgb(250, 250, 245); }\n`);
  write(`${site}/dark.css`, `:root { --fixture-dark: loaded; }\nbody { background: rgb(20, 20, 20); }\n`);
  write(`${site}/legacy.css`, `@import "common.css";\n:root { --fixture-legacy: loaded; }\n`);
  write(
    `${site}/colors.js`,
    `// Swaps the theme stylesheet in the original site; here it only marks that it ran.\ndocument.documentElement.dataset.fixtureScript = "colors.js";\n`,
  );
  write(`${site}/LICENSE`, "Synthetic test content; no license needed.\n");
  write(`${site}/README.md`, "# Example's Créature Site\n\nA generated mirror of a fan site, in the layout of a cached Git repository.\n");
}

// --- Assets for every reference -------------------------------------------------

const REFERENCE = /\b(?:src|href)\s*=\s*"([^"]+)"/g;
const CSS_URL = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
const ASSET = /\.(png|jpe?g|gif|webp|ico|pdf|zip|wc7|ttf)$/i;

function referencedAssets(file, text) {
  const references = [];
  const pattern = file.endsWith(".css") ? CSS_URL : REFERENCE;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#") || raw.startsWith("/")) continue;
    const clean = decodeURIComponent(raw.replace(/[?#].*$/, ""));
    if (!ASSET.test(clean)) continue;
    const width = Number(/width="(\d+)"/.exec(text.slice(match.index, match.index + 200))?.[1] ?? 16);
    const height = Number(/height="(\d+)"/.exec(text.slice(match.index, match.index + 200))?.[1] ?? 16);
    references.push({ path: path.posix.normalize(path.posix.join(path.posix.dirname(file), clean)), width, height });
  }
  return references;
}

function filesUnder(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(path.join(directory, entry.name), relative) : [relative];
  });
}

// The generator only replaces a directory it made itself, so that a mistaken
// argument deletes nothing.
const MARKER = ".html-page-viewer-corpus";
if (fs.existsSync(output) && fs.readdirSync(output).length > 0 && !fs.existsSync(path.join(output, MARKER))) {
  throw new Error(`${output} is not empty and was not made by this generator; choose a new or empty directory.`);
}
fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(path.join(here, "vault"), output, { recursive: true });
fs.writeFileSync(path.join(output, MARKER), "Generated by test/e2e/corpus/generate.mjs; replaced on every run.\n");
largePage();
mirroredSite();

let written = 0;
for (const file of filesUnder(output).filter((name) => /\.(html?|css)$/i.test(name))) {
  for (const reference of referencedAssets(file, fs.readFileSync(path.join(output, file), "utf8"))) {
    if (UNAVAILABLE.has(reference.path)) continue;
    if (reference.path.startsWith("../")) throw new Error(`${file} refers to ${reference.path}, outside the corpus`);
    const target = ELSEWHERE[reference.path] ?? reference.path;
    if (fs.existsSync(path.join(output, target))) continue;
    if (target.endsWith(".ttf")) continue;
    write(target, asset(target, reference.width, reference.height));
    written += 1;
  }
}

// The stylesheet's font, from the system when it has one; the tests skip the
// font check without it.
const font = ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "C:/Windows/Fonts/arial.ttf"].find((file) =>
  fs.existsSync(file),
);
if (font) write("Cache/Repositories/Example's Créature Site/fonts/FixtureSans.ttf", fs.readFileSync(font));

console.log(`Corpus in ${output}: ${filesUnder(output).length} files, ${written} generated assets.`);
