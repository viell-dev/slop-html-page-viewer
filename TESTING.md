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

| Promise                                                                                                                                                                            | Unit tests                                                                                                                                                                | In Obsidian                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Scripts and same-origin access are never granted together; scripts start off for each file                                                                                         | `rendered.test.ts`                                                                                                                                                        | `viewer.e2e.ts`: the frame cannot run scripts, and gets only `allow-scripts` with them on                                        |
| With scripts on, a page cannot reach the vault's files, apart from those copied into it                                                                                            | `document.test.ts`, `settings.test.ts`; `rendered.test.ts`: each frame has its sandbox before it is inserted                                                              | `resources.e2e.ts`: the origin that Obsidian's main process records for the frame is opaque from its creation; `settings.e2e.ts` |
| Only the vault's files load; a stylesheet comes only from a `.css` file; notes are never copied                                                                                    | `document.test.ts`: `vaultPath`, `pagePolicy`, stylesheets, locating by name                                                                                              | `resources.e2e.ts`: nothing from outside the vault                                                                               |
| A page whose copy cannot be prepared shows an error, never the file; an unreadable stylesheet is left out                                                                          | `rendered.test.ts`; `document.test.ts`: CSS escapes, unreadable files                                                                                                     | `resources.e2e.ts`: nothing from outside the vault on such pages either                                                          |
| The plugin never writes to vault files, makes no network requests, and does not use the clipboard                                                                                  | `policy.test.ts` reads the built bundle; `refresh.test.ts`: Obsidian's saving, which the bundle lacks                                                                     | `read-only.e2e.ts`: files are unchanged once they leave the view, also after refreshes                                           |
| A tab shows only its own file's contents, also when a read of a file ends after another file opened in the tab                                                                     | `refresh.test.ts`: a refresh; **Unreleased (#115):** Obsidian's reload of a changed file                                                                                  | `read-only.e2e.ts`: a refresh; **Unreleased (#115):** Obsidian's reload, after a switch, and of a change on disk                 |
| A page shows its local images, stylesheets, and fonts; references resolve by path or by name, also in shadow DOM                                                                   | `document.test.ts`, also the content of templates and shadow roots                                                                                                        | `resources.e2e.ts`, also in shadow DOM and copied with scripts on; `corpus.e2e.ts`                                               |
| HTML and SVG links, also nested and in shadow roots, stay in the copy, which no other navigation leaves and which acts only once watched; fragments follow id/name/top precedence  | `links.test.ts`; `document.test.ts`: shadow roots, inert copy; `rendered.test.ts`: only with scripts off                                                                  | `links.e2e.ts`, also after the tab moves to another tab group or window                                                          |
| Hovering a link shows where it leads, and an image its alt text, also in shadow DOM; an SVG link only when nothing inside it names it, which keeps that name                       | `document.test.ts`: tooltips                                                                                                                                              | `links.e2e.ts`: the titles that Chromium shows, and the names that it gives the links                                            |
| Pages without styles follow Obsidian's theme and Readable line length                                                                                                              | `reading.test.ts`                                                                                                                                                         | `theme.e2e.ts`                                                                                                                   |
| Settings, their defaults, and their immediate effect                                                                                                                               | `settings.test.ts`, `extensions.test.ts`, `plugin.test.ts`; the README's defaults: `consistency.test.ts`                                                                  | `settings.e2e.ts`, in Obsidian's own settings window                                                                             |
| The source view shows every character of the file, highlighted as HTML reads it                                                                                                    | `source.test.ts`, including random markup                                                                                                                                 | `viewer.e2e.ts`                                                                                                                  |
| The find bar finds in the source and the page, and moves with Enter, Shift+Enter, and Escape                                                                                       | `find.test.ts`: close paths, no-`checkVisibility` fallback, `content-visibility`                                                                                          | `find.e2e.ts`: Ctrl+F; finds exactly the words that the page paints                                                              |
| The split view keeps its two sides in step                                                                                                                                         | `split.test.ts`, also with shadow roots                                                                                                                                   | `split.e2e.ts`, both ways, on a smoothly scrolling page, and with shadow roots on an article, on the body, and declared late     |
| **Unreleased (#126):** A tab moved to another tab group or window keeps its reading style, and the place of a page that scrolls as a whole; the split view follows only its page   | `move.test.ts`: the place, by the element at the window's top, through `display: contents` and in parts closed again; placing again at `load` until the reader's input    | `move.e2e.ts`: a narrower tab group, a new window, a theme changed in place, the split view, scrolling before load, closed parts |
| Toolbar buttons and the find bar are labelled, the toggles and view modes say their state, and the match count is announced                                                        | `find.test.ts`, `reading.test.ts`, `rendered.test.ts`                                                                                                                     |                                                                                                                                  |
| Archived pages show as the previous build showed them                                                                                                                              |                                                                                                                                                                           | `corpus.e2e.ts` and `corpus/compare.mjs`: fails if the prototype showed an image that the plugin does not                        |
| A release holds exactly the verified build: its commit's CI passed, its files match their checksums, the zip, and each other, and a stopped run resumes without replacing anything | `release.test.ts`, against a stand-in for GitHub                                                                                                                          | The Release workflow's `verify-published` step, against the published release                                                    |
| Installing the release's zip, turning the plugin off and on, updating it, and restarting Obsidian keep its settings, extensions, and view                                          | `release.test.ts`: the zip holds the plugin's folder; `extensions.test.ts`: the viewer gives up only its own extensions; `settings.test.ts`: missing and damaged settings | `lifecycle.e2e.ts`                                                                                                               |
| Large pages stay usable                                                                                                                                                            | `find.test.ts`: at most 10,000 matches; `split.test.ts`: alignment past its limit; `settings.test.ts`: copy limits; `document.stress.ts`: 130,000 templates               | `corpus.e2e.ts`: every page, the 600 KB page with 500 images too, opens and passes its checks within 15 s                        |

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

**Unreleased (#115):** On 2026-11-17, with the view as 0.5.2 has it, Obsidian's reload of a changed
file that finished after another file opened in the tab showed the first file's contents under the
second file's name: in `refresh.test.ts`, whose stand-in for Obsidian now reloads a changed file as
Obsidian 1.5.3 and 1.15.1 do, and in `read-only.e2e.ts` in Obsidian 1.5.3 and 1.15.1, where nothing
was written. Leaving out the view's own read of its file failed both of `read-only.e2e.ts`'s tests
of Obsidian's reload in 1.5.3 and 1.15.1: neither a change on disk nor the late reload showed the
page again.

**Unreleased (#124):** on 2026-11-17, the earlier preparation of a page, which left the content of
its templates, and so of its declared shadow roots, as written, failed the new shadow DOM and SVG
link tests in `document.test.ts`, and in Obsidian 1.5.3 and 1.15.1 those in `resources.e2e.ts` and
`links.e2e.ts`: the shadow DOM's image found by name, linked stylesheet, and import did not show,
with scripts off or with them on and copying files; its link and image had no title; and SVG links
had no `xlink:title`. The split view's earlier pairing, which left out shadow roots, failed
`split.test.ts`, and `split.e2e.ts` in both versions, where scrolling the source to paragraph 30's
line moved the page to paragraph 88.

**Unreleased (#124):** on 2026-11-17, after the independent review, these failed against the
earlier version of this change. Giving every SVG link without text a tooltip failed the new tooltip
test in `document.test.ts`, and `links.e2e.ts` in Obsidian 1.5.3 and 1.15.1, where a link around a
labelled shape and one around a `<use>` icon with a title were named by their URLs instead (#117).
The split view's pairing, which left out the body's own shadow root and took every shadow root to
come before its host's own content, failed `split.test.ts`, and `split.e2e.ts` in both versions:
scrolling the source to paragraph 30's line moved a page whose body has a shadow root to paragraph
89, and scrolling it to paragraph 15's line left a page that declares its shadow root after 30
paragraphs at paragraph 1.

**Unreleased (#124):** on 2026-11-17, after the follow-up review, these failed against the version
before it. Giving a tooltip to an SVG link around HTML in a `<foreignObject>` failed the new tooltip
test in `document.test.ts`, and `links.e2e.ts` in Obsidian 1.5.3 and 1.15.1, where a link around
text in a shadow root declared there was named by its URL instead (#117). The split view's pairing,
which took any comment with its mark's text for the mark, and also the mark of a declaration that
stayed a template, failed `split.test.ts` and `document.test.ts`, and `split.e2e.ts` in both
versions: with a comment of the page's own with that text before its first paragraph, scrolling the
source to paragraph 15's line left a page that declares its shadow root after 30 paragraphs at
paragraph 1.

**Unreleased (#126):** On 2026-11-17, `move.e2e.ts` failed in Obsidian 1.5.3 and 1.15.1 with the
view as 0.5.2 has it: after the tab moved, the page was back at its top in a new tab group and in a
new window, a theme changed in place was undone, and the split view's sides were apart. Keeping the
page's place as the height it was scrolled to failed only the move to a narrower tab group, where
the page showed paragraph 19 or 21 in place of 30. Keeping the split view's following of the
document that the frame dropped failed only the split view's test, which counted six measurements
of that document after the move. Placing the page again when it had loaded, even after the reader
had scrolled it with the mouse wheel, in the page or in the split view's source, failed both tests
of the reader's scrolling: the page showed paragraph 30 again in place of 41 or 42. Treating only a
part without a box as closed failed both tests of a part closed again, in both versions: the page
showed a closed `<details>` element 418 pixels, and a closed accordion's panel 429 pixels, above the
window's top. It also failed `move.test.ts`'s tests of those parts and of a page inside an element
with `display: contents`, which kept its place only as a share of the body's height.

## Limits

- On Chromium 135 to 141, which some Obsidian versions between the tested ones use, a page's own
  styles can lift the copy's inertness before the view watches it (#127). Neither tested host is
  affected; there the view's listeners, added as soon as each document exists, still protect it.
- Linux desktop is the supported Obsidian target. Windows provides additional build and unit-test
  coverage, and can run Linux Obsidian in Docker. Windows Obsidian, macOS, and mobile are outside
  the support scope; the manifest prevents mobile installation (#65).
- Obsidian 1.5.0 to 1.5.2, which the manifest allows, were Insider builds that need an account to
  download; 1.5.3 is the oldest version tested. The versions between 1.5.3 and the latest are not
  tested.
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
- **Unreleased (#126):** After a tab moves, the view stops placing its page again once the reader
  presses a key or a pointer button, touches the screen, or turns the mouse wheel, in the page or
  elsewhere in the view. `move.e2e.ts` scrolls with the mouse wheel. `move.test.ts` stops the
  placement with each of the four kinds of input in jsdom, which does not show that Chromium sends
  them where the view listens. A page inside an element with `display: contents`, and a part that
  a page hides with `display: none`, are tested only in `move.test.ts`.
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
- The end-to-end test tools retain moderate advisories (#85). Both dependency packages have a
  required CI audit at the high-severity threshold. The tools run only in CI and in disposable
  containers, against the repository's own fixtures.
