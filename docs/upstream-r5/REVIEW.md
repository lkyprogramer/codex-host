# R5 independent review and validation

Baseline: `ae4bcc333b4518f86b61f04a09147c092b3da13a`. Final reviewer used `/Users/luo/.codex/agents/reviewer.toml`, explicitly dispatched as `reviewer` with `model: gpt-6-astra`, `reasoning_effort: high`, `fork_turns: none`. Session `01a0e0a0-6e9d-7320-a7a5-bc0958e2ee9f` actual turn-context metadata reports `gpt-6-astra` / `high`. An earlier R5 review session `01a0dc4e-c238-78d3-8bdc-4594af309c6a` was independently verified at the same tier. The reviewer was read-only; the root agent made and checked the final repairs.

The final review covered the entire R5 change against the baseline: shared contract, Pi/OpenCode native discovery and execution, Host admission and cancellation, official delegation, Composer and Desktop prewarm bindings, model favorites, CI, tests, and documentation. The reviewer reported no remaining actionable behavior findings after repair and focused reruns.

| Severity | Confirmed issue | Repair and closure |
| --- | --- | --- |
| P1 | Windows PowerShell could mask a failed TypeScript CI step with later Rust success. | Separate CI steps; workflow tests and Astra follow-up passed. |
| P1 | Command admission could acknowledge cancellation after native execution began without cancelling it. | Host metadata-to-execution handoff and Adapter immediate acceptance with pre-dispatch cancel fences; Host/Pi/OpenCode tests passed. |
| P1 | Official delegation referenced an uninstalled `CODEX_HOME` skill path. | Resolve only an existing managed skill path; Host and skill tests passed. |
| P1 | Serialized Desktop prewarm function referenced a module-only WeakMap. | Keep ownership on the injected target; serialized evaluation and disposal regression passed. |
| P1 | Loaded Session catalog reads entered its serialized operation queue and could delay prompt or cancel beyond the catalog timeout. | Remove loaded Session reads. Adapter-owned short-lived metadata inspection is independent; a real Host test holds the catalog pending while a normal Turn completes. Astra reran the Host test and cache tests. |
| P2 | Markdown code examples and longer closing fences were interpreted incorrectly as command carriers; DOM code blocks were also scanned during submit preflight. | Shared code range parser and DOM-aware preflight; shared unit and Chrome DOM/keyboard regressions passed. |
| P2 | Multiple or mixed chips, whitespace-only command arguments, and textarea Composer input lost or misrouted user text. | Scoped carriers, exact argument forwarding, textarea selection/value path and submit rejection; Host and Chrome tests passed. |
| P2 | Escaped menu dismissal was lost on keyup; after Escape then deleting and retyping `#`, textarea menu stayed closed. | Dismiss only the current unchanged trigger; clear dismissal when the trigger disappears. Both Chrome cases passed. |
| P2 | Pi accepted native commands after its Session was closed. | Guard command entry by `phase === open`; closed Session regression passed without a new transport. |
| P3 | Static-only Adapters promised that sending a message would load live commands. | Replace with factual static-directory status; Renderer tests passed. |

Validation observed locally:

- `npm run typecheck` and `npm run lint` passed after the production changes; the final lint rerun also passed after removing an unused import.
- Final aggregate of 16 changed Vitest files: 474 tests passed after all code fixes, including Pi closed-Session and Host catalog isolation.
- Five changed Playwright specs on installed Google Chrome: 27 tests passed before the final two focused changes. The subsequent DOM code and textarea dismissal regressions each passed as separate Chrome tests.
- Pi under Node v22.19.0: native `get_commands` returned 49 raw entries; actual Adapter inspection returned 41 admitted live entries and closed its temporary RPC transport. OpenCode metadata-only smoke returned 42 live entries and closed its managed server. No provider prompt was sent.
- `git diff --check` and changed-file Prettier checks passed. The R5 code tree before the documentation commit is `d45b908d4c3f9fd0d7113b7d2efbea8280b9ea8c` at `da72e61925f0794f4b13ad38fbe0d0345f560425`.

Remote GitHub Actions timing/cancellation, a restarted Codex Desktop with its private Composer bindings, provider-backed command execution, and cross-platform CI runs were not performed. Local Chrome fixtures exercise DOM and keyboard behavior, but lack Desktop's actual styling. No push, PR, deployment, or Desktop restart was performed.
