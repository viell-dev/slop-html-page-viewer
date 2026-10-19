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
- Shows a page with its local files: images and stylesheets in the vault load as they would next to
  the file on disk.
- Shows pages without styles of their own in Obsidian's theme, light or dark: its colors, fonts, and
  line width. The **Theme** button shows a page as a browser would instead.
- Follows links as Obsidian does: web links open outside Obsidian, in the default browser, links to
  other HTML pages open them in the viewer, links to notes and other vault files open them as
  Obsidian opens a file, and links within the page scroll to their target. Ctrl-click (Cmd-click on
  macOS) or a middle click opens a new tab.
- Renders the page in a sandboxed frame, with scripts off by default. A toolbar button turns them on
  for the current tab only.
- Shows the source with HTML syntax highlighting and line numbers.
- Never writes to the files it opens.

Planned changes are tracked as [issues](https://github.com/viell-dev/slop-html-page-viewer/issues).

### Limits

- **Stylesheets from the web do not apply**, apart from Google Fonts. Obsidian's own security policy
  allows a page only inline styles, so the viewer copies each linked stylesheet from the vault into
  the page it shows; it does not download stylesheets from the web.
- **With scripts on, local files do not load.** Scripts run without access to Obsidian, and Obsidian
  does not serve vault files to such a page. Copied stylesheets still apply. [Issue
  #11](https://github.com/viell-dev/slop-html-page-viewer/issues/11) plans another option.
- **With scripts on, links work as in a browser frame:** the viewer cannot reach the page to follow
  them, so a link opens in the frame itself.
- **A link to a part of another page** opens that page at its top.
- **Files outside the vault never load**, even when a page refers to them, and links to them are
  refused.

## How it differs from upstream

- It shows a page's local files, gives unstyled pages Obsidian's theme, and follows links in
  Obsidian. Upstream loads the file itself into the frame, where the page's local images and
  stylesheets do not load.
- Its plugin id is `viell-html-page-viewer` and its name "HTML Page Viewer (viell)", so that
  Obsidian never replaces it with an upstream release. Both plugins open `.html` and `.htm` files,
  so enable only one of them.
- Scripts are off again for each file that opens in a tab, as upstream's README promises.
- `npm run build` works on Windows. The fix is [offered
  upstream](https://github.com/viggomeesters/obsidian-html-page-viewer/pull/1).

Changes that could serve upstream's users are kept separate from fork-only ones and offered
upstream; [issue #2](https://github.com/viell-dev/slop-html-page-viewer/issues/2) tracks them.
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

The view shows a copy of the page, never the file itself, in a sandboxed frame. Scripts are off by
default, and scripts and same-origin access are never granted together:

- **Scripts off:** the sandbox grants only `allow-same-origin`, so that the page can load the
  vault's files. It cannot run scripts, submit forms, open popups, or navigate Obsidian.
- **Scripts on:** the sandbox grants only `allow-scripts`. The page cannot reach Obsidian or the
  vault's files.

The copy carries a policy that lets Obsidian's file URLs load only from inside the vault. The plugin
itself makes no network requests, does not use the clipboard, and only reads vault files: the page
and the stylesheets it links. A rendered page can still load the images, fonts, or scripts on the
web that it refers to, as any browser would. [SECURITY.md](SECURITY.md) has the details and how to
report a vulnerability.
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
