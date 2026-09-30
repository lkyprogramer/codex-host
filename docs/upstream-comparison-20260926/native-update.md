# Native、更新与发行链路的上游差异（2026-09-26）

## 比较口径

- fork：`feat/process-anchor`，`af255febcba902a70d16cfec9271dfa2c5cd6ae9`；上游本地镜像：`main`，`997f62a0ede22609ed42b949957100d16043ad17`；共同祖先：`7cc4db87fe5e5aa7f232e592a6ff8f0ff96534c9`。通过 Git alternate object directory 读取两个提交；未 fetch、checkout、构建或运行应用。本文的“上游”只指固定提交，不以版本号判断优劣。
- 仅分析 `crates/{launcher,shim,platform,updater}`、`packages/{harness-discovery,update-manager}`、`scripts/release` 和直接相关测试。fork 的 `crates/anchor`、Shim 的 anchor 注入与回收、发行包中的 anchor 必须保留（fork `crates/shim/src/lib.rs:773,898-946`、`scripts/release/prepare-npm.mjs:970-975`）。下列行号分别对应上述两个固定提交，实施前仍须重新核对 HEAD。
- 优先级是按可观察故障影响、迁移风险与现有测试边界排序的建议；“差距”是静态源码判断，未声称现场故障或运行时验收。

## 候选（按建议优先级）

### P0-1 · 保留 Codex 辅助 app-server 的官方路由

