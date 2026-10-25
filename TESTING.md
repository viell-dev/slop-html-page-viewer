# Testing

What each promise in the [README](README.md) and [SECURITY.md](SECURITY.md) rests on, and what no
test covers. [CONTRIBUTING.md](CONTRIBUTING.md#checks) explains how to run the checks.

## Layers

- **Unit tests** (`npm test`) run the plugin's code in a jsdom window, with a stand-in for the parts
  of Obsidian's API that it uses. They are required in CI on Linux and Windows. They prove logic,
  not Obsidian's behavior.
- **Consistency tests** (`test/consistency.test.ts`, part of `npm test`), **linting**
  (`npm run lint`), and **formatting** (`npm run format:check`) keep the versions, changelog,
  release notes, documented settings, labels, CI jobs, end-to-end suites, and documents' links in
  agreement. They are required in CI.
- **Tests in Obsidian** (`test/e2e/`) run the built plugin in real Obsidian, 1.5.3 and the latest
  release, on Linux. They are required for every pull request and also run weekly, so that a new
  Obsidian release is tested within a week. Their logs and screenshots, with one of Obsidian's
  window for each failed test, are kept as a CI artifact for 30 days. Anything about loading,
  origins, focus, or keys is measured here.
- **The archive corpus** (`test/e2e/corpus/`) opens every page of a synthetic vault of archived web
  pages in Obsidian, and compares the result with the frozen prototype build.

The settings suite also checks that global settings search finds all five viewer settings and
opens each result on versions that provide the search (Obsidian 1.13 and later).

## Promises and their evidence

| Promise                                                                                                                                                                            | Unit tests                                                                                                         | In Obsidian                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Scripts and same-origin access are never granted together; scripts start off for each file                                                                                         | `rendered.test.ts`                                                                                                 | `viewer.e2e.ts`: the frame cannot run scripts, and gets only `allow-scripts` with them on                 |
| With scripts on, a page cannot reach the vault's files, apart from those copied into it                                                                                            | `document.test.ts`, `settings.test.ts`                                                                             | `resources.e2e.ts`, `settings.e2e.ts`                                                                     |
| Only the vault's files load; a stylesheet comes only from a `.css` file; notes are never copied                                                                                    | `document.test.ts`: `vaultPath`, `pagePolicy`, stylesheets, locating by name                                       | `resources.e2e.ts`: nothing from outside the vault                                                        |
| The plugin never writes to vault files, makes no network requests, and does not use the clipboard                                                                                  | `policy.test.ts` reads the built bundle                                                                            |                                                                                                           |
| A page shows its local images, stylesheets, and fonts; references resolve by path or by name                                                                                       | `document.test.ts`                                                                                                 | `resources.e2e.ts`, `corpus.e2e.ts`                                                                       |
| Links open as Obsidian opens them                                                                                                                                                  | `links.test.ts`                                                                                                    | `links.e2e.ts`                                                                                            |
| Pages without styles follow Obsidian's theme and Readable line length                                                                                                              | `reading.test.ts`                                                                                                  | `theme.e2e.ts`                                                                                            |
| Settings, their defaults, and their immediate effect                                                                                                                               | `settings.test.ts`, `extensions.test.ts`, `plugin.test.ts`; the README's defaults: `consistency.test.ts`           | `settings.e2e.ts`, in Obsidian's own settings window                                                      |
| The source view shows every character of the file, highlighted as HTML reads it                                                                                                    | `source.test.ts`, including random markup                                                                          | `viewer.e2e.ts`                                                                                           |
| The find bar finds in the source and the page, and moves with Enter, Shift+Enter, and Escape                                                                                       | `find.test.ts`                                                                                                     | `find.e2e.ts`, with Ctrl+F in the page and in the source view                                             |
| The split view keeps its two sides in step                                                                                                                                         | `split.test.ts`                                                                                                    | `split.e2e.ts`, in both directions, and on a page that scrolls smoothly                                   |
| Toolbar buttons and the find bar are labelled, and the match count is announced                                                                                                    | `find.test.ts`, `reading.test.ts`                                                                                  |                                                                                                           |
| Archived pages show as the previous build showed them                                                                                                                              |                                                                                                                    | `corpus.e2e.ts` and `corpus/compare.mjs`: fails if the prototype showed an image that the plugin does not |
| A release holds exactly the verified build: its commit's CI passed, its files match their checksums, the zip, and each other, and a stopped run resumes without replacing anything | `release.test.ts`, against a stand-in for GitHub                                                                   | The Release workflow's `verify-published` step, against the published release                             |
| Large pages stay usable                                                                                                                                                            | `find.test.ts`: at most 10,000 matches; `split.test.ts`: alignment past its limit; `settings.test.ts`: copy limits | `corpus.e2e.ts`: every page, the 600 KB page with 500 images too, opens and passes its checks within 15 s |

There is no standing benchmark suite: timings on CI's shared runners vary too much to fail a build
on. Costs that could matter were measured in Obsidian in their pull requests, such as about a
second for every 8 MB copied into a page with scripts on (#58).

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

## Limits

- Linux desktop is the supported Obsidian target. Windows provides additional build and unit-test
  coverage, and can run Linux Obsidian in Docker. Windows Obsidian, macOS, and mobile are outside
  the support scope; the manifest prevents mobile installation (#65).
- Obsidian 1.5.0 to 1.5.2, which the manifest allows, were Insider builds that need an account to
  download; 1.5.3 is the oldest version tested. The versions between 1.5.3 and the latest are not
  tested.
- Screen readers are not tested; the tests check the labels and attributes that they read.
- The 15 s limit for a corpus page is a ceiling against a page that hangs, not a measure of speed.
- The Release workflow's writes to GitHub are tested against a stand-in, and its reads against
  GitHub; its publish job runs for real only in a release, whose run the release's pull request
  records.
- The end-to-end test tools carry advisories that wait on a dependency (#21). They run only in CI
  and in disposable containers, against the repository's own fixtures.
