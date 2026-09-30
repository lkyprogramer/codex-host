# R4 independent review

Baseline `1127cbc1`; worktree `/Users/luo/Documents/github/codex-host-r1`. Reviewer configured by `/Users/luo/.codex/agents/reviewer.toml`, native role `reviewer`. Actual session `01a0dc1d-822e-7fd2-8dec-931b672d0ca8` initial turn_context verified `gpt-6-astra / high`; no CLI fallback. All implementation workers were native GPT-6 Sol/high.

Final review passed. All six findings are closed; no remaining confirmed defect was reported.

| Finding | Priority | Evidence and repair requirement | State |
| --- | --- | --- | --- |
| R4-F1 | P2 | U13 added sourceItemIds but real Claude/Pi/OMP/Grok native fileChange producers did not attach tool provenance, allowing inferred fragments plus authoritative patch double counting. Repair real live/replay producers and regression, not just annotated synthetic items. | Closed |
| R4-F2 | P2 | U25 parent header reader decoded an arbitrary 64 KiB prefix with fatal UTF-8; a later multibyte character cut at the boundary rejects an otherwise valid first header. Decode only complete header bytes and cover valid child cold read. | Closed |
| R4-F3 | P2 | U13 path keys conflated POSIX backslash names with directory separators; Windows UNC cwd was not detected. Preserve POSIX names and normalize Windows roots correctly. | Closed |
| R4-F4 | P2 | U13 unbounded spread into Array.splice can exceed V8 call argument limits for a large valid replacement hunk and fail live projection. Avoid unbounded call arguments and add regression. | Closed |

The initial U24 pass and subsequent U22/U32 integration review found no confirmed issue. Tests and native boundaries are recorded in RESULT.md; the reviewer was read-only and did not run tests or build.


During F1 repair, OpenCode's Turn diff was confirmed to be potentially partial: the non-strict reader can return available files after retries or an empty result after an error. Repair must suppress inferred changes only for reliably covered file paths, preserving uncovered tool previews; item-wide or Turn-wide suppression is not justified by a nonempty array. Claude/Pi historical native patch fields also require projection through the same native parsers to preserve live/replay semantics. These are F1 completion requirements.

The existing Settings foundation regression additionally caught a mutable Resources page definition. It was changed to `Object.freeze<RendererSettingsPageDefinition>`, preserving the existing contract; the page-label/ID expectations were updated for Resources. Eight foundation/localization tests passed after the repair.


## Frozen-candidate repair review

The 73-file candidate was independently hash-checked. Astra also independently read the installed app.asar and matched its hash and fileChange reducer semantics to the evidence document. F1 real producer provenance, F2 complete-header UTF-8 decoding, F4 bounded splice/coordinate fallback were statically confirmed; OpenCode now preserves uncovered partial-diff previews. That repair-review pass identified the following direct gaps, both subsequently repaired and closed:

- R4-F5 (P2): Pi live returned early when a tool argument could synthesize a patch, while the new history path preferred a reliable native patch. Live must prefer the same native result and fall back consistently; compare both projections from the same real result fixture.
- R4-F6 (P3, extension of F3): Claude/Pi/OMP/Grok displayPath helpers converted literal POSIX backslashes to slashes before the corrected path-key code could see them. Preserve POSIX file names in the four directly affected producers and test native paths. No unrelated path cleanup.

Unified candidate validation before these final repairs: 35 Vitest files / 843 tests passed; 7 Chrome Playwright tests passed; TypeScript and Renderer build plus typecheck passed. Lint reported four forbidden non-null assertions in the root U22 source/test; they were replaced with explicit invariant/fixture checks, and the six resource-observation tests passed again. Final lint and repaired-path verification subsequently passed; see final closure below.


## Final closure

F5 and F6 repaired and verified with the same Pi native result through live/history projection and native POSIX backslash fixtures in all four affected Adapters. Final Astra review validated 77 hashes and closed F1–F6 with no new finding. A final lint pass then required three tests to replace cross-package `/src` imports with public exports; those tests still exercise the actual Adapter/snapshot/projector path. Their 80 tests and final typecheck/lint passed; Astra rechecked the three changed test files, all 77 hashes, and confirmed the same final verdict without weakened assertions.

Final evidence: TypeScript/Renderer builds and typecheck/lint passed; 35-file/843-test combined run, 15-file/337-test repair run, 3-file/80-test export-boundary rerun, and 7 Chrome E2E tests passed. These counts overlap. The reviewer did not execute tests/build/browser or edit files. Installed Desktop reducer static evidence was independently checked; actual Desktop card interaction, OMP native restart and native section pagination remain unrun. See RESULT.md for complete boundaries.

All five reviewer turn_context records in session `01a0dc1d-822e-7fd2-8dec-931b672d0ca8` were verified as `gpt-6-astra / high`; final turn ID `01a0dc37-9e8d-7310-b95d-08c0f91df69d`. Root independently rechecked all 77 source/test/dependency hashes before local commits. No production or test edits followed this final review.
