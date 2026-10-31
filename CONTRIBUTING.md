# Contributing

Issues and pull requests from people and from agents are welcome. This is a personal fork,
maintained by AI agents as the [README](README.md#status) says, and it serves its owner's use first.
A change to HTML Page Viewer that its other users would want may belong
[upstream](https://github.com/viggomeesters/obsidian-html-page-viewer) as well. The owner follows
the fork through issue and pull request descriptions rather than code, so write them for a reader
who has not seen the code. Agents maintaining the repository also follow [AGENTS.md](AGENTS.md),
and publish releases as [RELEASING.md](RELEASING.md) describes. Everyone follows the
[code of conduct](CODE_OF_CONDUCT.md).

If an agent wrote your issue or pull request, open it with a short note, such as a `> [!NOTE]`
callout, that says so, names the model and the tool that ran it, and says whether you reviewed it.
The maintaining agents mark their own posts the same way.

## Report a defect

Search the open and closed [issues](https://github.com/viell-dev/slop-html-page-viewer/issues)
first, then open one with the bug form's details:

- the commit you built, the Obsidian version, and the operating system;
- a minimal HTML file that shows the problem, synthetic or public, with any files it refers to;
- the view (rendered, source, or split) and whether scripts were on;
- what happened, and what you expected.

Remove private content from every example. Agents should open an issue only when their operator has
authorized publishing it. Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes.

## Set up

Development needs npm and the Node.js version in `.nvmrc`; in the checkout, `nvm use`
or `fnm use` selects it. CI and the release workflow read the same file. The end-to-end Docker image
names the version in its `FROM` line, so change the two together.

```sh
git clone https://github.com/viell-dev/slop-html-page-viewer.git
cd slop-html-page-viewer
npm ci
npm run build
```

`npm run build` writes a minified `main.js`; `npm run dev` writes an unminified one with an inline
source map. Neither is tracked. To try a build, copy `main.js`, `manifest.json`, and `styles.css`
into `.obsidian/plugins/viell-html-page-viewer/` in a test vault, reload Obsidian, and enable the
plugin. Use a vault made for testing, with synthetic pages.

## Checks

```sh
npx tsc --noEmit
npm run lint
npm run format:check
npm run build
npm test
```

`npm run lint` runs ESLint with `typescript-eslint`'s type-checked rules and the rules of Obsidian's
plugin review. A rule that is wrong for one line is disabled on that line, with its reason after
`--`. `npm run format` formats the code with Prettier; the fixture pages and the prototype build are
left as they are.

`npm test` bundles each `test/*.test.ts` file with esbuild and runs the bundles with Node.js's test
runner. The tests run the plugin in a jsdom window, with a stand-in for the parts of Obsidian's API
that it uses (`test/support/obsidian.ts`), and check what the view shows. A test marked `todo`
reproduces a known defect and names its issue; remove the marker with the fix. No test is skipped
or focused with `.skip` or `.only`. `test/consistency.test.ts` checks that the versions, changelog,
release notes, the README's settings, labels, CI jobs, end-to-end suites, and documents' links
agree.

[TESTING.md](TESTING.md) maps each promise of the README to the tests behind it and lists what no
test covers. Update it with a change that adds a promise or changes its tests.

### Tests in Obsidian

Whether pages load and behave correctly depends on Obsidian itself, so `test/e2e/` runs the built
plugin in real Obsidian with WebdriverIO and `wdio-obsidian-service`, against the synthetic vault in
`test/e2e/vaults/pages/`. The tools have their own package, `test/e2e/package.json`, because their
dependencies carry advisories that should not hide the root package's
([#21](https://github.com/viell-dev/slop-html-page-viewer/issues/21)).

With Docker, on any system, Windows included:

```sh
npm run build
npm run test:e2e:docker
```

On Linux with Obsidian's system libraries, Xvfb, and herbstluftwm installed, `npm ci --prefix
test/e2e` and then `npm run test:e2e` run the suite directly. Arguments after `--` go to `wdio run`,
such as `--spec specs/viewer.e2e.ts`. Screenshots and logs go to `test-results/e2e/`, and downloaded
Obsidian versions to `.obsidian-cache/` or, with Docker, the `html-page-viewer-obsidian-cache`
volume.

The suite runs Obsidian 1.5.3, the oldest public release that the manifest's `minAppVersion` allows,
and the latest public release. Set `OBSIDIAN_VERSIONS` to `appVersion/installerVersion` pairs to
test others, and `E2E_ONLY` to spec file names, such as `links.e2e.ts`, to run only those.
Obsidian is downloaded, never stored in the repository or the image, because its terms do not allow
redistributing it. It serves files whose paths are not ASCII only under a UTF-8 locale, which
`session.sh` sets, together with a window manager layout that keeps every Obsidian window at full
size, so that one test worker's window never reflows another's pages.

### The archive corpus

The plugin's main use is a vault that caches web pages as archival semantic HTML, so the suite also
opens every page of a synthetic vault in that layout. `test/e2e/corpus/vault/` holds hand-written
pages, each with a README, dated HTML representations, and dated asset directories, in the format
such a cache uses. `test/e2e/corpus/generate.mjs` copies them into `dist/e2e-vaults/archive/`, adds
generated parts at the sizes such a vault reaches, and writes every asset the pages refer to, so
that the repository holds no binaries. The corpus covers:

- names with accents, ampersands, apostrophes, commas, dashes, and parentheses;
- tables with merged cells and header groups, note groups, figures, many languages and writing
  systems, and downloads;
- an asset that is missing on purpose, and assets that only Obsidian's link resolution finds;
- a 600 KB page with 500 images;
- a mirrored fan site with stylesheets, an import, a font, scripts, query strings, and folder
  links.

`specs/corpus.e2e.ts` checks each page against the files on disk:

- every image that resolves, by path or by name, loads, and a missing one does not;
- stylesheets and imports apply, and the font loads;
- scripts never run;
- the reading style appears exactly on pages without styles.

The same spec also runs with the frozen prototype build in `test/e2e/prototype/`, byte-identical to
the one the owner's vault used before this fork, with its settings. `corpus/compare.mjs` fails if
the prototype showed an image the plugin does not. To add a case, add a page in the cache's format
to `corpus/vault/`, and to `UNAVAILABLE` or `ELSEWHERE` in `generate.mjs` when its assets are meant
to be missing or stored elsewhere.

### CI

GitHub Actions runs the type check, build, and tests on Linux and Windows with the Node.js version
in `.nvmrc`, and the lint and format checks and an `npm audit` on Linux; `main` requires both
platforms. The `e2e` job runs the tests in Obsidian on Linux for every pull request, and weekly, so
that a new Obsidian release is tested within a week. The Docker image is built and run weekly and
on request.

## Branches

The fork keeps every change that could serve upstream separate, so that it can be offered upstream
exactly as it was merged here:

- **Upstream-bound** changes, labelled `Target: Upstream`, start from upstream's `main`, or from the
  upstream-bound branch they build on. They contain nothing specific to the fork: not its documents,
  `.github/` files, plugin id, or versions, and never `main.js`.
- **Fork-only** changes, labelled `Target: Fork`, start from this repository's `main`.

To base a branch on upstream, add it as a remote:

```sh
git remote add upstream https://github.com/viggomeesters/obsidian-html-page-viewer.git
git fetch upstream
git switch -c my-change upstream/main
```

Never merge `main` into an upstream-bound branch; that would add the fork's files to it.

## Pull requests

Every change to `main` goes through a pull request with passing CI and is merged with a merge
commit, which keeps upstream-bound commits identical to the ones offered upstream. Contributions are
made under the MIT license. Keep discussion respectful and about reproducible behavior.

- Describe the problem, the resulting behavior, and the decisions made and why, for a reader who
  will not read the diff. Link the issue, and say whether the change is upstream-bound.
- Keep upstream's security rules: the plugin stays read-only, scripts stay off by default, and it
  adds no network or clipboard access. Scripts and same-origin access are never granted to a page
  together. Document any change to the sandbox in the README and [SECURITY.md](SECURITY.md).
- State how you verified the change, on which platforms, what you checked in Obsidian, and what
  remains unverified.
- Update every document, fixture, and test that describes what you changed, in the same pull
  request. Add a line to the **Unreleased** section of [CHANGELOG.md](CHANGELOG.md) for a change
  that users would notice.
- Keep changes scoped, and state remaining limits.

## Maintaining documentation

The README owns the user journey and supported behavior; `SECURITY.md` owns the security model,
`TESTING.md` the coverage and limits, and `RELEASING.md` the release and recovery procedure.
`AGENTS.md` adds durable maintenance instructions and non-obvious safeguards. Link to the owning
document rather than repeating its procedure elsewhere. Public procedures must stand alone.

Keep guidance accurate when behavior or policy changes. Issues and pull requests own decisions,
investigations, progress, and verification receipts; do not append their history to agent
instructions. Read configuration from its checked-in source and release state from tags and
releases. Preserve changelogs, version-specific release notes, compatibility and upgrade guidance,
active restrictions, and unresolved work.
