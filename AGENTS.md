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
Pinned issue #2 is the overview of upstream defects, the changes offered upstream, and every check
for a maintainer's response; keep it current.

- Each upstream pull request needs the owner's decision. Its description follows upstream's template
  and `CONTRIBUTING.md` and opens with an attribution callout.
- Upstream has not established that it accepts agent-written contributions. The first pull request,
  viggomeesters/obsidian-html-page-viewer#1, stays the only one until a maintainer responds to it.
- Check it while working on the fork and log each check in #2. If nobody responds by 2026-12-19, the
  owner's decision is to stop offering changes and to develop without regard to upstream: record
  that in #2 and propose to the owner dropping the upstream-bound branch rule below.
- Upstream-bound branches have no `AGENTS.md`. Read this file on `main` when working on one.
- Sync upstream's `main` through a pull request: push `upstream/main` to a branch named
  `upstream-sync-<date>` and open a pull request into `main`. If it conflicts, create that branch
  from `main` instead, merge `upstream/main` into it, and resolve the conflicts there. Upstream's
  releases change `main.js`, which this fork deleted; resolve that conflict by keeping it deleted.

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
- Review bots on the owner's account, Sourcery and CodeRabbit, may comment on pull requests. Treat
  their threads as review: check each claim, fix what holds or answer why not, and resolve the
  thread; the ruleset requires resolved threads. Check that a merge succeeded before deleting its
  branch.
- GitHub does not delete merged branches. Keep an upstream-bound branch until upstream merges or
  declines it, or until #2 records that upstream is no longer followed; delete other branches after
  merging.
- `prototype` is the previous fork's build, which the owner's vault uses until #12 replaces it. It
  is frozen by a ruleset: read it as a reference for redoing its work, and never try to update it.
- Never commit `main.js`. The fork has no tags or releases. Change the manifest's version only in a
  fork-only commit that prepares a deployment.

## Issues and labels

Take each assigned issue through validation (reproduce or measure on current `main`), a decision
with its reasoning and rejected alternatives, and a fix; the issue, not the session, is the record.
Labels follow [`.github/labels.json`](./.github/labels.json); keep GitHub in sync with it.

- Every item has one `Type:` label and at most one `Status:` label. `Status: Confirmed` means a
  reproduced defect or an accepted request; remove it when the item closes.
- `Target: Upstream` or `Target: Fork` says where the change can go. An upstream-bound defect found
  in upstream's code is also listed in #2.
- The fixing pull request names its issue with a closing keyword and carries the same labels.

## Settings

`.github/rulesets/` records the rulesets for `main` and `prototype`; keep it and GitHub's settings
in sync. The required checks bind to the `verify (ubuntu-latest)` and `verify (windows-latest)` job
names and the `e2e` job in `ci.yml`, and to GitHub Actions, app 15368, so renaming a job needs a
ruleset update. The tests in Obsidian are required because they are the only test of what users see.
Zero required approvals is deliberate for a single-account, agent-maintained repository; pull
requests, passing checks, and resolved review threads remain mandatory.

Other repository settings, each recorded here with its reason when it changes:

- GitHub Actions may run only actions that GitHub owns, pinned by full commit SHA, with read-only
  default permissions.
- Dependabot alerts and security updates, secret scanning with push protection, and private
  vulnerability reporting are on. Dependabot's version updates follow `.github/dependabot.yml`.
- Issues are on; wiki, projects, and discussions are off.
- #2, the upstream overview, is pinned.

Maintainers enforce the [code of conduct](./CODE_OF_CONDUCT.md).

## Technical map

- `src/main.ts` holds the plugin class, which registers the view for `.html` and `.htm`;
  `HtmlPageViewerView`, a `TextFileView` that renders the toolbar and either the sandboxed frame or
  the source view; `sandboxValue`, the one place that computes the frame's sandbox; and the per-line
  source highlighter.
- `src/document.ts` prepares the copy of the page that the frame shows through `srcdoc`: a `<base>`
  at the file's resource URL, a Content Security Policy that keeps Obsidian's file URLs inside the
  vault, and each linked vault stylesheet copied into a `<style>` with its references made absolute.
  A reference whose vault path does not exist is pointed at the file that Obsidian's link resolution
  (`getFirstLinkpathDest`) finds for it (`locatedUrl`); clicked links fall back the same way in
  `openVaultPath`. References that resolve stay as written.
  The measurements behind this design are in #7: in Obsidian, only a `srcdoc` frame with Obsidian's
  origin (`allow-same-origin`) loads vault files, and such a frame inherits Obsidian's policy, which
  allows only inline styles. Recheck them with the end-to-end suite when Obsidian changes.
- `src/reading.ts` builds the reading style from Obsidian's theme variables, for pages without a
  `<style>` or a stylesheet link. `preparePage` adds it to the copy; on Obsidian's `css-change`
  event the view replaces its text in place when it can reach the page (scripts off), and prepares
  the page again otherwise. Theme values are stripped of characters that could end a declaration.
- `src/links.ts` classifies a link's resolved URL and follows clicks in the page: the view calls
  `watchLinks` on each load of a page it can reach, and its capturing `click` and `auxclick`
  listeners run although the page's scripts are disabled (measured in #9). External links go to
  `window.open`, vault files to `openVaultPath` in `src/main.ts`.- `esbuild.config.mjs` bundles
  `src/main.ts` into `main.js`, minified when its first argument is `production`. `styles.css` is
  the plugin's stylesheet; `test-fixtures/` holds HTML files for manual and automated tests.
- `scripts/test.mjs` bundles each `test/*.test.ts` into `dist/test/` and runs it with Node.js's test
  runner. `test/support/dom.ts` installs a jsdom window and Obsidian's element helpers as globals,
  `test/support/obsidian.ts` stands in for the `obsidian` module and records what the plugin asks of
  it, and `test/support/harness.ts` loads the plugin and opens views as Obsidian does. Extend the
  stand-in when the plugin uses more of Obsidian's API, keeping it as Obsidian behaves.
  `test/policy.test.ts` checks the built bundle for the APIs the security model rules out.
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
- Deploy only for an approved test request (#12): build, then copy `main.js`, `manifest.json`, and
  `styles.css` into the vault's `.obsidian/plugins/viell-html-page-viewer/`. The owner's vault has
  its own rules; follow them.
