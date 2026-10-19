// Compares the corpus results of the plugin with those of the frozen
// prototype build, on the same Obsidian version: it fails if the prototype
// showed an image that the plugin does not, and prints how the two differ.
//
// Usage: node test/e2e/corpus/compare.mjs [results directory]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const directory = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../../../test-results/e2e"));
const read = (name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
const prototypes = fs.readdirSync(directory).filter((name) => /^corpus-prototype-.+\.json$/.test(name));

if (prototypes.length === 0) {
  console.log("No prototype results to compare with.");
  process.exit(0);
}

let regressions = 0;
for (const name of prototypes) {
  const prototype = read(name);
  const viewerName = `corpus-viewer-${prototype.version}.json`;
  if (!fs.existsSync(path.join(directory, viewerName))) {
    console.error(`Missing ${viewerName} to compare with ${name}.`);
    process.exit(1);
  }
  const viewer = read(viewerName);
  const totals = { prototype: 0, viewer: 0, images: 0, styledPrototype: 0, styledViewer: 0, pages: 0 };
  for (const [page, before] of Object.entries(prototype.pages)) {
    const after = viewer.pages[page];
    if (!after) {
      console.error(`The plugin's results lack ${page}.`);
      regressions += 1;
      continue;
    }
    totals.pages += 1;
    before.images.forEach((image, index) => {
      totals.images += 1;
      if (image.loaded) totals.prototype += 1;
      if (after.images[index]?.loaded) totals.viewer += 1;
      if (image.loaded && !after.images[index]?.loaded) {
        console.error(`Regression on ${page}: the prototype shows ${image.src}, the plugin does not.`);
        regressions += 1;
      }
    });
    if (before.markers.common === "loaded") totals.styledPrototype += 1;
    if (after.markers.common === "loaded") totals.styledViewer += 1;
  }
  console.log(
    `Obsidian ${prototype.version}, ${totals.pages} pages: images shown by the prototype ${totals.prototype}/${totals.images}, ` +
      `by the plugin ${totals.viewer}/${totals.images}; pages with the mirrored site's stylesheet applied: ` +
      `prototype ${totals.styledPrototype}, plugin ${totals.styledViewer}.`,
  );
}
process.exit(regressions === 0 ? 0 : 1);
