# Obsidian 1.15.1 verification — 16 November 2026

Maintenance patch `0.1.5`. Runtime code is unchanged. The actual desktop host exercised candidate `1d32c76fd2122a1fb6438a9b8856be9ecb85be4a` with exact source, bundle, manifest and CSS hashes. Production main.js SHA-256: `6a962af650f274999eb460609de2ffcd0c301354f62311f1c951487bf0121bba`.

## Exercised behavior

- Checked fixture-specific expected rendered values for `fixtures/html-page-viewer/static.html`.
- Executed the `Source` control and asserted changed output.
- Opened 1 further fixtures as smoke checks for nonempty content and no plugin-load failure; their exact semantic output was not asserted.
- Verified unchanged hashes for every opened input, removed extension/command registrations after detaching leaves, and reloaded the primary fixture with its expected values.

## Environment and validation

Tests use fictional fixtures in a fresh own synthetic vault on macOS arm64, the actual Obsidian 1.15.1 renderer and Electron 39.8.3. A bounded own bootstrap separates the CLI socket and test profile. Mock keychain is enabled; the regular application/CLI and installed original bytes are checked separately. Own test windows may be visible and remain unfocused. No OS mouse or keyboard input is used. The renderer uses an emulated 1800×1050 viewport; no native window geometry/throttle commands are used.

Ordinary locked `npm ci`, TypeScript checking, production build, existing test scripts and production dependency audit passed. Checked-in official `eslint-plugin-obsidianmd` 0.6.0 recommended checks cover source and metadata; existing repository lint guards are retained where present. Generated/test harness artifacts are outside the official production-source lint scope. Development tooling is not shipped.

## Scope limits

Viewer leaves are manually detached before unload; unregister/reload proof does not establish automatic closure of every open leaf.

This establishes the exercised 1.15.1 macOS behavior. It does not establish mobile, minimum-version, native-resize, authentication or real keychain behavior. Official Community source/release review, public asset readback and fresh catalog installation remain separate publication gates; a local build or screenshot alone does not establish them.

## Render evidence

![Actual Obsidian 1.15.1 synthetic fixture](../assets/obsidian-1.15.1.png)
