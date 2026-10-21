import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import esbuild from "esbuild";

// The security model promises that the plugin's own code makes no network
// requests and does not touch the clipboard. These checks read the bundle the
// build would produce, so they cover every source file and nothing else.
const bundle = (
  await esbuild.build({
    bundle: true,
    entryPoints: ["src/main.ts"],
    external: ["obsidian"],
    format: "cjs",
    platform: "browser",
    target: "es2022",
    write: false,
  })
).outputFiles[0].text;

describe("plugin code", () => {
  const forbidden: [string, RegExp][] = [
    ["the clipboard", /\bclipboard\b/],
    ["fetch", /\bfetch\s*\(/],
    ["XMLHttpRequest", /\bXMLHttpRequest\b/],
    ["WebSocket", /\bWebSocket\b/],
    ["EventSource", /\bEventSource\b/],
    ["sendBeacon", /\bsendBeacon\b/],
    ["Obsidian's request functions", /\brequest(Url)?\b/],
  ];
  for (const [name, pattern] of forbidden) {
    it(`does not use ${name}`, () => {
      assert.doesNotMatch(bundle, pattern);
    });
  }

  it("does not write to vault files", () => {
    assert.deepEqual(writesToVault(bundle), []);
  });

  it("would see the ways that code could write to vault files", () => {
    const writes = [
      "this.app.vault.modify(file, text)",
      "this.app.vault.delete(file)",
      "this.app.vault?.delete(file)",
      "vault\n  .create(path, text)",
      "const v = this.app.vault; v.delete(file)",
      'vault["delete"](file)',
      "const { delete: remove } = this.app.vault",
      "this.app.vault.adapter.write(path, text)",
      "this.app.fileManager.renameFile(file, path)",
      "this.app.fileManager.processFrontMatter(file, change)",
      "trashSystem(file)",
      "takes(this.app.vault)",
    ];
    for (const code of writes) assert.notDeepEqual(writesToVault(code), [], code);
    const reads = "const vault = this.app.vault; vault.getAbstractFileByPath(p); highlight.delete(r); el.remove(); doc.head.append(s)";
    assert.deepEqual(writesToVault(reads), []);
  });
});

/** The vault's members that the plugin may use: it only reads files and listens for changes. */
const VAULT_READS = new Set([
  "on",
  "off",
  "offref",
  "getConfig",
  "getName",
  "getResourcePath",
  "getAbstractFileByPath",
  "getFileByPath",
  "getFolderByPath",
  "getRoot",
  "getFiles",
  "getMarkdownFiles",
  "getAllLoadedFiles",
  "read",
  "cachedRead",
  "readBinary",
]);

/**
 * The places in code that could write to vault files. Write methods whose
 * names nothing else shares are refused anywhere; the vault adapter and the
 * file manager, which write, are not used at all; and the vault is only held
 * as a local named `vault` and used through the reads above, so that every use
 * of it can be seen by its name. Names such as `delete`, `remove`, and
 * `append` belong to the DOM, sets, and maps too, as the find bar uses them.
 */
function writesToVault(code: string): string[] {
  const found: string[] = [];
  const refuse = (pattern: RegExp): void => {
    for (const match of code.matchAll(pattern)) found.push(match[0]);
  };
  refuse(/\.\s*(modify|process|trash|rename|mkdir|rmdir|createBinary|createFolder|createNewMarkdownFile|writeBinary)\w*\s*\(/g);
  refuse(/\btrash\w*\s*\(/g);
  refuse(/\b(adapter|fileManager)\b/g);
  for (const match of code.matchAll(/\bvault\s*\??\.\s*(\w+)/g)) {
    if (!VAULT_READS.has(match[1])) found.push(match[0]);
  }
  for (const match of code.matchAll(/(?:(\w+)\s*=\s*)?this\.app\.vault\b(?!\s*\??\.)/g)) {
    if (match[1] !== "vault") found.push(match[0]);
  }
  refuse(/\bvault\s*\??\.?\s*\[/g);
  refuse(/[(,]\s*(?:this\.app\.)?vault\s*[,)]/g);
  return found;
}

describe("styles", () => {
  it("use no !important overrides", () => {
    assert.doesNotMatch(fs.readFileSync("styles.css", "utf8"), /!important/);
  });
});
