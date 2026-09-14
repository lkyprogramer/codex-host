# T05 — 紧凑观察、批量等待和明确输入

依赖：T03；与 T04 共享文件，默认串行。Owner：Host writer。目标：协调者一次等待多个任务，只取得新变化，减少反复模型回合和旧正文传输。

## 输入
/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/incremental-read.json；当前 delegation-snapshot.ts、delegation-cli.ts、coordinator wait/list、SessionStateObserver/Host Turn 事件。

## 写边界
delegation types/CLI/server/registry/coordinator/snapshot、必要 Host 事件订阅、直接测试及 OBSERVE/INPUT scenarios。不改变旧 read result/messages 的默认形状、分页语义；不加入第二个业务状态库或常驻自动化。

## 实现合同
1. 新增紧凑 status 视图：thread、当前 turn、status、opaque revision、cwd、实际配置的已知/未知值；默认没有历史 message/result 正文。
2. 新增批量 wait-many：targets-file 数组记录 threadId 与可选 afterRevision；默认 30 秒、可接受 0 秒即时快照，单调用最多 60 秒；有任一未消费的重要变化则返回变化集，无变化返回 timedOut 和最小状态。
3. revision 绑定 thread、实际 turn/状态版本及 Runtime epoch；旧 epoch、错 thread cursor 可明确 resync，不能静默忽略。已消费 terminal 不应每次立即重复唤醒。
4. 正常 flow 按 Host 状态事件/条件等待，不以 N 个每 100ms 的全历史 read 代替；取消等待不取消 child，订阅要回收。
5. 一个目标 missing/error 不丢弃其余目标的状态；返回逐目标错误及准确变化，不能全局假报成功。
6. 增加 delegate start --cwd 与 --task-file（或 --task - 读取 stdin），send --message-file；与原 --task/--message 互斥，输入按 UTF-8，错误发生在创建/投递前。
7. 已知调用者优先使用 CODEXHOST_THREAD_ID；原生 Codex 可从已提供的 CODEX_THREAD_ID 取得 parent。显式 --parent-thread 优先；缺可信身份才走原歧义处理，不猜唯一最近任务。
8. 所有输入使用参数数组/文件读取，不 eval 用户文本；newline、中文、引号、反引号、$() 与长 prompt 原样传输。

## 测试
- OBSERVE-01：3 个目标，running→terminal、failed、already-consumed terminal；只返回新变化。
- OBSERVE-02：等待前后竞态不丢事件，超时/客户端离开无订阅泄漏、不唤醒/取消 child。
- OBSERVE-03：跨 epoch/cursor错用、单目标 missing、混合结果准确。
- OBSERVE-04：结果正文为 100KB 的完成任务，重复 status/wait-many 不含正文；三目标无变化 JSON 总量上限 4KB（包括必要 identity/revision），具体计数写入测试。
- INPUT-01：非 ASCII/空格 cwd realpath 准确；task-file/stdin 逐字节匹配；互斥/无效文件在 admission 前拒绝。
- INPUT-02：明确 parent 优先级、不把测试 child 错归别的活跃父任务。
- 原 read/messages 的默认隐私与分页测试继续通过；本接口不把 read 游标当业务完成证据。

命令：定向 Vitest delegation-cli、snapshot、control-server、registry、coordinator；live verify.mjs --scenario OBSERVE-01,INPUT-01。

## 完成
批量观察不重发旧结果、不需父模型逐任务催报；旧 CLI 命令兼容。新命令 help/schema/tests 一致且只宣称实际存在的能力。

