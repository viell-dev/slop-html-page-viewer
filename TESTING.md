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

A test in Obsidian that runs past its timeout fails, but WebdriverIO cannot stop its code. Each
test's and hook's code therefore runs in a scope of its own (`test/e2e/support/late-requests.ts`),
and once the test or hook has its result, the run refuses that code's WebDriver requests, so that
it cannot drive Obsidian during the tests after it (#170). A test has its result when WebdriverIO's
`afterTest` hooks start; the configuration's takes a failed test's screenshot in a scope of its own,
but a service's own `afterTest` requests would be refused with the test's. Mocha goes on only once
the requests that the code had already sent have their answers, for at most 30 s. The failure's
message names those requests and the ones refused before Mocha went on; the first request refused
after that is printed to the log. So code that a test or hook starts can send requests only until
that test or hook has its result: a `before` hook cannot leave work running for the tests after it.

The configuration spreads these hooks from `test/e2e/support/hooks.ts`: `transformRequest`,
`before`, `beforeTest`, and `afterTest` with its screenshot. `session.sh` runs
`test/e2e/support/late-requests.check.ts` before the tests in Obsidian, which runs the same hooks
without Obsidian. It uses Mocha with WebdriverIO's own wrapping of tests, and a stand-in browser
that sends each request in WebdriverIO 10's order. It checks four things. A test's code has ended
when the configuration's `afterTest` returns, before anything that the hook awaits, so a test that
times out sends no request once that hook starts, while the screenshot goes through. Mocha waits for
a request still outstanding at the result. Each failure says what its code still did. The first
refusal after a test passed is printed. Breaking any of these in `hooks.ts` or `late-requests.ts`
fails the check, and so does an `afterTest` that ends the test's code only after the screenshot or
after an `await`. The check does not cover that `wdio.conf.mts` spreads these hooks, since
importing the configuration downloads hosts and clears results. `harness.e2e.ts` checks in Obsidian
that a request from code that goes on after its test passed is refused and never reaches Obsidian.
Each run therefore prints one such refusal to the log for each host, as expected:
`[late requests] Refused executeScript from "The test run in Obsidian leaves code running after it passes"…`.
A test that runs outside its scope, as under a copy of Mocha other than the one that
`@wdio/mocha-framework` runs, makes every request fail.

`test/pixels.test.ts` checks that the tests' reader of WebDriver's PNG screenshots decodes RGB and
RGBA rows with each of PNG's five row filters, and refuses an undefined one.

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
| **Unreleased (#162):** The find bar shows its matches in the source again after its tab moves to another tab group or window, without scrolling                                    | `find.test.ts`: another tab group, a new window, not the rendered page                                                                                                    | `move.e2e.ts`: another tab group and a new window, then Enter                                                                          |
| **Unreleased (#167):** The source stays where the find bar scrolls it, and goes back after a move that comes with a modifier key in it                                             | `source.test.ts`: the find bar's scroll before Chromium reports it; modifier keys; `move.test.ts`                                                                         | `move.e2e.ts`: the find bar's scroll to the start; a modifier key in the task of the move                                              |
| **Unreleased (#175):** After its tab moves to another window, Enter cancels the find bar's delayed search; after a move out of a window that closes, the bar still searches        | `find.test.ts`: Enter in a new window, also after typing before the move; typing after a move out of a window that closed                                                 | `move.e2e.ts`: typing and Enter in a new window; typing after the move back                                                            |
| **Unreleased (#165):** The split view's sides stay in step in a new window when Obsidian's styles arrive there after the view has followed the page                                | `split.test.ts`: the first resize of the source's lines soon after a move to a new window; a source that led keeps its line; none in one window                           | `move.e2e.ts`: the new window's app.css held back until the view has followed the page or the reader                                   |
| **Unreleased (#178):** A tab that Obsidian shows again after hiding it keeps the place of a page that scrolls as a whole, and the split view's sides where they were, in step      | `move.test.ts`: the frame's own observer; held while hidden, back when shown; `split.test.ts`: either order of reports, the side that led last, the reader, the find bar  | `move.e2e.ts`: rendered, split, wrapped lines, a long head, the reader, the find bar, a sidebar; the Source view and a column          |
| **Unreleased (#182):** Shown again after its pane changed width while hidden, a page shows the element at its top, and the split view's source the line at its top                 | `move.test.ts`: measured once scrolling settles for 100 ms, out of date after a scroll or a layout change, not hidden, sideways; `split.test.ts`: the source's line       | `move.e2e.ts`: narrowed while hidden, rendered, split, sideways; Readable line length and narrowing while shown; hidden mid-scroll     |
| **Unreleased (#186):** A tab moved while hidden shows its page where it was, and the split view's sides in step; also one whose hidden frame reloads                               | `split.test.ts`: the hidden page's element for the next document, also one with no size yet, twice; a page moved while it shows                                           | `move.e2e.ts`: rendered and split, by the tab header's menu, a drop's calls, and Split down in the tab in front                        |
| **Unreleased (#189):** The **Source** view shows the line at its top after a move, and when its tab shows again at another width                                                   | `source.test.ts`: lines that wrap otherwise, put back in pixels or at its end, its own observer, a new window; `split.test.ts`: measured at once, not without a width     | `move.e2e.ts`: narrowed while hidden; a narrower and a wider tab group; a new window; a hidden tab moved by its menu                   |
| **Unreleased (#195):** After a move, the split view's side that led last leads: a source keeps its line, and the page follows it until it loads                                    | `move.test.ts`: the source leads, again at load, the page's scrolling passed over; `split.test.ts`: a long head, moved shown or hidden; the source held meanwhile         | `move.e2e.ts`: a long head in another tab group, a new window, and a hidden tab moved by its menu; wrapped rules, a narrower tab group |
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
`find.e2e.ts` compares a screenshot of the whole page with one for each word made transparent,
asserts the entire fixture fits the frame, and checks nested declarative roots, slots, painted
highlights, and unchanged shadow structural selectors before, during, and after searching on both
hosts. It captures the whole page again when the layout changes, which Chromium does when a table
cell or a canvas with `content-visibility: hidden` changes colour, and fails if the page paints
differently at the end (#160). Its searches go through the find bar's input and Enter key in one
script call; the other find tests type theirs. The #121 decision retains
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

**Unreleased (#179):** `css.test.ts` checks which tokens name resources: URL tokens, and the closed
strings directly between the parentheses of `image-set()` and `-webkit-image-set()`, whose names it
compares as CSS does, in any case and with escapes, also in a fallback of `var()`. It finds no bare
string, none in `type()`, `format()`, `local()`, `image()`, `src()`, or `cross-fade()`, none after
the function or in a block inside it, none after a name with a space before its `(` or before a `{`
or `[`, as in the selectors of a custom element, and none left open at the end of the text, and it
follows mismatched closers as CSS nests them. `document.test.ts` checks that a linked stylesheet in
another folder than the page, in the document and in a shadow root, linked, imported in a `<style>`,
or imported in a linked stylesheet, gets such strings absolute and kept as strings, and with
copying, their files, the `2x` image too. The page's own `<style>` and `style` attributes keep such
strings as written, apart from those found by name, and copy their files. Other strings stay as
written, and nothing is read or copied for them. Within #177's text limit, they count as made
absolute, to the character. `resources.e2e.ts` checks in Obsidian 1.5.3 and the latest, in the
document and in a shadow root, that the squares that such strings name in a stylesheet in another
folder, in the page's `<style>`, and in a `style` attribute show the image beside the stylesheet,
not the one of the same name beside the page, with scripts off and with them on and files copied. It
checks that Chromium resolves the same page, served outside Obsidian, alike, that the host supports
strings in both functions and not `image()` or `src()`, and that it drops a bare string as a font's
source.

**Unreleased (#185):** `document.test.ts` checks a page whose `<base>` comes after a `<style>`, a
`<style>` that imports a file, a stylesheet link, an SVG `<style>`, and a `style` attribute, each of
which also comes after the `<base>`, with attributes of its own in each place (#191), in the
document, in a declarative shadow root and one nested in it before the `<base>`, in one after it,
and in a template's content. Those before it, the `<body>`'s `style` attribute among them, get their
URLs, `image-set()` strings, and imports absolute against the page's folder, and the link and the
import read the files there; the others keep their text, and the link and the import read the files
in the `<base>`'s folder, which the copy's `<base>` names. With copying, each copies its files from
its own folder. The `<html>` element's `style` attribute, around a `<base>` in the `<head>`,
resolves against the page, and a reference before the `<base>` that does not resolve as a path there
is found by name. The copy's `<base>` is that of the first HTML `<base>` with an `href`, also an
empty one, and none for one inside SVG, of a `data:` or `javascript:` URL in any case, or in a
template, and an ignored first one lets no later one apply; a `<base>` at the top of the `<head>`
leaves the stylesheets after it as written. An element after the `<base>` that repeats one before it
resolves against the `<base>`, as the copy's own rule (#191). Within #177's text limit, what making
the URLs of a `<style>` and of a `style` attribute before the `<base>` absolute adds counts to the
character, the second of two attributes that each take three fifths of it stays as written, a
rewrite that shortens an attribute gives no room back, rewriting stops once an attribute passes the
room, as the lookups of its references show, past the limit a reference is found by name against its
own base, not the copy's `<base>`, and with copying, those kept as written still copy from the
page's folder. `document.stress.ts` prepares 2,500 `style` attributes of 100 URLs each before a
`<base>`, which would add 19.5 million characters made absolute: those that fit in the limit are,
and the rest stay as written. `resources.e2e.ts` checks in Obsidian 1.5.3 and the latest a page
whose `<base>` comes after most of its squares, which name an image that is green in the page's
folder and blue in the `<base>`'s: a `<style>`, an import, a link, an SVG `<style>`, and a `style`
attribute before it, also in a shadow root, show green, and a `<style>` and a `style` attribute
after it blue. With scripts off, it reads where each square's image comes from; with scripts on and
files copied, it counts the squares of each color, with the blue one of a template's content that
the page's script adds. Two more pages, whose `<base>` is inside SVG, with a red image of that name
in its folder, or has a `data:` URL, show their square from their own folder. Chromium shows the
same pages, served outside Obsidian, alike.

**Unreleased (#187):** `document.test.ts` checks a page with an element of each kind that names a
resource, an image with `src` and `srcset`, a `<picture>` source, a video with `src`, `poster`, a
source, and a track, audio, an image input, a frame, a script, SVG `<use>` and `<image>` by `href`
and `xlink:href`, `<embed>`, and `<object>`, before a later `<base>`, in a declarative shadow root
before it, in a template's content, after it, and in a shadow root after it. Those before it, in the
document and the shadow root, get their URLs absolute against the page's folder, each URL of a
`srcset` too; the others keep their text, for the copy's `<base>`. With copying, each copies its
files from its own base's folder. A reference before it that does not resolve as a path against the
page is found by name, and one after it that resolves there stays as written. A path from the root,
a URL of the web or of `data:`, a fragment, also an SVG `<use>`'s, and an empty or blank value stay
as written, as the page and the `<base>` resolve them alike or they name no file, but a query alone
is made absolute, and a path from the root is too before a `<base>` of another origin. An image
after the `<base>` that repeats one before it resolves against the `<base>`. `resources.e2e.ts`
checks in Obsidian 1.5.3 and the latest a page whose `<base>` comes after an element of each of
those kinds but `<embed>` and `<object>`, a shadow root, and a script that the served page delays,
followed by a repeat of the first image, two SVG images, and a template's image that the page's
script adds. Each names a file of its own, green beside the page and blue in the `<base>`'s folder.
The served page requests each file of the elements before the `<base>` from the page's folder and
the others from the `<base>`'s, and loads the track's, the frame's, and the script's from the
page's. With scripts off, the viewer's copy resolves the URLs of those before it to the page's
folder and of the others to the `<base>`'s, and shows seven green images and three blue ones; with
scripts on and files copied, the copied media, the track's cue, and the script are the page
folder's, with eight green images and four blue ones. `document.stress.ts` makes the 100,000 URLs of
50,000 images and their `srcset` absolute before a `<base>`, in a folder of 1,000 characters, which
makes the copy about 60 times as long as the page: in jsdom on Windows 11, that took 4.3 to 4.9 s,
where `main` at `c853231` prepared the same page in 3.7 s.

`rendered.test.ts` checks that a page's text track is copied only with scripts on and **Local
files with scripts on**, and that with scripts off the view reads no file to copy (#196).
`resources.e2e.ts` checks in Obsidian 1.5.3 and the latest a page with a video's poster, a text
track, and an SVG `<use>` of another file. The served page, whose scripts run, loads the track and
shows the poster and the symbol whole, and its poster only in part under Chromium's controls when
the video has the `controls` attribute. In the viewer with scripts off, the track keeps its URL and
does not load, the poster shows as much as under the served page's controls, within 5 %, and the
symbol not at all; with scripts on and files copied, the track loads, the poster shows whole, and
the `<use>` keeps its URL and shows nothing.

**Unreleased (#198):** `document.test.ts` adds to the page of #187 a table with a `background`
attribute on an element of each kind, the table, a column group, a column, a head, a body, a foot,
a row, a header cell, and a cell, and SVG `<feImage>` and `<script>` by `href` and `xlink:href`.
Before the later `<base>`, also in the shadow root, their URLs are made absolute against the page's
folder, and with copying, each copies its file from its own base's folder; a `<body>` around the
`<base>` is made absolute, and one after a `<base>` in the `<head>` is not. Each attribute is read
only on the elements of its namespace: neither made absolute nor copied are a `background` on a
`<div>`, a `<span>`, or an SVG element, also an SVG `<td>`, `<tr>`, or `<col>`, which the parser
keeps in SVG, an `href` on an HTML `<script>` or `<use>`, or a `src` on an SVG `<script>` or
`<video>`. A page with a `<constructor>` element, in HTML, in SVG, in a shadow root, and in a
template, is prepared, also with copying, as its names are looked up in maps. Copied, their files pass the same checks: a note, a web address, a
path outside the vault, and an empty value stay as written, so does an `<feImage>`'s fragment, and
a file over the per-file limit is left out and counted. One that does not resolve as a path is
found by name. `resources.e2e.ts` checks in Obsidian 1.5.3 and the latest a page whose `<base>`
comes after a `<body>` background, nine tables with a background on an element of each kind, two
`<feImage>` elements, two SVG scripts, and a script that the served page delays, followed by a
cell's background and an `<feImage>`. The served page requests each file of those before the
`<base>` from the page's folder and the others from the `<base>`'s, and runs both SVG scripts of
the page's folder. With scripts off, the viewer's copy resolves those before it to the page's
folder and the others to the `<base>`'s, with eleven green images and two blue ones and the
`<body>`'s orange; with scripts on and files copied, it shows the same and runs both SVG scripts of
the page's folder.

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

**Unreleased (#177):** `document.test.ts` checks that the text limit counts a stylesheet's text as
preparing writes it, each to the character, with stylesheets in a folder whose long name makes a
short stylesheet's copy take the whole limit: one whose copy is exactly the limit is copied, and
one a character longer stays a link or an import. Its URLs count as made absolute, in a link, in an
import in the page's `<style>`, and in an import in a linked stylesheet, after what each importer
adds to its own import; so do its URLs found by name, its imports that stay imports as the copy
writes them, and the text that closes it at its end, also without URLs after a stylesheet that
leaves 100 characters. A rewrite that shortens its text gives nothing back. Rewriting stops once
the text passes the room: counting the context's `exists` calls, about 45 of 1,000 URLs are
rewritten in 100,000 characters. A repeat of the page's link of it counts its copy each time, so
two of three links of a stylesheet whose copy takes two fifths of the limit are copied. One that
stays a link takes nothing from the text limit, and what its rewriting reached from the discard
limit, so that a stylesheet after it of what remains of that, one character less than the whole
text limit, is copied, and one a character longer is not. Its repeats, by link or by import, are
refused without rewriting it again, while a stylesheet that imports it is prepared again for each
of its three links, the refusal having touched it each time; each link of it counts toward the
links and imports followed, so that a small stylesheet after the count's worth of them stays a
link. Other URLs of its file, with queries, are prepared within the discard limit: two, and then
nothing more. A stylesheet that fits in the text limit but is longer than what remains of the
discard limit is refused before it is scanned, under each of three URLs. A scan would find that it
does not fit and take its length from the discard limit, so the test counts scans by what remains
of that limit: a stylesheet of all of it is still copied after them. A page's own `<style>` keeps
its URLs as written, so that 10,000 URLs that would take 20 million characters made absolute take
nothing, and counts only what its imports that stay imports add: past the limit, it keeps its text
as CSS closes it, its imports as written and its references found by name changed. Two such
`<style>` elements spend the discard limit, after which a later `<style>`'s import stays an import.
A `<style>` with or without imports and a `style` attribute, whose references found by name
change, count nothing.
`inlineStylesheet` past the limit keeps its closed text, with references found by name changed. In
the fan-out stress test, each import counts as long as the copy writes a kept import.

`document.stress.ts` prepares #177's stylesheets of a million `a{b:url(c)}` and of a million
`@import"a";`, through a link, an import, and an import in a linked stylesheet, in a vault at an
ordinary path: what the copy adds stays within the text limit, each stylesheet stays a link or an
import, and rewriting stops at the room, which its `exists` count bounds. On `main` at `6acb438`,
each case added 78 or 82 million characters. It also prepares the pages that the review of #180
measured at 26 to 30 s: 1,000 links of a stylesheet whose 1,362 URLs pass the limit in a folder of
3,900 bytes of names, rewritten once, and the same with a query each, rewritten twice, each in
about 0.5 s, where the first fix rewrote over a million URLs; and 20 `<style>` elements each with an
import and those URLs, whose URLs are asked about once each and stay as written.
`resources.e2e.ts` checks in Obsidian 1.5.3 and the latest that a page's `<style>` with an import,
in the document, in a shadow root, and in a template's content that the page's script adds, keeps
its URL as written and shows its image from the page's folder, through the copy's `<base>`, with
scripts off, and with scripts on and files copied.

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

**Unreleased (#151):** `css.test.ts` reads an import's layer, its support conditions, and its media
query list, in that order: the `layer` keyword or `layer()` with identifiers joined by dots, written
with spaces, comments, and escapes too, also with comments beside a dot. It finds no block form for
a scope, for the layer names that Chromium 114 and 150 read as part of the media query list, such
as `layer(a .b)` and `layer()`, or for empty support conditions. `document.test.ts` checks that
imports into layers become `@layer` blocks, and imports with support conditions `@supports`
blocks, inside `@media` for their media conditions, with the conditions outside the layer, and
that an imported stylesheet's own imports nest inside. A stylesheet that declares no layer, such
as an empty one or one that holds only kept imports with media or support conditions of their own,
gets an `@layer` statement for its import's named layer, in the blocks of its other conditions,
which stops later imports as CSS does. Imports with support
conditions stay imports, reading nothing, where the window's `CSSImportRule` has no
`supportsText`, and scoped imports everywhere; a stylesheet with a `}` outside any block stays an
import with each condition. `resources.e2e.ts` checks in Obsidian 1.5.3 and the latest, with
scripts off and on, against what Chromium shows of the same page served outside Obsidian: layered
imports apply in their order; the imports of a missing file, of an empty one, and of ones that
hold only an import with `print` or, on 1.5.3, with support conditions, still declare their layers
where they are; a layer whose import's conditions do not hold comes where it is next
declared; a layer name with a comment beside its dot applies; an import with support conditions
applies on 1.15.1 and not on 1.5.3, as in each one's Chromium; one whose conditions do not hold
does not apply; and neither does a scoped import. The import into a layer with a comment before
`layer` now applies there, so the viewer shows each case of that page as Chromium does.

**Unreleased (#152):** `css.test.ts` checks which text keeps later imports from counting: none for
what CSS discards between rules, which it tells apart as blank, or for `@charset` and
`@supports-condition`; those after an import for `@layer` statements; all of them for any other
rule. It also finds the `<!--` and `-->` between top-level rules, and none in a rule.
`document.test.ts` checks that a kept import of Google Fonts, one into a layer, or one with
conditions that the viewer does not read, such as a scope, starts a stylesheet of its own after an
inlined stylesheet's rules, also from inside an inlined stylesheet and after an `@layer` statement
that follows an import or in a block, and that one right after it goes with it. An import of
anything else stays where it is, also from a look-alike of Google Fonts' origin, and spends none of
the limit on `<style>` elements; none starts a stylesheet after only what imports may follow, or
after a stylesheet with no rules imported with conditions, which takes no block. A stylesheet
imported with conditions adds them to its kept imports, nesting layers and joining support
conditions as written, also where the host never applies them, and leaves one in its blocks where
one import cannot have both. A `<style>` or a link puts each stylesheet in a `<style>` with its
`media` and `title`, a `<style>` with its `type` too, an SVG one for an SVG `<style>`, which keeps
the last, in every place a page has a stylesheet, copying files alike; a repeated link gets the same
stylesheets, read once. A stylesheet file's markers become spaces, also in a file that CSS closes at
its end, and the page's own stay. What the copy adds for conditions counts toward the text limit, as
what other stylesheets left of it: past it, a stylesheet goes in one block, and a stylesheet that
would have fit after that block is left out; with no room for one block, the import stays an import.
`document.stress.ts` prepares the review of #174's pages, which took the copy to 200 to 400 MB or
past V8's longest string: long media query lists and layer names around thousands of kept imports
and parts, and long `media` attributes on a `<style>` of thousands of kept imports after rules, and
long titles on such a `<style>` and on a link. What the copy adds stays within the text limit, and
what composition leaves out of a kept import is never given back: a stylesheet of 15 MB imported 999
times with `screen`, whose kept import composition shortens by its spaces or comments, is prepared
once. It also checks that the copy adds at most 1,000 `<style>` elements, and prepares 130,000 kept
imports through a link and an import within 10 s, in one `<style>`. `resources.e2e.ts` checks in
Obsidian 1.5.3 and the latest, with scripts off and on, that a layered web import after an inlined
stylesheet and one inside a stylesheet imported with `screen` have their `CSSImportRule`, the inner
one with `screen`, as Chromium has them for the same page. It also checks that an imported
stylesheet's rules between `<!--` and `-->` apply inside `@media`, and that a split SVG `<style>`
with an uppercase type applies on 1.15.1 and not on 1.5.3, as in each one's Chromium. A web
stylesheet that Obsidian's policy refuses stands in there for Google Fonts, which it allows, so that
the test needs no network: its layer makes its place matter.

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
viewer does.

**Unreleased (#194):** a `style` attribute is closed as a list of declarations, without a rule to
end. `css.test.ts` checks the text that closes a string, also after a `\`, a quoted or unquoted
`url(`, an escape, a comment, and the blocks and functions left open, innermost first, and that a
closer which matches no open block closes nothing. Closed, a string left open in `image-set()`, a
quoted `url(`, and an unquoted one name their files, and one in a comment does not.
`document.test.ts` checks that such references in `style` attributes before a later `<base>` are
made absolute against the page, those after it kept as written, and an attribute's other text kept
as the page has it, closers and all; that with copying, their files are copied from the folder of
each one's base, in the document and in a shadow root; and that they are found by name.
`resources.e2e.ts` checks in Obsidian 1.5.3 and the latest four squares whose `style` attributes
end inside `image-set("`, `url("`, `url(`, and `url('` before a late `<base>`, and one after it:
the served page and the viewer show the four from the page's folder and the last from the
`<base>`'s, and with scripts on and files copied, the viewer shows the same images.

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
one whose part before a `;`, trimmed of the whitespace that Chromium trims, is empty or `text/css`
in any case. Of 35 code points on both sides of `text/css`, it trims the 21 that headless Chrome 158
trims: U+0009 to U+000D, U+0020, U+1680, U+2000 to U+200A, U+2028, U+205F, and U+3000, and not
U+001C to U+001F, U+0085, U+00A0, U+180E, U+200B, U+200C, U+200E, U+2029, U+202F, U+2060, or
U+FEFF. `document.stress.ts` checks that a link's type with runs of 50,000 spaces is trimmed in
well under a second. The other elements stay exactly as written, and nothing is read or copied for
them; a page whose only stylesheets are such elements gets the reading style. `resources.e2e.ts`
builds a page with 23 types on a `<style>` and a link, disabled links, and four types on an SVG
`<style>`, in the document and in a shadow root. Its link types measure in Obsidian that U+000B,
U+1680, U+2003, U+2028, and U+3000 are trimmed, and U+00A0, U+180E, U+2029, and U+202F are not.
It serves the page over HTTP to a frame of Obsidian's window without a
sandbox and checks that what Chromium applies there matches #147's measurements. In the viewer, in
Obsidian 1.5.3 and the latest, with scripts off and with them on and files copied, the page shows
exactly what Chromium applied, the viewer reads only the stylesheets of the elements that apply,
keeps the others as written, and copies only the images of the `<style>` elements that apply.
Chromium 114, in Obsidian 1.5.3, applies an SVG `<style>` of type `TEXT/CSS` only in lowercase,
and Chromium 150, in 1.15.1, as an HTML one; the spec accepts either for that case, and the viewer
prepares it on both, so on 1.5.3 it reads that `<style>`'s import, which applies nothing there.

**Unreleased (#169):** `document.test.ts` checks, by the files that preparing reads, which
stylesheets the copy prepares by their titles, in each case that headless Chrome 158 measured: of
links, the first title's set, a repeat of it, untitled links, and an `alternate stylesheet` link of
that title, and no other titled link, no other alternate one, no untitled alternate one, and none
titled with a space. A titled `<style>` names the set as a link does, also an SVG one, and a link
names it before it loads, also when its file is missing; a disabled link, a link of another type or
with an `href` that is empty, blank, or no URL, an alternate link, and a `<style>` of another type
name none. A `<meta http-equiv="Default-Style">`, in any case and also in the `<body>`, names the
set before any title, but not after one; an empty one names none, and the first one counts. Titles
match only in the same case and with the same spaces. In a shadow root and a template, every
stylesheet but an alternate link is prepared, and their titles and `<meta>` name no set. With
copying, a `<style>` of another set keeps its text, and its files are not copied, and links of other
sets stay as written; a page whose only stylesheets are outside the set gets the reading style.
`resources.e2e.ts` checks in Obsidian 1.5.3 and the latest, against what Chromium applies to the
same pages served outside Obsidian, a page whose first title is that of a link to a missing file,
with links of both sets, untitled, alternate, and titled with a space, `<style>` elements and SVG
`<style>` elements of both sets and of a title in other case, a `<meta>` at the end, and a shadow
root with a link and a `<style>` of the other set and an alternate link; a page whose `<meta>` names
the second set; and a page whose first titled link's `href` is no URL, which names no set there. In
the viewer, with scripts off, the page shows what Chromium applied, the viewer reads only the
stylesheets that apply, and the copy keeps the others as written; with scripts on and files copied,
it copies only the figure of each `<style>` that applies.

**Unreleased (#192):** `document.test.ts` checks that a link is read only when ASCII whitespace
separates `stylesheet` from its other link types: with each of the 20 other spaces that
JavaScript's `\s` matches, U+000B, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F,
U+205F, U+3000, and U+FEFF, after it, before it, or at the start, the link stays a link and nothing
is read; with a space, a tab, a line feed, a form feed, or a carriage return, literal, which the
parser reads as a line feed, or as `&#13;`, and in any ASCII case, it is read. Such a link names no
stylesheet set, and an `alternate` one so joined applies nothing. With copying, an image whose
`src` holds U+00A0 and a name between ASCII spaces, a `srcset` with U+00A0 inside a URL, a `srcset`
whose URLs a form feed and a tab end, and a script whose `src` starts with U+2003 copy the files of
those names; found by name, such a reference stays as written when only the name without the space
would match. `resources.e2e.ts` checks in Obsidian 1.5.3 and the latest a page of 25 links, each to
a stylesheet of its own, with `stylesheet` and `x` joined by each of those 20 spaces or by a space,
a line feed, a tab, a form feed, or `&#13;`, and two images whose files are named with U+00A0,
written into the vault by their exact names. The served page applies only the links of ASCII
whitespace, all five on Chromium 150 and those of a space and a line feed on Chromium 114, and shows
the images of the names with U+00A0. In the viewer, the copy applies and reads the five links of
ASCII whitespace, and with scripts on and files copied, it shows those images, not the files of the
names without U+00A0.

**Unreleased (#148):** `document.test.ts` parses the copy of a page with scripts on as a frame that
runs scripts does, in a jsdom window that runs them. The content of a `<noscript>`, in the head, in
a paragraph, in a table, in a shadow root, and left open by the end of the file, is the source's
text, nothing is read or copied for it, nothing moves out of one in the head, and a title in it names
no stylesheet set. Without scripts it is prepared as elements. In SVG, a `<noscript>` is prepared as
the element that it is, and the text `<noscript>` in comments, raw text, and attributes is no
element; after CDATA text that seems to hold one, a `<noscript>` is prepared as elements. The copy
keeps the empty line that starts a `<pre>`, a `<textarea>`, or a `<listing>`, with scripts off and
on. `rendered.test.ts` checks that the view asks for either by whether scripts are on.
`resources.e2e.ts` checks in Obsidian 1.5.3 and the latest that a page with a `<noscript>` in its
head and in its body shows with scripts on what the same page shows when served outside Obsidian,
from its first stylesheet's title to its images, and reads and copies only what it shows; that it
shows them with scripts off; and that a `<pre>` keeps its empty line.

**Unreleased (#199):** `document.test.ts` checks that a link's tooltip names the file that its
`href` resolves to with only ASCII whitespace stripped from its ends: with a no-break space before
its name, the file of the name with it, also where only the name without it would be found by
name, and with line feeds, spaces, tabs, and form feeds, the file of the name without them.
`links.test.ts` checks that a click opens the same file and hands Obsidian's link resolution the
same reference. `links.e2e.ts` checks in Obsidian 1.5.3 and the latest a page with such links, a
file whose name starts with U+00A0, written into the vault by its exact name, and a decoy without
it: each tooltip names the vault path of the URL that Chromium resolves its link to, and a click
opens the file with U+00A0.

## Shown to fail

Each of these deliberate breakages fails the check named. Host tests fail in Obsidian 1.5.3 and 1.15.1,
the versions they ran on, unless one is named. Each change's pull request holds the measurements of
its breakages and of the behavior before it.

### Sandbox, policy, and release

- Granting scripts together with same-origin access: `rendered.test.ts`.
- Giving the frame its sandbox only after inserting it: `rendered.test.ts`, and
  `resources.e2e.ts` (#83).
- Reading any vault file as a stylesheet, accepting `..` in a vault path, or allowing `<object>`
  content in the page's policy: `document.test.ts`.
- Leaving out the copy's `<base>`: `document.test.ts`, and `resources.e2e.ts`, among them the test
  of `<style>` URLs kept as written with scripts off. With scripts on and files copied, preparing
  resolves the URLs itself, so that test passes.
- Copying the text tracks of a page with scripts off: `rendered.test.ts`'s test of text tracks
  (#196).
- Lifting the copy limit for a file: `settings.test.ts`.
- A `fetch` call in the plugin's code, even one that never runs: `policy.test.ts`.
- Showing the file as it is when preparing its copy fails, or failing on CSS escapes and on
  stylesheets that cannot be read: `document.test.ts`, `rendered.test.ts`, and `resources.e2e.ts`.
- A wrong default in the README, a label missing from `.github/labels.json`, a renamed required CI
  job, a changelog without the manifest's version, a link to a missing heading, an unregistered
  end-to-end spec, and a skipped test: `consistency.test.ts`.
- Missing prototype results in a full end-to-end run: `corpus/compare.mjs`.
- Publishing a commit whose CI has not passed, moving a tag, changing a published release,
  publishing a draft whose upload arrived damaged, and a wrong latest-release mark:
  `release.test.ts`.

### Files, refresh, and the plugin's lifecycle

- Leaving out the view's `save` override: `refresh.test.ts`, and `read-only.e2e.ts`, where leaving
  a tab after a refresh writes the refreshed contents to the file (#90).
- Leaving out the refresh's check that it is the latest and its file is still shown:
  `refresh.test.ts`; with the `save` override left out too, `read-only.e2e.ts`, where one file is
  overwritten with another's contents (#90).
- The view as 0.5.2 has it, where Obsidian's reload of a changed file that finishes after another
  file opened in the tab shows the first file's contents under the second file's name:
  `refresh.test.ts`, whose stand-in reloads a changed file as Obsidian does, and `read-only.e2e.ts`
  (#115).
- Leaving out the view's own read of its file: both of `read-only.e2e.ts`'s tests of Obsidian's
  reload (#115).
- Keeping the viewer's extensions registered after the plugin unloads, or ignoring the saved
  settings when it loads: `lifecycle.e2e.ts` on 1.5.3 (#98).

### Find in the page

- Leaving out a canvas's fallback text, or finding the children of a progress bar: `find.e2e.ts`.
- Closing the find bar without its pending search: the three close tests in `find.test.ts`.
- Not telling the find bar that Obsidian unloads the file, keeping its matches when the view shows
  something else, or leaving it open when the file cannot be read: `find.test.ts`'s tests of a slow
  next file, of a refresh that finds the file empty, and of a failed read.
- Matching text at zero opacity, leaving out text inside `display: contents`, and a fixture word
  meant to be hidden but painted: `find.e2e.ts`'s paint test (#160).
- Decoding a PNG row's average or sub filter wrongly: `pixels.test.ts`.

### Links and shadow roots

- Finding a clicked link from the event's target, where a shadow root hides it: `links.test.ts`,
  `document.test.ts`, and `links.e2e.ts`. Finding it along the event's path, but leaving the copy's
  shadow roots closed and the frame's other navigations uncanceled: `links.e2e.ts`.
- After a tab moves to another tab group or window, each of these fails `links.e2e.ts`:
  - Watching a frame's new document only when it loads, without making the copy inert: a link
    clicked before the page loads again navigates the frame away, and a copy of the frame that the
    view does not watch follows its links.
  - Making the copy inert, but watching the new document only when it loads: the moved page cannot
    follow its links before it loads.
  - Watching the new document at once, without making the copy inert: the unwatched copy follows
    its links.
  - Leaving out the cancellation of the frame's other navigations: a click on a link in an
    undeclared closed shadow root, or on one copied by SVG `<use>`, starts a navigation that
    nothing cancels.
- Collecting a page's templates by passing them all to one call: `document.stress.ts`, on a page
  with more of them than a call can take.
- Leaving the content of a page's templates, and so of its declared shadow roots, as written: the
  shadow DOM and SVG link tests in `document.test.ts`, and those in `resources.e2e.ts` and
  `links.e2e.ts` (#124).
- Giving every SVG link without text a tooltip, or one to an SVG link around HTML in a
  `<foreignObject>`: the tooltip test in `document.test.ts`, and `links.e2e.ts` (#117).
- In the split view's pairing, leaving out shadow roots, leaving out the body's own shadow root,
  taking every shadow root to come before its host's own content, or taking any comment with its
  mark's text, or the mark of a declaration that stayed a template, for the mark: `split.test.ts`
  (and `document.test.ts` for the marks), and `split.e2e.ts` (#124).

**Unreleased (#199):** Reading a click's `href` as written and trimming a tooltip's with `trim`,
or trimming both with `trim`: the tests of U+00A0 in `document.test.ts` and `links.test.ts`. The
first also fails the test of U+00A0 in `links.e2e.ts`.

### A page's place across a tab's move

- The view as 0.5.2 has it: `move.e2e.ts`, where after a move the page is back at its top, a theme
  changed in place is undone, and the split view's sides are apart (#126).
- Keeping the page's place as the height it was scrolled to: only the move to a narrower tab group.
- Keeping the split view's following of the document that the frame dropped: only the split view's
  test, which counts its measurements of that document.
- Placing the page again when it has loaded, after the reader scrolled it or the split view's
  source: both tests of the reader's scrolling.
- Treating only a part without a box as closed: both tests of a part closed again, and
  `move.test.ts`'s tests of those parts and of a page inside `display: contents`.

**Unreleased (#157):** The view as 0.6.0 has it fails five of `move.e2e.ts`'s tests of the
reader's scrolling of the split view's source during a move. Each of these fails a unit test:

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

**Unreleased (#162, #167):** In `move.e2e.ts`, a build without each part of the fix fails only that
part's tests: not finding the find matches again after a move, the two tests of the matches; the
find bar not telling the kept place of its scroll, the four tests of its scroll to the source's
start with a layout change or resize in the same task; and modifier keys counting as the reader's
input, the modifier key's test on 1.5.3, where Obsidian does not put a moved source back itself.
Each of these fails a unit test:

- Not finding the matches again after a move, or only when their ranges collapsed, or only in
  another window; and finding them again in the rendered view. `find.test.ts`.
- The find bar not telling the kept place of its scroll; and the kept place taking that scroll of a
  source that is not laid out. `source.test.ts`.
- Modifier keys counting as the reader's input: in the source's guard, `source.test.ts`; in placing
  the page again when it loads and in the watch of the reader, `move.test.ts`.

**Unreleased (#165, #175):** The view before these changes fails both of `move.e2e.ts`'s tests of
the find bar's delay, and on 1.5.3 both tests of the split view in a new window whose app.css
arrives after the view has followed the page. They pass on 1.15.1, whose source lines
have their height without app.css. Each of these fails a unit test:

- Clearing the find bar's timer through the view's window, setting it through the window that the
  bar was made in, and not cancelling it at the next key: `find.test.ts`.
- In the split view: not putting the sides in step again, or doing so after every move or without
  recording the window; doing so without measuring the source or the page again, or without a side
  leading again; not keeping the line of a source that led last, keeping it also after Chromium
  scrolled the source or whatever led last, or not having the page follow it; a lead that waits
  taken for none; the observer's signal that never aborts; and a time limit of 0 ms or an hour.
  `split.test.ts`.
- In the follower: the page leading again whatever led last; leading again while a side waits to
  lead; and the last leader recorded only when the other side moved, or had a target.
  `split.test.ts`.
- Watching the first resize with an observer of the plugin's window, without a time limit, after
  the signal or the first change, from the first report whatever its size, or by the height only;
  and not measuring again when asked. `split.test.ts`.

**Unreleased (#178):** The view before this change fails 11 of `move.e2e.ts`'s 14 tests of a tab
that Obsidian shows again after hiding it; the reader's scroll to the page's top, the **Source**
view, and a page that scrolls inside a column pass, since Chromium keeps their places. Each of these
fails the `move.e2e.ts` test named:

- Not putting the source back: the wrapped lines where the source led.
- Following the hidden page's scroll, or having the page lead once the sides are back: the long
  head.
- The find bar not telling the page's kept place: its scroll in the task that hid the tab.
- Putting the page back at every resize of its frame, not only when the frame shows again: a test
  of #157 on 1.15.1.
- Leaving the source's hold on at `back`: the reader's scroll between two switches. At `release`:
  the hidden tab moved to a new window.
- Keeping the scroll reported while held: the wrapped lines where the source led, shown by a click
  on the tab header.

Each of these fails a unit test, in `move.test.ts` or `split.test.ts`:

- In the kept place: taking reports while held; not going back, or only from the start; going
  back where the reader's input can be unreported; keeping the old place when released; leaving
  the hold on at `back` or at `release`; and the page not going back.
- In the watch of the frame: a frame without a size when watched taken for shown; every report
  taken for a change; an observer of the plugin's window; not disconnecting it; and a signal that
  never aborts.
- In the split view: following the source's or the hidden page's scroll while the tab is hidden;
  not holding the source, or not putting it back; not measuring the sides again; leading with
  either side's report of its going back; not leading again, or with the page whatever led last;
  not following the reader's scroll of the source as the tab shows, or not releasing the source
  there; and leaving the hold on when the frame drops its document.
- The find bar not telling the page's kept place.

**Unreleased (#182, #186):** Each of these fails the `move.e2e.ts` tests named:

- Going back as far down as it was, whatever it showed: the three tests of a narrowed view.
- The split view's source without its line: the narrowed split view where the source led.
- Measuring nothing once the scrolling settles: the tests of a view narrowed while hidden, of the
  narrowed split view, and of a hidden tab's move to a new window with its tab header's menu.
- Giving the frame's next document the hidden page's own place: the two tests of a hidden tab's
  move by its menu.
- No starting place for the next document: the four tests of **Split down** in the tab in front of
  a hidden tab.
- No observer of the page's root and body: the Readable line length and narrowing tests.
- The sideways place lost: the page scrolled 300 px sideways.
- Using a measurement after a scroll that it predates: the hide two frames after a scroll, and
  three tests of #178, among them the find bar's scroll in the task that hid the tab.

Measuring after one quiet frame, in place of 100 ms, passes every host test; only `move.test.ts`
tests it. Taking the place of a page at its top for one that cannot tell changes nothing, since both
go back to the page's top. Each of these fails a unit test, in `move.test.ts` or `split.test.ts`:

- In the kept place: going back as far down as it was whatever it showed; using a measurement
  after a scroll that it predates, or after a change of layout; no exact return within a pixel, or
  no rounding; the sideways place lost; measuring while not laid out; a measurement that does not
  end its being out of date; measuring in the frame of the report, after one quiet frame, by quiet
  counted from the report's frame, or in one window's frames whatever window the source is in; and
  measuring nothing at a report, after `placed`, or after `release`.
- In the page's kept place: no starting place, or one not passed by the view; a layout change
  counted while hidden, or not measured again; no observer of the page, one of its root only, or
  one never disconnected; and `placeNextDocument` returning no place, or a place where the page
  follows the source.
- In the split view's source's line: none kept; the share into the line not counted, or the line
  before the top; and the top padding as a share of the first line.
- In the view: the hidden page's own place at `pagehide`, or the kept place also for a page that
  shows; and the frame's hiding not recorded, or never ended.

**Unreleased (#189, #195):** Each of these fails the `move.e2e.ts` tests named:

- The **Source** view without its line: its five tests of a tab group, a new window, a narrowed
  view, and a hidden tab's move.
- No watch of the **Source** view's own size: the narrowed view, and on 1.15.1 the
  hidden tab's move.
- No going back to the line at a scroll that leaves the source where it was last reported: both
  tab groups; and not at its end short of that: the wider one.
- No watch of its lines in a new window: the held-back app.css, on 1.5.3.
- The split view's page leading after every move: the four tests of #195.
- The split view's source not going back to its line when the next document shows: the wrapping
  rules in a narrower tab group, and on 1.5.3 both tests of #165.
- The hold until the next document not ended by the reader's input: four tests of #157 on 1.5.3,
  and three on 1.15.1.

These fail no host test, and each fails a unit test in `move.test.ts`, `split.test.ts`,
`source.test.ts`, or `find.test.ts`: no hold of the source while the frame shows no page; no going
back to the line where Chromium leaves the source at its end at #165's resize; measuring the
source's line only once its scrolling settles, which a host test of #165 shows only where the tab
moves within 100 ms of the scroll; and the line place, or the watch of the **Source** view, taking
a source with no width for one that can tell.

### Stylesheets and resources

- Reading URLs and imports inside CSS strings and comments with regular expressions, as before #91:
  `document.test.ts`, also for a shadow root's `<style>` elements and linked stylesheets (#124).
- Counting a string that a newline ends as a string, reading U+0010 to U+0019 as hex digits, taking
  a malformed quoted `url(` as a URL, or counting braces without the parentheses and brackets around
  them: `css.test.ts` and `document.test.ts`.
- Reading U+0000 in a linked stylesheet as anything but an identifier character, and processing
  linked stylesheets again as the page's own styles: `document.test.ts`.
- Leaving out of the second pass the `<style>` elements that links become only in the document,
  not in a shadow root: `document.test.ts`, where a 20-deep import chain linked from a shadow root
  reads 16 files rather than 8.
- Removing a string's line continuations before decoding its escapes: `css.test.ts` and
  `document.test.ts`.
- Trimming the end of an import's media list, which removes the newline that ends a bad string
  there, or trimming JavaScript's whitespace at its start, which removes a U+FEFF that starts a
  name there: `document.test.ts`.
- Assigning every `<style>` element's text, even unchanged, which removes an SVG `<style>`
  element's children: `document.test.ts`.
- Finding imports anywhere outside blocks, or at the start of any top-level rule, allowing
  `@layer` statements after an import, or reading `<!--` and `-->` as other text: `css.test.ts` and
  `document.test.ts`. The preparation before #136 also fails both tests of imports in
  `resources.e2e.ts`.
- Classifying an import's conditions with a regular expression, which reads an import into a layer
  with a comment before `layer` as `@media /**/ layer`: `document.test.ts` (#144).
- Inlining an imported stylesheet without closing it, closing it after resolving its own URLs, or
  putting a stylesheet with a `}` outside any block in `@media`, or checking only its own text and
  not that of the stylesheets it imports: `document.test.ts` (#139).
- Processing a MathML `<style>`, reading an SVG `<style>`'s `textContent`, assigning a rewritten
  `<style>`'s `textContent`, turning a `<link>` inside SVG or MathML into a `<style>`, or counting
  any `<style>` as the page's own styles: `document.test.ts`'s reads and copies, rewriting, links,
  and reading style tests (#143). The preparation before #143 also fails both tests of `<style>`
  text in `resources.e2e.ts`.

**Unreleased (#147):** Each of these fails the check named in `document.test.ts`; the preparation
before #147 also fails both viewer tests of types in `resources.e2e.ts`:

- Preparing every `<style>`, whatever its type: the `<style>` test, the SVG `<style>` test, and the
  reading style test of #147.
- Comparing an SVG `<style>`'s type case-sensitively: the SVG `<style>` test.
- Leaving out a link's `disabled` attribute, or its type: the link test and the reading style test
  of #147.
- Trimming nothing from a link type's essence, or JavaScript's whitespace, which includes U+00A0:
  the link test. Trimming only ASCII whitespace and U+2003: the test of the whitespace that
  Chromium trims.
- Trimming with a regular expression that tries each run of whitespace from each of its positions:
  `document.stress.ts`'s test of long types, against its bound of 1 s.
- Counting any `<style>` or stylesheet link as the page's own styles: the reading style tests of
  #143 and #147.

**Unreleased (#151):** Each of these fails the check named, in `resources.e2e.ts` unless only a
unit test is named:

- Keeping imports into layers as imports: the viewer tests, and the block form tests in
  `document.test.ts`.
- Putting the layer outside the conditions: the viewer tests, and `document.test.ts`.
- Putting imports with support conditions in `@supports` blocks on every host: the viewer tests on
  1.5.3, and `document.test.ts`. Keeping them as imports on every host: `document.test.ts`.
- Reading any text in `layer()` as a name, or one that starts with a number, keeping no scoped
  import, or putting empty support conditions in a block: `css.test.ts` and `document.test.ts`.

**Unreleased (#152):** Each of these fails the check named, also the viewer tests in
`resources.e2e.ts` where they are named:

- Keeping a kept import in the stylesheet before it: the viewer tests, and five tests in
  `document.test.ts`.
- Adding no conditions to the kept imports of a stylesheet imported with them: the viewer tests,
  and `document.test.ts`. Adding them through an anonymous layer around the kept imports:
  `document.test.ts`.
- Leaving a stylesheet file's `<!--` and `-->` markers as they are: the viewer tests, and
  `document.test.ts`.
- Letting an `@layer` statement after an import leave later imports counting: `css.test.ts` and
  `document.test.ts`.
- Taking no block, or no text, from the text limit for what conditions add, or not stopping once it
  passes it: the text limit tests in `document.test.ts` or `document.stress.ts`. No single block when
  what conditions add would pass the limit: `document.test.ts`.
- No limit on the `<style>` elements, or none on their copied attributes, not charging a link's
  copied attributes or a `<style>`'s `title`, or giving the text limit back what composition leaves
  out: `document.stress.ts`.
- A stylesheet of its own for every kept import: two tests of #154 in `document.test.ts`, and the
  tests of kept imports. None for Google Fonts: those tests, and `document.stress.ts`.
- A block around blank text: four tests in `document.test.ts`.
- Keeping the stylesheet that a kept import split stopped: `document.test.ts`.
- No `@layer` statement for a stylesheet that declares none, or one for an anonymous layer too:
  `document.test.ts`, and for the first, the viewer tests.
- Taking any kept import for a declaration of the layer: `document.test.ts`, and the viewer tests,
  for the `print` import, and on 1.5.3 for the `supports()` import.
- Not copying a `<style>`'s `type`: `document.test.ts`, and the viewer tests on 1.5.3. Copying a
  link's `type`, whose parameters keep a `<style>` from applying: the tests of link types and kept
  imports in `document.test.ts`.
- Reading no comment beside a dot in a layer name: `css.test.ts`, and the viewer tests.
- Room for conditions as the whole limit, not what other stylesheets left; asking for another
  `<style>` element before whether the import's place matters; reading Google Fonts by a prefix of
  the URL, which a look-alike origin passes; keeping an import with conditions that the viewer does
  not read where it is; and an `@layer` statement that stops no later import, stops them only after
  an import inside its blocks, or stands outside its `@supports` block: `document.test.ts`.

**Unreleased (#154):** Each of these fails the check named:

- No limit on how many links and imports a page follows: `document.stress.ts`'s test of small
  stylesheets, within a second, and four tests in `document.test.ts`.
- No limit on the stylesheets' text: the stress test of 20 KB stylesheets, and three tests in
  `document.test.ts`.
- Counting only the links and imports whose stylesheet the copy takes in: the counting test in
  `document.test.ts`.
- No reuse of a page's repeated links and imports, reuse of links only or of imports only, or a
  repeat that takes one from the count: the components test in `document.test.ts`, and the stress
  test of 4,000 components.
- Keeping no result for a stylesheet that cannot be read: the test of repeats of such a stylesheet.
- A repeat that loses the stray `}` of its stylesheet, or one checked against the text limit but
  not added to it: the test of each.
- Reusing a stylesheet that the count, or the text limit, cut short: the test of preparing it again
  after each. Reusing stylesheets at every depth: the counting test, the test of preparing again
  after the text limit, and both fan-out stress tests.

**Unreleased (#155):** Each of these fails the check named in `document.test.ts`:

- Not closing a linked stylesheet: the tests of a last import, of the URL at its end, of one text
  for a link and an import, and of a linked stylesheet's stray `}`.
- Not closing a `<style>`: the tests of a last import, of the URL at its end copied and located, of
  the closed text, and the #143 test of an SVG `<style>`'s child elements.
- Keeping a link and an import of the same stylesheet apart: the test that counts them once.
- Dropping a stylesheet's own stray `}` from its prepared result: the stray `}` tests of #139,
  #154, and #155.

**Unreleased (#169):** Each of these fails the check named in `document.test.ts`; the preparation
before #169 also fails both viewer tests of stylesheet sets in `resources.e2e.ts`:

- A `<meta http-equiv="Default-Style">` that names no set, or no alternate link that applies: the
  tests of sets and of the reading style.
- An alternate link, one with a blank `href`, any link with a title, or a link whose `href` is no
  URL naming the set; titles compared in any case; an `http-equiv` compared in its exact case; and
  a `<meta>` counted only in the `<head>`: the test of sets.
- Titles that never matter: all four tests of sets.
- Titles that matter in the content of templates: the test of shadow roots and templates.
- Copying the files of every `<style>`, whatever its set: the test of what the copy keeps.
- A page's own styles counted whatever their set: the test of the reading style.

**Unreleased (#177):** Each of these fails the check named:

- Not counting what making URLs absolute adds: `document.stress.ts`, and six of the text limit
  tests in `document.test.ts`.
- Not counting an import as long as the copy writes a kept import: both stress tests of the limit's
  text, and three of the text limit tests.
- Not counting the text that closes a stylesheet: both tests of that text. Leaving out that check
  and the room check of `StylesheetBudget.add` together, or a `StylesheetBudget.add` that takes what
  it is given: #152's stress test of conditions, #154's repeat test, and the repeat test of #177.
- Not counting what copying a page's `<style>` imports adds to its URLs and imports, or counting its
  own text too: the test of each place, and the test of a page's `<style>`.
- Giving back the text of a stylesheet that stays a link: the test of that stylesheet.
- A repeat that counts nothing: the repeat tests of #177 and #154.
- Not remembering by URL a stylesheet whose rewritten text did not fit: the work stress test, and
  the test of repeats and importers.
- Not counting what such a stylesheet's rewriting reached against the discard limit: the work
  stress test, and both tests of the discard limit. Counting the stylesheet's text against the text
  limit instead: both tests of the discard limit.
- Not counting such a refusal as a refusal, or a repeat of a remembered refusal: the test of repeats
  and importers. Not counting such a repeat toward the count: the test of the count.
- Comparing the rewritten text with the room only at its end: the #177 stress test, and the test of
  rewriting that stops at the room. Comparing a stylesheet's length with the text limit's room, not
  `rewriteRoom`, before scanning it: the test of a stylesheet too long for what remains of the
  discard limit.
- Giving room back for a rewrite that shortens its text: the test of such rewrites.
- Making a page's `<style>`'s URLs absolute: six tests in `document.test.ts`, among them those of
  #139, #143, and #147, and the work stress test.
- Returning a stylesheet given alone past the limit unlocated, or a page's `<style>` past it as
  written: the test of each, and three more of locating by name.
- Taking nothing from the discard limit for a page's `<style>` whose imports would not fit: the test
  of two such `<style>` elements.

**Unreleased (#179):** Each of these fails the check named in `document.test.ts` unless another is
named; the preparation before #179 also fails both viewer tests of `image-set()` strings in
`resources.e2e.ts`:

- Rewriting only the URL tokens of a copied stylesheet: the tests of strings made absolute, of
  every place, and of the text limit.
- Not counting what making such strings absolute adds: the test of the text limit.
- Copying only the files of URL tokens: the tests of every place, and of the page's own `<style>`
  and `style` attributes. Finding only URL tokens by name: the latter.
- Taking a string anywhere inside `image-set()`, as in its `type()`, or a string in any function:
  `css.test.ts`, the test of other strings, and those of strings made absolute and of every place.
- Taking the strings of any block after the name `image-set`, as in `image-set{content:"a.png"}`:
  `css.test.ts`.

**Unreleased (#185):** Each of these fails the check named in `document.test.ts` unless another is
named; the preparation before #185 also fails the three viewer tests of a late `<base>` in
`resources.e2e.ts`:

- Taking an SVG `<base>`, or one of a `data:` or `javascript:` URL, or letting a later `<base>`
  apply after an ignored `data:` one: the test of the base that applies.
- One base for every stylesheet: all six tests of a `<base>` after the page's stylesheets.
- Never taking a shadow root's stylesheets for ones before the `<base>`, or taking any template's
  content for them: the test of every place.
- Resolving a link against the copy's `<base>`: the tests of every place and of copying.
- Copying the files of a `<style>` or a `style` attribute against the copy's `<base>`: the test of
  the text limit. Finding the references of one that does not fit by name against it: the test of
  finding by name past the limit.
- Never making a `style` attribute's URLs absolute: the tests of every place, of the `<html>`
  element, and of the text limit.
- Not counting what making a `style` attribute's URLs absolute adds: the test of the text limit,
  and `document.stress.ts`.
- Giving room back for a rewrite that shortens a `style` attribute, or rewriting the whole of one
  before comparing it with the room: the test of shortening and of the room.
- Keeping the URLs of a `<style>` without imports as written: four of the tests.

**Unreleased (#187, #198, #200):** Each of these fails the check named in `document.test.ts`; the
preparations before #187 and #198 also fail their viewer tests in `resources.e2e.ts`:

- Resolving every resource attribute against the copy's `<base>`: all five tests of resource
  attributes before a later `<base>`.
- Taking no shadow root's elements for ones before the `<base>`: the tests of every kind and of
  copying.
- Leaving a `srcset`'s URLs as written: the tests of every kind, of copying, and of finding by name.
- Making a fragment absolute, or a reference that the page and the `<base>` resolve alike: the test
  of what stays as written.
- Leaving `<embed>`, `<object>`, and SVG `<image>` to the copy's `<base>`: the tests of every kind
  and of copying.
- Leaving the backgrounds, `<feImage>`, or SVG scripts out of the attributes made absolute and found
  by name: the #187 tests of every kind and of copying, and the test of finding by name; for the
  backgrounds, the test of the `<body>` too. Leaving them out of the copied attributes: the #187
  test of copying and the test of the checks.
- Leaving `<col>` and `<colgroup>` out of the backgrounds: the #187 tests of every kind and of
  copying.
- Copying an SVG `<use>`'s file: the #187 test of copying and the test of namespaces.
- Reading an attribute on the elements of every namespace, or `background` attributes in SVG too:
  the test of namespaces.
- Looking up a copied type among an object's inherited properties, or an element's attribute names
  in an object, which makes a page with an extension such as `constructor`, or a `<constructor>`
  element, fail to prepare: the tests of each.

**Unreleased (#192):** Each of these fails the check named in `document.test.ts`; the preparation
before #192 also fails both viewer tests of ASCII whitespace in `resources.e2e.ts`:

- Splitting `rel` on JavaScript's whitespace: the tests of links and of stylesheet sets.
- Splitting a `srcset`, or stripping a URL attribute, on JavaScript's whitespace: the tests of
  copying and of finding by name.
- Splitting a `srcset` on ASCII whitespace without the form feed, or without the tab, or `rel`
  without the carriage return: the test of copying, and the test of links.

Lowercasing `rel` with `toLowerCase` instead of in ASCII passes every test: no character but an
ASCII capital lowercases into a letter of `stylesheet` or `alternate`, so that part only keeps the
rule exact.

**Unreleased (#194):** Each of these fails the check named; the preparation before #194 also fails
both viewer tests of `style` attributes left open in `resources.e2e.ts`:

- Reading an attribute as written to make its references absolute, to find them by name, or to copy
  their files: the test of each in `document.test.ts`.
- Keeping an attribute's closed text: the test of making references absolute, which keeps the rest
  as written.
- Closing only the token left open, without the blocks: every test of #194 in `css.test.ts` and
  `document.test.ts`.
- Closing an attribute as a stylesheet, with a rule's `{}`: the test of closers in `css.test.ts`.

**Unreleased (#148):** Each of these fails the check named; the preparation before #148 also fails
the viewer tests of `<noscript>` in `resources.e2e.ts`, with scripts off by the empty line and with
them on by that and the `<noscript>` content:

- Preparing the content of a `<noscript>` with scripts on, or a view that does not say that scripts
  are on: the tests of `<noscript>` in `document.test.ts`, or `rendered.test.ts`.
- Putting the content back by a string whose `$&` is replaced: the test of the source's text.
- Taking the content out wherever the source seems to have a `<noscript>`, without looking where the
  comment went: the tests of SVG and of CDATA.
- Parsing again with every content as written, not only the misplaced ones: the test of SVG.
- Keeping no line feed, or one in SVG too: the test of empty lines.

### The test harness

- Not refusing a finished test's late WebDriver requests: `harness.e2e.ts`. Running tests outside
  their scopes: every request in it (#170).
- With the refusal, a `move.e2e.ts` or `find.e2e.ts` test, or the paint test, cut short by its
  timeout fails alone, and its failure names the requests that its code still sent. Ending the
  test's code later than where WebdriverIO's `afterTest` hooks start lets a cut test act during the
  failure screenshot.

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
  their `type` and a link's `disabled` attribute. A link's `rel` values other than `stylesheet`
  and `alternate stylesheet`, its `media`, and a `type` that a script changes are not measured in
  Obsidian. **Unreleased (#169):** titles and `alternate stylesheet` links are measured there,
  as the coverage of #169 describes. **Unreleased (#192):** so is what splits a link's `rel`:
  Chromium 150, in Obsidian 1.15.1, splits it on ASCII whitespace, as the viewer does, but Chromium
  114, in Obsidian 1.5.3, only on spaces and line feeds. There, a link whose `rel` has a tab, a
  form feed, or a carriage return before or after `stylesheet` loads nothing, but the viewer reads
  it, and the copy applies it as a `<style>`. The parser keeps a carriage return only from a
  character reference, `&#13;`, and reads a literal one as a line feed. The review of #197 measured
  the carriage return on both hosts. The versions between them are not tested.
- **Unreleased (#169):** which titled stylesheets apply is decided from the page as it is parsed. A
  script that switches to another set, as by enabling a stylesheet, gets no linked stylesheet of it,
  as Obsidian's policy refuses a link, and its `<style>` elements without their imports, whose URLs
  resolve as written. A titled stylesheet in a template's content is prepared, though a script that
  puts it in the page itself would have its title decide whether it applies, and a `<meta>` or a
  title that a script adds names no set here. A titled stylesheet inside `<noscript>` names the
  set with scripts off, as in a browser that runs none.
- **Unreleased (#148):** the frame parses the copy, not the tree that preparing made, and HTML
  cannot write every tree so that it parses as the same one. An `<mglyph>` in a table in MathML's
  `<mtext>` is moved out of the table as an HTML element, and parsed as a MathML one in the copy,
  where a `<style>` inside it holds markup that preparing took for text. That was measured on both
  hosts, as was that with scripts off neither follows a refresh that only the frame's parse creates,
  in a sandboxed frame without the view's listeners too; no other element that only that parse
  creates was. The copy is not parsed again to compare the trees, which would double the parsing of
  every page for markup that no known page has. With scripts on, a `<noscript>` that the source does
  not show as one, as inside an SVG `<title>` or after CDATA text that seems to hold one, is prepared
  as elements, as before #148. One after a formatting element that its paragraph left open, as in
  `<p><b>one</p><noscript>x</noscript><p>two`, stands inside another `<b>` in the copy, with what
  follows it, as it does in a browser that runs no scripts; and a carriage return from `&#13;` before
  a `<pre>`'s text reads as a line feed there. The review of #209 saw both in Chrome 158
  ([#148](https://github.com/viell-dev/slop-html-page-viewer/issues/148)).
- **Unreleased (#185):** which base a stylesheet resolves against follows where it stands in the
  prepared tree, which is taken for the order in which the HTML parser made its elements. It is not
  always that order: the parser puts a `<base>` inside a `<table>` before the table, which it made
  first, so Chromium resolves the table's `style` attribute against the page and the viewer against
  the `<base>`; and it gives the first `<body>` the attributes of a second `<body>` tag after the
  `<base>`, which Chromium resolves against the `<base>` and the viewer against the page. The review
  of #188 measured both in Chrome 158 and on both hosts. Content that a script adds, as from a
  template, resolves against the page's `<base>`, as when the script runs once the page is parsed; a
  script before the `<base>` that adds it at once would resolve it against the page.
  **Unreleased (#187):** the same holds for the page's resource attributes. A `<style>` or a
  `style` attribute before the `<base>` whose URLs would not fit in the text limit made absolute
  keeps them as written, so in the frame they resolve against the `<base>`: no markup gives one
  element a base of its own. With copying, their files still come from the page's folder.
- **Unreleased (#185):** an element after the `<base>` that repeats one before it resolves against
  the `<base>` in the copy, where Chromium can resolve it against the page: it reuses the attributes
  that it parsed, with their parsed `style`, for an element with the same tag and the same
  attributes in the same order. The review of #188 measured which folder the repeat's image came
  from, in served pages and in the viewer on both hosts:

  | After the `<base>`, compared with one before it | Chrome 158 | 1.15.1 (150) | 1.5.3 (114) | Viewer |
  | ----------------------------------------------- | ---------- | ------------ | ----------- | ------ |
  | Same tag, same attributes                       | page       | page         | page        | base   |
  | The same, in a declarative shadow root          | page       | page         | page        | base   |
  | Another tag, same attributes                    | base       | base         | page        | base   |
  | Another attribute order, id, or spacing         | base       | base         | base        | base   |
  | A `<style>` with the same text, no import       | base       | base         | page        | base   |
  | A `<style>` with the same text and an import    | base       | base         | base        | base   |

  A repeated stylesheet link loads from its own folder. The copy does not imitate this caching,
  which is no rule that a page states and which Chromium 114 and 150 do differently;
  `document.test.ts` tests the copy's own rule for a repeat, and its other tests of a late
  `<base>` give each element attributes of its own
  ([#191](https://github.com/viell-dev/slop-html-page-viewer/issues/191)).

- **Unreleased (#187):** Chromium resolves the URL of an image, a picture's source, a frame, a
  script, and an SVG `<use>` as it parses the element, so always before a later `<base>`. It
  resolves those of image inputs, posters, video, audio, and their sources, text tracks, SVG
  `<image>`, `<embed>`, and `<object>` later, when it lays the element out or starts to load it:
  against the page if it has not parsed the `<base>` by then, against the `<base>` if it has. Which
  comes first depends on the page. In served pages in Obsidian 1.5.3 and 1.15.1, which #187's
  measurements and the review of #197 ran three to six times each:
  - **A short page that the parser reads in one go**, with the `<base>` a few elements later and no
    script that the parser waits for: an image input, a poster, SVG `<image>`, and a `background`
    attribute came from the `<base>`'s folder in every run on both hosts, and an `<img>` from the
    page's.
  - **23 elements before the `<base>`**, also with an inline script just before it: on 1.5.3, text
    tracks came from the `<base>`'s folder in every run, sources, `<embed>`, and `<object>` in some,
    and the others from the page's; on 1.15.1, tracks, video, audio, sources, `<embed>`, and
    `<object>` came from the `<base>`'s folder in a third of the runs, and the image input from both
    folders. The media of a declarative shadow root just before the `<base>`, which Chromium
    attaches where the shadow root ends, varied too.
  - **The same elements with a script before the `<base>` that the parser waits for, or 300 KB of
    text**: every one came from the page's folder in every run on both hosts.

  The viewer resolves all of them against the page, as Chromium does for a long page and for one
  with such a script. For a short page, `main` at `c853231`, whose copy left them to its `<base>`,
  showed the second kind as Chromium does, and this change does not: that is the cost of one rule
  for every page. `resources.e2e.ts` delays the served page's script before the `<base>`, which
  fixes the order for all of them; it does not test the other order.
  **Unreleased (#198):** SVG `<feImage>` and `<script>` are of the first kind, and `background`
  attributes, also of `<col>` and `<colgroup>`, of the second. In served pages on both hosts, in 6
  of 6 runs of a short page, each `<feImage>` came from the page's folder and each background from
  the `<base>`'s; in 3 of 3 runs with a script before the `<base>` that the parser waits for, an SVG
  script among them, every one came from the page's.

- **Unreleased (#187):** the URLs that the copy makes absolute before a later `<base>` do not count
  toward the text limit: each grows by about the length of the page folder's address, and more
  where a URL escapes its characters, so the copy grows with the page's own markup, as with the
  references found by name (#184). The factor is that length over the length of the markup of
  each reference. In a folder of 1,000 characters, in jsdom, `document.stress.ts`'s images make
  the copy about 60 times as long as the page, but one `<img>` whose `srcset` is 100,000 times
  `a 1x,`, half a million characters, made it 208 times as long, 104 million characters, in 2.1 s,
  as the review of #197 measured. What the frame does with a copy of that length is not measured
  (#158).
- With scripts off, a text track from the vault does not load. Obsidian 1.5.3 and 1.15.1 refuse it
  as an "unsafe attempt to load URL" of another origin than the frame's, unless its video has a
  `crossorigin` attribute, with which it loaded, as Obsidian answers such requests. A copy as a
  `data:` URL loaded, but the review of #203 showed that the page's CSS could read such a copy in
  Chrome 158, with a selector such as `:has(track[src*="…"])`, and send it to the web through a
  `url()` that applies only when the selector matches. So the copy of a page with scripts off holds
  no file's contents but its stylesheets'
  ([#196](https://github.com/viell-dev/slop-html-page-viewer/issues/196)).
- With scripts off, Chromium shows its media controls on every video and audio element, as HTML has
  browsers do wherever scripts cannot run. In Obsidian 1.5.3 and 1.15.1, frames whose sandbox lacks
  `allow-scripts` showed no poster whole, also one given as a `data:` URL, as a served frame shows
  one for a video with the `controls` attribute. The controls cover the lower part of a poster, and
  all of a 64-pixel video's, which #196 took for a poster that did not load. Hiding them would leave
  the reader no way to play the media, so the copy keeps them
  ([#196](https://github.com/viell-dev/slop-html-page-viewer/issues/196)).
- An SVG `<use>` of another file shows nothing, with scripts on or off. With scripts off, Obsidian
  1.5.3 and 1.15.1 refuse a vault file there as an "unsafe attempt to load URL" of another origin
  than the frame's; with scripts on, the frame's origin is opaque. A copy as a `data:` URL showed
  on 1.5.3 and was refused on 1.15.1, so copying the file would only lengthen the copy on the
  current host. A `blob:` URL from Obsidian's window showed with scripts off, but would have to
  live as long as the page, which the view does not manage. Putting the symbol into the copy would
  style it otherwise: in served pages, the page's rules applied to an external symbol on neither
  host, and the file's own `<style>` and gradient did on 1.15.1 and not on 1.5.3
  ([#196](https://github.com/viell-dev/slop-html-page-viewer/issues/196)).
- With scripts on, a `<base>` that the page's script adds does not apply when it comes after the
  copy's own `<base>`, which is first in the `<head>`: in Obsidian 1.5.3 and 1.15.1, what the page
  named after it resolved against the page's folder, where a served page resolved it against the
  added `<base>`. One that the script puts before the copy's applies, but resolves a relative
  address against the frame's fallback base, Obsidian's `app://obsidian.md/`, instead of the
  page's. No `<base>` that the copy places lets a script's relative one resolve against the page
  ([#193](https://github.com/viell-dev/slop-html-page-viewer/issues/193)).

- **Unreleased (#179):** a string that reaches `image-set()` only through `var()`, as in
  `--icon: "icon.png"` and `image-set(var(--icon) 1x)`, is not between that function's parentheses
  in the stylesheet's text, so the copy keeps it as written, and copies nothing for it. Chromium
  resolves it against the stylesheet that declares the property: the review of #188 measured, in
  Chrome 158 and on both hosts, that such a string in `css/set.css` loads `css/n8.png`, while the
  viewer shows `n8.png` beside the page. Whether Obsidian's Chromium supports `image()` and
  `src()`, whose strings are URLs too, is checked only in the two tested versions, which support
  neither.
- **Unreleased (#155):** closing a page's own stylesheet at its end can change what Chromium
  computes from a custom property whose value the stylesheet leaves open: Chromium keeps the value
  as text, with the closers, and puts it where the property is used. With
  `<style>p { margin-left: calc(var(--x) * 2) }</style><style>p { --x: (1px + 2px</style>`, headless
  Chrome 158 computes `margin-left` as 5px from the text as written and as 6px from the copy's
  closed text. A page's scripts see the closers too, in such a value, and as an empty rule for a
  selector left without its block. This was not measured in Obsidian.
- **Unreleased (#151):** whether Obsidian's Chromium applies an import's support conditions is read
  from its `CSSImportRule`, which has `supportsText` in Chromium 150 and not in 114. Only those two
  were measured; the versions between them are not tested.
- **Unreleased (#152):** no test loads Google Fonts, which needs the network: the host tests check
  the `CSSImportRule` of a layered web stylesheet that Obsidian's policy refuses, which shows that
  its import counts as one of Google Fonts would. Whether an import's place matters is read from its
  URL's origin, its layer, and whether the viewer reads its conditions (`placeMatters`), which only
  `document.test.ts` checks for Google Fonts and unread conditions. The follow-up review of #174
  loaded Google Fonts after copied rules in Obsidian 1.5.3 and 1.15.1. An imported stylesheet's
  `@namespace` rule still applies to the rules after it in the copy, or does not apply after another
  stylesheet's rules, and no test covers it. A kept import with an anonymous layer around it, or
  with media conditions inside others, stays in its blocks, where it never counts, which only
  `document.test.ts` checks.
- **Unreleased (#152):** the `<style>` elements that the copy adds before a page's own, or in a
  link's place, are elements of the page. A selector that counts the elements beside them, such
  as `#box > :nth-child(2)`, can match another element than in the page, and with scripts on, the
  page's scripts find more `<style>` elements and stylesheets, the first of which may hold only
  imported rules. The review of #174 saw `:nth-child` match another element in Obsidian 1.5.3 and
  1.15.1; no test covers what selectors or scripts see.
- **Unreleased (#177):** the text limit counts the stylesheet text that preparing writes into the
  page, not the copy that the view serializes from it: character references in an SVG `<style>`
  and in copied `media` and `title` attributes, and the escaping of `</style`, can make the copy
  up to six times longer (#183). It does not count the page's own markup: references found by name
  in `<style>` elements, `style` attributes, and other attributes can make the copy hundreds of
  times the page's length, and locating them costs time with each reference and the length of the
  page's URL (#184). An import whose stylesheet the viewer copies counts as long as a kept import,
  so the limit can count up to a URL's length more than the copy holds for each of them. No test
  opens a page of #177's sizes in Obsidian; the counting happens in preparation, which the unit
  tests run.
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
  `display: none`, are tested only in `move.test.ts`. **Unreleased (#167):** a modifier key alone,
  which scrolls nothing, does not stop the placement, as `move.test.ts` tests.
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
  On 1.5.3, that frame can keep a place that a tab's move lost, when a key that scrolls nothing
  comes in the same frame as a hotkey that moves the tab, as a macro can send them. A modifier key,
  which such a hotkey sends first, does not count as the reader's input (#167); `move.e2e.ts` gives
  it as a dispatched event in the task of the move. With real keys, Ctrl and F9 sent with no pause,
  where F9 moved the tab, left the source at its start in 1 of 6 runs on 1.5.3 without that, and
  in none of 4 with it. The find bar's scroll of the source is the view's own, and the view keeps
  where it put the source (#167); `move.e2e.ts` has the find bar scroll and sends the layout change
  or the resize in one task.
  **Unreleased (#165):** In a new window, Obsidian 1.5.3 lays the split view's source out before
  Obsidian's app.css arrives there, and in some moves the view puts the sides in step for that
  layout, whose lines then move. The view puts the sides in step again at the first size change of
  the source's lines within 2 seconds of showing the page there. The page leads again, or, where
  the reader scrolled the source last, the source keeps their line and the page follows it; a
  source that Chromium has scrolled since, as scroll anchoring would, leads from where it is.
  **Unreleased (#195):** so does a source that led before the move, from the line that its kept
  place put it back at, and one that Chromium has left at its end, short of where it led from,
  keeps its line; only `split.test.ts` tests the end.
  Styles that arrive later, and later changes of the layout, leave the sides as they are until the
  next scroll. `move.e2e.ts` holds the new window's app.css back until the view has followed the
  page, and then the reader's scroll of the source, in every run. On 1.15.1 the source's lines
  have their height without app.css, so holding it back moves nothing, and the test cannot show a
  drift there. In the test, the styles mostly arrive more than 250 ms after the view measured the
  sides, when the view measures them again by itself at the next scroll, so only `split.test.ts`
  holds that the view measures both sides again at once, and only it holds the guards on keeping
  the source's line and the page's following of it. A source that the reader scrolled to its start
  or its end in the fraction of a second before the styles arrive leaves it: to its first line's
  top, 10 pixels down, or a line or so above its end. The other tests of a move allow a line
  between the sides.
- **Unreleased (#162):** `move.e2e.ts` checks the find bar's matches after a move by the highlights
  that the source's window holds and the boxes of their ranges, not by the pixels painted.
  `find.e2e.ts` checks what Chromium paints in a page. `move.e2e.ts` moves the **Source** view; the
  split view with scripts on, whose source the same code searches again, is tested only in
  `find.test.ts`.
- **Unreleased (#175):** A key typed into the find bar in the same task as its tab's move out of a
  window that then closes is not searched, since its delay runs in that window. Enter searches it,
  and the next key does after its delay. `move.e2e.ts` and `find.test.ts` type into the bar after
  such a move, or before a move to a window that stays open.
- **Unreleased (#178):** The view puts the page, and the split view's source, back when the
  ResizeObserver of the frame's window reports that the frame has a size again after it had none,
  which the HTML standard has a window do before it paints. No test checks the frame that Chromium
  paints first.
  - A scroll that Chromium has yet to report when the tab hides, made in the frame before, is not
    kept: the page or the source goes back to where it was before that scroll.
  - A tab shown again after the frame's window reported it hidden, but before Chromium reported the
    hidden page's scroll to its start, as a script can do within one of Chromium's frames, leaves
    the page at its top: Chromium reports that scroll once the frame is laid out again, and the view
    takes it for the page's place. A hide and a show within one task, with a layout in between,
    leave the page where it was.
  - Once the sides are back, the side that led last puts them in step once; only `split.test.ts`
    tests that the sides are measured again for that.
  - **Unreleased (#182):** The page goes back to the element that was at its top, and the split
    view's source to the line that was at its top, as the view measured them once their scrolling
    had settled: once 100 ms of their window's animation frames had passed without a scroll
    report. Finding that element in every frame of a scroll would show: on 2026-11-19, in Docker on
    Obsidian 1.5.3 and 1.15.1, it took a median of 1.9 to 2.3 ms, and up to 7.8 ms, in each of 300
    frames of a scroll through a copy of the corpus's 500-row table, and a median of 11 to 12 ms,
    and up to 29 ms, through a page of 3,000 paragraphs. Obsidian's `active-leaf-change`, which
    could have been the moment to measure it once, came 27 to 46 ms after the tab hid, when the
    page had no layout.
    - A scroll that comes in steps less than 100 ms apart is searched once, at its end. On the page
      of 3,000 paragraphs, 20-pixel steps every second, third, or sixth frame were searched once or
      twice, where one quiet frame had searched after each of their 60, 40, and 20 steps. Steps
      further apart are each searched, as mouse-wheel notches more than 100 ms apart are: every
      eighth frame, 15 searches for 15 steps, at a median of 28 ms on 1.15.1 and 56 ms on 1.5.3
      while a second container ran beside them.
    - A page that was still scrolling when the tab hid, or that stopped less than 100 ms before,
      goes back as far down as it was. `move.e2e.ts` hides the tab two frames after a scroll, at
      the same width, and checks that the page goes back to the pixel and not to the element
      measured before; `move.test.ts` tests it too. **Unreleased (#189):** a source's line is
      measured at each scroll that it reports, as finding it reads the tops of the few lines of a
      binary search, so a source keeps its line also where it hid or moved right after a scroll;
      `split.test.ts` tests that.
    - A change of the page's layout while it shows, without a scroll, makes the element measured
      out of date until it is measured again, once 100 ms pass: the page's own window's
      `ResizeObserver` reports the sizes of its root and its body. Until then, the page goes back
      as far down as it was. `move.e2e.ts` turns Obsidian's Readable line length off, and narrows a
      page with `overflow-anchor: none`, while the tab shows, and turns Readable line length off
      two frames before the tab hides, before the view has measured the page again. A change that
      moves the page's text but changes neither size, or a page whose root or body changes size in
      every frame, is not tested; the second is never measured, and goes back in pixels.
    - Showing the tab again lays its page out anew, which the page's window reports right after
      `back`, in the same animation frame: that report is passed over, and where `back` showed the
      element, it is up to date where `back` put the page. So a tab shown for less than 100 ms, as
      one passed over while stepping through a tab group's tabs, keeps the element for its next
      show. `move.e2e.ts` shows the tab for two frames, and narrows its view while it is hidden
      again; only `move.test.ts` tests a brief show at another width.
    - `move.e2e.ts` narrows the tab's view with a style while the tab is hidden, as a narrower pane
      would; a sidebar opened meanwhile is not tested. It checks the page's sideways place with a
      page wider than its view.
  - Only `split.test.ts` tests that a scroll of the source that the reader makes as the tab shows
    again, before the frame's observer reports, leads.
  - `move.e2e.ts` hides the tab by opening a new tab in its tab group through Obsidian's API. It
    shows the tab again as the reader's click on its header does: it calls the header's `click()`
    in a task of its own, which runs Obsidian's handler of the click. Then a wrapped source reports
    where Chromium laid it out before the frame's observer reports. One wrapped-lines test also
    shows the tab through the API inside an animation frame's callback, where the observer reports
    first.
  - It does not click the tab header with WebDriver. In CI, in two runs of each version on
    2026-11-19, five of those clicks went wrong: three left the other tab shown, and two closed the
    viewer's tab. Over 200 passed in Docker, also beside ten busy host processes and in full runs.
    The cause was not found. One lead: after a failed WebDriver drag on Obsidian 1.5.3, every later
    WebDriver click on a tab header in that session did nothing, as did a click on the **Split**
    button, while the header's own `click()` still worked. No test drags, so that is not shown to
    be the cause.
  - **Unreleased (#186):** A frame that drops its document while its tab is hidden gives the next
    document the element that was at its page's top while it showed, as for #182. Where the next
    document has its text while its frame has no size, it shows that element once the frame has
    a size, and hands it on if the frame drops it before then.
    - `move.e2e.ts` moves a hidden tab to a new window with its tab header's menu, which it opens
      with a `contextmenu` event and whose item it clicks with `click()`, and with
      `moveLeafToPopout` for the reader's later scroll of the source; and to another tab group
      with the calls of a drop. Dragging a hidden tab's header is not tested.
    - The frame of a tab hidden behind the tab in front of it drops its document when Obsidian lays
      the tab group out anew, as for **Split down** in that tab, and the next document has its text
      with the frame 0 pixels high. `move.e2e.ts` runs `workspace:split-horizontal` there, and
      also closes the new pane again before showing the tab, which drops the document once more on
      both versions; it checks that the frame loaded a new document each time.
    - Where the page was still scrolling when the tab hid, or stopped less than 100 ms before, the
      next document gets the element measured where its scrolling last settled, as only
      `move.test.ts` tests: the pixels it was last reported at belong to the old layout. After Split
      down, the split view's source goes back to where it was scrolled, and its sides are apart
      until the next scroll; the in-depth review of #190 measured that, with the tab hidden 22 to
      35 ms after a scroll of the page to another paragraph, and no test covers it.
  - That a page with scripts on starts from its top was measured for #178 on both versions, not
    tested. That Chromium keeps the places of the frame's own scrolling elements, and of the
    **Source** view, `move.e2e.ts` tests.
  - **Unreleased (#189):** The **Source** view's source goes back to its line when the
    ResizeObserver of its own window reports that it has a size again, before that window paints,
    as for the frame. Chromium lays it out again as far down as it was, and reports no scroll for
    that, nor for its scroll to its start while hidden. In a new window, Obsidian 1.5.3 first lays
    the view out with no width, where each of the source's lines is as high as its characters are
    many, so a source counts as shown, and its line as known, only once it has a width. After a
    move to another window, the view observes the source in that window at Obsidian's next layout
    change or resize, which also tells a showing that the first window's observer missed; on both
    versions, the main window's observer still reported the moved source's sizes. There, the source
    also goes back to its line at each size change of its lines within 2 seconds, as Obsidian 1.5.3
    lays a new window out before its styles arrive (#165), or to the line where the reader scrolled
    it since; later changes of its layout leave it where it is. The in-depth review of #202
    measured that limit: with the new window's app.css held back 2.6 s past that, the source showed
    line 39 in place of line 37 on 1.5.3 once the styles came, and on 1.15.1 nothing moved.
    `move.e2e.ts` holds the new window's app.css back until the view has put the source at its line
    without it, as for the split view. It also hides the tab two frames after a scroll of the
    source, within the 100 ms in which a page's scrolling settles.
  - **Unreleased (#189):** A resize of the pane while the **Source** view shows is left to
    Chromium's scroll anchoring, which keeps the source near its line but not at it. The in-depth
    review of #202 narrowed it from 1196 to 454 px wide while it showed: the source went to 75 px
    above line 37, with the last rows of line 36 at its top. The view adds nothing to that.
  - **Unreleased (#189):** After a move, Obsidian puts a source back as far down as it was, which
    Chromium reports as a scroll to where the source was last reported, or to its end where its
    lines now take less room: 1.15.1 in every move measured, and 1.5.3 in some, as in a move after
    the tab had been hidden once. The view takes such a scroll of an element of the view for a lost
    place, and shows the source's line there; the reader's scrolling never reports where its last
    report left it. A frame's page, which Obsidian never puts back, takes no such scroll for one.
    Obsidian 1.5.3 shows a source moved without that from its start, and the view puts it back at
    its line at the layout change. `move.e2e.ts` moves the **Source** view into a narrower and a
    wider tab group, made beside the first with a `max-width` on one of them, and to a new window,
    with and without hiding it first. No committed test drags a tab header; the in-depth review of
    #202 dragged one onto a narrower tab group on 1.15.1, for the **Source** view and the split
    view, and both kept their line.
  - **Unreleased (#195):** The view records which side of the split view led last when the frame
    drops its page, and has that side lead the next document; a document that the frame drops
    before the view has shown it hands on the side that led before it. From the frame's `pagehide`
    until the next document shows, the source's place is held, apart from a scroll that it reports
    in the frame of the reader's input in it. The source then goes back to its line, or, where the
    watch of the reader says that they scrolled it, stays where they did, also where Chromium
    reported that scroll a frame after their input, as with smooth scrolling. Where the source
    leads, the page follows it, and the page's own scrolling leads nothing until the page has
    loaded or the reader acts, as Chromium's scroll anchoring scrolls the page while its images
    load; the source then leads again. A page whose images never arrive follows the source until
    the reader acts. Where the page led last, it is placed and leads, as before. `move.e2e.ts`
    tests the long head of #195 in another tab group, in a new window whose app.css is held back
    until the view has put the source at its line, and after a hidden tab's move by its menu; a
    head whose rules wrap in a narrower tab group; and a page that a script scrolls before its
    held image arrives. Only `split.test.ts` tests a document dropped before it was shown.
- With scripts off, a link inside what SVG `<use>` copies does nothing when clicked. The copy is in
  the browser's own shadow tree, which hides from the view which link was clicked, and the view
  cancels the navigation that the click starts, as `links.e2e.ts` checks. Pages mostly use `<use>`
  for icons, inside a link around the `<svg>`, which is followed as usual.
- Find counts a closed select's chosen option text, but Chromium paints no Custom Highlight on
  that native label. Selects with `multiple`, list boxes (`size` above one), and option `label`
  attributes are not searched. Shadow matches stay within one tree; SVG `<use>` copies live in
  inaccessible browser shadow trees and are not searched (#122, #124).
- The 15 s limit for a corpus page is a ceiling against a page that hangs, not a measure of speed.
- The code of a test in Obsidian that runs past its timeout stops at its first WebDriver request
  after WebdriverIO fails the test, which the run refuses (#170). Until then it goes on, and what it
  does without WebDriver, such as writing the vault's files on disk as `read-only.e2e.ts` does, can
  still change what the tests after it see. Once Mocha has gone on, a refusal is no longer added to
  the failure, and only the first is printed to the log. WebdriverIO's own retries, the third
  argument of `it`, run each attempt in the test's one scope, so the run cannot refuse one attempt's
  late requests during the next; Mocha's `retries` can. No spec uses either.
- The Release workflow's writes to GitHub are tested against a stand-in, and its reads against
  GitHub; its publish job runs for real only in a release, whose run the release's pull request
  records.
- The lint and end-to-end test tools retain moderate advisories (#85). Both dependency packages
  have a required CI audit that fails on any advisory above moderate severity that
  `.github/audit-exceptions.json` does not accept, and on an exception that is no longer needed.
  `audit.test.ts` checks its decisions, and CONTRIBUTING.md says when an exception is acceptable. The tools run against the repository's own files, and only its configuration
  supplies their glob patterns.
