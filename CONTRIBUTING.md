# Contributing

Issues and pull requests from people and from agents are welcome. This is a personal fork,
maintained by AI agents as the [README](README.md#status) says, and it serves its owner's use first.
A change to HTML Page Viewer that its other users would want may belong
[upstream](https://github.com/viggomeesters/obsidian-html-page-viewer) as well. The owner follows
the fork through issue and pull request descriptions rather than code, so write them for a reader
who has not seen the code. Agents maintaining the repository also follow [AGENTS.md](AGENTS.md).
Everyone follows the [code of conduct](CODE_OF_CONDUCT.md).

If an agent wrote your issue or pull request, open it with a short note, such as a `> [!NOTE]`
callout, that says so, names the model and the tool that ran it, and says whether you reviewed it.
The maintaining agents mark their own posts the same way.

## Report a defect

Search the open and closed [issues](https://github.com/viell-dev/slop-html-page-viewer/issues)
first, then open one with the bug form's details:

- the commit you built, the Obsidian version, the operating system, and whether it is desktop or
  mobile;
- a minimal HTML file that shows the problem, synthetic or public, with any files it refers to;
- the view (rendered or source) and whether scripts were on;
- what happened, and what you expected.

Remove private content from every example. Agents should open an issue only when their operator has
authorized publishing it. Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes.

## Set up

Development needs Node.js 24 and npm.

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
npm run build
npm test
```

`npm test` bundles each `test/*.test.ts` file with esbuild and runs the bundles with Node.js's test
runner. The tests run the plugin in a jsdom window, with a stand-in for the parts of Obsidian's API
that it uses (`test/support/obsidian.ts`), and check what the view shows. A test marked `todo`
reproduces a known defect and names its issue; remove the marker with the fix.

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
test others. Obsidian is downloaded, never stored in the repository or the image, because its terms
do not allow redistributing it.

### CI

GitHub Actions runs the type check, build, and tests on Linux and Windows with Node.js 24, and an
`npm audit` on Linux; `main` requires both platforms. The `e2e` job runs the tests in Obsidian on
Linux for every pull request, and weekly, so that a new Obsidian release is tested within a week.
The Docker image is built and run weekly and on request.

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
- State how you verified the change, on which platforms, and what you checked in Obsidian.
- Update every document, fixture, and test that describes what you changed, in the same pull
  request.
- Keep changes scoped, and state remaining limits.
