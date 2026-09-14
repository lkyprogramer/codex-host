# T03 — 稳定 Turn、状态一致和可靠续接

依赖：T02。Owner：Host writer。目标：同一次实际 Turn 在 send/cancel/read/history refresh 中身份稳定，状态不会被上一轮覆盖。

## 输入
/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/cancel-start.json、cancel-ack.json、cancel-terminal.json、list-after-followup.json、host-recovery-assessment.json。
源码：harness-delegation-coordinator.ts、external-thread-runtime.ts:389、external-thread-repository.ts:408、app-server-host.ts Turn 事件处理、GrokAdapter #settleFromHistory、grok-history.ts。

## 写边界
上述 Host/Grok owning 文件、必要 records/type/CLI/API、直接测试及 TURN scenarios。保留现有 Desktop steering 的取消后另起新轮语义；不擅自实现或声称 native interject。

## 实现任务
1. 复现取消/失败缺 nativeTurnRef 后历史刷新新发 Host UUID。记录实际 native 事件/映射；不要从最后一条消息猜唯一根因。
2. 保留已分配 Host attempt ID；真实 native identity 出现后绑定原 ID。未创建 native Turn 的早期取消也必须能追踪原请求，不能伪造 native identity 或生成重复历史轮。
3. 将 Delegation 状态更新接入统一 Turn start/terminal 路径（包括 follow-up 与自主轮）；read/list 状态一致，迟到旧事件不覆盖新 active turn。
4. send 支持可选 request-id 与预期前轮 identity；同一后续输入的响应丢失可安全重试。无 ID 保持现有非幂等行为，不将不同内容合并。
5. cancel 支持可选 expected-turn，目标已换轮时明确拒绝，不取消新轮。所有旧参数与返回兼容；新字段是可选扩展。
6. 同轮并发 send 只有一个 admission；另一个 busy 或同 ID 合并。禁止默默排队、默认取消旧工作来接受新消息。

## 测试
- TURN-01：取消/失败/正常完成后重复 read、history hydrate、Runtime reopen，Host Turn ID 不漂移。
- TURN-02：早期无 native Turn 与 native identity 迟到两条路径；不制造假的 native 映射。
- TURN-03：follow-up 后 list/read=running，terminal 后一致；旧 completion 不回退新轮状态。
- TURN-04：同 send request-id 并发/响应丢失只投递一次；不同 payload 冲突；无 ID busy 语义兼容。
- TURN-05：过期 expected-turn cancel/send 被拒绝且新轮继续；实际失败不返回 completed。
- 真实 Grok 校准一次有界取消/续接和一次响应读取。进程残留交给 T04；本 task 不以 interrupted 证明资源已释放。

命令：定向运行 harness-delegation-coordinator、external-thread-runtime、external-thread-repository、delegation-snapshot、delegation-cli、grok-adapter、grok-history 对应 Vitest 文件；AppServerHost 修改则加 -t 精确覆盖其相关测试。live verify.mjs --scenario TURN-01,TURN-03,TURN-05。

## 完成
同一 attempt 全链路可关联，调度不再看见旧 completed；重试不多起一轮。缺 correlation 时输出可诊断未证实状态，不隐式换 ID。

