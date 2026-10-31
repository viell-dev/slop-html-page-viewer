# Releasing

The fork is published as GitHub releases, which users install by hand as the
[README](README.md#install) describes; it is not in Obsidian's community plugin directory. Each
release holds `viell-html-page-viewer-<version>.zip`, the plugin's three files, and `SHA256SUMS`.
The Release workflow (`.github/workflows/release.yml`) publishes them, running the steps of
`scripts/release.ts`, which also run locally with the Node.js version in `.nvmrc`.

Three rules hold throughout, and the repository enforces them:

- **Version tags never move.** A ruleset forbids updating or deleting them.
- **A published release's files never change.** Releases published since 2026-10-21 are
  immutable: GitHub refuses changes to their files and tag, while their title and notes stay
  editable. Earlier releases are not immutable, but the same rule applies to them.
- **A version is used once.** A release that went wrong is followed by a new version, never
  replaced.

## Human release testing

A person must install and use a representative candidate before the first
stable release, including a stable release below 1.0, and before stable delivery
of substantial changes to the interface, interaction, or main user workflow.
Working functions, automated UI checks, agent review, and CI cannot establish
that the product is understandable and usable. Human testing complements all
required automated checks; it does not replace them.

For a routine fix, the release PR may reuse recorded human evidence while the
tested workflow remains representative. Link the report and explain what changed
since the tested build and why no further human pass is needed. Genuine earlier
use can supply evidence with its build, scope, feedback, and limits recorded;
silence, downloads, and a partial test are not blanket acceptance.

1. Prepare a brief practical test of the main user journey, including
   installation, discoverability, ordinary tasks, feedback, and recovery.
   Complete agent verification first. Supply a directly downloadable installable
   build, installation instructions, synthetic inputs, numbered tasks and
   expected outcomes. Ask what felt unclear or awkward as well as what failed,
   and request the build, environment, tested tasks, and remaining untested areas.
   Do not ask a person to build from source or reconstruct a development thread.
2. Create or reuse a dedicated issue before requesting the test. Use
   `Type: Maintenance` and `Needs: Human`, or `Needs: Owner` when only the owner
   can supply the answer; never both Needs labels. Assign the person being asked,
   including the owner when asking them under `Needs: Human`. If no tester is
   identified, assign the owner to arrange one. State the stable release it
   blocks, use `Status: Blocked` on the waiting release work, and link the
   request from the release tracker and preparation PR.
3. A prerelease can supply the test build after its required automated checks.
   Create the request before publishing it; add and verify the actual download
   links before handoff, and link the request in the release notes. A dry-run
   artifact is also usable if the recipient can download and install it.
   Before ending the thread, verify the live issue's assignee and labels and
   link it prominently with the pending action and release impact. Publishing a
   candidate or merging preparation does not finish the human request; do not
   close it through a PR closing keyword.
4. Record the person's actual observations separately from the agent's
   assessment. Retain useful partial results, request only missing coverage, and
   retest material fixes in affected workflows. Track and triage reported defects.
   Assess open defects against ordinary use, safety, accessibility, and advertised
   scope: a known-issues entry, enhancement label, or upstream cause does not by
   itself make one acceptable. Fix release blockers. An owner-identified blocker
   remains blocking until fixed or the owner explicitly changes its scope;
   agents cannot silently defer it past stable.
5. Before stable publication, the release PR links the completed human report,
   relevant defect dispositions, candidate-to-final changes, and remaining limits.
   Missing required coverage or unresolved blockers stop publication even with
   green CI. Keep the request open until its answer and resulting work are
   handled, or explicitly supersede it with a linked replacement. Check pending
   requests when maintenance resumes; an issue reply alone does not restart an
   agent unless monitoring is configured.

Agents continue to own implementation, verification, review, packaging,
publication, and follow-up. This gate requires a proportionate human usability
pass, not human code review or repeated approval for every routine release.

For this Linux desktop fork, cover installing in a synthetic Obsidian vault,
opening an HTML page and its local assets, understanding the view controls, and
following links. Keep the owner's real vault outside agent-controlled tests.

## Prepare the release

Check [open issues](https://github.com/viell-dev/slop-html-page-viewer/issues) for release blockers
and pending human requests before preparing a version. The minimum-host local-file visibility
failure in [#83](https://github.com/viell-dev/slop-html-page-viewer/issues/83) blocks the next
software release until its cause and fix are verified. A later passing run alone does not resolve
it; retain its failure evidence and follow the issue's required diagnosis.

1. Choose the version by semantic versioning: a minor version for new features, a patch for
   fixes. A version with a prerelease part, such as `0.6.0-rc.1`, becomes a prerelease.
2. In a pull request from a branch of `main`, labelled `Target: Fork`:
   - Set the version with `npm version <version> --no-git-tag-version`, which changes
     `package.json` and its lockfile, and in `manifest.json`.
   - Add `"<version>": "<minAppVersion>"` to `versions.json`.
   - Add `.github/release-notes/<version>.md`, written for someone installing the plugin. Like the
     earlier notes, it names the zip, gives the installation steps and how to go back, says what
     is new and fixed, and lists the known limits and how the release was tested.
   - Move the **Unreleased** entries of `CHANGELOG.md` under
     `## [<version>](.github/release-notes/<version>.md) - <date>`.
3. `npm test` checks that these files agree, and `node scripts/release.ts check <version>` checks
   the version as the workflow will.
4. The pull request gets an in-depth independent review of everything since the previous release,
   as [AGENTS.md](AGENTS.md#review) describes, and passes CI.
5. Merge it, and wait for CI to pass on the merge commit on `main`. The workflow refuses a commit
   whose required checks have not all passed: `verify (ubuntu-latest)`, `verify (windows-latest)`,
   and `e2e`, the tests in Obsidian.

## Try it first

A dry run does everything except publish, with a token that cannot write:

```sh
gh workflow run release.yml -f version=<version> -f dry_run=true
```

It checks the version and the commit's CI, runs the unit tests, builds and packages the plugin,
keeps the assets as the run's `release-<version>` artifact, and lists the changes that publishing
would make. Add `--ref <branch>` to try another branch. Locally, with a build of the commit:

```sh
npm run build
node scripts/release.ts package <version>
node scripts/release.ts publish <version> --sha "$(git rev-parse HEAD)" --dry-run
```

The local dry run reads GitHub anonymously, or with `GH_TOKEN`; it never writes.

## Publish

```sh
gh workflow run release.yml -f version=<version>
```

Run it on `main`. The `prepare` job does what the dry run does. The `publish` job then:

1. takes the assets that `prepare` built, never a new build;
2. tags the commit with the version, or checks that an existing tag points to it;
3. creates a draft release with the version's notes, and uploads the zip, the three files, and
   `SHA256SUMS`, last;
4. checks each uploaded file against GitHub's checksum of it;
5. publishes the release, as the latest release only if no published full release is newer;
6. downloads every file as a user does, without a token, and checks them against `SHA256SUMS`, the
   zip against the loose files, the manifest's version, the tag's commit, and the files that
   `prepare` built.

Afterwards, `npm run check:github` confirms that the release's text matches its notes file.

## When a step fails

Rerunning the workflow for the same version and commit is always safe, with **Re-run failed jobs**
or a new run. It resumes where the previous run stopped, and refuses to change anything already
published. Once the tag exists, resume from the tag, which runs the workflow on the tagged commit
even after `main` has moved:

```sh
gh workflow run release.yml --ref <version> -f version=<version>
```

| What failed                                                                                  | What it left                             | What to do                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Check the version**                                                                        | Nothing                                  | Fix the version files, notes, or changelog in a pull request, and run it again.                                                                                                                                                                                                                                                                     |
| **Check the commit's CI**                                                                    | Nothing                                  | Wait for CI on the commit to finish, or fix what fails. Never release a commit around its CI.                                                                                                                                                                                                                                                       |
| The tests, the build, or packaging                                                           | Nothing                                  | Fix the cause in a pull request.                                                                                                                                                                                                                                                                                                                    |
| **Plan**: the tag points to another commit                                                   | Nothing new                              | If this run resumes a stopped release from a moved `main`, resume it from the tag instead. Otherwise, the version was claimed for another commit: release this one under the next version.                                                                                                                                                          |
| **Plan** or **Publish**: the release is published and differs                                | Nothing new                              | The published release stays as it is. Release under the next version.                                                                                                                                                                                                                                                                               |
| **Publish**, before publishing: a lost connection, a cancelled run                           | The tag, perhaps a draft with some files | Resume from the tag. The draft's files are kept if they are exactly this build's, and the rest are uploaded.                                                                                                                                                                                                                                        |
| **Publish**: the draft holds a file that is not this build's, or whose upload did not finish | The tag and a draft                      | The draft was never published. If the build differs, find out why. Delete the draft (`gh release delete <version> --yes`, which keeps the tag), and resume from the tag.                                                                                                                                                                            |
| **Verify the published release**                                                             | A published release                      | Run `node scripts/release.ts verify-published <version> --sha <commit>` again: a download that failed may pass. If a file is wrong, say so in the release's notes, and release a fixed version. If only the latest-release mark is wrong, `gh release edit <version> --latest` on the release that should have it fixes it; no file or tag changes. |
| Wrong text in published notes                                                                | A published release                      | Fix `.github/release-notes/<version>.md` in a pull request, then run `gh release edit <version> --notes-file .github/release-notes/<version>.md` from `main`. No file or tag changes.                                                                                                                                                               |

`test/release.test.ts` runs these steps against a stand-in for GitHub. It stops a run after each of
its changes, reruns it, and checks every refusal. The dry run takes the same steps against
GitHub's real state. `node scripts/release.ts verify-published <version>` checks any published
release at any time.
