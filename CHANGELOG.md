# Changelog

The fork's releases, newest first. Each version's full notes, written for someone installing it,
are in [`.github/release-notes/`](.github/release-notes/), and they are the text of its
[GitHub release](https://github.com/viell-dev/slop-html-page-viewer/releases). Changes merged since
the newest release are listed under **Unreleased**. Upstream's own releases follow at the
[end](#upstream-releases).

## Unreleased

- A page that scrolls as a whole keeps its place when Obsidian shows its tab again after hiding it,
  as after another tab of its tab group or a collapsed sidebar, instead of showing from its top. In
  the split view, both sides go back where they were and stay in step. Before, the page went to its
  top, and where the source's long lines wrap, as they do by default, the source came back a few
  lines away and the page followed it there, further at each switch. A page with scripts on still
  shows from its top, since the viewer cannot reach it (#178).
- A linked or imported stylesheet in another folder than the page shows the images that it names
  with strings in `image-set()` or `-webkit-image-set()`, such as
  `image-set("icon.png" 1x, "icon@2x.png" 2x)`, from its own folder, as browsers do, instead of
  from the page's folder. With **Local files with scripts on**, the files of such strings are copied
  into the page, also from the page's own `<style>` elements and `style` attributes (#179).
- A page whose `<base>` comes after its styles, such as at the end of its `<head>`, shows the
  images and fonts that its `<style>` elements, stylesheet links, imports, and `style` attributes
  before the `<base>` name from its own folder, as browsers do, instead of from the `<base>`'s
  folder. A `<base>` inside SVG, or one with a `data:` or `javascript:` URL, which browsers ignore,
  no longer changes where the page's files come from (#185).
- The viewer reads and copies only the stylesheets that browsers apply: untitled ones, and the
  titled ones of the page's preferred set, which the page's first title or a
  `<meta http-equiv="Default-Style">` names. A titled `<style>` or stylesheet link of another set
  keeps its text or stays a link, and an `alternate stylesheet` link with the preferred set's title
  now applies, as in browsers (#169).
- A page whose stylesheets import each other many times opens in moments instead of keeping
  Obsidian from responding for seconds to hours: for each page, the viewer follows at most 1,000
  links and imports of vault stylesheets and copies at most 16 million characters of their text,
  and leaves the rest as links and imports, which do not apply. The page's repeated links and
  imports of a stylesheet that it has copied whole, as components with shadow DOM have, count only
  the text that they add, and those of a missing stylesheet nothing. It reads each stylesheet file
  once per page (#154).
- The page's 16 million characters of stylesheets count each stylesheet's text as preparing writes
  it, closed at its end and with its URLs and imports made absolute, so that a stylesheet of many
  short `url()`s no longer takes the copy to several times that. A stylesheet that would pass the
  limit so rewritten stays a link or import, which does not apply, and is not prepared again for a
  repeat of its link or import. Once preparing such stylesheets has reached 32 million characters
  of them, the page gets no further stylesheet, also one that would fit. A page's own `<style>`
  keeps its `url()`s as written, which resolve as before (#177).
- In the split view, scrolling the source right after its tab moves to another tab group or window,
  before the page shows again or as it does, is no longer undone: the page follows the source,
  instead of sending it back to where the page was. On Obsidian 1.5.3, the source is back in its
  place as soon as the tab has moved, so the scrolling goes on from there. After such a move, the
  find bar shows its matches again without scrolling to the current one. In the split view and the
  **Source** view, the reader's scroll of the source to its start is no longer undone by a layout
  change or a resize that comes before Chromium reports it (#157).
- The viewer reads and copies only for the `<style>` and stylesheet `<link>` elements that browsers
  apply. A `<style>` of another type, such as `text/x-scss` or `text/css; charset=utf-8`, keeps
  its text as written, and a disabled link or one of another type, such as `text/plain`, stays a
  link instead of becoming a `<style>` whose rules applied. A page whose only stylesheets are such
  elements shows in Obsidian's theme. A disabled link that a page's scripts enable later stays
  without its stylesheet (#147).
- A `<style>` or a linked stylesheet that ends in an import without its `;` now imports its file,
  and an unquoted `url(` at the end of a linked stylesheet loads from the stylesheet's folder, as
  CSS ends each stylesheet on its own. A page's link and import of the same stylesheet then count
  once toward its stylesheet limits (#155).
- In the **Source** view, and in the split view with scripts on, the find bar highlights its
  matches again after its tab moves to another tab group or window, and the source stays as far as
  it was scrolled. Before, the highlights were
  gone, while the bar still counted the matches (#162). The find bar's own scroll of the source to
  its start, to a match on its first lines, is no longer undone by a layout change or a resize that
  comes before Chromium reports it (#167).
- A page's imports of vault stylesheets into cascade layers, such as `@import "base.css" layer;`,
  now apply, in the layer order that their imports give. So do imports with support conditions,
  such as `supports(display: grid)`, on Obsidian versions whose Chromium applies them; Obsidian
  1.5.3's never does. Imports with a scope still do not apply, as in Chromium (#151).
- An import of Google Fonts, an import into a cascade layer, or one with conditions that the
  viewer does not read, such as a scope, now counts after a page's imports of vault stylesheets,
  also inside a stylesheet imported with conditions, such as `@import "fonts.css" screen;`. The
  viewer puts it in a `<style>` element of its own, with the rules after it, which keeps each
  rule's place in the cascade; selectors that count elements and the page's scripts see the new
  element. A stylesheet imported into a layer declares the layer where its import is, also when it
  holds nothing that would. `<!--` and `-->` in an imported stylesheet no longer
  keep its rules from applying inside the conditions of its import (#152).
- After a tab moves to another window, Enter pressed right after typing in the find bar goes on
  from the match that it shows, instead of the search of what was typed taking the bar back to the
  first match a moment later. After the tab moves out of a window that then closes, the find bar
  searches what is typed again without waiting for Enter (#175).
- On Obsidian 1.5.3, the split view's two sides stay in step after its tab moves to a new window,
  instead of ending a line or two apart once Obsidian's styles have arrived in the window. A source
  that the reader has scrolled by then stays at their line, and the page follows it (#165).

## [0.6.0](.github/release-notes/0.6.0.md) - 2026-11-18

- Content inside a page's shadow DOM, which pages saved with their web components can contain, is
  shown as the rest of the page: its images load, also those that it names by file name only, its
  stylesheets and imports apply, and with **Local files with scripts on** its files are copied into
  a page with scripts on. In the split view, the two sides stay in step on such a page (#124).
- Hovering a link or an image inside shadow DOM shows where the link leads and the image's alt
  text, and hovering an SVG link without text, labels, icons, or HTML content inside shows where it
  leads (#117, #124).
- A link from a page to a vault file opens in the page's own tab, and with Ctrl or a middle click in
  a new tab beside it, also while a tab in another tab group or window is the active one, instead of
  from that tab. In a sidebar, a plain click now opens the link in the sidebar's tab, as one in a
  note there does (#141).
- When its tab moves to another tab group or window, a page keeps the theme and line width that it
  shows and, if it scrolls as a whole, its place, and the split view's two sides stay in step there
  (#126).
- On Obsidian 1.5.3, the **Source** view stays scrolled as far as it was when its tab moves to
  another tab group or window, instead of starting again from its top (#135).
- A page follows a change of Obsidian's theme or of **Readable line length** made while the viewer
  was still preparing it (#140).
- A tab no longer shows a page's earlier contents under another page's name when the first page
  changes on disk just as the other opens in the tab (#115).
- Find leaves out unpainted fallback and SVG resource text, includes a closed select's chosen text,
  and searches and highlights text in shadow roots and slots. Opening an empty find bar avoids
  collecting the page's text (#122, #121, #124).
- CSS strings and comments stay as the page has them when the viewer resolves resources and copies
  local files, and repeated malformed `url(` text no longer stalls it (#91). Stylesheet imports
  inside `@media` or style blocks are no longer inlined, as browsers ignore them there, while
  imports written with comments or escapes, such as `@import /**/ url(…)` or `@\69mport`, now are.
  Unquoted URLs with an escaped `)` or `"` now resolve, and a linked stylesheet that imports itself
  no longer repeats its rules.
- Stylesheet imports count only where browsers apply them. An `@import` after a style rule, inside
  a rule's selector, or after a stray `;`, `)`, or `}` is no longer read into the page, while one
  after `@charset`, an `@layer` statement, or `<!--` still is (#136). An imported stylesheet that
  ends inside a string, a comment, an unquoted `url(`, a block, or a rule no longer changes the
  stylesheet that imports it, which could drop the rules after the import, or, with **Local files
  with scripts on**, copy a file that only a string named (#139). An import into a cascade layer
  stays an import also when a comment or an escape comes before `layer`, rather than becoming an
  `@media` rule that never applies (#144).
- Only the text of HTML and SVG `<style>` elements, not of their child elements, and HTML
  stylesheet links are read, applied, and copied from, as browsers read them. Text inside the
  elements of an SVG `<style>` no longer applies once the viewer rewrites the `<style>`, which keeps
  those elements. A MathML `<style>` no longer reads stylesheets or copies files, and a stylesheet
  `<link>` inside SVG or MathML no longer applies or adds its text to the page as markup. A page
  whose only styles are such a `<style>` or `<link>` now shows in Obsidian's theme (#143).

## [0.5.2](.github/release-notes/0.5.2.md) - 2026-11-17

- **Rendered**, **Source**, and **Split** form a labelled group, and the selected one says it is
  pressed, so that screen readers announce which view mode a tab shows.
- Security: a page that cannot be prepared for display shows an error, with Refresh and the source
  view still available, instead of being shown without its protections. Escapes in a page's CSS
  decode as CSS specifies, and a stylesheet that cannot be read is left out, as a missing one is.
- Links in SVG drawn in the page open as other links do. A link to `#` scrolls to the top of the
  page, and a link to `#top` goes to the element named `top` when the page has one.
- A refresh that finishes after another file has opened in the same tab no longer shows the
  earlier file's contents there. Before, Obsidian then saved those contents over the file that the
  tab showed once the tab moved on; the viewer no longer lets Obsidian save the files it shows.
- Find in the page leaves out text that CSS hides, and closing the find bar keeps a query typed just
  before it closed.
- Security: with scripts on, a page's frame is isolated from the vault's files from the moment it is
  created. On some Obsidian versions, such as 1.5.3, such a page could, rarely, load vault files
  that it names, such as its images, without the **Local files with scripts on** setting.
- Security: links inside a page's shadow DOM, which pages saved with their web components can
  contain, open in Obsidian as other links do, and the page stays in its frame.
- Security: after a tab moves to another tab group or window, its page follows links in Obsidian as
  soon as it shows again. Before, a link clicked before the page had loaded again navigated the
  frame away from the page.

## [0.5.1](.github/release-notes/0.5.1.md) - 2026-10-24

- The viewer's settings appear in global settings search on Obsidian 1.13 and later, while older
  versions keep the same settings tab.
- The supported target is Linux desktop. Windows supplies additional development checks; macOS
  and mobile are out of scope. The manifest now prevents mobile installation.

## [0.5.0](.github/release-notes/0.5.0.md) - 2026-10-21

- A find bar for the source view and, with scripts off, the rendered page.
- A **Split** view of the source beside the page, scrolling in step while scripts are off.

## [0.4.0](.github/release-notes/0.4.0.md) - 2026-10-21

- The **Local files with scripts on** setting, off by default, copies a page's local images, media,
  text tracks, fonts, and scripts into it while its scripts are on.
- A `srcset` URL without a size no longer keeps the next URL from being found by name.

## [0.3.1](.github/release-notes/0.3.1.md) - 2026-10-21

- The source view shows every character of the file, and highlights it as HTML reads it, across
  lines too.
- Security: only `.css` files apply as a page's local stylesheets, so a page with scripts on can no
  longer read another vault file by linking it as a stylesheet.

## [0.3.0](.github/release-notes/0.3.0.md) - 2026-10-21

- Settings: **Theme in new tabs**, **Scripts when a page opens**, **Wrap long lines in the source
  view**, and **File extensions**.
- The reading style follows Obsidian's **Readable line length** setting.
- A tab keeps its **Theme** and view choices for the next page.
- Links and images show tooltips.

## [0.3.0-rc.1](.github/release-notes/0.3.0-rc.1.md) - 2026-10-21

The release candidate of 0.3.0, with the same plugin.

## [0.2.0](.github/release-notes/0.2.0.md) - 2026-10-19

The fork's first release:

- Pages show with their local images and stylesheets.
- Pages without styles of their own show in Obsidian's theme.
- Links open as Obsidian opens them.
- A reference that does not resolve as a path finds its file by name.

## [0.2.0-rc.1](.github/release-notes/0.2.0-rc.1.md) - 2026-10-19

The release candidate of 0.2.0, with the same plugin.

## Upstream releases

[HTML Page Viewer](https://github.com/viggomeesters/obsidian-html-page-viewer)'s releases, as
upstream recorded them. The fork's releases take their changes from upstream's `main` as it syncs,
not by version.

### 0.1.6 - 2026-11-18

- Prevent stale refreshes and inherited save paths from overwriting HTML files.

### 0.1.5 - 2026-11-16

- Maintenance verification for Obsidian 1.15.1 on macOS desktop.
- Add reproducible official Obsidian lint checks; no runtime code change.

### 0.1.4 - 2026-11-11

- Preserve source whitespace and highlighting across multiline tags, attribute values, and comments.
- Handle quoted tag delimiters and script/style content in source view.

### 0.1.3 - 2026-11-10

- Remember the Scripts toggle per HTML file across note changes and Obsidian restarts. Scripts start off for files without permission.

### 0.1.2 - 2026-10-25

- Cross-platform production build.
- Current Community installation documentation.

### 0.1.1 - 2026-06-07

- Remove the redundant product name from the manifest description for Community review compatibility.

### 0.1.0 - 2026-06-07

- Initial public release.
- Add read-only `.html` and `.htm` file view.
- Add sandboxed rendered preview with scripts disabled by default.
- Add per-viewer Scripts OFF/ON toggle that never grants same-origin, forms, popups, or top-level navigation.
- Add rendered/source toggle, manual refresh, empty/error states, and lightweight HTML syntax highlighting.