上游 `66bedaed` 在 `crates/shim/src/lib.rs:341-384,393-435` 精确识别 `model_provider=openai-memgen`，并让非 `Codex Desktop` 的 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` 回到 stock CLI；测试在同文件 `1061-1110`。fork `crates/shim/src/lib.rs:375-417` 只按 app-server 参数形状选 Host，缺少两个例外。**差距：存在**；Skysight/Computer Use 等官方一次性服务可能被当成长期 Host（具体现场未验）。**方式：小补丁，S**。仅在路由判定前加精确 provider 与 originator 判断，保留现有 SSH proxy、Unix listener、anchor 注入规则；不扩大为所有 `-c` 参数绕行。**冲突/依赖：**需确认当前 Desktop 对正常调用的 originator 值；精确测试需要同时覆盖正常 Desktop、provider 定义但未选中、辅助 originator、前后置 `-c`。**实施/验收：**修改 Shim 路由及单测后运行 `cargo test --locked -p codexhost-shim --lib` 和相关 `crates/shim/tests/proxy.rs` 定向用例；真实 Desktop 摘要仍需单独 smoke。**回滚：**撤回该路由例外及测试，恢复原判定。

### P0-2 · 拒绝 npm CLI 与平台包版本错配

上游 `53795e97` 在 `scripts/release/prepare-npm.mjs:363-374` 读取已解析平台包的 `package.json` 并要求其版本等于 CLI 版本，配套测试见 `tests/release/npm-package.test.mjs`；fork `scripts/release/prepare-npm.mjs:293-323` 解析包路径后立即使用二进制，没有版本检查。**差距：存在**；全局安装残留或 optional dependency 错配时可能运行另一版 native/payload，且 fork 的 anchor 随平台包发行，影响更大。**方式：小补丁，S**。在路径解析之后、启动之前校验版本；错误指令仍应涵盖 fork 的 CLI 与平台包，勿只更新元包。**冲突/依赖：**保留 symlink/global fallback 和 anchor 打包路径；测试 fixture 的版本必须与生成 CLI 版本一致。**实施/验收：**补齐 match/mismatch/malformed package metadata fixture，运行 `npx vitest run --config tests/vitest.config.js tests/release/npm-package.test.mjs`；打包和真实 npm 全局升级未运行。**回滚：**移除启动前校验及相关 fixture，不触碰安装器。

### P1-3 · 限制重复启动时的附件恢复重试

上游 `07e72f6f` 在 `crates/launcher/src/desktop_attachment.rs:24-25,69-95,150-190` 对 `busy`、读超时、连接中断视为暂态，并将重试间隔从 100 ms 指数退避到 1 s；该提交还修改 `packages/desktop-control/src/controller-attachment-server.ts:32,65-67` 的 busy 响应。fork `crates/launcher/src/desktop_attachment.rs:66-80,136-160` 仍固定 100 ms 且读超时会出错；fork Controller 的 `packages/desktop-control/src/controller-attachment-server.ts:64` 也没有 busy 分支。**差距：两端均存在**。**方式：语义重实现，M**。同时适配 Controller 的并发回复和 Launcher 的暂态处理。**冲突/依赖：**需要避免退避耗尽原有启动 timeout，也要维持 guard/descriptor 所有权；anchor 不参与此连接。**实施/验收：**新增 busy/timeout/并发恢复 fixture，运行 `cargo test --locked -p codexhost-launcher` 与 Controller 定向 Vitest；真实重复启动 smoke 另验。**回滚：**恢复旧 ATTACH 行为和重试逻辑，两端同时回退。

### P1-4 · 保持已选择的 Node 在 Harness PATH 中优先

上游 `c9ebf7fe` 将 `packages/harness-discovery/src/node-runtime.ts:21-23` 的 runtime 目录放到 PATH 末尾，避免覆盖版本管理器或包管理器 shim 所选 Node。fork 同文件 `14-21` 仍 `unshift`；测试位置 `packages/harness-discovery/test/resolve.test.ts:203-208`。**差距：存在**。**方式：小补丁，S**。只改 fallback 顺序，同时检查空 PATH 仍能找到内置 Node、Windows 大小写去重仍有效。**冲突/依赖：**anchor 启动的是 Harness 进程，但不决定 Node 搜索顺序；若某 adapter 依赖强制 bundled Node，须在其自身边界声明并单测。**实施/验收：**改顺序和现有测试，运行 `npx vitest run --config tests/vitest.config.js packages/harness-discovery/test/resolve.test.ts`。**回滚：**还原 PATH 插入顺序。

### P1-5 · 显式 Desktop profile 路径贯通 LaunchServices/AppX

上游 `ead8028d`、`fa700d4e`、`1a2b4533` 形成 `crates/launcher/src/desktop_path_overrides.rs:4-49`：只转发绝对目录的 `HOME/USERPROFILE/ZDOTDIR/CODEX_HOME/CODEX_ELECTRON_USER_DATA_PATH`，远程受管启动不转发，并为 Electron profile 增加 `--user-data-dir`；调用在 `crates/launcher/src/main.rs:698-709,912-914`。fork `crates/launcher/src/main.rs:697-707,857-908` 未转发这些显式覆盖。**差距：存在；仅对使用隔离 home/profile 的启动有意义**。**方式：语义重实现，M**。按 fork 现有 `CODEXHOST_DATA_DIR` 和远程 SSH 边界整合白名单及参数，拒绝相对路径和凭据变量。**冲突/依赖：**`open --env` 会暴露命令行环境；不得把整个父环境传给 Desktop；需核对 profile 与 launcher runtime descriptor 是否要同址。**实施/验收：**增加纯函数和隔离环境测试，运行 `cargo test --locked -p codexhost-launcher`，随后在 macOS/Windows 分别以独立测试 profile 启动验证；后者本次未做。**回滚：**删除转发白名单及 `--user-data-dir` 追加，保持现有数据目录配置。

### P2-6 · macOS node_repl 沙箱重入的受限 CLI 发现

上游 `8bb27d6a` 在 `crates/shim/src/lib.rs:797-850` 允许仅 macOS 且顶层参数为 `sandbox` 时，在两个 CLI 覆盖均被清空的条件下发现 Desktop 管理的 stock CLI；其余调用继续 fail closed，回归在 `crates/shim/tests/proxy.rs`。fork `crates/shim/src/lib.rs:825-870` 强制 `CODEX_CLI_PATH` 自指或明确 stock 路径。**差距：存在；当前 node_repl 路径是否触发该清洗仍待实际验证**。**方式：小补丁，M**，因为是代理目标信任边界。**冲突/依赖：**保持 fork 的 remote SSH bootstrap、stock 路径验证、anchor 只注入 Host。**实施/验收：**用无覆盖环境的顶层 sandbox fixture 验证仅该情况放行，普通直接调用仍报错；运行 `cargo test --locked -p codexhost-shim --features test-utils --test proxy`。**回滚：**撤销单一 sandbox 例外。

### P2-7 · Windows Job 的后代存活与树退出确认（上游 `ead8028d`）

上游的 `crates/platform/src/windows_process.rs:127-154` 用 Job accounting 读取 active process 数，`crates/platform/src/process_supervision.rs:169-215` 增加 `wait_for_tree_exit` 和 Windows `has_live_processes`，并在同文件 Windows 测试中覆盖根进程先退出、后代仍活。fork `crates/platform/src/process_supervision.rs:237-249` 只在 Unix 有 `has_live_processes`；Windows 现有 `ChildJob` 只有终止操作（`crates/platform/src/windows_process.rs:125-155`）。**差距：能力缺失；上游该 API 自身未见生产调用，故暂不把它当作已证明的现场修复**。**方式：仅理念，M**。先找到 fork Windows Shim/Updater 中确需等待整棵树退出的调用点，再在 Job 所有权成立时增加查询和等待，不用根进程 exit 代替释放证明。**冲突/依赖：**process-anchor 是 Unix Harness 轨道，Windows 仍走 Job；对无 Job 的短命子进程要定义可观察结果。**实施/验收：**先写根先退/后代滞留 fixture，再验证等待与强杀；运行 Windows 上 `cargo test --locked -p codexhost-platform`。**回滚：**撤回新查询及其调用点，维持现有 Job 终止语义。

### P3-8 · macOS 进程观察优化已由 fork 等价且更贴合 anchor 的方案覆盖

上游 `cd38646b` 在 `crates/platform/src/macos_process_observation.rs:21-104` 先读全系统身份、仅给候选树成员读取 `pidpath`，接入点 `crates/platform/src/process.rs:332-340`。fork `crates/platform/src/process.rs:390-416` 已在 `observe_identities()` 中先读取身份与 root 路径，再为所属成员补全可执行路径；`crates/platform/src/process_supervision.rs:40-45` 的存活探测直接使用该轻量观察，服务于 anchor 清理。**差距：核心性能目标已覆盖**。**方式：已有无需移植，S（只需复核现有测试）**。不覆盖 fork 的所有权/PID reuse 与 self-releasing anchor 规则。**验收：**如果将来调整观察算法，先跑 `cargo test --locked -p codexhost-platform` 与 Shim anchor 回归，并比较路径读取次数；本轮无需改动。**回滚：**无迁移动作。

## 已覆盖、应拒绝及条件项

- **已覆盖：**上游 macOS 路径读取优化如 P3-8；fork 另有 anchor 的 group 固定、回收及发行打包（`crates/anchor/src/anchor.rs`、`crates/shim/src/lib.rs:898-946`、`scripts/release/prepare-payload.mjs`），上游没有等价物，不能在合并其他 native 补丁时删除。
- **暂不移植：**上游 `5fde6be4`/`903f1b4c` 的统一品牌图标及生成器（`scripts/release/generate-brand-icons.mjs:1-39`、`scripts/release/windows/Installer.iss:15-17`）属视觉/品牌选择，fork 目前的图标装配在 `scripts/release/macos/assets.mjs:11-17,55-57` 与 `scripts/release/macos/package.sh:73-80` 可工作；未经产品素材决定不替换。上游 `aaeef316` 的 npm Star 提示也不构成可靠性修复，且改变 CLI 标准输出，不建议移植。
- **条件项：**上游新增 Qoder/WorkBuddy/Kimi 等 Harness 后对应的 `scripts/release/harness-plugins.json` 和第三方 license 清单，只在 fork 决定引入对应 Adapter 时同步，否则会形成无 owner 的预装与许可工件。`packages/harness-discovery/src/environment.ts` 的 `isDirectory` 是这些安装目录发现改动的配套 helper，不单独引入。
- `packages/update-manager` 和 `crates/updater` 自共同祖先以来在上游目标快照没有直接改动；fork 自己修改了更新准备与下载路径。因此不存在可机械移植的上游 updater 补丁。本报告未把上游发布编号当作更新安全证据，也未验证生产升级。

## 验证与实施边界

本文只执行固定提交的 `git log/diff/show`、`rg`、源码与 `package.json`/Cargo 配置读取，以及写入本文件；所有列出的 Cargo/Vitest/跨平台 smoke 均为建议命令，**未运行**。若实施，先按 P0 → P1 小批次推进，每批保留 fork 的 anchor 行为与打包清单，分别验收后再考虑下一批；P2-7 应以发现真实调用需求为前提。
