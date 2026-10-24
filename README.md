# HTML Page Viewer (viell)

A personal fork of [HTML Page Viewer](https://github.com/viggomeesters/obsidian-html-page-viewer),
the Obsidian plugin by Viggo Meesters that opens HTML files in a vault, for reading saved web pages
and other local HTML in Obsidian.

[![CI](https://github.com/viell-dev/slop-html-page-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/viell-dev/slop-html-page-viewer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

The fork is not in Obsidian's community plugin directory. It is built for its owner's vaults; its
[releases](https://github.com/viell-dev/slop-html-page-viewer/releases) are for installing by hand,
and anyone may use it under the license.

## What it does

- Opens `.html` and `.htm` files in their own Obsidian view, as a rendered preview by default, and
  the files of any other extension that its settings list, which it shows as HTML too.
- Shows a page with its local files: images and stylesheets in the vault load as they would next to
  the file on disk. A reference that does not resolve as a path finds its file as Obsidian's own
  links do, by name or by a partial path.
- Shows pages without styles of their own in Obsidian's theme, light or dark: its colors and fonts,
  and its line width while **Readable line length** is on. The **Theme** button shows a page as a
  browser would instead.
- Follows links as Obsidian does: web links open outside Obsidian, in the default browser, links to
  other HTML pages open them in the viewer, links to notes and other vault files open them as
  Obsidian opens a file, and links within the page scroll to their target. Ctrl-click or a middle
  click opens a new tab. Hovering a link shows where it leads, and hovering an image shows its alt
  text, unless the page gives them titles of its own.
- Renders the page in a sandboxed frame, with scripts off by default. A toolbar button turns them on
  for the open page, and a setting can copy the page's local images, media, text tracks, fonts, and
  scripts into it, so that they load with scripts on too.
- Shows the source with HTML syntax highlighting and line numbers, wrapping long lines.
- Shows the source and the page side by side in its **Split** view, one above the other in a narrow
  pane. With scripts off, the two sides scroll in step, for a page that scrolls as a whole.
- Finds text in the source and, with scripts off, in the rendered page: the toolbar's search button,
  Ctrl+F while the viewer has focus, or the **Find in page** command opens a find bar, which
  highlights every match, up to 10,000, and moves between them with Enter and
  Shift+Enter; Escape closes it. In the page, a match stays within a paragraph or another block, and
  leaves out text that the page hides. In the split view, it finds in the source, which the page
  follows.
- Keeps a tab's **Theme** and **Rendered**, **Source**, or **Split** choice for the next page it
  shows, also after a note in between. A new tab starts rendered.
- Has settings for **Theme in new tabs**, on by default; **Scripts when a page opens**, off by
  default; **Local files with scripts on**, off by default; **Wrap long lines in the source view**,
  on by default; and **File extensions**, `html, htm` by default.
  On Obsidian 1.13 and later, these settings also appear in the global settings search.
- Never writes to the files it opens.

Planned changes are tracked as [issues](https://github.com/viell-dev/slop-html-page-viewer/issues).

### Limits

- **Stylesheets from the web do not apply**, apart from Google Fonts. Obsidian's own security policy
  allows a page only inline styles, so the viewer copies each linked stylesheet from the vault into
  the page it shows; it does not download stylesheets from the web. A local stylesheet applies only
  from a file whose name ends in `.css`.
- **With scripts on, local files load only when they are copied into the page.** Scripts run
  without access to Obsidian, and Obsidian does not serve vault files to such a page. Copied
  stylesheets still apply, and the **Local files with scripts on** setting copies the page's images,
  media, text tracks, fonts, and scripts into it as well: up to 32 MB for a page, scripts and fonts
  first, counting a file again for each place that uses it, and no file over 8 MB. Such a page takes
  about a second longer to open for every 8 MB. Files that a script loads itself, such as with
  `fetch`, modules that a module script imports, and pages in frames still do not load.
- **With scripts on, links work as in a browser frame:** the viewer cannot reach the page to follow
  them, so a link opens in the frame itself. For the same reason, the find bar then finds only in
  the source view, and the split view's sides scroll apart.
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
- Scripts are off again for each file that opens in a tab, as upstream's README promises, unless
  the settings start every page with them on.
- Its source view shows every character of the file and highlights it as HTML reads it, also where a
  tag or a comment continues over several lines. Upstream's leaves out the space after an attribute
  without a value, and highlights only the first line of such a tag.
- It has settings, a find bar, and a split view of the source beside the page.
- `npm run build` works on Windows. The fix is [offered
  upstream](https://github.com/viggomeesters/obsidian-html-page-viewer/pull/1).

Changes that could serve upstream's users are kept separate from fork-only ones and offered
upstream; [issue #2](https://github.com/viell-dev/slop-html-page-viewer/issues/2) tracks them.
[CHANGELOG.md](CHANGELOG.md) lists the fork's releases, and upstream's before them.

## Install

1. Download `viell-html-page-viewer-<version>.zip` from the newest
   [release](https://github.com/viell-dev/slop-html-page-viewer/releases).
2. Unzip it into your vault's `.obsidian/plugins/` folder, so that
   `.obsidian/plugins/viell-html-page-viewer/` holds `main.js`, `manifest.json`, and `styles.css`.
3. In **Settings → Community plugins**, turn off upstream's HTML Page Viewer if it is installed,
   and turn on **HTML Page Viewer (viell)**; if it is not listed yet, reload the list of installed
   plugins.

To build it from a checkout instead, with Node.js 24 and npm, run `npm ci` and `npm run build`, and
copy the same three files from the checkout's root.

**Compatibility.** The fork supports Linux desktop with Obsidian 1.5.0 or later. Each change is
tested in Obsidian 1.5.3, the oldest public release that this allows, and in the latest release.
Windows is a development host with extra build and unit-test coverage; Linux Obsidian also runs
in Docker there. Windows Obsidian is not a supported target. macOS and mobile are out of scope,
and the plugin is marked desktop-only. Wider platform support can be reconsidered if the fork
moves beyond personal use.

**Update.** Install the newer release the same way, replacing the three files, then turn the
plugin off and on again in **Settings → Community plugins**, or restart Obsidian. Its settings are
kept. To go back to an earlier version, install that release the same way.

**Remove.** Uninstall the plugin in **Settings → Community plugins**. That deletes its folder,
`.obsidian/plugins/viell-html-page-viewer/`, with its settings, the only file it writes; turning it
off instead keeps them. It never changes the pages it opens.

## Keyboard

The toolbar's buttons are ordinary buttons with labels, reached with Tab. **Scripts** and
**Theme** say whether they are on. Ctrl+F, while the viewer has focus, opens the find bar. In it,
Enter moves to the next match and Shift+Enter to the previous one, Escape closes
it, and the number of matches is announced as it changes. The **Find in page** command has no
hotkey of its own; one can be set in **Settings → Hotkeys**.

## Troubleshooting

- **The plugin is not listed** after unzipping: check that its folder is named
  `viell-html-page-viewer` and directly holds `main.js`, `manifest.json`, and `styles.css`, then
  reload the list of installed plugins.
- **HTML files open in another viewer**: upstream's HTML Page Viewer or another plugin has the
  extension. Turn the other plugin off; the **File extensions** setting says when another view has
  an extension.
- **A page shows without its images**: with scripts on, local files load only with **Local files
  with scripts on**, and then only within its limits. Files outside the vault never load. A
  reference that resolves to no vault file, by path or by name, shows nothing.
- **A page shows without its styles**: stylesheets from the web do not apply, apart from Google
  Fonts, and a local stylesheet applies only from a `.css` file.
- **Find in page finds nothing in the page**, or **the split view's sides scroll apart**: with
  scripts on, the viewer cannot reach the page. Turn scripts off. The split view also follows only a
  page that scrolls as a whole.
- **Ctrl+F opens Obsidian's search**: the viewer does not have focus. Click in it first, or use the
  **Find in page** command.

If none of these explains it, [report a defect](CONTRIBUTING.md#report-a-defect).

## Security model

The view shows a copy of the page, never the file itself, in a sandboxed frame. Scripts are off
unless the toolbar or the settings turn them on, and scripts and same-origin access are never
granted together:

- **Scripts off:** the sandbox grants only `allow-same-origin`, so that the page can load the
  vault's files. It cannot run scripts, submit forms, open popups, or navigate Obsidian.
- **Scripts on:** the sandbox grants only `allow-scripts`. The page cannot reach Obsidian or the
  vault's files, apart from those copied into it: its `.css` stylesheets, and, with **Local files
  with scripts on**, the images, media, text tracks, fonts, and scripts it names.

The copy carries a policy that lets Obsidian's file URLs load only from inside the vault. The plugin
itself makes no network requests, does not use the clipboard, and only reads vault files: the page,
the `.css` files it links as stylesheets, and the files it copies into a page with scripts on. The
one file it writes is its own settings. A rendered page can still load the images, fonts, or
scripts on the web that it refers to, as any browser would. [SECURITY.md](SECURITY.md) has the
details and how to report a vulnerability.

## Status

The fork is written and maintained by AI agents, and no person reviews the code. Changes are
accepted on their tests and on CI on Linux and Windows. These include tests in Obsidian itself, on
the oldest and the newest supported version, of a synthetic vault of archived web pages; on the
newest version, each page is also compared with how the previous build showed it.
[TESTING.md](TESTING.md) lists which tests back each promise here, and what they do not cover.

## Contributing, security, and license

[CONTRIBUTING.md](CONTRIBUTING.md) explains how to report a defect and how to make a change, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) what is expected of everyone who takes part. Report
vulnerabilities as [SECURITY.md](SECURITY.md) describes.

The fork is released under the [MIT license](LICENSE), as upstream is, and keeps upstream's
copyright notice. Upstream acknowledges that it was informed by the MIT-licensed
[JiaLinZhang24/obsidian-html-viewer](https://github.com/JiaLinZhang24/obsidian-html-viewer), and
includes no source code from it.
