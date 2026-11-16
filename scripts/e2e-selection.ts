// Shared selection contract for the launcher, host configuration and corpus check.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function selectedSpecs(value = process.env.E2E_ONLY): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const names = value.split(",").map((name) => name.trim());
  const known = fs
    .readdirSync(path.join(import.meta.dirname, "../test/e2e/specs"))
    .filter((name) => name.endsWith(".e2e.ts"));
  const unknown = names.filter((name) => !known.includes(name));
  if (unknown.length)
    throw new Error(
      `Unknown E2E_ONLY selection: ${unknown.map((name) => name || "(empty)").join(", ")}. Use spec file names: ${known.join(", ")}.`,
    );
  return [...new Set(names)];
}

export function rejectSpecArguments(args: string[]): void {
  if (args.some((arg) => /^--(?:spec|suite|exclude)(?:=|$)/.test(arg)))
    throw new Error(
      "Runner spec filters are unsupported; use E2E_ONLY=viewer.e2e.ts (comma-separated file names).",
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length > 2)
    throw new Error(
      "Runner arguments are unsupported; use E2E_ONLY=viewer.e2e.ts to focus the run.",
    );
  selectedSpecs();
}
