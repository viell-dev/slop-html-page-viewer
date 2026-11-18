# Testing

What each promise in the [README](README.md) and [SECURITY.md](SECURITY.md) rests on, and what no
test covers. [CONTRIBUTING.md](CONTRIBUTING.md#checks) explains how to run the checks.

## Layers

- **Unit tests** (`npm test`) run the plugin's code in a jsdom window, with a stand-in for the parts
  of Obsidian's API that it uses. They are required in CI on Linux and Windows. They prove logic,
  not Obsidian's behavior. **Stress tests** (`npm run test:stress`) run the same way on pages at
  the sizes that once broke the plugin, and are required in CI with them.
- **Consistency tests** (`test/consistency.test.ts`, part of `npm test`), **linting**
  (`npm run lint`), and **formatting** (`npm run format:check`) keep the versions, changelog,
  release notes, documented settings, unreleased notices and their changelog issue references,
  labels, CI jobs, end-to-end suites, and documents' links in agreement. They are required in CI.
- **Tests in Obsidian** (`test/e2e/`) use WebdriverIO 10 to run the built plugin in real Obsidian,
  1.5.3 and the latest release, on Linux. They are required for every pull request and also run
  weekly, so that a new Obsidian release is tested within a week. Their logs and screenshots, with
  one of Obsidian's window for each failed test, are kept as a CI artifact for 30 days. The tests
  wait until the page has loaded in its frame, asking inside the frame when scripts are on. A test
  that finds a vault file shown in a page with scripts on also keeps a diagnosis of the frame
  there, in `diagnoses/`. Anything about loading, origins, focus, or keys is measured here.
- **The archive corpus** (`test/e2e/corpus/`) opens every page of a synthetic vault of archived web
  pages in Obsidian, and compares the result with the frozen prototype build.

`test/e2e-selection.test.ts` checks how `E2E_ONLY` narrows a run: it accepts spec file names,
refuses unknown names and runner arguments, and lets only a run without `corpus.e2e.ts` leave out
the corpus results, which a full run requires. `E2E_ONLY=viewer.e2e.ts npm run test:e2e:docker`
is the quick check that a narrowed run works in Obsidian.

`lifecycle.e2e.ts` goes through the plugin's lifecycle as a user does, in an Obsidian started
without it. It packages the build with `node scripts/release.ts package`, under the manifest's
version and under the earlier version `0.0.0-lifecycle`, and unzips each zip with Info-ZIP's
`unzip`. It installs the earlier one in the vault's plugins folder and turns it on, saves settings
that differ from the defaults, and turns the plugin off and on. It then replaces its files with the
candidate's, turns it off and on, and restarts Obsidian. At each step it checks the version that
runs, the settings, which extensions the viewer holds, and a page in the viewer. At the end it
checks that the page file's bytes and modification time are unchanged. It takes about ten seconds
on each host, so it runs with the rest in the required `e2e` job: on every pull request, weekly,
and on the commit that a release publishes, whose CI the Release workflow checks.

The settings suite also checks that global settings search finds all five viewer settings and
opens each result on versions that provide the search (Obsidian 1.13 and later).

## Promises and their evidence

| Promise                                                                                                                                                                            | Unit tests                                                                                                                                                                | In Obsidian                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Scripts and same-origin access are never granted together; scripts start off for each file                                                                                         | `rendered.test.ts`                                                                                                                                                        | `viewer.e2e.ts`: the frame cannot run scripts, and gets only `allow-scripts` with them on                                              |
| With scripts on, a page cannot reach the vault's files, apart from those copied into it                                                                                            | `document.test.ts`, `settings.test.ts`; `rendered.test.ts`: each frame has its sandbox before it is inserted                                                              | `resources.e2e.ts`: the origin that Obsidian's main process records for the frame is opaque from its creation; `settings.e2e.ts`       |
| Only the vault's files load; a stylesheet comes only from a `.css` file; notes are never copied                                                                                    | `document.test.ts`: `vaultPath`, `pagePolicy`, stylesheets, locating by name                                                                                              | `resources.e2e.ts`: nothing from outside the vault                                                                                     |
| A page whose copy cannot be prepared shows an error, never the file; an unreadable stylesheet is left out                                                                          | `rendered.test.ts`; `document.test.ts`: CSS escapes, unreadable files                                                                                                     | `resources.e2e.ts`: nothing from outside the vault on such pages either                                                                |
| The plugin never writes to vault files, makes no network requests, and does not use the clipboard                                                                                  | `policy.test.ts` reads the built bundle; `refresh.test.ts`: Obsidian's saving, which the bundle lacks                                                                     | `read-only.e2e.ts`: files are unchanged once they leave the view, also after refreshes                                                 |
| A tab shows only its own file's contents, also when a read of a file ends after another file opened in the tab                                                                     | `refresh.test.ts`: a refresh, and Obsidian's reload of a changed file (#115)                                                                                              | `read-only.e2e.ts`: a refresh, and Obsidian's reload, after a switch, and of a change on disk (#115)                                   |
| A page shows its local images, stylesheets, and fonts; references resolve by path or by name, also in shadow DOM                                                                   | `document.test.ts`, also the content of templates and shadow roots                                                                                                        | `resources.e2e.ts`, also in shadow DOM and copied with scripts on; `corpus.e2e.ts`                                                     |
| HTML and SVG links, also nested and in shadow roots, stay in the copy, which no other navigation leaves and which acts only once watched; fragments follow id/name/top precedence  | `links.test.ts`; `document.test.ts`: shadow roots, inert copy; `rendered.test.ts`: only with scripts off                                                                  | `links.e2e.ts`, also after the tab moves to another tab group or window                                                                |
| A vault link opens in its page's tab, or with a modifier beside it, as a link in a note in that tab does, also while another tab is active (#141)                                  | `links.test.ts`: the view's own tab, a pinned one, and each modifier                                                                                                      | `links.e2e.ts`: real clicks while another tab group's tab is active, and in a pinned tab; a click dispatched in a page in a new window |
| Hovering a link shows where it leads, and an image its alt text, also in shadow DOM; an SVG link only when nothing inside it names it, which keeps that name                       | `document.test.ts`: tooltips                                                                                                                                              | `links.e2e.ts`: the titles that Chromium shows, and the names that it gives the links                                                  |
| Pages without styles follow Obsidian's theme and Readable line length                                                                                                              | `reading.test.ts`; `document.test.ts`, for pages whose only styles do not apply (#143)                                                                                    | `theme.e2e.ts`                                                                                                                         |
| Settings, their defaults, and their immediate effect                                                                                                                               | `settings.test.ts`, `extensions.test.ts`, `plugin.test.ts`; the README's defaults: `consistency.test.ts`                                                                  | `settings.e2e.ts`, in Obsidian's own settings window                                                                                   |
| The source view shows every character of the file, highlighted as HTML reads it                                                                                                    | `source.test.ts`, including random markup                                                                                                                                 | `viewer.e2e.ts`                                                                                                                        |
| The find bar finds in the source and the page, and moves with Enter, Shift+Enter, and Escape                                                                                       | `find.test.ts`: close paths, no-`checkVisibility` fallback, `content-visibility`                                                                                          | `find.e2e.ts`: Ctrl+F; finds exactly the words that the page paints                                                                    |
| The split view keeps its two sides in step                                                                                                                                         | `split.test.ts`, also with shadow roots                                                                                                                                   | `split.e2e.ts`, both ways, on a smoothly scrolling page, and with shadow roots on an article, on the body, and declared late           |
| A tab moved to another tab group or window keeps its reading style, and the place of a page that scrolls as a whole; the split view follows only its page (#126)                   | `move.test.ts`: the place, by the element at the window's top, through `display: contents` and in parts closed again; placing again at `load` until the reader's input    | `move.e2e.ts`: a narrower tab group, a new window, a theme changed in place, the split view, scrolling before load, closed parts       |
| **Unreleased (#157):** The split view follows the reader's scrolling of its source right after its tab moves, on from its place; the find bar moves neither side                   | `move.test.ts`: showing the moved page after the reader's scrolling, input only, or neither; `split.test.ts`: the placed side, the find bar; `source.test.ts`             | `move.e2e.ts`: before the page shows, in the frame that places it, or between; on from its place, to its start; the find bar           |
| The source view stays scrolled as far as it was when its tab moves to another tab group or window (#135)                                                                           | `source.test.ts`: back after a layout change or a resize, not after the reader's scrolling; **Unreleased (#157):** nor before Chromium reports it                         | `move.e2e.ts`: another tab group and a new window; **Unreleased (#157):** the reader's scroll to its start                             |
| Toolbar buttons and the find bar are labelled, the toggles and view modes say their state, and the match count is announced                                                        | `find.test.ts`, `reading.test.ts`, `rendered.test.ts`                                                                                                                     |                                                                                                                                        |
| Archived pages show as the previous build showed them                                                                                                                              |                                                                                                                                                                           | `corpus.e2e.ts` and `corpus/compare.mjs`: fails if the prototype showed an image that the plugin does not                              |
| A release holds exactly the verified build: its commit's CI passed, its files match their checksums, the zip, and each other, and a stopped run resumes without replacing anything | `release.test.ts`, against a stand-in for GitHub                                                                                                                          | The Release workflow's `verify-published` step, against the published release                                                          |
| Installing the release's zip, turning the plugin off and on, updating it, and restarting Obsidian keep its settings, extensions, and view                                          | `release.test.ts`: the zip holds the plugin's folder; `extensions.test.ts`: the viewer gives up only its own extensions; `settings.test.ts`: missing and damaged settings | `lifecycle.e2e.ts`                                                                                                                     |
| Large pages stay usable                                                                                                                                                            | `find.test.ts`: at most 10,000 matches; `split.test.ts`: alignment past its limit; `settings.test.ts`: copy limits; `document.stress.ts`: 130,000 templates               | `corpus.e2e.ts`: every page, the 600 KB page with 500 images too, opens and passes its checks within 15 s                              |

`release.test.ts` also invokes the packaging command in disposable synthetic checkouts: protected
paths, unowned contents and links are refused without deleting their targets; fresh, empty and
previously owned outputs package successfully, including version switches and checkouts under linked
ancestors. It checks malformed/foreign markers, file destinations, missing homes, hard-link
preservation, and marked assets reaching the publish dry run's GitHub check. The CLI dry-run
output test rejects any GitHub write and requires only the proposed changes, without messages
claiming publication completed; the library tests also assert that real state is unchanged.

Find regression coverage (#121, #122, #124): `find.test.ts` checks fallback and SVG exclusions,
closed selected options, composed shadow content, range boundaries, and empty-query collection.
`find.e2e.ts` compares paired screenshots with each word transparent, asserts the entire fixture
fits the frame, and checks nested declarative roots, slots, painted highlights, and unchanged shadow
structural selectors before, during, and after searching on both hosts. The #121 decision retains
`checkVisibility()` (SVG switch branches pin it) and avoids collection for empty queries;
nonempty searches still walk the page.

There is no standing benchmark suite: timings on CI's shared runners vary too much to fail a build
on. Costs that could matter were measured in Obsidian in their pull requests, such as about a
second for every 8 MB copied into a page with scripts on (#58), and about 1.5 s for a search of a
page with 80,009 elements, three times as long as before find left out hidden text (#121).

CSS resource coverage (#91): `css.test.ts` checks the scanner's token kinds and spans, bad strings,
escapes (only 0-9, A-F, and a-f are hex digits) and line continuations, malformed URL recovery, and
nesting in import preludes. The CSS token boundary cases in `document.test.ts` cover strings,
comments, escaped URL names, whitespace-terminated hex escapes, U+0000 in linked stylesheets,
top-level imports and the end of their media lists, and the local-file copying pass, in `<style>`
elements and linked stylesheets, the document's and a shadow root's alike (#124). They also check
that 20,000 malformed URL openers preserve their text within 2 s, and that linked stylesheet imports
keep their cycle and eight-file depth limits, also in a shadow root. `resources.e2e.ts` checks
generated content beside an applied local stylesheet in real Obsidian, in the document and in a
shadow root. `scripts/css-benchmark.mjs` reports a revision's time and peak memory for synthetic 300
KB and 4 MB stylesheets, as observations rather than a check.

**Unreleased (#154):** beside the eight-file depth limit, `document.test.ts` checks the page's
stylesheet limits: at most 1,000 links and imports followed, and 16 million characters of the
stylesheets' text, shared by the page's links and imports in the document and in shadow roots.
Every link and import followed counts, also of a missing, too large, or left-out stylesheet, so
that one past the limit stays a link or an import and is not read. A smaller stylesheet after one
too large still fits, one of exactly the limit fits alone, and each file is read once. A repeat of
the page's own link or `<style>` import of a stylesheet copied whole gets that copy and counts
only its text, each time, so that 550 components that link a stylesheet and 550 that import it,
each kind more than the count allows, show whole. A repeat of one that cannot be read counts
nothing, so that a stylesheet after 1,000 links and 1,000 imports of a missing or unreadable one
is still copied. A link and an import of the same stylesheet repeat each other, as both are closed
at their end (#155), and a repeated import of a stylesheet with a stray `}` stays an import in
media conditions, also after a link of it. One that the count or the text limit cut short is
prepared again, and with **Local
files with scripts on** the copy limits count the files of each place. `document.stress.ts`
prepares eight stylesheets that each import the
next ten times, eleven million stylesheets without the limits, with small and with 20 KB
stylesheets, and a page of 4,000 such components. Its context fails the preparation once it has
looked at twice as many imports as the limits allow, so that a missing limit fails the test within
a second; by extrapolation from #154's measurements, the copy would otherwise pass V8's longest
string within a minute or two. `resources.e2e.ts` checks in Obsidian 1.5.3 and the latest that such
a page shows the stylesheets up to the limit, that an import past it does not apply, and that the
window's timers never stop for 2 s while it opens. They stopped for at most 0.3 s when measured
(#154), against 3 to 5 s with five imports a stylesheet before the limits, and, by extrapolation,
6 to 10 minutes for this page.

Import position coverage (#136): `css.test.ts` checks where imports count: only where a top-level
rule starts, before every rule but `@charset`, `@supports-condition`, other imports, and `@layer`
statements before the first import, with `<!--` and `-->` left out between rules. The cases in
`document.test.ts` read no import after a style rule, in a rule's selector, or after a stray `)`,
`}`, or `;`, or an `@layer` statement after an import, in `<style>` elements and linked stylesheets,
the document's and a shadow root's alike, with and without copying files. `resources.e2e.ts` checks
in Obsidian that such an import does not apply, that one after `@charset`, an `@layer` statement,
and `<!--` does, and that a linked stylesheet that starts with a byte order mark keeps its import,
as Obsidian's reads leave the mark out.

Import condition coverage (#144): `css.test.ts` classifies an import's conditions by their tokens:
none, a media query list, or conditions that start with `layer` or `scope`, or have a function at
their top level, such as `layer()`, `scope()`, and `supports()`, written with comments and escapes
too. `document.test.ts` checks that only a media query list becomes `@media`, and that the others
stay imports and read nothing. `resources.e2e.ts` checks in Obsidian that an import into a layer
with a comment before `layer` stays an import in the copy, which Obsidian does not load (#151).

Imported stylesheet end coverage (#139): `css.test.ts` checks what closes a stylesheet that ends
inside a comment, a string, an unquoted URL, an escape, blocks, or a rule that has not ended, that
nothing is open once it is closed, and which `}` are outside any block. The cases in
`document.test.ts` copy no file that only the importing stylesheet's strings name, keep the rules
after the import, and resolve an unquoted URL at the end of an imported stylesheet against that
stylesheet, in every place a page has a stylesheet. An import with media conditions of a stylesheet
with a `}` outside any block, also one in a stylesheet that it imports, stays an import.
`resources.e2e.ts` checks in Obsidian that the rules after imports whose stylesheets end inside a
string, a comment, an unquoted `url(`, and a block apply, and that their strings stay strings with
scripts on and files copied.

**Unreleased (#155):** the page's own stylesheets are closed the same way. The cases in
`document.test.ts` import the file of a last import without its `;` in a `<style>` and a linked
stylesheet, the document's and a shadow root's alike, with and without copying files, and in
`inlineStylesheet`. An unquoted URL at the end of a linked stylesheet resolves against that
stylesheet, and is copied with **Local files with scripts on**; one at the end of a `<style>` is
copied, and located by name. The copy keeps a `<style>`'s closed text, and one that CSS leaves
closed as it is. A link and an import of the same stylesheet get one text, read and counted once,
which keeps its stray `}` for an import with media conditions. `resources.e2e.ts` checks in
Obsidian 1.5.3 and the latest, with scripts off and with them on and files copied, that a linked
stylesheet and a `<style>` that end in such an import apply its file, and that the URL at the end
of a linked stylesheet is the stylesheet's. The same spec serves its whole page of imports over
HTTP to a frame of Obsidian's window without a sandbox, where neither the plugin nor Obsidian's
policy stands between Chromium and the page, and checks that Chromium shows each case as the
viewer does, apart from the import into a layer, which the viewer leaves an import (#151).

`<style>` and `<link>` coverage (#143): `document.test.ts` checks, in the document and in a shadow
root, with and without copying files, that the plugin reads and copies only for an HTML or SVG
`<style>`'s own text nodes, joined, and for HTML stylesheet links, also inside SVG's
`<foreignObject>`. Rewriting an SVG `<style>` keeps its child elements, and text put into it stays
text when the copy is parsed again. Nothing that a MathML `<style>`, an SVG `<style>`'s child
elements, or a `<link>` inside SVG or MathML names is read or copied, and a MathML `<style>` or such
a `<link>` does not keep the reading style out. `resources.e2e.ts` shows in Obsidian 1.5.3 and the
latest release what Chromium applies, in the document and in a shadow root, with scripts off and
with them on and copying files: an SVG `<style>`'s own text, joined across a child element, and
nothing inside that element, in a MathML `<style>`, or from a `<link>` inside SVG, to which Chromium
gives no stylesheet. It also checks that the copy holds neither those stylesheets' text nor their
files.

**Unreleased (#147):** `document.test.ts` checks, in the document and in a shadow root, with and
without copying files, that the plugin prepares a `<style>`, HTML or SVG, only with no `type`, an
empty one, or `text/css` in any ASCII case, and one with a `disabled` attribute as any other. A link
becomes a `<style>` only without a `disabled` attribute, whatever its value, and with no `type` or
one whose part before a `;`, trimmed of the whitespace that Chromium trims, is empty or `text/css`.
The other elements stay exactly as written, and nothing is read or copied for them; a page whose
only stylesheets are such elements gets the reading style. `resources.e2e.ts` builds a page with 17
types on a `<style>` and a link, disabled links, and four types on an SVG `<style>`, in the document
and in a shadow root. It serves the page over HTTP to a frame of Obsidian's window without a
sandbox and checks that what Chromium applies there matches #147's measurements. In the viewer, in
Obsidian 1.5.3 and the latest, with scripts off and with them on and files copied, the page shows
exactly what Chromium applied, the viewer reads only the stylesheets of the elements that apply,
keeps the others as written, and copies only the images of the `<style>` elements that apply.
Chromium 114, in Obsidian 1.5.3, applies an SVG `<style>` of type `TEXT/CSS` only in lowercase,
and Chromium 150, in 1.15.1, as an HTML one; the spec accepts either for that case, and the viewer
prepares it on both, so on 1.5.3 it reads that `<style>`'s import, which applies nothing there.

## Shown to fail

On 2026-10-21, each of these deliberate breakages failed the check named:

- Granting scripts together with same-origin access: `rendered.test.ts`.
- Reading any vault file as a stylesheet: `document.test.ts`.
- Accepting `..` in a vault path: `document.test.ts`.
- Allowing `<object>` content in the page's policy: `document.test.ts`.
- Leaving out the copy's `<base>`: `document.test.ts`, and `resources.e2e.ts` in Obsidian.
- Lifting the copy limit for a file: `settings.test.ts`.
- A `fetch` call in the plugin's code, even one that never runs: `policy.test.ts`.
- A wrong default in the README, a label missing from `.github/labels.json`, a renamed required CI
  job, a changelog without the manifest's version, a link to a missing heading, an unregistered
  end-to-end spec, and a skipped test: `consistency.test.ts`.
- Missing prototype results in a full end-to-end run: `corpus/compare.mjs`.
- Publishing a commit whose CI has not passed, moving a tag, changing a published release,
  publishing a draft whose upload arrived damaged, and a wrong latest-release mark:
  `release.test.ts`. Against GitHub's real state, a dry run of 0.5.0 from a later commit refused
  because the tag points elsewhere, and one with a zip packaged differently refused to change the
  published release.

On 2026-11-16, the earlier preparation of a page, which showed the file as it is when preparing its
copy failed, and could fail on CSS escapes and on stylesheets that could not be read, failed
`document.test.ts`, `rendered.test.ts`, and `resources.e2e.ts` in Obsidian 1.5.3 and 1.15.1.

On 2026-11-16, these failed the check named (#90):

- Leaving out the view's `save` override: `refresh.test.ts`; in Obsidian 1.5.3 and 1.15.1,
  `read-only.e2e.ts`, where leaving a tab after a refresh wrote the refreshed contents to the file.
- Leaving out the refresh's check that it is the latest and its file is still shown:
  `refresh.test.ts`; in Obsidian, with the `save` override left out too, `read-only.e2e.ts`, where
  the second file was overwritten with the first's contents, and the first file's read error
  replaced the third page.

On 2026-11-16, keeping the viewer's extensions registered after the plugin unloads, and ignoring
the saved settings when it loads, each failed `lifecycle.e2e.ts` on Obsidian 1.5.3 (#98).

On 2026-11-16, giving the frame its sandbox only after inserting it failed `rendered.test.ts`,
and `resources.e2e.ts` on Obsidian 1.5.3 and 1.15.1 (#83).

On 2026-11-17, find in the page that left out a canvas's fallback text, or that found the children
of a progress bar, failed `find.e2e.ts` in Obsidian 1.5.3 and 1.15.1. Closing the find bar without
its pending search failed only the three close tests in `find.test.ts`.

On 2026-11-17, the earlier handling of links, which found a clicked link from the event's target,
where a shadow root hides it, failed `links.test.ts`, `document.test.ts`, and `links.e2e.ts` in
Obsidian 1.5.3 and 1.15.1. Finding links along the event's path instead, while leaving the copy's
shadow roots closed and the frame's other navigations uncanceled, still failed `links.e2e.ts` in
both versions.

On 2026-11-17, these failed `links.e2e.ts` in Obsidian 1.5.3 and 1.15.1:

- Leaving the view to watch a frame's new document only when it loads, without making the copy
  inert: after the tab moved to another tab group or window, a link clicked before the page loaded
  again navigated the frame away from the page, and a copy of the frame that the view did not
  watch followed its links.
- Making the copy inert, but watching the new document only when it loads: the moved page could
  not follow its links before it loaded.
- Watching the new document at once, without making the copy inert: the unwatched copy of the
  frame followed its links.
- Leaving out the cancellation of the frame's other navigations: a click on a link in a closed
  shadow root that the page did not declare, and one on a link copied by SVG `<use>`, each started
  a navigation that nothing canceled.

Collecting a page's templates by passing them all to one call failed the test now in
`document.stress.ts` on a page with more of them than a call can take.

On 2026-11-17 (#115), with the view as 0.5.2 has it, Obsidian's reload of a changed file that
finished after another file opened in the tab showed the first file's contents under the second
file's name: in `refresh.test.ts`, whose stand-in for Obsidian now reloads a changed file as
Obsidian 1.5.3 and 1.15.1 do, and in `read-only.e2e.ts` in Obsidian 1.5.3 and 1.15.1, where nothing
was written. Leaving out the view's own read of its file failed both of `read-only.e2e.ts`'s tests
of Obsidian's reload in 1.5.3 and 1.15.1: neither a change on disk nor the late reload showed the
page again.

On 2026-11-17 (#124), the earlier preparation of a page, which left the content of its templates,
and so of its declared shadow roots, as written, failed the new shadow DOM and SVG link tests in
`document.test.ts`, and in Obsidian 1.5.3 and 1.15.1 those in `resources.e2e.ts` and `links.e2e.ts`:
the shadow DOM's image found by name, linked stylesheet, and import did not show, with scripts off
or with them on and copying files; its link and image had no title; and SVG links had no
`xlink:title`. The split view's earlier pairing, which left out shadow roots, failed
`split.test.ts`, and `split.e2e.ts` in both versions, where scrolling the source to paragraph 30's
line moved the page to paragraph 88.

On 2026-11-17 (#124), after the independent review, these failed against the earlier version of that
change. Giving every SVG link without text a tooltip failed the new tooltip test in
`document.test.ts`, and `links.e2e.ts` in Obsidian 1.5.3 and 1.15.1, where a link around a labelled
shape and one around a `<use>` icon with a title were named by their URLs instead (#117). The split
view's pairing, which left out the body's own shadow root and took every shadow root to come before
its host's own content, failed `split.test.ts`, and `split.e2e.ts` in both versions: scrolling the
source to paragraph 30's line moved a page whose body has a shadow root to paragraph 89, and
scrolling it to paragraph 15's line left a page that declares its shadow root after 30 paragraphs at
paragraph 1.

On 2026-11-17 (#124), after the follow-up review, these failed against the version before it. Giving
a tooltip to an SVG link around HTML in a `<foreignObject>` failed the new tooltip test in
`document.test.ts`, and `links.e2e.ts` in Obsidian 1.5.3 and 1.15.1, where a link around text in a
shadow root declared there was named by its URL instead (#117). The split view's pairing, which took
any comment with its mark's text for the mark, and also the mark of a declaration that stayed a
template, failed `split.test.ts` and `document.test.ts`, and `split.e2e.ts` in both versions: with a
comment of the page's own with that text before its first paragraph, scrolling the source to
paragraph 15's line left a page that declares its shadow root after 30 paragraphs at paragraph 1.

On 2026-11-17 (#126), `move.e2e.ts` failed in Obsidian 1.5.3 and 1.15.1 with the view as 0.5.2 has
it: after the tab moved, the page was back at its top in a new tab group and in a new window, a
theme changed in place was undone, and the split view's sides were apart. Keeping the page's place
as the height it was scrolled to failed only the move to a narrower tab group, where the page showed
paragraph 19 or 21 in place of 30. Keeping the split view's following of the document that the frame
dropped failed only the split view's test, which counted six measurements of that document after the
move. Placing the page again when it had loaded, even after the reader had scrolled it with the
mouse wheel, in the page or in the split view's source, failed both tests of the reader's scrolling:
the page showed paragraph 30 again in place of 41 or 42. Treating only a part without a box as
closed failed both tests of a part closed again, in both versions: the page showed a closed
`<details>` element 418 pixels, and a closed accordion's panel 429 pixels, above the window's top.
It also failed `move.test.ts`'s tests of those parts and of a page inside an element with
`display: contents`, which kept its place only as a share of the body's height.

**Unreleased (#157):** On 2026-11-18, with the view as 0.6.0 has it, five of `move.e2e.ts`'s tests
of the reader's scrolling of the split view's source in a move failed in Obsidian 1.5.3 and 1.15.1:
to line 30 before the moved page showed again, in the frame in which the view placed it, from one to
the other, and with the find bar open, the source went back to line 20 and the page stayed at
paragraph 12; scrolled on by 200 pixels, it stayed at line 20. The version that the independent
review read, `8214323`, failed both tests with the find bar open and an input before the page
showed, in both versions: the find bar's search again scrolled the source to its match, which then
led, and both sides went to paragraph 26 and line 33 or 34. It failed the test scrolled on by 200
pixels in 1.5.3, where the page followed the source from its top to paragraph 2 and line 10.
The version that the follow-up review read, `73fce54`, failed the five tests of a scroll to the
source's start in both versions, where the view put the source back where it was: in the first task
after a move to a new window, and with no move, when a layout change or a resize came before
Chromium reported the scroll, in the split view and in the source view, which 0.6.0 has done since
#135. Each of these deliberate breakages failed a unit test:

- In `placeNextDocument`: following the placed page whatever the reader scrolled, also when the
  page was at its top before the move; passing over the source's earlier scrolling also after the
  reader's input; placing the page again at `load` after it; not telling the follower of the
  placement; and passing over nothing. `move.test.ts`.
- Leaving the view's placement to lead through the page's own report of it: `split.test.ts`.
- In the view: scrolling to the find bar's match after a move; not starting the watch of the reader
  when the frame drops its page, or restarting it when it runs already; not giving it the split
  view's source; not passing what it saw, or the follower, to `placeNextDocument`; and not stopping
  it when the view shows a new frame. `split.test.ts`.
- Not keeping the split view's source's place; taking the reader's scroll to the source's start for
  a lost place before Chromium reports it; and doing so still after the next frame, or after a
  scroll event. `source.test.ts`.

On 2026-11-17, each of these deliberate breakages failed the check named (#91):

- The regular expressions used before #91, which read URLs and imports inside CSS strings and
  comments: `document.test.ts`, also with only a shadow root's `<style>` elements and linked
  stylesheets in its cases (#124).
- Counting a string that a newline ends as a string, or reading U+0010 to U+0019 as hex digits:
  `css.test.ts` and `document.test.ts`.
- Taking a malformed quoted `url(` as a URL: `css.test.ts` and `document.test.ts`.
- Counting braces without the parentheses and brackets around them: `css.test.ts` and
  `document.test.ts`.
- Reading U+0000 in a linked stylesheet as anything but an identifier character, and processing
  linked stylesheets again as the page's own styles: `document.test.ts`.
- Leaving out of the second pass the `<style>` elements that links become only in the document,
  not in a shadow root (#124): `document.test.ts`, where a 20-deep import chain linked from a
  shadow root read 16 files rather than 8.
- Removing a string's line continuations before decoding its escapes, so that `"gh\6\` and a
  newline before `fst.css"` named `ghost.css`: `css.test.ts` and `document.test.ts`.
- Trimming the end of an import's media list, which removed the newline that ends a bad string
  there, or trimming JavaScript's whitespace at its start, which removed a U+FEFF that starts a
  name there: `document.test.ts`.
- Assigning every `<style>` element's text, even unchanged, which removed an SVG `<style>`
  element's children: `document.test.ts`.

On 2026-11-17 (#136), the stylesheet preparation before that change, after #91, failed both new
tests of imports in `resources.e2e.ts` in Obsidian 1.5.3 and 1.15.1, where an import after a style
rule applied. Finding imports anywhere outside blocks, as it does, or at the start of any top-level
rule, or allowing `@layer` statements after an import, failed `css.test.ts` and `document.test.ts`.
So did reading `<!--` and `-->` as other text.

On 2026-11-17 (#144), in the same `resources.e2e.ts` run, an import into a layer with a comment
before `layer` became `@media /**/ layer`. The regular expression that classified an import's
conditions before that change failed `document.test.ts`.

On 2026-11-17 (#139), in the same `resources.e2e.ts` run, the rules after imports whose stylesheets
end inside a string, a comment, an unquoted `url(`, or a block did not apply. These failed
`document.test.ts`:

- Inlining an imported stylesheet without closing it.
- Closing it after resolving its own URLs, which left its unquoted URL at the end unresolved.
- Putting a stylesheet with a `}` outside any block in `@media`, or checking only its own text and
  not that of the stylesheets it imports.

On 2026-11-17 (#143), the preparation of `<style>` elements and links as `main` had it at `f329f7f`
failed four tests in `document.test.ts`, and both tests of `<style>` text in `resources.e2e.ts` in
Obsidian 1.5.3 and 1.15.1. There, a rule inside an SVG `<style>`'s `<desc>` applied once the copy
rewrote the `<style>`, which lost its `<desc>`. A `<link>` inside SVG applied, as an SVG `<style>`
that the copy put in its place. The copy held the text of both stylesheets that nothing applies and,
with scripts on, six copied images where the applied CSS names two. Each of these breakages failed
the check named in `document.test.ts`:

- Processing a MathML `<style>`: the reads and copies test, and the reading style test.
- Reading an SVG `<style>`'s `textContent`: the reads and copies test, and the rewriting test.
- Assigning a rewritten `<style>`'s `textContent`, which removes its child elements: the rewriting
  test.
- Turning a `<link>` inside SVG or MathML into a `<style>`: the links test, and the reading style
  test.
- Counting any `<style>` as the page's own styles: the reading style test.

**Unreleased (#154):** On 2026-11-18, each of these breakages failed the check named:

- No limit on how many links and imports a page follows: `document.stress.ts`'s test of small
  stylesheets, within a second, with its context's error, and four tests in `document.test.ts`.
- No limit on the stylesheets' text: the stress test of 20 KB stylesheets, which took in 1,000
  rather than 792, and three tests in `document.test.ts`.
- Counting only the links and imports whose stylesheet the copy takes in: the counting test in
  `document.test.ts`.
- No reuse of a page's repeated links and imports, reuse of links only or of imports only, or a
  repeat that takes one from the count: the components test in `document.test.ts`, and the stress
  test of 4,000 components. A count limit of 10,000 without reuse passed the components test of the
  time, with 600, but kept Obsidian from responding for 3 to 8 s on eight stylesheets that each
  import the next ten times.
- Keeping no result for a stylesheet that cannot be read: the test of repeats of such a stylesheet.
- One kept text for a link and an import of the same URL, a repeat that loses the stray `}` of its
  stylesheet, and a repeat checked against the text limit but not added to it: the test of each.
- Reusing a stylesheet that the count, or the text limit, cut short: the test of preparing it
  again after each. Reusing stylesheets at every depth: the counting test, the test of preparing
  again after the text limit, and both fan-out stress tests.

The test in `resources.e2e.ts` was not run against the preparation before the limits, which would
keep Obsidian from responding for 6 to 10 minutes on its page, by extrapolation; #154 records that
preparation's measurements in Obsidian, with up to five imports a stylesheet.

**Unreleased (#147):** On 2026-11-18, the preparation of `<style>` and `<link>` elements as `main`
had it at `eb92df5` failed both viewer tests of types in `resources.e2e.ts` in Obsidian 1.5.3 and
1.15.1. There, the links of other types and the disabled links applied, as `<style>` elements put in
their place, the copy kept none of the elements that do not apply as written, the viewer read 20
stylesheets of elements that apply nothing, and with scripts on it copied 44 images where the
`<style>` elements that apply name 16. Both served pages showed what the tests expect. In an
earlier run of the spec, with an SVG `<style>`'s type compared case-sensitively, an SVG `<style>`
of type `TEXT/CSS` in 1.15.1 applied its own rule but not its import, which Chromium applies. Each
of these breakages failed the check named in `document.test.ts`:

- Preparing every `<style>`, whatever its type: the `<style>` test, the SVG `<style>` test, and the
  reading style test of #147.
- Comparing an SVG `<style>`'s type case-sensitively: the SVG `<style>` test.
- Leaving out a link's `disabled` attribute, or its type: the link test and the reading style test
  of #147.
- Trimming nothing from a link type's essence, or JavaScript's whitespace, which includes U+00A0:
  the link test.
- Counting any `<style>` or stylesheet link as the page's own styles: the reading style tests of
  #143 and #147.

**Unreleased (#155):** On 2026-11-18, in the same `resources.e2e.ts` run, a linked stylesheet and a
`<style>` that end in an import without its `;` did not apply its file, and the unquoted URL at the
end of a linked stylesheet resolved against the page, in Obsidian 1.5.3 and 1.15.1, with scripts
off and on. Each of these breakages failed the check named in `document.test.ts`:

- Not closing a linked stylesheet: the tests of a last import, of the URL at its end, of one text
  for a link and an import, and of a linked stylesheet's stray `}`.
- Not closing a `<style>`: the tests of a last import, of the URL at its end copied and located, of
  the closed text, and the #143 test of an SVG `<style>`'s child elements.
- Keeping a link and an import of the same stylesheet apart: the test that counts them once.
- Dropping a stylesheet's own stray `}` from its prepared result: the stray `}` tests of #139,
  #154, and #155.

Since #155, a link and an import of the same URL share one kept text, so the #154 entry above for
one kept text describes a breakage of that time, not of the current checkout.

## Limits

- Which tab a link opens in (#141) is tested in Obsidian for plain and Ctrl clicks in the main area,
  a pinned tab, and a new window. Ctrl+Alt (a split) and Ctrl+Alt+Shift (a new window) are checked
  only against the unit tests' stand-in, and a page in a sidebar is not tested. WebDriver cannot
  click inside a page in a second window, so that test dispatches the click in the page.
- On Chromium 135 to 141, which some Obsidian versions between the tested ones use, a page's own
  styles can lift the copy's inertness before the view watches it (#127). Neither tested host is
  affected; there the view's listeners, added as soon as each document exists, still protect it.
- Linux desktop is the supported Obsidian target. Windows provides additional build and unit-test
  coverage, and can run Linux Obsidian in Docker. Windows Obsidian, macOS, and mobile are outside
  the support scope; the manifest prevents mobile installation (#65).
- Obsidian 1.5.0 to 1.5.2, which the manifest allows, were Insider builds that need an account to
  download; 1.5.3 is the oldest version tested. The versions between 1.5.3 and the latest are not
  tested.
- **Unreleased (#147):** which `<style>` and `<link>` elements Chromium applies was measured by
  their `type` and a link's `disabled` attribute. A link's `rel` values beyond `stylesheet` and
  `alternate`, its `media` and `title`, and a `type` that a script changes are not measured.
- The bundle check in `policy.test.ts` sees only the plugin's own code. Obsidian's TextFileView,
  which the view extends, saves a view's data to its file from Obsidian's own code. The unit tests
  model that saving as Obsidian 1.5.3 and 1.15.1 implement it, and `read-only.e2e.ts` checks in
  Obsidian that it never writes, so its weekly run would see a release that saves another way.
- The update in `lifecycle.e2e.ts` installs the same build under a newer version. It shows that
  Obsidian runs the replaced files with the saved settings and workspace, not how the code of an
  earlier release reads them, which `settings.test.ts` covers for missing and damaged values.
  Removing the plugin, and installing or updating it through Obsidian's community plugin browser,
  where the fork is not listed, are not tested.
- Screen readers are not tested; the tests check the labels and attributes that they read.
- No test sees a tooltip appear: Chromium draws it outside the page, where WebDriver's screenshots
  do not reach. The tests check the attributes that Chromium shows as tooltips. On 2026-11-17,
  moving the display's own pointer over the links and capturing the whole screen showed them in
  Obsidian 1.5.3 and 1.15.1.
- Obsidian 1.5.3 and 1.15.1 name an SVG link from nothing inside a `<foreignObject>`, which
  Chrome 157 includes. The viewer gives such a link no tooltip, which would replace that name, so
  on those versions a link around HTML without a label of its own has neither (#117).
- After a tab moves (#126), the view stops placing its page again once the reader presses a key or a
  pointer button, touches the screen, or turns the mouse wheel, in the page or elsewhere in the
  view. `move.e2e.ts` scrolls with the mouse wheel. `move.test.ts` stops the placement with each of
  the four kinds of input in jsdom, which does not show that Chromium sends them where the view
  listens. A page inside an element with `display: contents`, and a part that a page hides with
  `display: none`, are tested only in `move.test.ts`.
- **Unreleased (#157):** `move.e2e.ts` scrolls the split view's source at a moment of a tab's move
  with a wheel or pointer event and the source's `scrollTop`, since WebDriver's input cannot be
  timed to a task, and it instruments the frame's window to find the task in which the view places
  the page. Chromium reports the source's scrolling before the page's in one frame; traces in
  Obsidian 1.5.3 and 1.15.1 measured that for #157, and the committed tests pass in either order.
  Whether Chromium reports a scroll made before the page shows again before or after the view
  places it depends on its next frame; `move.test.ts` tests both. Only `move.test.ts` tests that
  an input still being dispatched when the frame drops the page, as a hotkey that moves the tab, is
  not the reader's. For one frame after the reader's input in a source, the view does not take the
  source at its start for one that lost its place; the tests give that input as a dispatched event.
  On 1.5.3, that frame can keep a place that a tab's move lost, when a key comes in the same frame
  as a hotkey that moves the tab, as a macro sends them. A scroll of the source to its start by the
  find bar itself, not by the reader, can still be undone on 1.5.3 by a layout change or a resize
  in the frame after it: in the source view, as 0.6.0 does, and in the split view (#167).
  In a new window on Obsidian 1.5.3, the split view's sides can end a line or two out of step after
  a move, also without the reader, as before this change, which the tests' tolerance of a line
  allows (#165).
- With scripts off, a link inside what SVG `<use>` copies does nothing when clicked. The copy is in
  the browser's own shadow tree, which hides from the view which link was clicked, and the view
  cancels the navigation that the click starts, as `links.e2e.ts` checks. Pages mostly use `<use>`
  for icons, inside a link around the `<svg>`, which is followed as usual.
- Find counts a closed select's chosen option text, but Chromium paints no Custom Highlight on
  that native label. Selects with `multiple`, list boxes (`size` above one), and option `label`
  attributes are not searched. Shadow matches stay within one tree; SVG `<use>` copies live in
  inaccessible browser shadow trees and are not searched (#122, #124).
- The 15 s limit for a corpus page is a ceiling against a page that hangs, not a measure of speed.
- The Release workflow's writes to GitHub are tested against a stand-in, and its reads against
  GitHub; its publish job runs for real only in a release, whose run the release's pull request
  records.
- The lint and end-to-end test tools retain moderate advisories (#85). Both dependency packages
  have a required CI audit that fails on any advisory above moderate severity that
  `.github/audit-exceptions.json` does not accept, and on an exception that is no longer needed.
  `audit.test.ts` checks its decisions, and CONTRIBUTING.md says when an exception is acceptable. The tools run against the repository's own files, and only its configuration
  supplies their glob patterns.
