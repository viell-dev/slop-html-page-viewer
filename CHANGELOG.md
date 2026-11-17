# Changelog

The fork's releases, newest first. Each version's full notes, written for someone installing it,
are in [`.github/release-notes/`](.github/release-notes/), and they are the text of its
[GitHub release](https://github.com/viell-dev/slop-html-page-viewer/releases). Changes merged since
the newest release are listed under **Unreleased**. Upstream's own releases follow at the
[end](#upstream-releases).

## Unreleased

- Find leaves out unpainted fallback and SVG resource text, includes a closed select's chosen text,
  and searches and highlights text in shadow roots and slots. Opening an empty find bar avoids
  collecting the page's text (#122, #121, #124).
- A tab no longer shows a page's earlier contents under another page's name when the first page
  changes on disk just as the other opens in the tab (#115).
- Content inside a page's shadow DOM, which pages saved with their web components can contain, is
  shown as the rest of the page: its images load, also those that it names by file name only, its
  stylesheets and imports apply, and with **Local files with scripts on** its files are copied into
  a page with scripts on. In the split view, the two sides stay in step on such a page (#124).
- Hovering a link or an image inside shadow DOM shows where the link leads and the image's alt
  text, and hovering an SVG link without text, labels, icons, or HTML content inside shows where it
  leads (#117, #124).
- When its tab moves to another tab group or window, a page keeps the theme and line width that it
  shows and, if it scrolls as a whole, its place, and the split view's two sides stay in step there
  (#126).
- A page follows a change of Obsidian's theme or of **Readable line length** made while the viewer
  was still preparing it (#140).
- Preserve CSS strings and comments when resolving resources and copying local files, and avoid
  stalls on repeated malformed `url(` text (#91). Stylesheet imports inside `@media` or style
  blocks are no longer inlined, as browsers ignore them there, while imports written with comments
  or escapes, such as `@import /**/ url(…)` or `@\69mport`, now are. Unquoted URLs with an escaped
  `)` or `"` now resolve, and a linked stylesheet that imports itself no longer repeats its rules.
- Only stylesheets that browsers apply are read, applied, and copied from. Text inside the elements
  of an SVG `<style>` no longer applies once the viewer rewrites the `<style>`, which keeps those
  elements. A MathML `<style>` no longer reads stylesheets or copies files, and a stylesheet
  `<link>` inside SVG or MathML no longer applies or adds its text to the page as markup (#143).
- On Obsidian 1.5.3, the **Source** view stays scrolled as far as it was when its tab moves to
  another tab group or window, instead of starting again from its top (#135).
- A link in a page opens in the page's own tab, and with Ctrl or a middle click in a new tab beside
  it, also while a tab in another tab group or window is the active one, instead of from that tab.
  In a sidebar, a plain click now opens the link in the sidebar's tab, as one in a note there does
  (#141).

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
