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

  The copy of such a page holds no vault file's contents but its `.css` stylesheets', whose text
  goes into `<style>` elements; its other files load by their URLs, or not at all. CSS runs without
  scripts, and an attribute selector such as `:has(track[src*="…"])` can test an attribute's value
  piece by piece and turn each answer into a request to the web, through a `url()` that applies
  only when the selector matches, which the copy's policy lets load. A file copied into an
  attribute as a `data:` URL could so be read out of the page. So a text track, which Chromium
  loads only from the frame's own origin unless its video has a `crossorigin` attribute, does not
  load with scripts off, rather than be copied
  ([#196](https://github.com/viell-dev/slop-html-page-viewer/issues/196)).

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
  both could reach Obsidian, and through it the vault and the computer. The function `sandboxValue`
  is the one place that computes the sandbox, and tests cover it.
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
  stylesheet, after nothing but `@charset`, `@supports-condition` rules, other imports, and `@layer`
  statements before the first import. Resource-like text inside CSS strings and comments, in the page's stylesheets and in its
  shadow DOM's alike, causes no stylesheet reads, and no copying either. An imported stylesheet ends
  in the copy where CSS ends it, with what it leaves open closed, so that string and comment text
  after its import stays text and names no file. The scan does not evaluate CSS, and inlining can
  still change which of the importing sheet's rules apply
  ([#152](https://github.com/viell-dev/slop-html-page-viewer/issues/152)).

  **Unreleased (#155):** so does each of the page's own stylesheets, a `<style>` element's text and
  a linked stylesheet, which 0.6.0 reads as written. An import without its `;` at its end is read
  and copied into the page, and an unquoted URL at its end names a file, which a linked
  stylesheet's folder resolves and which, with **Local files with scripts on**, is copied. Before,
  they named nothing, so the viewer read and copied less than CSS names, never more
  ([#155](https://github.com/viell-dev/slop-html-page-viewer/issues/155)).

  **Unreleased (#151):** the viewer also reads and copies the stylesheets of imports into cascade
  layers, and of imports with support conditions where Obsidian's Chromium applies those, which
  0.6.0 leaves as imports without reading them. Their reads pass the same vault-path, `.css`,
  depth, cycle, and page-limit checks as other imports'. Imports with a scope, which no Chromium
  in Obsidian applies, still cause no reads
  ([#151](https://github.com/viell-dev/slop-html-page-viewer/issues/151)).

  **Unreleased (#152):** an import of Google Fonts, one into a cascade layer, or one with
  conditions that the viewer does not read, that the copy keeps as an import counts after copied
  rules too, in a `<style>` element of its own, and so does one inside a copied stylesheet, with
  the conditions of that stylesheet's import. A page then loads a Google Fonts import that 0.6.0
  put where CSS ignores it, as it loads one before any copied rules; Obsidian's policy still
  refuses other web and vault stylesheets. Nothing more is read or copied for it. What the copy
  adds for conditions and new `<style>` elements counts toward the page's text limit, and gives
  none back, and at most 1,000 such elements are added
  ([#152](https://github.com/viell-dev/slop-html-page-viewer/issues/152)).

  **Unreleased (#177):** so does what the copy adds to a stylesheet's text by closing it at its
  end and by making its URLs and imports absolute. A stylesheet that would take the page past the
  limit with it stays a link or an import, and the stylesheets that it imports are not read. A
  page's own `<style>` keeps its URLs as written, which resolve against the page as before. The
  limits decide only how many of the stylesheets that the page's CSS names are read and copied;
  each read still passes the vault-path, `.css`, depth, cycle, and page-limit checks
  ([#177](https://github.com/viell-dev/slop-html-page-viewer/issues/177)).

  **Unreleased (#179):** a string directly inside `image-set()` or `-webkit-image-set()` is a URL
  argument too, as Chromium reads it. The copy makes it absolute or finds it by name, and with
  **Local files with scripts on** copies its file into the page, by the same file types, limits,
  and vault-only paths as a `url()`'s. Such strings cause no stylesheet reads. Other strings, such
  as those of `type()`, `format()`, and `local()`, a font source that is a bare string, which
  Chromium does not load, and the strings of `image()` and `src()`, which Obsidian's Chromium
  does not support, still cause no reads or copying. Version 0.6.0 leaves these strings as
  written, so that one in a linked stylesheet in another folder names a file beside the page, and
  copies none of their files
  ([#179](https://github.com/viell-dev/slop-html-page-viewer/issues/179)).

  **Unreleased (#185):** each of the page's stylesheets resolves against the base that Chromium
  applies where it stands: a `<style>` and its imports, a stylesheet link, and a `style`
  attribute before the page's `<base>` resolve against the page's own address. So the viewer reads
  the stylesheet of such a link or import, and with **Local files with scripts on** copies the
  files that such stylesheets name, from the page's folder, where 0.6.0 reads and copies them from
  the `<base>`'s. It also ignores a `<base>` inside SVG or MathML and one with a `data:` or
  `javascript:` URL, as Chromium does. Either way, the page names these files in CSS that
  applies, and each read and copy passes the same vault-path, `.css`, file-type, and limit checks
  ([#185](https://github.com/viell-dev/slop-html-page-viewer/issues/185)).

  **Unreleased (#194):** a `style` attribute is read closed at its end, as CSS reads it, so that a
  `url(`, or a string in `image-set()` or `-webkit-image-set()`, that its end leaves open names a
  file, which **Local files with scripts on** copies, by the same file types, limits, and
  vault-only paths as any `url()`'s. Another string left open there still names nothing. Version
  0.6.0 copies nothing for such a reference, which browsers load
  ([#194](https://github.com/viell-dev/slop-html-page-viewer/issues/194)).

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

  Since 0.6.0, these include the `.css` files that the content of the page's `<template>` elements
  links or imports, and the files that it names there, read and copied by the same file types,
  limits, and vault-only paths as the rest of the page's
  ([#124](https://github.com/viell-dev/slop-html-page-viewer/issues/124)). That covers its shadow
  DOM, which comes from such templates, and also a template that declares no shadow root, because a
  page with scripts on can use its content.

  Of the page's `<style>` and `<link>` elements, it reads and copies only for an HTML or SVG
  `<style>` element's own text and for HTML stylesheet `<link>` elements, the ones whose namespace
  Chromium applies. The elements inside an SVG `<style>`, a MathML `<style>`, and a `<link>` inside
  SVG or MathML cause no reads or copying, and the copy keeps them as the page has them. Such a
  `<link>` loads nothing; a `<style>` in its place would be parsed as SVG's or MathML's in the
  frame, which reads its text as markup. Before 0.6.0, the viewer read and copied for all of these,
  and replaced a `<link>` inside SVG or MathML with such a `<style>`; fixed in 0.6.0
  ([#143](https://github.com/viell-dev/slop-html-page-viewer/issues/143)). Version 0.6.0 does not
  check their `type` or a link's `disabled` attribute. It also prepares the stylesheets in every
  `<template>`, whose content a page with scripts on can use, and in `<noscript>`, which such a
  page never shows ([#148](https://github.com/viell-dev/slop-html-page-viewer/issues/148)).

  **Unreleased (#147):** it reads and copies only for the elements that Chromium also applies by
  their `type` and a link's `disabled` attribute: a `<style>` with no `type`, an empty one, or
  `text/css` in any case, without parameters or spaces, and a link without `disabled` whose `type`
  is absent, or whose part before any `;`, trimmed of whitespace, is empty or `text/css` in any
  case. The others cause no reads or copying, and the copy keeps them as the page has them;
  before, such a link became a `<style>` that applied. On Obsidian 1.5.3, whose Chromium applies an
  SVG `<style>` only with a lowercase `text/css`, an SVG `<style>` with that type in other case is
  still prepared, though it applies nothing
  ([#147](https://github.com/viell-dev/slop-html-page-viewer/issues/147)).

  **Unreleased (#169):** of those, it reads and copies only for the stylesheets of the set that
  Chromium applies. In the page itself, they are the untitled ones and those titled with the name
  of the preferred set, which the page's first title of a `<style>` or a stylesheet link, or a
  `<meta http-equiv="Default-Style">` before it, gives, `alternate stylesheet` links of that title
  among them; in shadow DOM and in templates, every one but alternate links. A titled stylesheet
  of another set causes no reads or copying, and the copy keeps it as the page has it. Version
  0.6.0 reads and copies for every titled stylesheet, and none for an `alternate stylesheet` link,
  also one in the preferred set, which Chromium applies
  ([#169](https://github.com/viell-dev/slop-html-page-viewer/issues/169)).

  **Unreleased (#192):** a link is a stylesheet link only when ASCII whitespace separates
  `stylesheet` from the other words of its `rel`, as HTML splits it. Version 0.6.0 also splits it
  at U+00A0 and the other spaces of JavaScript's `\s`, and so reads, applies, and copies for links
  that browsers do not load. With **Local files with scripts on**, the viewer copies the file that
  a URL attribute names with such a space at its start or end, or a `srcset` inside a URL, where
  0.6.0 copies the file of the name without it, or none. Each read and copy passes the same checks
  ([#192](https://github.com/viell-dev/slop-html-page-viewer/issues/192)).

  **Unreleased (#187):** with **Local files with scripts on**, it copies the files that the page's
  images, media, text tracks, and scripts before its `<base>` name from the page's folder, instead
  of from the `<base>`'s, as it copies the files of stylesheets there since #185. That is the
  viewer's choice: Chromium resolves images and scripts there in every page, but image inputs,
  posters, media, their sources, text tracks, and SVG `<image>` against the `<base>` in a short page
  that it reads in one go. The same file types, limits, and vault-only paths apply
  ([#187](https://github.com/viell-dev/slop-html-page-viewer/issues/187)).

  **Unreleased (#198):** with **Local files with scripts on**, it also copies the images that the
  `background` attributes of the `<body>` and of tables and their parts name, and the files of SVG
  `<feImage>` and `<script>` elements, which 0.6.0 leaves as written, so that a page with scripts
  on loads none of them. An SVG script so copied runs, as the page's other scripts do then. Before
  a later `<base>`, the viewer copies these from the page's folder too, which is its choice, as for
  #187: Chromium takes an `<feImage>`'s and an SVG script's file from there in every page, but a
  `background` attribute's from the `<base>`'s folder in a short page that it reads in one go. It
  reads an attribute only on the
  elements of the namespace that Chromium loads it for: an HTML element's `background` and `src`,
  and an SVG element's `href`, so that it no longer copies the file of a `<video>`, an `<audio>`, or
  an `<input>` inside SVG, which loads nothing. The same file types, limits, and vault-only paths
  apply
  ([#198](https://github.com/viell-dev/slop-html-page-viewer/issues/198)).

A rendered page can still request the images, fonts, scripts, or media on the web that it refers to,
as any browser would. That is the page's request, not the plugin's. Open untrusted pages with
scripts off.

A change to this model is documented here and in the README in the same pull request.
