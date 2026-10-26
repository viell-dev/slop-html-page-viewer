Describe the problem and resulting behavior for a reader who has not seen the code: the repository
owner reads pull request descriptions to judge direction without reading the diff. State the design
decisions the change makes and why, rather than leaving them as questions. Link the issue.

Say whether the change is upstream-bound (`Target: Upstream`, based on upstream's `main`) or
fork-only (`Target: Fork`), as `CONTRIBUTING.md` describes. Confirm that the security model is
unchanged, or that the README and `SECURITY.md` describe the change.

## Verification

For a release or substantial UI/workflow change, assess the human-testing gate
in RELEASING.md. Link the assigned test request and pending stable-release
blockers, or the completed human report and why it still covers this candidate.
State what changed since the tested build and how relevant open defects were
resolved or accepted. Candidate publication and this PR's merge must not close
an unanswered human request; link it in the handoff as well.

The commands run, on which platforms, with their results; what was checked in Obsidian; and what
remains unverified. Whether the change had an independent review, of which commit, and why or why
not.

If an agent wrote this pull request, say so at its start, as `CONTRIBUTING.md` describes.
