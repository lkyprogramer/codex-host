# R2 权限与恢复改造结果

工作树 `/Users/luo/Documents/github/codex-host-r1`，分支 `codex/upstream-r1`，HEAD 仍为 `af255febcba902a70d16cfec9271dfa2c5cd6ae9`。在未提交的 R1 上继续实施，没有提交、推送或启动 Desktop。

**最终状态：七项范围内改造及评审发现的问题已完成本地修复与验证。原生 Astra / high 再审确认 U12 及修补期间三个 P2 全部关闭，无新增明确 P1/P2。最终 Host 回归 214 passed，typecheck、lint 和 diff 检查通过；详见 [修复记录](REPAIR.md)。**

按用户最新要求，**U15 / CodeBuddy 排除，本机未安装，不作改造**。本轮落实 U05、U06、U08、U12、U16、U17、U18 七项。

## 结果

| 任务 | 已实现行为 | 边界 |
| --- | --- | --- |
| U05 | Fork 继承源 Session 的有效权限；必要时选择并读回确认；固定创建期权限不匹配则拒绝；确认后的模式写入恢复路由，重启继续读取 | 不允许静默回到更宽默认模式；失败关闭派生 Session、移除临时 Host 记录。原生历史没有公共删除接口，可能保留；失败响应给出 Native Session ID，关闭/移除失败另行列出 |
| U06 | macOS 争锁时用 `/bin/ps` 查询 PID 启动时间，确认与锁记录不同后才认定 PID 被复用；查询有 1 秒上限 | 时间缺失/非法、查询失败、未知 kill 查询错误保守保留锁；保留现有锁文件协议 |
| U08 | Controller 串行处理 attachment、并发返回 busy；Launcher 暂态错误按 100 ms→1 s 退避，连接/写入/分片读取受原期限约束 | nonce 拒绝和格式/权限错误不重试；控制端仍可连接时不清理 descriptor；不重启真实 Desktop |
| U12 | 已打开/新打开的原生子代理 Thread 从 Host live 状态初始化 running；终态先更新 live map，再由受管理任务刷新历史；新状态/关闭取消旧刷新，迟到读取与出队通知被过滤；已提交身份映射保持一致 | 普通 Thread 不被标记为 child active；旧终态不覆盖新的 active；保留 observer 真源 |
| U16 | OMP 对未跟踪调用的迟到 update/end 不再 fault 整个 Session；已跟踪调用继续检查名称和载荷 | 不吞掉所有协议错误，不修改订阅或自主 Turn 的原有语义 |
| U17 | Pi 原生取消结算默认窗口从 2 秒调为 30 秒，继续要求 abort acknowledgement、agent_settled 与 state 读回 | Host 替代请求仍限 20 秒；过期后绝不补启动替代 Turn，但迟到的合法 native 结算可完成；close/释放期限未扩大 |
| U18 | Host 托管 OpenCode server 从单独可写临时目录启动；各 Session 请求仍使用原项目 directory | 只清理本次托管目录；树停止失败保留句柄供重试；不接管外部 server |

### 主要路径

- Host：`packages/host-runtime/src/external-thread-fork.ts`、`external-thread-runtime.ts`、`app-server-host.ts`、`external-turn-steering.ts`。
- 锁：`packages/mapping-store/src/mapping-store.ts`，新增 `test/macos-lock.test.ts`。
- 启动恢复：`crates/launcher/src/desktop_attachment.rs`、`main.rs` 内定向测试；`packages/desktop-control/src/controller-attachment-server.ts`。
- Adapter：`packages/adapters/{omp,pi}/src/*-rpc-session.ts`、`packages/adapters/opencode/src/server-connection.ts` 及对应测试。
- 精确文件清单见 `r2-files.txt`；进入 R2 前的 15 个 R1 tracked 改动文件 SHA-256 见 `r1-baseline.json`，最终逐一相同。

## 验证记录

所有 TS 命令在该 worktree 下，使用 Node **22.22.0**，并移除环境 `NODE_USE_ENV_PROXY`，避免与本地离线 fixture 无关的实验代理警告污染输出。没有改弱断言或跳过失败用例。

