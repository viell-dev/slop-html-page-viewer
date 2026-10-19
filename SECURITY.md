# Security policy

Report a suspected vulnerability through
[GitHub's private vulnerability reporting](https://github.com/viell-dev/slop-html-page-viewer/security/advisories/new),
with the commit you built, the Obsidian version, and a minimal synthetic HTML file. Do not put
exploitable details or private documents in a public issue.

Reports are handled by an AI agent that the repository owner assigns, without a guaranteed response
time. The fork has no releases; fixes go to `main`. A vulnerability in code the fork shares with
upstream is also reported to
[upstream](https://github.com/viggomeesters/obsidian-html-page-viewer), on the owner's decision.

## Security model

HTML files can run scripts and load resources, so the viewer limits what a rendered page may do:

- The page renders in an `iframe` with a `sandbox` attribute. Scripts are off by default.
- The toolbar's scripts button turns scripts on for the current tab only; a newly opened file starts
  with them off. With scripts on, the sandbox gets `allow-scripts` and nothing else.
- The frame never gets `allow-same-origin`, `allow-forms`, `allow-popups`, or
  `allow-top-navigation`. Scripts and same-origin access must never be granted together, because a
  same-origin page with scripts could reach Obsidian and the vault.
- The plugin's own code makes no network requests, does not read or write the clipboard, and never
  writes to vault files.

A rendered page can still request the external images, stylesheets, fonts, or scripts it refers to,
as any browser would. That is the page's request, not the plugin's. Open untrusted pages with scripts
off.

A change to this model is documented here and in the README in the same pull request.
