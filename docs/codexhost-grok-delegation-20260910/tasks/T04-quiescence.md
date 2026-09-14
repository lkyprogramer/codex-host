# T04 — 取消、作业静止、Session 释放与恢复

依赖：T03。Owner：Host writer。目标：保留原生 cancel 语义，同时提供有证据的 Session 释放与恢复；不得因 interrupted 自动接管仍在写入的作业。

## 输入
/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/cancel-process-after-ack.json、cancel-process-later.json；fixtures/cancel/cancel_probe.py。
源码：packages/adapters/grok/src/acp-transport.ts:231,875、grok-adapter.ts；Host external-thread-runtime 及 delegation API。

## 写边界
Grok transport/adapter 进程生命周期、公共 capability/结果类型的必要扩展、Host release/resume 路径、CLI、直接测试。其他 Harness 不支持时如实 unsupported；不写通用 pkill 扫描器，不改 Grok 原生安装文件。

## 确定合同
- cancel 只确认请求和 Turn 终态，不承诺作业静止。
- 新增显式 thread release（名称在 help 中固定）：默认仅对已终止/空闲且 expected-turn 匹配的 Session 执行；忙碌轮返回 busy，先走 cancel→wait。
- 结果分开表示 Session 是否已释放、已知作业静止是否 confirmed/unknown/unsupported，以及证明范围。confirmed 只覆盖该 Session 实际拥有并可核验的进程/工具作业。
- 释放保留 native 历史、Delegation 和 worktree；后续 send 在同 thread 恢复真实模型/权限配置。
- 协调者只有确认作业静止且业务 owner 的 readback/cleanup 条件满足才释放业务资源；进程退出绝不等于 DB 回滚。

## 实现任务
1. 用真实 shell 在自有临时目录记录 PID/PGID/开始标记，延迟写尾标记；重现 cancel 后仍写。
2. 建立 Session-owned 进程/作业所有权证据，调查现有 close/resume 可以覆盖的范围。close 时主进程先退出也不能忽略仍存活的已知后代。
3. 对可证明属于本 Session 的作业使用有界停止与退出确认；限制在记录的所有权，防 PID/PGID 重用与误杀别的任务。不用 cwd/进程名通配杀进程。
4. 原生 detached/daemon 作业无法证明归属时，明确 unknown/unsupported，并保留 caller 的资源占用；不能为交付把所有结果一律设 confirmed，也不能“一律 unknown”绕过已支持路径验收。
5. 保留 pending identity、失败和取消信息，Session release 后用已持久化配置恢复，重试 release 幂等。
6. 记录有限的 job/进程摘要，不存凭据、完整私有 transcript 或无关进程信息。

## 测试
- RELEASE-01：本 Session 有界真实 shell 任务 cancel 后 release，确认其退出；超过原迟到写截止时间无尾标记。
- RELEASE-02：父先退出而已知后代仍活、取消/退出延迟、重复 release、超时，分别保留准确结果。
- RELEASE-03：未知/脱离所有权作业不能 confirmed；另一 Session 的哨兵作业不被终止；PID/PGID 重用保护。
- RELEASE-04：release 后同 thread send 成功，模型/档位/权限如实恢复，native 历史不丢失。
- 禁止拿自动回收 worktree、删除文件或吞 cleanup 异常替代上述证明。

定向 Vitest：grok-adapter.test.ts 与新增 transport lifecycle 测试、external-thread-runtime.test.ts、delegation CLI/API；live verify.mjs --scenario RELEASE-01,RELEASE-04。

## 完成与停止
支持的本 Session 作业路径真实停止并恢复；无法保证范围有可机读状态且调度 fail-closed。若需要修改 Grok 本体才能处理未支持作业，只记录具体扩展任务；不能扩大到修改其安装或宣称所有系统作业均可强制停止。

