# Agent maintenance

This file holds what agents maintaining this repository need beyond its other documents. The
[README](./README.md#status) states how the fork is maintained, and
[CONTRIBUTING.md](./CONTRIBUTING.md) holds the setup, checks, branch model, and pull request rules;
follow them and do not repeat them here.

## Repository boundary

Everything the project needs lives in this repository. Never stage, copy, quote, or publish content
from outside it. Use synthetic fixtures, never real vault documents, in tests, issues, and pull
requests, and keep private documents out of screenshots and logs. The owner's vault is private: turn
observations from it into synthetic fixtures.

## Upstream

Upstream is
[viggomeesters/obsidian-html-page-viewer](https://github.com/viggomeesters/obsidian-html-page-viewer).
Pinned issue #2 is the overview of upstream's defects and the fork's dependency defects, the changes
offered upstream, and every check for a maintainer's response; keep it current, as
[Dependency defects](#dependency-defects) describes.

- Within their assigned work, agents may report upstream defects and offer upstream-bound fixes,
  following upstream's current contribution guidance and templates. Each submission opens with an
  attribution callout that names the agent and says whether the owner reviewed it.
- Upstream has not established that it accepts agent-written contributions. The first pull request,
  viggomeesters/obsidian-html-page-viewer#1, invites the maintainer to decline more, and stays the
  only submission, report or pull request, until a maintainer responds to it. Silence, an automated
  reply, or the absence of a ban is not a response; honor a response that declines.
- Check it while working on the fork and log each check in #2. If nobody responds by 2026-12-19,
  the owner's decision applies: stop offering changes and develop without regard to upstream.
  Record in #2 that the upstream route is unavailable, then decide whether the upstream-bound
  branch rule below still serves the fork, and record that decision there.
- Upstream-bound branches have no `AGENTS.md`. Read this file on `main` when working on one.
- Sync upstream's `main` through a pull request: push `upstream/main` to a branch named
  `upstream-sync-<date>` and open a pull request into `main`. If it conflicts, create that branch
  from `main` instead, merge `upstream/main` into it, and resolve the conflicts there. Upstream's
  releases change `main.js`, which this fork deleted; resolve that conflict by keeping it deleted.
  Move entries that upstream adds to `CHANGELOG.md` under its **Upstream releases** section.

## Branches and merging

Upstream-bound branches start from `upstream/main` and fork-only branches from `main`, as
CONTRIBUTING.md describes; label each pull request `Target: Upstream` or `Target: Fork`. Merge with
a merge commit after checking the exact head: `gh pr merge --merge --match-head-commit SHA`.

- Squash and rebase merging are disabled, because they would create commits that differ from the
  ones offered upstream, and later upstream syncs would conflict with them.
- The ruleset does not require branches to be up to date with `main`, and the update-branch button
  is off, because merging `main` into an upstream-bound branch adds fork-only files to it. When
  `main` has moved since a pull request's CI ran, close and reopen the pull request to test it
  against the current `main`; rerunning the workflow tests the old merge commit.
- An upstream-bound branch that conflicts with `main`, as one that changes `package.json` or the
  lockfile does, is merged through a second branch, `merge-<branch>`, created from `main`: merge the
  upstream-bound branch into it with `--no-ff`, resolve the conflicts and the fork's documents
  there, and open the pull request from it. The upstream-bound commits reach `main` unchanged. For
  the lockfile, take `main`'s and rerun the branch's `npm install` commands.
- Check that a merge succeeded before deleting its branch.
- GitHub does not delete merged branches. Keep an upstream-bound branch until upstream merges or
  declines it, or until #2 records that upstream is no longer followed; delete other branches after
  merging.
- `prototype` is the previous fork's build, which the owner's vault used until this fork's
  0.2.0-rc.1 replaced it (#12). It is frozen by a ruleset: read it as a reference for redoing its
  work, and never try to update it.
- Never commit `main.js`.

## Review

Every change gets its author's review of the complete diff once its checks pass, trying inputs that
the tests do not cover. Its pull request records the commands, their results, the platforms, and
what remains unverified. The author decides whether the change also needs an independent review,
from its sensitivity, complexity, impact, and uncertainty, and records that choice and its reason
in the pull request's verification section.

- An independent review is by a separate agent with fresh context, normally a model with stronger
  reasoning. Changes to the sandbox, to what the plugin reads or copies into a page, to link
  handling, or to the release workflow normally get one, as do complex changes that are hard to
  test. Ordinary, well-understood changes can rest on the author's review.
- A release pull request normally gets an in-depth independent review of everything since the
  previous release: the changes, unresolved defects, the evidence, compatibility, packaging, the
  documents, and installation and updates. Record the reason if it is left out.
- The review names the commit it reviewed. Fix its findings, or answer in the pull request why not.
  A material fix or a disputed finding gets a follow-up review, which includes the changes since.
- Review bots on the owner's account, such as Sourcery, cubic, and CodeRabbit, may comment on pull
  requests. Treat their threads as review: check each claim, fix what holds or answer why not, and
  resolve the thread; the ruleset requires resolved threads.

## Releases

The owner installs the fork by hand from GitHub releases. It is not in Obsidian's community plugin
directory, and listing it there would need the owner's decision. Agents publish routine releases
when their changes are ready, without asking each time. The owner does not test releases: test each
one as thoroughly as anything else before publishing it. Publish full versions. A release candidate
is only for a change that needs real use before its release, and no test can stand in for that use.
Choose the version by semantic versioning: a minor version for new features, a patch for fixes.

1. In a fork-only pull request, set the version in `manifest.json`, `package.json` and its lockfile,
   and `versions.json`. Add `.github/release-notes/<version>.md`, written for someone installing
   the plugin, and move the **Unreleased** entries in `CHANGELOG.md` to a section for the version.
2. After it merges, run `gh workflow run release.yml -f version=<version>` on `main`. The workflow
   checks the version, tests and builds, and publishes the zip, the three plugin files, and
   `SHA256SUMS`; a version with a prerelease part, such as `-rc.1`, becomes a prerelease.
3. Check the release's assets against the checksums.

Version tags are immutable (`.github/rulesets/version-tags.json`). Never change the owner's vault;
the owner installs releases there.

## Issues and labels

Take each assigned issue through validation (reproduce or measure on current `main`), a decision
with its reasoning and rejected alternatives, and a fix; the issue, not the session, is the record.
Labels follow [`.github/labels.json`](./.github/labels.json); keep GitHub in sync with it.

- Every item has one `Type:` label and at most one `Status:` label. `Status: Confirmed` means a
  reproduced defect or an accepted request; remove it when the item closes. The `Type:`, `Status:`,
  and `Needs:` labels, `Good First Issue`, and `Help Wanted` are shared with the maintainers' other
  repositories: keep their names, colors, and descriptions as they are there, and add no synonyms.
- `Target: Upstream` or `Target: Fork` says where the change can go. An upstream-bound defect found
  in upstream's code is also listed in #2.
- The fixing pull request names its issue with a closing keyword and carries the same labels.
- Record each defect or limit found during other work as an issue, or in an existing one, and link
  it from the pull request. An issue filed for later work states what its assignee must decide.
- A request that needs the owner goes in its own issue, assigned to them and labelled
  `Needs: Owner`: their decision on scope or direction, their identity, access, or second factor,
  or an observation only they can make. One that another suitable person could answer gets
  `Needs: Human` instead. State exactly what is needed and why an agent cannot provide it, the
  recommendation, the result to expect, and what waits for it. A request to try something names
  the build, gives synthetic inputs, numbered steps, and the expected results, and says what to
  report. Label the work that waits for the answer `Status: Blocked`, and link the two. Never ask
  the owner to test what a test can check.
- Edit an issue's or pull request's text from its exact bytes: write it to a file with `gh api`
  from a tool that keeps them, and send it back with `gh api -X PATCH … -F body=@file`. PowerShell
  turns captured `gh` output into an array of lines, and writing that array joins them with
  spaces; that flattened four descriptions here on 2026-10-19. Read the result back.

## Dependency defects

#2 is the one pinned overview of defects in upstream's code and in the fork's dependencies, such as
its test tools. Each entry links its dedicated issue, if it has one, and any upstream report or fix.
It records the affected versions, the impact, the evidence, the local handling, and what would
unblock or reopen it, and gives one of four states:

1. **Blocked upstream:** no local remedy; the affected behavior waits for upstream. State the limit
   that users or maintainers meet and any effect on releases.
2. **Worked around:** upstream is still defective, but a verified local fix or workaround handles
   it. State its limits, and when it can be removed.
3. **Resolved upstream:** an upstream fix is verified, in a release or an unreleased commit. Track
   adopting it and removing the workaround until the fork's own result is verified.
4. **Upstream route unavailable:** upstream is unresponsive, declines, or prohibits the
   contribution, as its policy or a dated interaction shows. Record the local remedy chosen.

Check the relevant upstream responses and versions during maintenance and before a release that
they affect, and log each check in #2. A dedicated issue with no local work left may be closed as
not planned, keeping `Status: Blocked`, while #2 records the condition for reopening it.

## Settings

`.github/rulesets/` records the rulesets for `main`, `prototype`, and version tags; keep it and
GitHub's settings in sync. The required checks bind to the `verify (ubuntu-latest)` and `verify
(windows-latest)` job names and the `e2e` job in `ci.yml`, and to GitHub Actions, app 15368, so
renaming a job needs a ruleset update. The tests in Obsidian are required because they are the only
test of what users see. Zero required approvals is deliberate for a single-account, agent-maintained
repository; pull requests, passing checks, and resolved review threads remain mandatory.

Other repository settings, each recorded here with its reason when it changes:

- GitHub Actions may run only actions that GitHub owns, pinned by full commit SHA, with read-only
  default permissions.
- Dependabot alerts and security updates, secret scanning with push protection, and private
  vulnerability reporting are on. Dependabot's version updates follow `.github/dependabot.yml`.
- Issues are on; wiki, projects, and discussions are off.
- #2, the upstream overview, is pinned.

Maintainers enforce the [code of conduct](./CODE_OF_CONDUCT.md).

## Technical map

- `src/main.ts` holds the plugin class, which registers the view for the extensions the settings
  list and keeps each tab's toolbar choices (`tabChoices`, #39) while the tab shows other views;
  `HtmlPageViewerView`, a `TextFileView` that renders the toolbar and the sandboxed frame, the
  source view, or both side by side; `sandboxValue`, the one place that computes the frame's
  sandbox; and the source highlighter, whose `tokenizeHtml` reads the whole file as HTML's tokenizer
  does, into tokens that together are exactly the file's text, which `renderSource` splits into
  lines (#54). Scripts are never among the kept choices: they start off for every file.
- `src/document.ts` prepares the copy of the page that the frame shows through `srcdoc`: a `<base>`
  at the file's resource URL, a Content Security Policy that keeps Obsidian's file URLs inside the
  vault, and each linked vault stylesheet copied into a `<style>` with its references made absolute;
  only `.css` files are read as stylesheets (`isStylesheetFile`), because with scripts on the page's
  scripts can read the copy. With scripts on and the `copyLocalFiles` setting, `copyReferencedFiles`
  copies the vault images, media, text tracks, fonts, and scripts that the page names
  (`COPIED_TYPES`) into it as `data:` URLs, within `COPY_FILE_LIMIT` and `COPY_PAGE_LIMIT` (#11), in
  two passes: `FileCopier` notes every reference, gives the page's limit to scripts, fonts, and text
  tracks before images and media, counting each reference, and copies what that allows; measured in
  Obsidian, a frame with an opaque origin loads `data:` URLs, but not the `blob:` URLs that
  Obsidian's window creates. A reference whose vault path does not exist is pointed at the file that
  Obsidian's link resolution (`getFirstLinkpathDest`) finds for it (`locatedUrl`); clicked links
  fall back the same way in `openVaultPath`. References that resolve stay as written. Links and
  images without a `title` get one (`addTooltips`, #42): a link's vault path or address, as a click
  would open it, and an image's alt text; `linkTooltip` skips the links that `linkTarget` in
  `src/links.ts` does not open. The measurements behind this design are in #7: in Obsidian, only a
  `srcdoc` frame with Obsidian's origin (`allow-same-origin`) loads vault files, and such a frame
  inherits Obsidian's policy, which allows only inline styles. Recheck them with the end-to-end
  suite when Obsidian changes.
- `src/reading.ts` builds the reading style from Obsidian's theme variables, for pages without a
  `<style>` or a stylesheet link, and keeps the text to the theme's line width while Obsidian's
  Readable line length setting (`vault.getConfig("readableLineLength")`) is on. `preparePage` adds
  it to the copy; on Obsidian's `css-change` event, and on the vault's `config-changed` for that
  setting (#37), the view replaces its text in place when it can reach the page (scripts off), and
  prepares the page again otherwise. Theme values are stripped of characters that could end a
  declaration.
- `src/links.ts` classifies a link's resolved URL and follows clicks in the page: the view calls
  `watchLinks` on each load of a page it can reach, and its capturing `click` and `auxclick`
  listeners run although the page's scripts are disabled (measured in #9). External links go to
  `window.open`, vault files to `openVaultPath` in `src/main.ts`.
- `src/find.ts` finds text for the find bar (#13): `sourceRuns` and `pageRuns` collect the text of
  the source view's lines and of a page's blocks, `findRanges` turns case-insensitive matches into
  ranges, and `Highlighter` shows them with the CSS Custom Highlight API, sharing the named
  highlights of a window with other views. The view opens the bar from its toolbar, from Mod+F in
  its `scope`, from a key press in a page it can reach, and from the `find-in-page` command, and
  searches the page only with scripts off, and the source in the split view; measured in Obsidian
  1.5.3 and 1.14.4, highlights work in the page's frame, and a view's `scope` gets Mod+F before
  Obsidian's own hotkeys.
- `src/split.ts` keeps the split view's sides in step (#13): `startTags` in `src/main.ts` lists the
  source's start tags with their lines, and `anchorElements` pairs the page's elements with them by
  aligning the two sequences of names (`alignSequences`, Myers's algorithm), as the parser adds
  elements, such as `tbody` and copies of misnested formatting, and drops tags; past 1,000
  differences it looks 16 tags ahead instead. `syncPoints` keeps the longest run of paired elements
  whose heights on the page are in order, leaving out fixed, sticky, and hidden ones, and adds both
  sides' ends; `pageTopForLine` and `lineForPageTop` map between a source line and a height of the
  page in proportion between them. `ScrollFollower` lets the scrolled side lead once per animation
  frame and passes over the one scroll that moving the other side causes. The view's
  `syncScrolling` starts once the page's document is parsed, measures again at most every 250 ms
  when a side's height changes (`remeasured`), and scrolls instantly; it works only with scripts
  off, and only for a page that scrolls as a whole.
- `src/settings.ts` holds the settings (#38), how they are read from the plugin's saved data
  (`readSettings`, where a missing or mistyped value takes its default), and the settings tab. The
  Theme and Scripts settings choose how those buttons start, and open tabs keep their state; source
  wrapping (#40) and the copying of local files into pages with scripts on (#11) apply at once,
  through the workspace event `html-page-viewer:settings-change`. Obsidian 1.14 shows its settings
  in a window of its own, so tests reach a settings tab through `app.setting.activeTab`, not the
  main window's document.
- `src/extensions.ts` normalizes the listed extensions and holds them in Obsidian's view registry
  (#41), which Obsidian 1.5 and later have but do not declare: `ExtensionRegistration` registers
  and gives up each extension on its own, never takes one another view has, and gives up only those
  still registered to the viewer. Without the registry, `Plugin.registerExtensions` registers them
  once. Measured in 1.5.3 and 1.14.4: registering an existing extension throws, and the registry
  keeps case and dots as given.
- `esbuild.config.mjs` bundles `src/main.ts` into `main.js`, minified when its first argument is
  `production`. `styles.css` is the plugin's stylesheet; `test-fixtures/` holds HTML files for
  manual and automated tests.
- `scripts/test.mjs` bundles each `test/*.test.ts` into `dist/test/` and runs it with Node.js's test
  runner. `test/support/dom.ts` installs a jsdom window and Obsidian's element helpers as globals,
  `test/support/obsidian.ts` stands in for the `obsidian` module and records what the plugin asks of
  it, and `test/support/harness.ts` loads the plugin and opens views as Obsidian does. Extend the
  stand-in when the plugin uses more of Obsidian's API, keeping it as Obsidian behaves.
  `test/policy.test.ts` checks the built bundle for the APIs the security model rules out, and
  `test/consistency.test.ts` the facts that several files state. When a fact moves, change its
  check with it. `eslint.config.mjs` and `.prettierrc.json` configure the lint and format checks.
  [TESTING.md](./TESTING.md) maps the promises to their tests; keep it current.
- `test/e2e/` runs the built plugin in Obsidian: `wdio.conf.mts` copies `main.js`, `manifest.json`,
  and `styles.css` into `dist/e2e-plugin/` and installs it into a copy of `vaults/pages/`;
  `support/viewer.ts` drives the view; `specs/` holds the suites. Measure loading, origins, and link
  behavior there, never only in jsdom. Keep the fixture vaults synthetic.
- `test/e2e/corpus/` is the archive corpus that CONTRIBUTING.md describes, and
  `test/e2e/prototype/` the frozen prototype build it is compared with; `wdio.conf.mts` runs the
  corpus spec once per Obsidian version with the plugin and once with the prototype. Model new
  corpus pages on the owner's cache format, never on its content.
- The view type, CSS classes, and command ids stay upstream's; only the manifest's id, name, author,
  and description identify the fork.
