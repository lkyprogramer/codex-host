# AI 实施任务卡

适用基线与排序见 [主清单](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/README.md)。本文件只定义后续工作，**所有开发、测试、原生 smoke 均未在本轮执行**。用户已排除 Session 历史导入、多账号、凭据与额度改造；U11/U21/U36/U38 不生成实施卡。

## 所有任务共用的执行合同

1. 先读仓库 AGENTS.md，检查 `git status --short`、HEAD、相关源码/测试；重验卡片缺口是否仍存在。当前 fork 基线 `af255febcba902a70d16cfec9271dfa2c5cd6ae9`，参考上游 `997f62a0ede22609ed42b949957100d16043ad17`。基线变化后重核受影响路径，不盲用旧行号。
2. 复制上游代码前记录具体提交、文件和适用许可证；遵守[来源说明](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/evidence.md)。提交哈希是研究线索，不是 `cherry-pick` 命令清单；只提取最终仍存在的改动。
3. 保留 native anchor、owned-process API、ManagedHarnessSession、resourceLifecycle、delegation/observer、capability、持久化提交与 conformance 合同。Host 不新增 Harness 名称分支来模拟原生能力；Renderer 不解析原生私有存储。
4. 每个可独立验收切片单独实现和检查，不顺便更新依赖或改账号/额度。当前任务不授权开发；后续用户明确选择实现时，按其授权做本地修改。启动当前 Desktop、安装/更新/发布、真实凭据访问、push/PR 等不由本文件自动授权。
5. 先运行最小定向测试；涉及公共接口补 typecheck/boundary，视觉改动做实际渲染。使用真实 Harness 时固定版本、临时目录和可追踪 Native Session，fixture PASS 与原生 PASS 分别报告。不能因测试 fixture 能解析就开放未验证的原生 capability。
6. 完成输出：实现的行为、代码位置、精确命令及结果、未覆盖层、回滚边界、仍存在的限制。高风险任务交独立 reviewer。没有确切缺口则记录“不需修改”并结束。

以下 `F:`、`U:` 为文件所有权标记，分别指当前 fork 和固定上游树；完整路径与行号见对应分域报告。卡中“验证文件”是现有测试入口或明确标记的新文件建议；不是已执行证据。

## P1：底层与已有能力

### U01 · 官方辅助 app-server 路由

