# R5 U31 CI coverage

The CI workflow keeps the four existing release-gated job names. The Linux x64 job still runs `npm run check` in full. macOS, Windows, and Linux ARM64 run `npm run test:typescript` and `npm run test:rust`; the two Linux jobs still smoke-test their own npm packages. The TypeScript and Rust commands use independent steps so a later success cannot hide an earlier failure under Windows PowerShell.

## Before and after inventory

| Runner / release job | Before U31 | After U31 |
| --- | --- | --- |
| `ubuntu-22.04` / `Check ubuntu-22.04` | `npm run check`; Linux x64 npm smoke | Same full check and smoke |
| `macos-14` / `Check macos-14` | `npm run check` | `npm run test:typescript`; `npm run test:rust` |
| `windows-latest` / `Check windows-latest` | `npm run check` | `npm run test:typescript`; `npm run test:rust` |
| `ubuntu-22.04-arm` / `Check Linux ARM64` | `npm run check`; Linux ARM64 npm smoke | Both test scripts and same smoke |

`test:typescript` builds the TypeScript packages and `codexhost-anchor`, then runs the unchanged `tests/vitest.config.js`. At baseline `ae4bcc33`, its exact file set is 333 files: 277 `packages/**/test/**/*.test.ts`, 7 `packages/repository-automation/test/**/*.test.mjs`, 14 `tests/release/**/*.test.mjs`, and 35 `tools/**/*.test.mjs`. **Each of those files is selected on all four runners before and after U31.** Existing test-level platform skips remain in the tests; no test is classified or filtered by scanning its source. The sorted path list has SHA-256 `8f904fb678df52fd892094d17c7ea578c7246a5e5a241162ab50af9af957dcff` at that baseline. The include patterns in `tests/vitest.config.js` define the exact set as new tests are added.

`test:rust` invokes the same `cargo test --workspace --locked --features codexhost-shim/test-utils,codexhost-gate-a-native/gate-tools` command used inside `check:rust`. Thus every workspace crate's tests still run on all four OS/architecture jobs. The TypeScript setup file still injects the built native anchor on non-Windows runners, and the anchor crate is in the Cargo workspace. The same Vitest suite continues to own behavior, conformance, repository automation, release, and package tests on every runner.

Formatting, ESLint, package boundary checks, the separate `tests/tsconfig.json` typecheck, and Rust Clippy now run once in the full Linux x64 check. Platform tests still compile the TypeScript packages and Rust workspace locally. This preserves OS-specific compilation and test behavior while removing duplicate static checks from the other three jobs.

Rust cache restoration follows toolchain setup in each job. The cache stores dependencies, while `cache-workspace-crates: false` makes workspace crate builds source-current; `cache-on-failure: false` avoids saving failed build products. A cache miss performs the normal cold build. A hit still runs every build, test, and package smoke command. PR concurrency is grouped by PR number and cancels superseded PR runs; main pushes use their unique run ID and are not canceled by later pushes.

Local workflow tests check the workflow declaration and coverage ownership. Remote GitHub Actions cold/warm duration, cache hits, failed-run log retention, PR cancellation, and main-push non-cancellation remain **unrun** until an authorized push or CI trigger. No time saving is claimed from local checks.
