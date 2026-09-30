# R1 改造结果

基于 `feat/process-anchor` 的 `af255febcba902a70d16cfec9271dfa2c5cd6ae9`，在 `/Users/luo/Documents/github/codex-host-r1`、分支 `codex/upstream-r1` 实施。未提交、未 push；原 worktree 保持原状，研究清单仍位于原仓库。

## 完成内容

| 任务 | 结果 | 主要文件 |
| --- | --- | --- |
| U01 | memgen 与官方辅助 originator 走 stock CLI；普通 Desktop/代理路由保持；重复 provider 以最后一次覆盖生效 | `crates/shim/src/lib.rs`、`crates/shim/tests/proxy.rs` |
| U02 | 分块 JSONL 只扫描新增字节，在完整帧时拼接；支持显式帧限额；私有官方 WebSocket 移除 128 MiB 限制 | `packages/protocol-core/src/jsonl.ts`、`packages/host-runtime/src/remote-official-connection.ts` |
| U03 | 校验链接与目标的 owner、socket 类型和目标私有权限；只 unlink 已记录同 inode 路径，不删目标；覆盖关闭竞态与失败清理 | `packages/host-runtime/src/remote-official-app-server.ts` |
| U04 | 校验实际解析到的平台包名称和 CLI 版本一致，错配/损坏元数据不启动 native；包含全局 symlink fallback | `scripts/release/prepare-npm.mjs` |
| U07 | Host Node 目录追加为 PATH 兜底，保留用户 shim；Windows 路径与大小写去重 | `packages/harness-discovery/src/node-runtime.ts` |
| U14 | 仅 retry delayMs 接受非负有限小数，retry/maxRetries 仍为整数 | `packages/adapters/deepseek-harness/src/modern/history.ts` |

另修复基线测试 `managed-harness-session.test.ts` 对动态附加 resourceLifecycle 的类型访问（仅 import/type cast，无运行逻辑变动），使测试类型检查能够通过。没有改多账号、额度、导入、Harness 集合、anchor、observer 或回收公共合同。

## 验证

TypeScript 使用仓库 `.node-version` 对应 Node 22.22.0；首次依赖准备 `npm ci --ignore-scripts --prefer-offline` 由 shell 默认 Node 22.16.0 执行，报告 engine warning，随后构建/测试切换为 22.22.0。锁文件未改变；未运行 npm audit fix 或更新依赖。

- `npm run build:typescript`：通过（含插件构建）。
- `npm run typecheck`：最终通过。
- `npm run lint`：最终通过（含 `tools/check-boundaries.mjs`）。
- 7 个定向 Vitest 文件最终分别通过，合计 134 个不同用例：JSONL 6、Node discovery 15、DSH history 45、remote official connection 4、remote official listener 15、npm package 33、managed session 16。
- `cargo test --locked -p codexhost-shim --lib`：26 passed；最后 provider 覆盖修订后定向重跑 `routes_only_selected_memory_provider_to_stock_codex`：1 passed。
- `cargo test --locked -p codexhost-shim --features test-utils --test proxy auxiliary_app_servers_use_stock_cli_with_host_paths_configured`：1 passed。
- Rust 验证使用 `CARGO_TARGET_DIR=/Users/luo/Documents/github/codex-host/target` 复用构建缓存。`cargo fmt --all -- --check` 与 `git diff --check` 通过；修改的 TS/MJS 已使用 Prettier 格式化。
- 独立 GPT-6 Sol / medium 只读复核（原标 high 不准确，已按实际会话配置更正）：最终无阻塞 finding。已修复其发现的 provider 覆盖顺序与 socket 初始化/就绪期间关闭交错问题。

### 定向 TS 命令

各次按失败范围重跑，而非执行全仓套件。执行目录均为新 worktree，PATH 使用 `/Users/luo/.nvm/versions/node/v22.22.0/bin`。

```bash
npx vitest run --config tests/vitest.config.js packages/protocol-core/test/jsonl.test.ts packages/host-runtime/test/remote-official-connection.test.ts packages/harness-discovery/test/resolve.test.ts packages/adapters/deepseek-harness/test/modern/history.test.ts tests/release/npm-package.test.mjs

env -u NODE_USE_ENV_PROXY npx vitest run --config tests/vitest.config.js tests/release/npm-package.test.mjs packages/host-runtime/test/managed-harness-session.test.ts

env -u NODE_USE_ENV_PROXY npx vitest run --config tests/vitest.config.js packages/adapters/deepseek-harness/test/modern/history.test.ts packages/host-runtime/test/remote-official-app-server.test.ts
```

首次组合运行有失败：npm 三项严格 stderr 断言被环境 `NODE_USE_ENV_PROXY=1` 的实验性警告污染；移除该变量后原断言通过，未屏蔽全部警告或改弱断言。大历史新测试曾等待连接关闭时未继续消费异步迭代器，修正 fixture 的 drain/关闭次序后通过（另已运行 remote-official-connection 文件 4 项）。新增 socket fixture 的可选属性类型及两处测试 lint 错误亦已修复。最终 typecheck/lint 已重跑通过。

### 大帧证据

真实本机回环 WebSocket fixture 返回 129 MiB JSON 响应后继续返回小帧，验证字节完整及连接正常关闭；未调用真实 Codex 服务。JSONL 的分块 16 MiB 测试同时断言只调用一次 Buffer.concat，防止逐块重复复制。

单次本机测量：256 个 64 KiB 块合成一个 16,777,216 字节帧，Node 22.22.0，约 7.09 ms；RSS 67,305,472 → 86,605,824 bytes，进程 maxRSS 84,576 KiB。无旧版对照、无多轮统计，不据此宣称加速倍数或生产容量。

## 来源与许可证记录

技术参考提交：U01 `66bedaed`，U02 `90abc1d3`，U03 `2e6e1bf1`，U04 `53795e97`，U07 `c9ebf7fe`，U14 `b685f36e`，位于 BytePioneer-AI/codex-host。

U01 适配部分上游路由实现，已核对该源提交 LICENSE 为 MIT，版权与原仓库 MIT LICENSE 一致，源文件注释标明提交。U02/U04/U07/U14 按本地接口实现行为要求，没有整段复制上游补丁。U03 参考上游校验结构并复用 uid/isSocket/mode 的目标校验表达式，其余生命周期与测试在 fork 本地编写；上游该提交处于 LGPL 切换之后，保留此来源差异，不将整个最新上游标作 MIT。本轮不做发布或许可证合规结论。

## 限制与回滚

未运行真实 Desktop 摘要、真实 SSH、真实 DSH、目标 Windows/Linux 平台、全仓测试、实际 npm 全局安装/升级。Node discovery 的 owned-process 用例使用本 worktree 默认测试环境（未额外构建/指定 native anchor），不能作为新增 anchor 实测。

socket 所有权沿用私有随机 sibling 路径和 inode 模型：不是防同用户恶意抢占路径的安全沙箱；检查与 unlink 之间的同用户 pathname 竞态不能由该 API 完全排除。超大 WebSocket 响应仍会占用相应内存，只对已有私有官方连接放宽，不推广到公网服务。

六项可按文件范围分别撤回；U02 的 parser 与 WebSocket 选项分开处理，U03 的生命周期检查与链接清理须一起回退。没有持久化格式或数据库迁移，不删除用户 Native Session 数据。分支未提交，后续合并/提交由用户另行指示。


## 后续提交授权

2026-09-26 用户授权整理全部改动并分批提交，随后继续 R3。上文“未提交”等描述保留为实施当时的证据边界；后续提交清单见 `docs/upstream-r3/plan.md`。
