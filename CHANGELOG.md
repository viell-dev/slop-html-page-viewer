# Changelog

The fork's releases, newest first. Each version's full notes, written for someone installing it,
are in [`.github/release-notes/`](.github/release-notes/), and they are the text of its
[GitHub release](https://github.com/viell-dev/slop-html-page-viewer/releases). Changes merged since
the newest release are listed under **Unreleased**. Upstream's own releases, from before the fork,
follow at the [end](#upstream-releases).

## Unreleased

Nothing that changes the plugin.

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

[HTML Page Viewer](https://github.com/viggomeesters/obsidian-html-page-viewer)'s releases before the
fork, as upstream recorded them.

### 0.1.1 - 2026-06-07

- Remove the redundant product name from the manifest description for Community review compatibility.

### 0.1.0 - 2026-06-07

- Initial public release.
- Add read-only `.html` and `.htm` file view.
- Add sandboxed rendered preview with scripts disabled by default.
- Add per-viewer Scripts OFF/ON toggle that never grants same-origin, forms, popups, or top-level navigation.
- Add rendered/source toggle, manual refresh, empty/error states, and lightweight HTML syntax highlighting.
