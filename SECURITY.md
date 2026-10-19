# Security policy

Report a suspected vulnerability through [GitHub's private vulnerability
reporting](https://github.com/viell-dev/slop-html-page-viewer/security/advisories/new), with the
commit you built, the Obsidian version, and a minimal synthetic HTML file. Do not put exploitable
details or private documents in a public issue.

Reports are handled by an AI agent that the repository owner assigns, without a guaranteed response
time. The fork has no releases; fixes go to `main`. A vulnerability in code the fork shares with
upstream is also reported to [upstream](https://github.com/viggomeesters/obsidian-html-page-viewer),
on the owner's decision.

## Security model

HTML files can run scripts and load resources, so the viewer limits what a rendered page may do.

- **A copy in a sandboxed frame.** The view parses the file, prepares a copy of it, and shows the
  copy through the `srcdoc` of an `iframe` with a `sandbox` attribute. Parsing runs nothing, and the
  file is never changed.
- **Scripts off, by default.** The sandbox grants only `allow-same-origin`. The page then has
  Obsidian's origin, which a page needs in Obsidian to load the vault's files. Without
  `allow-scripts`, nothing in the page can use that origin: no script runs, including event handler
  attributes and `javascript:` links, and forms, popups, and navigation of Obsidian's window stay
  blocked.
- **Scripts on, by choice.** The toolbar's scripts button turns scripts on for the open page, and
  the **Scripts when a page opens** setting turns them on for every page as it opens. The sandbox
  then grants only `allow-scripts`, so the page runs with an opaque origin and cannot reach Obsidian
  or the vault's files. Each file opened in a tab starts as that setting says: with scripts off,
  unless it is on.
- **Never both.** Scripts and same-origin access are never granted together, because a page with
  both could reach Obsidian, and through it the vault and the computer. `sandboxValue` in
  `src/main.ts` is the one place that computes the sandbox, and tests cover it.
- **Only the vault's files.** The copy carries its own Content Security Policy, which the browser
  enforces together with Obsidian's. Obsidian's file URLs load only from inside the vault, so a page
  cannot show a file elsewhere on the computer by referring to it, and `<object>` content is
  blocked. Obsidian's own policy also applies to the copy: it allows only inline styles and Google
  Fonts stylesheets.
- **Links.** With scripts off, the view follows clicks on the page's links itself, so the frame
  never leaves the copy: web links are handed to Obsidian to open outside it, vault files open in
  Obsidian, and links to other local files are refused. With scripts on, the view cannot reach the
  page, and a link navigates the frame, which keeps its sandbox.
- **What the plugin does.** It reads vault files, the page and the stylesheets the page links, to
  prepare the copy. It never writes to vault files, makes no network requests, and does not read or
  write the clipboard. The one file it writes is its own settings, which Obsidian keeps in the
  plugin's folder.

A rendered page can still request the images, fonts, scripts, or media on the web that it refers to,
as any browser would. That is the page's request, not the plugin's. Open untrusted pages with
scripts off.

A change to this model is documented here and in the README in the same pull request.
