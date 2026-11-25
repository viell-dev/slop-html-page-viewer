# HTML Page Viewer (viell)

[![CI](https://github.com/viell-dev/slop-html-page-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/viell-dev/slop-html-page-viewer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

A personal fork of [HTML Page Viewer](https://github.com/viggomeesters/obsidian-html-page-viewer),
the Obsidian plugin by Viggo Meesters that opens HTML files in a vault, for reading saved web pages
and other local HTML in Obsidian.

The fork is not in Obsidian's community plugin directory. It is built for its owner's vaults; its
[releases](https://github.com/viell-dev/slop-html-page-viewer/releases) are for installing by hand,
and anyone may use it under the license.

This guide describes **0.6.0**, the latest installable release, on **Linux desktop**.
See [troubleshooting](#troubleshooting) for help and [the security model](#security-model) for
what a page can access.

## Install

1. Download `viell-html-page-viewer-<version>.zip` from the newest
   [release](https://github.com/viell-dev/slop-html-page-viewer/releases/latest).
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

## Try a saved page

In a test vault, create a `Saved` folder. Download the synthetic
[Example article.html](test/e2e/vaults/pages/Saved/Example%20article.html) and its
[figure.png](test/e2e/vaults/pages/Saved/2026-01-15/figure.png) (use GitHub's **Download raw
file**), and arrange them like this:

```text
Saved/
  Example article.html
  2026-01-15/
    figure.png
```

In Obsidian's file list, expand **Saved** and click **Example article.html**. With the default
settings, the rendered view shows an **Example article** heading, a green square with its caption,
a small table, and text in Obsidian's theme. The toolbar says **Scripts OFF**; scripts cannot run.
The image loads from the folder beside the page. The example's links to another saved page and a
note need those files too; they are not needed to view this page and image.

Use **Source** to read the HTML or **Split** to see it beside the preview. Neither view edits the
file. Keep scripts off for ordinary saved pages; see [Limits](#limits) before enabling them.

## What it does

- Opens `.html` and `.htm` files in their own Obsidian view, as a rendered preview by default, and
  the files of any other extension that its settings list, which it shows as HTML too.
- Shows a page with its local files: images and stylesheets in the vault load as they would next to
  the file on disk, also inside shadow DOM, which pages saved with their web components can contain.
  A reference that does not resolve as a path finds its file as Obsidian's own links do, by name or
  by a partial path.

  The viewer finds a page's files only where browsers read them. Its stylesheets are an HTML or SVG
  `<style>` element's own text and a stylesheet `<link>` in HTML; the elements inside an SVG
  `<style>`, a MathML `<style>`, and a `<link>` inside SVG or MathML stay as the page has them. A
  stylesheet names files only with its `url()`s and its imports, and only the imports at its start
  count, after nothing but `@charset`, `@supports-condition` rules, other imports, and `@layer`
  statements before the first import. Text inside CSS strings and comments, such as `content: "url(icon.png)"`, stays as the
  page has it. Version 0.6.0 reads the stylesheets of these elements whatever their `type`, and of
  a disabled link.

  **Unreleased (#147):** the viewer reads only the `<style>` and `<link>` elements that Chromium
  applies, and leaves the others as the page has them, reading and copying nothing for them. A
  `<style>` applies with no `type`, an empty one, or `text/css` in any case, without parameters or
  spaces. A link applies unless it has a `disabled` attribute, with no `type`, or one whose part
  before any `;`, trimmed of spaces, is empty or `text/css` in any case, such as
  `TEXT/CSS ; charset=utf-8`. Other types, such as `text/x-scss`, keep another stylesheet language
  in the page for its scripts. A page whose only stylesheets are such elements shows as a page
  without styles of its own. A disabled link that the page's scripts enable later stays without its
  stylesheet, as the viewer's frame loads no linked stylesheets but Google Fonts
  ([#147](https://github.com/viell-dev/slop-html-page-viewer/issues/147)).

  **Unreleased (#169):** the viewer also reads only the titled stylesheets that Chromium applies.
  In the page itself, an untitled `<style>` or stylesheet link applies, and a titled one only with
  the title of the preferred set: the first title of a `<style>` or a stylesheet link, also one
  whose file is missing, or the content of a `<meta http-equiv="Default-Style">` before it. An
  `alternate stylesheet` link applies only with that title. In shadow DOM, titles do not matter,
  and no alternate link applies. The others stay as the page has them, and nothing is read or
  copied for them; a page whose script switches to another set gets none of that set's linked
  stylesheets, and its `<style>` elements without their imports
  ([#169](https://github.com/viell-dev/slop-html-page-viewer/issues/169)).

  **Unreleased (#148):** with scripts on, a `<noscript>` holds text, as in browsers: the viewer
  reads and copies nothing for it, nothing in it shows, and its stylesheets' titles name no set.
  Version 0.6.0 prepares its content with scripts on too, so that files which the page never shows
  take from its copy limits, and shows an image of a `<noscript>` in the `<head>`. With scripts off,
  its content shows, as before
  ([#148](https://github.com/viell-dev/slop-html-page-viewer/issues/148)).

  **Unreleased (#192):** a link is a stylesheet link only when a space, tab, line feed, or form feed
  separates `stylesheet` from the other words of its `rel`, as HTML splits it. With a no-break space
  or another space between them, the words are one, browsers load nothing, and the viewer reads
  nothing for it; version 0.6.0 reads and applies such a link. A URL attribute keeps such a space at
  its start or end, and a `srcset` one inside a URL, as browsers read them, so that with **Local
  files with scripts on** the file of that name is copied, not one without the space. Obsidian 1.5.3
  splits `rel` only at spaces and line feeds, so there a link with a tab, a form feed, or a carriage
  return written as `&#13;` in its `rel` applies in the viewer but not in a browser
  ([#192](https://github.com/viell-dev/slop-html-page-viewer/issues/192)).

  **Unreleased (#155):** each of the page's own stylesheets ends where CSS ends it, as an imported
  one does: an import without its `;` at the end of a `<style>` or a linked stylesheet counts, and
  an unquoted URL at the end of a linked stylesheet is that stylesheet's, resolved from its folder
  ([#155](https://github.com/viell-dev/slop-html-page-viewer/issues/155)).

  **Unreleased (#194):** so does a `style` attribute: a `url(`, or a string in `image-set()` or
  `-webkit-image-set()`, that its end leaves open, as in `style='background-image: url("icon.png'`,
  names its file, which browsers load; another string left open there names nothing. Before a
  later `<base>`, such a reference resolves from the page's folder, a name that does not resolve as
  a path is found by name, and with **Local files with scripts on** its file is copied. The
  attribute keeps its text, apart from such a reference
  ([#194](https://github.com/viell-dev/slop-html-page-viewer/issues/194)).

  **Unreleased (#179):** a string in `image-set()` or `-webkit-image-set()`, as in
  `image-set("icon.png" 1x, "icon@2x.png" 2x)`, names a file as a `url()` does: in a linked or
  imported stylesheet, it resolves from that stylesheet's folder, a name that does not resolve as a
  path is found by name, and with **Local files with scripts on** its file is copied into the page.
  What making it absolute adds counts toward the page's limits on stylesheets, as for a `url()`.
  Other strings, such as those of `type()`, `format()`, and `local()`, still name nothing
  ([#179](https://github.com/viell-dev/slop-html-page-viewer/issues/179)).

  **Unreleased (#185):** the page's stylesheets resolve as Chromium resolves them while it reads the
  page, against the base that applies where each stands. A `<style>`, with its imports, a stylesheet
  link, and a `style` attribute before the page's `<base>`, such as one at the end of its `<head>`,
  resolve against the page's own folder, also in shadow DOM before the `<base>`; the others, and the
  content of templates that a script adds, resolve against the `<base>`. The viewer makes the URLs
  of those before it absolute, and what that adds counts toward the page's limits on stylesheets;
  past them, such a stylesheet keeps its URLs as written, which then resolve against the `<base>`,
  though with **Local files with scripts on** their files are still copied from the page's folder. A
  `<base>` that Chromium ignores, one inside SVG and one with a `data:` or `javascript:` URL, no
  longer moves the page's files
  ([#185](https://github.com/viell-dev/slop-html-page-viewer/issues/185)).

  **Unreleased (#187):** so do the page's other references before its `<base>`: images, also those
  of a `srcset` and a `<picture>`, image inputs, video posters, video and audio and their sources,
  text tracks, frames, scripts, and SVG `<use>` and `<image>`, also in shadow DOM. The viewer makes
  their URLs absolute against the page's own address, and with **Local files with scripts on**
  copies their files from the page's folder. Chromium resolves image inputs, posters, media, their
  sources, text tracks, and SVG `<image>` a moment after it reads them, so in a browser they come
  from the page's folder in a longer page or one with a script before the `<base>`, but from the
  `<base>`'s folder in a short page; see [Limits](#limits). What making these URLs absolute adds
  to the copy does not count toward the page's limits on stylesheets: each grows by about the
  length of the page folder's address, so the copy grows with the page's own markup, as with
  references found by name ([#184](https://github.com/viell-dev/slop-html-page-viewer/issues/184)).

  **Unreleased (#198):** so do the `background` attributes of the `<body>` and of tables, their
  columns, row groups, rows, and cells, and SVG `<feImage>` and `<script>`, which version 0.6.0
  leaves to the `<base>`. A name of theirs that does not resolve as a path is found by name, and
  with **Local files with scripts on** their files are copied, which 0.6.0 does not do, so that
  such backgrounds and filter images show and such scripts run. Chromium resolves an `<feImage>`
  and an SVG script before the `<base>` in every page, and a `background` attribute as it does an
  image input
  ([#198](https://github.com/viell-dev/slop-html-page-viewer/issues/198)).

- Shows pages without styles of their own in Obsidian's theme, light or dark: its colors and fonts,
  and its line width while **Readable line length** is on. The **Theme** button shows a page as a
  browser would instead.
- Follows links as Obsidian does: web links open outside Obsidian, in the default browser, links to
  other HTML pages open them in the viewer, links to notes and other vault files open them as
  Obsidian opens a file, and links within the page scroll to their target. Following HTML and SVG
  links (including legacy `xlink:href`) is supported, also in shadow DOM, which pages saved with
  their web components can contain.

  A link to a vault file opens as a link in a note in the page's tab does: in that tab, or with
  Ctrl-click or a middle click in a new tab beside it, also while a tab in another tab group or
  window is the active one. A link in a pinned tab opens where one in a pinned note does. In a
  sidebar, a link opens in the sidebar's tab, and Ctrl-click or a middle click opens a new tab in
  the main area.

  Hovering an HTML link shows where it leads, and hovering an image shows its alt text, also inside
  shadow DOM, unless the page gives them titles of its own. So does hovering an SVG link that
  nothing inside names. An SVG link with text, a labelled or titled shape, a `<use>` icon, or HTML
  content in a `<foreignObject>` inside shows none: Chromium reads an SVG link's tooltip as its name
  for assistive technology, in place of the name that its content gives it, so the viewer leaves
  that name.

- Renders the page in a sandboxed frame, with scripts off by default. A toolbar button turns them on
  for the open page, and a setting can copy the page's local images, media, text tracks, fonts, and
  scripts into it, so that they load with scripts on too.

- Shows the source with HTML syntax highlighting and line numbers, wrapping long lines.
- Shows the source and the page side by side in its **Split** view, one above the other in a narrow
  pane. With scripts off, the two sides scroll in step, for a page that scrolls as a whole, also
  where the page's content is inside shadow DOM.
- Finds text in the source and, with scripts off, in the rendered page: the toolbar's search button,
  Ctrl+F while the viewer has focus, or the **Find in page** command opens a find bar, which
  highlights every match, up to 10,000, and moves between them with Enter and Shift+Enter; Escape
  closes it, and closing keeps the query. In the split view, it finds in the source, which the page
  follows.

  In the page, find searches the text that Obsidian paints, also in the page's shadow roots and
  slots. A match stays within a paragraph or another block, and within one shadow root. Find leaves
  out text that the page hides, such as with `display: none`, `visibility: hidden`, or zero opacity,
  and fallback content and SVG resources that Obsidian never paints. It finds painted SVG text, also
  directly in `foreignObject`, and a closed select's chosen option, which it cannot highlight;
  multiple selects, list boxes, and option `label` attributes are not searched.

- Keeps a tab's **Theme** and **Rendered**, **Source**, or **Split** choice for the next page it
  shows, also after a note in between. A new tab starts rendered.
- When its tab moves to another tab group or window, a page keeps the theme and line width that it
  shows and, for a page that scrolls as a whole, its place, and the split view's two sides stay in
  step there. The place is the part of the page at the window's top, so it holds where the page
  wraps differently in its new pane. The **Source** view stays scrolled as far as it was; where long
  lines wrap differently in its new pane, that can show other lines. A tab that moves while another
  tab of its tab group shows, as from its tab header's menu, shows its page from its top
  ([#186](https://github.com/viell-dev/slop-html-page-viewer/issues/186)).

  **Unreleased (#186):** a tab that moves while hidden no longer shows its page from its top: it
  shows it where it was, and the split view's two sides in step there. So does a hidden tab whose
  tab group Obsidian lays out anew, as for **Split down** in the tab in front of it. A page whose
  scrolling had not been at rest for a tenth of a second when the tab hid shows where it rested
  before that scroll; after **Split down**, the split view's source then shows where it was
  scrolled, apart from the page.

  **Unreleased (#189):** after a move, also one while the tab was hidden, the **Source** view shows
  the line that was at its top, as its long lines wrap in the new pane, instead of the same pixels,
  which can show other lines.

  **Unreleased (#195):** after a move, the split view's side that was scrolled last leads, as when
  Obsidian shows a hidden tab again. Where that was the source, it keeps the line that was at its
  top and the page follows it, instead of the page leading, which took the source to other lines
  among the many short lines of a long `<head>`.

  **Unreleased (#178):** a page that scrolls as a whole also keeps its place when Obsidian shows its
  tab again after hiding it, as after another tab of its tab group or a collapsed sidebar, instead
  of showing from its top. In the split view, both sides go back where they were and stay in step,
  also where the source's long lines wrap. The **Source** view, and the parts of a page that scroll
  by themselves, keep their place there, as they did before.

  **Unreleased (#182):** where the pane changed width while the tab was hidden, as when a sidebar
  opened or closed meanwhile, the page shows the part that was at its top, and the split view's
  source the line that was at its top, as they wrap now. A page that was still scrolling when the
  tab hid, or stopped less than a tenth of a second before, goes back as far down as it was, which
  can show another part there.

  **Unreleased (#201):** a page that had shown only for a moment, as while stepping through a tab
  group's tabs, shows the part that was at its top there too, however soon its tab shows again.

  **Unreleased (#189):** the **Source** view shows the line that was at its top there too. A
  source, unlike a page, keeps its line also where its tab hid or moved within a tenth of a second
  of a scroll; one made in the same instant as the hide or the move is not kept.

  **Unreleased (#204):** with scripts on, the split view's source does the same: it shows the line
  that was at its top when its tab shows again and after a move, though it and the page still scroll
  apart and the page starts again from its top.

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
- **Some imports of vault stylesheets do not apply.** The viewer copies a page's imports of
  stylesheets in the vault into the page, but leaves these as imports, which Obsidian's policy keeps
  the page from loading:
  - imports into cascade layers or with support conditions, such as `@import "base.css" layer;`
    ([#151](https://github.com/viell-dev/slop-html-page-viewer/issues/151));
  - imports after a rule that browsers drop as invalid, such as an unknown at-rule, which browsers
    still apply: telling which rules are valid would take a CSS parser;
  - an import with media conditions of a stylesheet that has a `}` outside any block: wrapped in
    `@media`, as the viewer copies other such imports, that `}` would end the wrapper early.

  **Unreleased (#151):** imports into cascade layers apply, copied into `@layer` blocks, which take
  the places in the layer order that the imports give, and imports with support conditions apply
  in `@supports` blocks where Obsidian's Chromium applies such imports. Obsidian 1.5.3's Chromium
  114 never applies them, and neither does the viewer there. Imports with a scope, such as
  `@import "card.css" scope(.card);`, still stay imports: no Chromium in Obsidian applies them. A
  stylesheet with a `}` outside any block stays an import with any of these conditions. One that
  is empty still declares its layer where its import is, as an import does
  ([#151](https://github.com/viell-dev/slop-html-page-viewer/issues/151)).

- **Copying an import can change what CSS reads in the stylesheets**
  ([#152](https://github.com/viell-dev/slop-html-page-viewer/issues/152)). The viewer puts an
  imported stylesheet's text where its import was, where CSS reads some of it as it would not in a
  stylesheet of its own. An import after that text, such as one of Google Fonts, does not apply,
  and neither does one inside the `@media` block that an import's media conditions put around it.
  There, `<!--` and `-->` start a rule, which keeps it from applying. An imported stylesheet's
  `@namespace` rule applies to the importing stylesheet's later rules too, and after another
  imported stylesheet's rules, it does not apply at all.

  **Unreleased (#152):** after copied rules, an import of Google Fonts, which Obsidian's policy
  loads, an import into a cascade layer, which declares the layer where it counts, or an import
  with conditions that the viewer does not read, such as a scope, starts a `<style>` element of
  its own, together with the rules after it. It then applies, and every rule keeps its place in
  the cascade. Any other import that stays an import does nothing wherever it is, and stays where
  it is. The new elements come just before the page's own, with its `media`, `title`, and `type`,
  and the page sees them: a selector that counts elements, such as `:nth-child(2)` beside a
  `<style>`, can match another element, and the page's scripts find more stylesheets through
  `document.styleSheets` or `document.querySelector("style")`. The viewer adds at most 1,000 of
  them for a page; past that, such an import stays where it is, as in 0.6.0.

  An import inside a stylesheet imported with conditions gets those conditions in its own, as
  `@import url(…) screen;`, unless one import cannot have both: with an anonymous layer around it,
  an anonymous layer of its own inside a named one, or media conditions of its own inside others.
  Such an import stays inside the blocks, where it never counts, so its layer, if it has one, comes
  in the layer order where that layer is next declared, later than in Chromium. `<!--` and `-->`
  between an imported stylesheet's rules become spaces, and text of nothing but comments and spaces
  takes no block. What the viewer adds for conditions, the blocks, the conditions added to imports,
  and the attributes of the `<style>` elements it adds, counts toward the page's 16 million
  characters of stylesheets (#154). Past them, a stylesheet imported with conditions goes in one
  block, with its kept imports inside, where they never count, and if even that does not fit, its
  import stays an import. `@namespace` rules still apply as before.

- **A page whose stylesheets import each other many times can keep the viewer preparing it for a
  long time**, and Obsidian may not respond meanwhile, also when it opens such a page again at its
  next start. The viewer follows each stylesheet's imports up to eight deep, but nothing bounds how
  many imports each stylesheet has, so the work multiplies with each level
  ([#154](https://github.com/viell-dev/slop-html-page-viewer/issues/154)).

  **Unreleased (#154):** for each page, also its shadow DOM, the viewer follows at most 1,000 links
  and imports of vault stylesheets, and copies at most 16 million characters of the stylesheets'
  text, counting a stylesheet's text as preparing writes it into the page (#177) when it follows a
  link or import of it. Each link and
  import that it follows counts, also when its stylesheet is missing, too large, or then left as an
  import. A repeated link of a stylesheet in the page, or import of it in one of the page's own
  `<style>` elements, gets what the first link or import of it got, once the limits have left that
  whole, and is not followed again: a
  repeat of a stylesheet copied whole counts only the text that it adds to the copy, with its
  imports in it and its URLs made absolute, and a repeat of one that is missing or cannot be read
  counts nothing. So a page of components that each link the same stylesheet shows whole. The
  links and imports past either limit stay links and imports, which
  Obsidian's policy keeps from loading, so such a page shows only some of its styles, without
  keeping the viewer preparing it. A smaller stylesheet after one too large for what remains is
  still copied. Obsidian still does not respond while the viewer prepares a page, about a third to
  half a second for each million characters of stylesheets that it copies
  ([#158](https://github.com/viell-dev/slop-html-page-viewer/issues/158)).

  **Unreleased (#177):** a stylesheet's text counts as preparing writes it into the page: closed
  where CSS ends it, with its URLs made absolute against its own address or pointed at the file
  found by name, and with each of its imports as long as the copy writes one that stays an import,
  also when the viewer copies the imported stylesheet in its place. The limit counts that text, not
  the copy that the view then serializes from it, which character references and escapes can make
  several times longer ([#183](https://github.com/viell-dev/slop-html-page-viewer/issues/183)). A
  page's own `<style>` keeps its URLs as written, which the copy's `<base>` resolves as the page
  does, apart from those found by name, and only what its imports that stay imports add counts; one
  before the page's `<base>`, and a `style` attribute there, get their URLs made absolute instead,
  and what that adds counts too
  ([#185](https://github.com/viell-dev/slop-html-page-viewer/issues/185)).
  Its own text, its other `style` attributes, and the page's other references count nothing, and the
  references found by name there can make the copy far longer than the page
  ([#184](https://github.com/viell-dev/slop-html-page-viewer/issues/184)). A stylesheet whose text,
  so rewritten, would not fit stays a link or import, as one too large does, takes nothing from the
  limit, and its imports are not followed: with its URLs as written, they would resolve against the
  page, and its images and fonts would not load. A repeat of its link or import stays a link or
  import without being prepared again. A `<style>` whose imports that stay imports would not fit
  keeps its text as CSS closes it, apart from references found by name, and its imports stay
  imports. What preparing such stylesheets and `<style>` elements wrote before it stopped counts
  toward a limit of its own, of 32 million characters for each page, and the viewer copies a
  stylesheet only within what remains of both: once that limit is spent, it copies no further
  stylesheet, also one that would fit. So what it rewrites of stylesheets that it then leaves out
  stays within that limit, apart from the text that closes the last of them, which counts at once
  and can be as long as that stylesheet
  ([#177](https://github.com/viell-dev/slop-html-page-viewer/issues/177)).

- **Unreleased (#185):** an element after a page's late `<base>` that repeats one before it can
  show its `style` attribute's images from the `<base>`'s folder, where Chromium shows them from
  the page's. Chromium reuses what it parsed for an element with the same tag and the same
  attributes in the same order, and so resolves the repeat against the page, also in shadow DOM.
  Chromium 114, in Obsidian 1.5.3, also does this for another tag with the same attributes, and
  for a `<style>` with the same text and no imports. The viewer resolves every element after the
  `<base>` against it, and does not imitate this caching, which Chromium versions do differently
  ([#191](https://github.com/viell-dev/slop-html-page-viewer/issues/191)).

- **Unreleased (#187):** image inputs, video posters, media, their sources, text tracks, and SVG
  `<image>` before a page's late `<base>` come from the page's folder in the viewer. Chromium
  resolves their URLs when it lays them out or starts to load them, a moment after it reads them:
  against the page's address when it has not read the `<base>` by then, as in a longer page or one
  with a script before the `<base>`, but against the `<base>` in a short page that it reads at
  once. For such a short page, version 0.6.0 shows them as browsers do, from the `<base>`'s folder,
  and the viewer no longer does
  ([#187](https://github.com/viell-dev/slop-html-page-viewer/issues/187)).
  **Unreleased (#198):** so do the images of `background` attributes.

- **Some malformed markup shows otherwise than in a browser.** The viewer parses a page, prepares
  it, and writes it as HTML again for its frame to parse, and HTML cannot write every tree so that
  it reads as the same one. A known case is a MathML element that the parser moved out of a table:
  the frame can read a `<style>` inside it as markup, whose files the viewer has then not prepared
  ([#148](https://github.com/viell-dev/slop-html-page-viewer/issues/148)). Version 0.6.0 also drops
  the empty line that starts a `<pre>` or a `<textarea>`.

  **Unreleased (#148):** such an empty line shows.

- **With scripts on, a `<base>` that a page's script adds** does not apply in the viewer, where a
  browser resolves the URLs that the page names after it against it: the viewer's copy has a
  `<base>` of its own first, which applies instead. If the script puts its `<base>` before that
  one, a relative address in it resolves against Obsidian's own address instead of the page's
  ([#193](https://github.com/viell-dev/slop-html-page-viewer/issues/193)).

- **With scripts off, a video's text tracks from the vault do not load**, such as its captions.
  Unless its video has a `crossorigin` attribute, browsers load a text track only from the page's
  own origin, which in the viewer's frame no vault file shares. With scripts off, the viewer copies
  only stylesheets into a page, since its CSS could read a file copied into an attribute, such as a
  track's, and send it to the web. With scripts on, **Local files with scripts on** copies the
  tracks
  ([#196](https://github.com/viell-dev/slop-html-page-viewer/issues/196)).
- **With scripts off, video and audio show Chromium's own controls**, which cover the lower part of
  a video's poster, and all of a small video's: HTML has browsers show them wherever a page's
  scripts cannot run, so that its media can still be played. The poster itself loads as in a
  browser ([#196](https://github.com/viell-dev/slop-html-page-viewer/issues/196)).
- **An SVG `<use>` of a symbol in another file shows nothing**, as in
  `<use href="icons.svg#home"/>`, with scripts on or off; a symbol in the page itself shows.
  Browsers load the other file only from the page's own origin, which in the viewer's frame no
  vault file shares, and Obsidian 1.15.1 refuses a copy of it as a `data:` URL, so the viewer does
  not copy such files
  ([#196](https://github.com/viell-dev/slop-html-page-viewer/issues/196)).
- **With scripts on, local files load only when they are copied into the page.** Scripts run without
  access to Obsidian, and Obsidian does not serve vault files to such a page. Copied stylesheets
  still apply, and the **Local files with scripts on** setting copies the page's images, media, text
  tracks, fonts, and scripts into it as well, also those of its shadow DOM: up to 32 MB for a page,
  scripts and fonts first, counting a file again for each place that uses it, and no file over 8 MB.
  Such a page takes about a second longer to open for every 8 MB. Files that a script loads itself,
  such as with `fetch`, modules that a module script imports, and pages in frames still do not load.
- **With scripts on, links work as in a browser frame:** the viewer cannot reach the page to follow
  them, so a link opens in the frame itself. For the same reason, the find bar then finds only in
  the source view, and the split view's sides scroll apart.
- **A page with scripts on starts again from its top** when its tab moves to another tab group or
  window, and its scripts run again: the viewer cannot reach the page to keep its place.

  **Unreleased (#178):** it also starts again from its top, without running its scripts again,
  when Obsidian shows its tab again after hiding it, as after another tab of its tab group.

- **Parts of a page that scroll by themselves start again from their beginning** when its tab
  moves to another tab group or window, as does a page that scrolls only inside such a part, such as
  a main column beside a sidebar, or a wide table or code block in a box of its own. Only the place
  of the page as a whole is kept. A part that the page opens, such as a `<details>` element or a
  section that a checkbox shows, is closed again. A page whose place was inside it shows the closed
  part at the window's top: a `<details>` element with its summary, and a section that the page's
  styles close by its height from where its content would begin, so that a heading just before it
  is just above the window's top, or in view when an element around the section clips it too. For a
  section that they hide so that it takes no space, the page shows the element around it from that
  element's top.
- **A link to a part of another page** opens that page at its top.
- **A link that SVG `<use>` copies** from elsewhere in the page does nothing when clicked: the
  viewer cannot tell which copied link it is, and the page stays in its frame.
- **Files outside the vault never load**, even when a page refers to them, and links to them are
  refused.

## How it differs from upstream

- It shows a page's local files, gives unstyled pages Obsidian's theme, and follows links in
  Obsidian. Upstream loads the file itself into the frame, where the page's local images and
  stylesheets do not load.
- Its plugin id is `viell-html-page-viewer` and its name "HTML Page Viewer (viell)", so that
  Obsidian never replaces it with an upstream release. Both plugins open `.html` and `.htm` files,
  so enable only one of them.
- Each file that opens in a tab starts as the **Scripts when a page opens** setting says, with
  scripts off unless it is on, and the toolbar's scripts button changes only the open page.
  Upstream instead remembers the scripts choice for each file, also after Obsidian restarts.
- It has settings, a find bar, and a split view of the source beside the page.

Changes that could serve upstream's users are kept separate from fork-only ones and offered
upstream; [issue #2](https://github.com/viell-dev/slop-html-page-viewer/issues/2) tracks them.
Upstream's source view came from the fork, so the two show and highlight the source alike.
[CHANGELOG.md](CHANGELOG.md) lists the fork's releases, and upstream's own after them.

## Keyboard

The toolbar's buttons are ordinary buttons with labels, reached with Tab. **Rendered**, **Source**,
and **Split** form a group named **View mode**, in which the selected one says it is pressed.
**Scripts** and **Theme** say whether they are on. Ctrl+F, while the viewer has focus, opens the
find bar. In it, Enter moves to the next match and Shift+Enter to the previous one, Escape closes
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
  Fonts, and a local stylesheet applies only from a `.css` file. A stylesheet that cannot be read is
  left out, as a missing one is, and some imports do not apply; see [Limits](#limits).
  **Unreleased (#154):** neither do the stylesheets past a page's limits.
  **Unreleased (#147):** nor does a disabled stylesheet link that the page's scripts enable; see
  [What it does](#what-it-does).
- **The view says it is unable to prepare a page**: the viewer could not make the copy of the page
  that it shows, and says why rather than show the file without the copy's protections. The source
  view still shows the file, and **Refresh preview** tries again. Report a defect with the message.
- **Find in page finds nothing in the page**, or **the split view's sides scroll apart**: with
  scripts on, the viewer cannot reach the page. Turn scripts off. The split view also follows only a
  page that scrolls as a whole.
- **Ctrl+F opens Obsidian's search**: the viewer does not have focus. Click in it first, or use the
  **Find in page** command.

If none of these explains it, [report a defect](CONTRIBUTING.md#report-a-defect).

## Security model

The view shows a copy of the page, never the file itself, in a sandboxed frame; a page whose copy
cannot be prepared shows an error instead. Scripts are off unless the toolbar or the settings turn
them on, and scripts and same-origin access are never granted together:

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
