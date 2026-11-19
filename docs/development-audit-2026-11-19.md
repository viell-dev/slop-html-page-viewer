# Development dependency assessment — 19 November 2026

> Historical assessment: superseded by [the follow-up](development-audit-2026-11-19-followup.md).


Issue #16 assesses development tooling for HTML Page Viewer 0.1.6. Obsidian SDK is updated to 1.14.4 and typescript-eslint to 8.73.0. This removes the vulnerable Moment transitive and updates the TypeScript ESLint minimatch path without forcing an incompatible override or downgrading the official linter.

On Linux with Node 24.21.0 and npm 11.19.0, npm ci, all 56 tests, build, official lint, TypeScript and production audit passed. The production bundle remains byte-identical to published 0.1.6: SHA-256 `036348d99049ed86bcee81d89dc4fba8d4e1bdcbca7c6a38adf55e0300f48f89`. No new runtime or platform compatibility claim follows from tooling checks.

The complete development audit decreases from 12 moderate dependency nodes across two advisories to four nodes across one advisory; production audit remains zero. The remaining path is eslint-plugin-obsidianmd 0.6.0 → @microsoft/eslint-plugin-sdl 1.1.0 → eslint-plugin-n 17.10.3 → minimatch 9.0.9, affected by GHSA-g3hv-75wg-m249. Four affected nodes are not four independent vulnerabilities. The advisory concerns glob amplification at optimizationLevel >= 2; the previously inspected lint path uses the default level 1. This bounds the development exposure, not a universal immunity or a clean development audit. Recheck upstream supported tooling; do not apply npm's suggested obsolete linter downgrade or a forced cross-major override.

The additional @isaacs/nonrecursive-glob-match dependency is development-only (BlueOak-1.0.0) and is absent from the built plugin. The runtime and published assets are unchanged; no additional plugin release is warranted solely for this tooling repair.

Sources: https://github.com/advisories/GHSA-g3hv-75wg-m249 and https://github.com/advisories/GHSA-4p3w-j4w9-5jqw.