| 检查 | 实际结果 |
| --- | --- |
| `npm run build:typescript` | 通过，含插件构建 |
| `npm run typecheck` | 最终通过 |
| `npm run lint` | 最终通过，含包边界检查 |
| 主代理首轮 Host/Adapter/Controller 组合测试 | 9 文件、311 passed；之后针对修改的 Host 文件重跑，见下文，不把重复运行加总为独立用例数 |
| 最终 U12 后 Host 两文件全测 | 190 passed；随后新增 U05 清理错误测试并定向重跑最终权限/fork/child 场景 12 passed、158 按名称过滤未运行（含读回失败且清理失败） |
| Mapping Store（子代理） | 4 文件、55 passed，包含 macOS 真实本机子进程身份 + `/bin/ps` 场景 |
| OpenCode `sdk-transport.test.ts`（子代理） | 14 passed；测试类型错误修复后重跑通过 |
| Pi RPC + steering（主代理） | 2 文件、67 passed；亦在组合测试中覆盖 |
| OMP RPC（子代理） | 20 passed；亦在组合测试中覆盖 |
| Controller attachment（子代理） | 5 passed；亦在组合测试中覆盖 |
| Launcher Rust（子代理） | 完整包首次 48 单元 + 4 CLI 通过；之后修复分片响应期限并新增一例，定向 `controlled_attachment` 7 passed |
| 格式与 diff | 修改的 TS/MJS 使用 Prettier；`cargo fmt --all --check`、`git diff --check` 通过 |
| 独立复核 | 早期子代理实际为 Sol / medium；此前请求参数或名字不能证明 Astra / high。最终原生 Astra / high 再审确认 U12 与修补期间三个 P2 均关闭，无新增明确 P1/P2；见 REPAIR.md |

### 主代理定向测试命令

```bash
npx vitest run --config tests/vitest.config.js \
  packages/host-runtime/test/app-server-host.test.ts \
  packages/host-runtime/test/external-thread-runtime.test.ts \
  packages/host-runtime/test/external-subagent-threads.test.ts \
  packages/host-runtime/test/thread-observer-runtime.test.ts \
  packages/host-runtime/test/external-turn-steering.test.ts \
  packages/host-runtime/test/managed-harness-session.test.ts \
  packages/adapters/pi/test/pi-rpc-session.test.ts \
  packages/adapters/omp/test/omp-rpc-session.test.ts \
  packages/desktop-control/test/controller-attachment-server.test.ts

npx vitest run --config tests/vitest.config.js \
  packages/host-runtime/test/app-server-host.test.ts \
  packages/host-runtime/test/external-thread-runtime.test.ts

npx vitest run --config tests/vitest.config.js \
  packages/host-runtime/test/app-server-host.test.ts \
  -t 'fork|Permission Mode|terminal child status'
```

首个组合命令曾额外传入不存在的 `packages/adapters/opencode/test/server-connection.test.ts`，实际仅收集上述 9 个文件；没有把它算作 OpenCode 验证。OpenCode 随后由其 owner 运行真正的 `sdk-transport.test.ts`，14 项通过。

Rust 使用 `CARGO_TARGET_DIR=/Users/luo/Documents/github/codex-host/target` 复用本地缓存：

```bash
cargo test --locked -p codexhost-launcher
cargo test --locked -p codexhost-launcher controlled_attachment
cargo fmt --all --check
```

### 失败与修正

- 整合 typecheck 发现新增 OpenCode 测试中的数组项可能 undefined：改为明确检查后再读取，测试与类型检查通过。
- 最后 lint 发现 U12 测试 `Promise.withResolvers<void>` 不符合仓库约定：改为 `undefined` 及明确 resolve 值，最终 lint/typecheck 通过。
- 评审发现 U12 终态刷新期间 live map 滞后：先更新 map，加转换 token 与可控时序回归；完整 Host 测试重跑通过。
- 主代理发现 U08 `read_line` 的逐次 socket timeout 不能约束慢速分片总时间：改为按绝对期限的非阻塞短行读取，新增实际 TCP 分片 fixture 并通过。
- U05 权限失败不能被称为“删除派生历史”：公共合同只有 close，没有 native delete。本轮改为明确报告可能残留的原生 ID 和清理失败，不引入未经定义的破坏性删除接口。

## 验证与产品边界

1. U05 的 fixture 证明 Host 在拒绝/抛错/模式不匹配时不注册 ready Thread，正常清理可移除 provisional、关闭 Session，源权限不变，并验证成功继承后的恢复路由；不证明各真实 Harness 都删除了原生派生历史。成功 open 后的原生历史可能留存，需要在对应原生工具中识别，错误会给出 ID。close 或临时记录移除失败会明确返回失败项与 Host ID。
2. U06 只增强 PID 身份判断；现有 stale-lock rename 协议未重写，仍不是对多个进程同时抢占/回收旧锁的完整原子性证明。不能把本轮测试描述成“所有锁竞态已消除”。
3. U08 使用真实本机 TCP fixture，但没有执行完整 `acquire_launcher_ownership` 的 Desktop guard/descriptor 端到端启动；未启动或重启用户 Desktop。
4. U17 假时钟证明 1 秒/5 秒/25 秒结算可完成，30 秒始终不 settled 会失败；20 秒已过期的 steer 即使收到迟到 terminal 也不会启动新 Turn。真实 Pi 慢工具取消未验。
5. U18 使用 fake spawn/client + 实际临时目录验证权限/不存在项目/两项目 directory/连接失败/重试停止，未运行真实 OpenCode server。新 worktree 测试未额外启用 native anchor，不声称新增 anchor 真机验收。
6. 未运行真实 Harness/模型、真实 SSH、目标 Windows/Linux 系统、全仓套件、安装/升级、发布或生产数据操作。

