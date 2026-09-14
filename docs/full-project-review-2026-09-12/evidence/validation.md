# 验证记录

基线：local/all-fixes @ 38964658185bd090b4044f0cc9f5b575d8284b87。Node测试使用22.20.0（满足package.json engines；仓库.node-version为22.22.0），npm为该Node安装内的CLI；Rust/cargo均1.97.1。未安装或升级依赖。

结果汇总：生产TypeScript/十插件Bundle构建通过；独立边界通过；34个TS文件763 passed、1 skipped；Rust12 passed。5个隔离复现不计入这些测试用例数。未运行全仓test/check、完整Renderer build/E2E、Shim/Platform全套、真实Harness/模型/安装/更新/SSH。

lint失败使其串联的boundary步骤没有执行，因此独立执行了一次boundary，结果通过。Typecheck先生产tsc通过，后测试编译失败；不能把build:typescript通过称为typecheck通过。

## TypeScript typecheck

```sh
PATH=/Users/luo/.nvm/versions/node/v22.20.0/bin:$PATH npm run typecheck
```

退出码：2。结果：15 test type errors: Grok optional workMode/steering 11; DelegationControlApi fixture missing listHarnesses 1; external-work-mode HarnessSession assertions 3.

[原始输出](/Users/luo/Documents/github/codex-host/docs/full-project-review-2026-09-12/evidence/typecheck.txt)

## ESLint + declared boundary script

```sh
PATH=/Users/luo/.nvm/versions/node/v22.20.0/bin:$PATH npm run lint
```

退出码：1。结果：2 ESLint errors; chained boundary command not reached.

[原始输出](/Users/luo/Documents/github/codex-host/docs/full-project-review-2026-09-12/evidence/lint.txt)

## Independent boundary

```sh
PATH=/Users/luo/.nvm/versions/node/v22.20.0/bin:$PATH node tools/check-boundaries.mjs
```

退出码：0。结果：PASS; no output.

[原始输出](/Users/luo/Documents/github/codex-host/docs/full-project-review-2026-09-12/evidence/boundaries.txt)

## Production TypeScript and 10 plugin bundles

```sh
PATH=/Users/luo/.nvm/versions/node/v22.20.0/bin:$PATH npm run build:typescript
```

退出码：0。结果：PASS; includes tsc -b and npm run build:plugins.

[原始输出](/Users/luo/Documents/github/codex-host/docs/full-project-review-2026-09-12/evidence/build-typescript.txt)

## Core focused Vitest

```sh
PATH=/Users/luo/.nvm/versions/node/v22.20.0/bin:$PATH ./node_modules/.bin/vitest run --config tests/vitest.config.js packages/harness-adapter/test/text-session.test.ts packages/host-runtime/test/harness-plugin-loader.test.ts packages/host-runtime/test/installed-harness-plugins.test.ts packages/host-runtime/test/external-turn-steering.test.ts packages/host-runtime/test/harness-delegation-coordinator.test.ts packages/mapping-store/test/index.test.ts packages/mapping-store/test/session-replacement.test.ts packages/renderer-extension/test/renderer-external-steering.test.ts packages/renderer-extension/test/renderer-external-steering-rpc.test.ts packages/renderer-extension/test/renderer-external-queue.test.ts packages/renderer-extension/test/renderer-binding-probe-host-catalog.test.ts
```

退出码：0。结果：11 files, 182 passed.

[原始输出](/Users/luo/Documents/github/codex-host/docs/full-project-review-2026-09-12/evidence/focused-core-tests.txt)

## Adapter/restore/Broker Vitest

```sh
PATH=/Users/luo/.nvm/versions/node/v22.20.0/bin:$PATH ./node_modules/.bin/vitest run --config tests/vitest.config.js packages/adapters/claude-code/test/claude-code-adapter.test.ts packages/adapters/claude-code/test/sdk-transport.test.ts packages/adapters/grok/test/grok-adapter.test.ts packages/adapters/grok/test/grok-rewind.test.ts packages/adapters/pi/test/pi-adapter.test.ts packages/adapters/omp/test/omp-adapter.test.ts packages/adapters/opencode/test/opencode-adapter.test.ts packages/adapters/antigravity/test/antigravity-adapter.test.ts packages/adapters/kiro-cli/test/kiro-adapter.test.ts packages/adapters/kiro-cli/test/acp-session-lifecycle.test.ts packages/adapters/codebuddy/test/codebuddy-adapter.test.ts packages/adapters/cursor-cli/test/adapter.test.ts packages/adapters/deepseek-harness/test/modern/deepseek-harness-adapter.test.ts packages/host-runtime/test/external-thread-runtime.test.ts packages/host-runtime/test/external-thread-rollback.test.ts packages/harness-broker/test/broker-recovery.test.ts
```

退出码：0。结果：15 files, 513 passed. Cursor adapter.test.ts does not exist and was not selected; actual cursor.test.ts run separately below.

[原始输出](/Users/luo/Documents/github/codex-host/docs/full-project-review-2026-09-12/evidence/focused-adapter-tests.txt)

## Cursor actual file

```sh
PATH=/Users/luo/.nvm/versions/node/v22.20.0/bin:$PATH ./node_modules/.bin/vitest run --config tests/vitest.config.js packages/adapters/cursor-cli/test/cursor.test.ts
```

退出码：0。结果：1 file, 16 passed.

[原始输出](/Users/luo/Documents/github/codex-host/docs/full-project-review-2026-09-12/evidence/focused-cursor-tests.txt)

## Update/Desktop/Bundle Vitest

```sh
PATH=/Users/luo/.nvm/versions/node/v22.20.0/bin:$PATH ./node_modules/.bin/vitest run --config tests/vitest.config.js packages/update-manager/test/update-manager.test.ts packages/update-manager/test/distribution.test.ts packages/host-runtime/test/update-coordinator.test.ts packages/desktop-control/test/production-controller.test.ts packages/desktop-control/test/renderer-control-session.test.ts tests/release/host-bundle.test.mjs tests/release/desktop-controller-bundle.test.mjs
```

退出码：0。结果：7 files, 52 passed, 1 skipped: Windows-only update process detachment test on macOS.

[原始输出](/Users/luo/Documents/github/codex-host/docs/full-project-review-2026-09-12/evidence/focused-native-boundary-tests.txt)

## Rust updater

```sh
cargo test --locked -p codexhost-updater
```

退出码：0。结果：7 passed.

[原始输出](/Users/luo/Documents/github/codex-host/docs/full-project-review-2026-09-12/evidence/rust-updater.txt)

## Rust launcher update

```sh
cargo test --locked -p codexhost-launcher active_update
```

退出码：0。结果：5 passed; other targets filtered, no full crate suite.

[原始输出](/Users/luo/Documents/github/codex-host/docs/full-project-review-2026-09-12/evidence/rust-launcher-active-update.txt)

## 测试门禁的精确失败

- Grok grok-adapter.test.ts:2656–2725：11处可选workMode/steering未收窄的TS18048。
- Host delegation-control-server.test.ts:203：fixture缺DelegationControlApi.listHarnesses。
- Host external-work-mode.test.ts:18/31/35：3处不完整对象断言HarnessSession，TS2352。
- Grok grok-adapter.ts:420：no-this-alias；grok-work-mode.ts:80：no-non-null-assertion。
- 唯一skipped在update-manager.test.ts:143，为Windows-only进程detachment用例，在macOS跳过。

未改动这些错误，也未修改断言、扩大mock或跳过失败来获得通过。
