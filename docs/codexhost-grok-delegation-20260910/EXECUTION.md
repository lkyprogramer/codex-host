# 执行协议

## 1. 激活和工作绑定

用户明确要求执行本计划时才激活。读取 GOAL.md、state.json 与 codex-host 仓库 AGENTS。本轮写计划不代表开发已启动。使用当前运行环境的 goal 工具时按用户启动指令登记同一目标，不为每个 task 新建 goal。

Host 基线固定 80f3116530c47e05ec24b97f267c011bbf7be982。先用 git cat-file -e 核实对象，再从它创建 codex/delegation-grok-workers 独立 branch/worktree；已存在时验证其绑定后恢复，不能覆盖。canonical 源目录不切分支、不清理 WIP。最终 PR 也从该分支继续；不从旧 origin/main 重做。


首次写前记录任务 ID、realpath、branch、base SHA、允许路径。构建依赖必须安装在本 worktree，不把 node_modules 工作区链接或 dist 指向另一 writer 的目录。

## 2. 默认分工

- 当前协调者只做边界、依赖、采纳、验证和最终 PR；大段调查/实现优先派给 Grok。
- 一个持久 Host writer 依序承担 T01–T07。同 owner 修复续用原任务。
- T08 的代码审查与行为/公共合同审查分别由新建 Grok 任务承担，不能继承实现者会话；具体结论由协调者读回候选核验。
- 默认复杂 writer/reviewer 候选档位 grok-4.6/xhigh；短调查 medium。派发前用 harness inspect 的真实 opaque ID 核实，并记录 effective 配置；不可用时不伪报或静默换成 Codex。
- 初始最多 3 个无冲突 Grok 活动任务；这是已测起点，不是产品上限。只能在独立 fixture/resource 与实测容量允许时扩大。共享 Host 文件由唯一 writer 维护。
- T04/T05 共享 coordinator/types/API 文件，默认串行；独立只读调查与审查可并行。

## 3. 派发协议

使用本会话原样 CODEXHOST_CLI_PATH 运行 delegate --help；不使用裸 codexhost，不复制本机 npm 版本路径进技能。父任务明确传真实 parent-thread；现阶段从工作目录调用 CLI，T05 的 --cwd 实现后使用它并再次核验。

request-id 绑定 parent + task + attempt；同请求重试复用 ID，输入/配置变更使用显式新 attempt。T02 未通过前，同一 request-id 的生产派发不并发调用。新任务先验证一个真实可读 child，再扩展 ready 集。

writer brief 只包含当前 task 目标、已提交输入、绝对 worktree、BASE、允许路径、测试与完整 commit 交付。引用 task 文档，不复制全部规则。结果返回候选、变化路径、日志位置和具名缺口；自然语言自报不能直接写成 PASS。

忙碌任务不循环 send；沿当前 CLI 合同 wait/read，使用 T03 增加的 request/expected-turn 语义后再采用新接口。cancel ACK 不释放 worktree、进程或业务资源；按 T04 读回静止状态。无必要不取消正常任务来催报。

## 4. 测试与产物

构建 Node 以仓库 .node-version 为准，计划时为 22.22.0；当前桌面子 shell 的 v22.16.0 不满足仓库 build engines，不能拿它作正式构建环境。缺版本可在独立 shell 用 nvm install 22.22.0 / nvm use 22.22.0，不修改全局默认。npm 以 packageManager 指定的 11.8.0 为准，依赖用 npm ci；不要顺手升级 lockfile。

每阶段保存：argv、cwd、Node/npm/工具版本、base/result SHA、完整日志、退出码、相关 JUnit/JSON。下一次会覆盖产物的命令前先保全。成功证据按实际源码影响复用；final 不为形式重复所有 live 场景，但必须绑定最终候选并补测变化闭包。

T01 新增验证入口的计划合同：
- node tools/delegation/verify.mjs --list
- node tools/delegation/verify.mjs --mode hermetic|live --scenario <ID[,ID...]> --output <absolute-dir>
- --mode live 只能使用本次启动的隔离 Runtime；不得默认落到继承的现用 endpoint。入口输出 Runtime PID/候选/数据目录/清理结果，但不输出 token。
- 真实模式必须经过生产 CLI → control server/registry → Host/coordinator → 真实 Grok Adapter。不得把 provider 换成 fake 后仍报 live。
这些命令当前不存在；T01 实现并验证后成为后续 task 依赖。

用例命名固定在 TEST_MATRIX.md；每 task 增加其场景，不让后续阶段一次性补所有测试。所有需要标 live 的测试至少有一次真实 Grok 校准。

## 5. 提交、恢复与停止

完成一个可验证 task 即提交；commit message 使用 English、按实际行为命名。state.json 只在阶段、候选、blocker 或证据变化时更新。每 task 完成字段含 base/result、commands、evidence、remaining_risks；不维护消费项目的进度记录。

恢复先读 state.json、最新任务指令、实际 Git/WIP 和活动进程。不要重做 T00 或已验证 task；输入漂移只重验受影响部分。UNKNOWN 创建恢复用 T02 的具名 reconcile，不靠换 ID 创建另一 writer。

本地集成只合入本计划的完整提交，保留基线修复和原有 WIP。T09 才推送本人 fork/创建普通 PR；不擅自 merge 上游或部署当前桌面。阻断一个 task 时继续无冲突准备，但所有 required gate 未完成不得把 goal 标 COMPLETE。

