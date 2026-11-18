# Security policy

Report a suspected vulnerability through [GitHub's private vulnerability
reporting](https://github.com/viell-dev/slop-html-page-viewer/security/advisories/new), with the
commit you built, the Obsidian version, and a minimal synthetic HTML file. Do not put exploitable
details or private documents in a public issue.

Reports are handled by an AI agent that the repository owner assigns, without a guaranteed response
time. Fixes are released as new versions of the fork. A vulnerability in code the fork shares with
[upstream](https://github.com/viggomeesters/obsidian-html-page-viewer) is also reported there,
through upstream's security policy, following the rules for submissions to upstream in
[AGENTS.md](AGENTS.md#upstream).

## Security model

HTML files can run scripts and load resources, so the viewer limits what a rendered page may do.

- **A copy in a sandboxed frame.** The view parses the file, prepares a copy of it, and shows the
  copy through the `srcdoc` of an `iframe` with a `sandbox` attribute. Parsing runs nothing, and the
  file is never changed. If the copy cannot be prepared, the view shows an error in its place, never
  the file itself, which has none of the copy's protections; the source view still shows the file.
  The frame has its sandbox from the moment it is created. Obsidian serves vault files to a frame
  by the origin that its main process records for the frame, and a frame created without a sandbox
  is recorded with Obsidian's origin. On some versions, such as 1.5.3, the frame's page commits
  under that record, which keeps Obsidian's origin until the main process processes the commit;
  until then, a page with scripts on could load any vault file that it asks for.
- **Scripts off, by default.** The sandbox grants only `allow-same-origin`. The page then has
  Obsidian's origin, which a page needs in Obsidian to load the vault's files. Without
  `allow-scripts`, nothing in the page can use that origin: no script runs, including event handler
  attributes and `javascript:` links, and forms, popups, and navigation of Obsidian's window stay
  blocked.
- **Scripts on, by choice.** The toolbar's scripts button turns scripts on for the open page, and
  the **Scripts when a page opens** setting turns them on for every page as it opens. The sandbox
  then grants only `allow-scripts`, so the page runs with an opaque origin and cannot reach Obsidian
  or the vault's files. Its scripts can read the copy itself, with the stylesheets copied into it,
  which the view takes only from `.css` files. With the **Local files with scripts on** setting,
  the copy also holds the images, audio, video, text tracks, fonts, and scripts that the page names
  from the vault, chosen by their file types, so its scripts can read those too; notes and other
  documents are never copied. Each file opened in a tab starts as the **Scripts when a page opens**
  setting says: with scripts off, unless it is on.
- **Never both.** Scripts and same-origin access are never granted together, because a page with
  both could reach Obsidian, and through it the vault and the computer. `sandboxValue` in
  `src/main.ts` is the one place that computes the sandbox, and tests cover it.
- **Only the vault's files.** The copy carries its own Content Security Policy, which the browser
  enforces together with Obsidian's. Obsidian's file URLs load only from inside the vault, so a page
  cannot show a file elsewhere on the computer by referring to it, and `<object>` content is
  blocked. Obsidian's own policy also applies to the copy: it allows only inline styles and Google
  Fonts stylesheets.
- **Links.** With scripts off, the view follows clicks on the page's links itself, including links
  inside shadow DOM, so the frame never leaves the copy: web links are handed to Obsidian to open
  outside it, vault files open in Obsidian, and links to other local files are refused. The copy
  declares the page's shadow roots open, so that none of its links is hidden from the view, and the
  view cancels every other navigation of the frame. The copy is also inert, so that nothing in it
  can be clicked, focused, or reached with keys, until the view has added its listeners to the
  document that shows it. That holds for every document the frame shows: when Obsidian moves a tab
  to another tab group or window, the frame loads the copy again, and the view adds its listeners
  as soon as the new document exists. On Chromium 135 to 141, which some Obsidian versions use, a
  page's own styles can lift that inertness, so there only the listeners protect it
  ([#127](https://github.com/viell-dev/slop-html-page-viewer/issues/127)). With scripts on, the view cannot
  reach the page, and a link navigates the frame, which keeps its sandbox.
- **CSS resources.** A stylesheet names resources only with its URL arguments and the sources of
  the imports that browsers apply, including their quoted forms: imports at the start of a
  stylesheet, after nothing but `@charset`, other imports, and `@layer` statements before the first
  import. Resource-like text inside CSS strings and comments, in the page's stylesheets and in its
  shadow DOM's alike, causes no stylesheet reads, and no copying either. An imported stylesheet ends
  in the copy where CSS ends it, with what it leaves open closed, so that string and comment text
  after its import stays text and names no file. The scan does not evaluate CSS, and inlining can
  still change which of the importing sheet's rules apply
  ([#152](https://github.com/viell-dev/slop-html-page-viewer/issues/152)).

  Before 0.6.0, the viewer also read stylesheets, and with **Local files with scripts on** copied
  files, that only CSS strings or comments named, or that imports named which never apply: one
  after a style rule, and one into a cascade layer written with a comment or an escape before
  `layer`. An imported stylesheet that ended inside a string or a comment could make text after its
  import name files.
  Each such read and copy still passed the vault-path, `.css`, file-type, and copy-limit checks, so
  none gave a page a file that it could not name in CSS that applies. Fixed in 0.6.0
  ([#91](https://github.com/viell-dev/slop-html-page-viewer/issues/91),
  [#136](https://github.com/viell-dev/slop-html-page-viewer/issues/136),
  [#139](https://github.com/viell-dev/slop-html-page-viewer/issues/139),
  [#144](https://github.com/viell-dev/slop-html-page-viewer/issues/144)).

- **What the plugin does.** It reads vault files to prepare the copy: the page, the `.css` files
  that the page links or imports as stylesheets, and the files it copies into a page with scripts
  on. It never writes to vault files, makes no network requests, and does not read or write the
  clipboard. The one file it writes is its own settings, which Obsidian keeps in the plugin's
  folder. Obsidian saves an open file's view to the file when the file leaves it; the viewer turns
  that saving off, so Obsidian does not write the files it shows either.

  Since 0.6.0, these include the `.css` files that the page's shadow DOM links or imports, and the
  files that it names there, read and copied by the same file types, limits, and vault-only paths
  as the rest of the page's ([#124](https://github.com/viell-dev/slop-html-page-viewer/issues/124)).

  Of the page's `<style>` and `<link>` elements, it reads and copies only for an HTML or SVG
  `<style>` element's own text and for HTML stylesheet `<link>` elements, the ones whose namespace
  Chromium applies. The elements inside an SVG `<style>`, a MathML `<style>`, and a `<link>` inside
  SVG or MathML cause no reads or copying, and the copy keeps them as the page has them. Such a
  `<link>` loads nothing; a `<style>` in its place would be parsed as SVG's or MathML's in the
  frame, which reads its text as markup. Before 0.6.0, the viewer read and copied for all of these,
  and replaced a `<link>` inside SVG or MathML with such a `<style>`; fixed in 0.6.0
  ([#143](https://github.com/viell-dev/slop-html-page-viewer/issues/143)). It does not yet check
  their `type` or a link's `disabled` attribute
  ([#147](https://github.com/viell-dev/slop-html-page-viewer/issues/147)). It also prepares the
  stylesheets in every `<template>`, whose content a page with scripts on can use, and in
  `<noscript>`, which such a page never shows
  ([#148](https://github.com/viell-dev/slop-html-page-viewer/issues/148)).

A rendered page can still request the images, fonts, scripts, or media on the web that it refers to,
as any browser would. That is the page's request, not the plugin's. Open untrusted pages with
scripts off.

A change to this model is documented here and in the README in the same pull request.