## 评审执行身份更正（过程记录，最终状态见文首）

`r2_astra_final_review` 与 `r2_astra_high_verified` 实际会话均为 `gpt-6-sol / medium`：默认角色配置覆盖了派发参数，省略角色也未解决。前者的初步意见移至 `SOL-REVIEW.md`，不算用户要求的 Astra 终审；后者在开始评审前已停止。没有修改用户全局代理配置。

改用独立只读 CLI 评审：`codex exec -s read-only -m gpt-6-astra -c 'model_reasoning_effort="high"'`。探测会话 `01a0dbc4-3d81-7632-8abc-10b1daf0198a` 和正式评审会话 `01a0dbc5-992e-7770-b346-744534689a09` 的持久化 `turn_context` 均核验为 `model=gpt-6-astra, effort=high`。正式评审发现 U12 终态刷新阻塞同一输出队列，后续 running 无法及时使 token 失效，尚未修复。R2 不宣称已完成。

- 终审前修复：Fork 权限读回返回失败时进入统一清理路径；清理失败给出 Native/Host ID 与失败项；清理成功保留原映射错误码。新增相应定向回归，12 项通过。

## 来源与回滚

参考上游语义：U05 `7a5ad219`、U06 `0323f438`、U08 `07e72f6f` / `506a08fa`、U12 `3cd01e58`、U16 `b9b598ba`、U17 `55868740`、U18 `7a6fb671` / `2f2ab4ea`。按本 fork 的现有接口与生命周期实现，不整树移植；U05 特意不采用上游吞权限选择错误的行为，U17 不扩大所有 Harness 的 Host 超时。现有 LICENSE 未改，本轮没有发布或作整体许可证合规结论。

可按各 owner 范围撤回 R2；U08 两端协议逻辑与 U05 权限/恢复接线应成套回退。权限保存继续使用已有 transport route 格式，没有数据库或原生历史迁移。撤回时只处理 `r2-files.txt` 对应本轮 hunk，保留 R1 和用户文件，不删除原生历史或用户配置。

## 原生子代理派发验证

用户要求先验证原生接口后，直接以 `agent_type=default, model=gpt-6-astra, reasoning_effort=high, fork_turns=none` 派发最小探测 `/root/astra_explicit_probe`；会话 `01a0dbc7-ca01-7380-854e-c2b0dbfc1f94` 的 turn_context 仍为 Sol / medium。官方 Subagents 文档 Custom agents 节明确：自定义角色文件中的 model/effort 优先；此前先解析显式 spawn 值，再全局 agents 默认值，再父会话值。因此应区分角色文件与全局默认值，不把接口本身称为无法指定模型。未修改用户全局配置，也未新增评审角色。

来源：https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents

## 原生初次终审（后续修复已完成）

用户授权创建 Astra / high 评审配置后，新增 astra-code-reviewer.toml；当前会话尚不识别新角色名，因此将已知 reviewer.toml 的 model 改为 gpt-6-astra，保留 high 和只读设置。原生 reviewer 子代理会话 `01a0dbe7-1910-7303-bee9-8f168921b99f` 的探测/正式评审两次 turn_context 都核验为 Astra / high。没有重启应用，没有恢复 default.toml，本轮终审未使用 CLI。

完整结果见 NATIVE-ASTRA-REVIEW.md：独立确认 1 项 U12 P2，未发现其他明确 P1/P2。R2 代码没有在评审期间修改，候选 19 文件哈希与 R1 15 文件基线一致。R2 仍待修复 U12 后才能收口。

## 最终修复与验证

U12 原始队列阻塞和修补复核发现的三个 P2 全部修复。最终原生 Astra / high reviewer 只读确认无新增明确 P1/P2。历史段落中的“尚未修复/仍待修复”仅描述当次评审状态，当前状态以本节及 REPAIR.md 为准。

最终实际执行（Node 22.22.0，env -u NODE_USE_ENV_PROXY）：

```bash
npx vitest run --config tests/vitest.config.js \
  packages/host-runtime/test/app-server-host.test.ts \
  packages/host-runtime/test/external-thread-runtime.test.ts \
  packages/host-runtime/test/managed-harness-session.test.ts
npm run typecheck
npm run lint
git diff --check
```

结果：三个文件 214 passed；typecheck、lint（含边界）、diff 检查通过。生产改动仅限原 R2 Host 文件，本次增加/强化真实输出队列、磁盘提交、writer 背压、等待取消与超时回归；R1 的 15 个源文件字节不变。没有提交、推送、重启或运行真实 Harness/Desktop。其余真实环境未验证边界保持不变。


## 后续提交授权

2026-09-26 用户授权整理全部改动并分批提交，随后继续 R3。上文“未提交”等描述保留为实施当时的证据边界；后续提交清单见 `docs/upstream-r3/plan.md`。