- **证据 / owner：** [`66bedaed`](https://github.com/BytePioneer-AI/codex-host/commit/66bedaed)，[Native 对照](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/native-update.md) P0-1；owner 为 `crates/shim`。F `should_start_host_runtime` 缺少 `openai-memgen` 与非 Desktop originator 例外。
- **目标 / 边界：** 官方辅助调用回到 stock Codex；普通 Desktop 仍走 Host。保留 SSH proxy、默认 Unix listener、anchor 注入和官方 CLI 验证；不将所有 `-c` 或非标准参数一律旁路。
- **步骤：** 提取精确 config key/value 与 originator 判断；覆盖 `-c value`、`--config=value`、子命令前后参数；再接路由。单独覆盖只是定义 provider、没有选择它的反例。
- **验收：** 正常 Desktop、memgen、辅助 originator、proxy/daemon 各命中正确目标；`cargo test --locked -p codexhost-shim --lib`，相关 `crates/shim/tests/proxy.rs` fixture；真实摘要 smoke 另记未验或实测。
- **风险 / 回滚：** S、中；误判会让主服务旁路。仅回退路由例外，不能回退整个 Shim/anchor 文件。无依赖。

### U02 · 大历史传输：线性解析与远程 payload 分开验收

- **证据 / owner：** [`90abc1d3`](https://github.com/BytePioneer-AI/codex-host/commit/90abc1d3)，[协议对照](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/protocol-runtime.md) 1；F `protocol-core/src/jsonl.ts` 逐块拼接，`host-runtime/src/remote-official-connection.ts:40` 限 128 MiB。
- **目标 / 边界：** 已管理会话的大历史完整可读，避免长帧重复复制。不是增加原生 Session 导入；只调整私有官方 app-server 连接，不给所有网络入口取消限制。
- **步骤：** U02-a 将读取器改为 chunk 累积、只在完整 LF 帧拼接，保留空帧/非法 UTF-8/尾部不完整错误；U02-b 对私有官方连接核对上游 `maxPayload:0`，保留 loopback/Unix endpoint 和背压。两切片可分别提交。
- **验收：** `packages/protocol-core/test/jsonl.test.ts` 覆盖 chunk 内多帧、跨块 UTF-8、单长帧、显式限额及残帧；`packages/host-runtime/test/remote-official-connection.test.ts` 覆盖超过旧 128 MiB 阈值的完整响应、断连与背压。用可重复输入记录耗时/内存，未测前不承诺加速倍数；普通小请求顺序不变。
- **风险 / 回滚：** M、中；放宽 payload 有内存成本，线性读取不等于常量内存 JSON 解析。回退 parser 与 WS 选项可以分开，但不得声称只做 a 就完成“远程大历史”。无依赖。

### U03 · 官方 socket symlink 与 SSH

- **证据 / owner：** [`2e6e1bf1`](https://github.com/BytePioneer-AI/codex-host/commit/2e6e1bf1)，F/U `packages/host-runtime/src/remote-official-app-server.ts`；[协议对照](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/protocol-runtime.md) 2。
- **目标 / 边界：** 接受属于当前用户、目标为私有 socket 的合法链接；清理只针对本次创建且身份仍匹配的路径。上游链接分支有 owner/mode 校验，不因此宣称所有非链接分支也有相同保证。
- **步骤：** 局部补 link/target 区分；覆盖 dangling link、替换竞态与启动失败清理；保留 fork official lifecycle stop 顺序。不要删除指向的用户 socket。
- **验收：** `packages/host-runtime/test/remote-official-app-server.test.ts` 的 socket、symlink、非 socket、错误 owner/mode、失败启动 fixture；随后隔离 SSH 环境验证本地/远程连接与退出。fixture 与真实 SSH 分别报告。
- **风险 / 回滚：** M、中；回退链接支持和对应清理分支；无依赖。

### U04 · npm 平台包与 CLI 版本一致性

- **证据 / owner：** [`53795e97`](https://github.com/BytePioneer-AI/codex-host/commit/53795e97)，F/U `scripts/release/prepare-npm.mjs`；[Native 对照](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/native-update.md) P0-2。
- **目标 / 边界：** 解析实际平台 package.json 并在运行 native 载荷前要求版本匹配；保留 fork anchor 的所有打包条目、global/symlink fallback 和本地版本格式。
- **步骤：** 在生成 launcher 的实际解析结果上检查元数据；不只检查声明依赖版本。错误提示指出需要修复整套 CLI + platform 安装，不能继续启动错配载荷。
- **验收：** `tests/release/npm-package.test.mjs` 覆盖版本一致、不一致、无效元数据、fallback 与本地 prerelease；错误时没有 native spawn。平台安装 smoke 仅在相应环境另验，不实际升级当前安装。
- **风险 / 回滚：** S、低；回退单一启动前 guard。无依赖。

### U05 · fork 权限继承，不复制静默失败

- **证据 / owner：** [`7a5ad219`](https://github.com/BytePioneer-AI/codex-host/commit/7a5ad219)，F `packages/host-runtime/src/external-thread-fork.ts`；U helper `inheritSourcePermissionMode` 在失败时继续。F rollback 已有更严格的配置失败处理，优先复用相同语义。
- **目标 / 边界：** 以 `SessionStateObserver` 的 effective mode 为真源，支持时继承、读回并保持恢复后的模式；不能把权限复制失败解释为成功继承。不得将 Codex 权限档位硬映射到原生模式。
- **步骤：** 先列 live-select、fixed-at-create、原生继承、缺失/未知模式四种情况；采用 fork 现有 open/configuration 合同。可选择时 select 失败必须清理 provisional/derived 资源并明确失败，或按明确合同返回不继承结果，不能静默扩大权限。fixed-at-create 若无可靠传递方式，不伪造支持。核对 requested/effective 与持久化恢复一致性。
- **验收：** 扩展 `packages/host-runtime/test/app-server-host.test.ts` 的 fork 场景及 `external-thread-repository.test.ts` / `harness-session-validation.test.ts` 的必要用例；source 模式、derived 模式、失败清理、restart resume、源 Session 未改变。声明原生支持的 Adapter 另用 fixture/native 读回。
- **风险 / 回滚：** M、高；自身无前置，U28/U29 依赖本卡。回退新增继承接线；若新版本持久化了字段，回退 reader 必须能读取，不能删已产生 Session 数据。

### U06 · macOS stale Mapping Store 锁

- **证据 / owner：** [`0323f438`](https://github.com/BytePioneer-AI/codex-host/commit/0323f438)，F `packages/mapping-store/src/mapping-store.ts:117` 在非 Windows 只证明 PID 活着，没有查询启动时间。
- **目标 / 边界：** 只有身份信息足以证明旧 owner 已消失时才恢复锁；查询失败/权限不足保持保守，不删除活进程锁。不要把本任务变成全局锁协议重写。
- **步骤：** 补 macOS `/bin/ps` 启动时间查询及可注入测试边界；核对时间精度容差、同 PID 自身分支、旧锁格式；保留现有原子创建、持久化和 cleanup。
- **验收：** 借 U `packages/mapping-store/test/macos-lock.test.ts`（F 待新增）场景，加活 owner、PID 复用、无法查询、缺 metadata、并发竞争；在 macOS 跑定向用例。不以 mock 判断替代真实进程身份 smoke。
- **风险 / 回滚：** M、高；误回收会允许双写。回退 macOS 身份分支，不迁移锁格式；无依赖。

### U07 · Harness PATH 尊重已有 Node

- **证据 / owner：** [`c9ebf7fe`](https://github.com/BytePioneer-AI/codex-host/commit/c9ebf7fe)，F `packages/harness-discovery/src/node-runtime.ts` 当前 `unshift`，上游 `push`。
- **目标 / 边界：** 已有 PATH 决定 Node，Host runtime 目录仅在缺失时补在末尾。不是挑选“最新 Node”；原有 Node 不兼容时由对应发现/启动错误报告，不能另设隐藏覆盖规则。
- **步骤 / 验收：** 改顺序并扩展 `packages/harness-discovery/test/resolve.test.ts`：空 PATH、已有 runtime、版本管理器 shim、Windows PATH key 大小写及目录去重；验证 owned-process spawn 获得同一环境。所有 spawn 仍经 fork API。
- **风险 / 回滚：** S、中；回退插入顺序。无依赖。

### U08 · Launcher / Controller attachment 恢复

- **证据 / owner：** [`07e72f6f`](https://github.com/BytePioneer-AI/codex-host/commit/07e72f6f)、`506a08fa`；F/U `crates/launcher/src/desktop_attachment.rs`、`packages/desktop-control/src/controller-attachment-server.ts`。
- **目标 / 边界：** Controller 忙碌、读超时或连接断开时做有界退避；总启动期限不被重置。复用 descriptor/activation guard，不能重复启动长期进程。
- **步骤：** 明确协议 busy 响应；再实现 Launcher 暂态分类与 100 ms→1 s 上限退避。取消/永久错误立即退出；不要把权限或格式错误归成可重试。
- **验收：** `cargo test --locked -p codexhost-launcher` 中相关 fixture；`packages/desktop-control/test/controller-attachment-server.test.ts`。并发重开、超时后恢复、耗尽期限、断连不得留下重复 controller；真实重开会影响 Desktop，后续需单独安排。
- **风险 / 回滚：** M、中；双端一起回退，保证旧新 busy 行为的兼容说明。无依赖。

### U09 · 稳定 Host 连接与 Composer 发送路由

- **证据 / owner：** [`af10d665`](https://github.com/BytePioneer-AI/codex-host/commit/af10d665)、`5a1ae98c`、`65bbcf28`；[Renderer 对照](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/desktop-renderer.md)。主要 owner 为 desktop-control + renderer-extension。
- **目标 / 边界：** 连接查询不依赖某个编辑器 DOM 存活；发送仍依当前 Composer/Host/cwd 精确路由。新建/替换 draft、side-chat 不串路由。**不开发额度、Usage 或账号功能**；现有订阅、capability 和双 draft ID 仅做不退化约束。
- **步骤：** U09-a 对比 committed React ancestor / request manager 发现；U09-b 分离稳定 Host clients 与 Composer route；U09-c 校正 draft 选择继承和相关 sidebar 扫描范围。保留现有 route resolver 的有效部分，不整搬巨型 binding 文件。
- **验收：** `packages/renderer-extension/test/versioned-renderer-adapter.test.ts`、`agent-selection-state.test.ts`、相关 desktop-control policy 测试；Playwright `tests/e2e/renderer-chat-composer-isolation.spec.ts`、`renderer-binding-startup.spec.ts`。覆盖无 Composer、本地/远程、多个编辑器、draft 替换、已锁 Thread、Host 断开；实际 Desktop 绑定另验。
- **风险 / 回滚：** L、高；私有 React 合同漂移。三切片各保留明确入口，可回退连接 discovery 与路由接线；不添加永久双重事实源。可先独立做 U10 的 set/CDP 小修，最终再整合。

### U10 · Renderer 稳定性三项小修

- **证据 / owner：** [`0873a682`](https://github.com/BytePioneer-AI/codex-host/commit/0873a682)、[`2cb157a1`](https://github.com/BytePioneer-AI/codex-host/commit/2cb157a1)、[`55a097ab`](https://github.com/BytePioneer-AI/codex-host/commit/55a097ab)；[Renderer 对照](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/desktop-renderer.md)。
- **步骤：** U10-a Agent catalog 按身份集合判等，不能只因列表重排重注入；U10-b CDP target 缺少可附着入口时跳过并继续找有效候选，全部无效应失败；U10-c mounted control 重新绑定 live send button，释放旧监听但保留菜单状态。每项单独 diff 和测试。
- **验收：** `packages/desktop-control/test/cdp-client.test.ts` / `production-controller.test.ts`、`packages/renderer-extension/test/renderer-binding-probe.test.ts`；按钮替换、菜单打开时重排、坏 target 排首位、catalog 实际增删。检查没有重复控件/observer，不单靠快照证明交互。
- **风险 / 回滚：** M、中；c 与 U09 共享 DOM/binding owner，串行整合。每个函数可独立回退；不修改额度 gate。

### U12 · 打开的 Subagent Thread 运行态

- **证据 / owner：** [`3cd01e58`](https://github.com/BytePioneer-AI/codex-host/commit/3cd01e58)；F `packages/host-runtime/src/external-thread-runtime.ts` 注册初始 `running:false`，Host 另有 subagent status 真源。
- **目标 / 步骤：** 注入既有状态读取回调，仅对对应 child 在 register/open 时设置当前 active。parent 终态与 child 仍运行可以共存；不从标题、映射文件或保存过的最后状态推断 live。
- **验收：** `packages/host-runtime/test/external-subagent-threads.test.ts`、`external-thread-runtime.test.ts`，必要时 `thread-observer-runtime.test.ts`：运行中打开、立即结束竞态、重读、普通 Thread、孤儿/未知状态；observer 的 terminal 不被旧事件反转。
- **风险 / 回滚：** S、中；回退初始状态接线即可，不改变持久化身份。无依赖。

### U13 · 同一 Turn 文件变更汇总

- **证据 / owner：** [`ee45196f`](https://github.com/BytePioneer-AI/codex-host/commit/ee45196f) 及 `f506c9fd`、`3668e648`；U `packages/protocol-core/src/file-change-summary.ts`，F projector 仍主要按单 item patch 投影。
- **目标 / 边界：** 同一路径的 add/edit/delete 合并成准确展示；原始 items 与 sourceItemIds 仍可追踪。不回写 Native Session，不把展示汇总当作文件回滚证据。
- **步骤：** 抽纯汇总函数处理路径归一化与变更顺序，再接 live 和 snapshot/replay 相同入口；明确 add→edit、edit→delete、delete→add、两工具同文件的结果。
- **验收：** `packages/protocol-core/test/codex-ui-projector.test.ts` 与拟新增 `file-change-summary.test.ts`；相对/绝对路径、带空格路径、删除内容、重复 edits、replay 一致、未知 patch 不捏造。实际文件卡片渲染另验。
- **风险 / 回滚：** M、中；回退 projector 汇总入口与纯函数，不改原始历史。无依赖。

### U14 · DSH fractional retry delay

- **证据 / owner：** [`b685f36e`](https://github.com/BytePioneer-AI/codex-host/commit/b685f36e)；F `packages/adapters/deepseek-harness/src/modern/history.ts` 对 delayMs 要求整数。
- **目标 / 步骤：** 仅对原生 retry delay 接受非负有限小数；检查对应 profile validator，保持序号/计数等整数要求。不要全面放宽数字验证。
- **验收：** `packages/adapters/deepseek-harness/test/modern/history.test.ts` 及相关 profile 测试：0、正小数、负数、缺字段、Infinity/NaN 输入边界；合法重试历史可打开，坏 journal 仍失败。
- **风险 / 回滚：** S、低；单点谓词和测试回退。独立于 U27，先做。

### U15 · CodeBuddy 审批作用域

- **证据 / owner：** [`09726829`](https://github.com/BytePioneer-AI/codex-host/commit/09726829)；F `packages/adapters/codebuddy/src/interactions.ts:89` 为 `allowAlways`，U `:103` 映射 `allowForSession`。
- **目标 / 边界：** 显示和投影应与固定版本原生 option 的实际有效期一致。上游注释和单测是本轮证据，尚无真实 CodeBuddy 行为证据；不宣称原生已经由本轮验证。
- **步骤 / 验收：** 先取得脱敏原生 permission option fixture / 官方实现依据，确认跨 Session 语义；再改映射及 `packages/adapters/codebuddy/test/codebuddy-adapter.test.ts` 对应交互测试。单次、session、deny 区分正确，既有批准不被升级；若旧 enum 被持久化，明确显示兼容而非静默重解释。
- **风险 / 回滚：** S、中；原生证据不支持则停止该映射变更。回退映射与展示，保留已存审计事实。不是账号或额度功能。

### U16 · OMP 迟到的后台工具事件

- **证据 / owner：** [`b9b598ba`](https://github.com/BytePioneer-AI/codex-host/commit/b9b598ba)；F `packages/adapters/omp/src/omp-rpc-session.ts` 对未跟踪 update/end 会 fault。
- **目标 / 步骤：** 仅忽略已结束或未跟踪 call 的迟到 update/end；对正在跟踪的 tool 继续严格校验。保留 fork 自主 Turn 与 Subagent 事件处理，不宽泛 catch 全部协议错误。
- **验收：** `packages/adapters/omp/test/omp-rpc-session.test.ts`：父 Turn 结束后迟到 update/end、另一个有效 Turn 正运行、活动 tool 坏载荷、重复完成；Session 不被无关迟到事件关闭，真实错误仍可见。
- **风险 / 回滚：** M、中；回退窄分支，不能回退 fork subscription/owned-process。无依赖。

### U17 · Pi 取消结算及 Host 时限

- **证据 / owner：** [`55868740`](https://github.com/BytePioneer-AI/codex-host/commit/55868740)；F Pi `cancelTimeoutMs:2_000`，U 为 30 秒；F `ExternalTurnSteering` 默认 20 秒，`ManagedHarnessSession` 另有操作/释放上限。
- **目标 / 边界：** 请求 abort、原生 settled、state 读回是不同事实；慢收尾不能过早 fault，也不能在旧 Turn 未结束时启动替代。不能只把 2 改为 30 就宣布完成。
- **步骤：** 先画 cancel/steer/close/suspend 的时限和信号传播；定义内层等待与外层 abort/terminal 的关系，再调整 Pi 默认及必要的调用协调。close/release 继续有独立期限，不扩大所有 Harness 的全局超时。
- **验收：** `packages/adapters/pi/test/pi-rpc-session.test.ts`、`packages/host-runtime/test/external-turn-steering.test.ts` 和必要的 `managed-harness-session.test.ts`；覆盖 <2 秒、2–20 秒、20–30 秒、永久不 settled、cancel 与 close 竞态。假时钟固定顺序，真实 Pi 慢取消另验；没有 settled 不能报告取消已终结。
- **风险 / 回滚：** M、高；回退内层窗口与协调接线必须成套，不能保留半套时限。无依赖。

### U18 · OpenCode server 启动 cwd

- **证据 / owner：** [`7a6fb671`](https://github.com/BytePioneer-AI/codex-host/commit/7a6fb671)、`2f2ab4ea`；F/U `packages/adapters/opencode/src/server-connection.ts`。
- **目标 / 边界：** 托管 server 从可写隔离目录启动；Session 请求仍携带用户项目 cwd。仅管理 Host 启动的 server，不接管已有外部服务。
- **步骤 / 验收：** 明确目录选择/失败策略，再把 spawn cwd 与 request directory 分离；沿用 owned-process 和受管停止逻辑。扩展 `packages/adapters/opencode/test/opencode-adapter.test.ts` 或实际 server-connection 测试，覆盖只读项目、目录不存在、连接失败、两项目共用 server 的隔离。原生 managed server smoke 单独执行。
- **风险 / 回滚：** M、中；回退 server cwd 策略，不更改 Native Session 路径。仅在使用 managed server 时安排。

## P2：架构完善与实用功能

### U19 · 原生工作区命令与技能目录

- **证据 / owner：** [`77b4b975`](https://github.com/BytePioneer-AI/codex-host/commit/77b4b975)、`a014fbad`、`2491d23d`、`9a015338`、`8de2be76`；[协议对照](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/protocol-runtime.md) 7。owner 为 harness-adapter/shared-contracts/host-runtime，具体原生元数据归 Adapter。
- **目标 / 边界：** 新 draft 能查看当前 Harness + cwd 的可用命令/skills；查询有界且不挡普通 prompt。复用静态目录和已有 Session；是否需要 native discovery 必须在合同中明确，不能为菜单查询偷偷建长期 Session。不让 Host/Renderer 执行或读取 SKILL.md 私有语义。
- **步骤：** U19-a 定义 live catalog 状态、静态优先及 builtin 名称冲突规则；U19-b 在两个真实 Adapter 上验证 native metadata 接线；U19-c 增加按 Host/Harness/cwd 区分的缓存和取消/超时/失效；U19-d 规范命令 admission、被排除的 native 命令以及 fallback 条件。
- **验收：** 新增上游同类 live catalog/cache 定向测试，扩展 `packages/host-runtime/test/app-server-host.test.ts` 的 commands 分支；覆盖冷/热、慢/失败、跨 cwd、源命令变化、普通文本不查询、未知命令拒绝、首次 native catalog 未就绪、取消后不得继续执行。builtin、user skill 同名行为必须有测试，不能泛化过滤所有 skill。
- **风险 / 回滚：** L、高；依赖 U09 的正确 Host/cwd。可关闭 live capability 回到原静态目录；不损伤已保存 Thread。Host 继续复用 fork bounded call 与 admission。

### U20 · Composer `#` 菜单

- **证据 / owner：** [`16959adf`](https://github.com/BytePioneer-AI/codex-host/commit/16959adf)、`72f5f235`、`30e27e68`、`5d249053`；U `renderer-delegation-mention.ts` / `renderer-native-composer-controller.ts`，F 已有独立命令按钮和委派链。
- **目标 / 边界：** 同一菜单选择委派目标、命令和 skills；保留 fork 已有委派实现，不新增第二个 coordinator。命令 chip 只是路由载体，原生能力由 U19 提供。不可直接注入 Desktop 自身 React 管理的 slash 菜单。
- **步骤：** 先做公共 mention/chip 编解码和 Host admission，再接 UI 搜索、分组、键盘、focus/scroll、定位；旧按钮成为菜单入口，必要短暂回退路径明确删除条件。无参命令直接执行；有参命令插入 chip，保留其他 draft 和附件。
- **验收：** 输入普通 `#`、代码片段、多个 chip、空参数/多空格/tab/缩进、disabled 原因、无 Thread、Esc/Enter、重连、steer+取消。commands 请求失败必须保留原始错误，不降级为普通 prompt 执行；Host response/event 顺序与委派去重不退化。新增对应 Renderer/Host fixture，运行实际菜单渲染/键盘测试。
- **风险 / 回滚：** L、高；依赖 U19、U09；与 U10 同 Renderer owner 串行。回退菜单入口至既有 command UI，保持原协议对已有 chip 的可诊断拒绝；不要把持久化消息静默改写。

### U22 · 资源设置的只读 Session 视图

- **证据 / owner：** [`f00db6fc`](https://github.com/BytePioneer-AI/codex-host/commit/f00db6fc)，U `settings/loaded-sessions-table.ts`，F 已有 per-Session resourceLifecycle 和 Runtime 诊断；[Renderer 对照](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/desktop-renderer.md)。
- **目标 / 边界：** 显示已加载 Thread/Harness、是否运行、最近状态与现有释放结果。只读列表，不新增强杀按钮，不复制上游全局 idle-close，不在 UI 判定可安全回收。
- **步骤：** 先明确现有 Runtime 哪个对象为各字段真源，再做最小 browser-safe schema/RPC 投影；返回脱敏元数据，不带环境/凭据/原生 transcript。前端用当前样式组件显示刷新、空、断连、unknown/releaseFailed 状态。
- **验收：** 扩展 `packages/host-runtime/test/external-thread-runtime.test.ts`、`managed-harness-session.test.ts` 的状态投影及 settings tests；active、busy、unknown、releaseFailed、已释放各自不误报。列表读取不触发新 Session/释放；视觉验证长列表、窄窗、断连。
- **风险 / 回滚：** M、中；回退只读 RPC/UI。无需 Tailwind 升级或修改回收算法，无账号/额度信息。

### U23 · 活跃目录、模型收藏与小屏布局

- **证据 / owner：** [`7616cb28`](https://github.com/BytePioneer-AI/codex-host/commit/7616cb28)、[`a6350949`](https://github.com/BytePioneer-AI/codex-host/commit/a6350949)、[`fb4f94d8`](https://github.com/BytePioneer-AI/codex-host/commit/fb4f94d8)；[Renderer 对照](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/desktop-renderer.md) 的三个独立增量。
- **步骤：** U23-a 当前 Harness/Model 查询优先，批量 inspect 用已有后台调度能力；先核对 fork dispatcher 是否已有 priority 合同，再接调用，不能只给不识别的字段。U23-b 收藏键至少含 Harness + 完整 Model ref，按需含 Provider 身份，保存偏好并即时排序。U23-c 只补 chip 收缩、min-width、ellipsis，保留按钮定位。
- **验收：** 慢插件不阻塞当前选择；收藏跨重启不串 Harness/Provider、失效模型可移除、搜索不丢候选；窄窗/长模型名/侧栏展开不重叠且所有控件可点击。`renderer-model-picker.test.ts`、`renderer-binding-probe-host-catalog.test.ts` 与 `tests/e2e/renderer-model-picker.spec.ts`。已有 Usage chip 可参与布局回归，但不增加额度功能。
- **风险 / 回滚：** M、中；a 依赖 U09，c 跟随 U10。a/b/c 分开回退；旧版本忽略新增收藏偏好，不删除用户其他设置。不声称已实测加载加速。

### U24 · Claude `modelPicker.options`

- **证据 / owner：** [`b72878a1`](https://github.com/BytePioneer-AI/codex-host/commit/b72878a1)；U `packages/adapters/claude-code/src/model-catalog.ts:103`，F 只有 SDK 模型规范化。
- **目标 / 步骤：** 尊重 Claude 配置目录和 `replaceBuiltInOptions`，合并有效自定义模型；全无效 options 不能清空 SDK 列表。使用临时 settings fixture，不访问真实账号凭据，不修改登录/额度。
- **验收：** `packages/adapters/claude-code/test/model-catalog.test.ts` 覆盖追加/替换/空/非法/重复/无文件/custom config dir；picker 中编码的 ref 能原样送到模型选择边界。保持 fork Claude 项目 settings、认证错误分类及进程关闭修复。
- **风险 / 回滚：** M、中；回退 catalog 合并层，无持久化迁移。无依赖。

### U25 · OMP child transcript 冷恢复

- **证据 / owner：** [`f14a2f3d`](https://github.com/BytePioneer-AI/codex-host/commit/f14a2f3d)；U `packages/adapters/omp/src/omp-adapter.ts:349` 增加已保存 child JSONL 路径，F 已有 subagent subscription 与能力观测。
- **目标 / 边界：** 已管理的 OMP child 在重启后仍可打开。不是导入任意外部 Session，也不重新做订阅。文件读取只能从已知 parent 的原生目录与 child ID 推导。
- **步骤：** 移植纯文件名/realpath 边界、流式有界读取和现有 history parser；文件缺失再按合同走 RPC。上游 8 MiB 限制要给清楚的 too-large/不可读结果，不能截断后声称完整历史。
- **验收：** OMP adapter 定向 fixture：存在/缺失/非法 ID/越界符号链接/超限/并发追加/冷 RPC 回退；父子 identity 不串，未知 child 不创造假 Thread。真实 OMP 重启后读取另验。
- **风险 / 回滚：** M、中；推荐先 U12/U16。回退到原 RPC 读取；不修改或删除原生 JSONL。

### U26 · Pi 原生子任务工作流

- **证据 / owner：** [`90c09f04`](https://github.com/BytePioneer-AI/codex-host/commit/90c09f04)；U `pi-subagents.ts` / `pi-subagent-history.ts`；F 缺这套 native child 投影，已有主 Session 导入无须改动。
- **目标 / 边界：** 只对当前受管 Pi Session 的原生 child 状态与 transcript 建映射；区分 Pi 内部任务与 Host delegation，保留稳定 native child ID。
- **步骤：** 定义 parent/child identity 及生命周期映射；再做实时 RPC 事件、冷历史和恢复；声明 capability 前先验证原生扩展/版本可用。缺失 pi-subagents 支持时不伪装支持。
- **验收：** 新增对应 subagents/history tests，覆盖成功、失败、取消、并发 child、parent 已结束、缺 transcript、重启后 ID 不变。真实 Pi 扩展版本、资源清理与 observer readback 单独出证据。
- **风险 / 回滚：** L、高；依赖 U12 并与 U17 协调。关闭新增 capability/投影，不删除 Pi 原生文件。

### U27 · DeepSeek 新协议 profiles

- **证据 / owner：** [`5c0ca7b9`](https://github.com/BytePioneer-AI/codex-host/commit/5c0ca7b9)、[`3e8cc6f7`](https://github.com/BytePioneer-AI/codex-host/commit/3e8cc6f7)、`daaef03b`；F profiles 仍围绕旧 V0/V3 版本，U 增加 V4 与新版协议检查。
- **目标 / 边界：** 支持当前 DSH 的 journal、developer message、Assistant stream、fork closer、permissions 和工具输出。版本可尝试不等于协议可接受；未知格式必须明确失败。不新增 Session 导入界面/来源。
- **步骤：** U27-a 固定 V0/V3/V4 脱敏协议 fixture 和兼容矩阵；U27-b adapter profile/validation/history；U27-c reasoning 与 PowerShell 工具卡投影；最后调整声明的版本策略。保留 fork Session environment/递归委派隔离与 owned-process。
- **验收：** `packages/adapters/deepseek-harness/test/modern/history.test.ts` 及 profiles/session 相关测试；同原生版本下 resume/fork/revise/权限/取消/清理、跨版本 checkpoint 不混用。真实 DSH Gate 另行安排，本卡不使用付费模型作为默认单测。
- **风险 / 回滚：** L、高；依赖 U14。已产生 V4 原生历史后不能宣称旧 reader 可恢复；回滚要保留只读兼容 reader 或明确这些 Session 暂不可用，不改写原生日志、不做降级迁移。

### U28 · Cursor 原生 fork / revise

- **证据 / owner：** [`61b3cddf`](https://github.com/BytePioneer-AI/codex-host/commit/61b3cddf)、`e6a5cdca`；U `packages/adapters/cursor-cli/src/fork.ts` / bridge，F open 的派生模式返回 unsupported。
- **目标 / 边界：** 对现有受管 Cursor 会话做真实 head/history 派生；先证明 checkpoint 和独立 native identity，不用复制 Host transcript 模拟 fork。
- **步骤：** 先读原生 bridge/fixture，明确上游依赖 `/usr/bin/script` 的平台范围；通过 fork owned-process API 运行 bridge，补取消/超时/清理；校验源历史不变与派生边界后开启对应平台 capability。保留 fork 参数化模型、historyOnly replay、catalog cache 与 suspend。
- **验收：** Cursor adapter 单测新增 head/history fork、revise、空历史/坏 checkpoint、目标 cwd、取消/崩溃、model 参数；真实 Cursor 固定版本读取 native 源和派生 Session 并继续一轮。Windows 未证则继续 unsupported，不能从 Unix 结果外推。
- **风险 / 回滚：** L、高；依赖 U05。关闭 capability/bridge，不删除已建立原生 Session；确认旧 reader 能 resume 后才完整回退 Adapter。

### U29 · CodeBuddy 原生 fork / revise

- **证据 / owner：** [`74caabd3`](https://github.com/BytePioneer-AI/codex-host/commit/74caabd3)；U `deriveCodeBuddySession`，F `configuration.ts` 对派生 history capabilities 为 false。
- **目标 / 步骤：** 先把原生 history/checkpoint 校验与派生 profile 读清楚，再实现 prepared derived Session、读回、Host commit 和失败清理，最后开 capability。不得重新加入上游已撤回的 cwd trust preflight。
- **验收：** CodeBuddy history/adapter tests：head/history、revise、不同 cwd、源不变、native 派生后 Host 提交失败、清理失败；固定原生版本真实 continue readback。保留 fork 现有 ACP history/observer/anchor。
- **风险 / 回滚：** L、高；依赖 U05/U15。关闭派生能力；不通过删原生历史回滚。协议不满足则保持 unsupported。

### U30 · 更新 start 超时与真实失败分离

- **证据 / owner：** [`a611b6b9`](https://github.com/BytePioneer-AI/codex-host/commit/a611b6b9)、`b99c61e7`；F/U `packages/renderer-extension/src/settings/pages.ts`。
- **目标 / 边界：** 发起请求超时后继续观察 update status；后台完成后显示真实结果，不自动重复 start。只改 UI 状态机，不改安装器/账号，也不在验收中真正升级当前应用。
- **步骤 / 验收：** 扩展 `packages/renderer-extension/test/settings/update-request.test.ts`、`settings/pages.test.ts`，覆盖超时后 downloading/ready/failed、断连后恢复、点击去重。真实失败给 fork 当前配置对应的发布下载入口，不能硬编码上游 Releases 把用户换回原版。
- **风险 / 回滚：** S、中；依赖现有 update status 合同。回退页面状态机即可；进行中的后台更新仍交现有 coordinator 管理。

### U31 · CI 去重与缓存，保留 fork 验证

- **证据 / owner：** [`3fc1d6d7`](https://github.com/BytePioneer-AI/codex-host/commit/3fc1d6d7)、`5f0f8347`、`ff258869`、`cf017fcd`；U `.github/workflows/ci.yml:12` / `tests/vitest.config.js:14`，F 每个平台重复 `npm run check`。
- **目标 / 边界：** superseded PR 可取消，主线每个提交保留证据；复用 Rust dependencies，静态检查集中运行，平台行为仍在对应 OS 验证。**不要照抄上游用测试源码正则推断平台敏感性的过滤器**，它可能漏掉通过 helper 间接访问 OS 的测试。
- **步骤：** U31-a 单独加 CI concurrency/cache/cold build 配置并测冷暖运行；U31-b 明确平台测试 owner/清单后再去重。保留 F `tests/vitest.setup.js` anchor 注入、`test:typescript` 的 anchor build、Rust anchor crate、package/tsconfig 边界与 conformance；不能只拷上游 scripts 导致 anchor 不再测。
- **验收：** 仓库已有 workflow/release automation tests 做声明检查；比较前后每个测试文件在哪个平台运行，完整 Linux 主 lane 不删。实际 Actions 的冷/暖时长、失败保留栈、旧 PR 取消与主线不取消另验；没有运行数据不承诺节省百分比。
- **风险 / 回滚：** M、中；配置可独立回退。修改 workflow 是本地工作，触发远程 CI/push 需后续授权；无依赖。

### U32 · 官方 section_position 排序

- **证据 / owner：** [`8d5e43bd`](https://github.com/BytePioneer-AI/codex-host/commit/8d5e43bd)；F/U `packages/protocol-core/src/thread-management.ts`、`host-runtime/src/thread-list-aggregator.ts`。
- **目标 / 步骤：** 将官方分组位置排序判为 official-only，并透传 native cursor；时间排序仍合并外部 Thread。先核对当前 Desktop 是否实际发送这个 sortKey，不给外部 Thread 编造 section position。
- **验收：** `packages/protocol-core/test/thread-management.test.ts`、`packages/host-runtime/test/thread-list-aggregator.test.ts`：native cursor 原样、分页不重复/漏项、时间排序不退化。与 fork 自定义 delegation list 分页分开。
- **风险 / 回滚：** S、低；回退特定 sortKey 路由。无依赖。

### U33 · macOS sandbox 重入时受限 stock CLI 发现

- **证据 / owner：** [`8bb27d6a`](https://github.com/BytePioneer-AI/codex-host/commit/8bb27d6a)；F/U `crates/shim/src/lib.rs` 的 CLI 发现；[Native 对照](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/native-update.md) P2-6。
- **目标 / 边界：** 仅 macOS、顶层 `sandbox`、两个官方 CLI 覆盖均被清洗时，从 Desktop 管理路径找 stock CLI。其他直接调用继续 fail closed；不能变成任意 PATH 搜索或让 Shim 指向自己形成递归。
- **步骤 / 验收：** 先用隔离环境 fixture 复现缺 override 的 node_repl 重入；再加精确例外及普通命令/非 macOS/自指/坏路径反例。运行 `cargo test --locked -p codexhost-shim --features test-utils --test proxy` 的相关用例，真实 Desktop node_repl 另验。
- **风险 / 回滚：** M、高；与 U01 同 owner 协调，未复现需求可不实施。回退单一发现例外，保留 anchor 和其他 CLI 路由。

## P3：条件项，新 Harness 最后

### U34 · 隔离 Desktop profile 的显式路径覆盖

- **证据 / owner：** 上游 `ead8028d`、`1a2b4533`、`fa700d4e` 的最终路径逻辑，U `crates/launcher/src/desktop_path_overrides.rs`；只取启动路径部分，**不取这些提交的账号改造**。
- **适用场景 / 步骤：** 仅在调试、测试或明确隔离 profile 需求下立项。绝对目录白名单传递 HOME/USERPROFILE/ZDOTDIR/CODEX_HOME/USER_DATA_PATH 对应已支持变量，核对 `CODEXHOST_DATA_DIR` 与 descriptor；远程托管启动不注入本机路径。不得传整个环境或凭据。
- **验收：** Launcher 纯函数 fixture 覆盖非法/相对/缺失目录、macOS LaunchServices / Windows AppX 参数；用临时空 profile 做平台 smoke，不触碰用户既有配置。保持现有多账号逻辑原样。
- **规模 / 回滚：** M、中；无此需求则不做。撤销白名单转发/参数追加，不删除 profile 数据。

### U35 · 已有 Harness 的安装与配置指引

- **证据 / owner：** [`d7b3c56a`](https://github.com/BytePioneer-AI/codex-host/commit/d7b3c56a)，U `settings/harness-installation-guides.ts` / panel；F plugin manifest 已有 installation 元数据。
- **目标 / 步骤：** 复用已有 metadata 给未安装/路径错误/未配置状态提供官方链接和平台指令；自定义插件没有指令时显示明确缺省。Host 不执行安装，不新增账号管理能力。
- **验收：** 现有 Connections settings tests 加 missing/custom plugin、不同平台、远程 Host、无支持链接；实施时复核官方安装说明与 Adapter 实际支持版本。上游 DSH guide 仍写较旧固定版本，不能无校验照抄；链接展示与错误详情不溢出。
- **规模 / 回滚：** S、低；回退面板，保留现有发现逻辑。无依赖，新 Harness 仍另行立项。

### U37 · Windows Job 的后代退出证明

- **证据 / owner：** 上游 `ead8028d` 中 `crates/platform/src/windows_process.rs` 的 Job active process 查询和 `process_supervision.rs` 的 tree wait；[Native 对照](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/native-update.md) P2-7。
- **前置判断：** 上游 helper 存在不等于已有生产调用收益。先找 fork 中“根进程退出被误当整树清理”的真实调用或 fixture；没有就记录理念，停止实现，不添加无人调用的 API。
- **步骤 / 验收：** 如需实现，让持有 Job 的 owner 查询后代并有界等待，根先退出/孙进程仍活/超时强杀/无 Job 分开表达。只在 Windows 上运行相关 `cargo test --locked -p codexhost-platform` 与调用方测试；Unix anchor 不受替换。
- **规模 / 回滚：** M、中；回退新增调用点和 Job query，不改当前终止语义。与多账号无关，禁止夹带 owner/pool 改造。

### U39 · 最后按需接一个新 Harness

- **候选 / 证据：** 上游比 fork 多出 Hermes、Kimi Code、WorkBuddy、Qoder、Qoder CN 五个 Adapter package；Qoder 两个包是一组产品发行方向。源码在上游 `packages/adapters/{hermes,kimi-code,workbuddy,qoder,qoder-cn}`，发布主题见证据页；存在代码不等于已在 fork 环境认证。
- **选择原则：** 仅在用户明确有对应原生 Harness 使用需求后选择一个。先确认原生 CLI/API、支持平台、当前版本、安装方式与维护成本，不以模型名称或营销热度排序。
- **实施顺序：** 公共 plugin manifest/factory → discovery → create/resume/Turn/interaction/cleanup → 最小 UI → 分平台 conformance。所有进程通过 fork owned-process/anchor，Host 从 plugin public contract 加载；不复制上游 release plugin 清单覆盖现有集合。
- **不在范围：** 不增加该 Harness 的外部 Session 历史导入，不改多账号、凭据迁移或额度功能。受管 Session 的必要 resume/history 是执行合同，按最小功能验证。
- **验收 / 回滚：** 每个为独立 L、高风险任务。固定原生版本验证真实身份、权限、取消、恢复、父子资源和清理；未证能力标 unsupported/notCovered。先从预装清单移除或禁用 plugin 回滚，保留用户原生 Session 数据。

## 精确命令的使用方式

所有命令从当前 `package.json`、`tests/vitest.config.js`、`tests/e2e/playwright.config.js` 和 Cargo manifest 推导，**本轮均未运行**。执行前检查现有 dist 是否需要构建；不要因为命令成功但零测试而报告通过。

```bash
# 示例：U02 的两层定向测试。实施时先按变更重新构建必要的包。
npm run build:typescript
npx vitest run --config tests/vitest.config.js packages/protocol-core/test/jsonl.test.ts packages/host-runtime/test/remote-official-connection.test.ts

# 公共 TS 合同变更时补充；仅文档、小型局部变更不要求无差别运行。
npm run typecheck
node tools/check-boundaries.mjs

# 示例：U09 视觉/路由 fixture；实际 Desktop smoke 是单独证据。
npm run build:renderer
npx playwright test --config tests/e2e/playwright.config.js tests/e2e/renderer-chat-composer-isolation.spec.ts

# 示例：U01 的 Rust 路由检查；proxy fixture 需要 test-utils。
cargo test --locked -p codexhost-shim --lib
cargo test --locked -p codexhost-shim --features test-utils --test proxy
```

注意 fork `npm run test:typescript` 会先构建 native anchor，而直接调用 Vitest 不会；进程相关测试需明确使用 anchor 或 Host fallback，不能把后者通过冒充 anchor 通过。`npm start` 会关闭当前 Desktop 进程，不作为这些卡片的例行测试命令。

## 可复制的 AI 派发正文

```text
实施 docs/upstream-comparison-20260926/tasks.md 中的 <一个 ID 或明确子切片>。
先读取主清单、该卡、AGENTS.md 及当前源码，重验 HEAD 与工作区，确认缺口仍存在。
固定参考上游 997f62a0；不得整文件覆盖 fork，先核对具体来源许可。
只修改卡片 owner 路径和直接必要的合同/测试/文档，保留 anchor、lifecycle、
delegation/observer、capability、原生权限与持久化不变量。
不做 Session 历史导入、多账号、凭据或额度改造，不接入新的 Harness，
除非这次明确选择的就是 U39。
交付实现与最小定向验证，记录真实执行的命令和结果、未验层、风险与回滚。
发现目标已经满足则给证据并结束；发现真实边界与卡片不符则先修正方案，
不要为凑完成而放宽断言、吞错或扩大范围。
不执行 push/PR/安装/部署，不启动当前 Desktop，不访问真实凭据。
```
