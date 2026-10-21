// @ts-check
// The plugin's source, unit tests, and scripts. The end-to-end suite has its
// own package and type check (test/e2e/), and the fixtures and the frozen
// prototype build are test data.
import obsidianmd from "eslint-plugin-obsidianmd";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    ".obsidian-cache/",
    "dist/",
    "main.js",
    "release/",
    "test-fixtures/",
    "test-results/",
    "test/e2e/",
  ]),
  // The rules of Obsidian's review of community plugins.
  obsidianmd.configs.recommended,
  {
    rules: {
      // That review forbids disabling its rules in place; the fork is not in
      // Obsidian's directory, and each disable here states its reason.
      "eslint-comments/no-restricted-disable": "off",
    },
  },
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // The tests and scripts run in Node.js, not in Obsidian.
  {
    files: ["scripts/**", "test/**", "*.{js,mjs}"],
    languageOptions: { globals: globals.node },
    rules: {
      "import/no-extraneous-dependencies": ["error", { devDependencies: true }],
      "import/no-nodejs-modules": "off",
      "no-console": "off",
      "obsidianmd/no-global-this": "off",
      "obsidianmd/no-nodejs-modules": "off",
      "obsidianmd/prefer-create-el": "off",
      "obsidianmd/prefer-instanceof": "off",
      "obsidianmd/prefer-window-timers": "off",
      "obsidianmd/rule-custom-message": "off",
      // Obsidian's requestUrl exists only inside Obsidian.
      "no-restricted-globals": "off",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // node:test's test and describe return promises that the runner awaits.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["describe", "it", "test"] },
          ],
        },
      ],
      // The stand-in for Obsidian keeps its API's async signatures.
      "@typescript-eslint/require-await": "off",
    },
  },
);
