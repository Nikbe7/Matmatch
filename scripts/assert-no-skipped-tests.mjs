#!/usr/bin/env node
// Fails the build when a vitest run skipped anything (#227).
//
// This is the whole point of the CI job, not a nicety on top of it. 283 of the
// backend tests gate themselves on `isLocalStackAvailable()` and skip *silently*
// when the Supabase stack is not reachable — the run still exits 0 and still prints
// a cheerful green summary. A CI job that lets that pass is worse than no CI: it
// converts "nobody checked" into "the robot said it was fine".
//
// CLAUDE.md's merge rule already requires "both suites at 0 skipped via the JSON
// reporter". Until this script existed that condition could only be checked by a
// human remembering to look at the right field. Now it is enforced.
//
// `todo` counts too. A `it.todo` is a test that does not run, and the distinction
// between "skipped" and "planned" is not one the merge rule cares about.

import { readFile } from "node:fs/promises";

const [, , reportPath, label] = process.argv;

if (!reportPath) {
  console.error("usage: assert-no-skipped-tests.mjs <vitest-json-report> [label]");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(await readFile(reportPath, "utf8"));
} catch (cause) {
  // A missing or unparseable report means the suite did not run to completion —
  // treated as a failure rather than "nothing to check", for the same reason as
  // above: the failure mode this guards against is a run that quietly did nothing.
  console.error(`${label ?? reportPath}: could not read the vitest report (${cause.message})`);
  process.exit(1);
}

const name = label ?? reportPath;
const { numTotalTests = 0, numPassedTests = 0, numFailedTests = 0, numPendingTests = 0, numTodoTests = 0 } = report;

console.log(
  `${name}: ${numTotalTests} total, ${numPassedTests} passed, ${numFailedTests} failed, ` +
    `${numPendingTests} skipped, ${numTodoTests} todo`,
);

if (numTotalTests === 0) {
  console.error(`${name}: the run reported zero tests — the suite did not execute.`);
  process.exit(1);
}

if (numPendingTests > 0 || numTodoTests > 0) {
  console.error(
    `${name}: ${numPendingTests} skipped and ${numTodoTests} todo test(s). ` +
      `A green run that skipped its database tests is not a green run — check that the ` +
      `Supabase stack started before the suite (see .github/workflows/ci.yml).`,
  );
  process.exit(1);
}

if (numFailedTests > 0) {
  console.error(`${name}: ${numFailedTests} failing test(s).`);
  process.exit(1);
}
