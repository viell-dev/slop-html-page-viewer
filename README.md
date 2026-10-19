# HTML Page Viewer (viell)

A personal fork of [HTML Page Viewer](https://github.com/viggomeesters/obsidian-html-page-viewer),
the Obsidian plugin by Viggo Meesters that opens HTML files in a vault, for reading saved web pages
and other local HTML in Obsidian.

[![CI](https://github.com/viell-dev/slop-html-page-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/viell-dev/slop-html-page-viewer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

The fork is not published: it is not in Obsidian's community plugin directory and has no releases.
It is built for its owner's vaults, and anyone may build and use it under the license.

## What it does

- Opens `.html` and `.htm` files in their own Obsidian view, as a rendered preview by default.
- Renders the page in a sandboxed frame, with scripts off by default. A toolbar button turns them on
  for the current tab only.
- Shows the source with HTML syntax highlighting and line numbers.
- Never writes to the files it opens.

These are upstream's features, unchanged so far. The fork is being set up, and the changes planned
for it are tracked as [issues](https://github.com/viell-dev/slop-html-page-viewer/issues):

- [local images, stylesheets, and media](https://github.com/viell-dev/slop-html-page-viewer/issues/7)
  in the rendered page;
- [a reading style that follows Obsidian's theme](https://github.com/viell-dev/slop-html-page-viewer/issues/8)
  for pages without styles of their own;
- [links that open where they should](https://github.com/viell-dev/slop-html-page-viewer/issues/9):
  external links in the browser, and links between vault files in Obsidian.

## How it differs from upstream

- Its plugin id is `viell-html-page-viewer` and its name "HTML Page Viewer (viell)", so that
  Obsidian never replaces it with an upstream release. Both plugins open `.html` and `.htm` files,
  so enable only one of them.
- `npm run build` works on Windows. The fix is
  [offered upstream](https://github.com/viggomeesters/obsidian-html-page-viewer/pull/1).

Changes that could serve upstream's users are kept separate from fork-only ones and offered upstream;
[issue #2](https://github.com/viell-dev/slop-html-page-viewer/issues/2) tracks them.
[CHANGELOG.md](CHANGELOG.md) is upstream's record of its releases.

## Install

Build the plugin from a checkout. It needs Node.js 24 and npm.

```sh
git clone https://github.com/viell-dev/slop-html-page-viewer.git
cd slop-html-page-viewer
npm ci
npm run build
```

1. Create the folder `.obsidian/plugins/viell-html-page-viewer/` in your vault.
2. Copy `main.js`, `manifest.json`, and `styles.css` into it.
3. Reload Obsidian, and enable **HTML Page Viewer (viell)** in **Settings → Community plugins**.
   Disable upstream's HTML Page Viewer first if it is installed.

## Security model

Scripts are off by default. With scripts on, the frame's sandbox gets `allow-scripts` and nothing
else: no same-origin access, forms, popups, or top-level navigation. The plugin itself makes no
network requests, does not use the clipboard, and does not edit vault files. A rendered page can
still load external images, stylesheets, fonts, or scripts that it refers to, as any browser would.
[SECURITY.md](SECURITY.md) has the details and how to report a vulnerability.

## Status

The fork is written and maintained by AI agents, and no person reviews the code. Changes are
accepted on their tests and on CI on Linux and Windows.

## Contributing, security, and license

[CONTRIBUTING.md](CONTRIBUTING.md) explains how to report a defect and how to make a change, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) what is expected of everyone who takes part. Report
vulnerabilities as [SECURITY.md](SECURITY.md) describes.

The fork is released under the [MIT license](LICENSE), as upstream is, and keeps upstream's
copyright notice. Upstream acknowledges that it was informed by the MIT-licensed
[JiaLinZhang24/obsidian-html-viewer](https://github.com/JiaLinZhang24/obsidian-html-viewer), and
includes no source code from it.
