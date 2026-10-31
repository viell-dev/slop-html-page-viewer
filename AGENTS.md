# Agent maintenance

This file holds what agents maintaining this repository need beyond its other documents. The
[README](./README.md#status) states how the fork is maintained, and
[CONTRIBUTING.md](./CONTRIBUTING.md) holds the setup, checks, branch model, and pull request rules;
follow them and do not repeat them here.

## Repository boundary

Everything the project needs lives in this repository. Never stage, copy, quote, or publish content
from outside it. Use synthetic fixtures, never real vault documents, in tests, issues, and pull
requests, and keep private documents out of screenshots and logs. The owner's vault is private: turn
observations from it into synthetic fixtures. Never change the owner's vault; the owner installs
releases there.

Linux desktop is the supported target. Windows is a development host and supplies extra build and
unit-test coverage, plus Linux Obsidian in Docker. Windows Obsidian, macOS, and mobile are outside
the fork's support scope; reconsider broader support if the owner chooses wider distribution. Keep
verification focused on practical risks rather than an exhaustive search for obscure edge cases.

## Upstream

Upstream is
[viggomeesters/obsidian-html-page-viewer](https://github.com/viggomeesters/obsidian-html-page-viewer).
Track its defects, offered changes, and maintainer responses through
[Dependency defects](#dependency-defects).

- Within their assigned work, agents may report upstream defects and offer upstream-bound fixes,
  following upstream's current contribution guidance and templates. Each submission opens with an
  attribution callout that names the agent and says whether the owner reviewed it.
- Upstream accepts agent-written contributions; [#2](https://github.com/viell-dev/slop-html-page-viewer/issues/2)
  holds the evidence and current collaboration state. Keep submissions useful and proportionate.
  Offer a branch that builds on another only once upstream has merged that one, so that each pull
  request shows only its own change. Honor any later request to stop or to decline a kind of
  contribution, and record it in #2.
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
- `prototype` is the previous fork's build and the archive corpus's comparison baseline. It is
  frozen by a ruleset: read it as a reference, and never try to update it.
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

Agents may publish ready routine releases through [RELEASING.md](./RELEASING.md), including its
human-testing gate, blocker checks, and recovery procedure. Record the workflow run and its
`verify-published` result in the release pull request. Listing the fork in Obsidian's community
plugin directory needs the owner's decision.

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
  `Needs: Human` instead. Assign the person being asked under either label, including the owner
  when asking them to test. State exactly what is needed and why human input is required, the
  recommendation, the result to expect, and what waits for it. A request to try something names
  the build, gives synthetic inputs, numbered steps, and the expected results, and says what to
  report. Label the work that waits for the answer `Status: Blocked`, and link the two. Run the
  mechanical checks as an agent, while retaining required human usability testing. Verify the live
  assignee and labels and link the request before ending the thread; candidate publication and
  preparation merges do not complete it. Keep it open until the answer and resulting work are
  handled, and check pending requests when maintenance resumes.
- Preserve multiline issue and pull request bodies when editing them: save the exact body to a
  UTF-8 file and send it with `gh api -X PATCH … -F body=@file`. Do not flatten captured PowerShell
  output into a space-joined string. Read the result back to verify formatting.

## Dependency defects

Use pinned [#2](https://github.com/viell-dev/slop-html-page-viewer/issues/2) as the one overview of
upstream and dependency defects, offered changes, and maintainer responses.
Each entry links its dedicated issue, if it has one, and any upstream report or fix. Record the
affected versions, impact, evidence, local handling, and what would unblock or reopen it, with one
of four states:

1. **Blocked upstream:** no local remedy; the affected behavior waits for upstream. State the limit
   that users or maintainers meet and any effect on releases.
2. **Worked around:** upstream is still defective, but a verified local fix or workaround handles
   it. State its limits, and when it can be removed.
3. **Resolved upstream:** an upstream fix is verified, in a release or an unreleased commit. Track
   adopting it and removing the workaround until the fork's own result is verified.
4. **Upstream route unavailable:** upstream is unresponsive, declines, or prohibits the
   contribution, as its policy or a dated interaction shows. Record the local remedy chosen.

During maintenance and before affected releases, check upstream's `main` and other relevant
branches, responses to open submissions, and dependency versions; log the results in #2. If the
upstream route becomes unavailable, record the evidence and decide there whether the upstream-bound
branch rule still serves the fork. A dedicated issue with no local work left may be closed as not
planned, keeping `Status: Blocked`, while #2 records the condition for reopening it.

## Repository settings

`.github/settings.json`, `.github/rulesets/`, and `.github/labels.json` are the checked-in records
of GitHub configuration. Keep them and GitHub in sync; run `npm run check:github` after a change
and during maintenance. The check needs the GitHub CLI signed in as a repository administrator,
so it runs outside CI.

Required checks bind to workflow job names and the GitHub Actions app identity; renaming a job
requires a matching ruleset update. The tests in Obsidian remain required because they test the
real host. Zero required approvals is deliberate for a single-account, agent-maintained
repository; pull requests, passing checks, and resolved review threads remain mandatory.
Record material settings decisions and their rationale in the owning issue or pull request.

## Technical map

- `src/main.ts`: plugin, view lifecycle, toolbar, source highlighting, and sandbox selection.
- `src/document.ts`: the rendered copy, resource paths, stylesheets, and optional local-file copying.
- `src/reading.ts`, `src/links.ts`, `src/find.ts`, and `src/split.ts`: reading style, navigation,
  search, and synchronized scrolling.
- `src/settings.ts` and `src/extensions.ts`: saved settings, controls, and extension registration.
- `test/support/`: jsdom and Obsidian stand-ins for unit tests. Keep their behavior aligned with the
  real host; they cannot establish host behavior themselves.
- `test/e2e/`: real Obsidian suites and synthetic vaults. The archive corpus compares the plugin
  with the frozen build in `test/e2e/prototype/`.

[TESTING.md](./TESTING.md) owns the coverage and limits; keep it current when promises or checks
change. [CONTRIBUTING.md](./CONTRIBUTING.md#checks) explains the test commands and fixtures.

### Constraints that need host verification

- Preserve the [security model](./SECURITY.md#security-model). Render a prepared copy through
  `srcdoc`; never combine scripts with same-origin access. Resource rewriting changes only that
  copy: the source view must retain the original text, without generated `data:` URLs.
- Obsidian's origin is needed to load vault files, and its inherited policy permits only inline
  styles apart from Google Fonts. Linked vault stylesheets therefore become inline styles.
  Read only `.css` files as stylesheets: scripts can read everything copied into the page.
- With scripts on, the frame has an opaque origin. In Obsidian it loads copied `data:` URLs but
  cannot load `blob:` URLs created by the host window. Keep the allowed file types and per-file
  and per-page copy limits enforced. Recheck origin and resource behavior in Obsidian when the
  host changes; [#7](https://github.com/viell-dev/slop-html-page-viewer/issues/7) and
  [#11](https://github.com/viell-dev/slop-html-page-viewer/issues/11) hold the measurements.
- Host-installed link listeners work with scripts off. Finding in the page and synchronizing its
  scroll require access to its document; scripts on removes that access. Scroll synchronization
  covers pages that scroll as a whole, not independently scrolling regions.
- Extension registration uses Obsidian's undeclared view registry. Never take another view's
  extension, and release only extensions still owned by this viewer. Without the registry,
  fall back to registering once through the public API.
- Settings search is available from Obsidian 1.13; keep the legacy settings-tab fallback. Newer
  Obsidian opens settings in a separate window, so host tests reach the tab through
  `app.setting.activeTab`, not the main window's document. Wait for settings saves before testing
  their effect on vault files.
- View types, CSS classes, and command ids retain upstream's identity; the manifest identifies
  the fork separately so an upstream release cannot replace it.
