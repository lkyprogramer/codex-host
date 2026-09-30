# 独立只读复核（2026-09-26）

基线为 fork `af255feb` 与 upstream `997f62a0`。本记录抽查四份分项报告中的高优先级差距、相应源码和提交；未运行构建、测试、Desktop、原生 CLI，也未验证真实服务行为。

## 源事实复核与最终处理

1. **已解决：大型历史的两处边界。** `90abc1d3` 同时修改 JSONL 累积和 upstream `packages/host-runtime/src/remote-official-connection.ts:43-47` 的 `maxPayload:0`；fork 远程连接仍限 128 MiB。最终 [protocol-runtime.md](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/protocol-runtime.md) 第 9–13 行及 [tasks.md](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/tasks.md) U02 已分成线性读取和私有 WebSocket 上限两个切片，分别要求验收；没有把无限 payload 推广到其他入口。

2. **已解决：Usage 差距与用户范围。** fork `renderer-model-client.ts:210-225` 已换 client 退订并用 generation 拒绝旧事件，`versioned-renderer-adapter.ts:1027-1034` 在路由换 client 时重连。最终 [desktop-renderer.md](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/desktop-renderer.md) 第 9、23 行及 [tasks.md](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/tasks.md) U09 仅将现有订阅视为连接重构的回归约束；额度/Usage 功能不在 35 张卡内。

3. **已解决：权限继承失败语义。** fork `external-thread-fork.ts:132-144` 缺选择来源 Permission Mode；upstream `external-thread-fork.ts:208-232` 吞失败后继续 fork，而 fork `external-thread-rollback.ts:88-103` 对可选择模式恢复失败返回错误。最终 [protocol-runtime.md](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/protocol-runtime.md) 第 33–37 行与 [tasks.md](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/tasks.md) U05 要求区分 live-select、fixed-at-create、原生继承和未知模式，失败不得静默放宽，恢复路径需读回。

4. **已解决：CodeBuddy 作用域的证据等级。** `09726829` 的源码差距成立：fork `interactions.ts:85-94` 把 `allow_always` 映射为 `allowAlways`，upstream 第 103–110 行映射为 `allowForSession`。真实原生作用域本轮未验；最终 [existing-harnesses.md](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/existing-harnesses.md) 第 12 行与 [tasks.md](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/tasks.md) U15 已把上游注释/单测和待取得的固定版本原生证据分开。

## 最终稿剩余问题

抽查范围内无剩余明确问题。U05 曾写“无其他任务依赖”，与 U28/U29 的依赖冲突；最终 [tasks.md](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/tasks.md) 第 56 行已改为“自身无前置，U28/U29 依赖本卡”。

## 抽查成立的边界

- [native-update.md](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/native-update.md) 的官方辅助 app-server 路由缺口成立：upstream `crates/shim/src/lib.rs:341-435` 加入精确 `model_provider=openai-memgen` 与非 Desktop originator 例外；fork 第 377–417 行仅按参数形状决定 Host 路由。`66bedaed` 来源可定位。该条的 Skysight/Computer Use 现场影响仍属于推断，报告已注明未验。
- Node PATH 的 `c9ebf7fe` 来源与 `unshift`（fork `node-runtime.ts:18-21`）至 `push`（upstream 第 21–24 行）的差异成立。措辞宜限定为保留现有 PATH 搜索顺序并把 Host Node 作为兜底；是否选中正确 Node 仍取决于实际 PATH 内容。
- 官方 socket 符号链接差距成立：fork `remote-official-app-server.ts:82-91` 只认 socket；upstream 第 63–94 行接受符号链接并检查链接 owner、目标 owner/socket/私有权限，`2e6e1bf1` 来源成立。安全承诺应限于该链接分支；upstream 普通 socket 分支没有同样的 owner/mode 检查。清理须保留 inode 身份判断及 fork 的进程停止顺序。
- fork 的 process anchor、`resourceLifecycle.suspend`、observer、capability 和多账号 runtime pool 在分项报告中均被标为保留/单独设计，未发现建议直接删除这些定制的条目。上述只是静态边界抽查，不等于这些功能经过运行验收。

## 未覆盖

最终 [README.md](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/README.md) 列 35 项，17 个 P1、14 个 P2、4 个 P3；[tasks.md](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/tasks.md) 对应 35 张卡，U11/U21/U36/U38 留空且未成为隐含依赖。抽查的 `npm run build:typescript`、`npm run typecheck`、`npm run build:renderer`、`node tools/check-boundaries.mjs`、Shim Cargo 包名和列出的定向测试文件均存在；命令未执行。未逐项复核全部候选、每一行引用、发行说明或许可证结论；产品与测试验收均未运行。
