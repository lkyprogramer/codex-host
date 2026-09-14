# 验收矩阵

本表 ID 对应 task 中的精确定义，均为 required，除明确的 unsupported 分支测试。expected rejection 是测试预期，不是产品失败。state.json 不能把未执行项设 PASS。

| Task | 必须覆盖的 ID | 最小证据层 |
|---|---|---|
| T00 | 原始 CLI help、inspect、next.wait/read、child 路径回报 | 本轮已完成的真实 CLI；child 工具轨迹限制已披露 |
| T01 | ENTRY-01/02/03、SMOKE-01 | hermetic + 真实 CLI/Host/Grok |
| T02 | CREATION-01/02/03、RECOVERY-01/02 | storage/Host 故障注入 + 真实并发创建 |
| T03 | TURN-01/02/03/04/05 | 身份/状态/并发单测 + 真实取消续接 |
| T04 | RELEASE-01/02/03/04 | owning lifecycle 单测 + 真实 shell 退出/迟到写与恢复 |
| T05 | OBSERVE-01/02/03/04、INPUT-01/02 | 游标/超时/竞态/字节断言 + 3 任务真实观察 |
| T06 | EVIDENCE-01/02/03/04 | 隐私/分页/缺失单测 + 实际文件读取和配置 |
| T07 | SKILL-01/02/03/04 | Host managed skill 测试 + 独立 Grok 技能前测 |
| T08 | FLOW-01/02/03、npm run check、两位独立审查 | 最终候选真实集成与审查 |
| T09 | PR-01/02/03/04 | 上游 PR 当前 head、diff、required CI |

## 证据规则
每条结果绑定 test ID、mode、source/base/result、工具版本、实际 argv/cwd、退出码、原始日志/JSON路径、cleanup。关键断言应包含预期和实际 identity、写文件/进程后态，不只看 CLI exit=0。
旧证据可复用的前提是相关 closure 未变化并有采纳判断；不因 commit hash变化清零全部，也不把旧结果改写成新运行。
假官方控制元数据、fake Harness、mock HTTP 必须分别标明；它们不能替代真实 Grok 验证。验收只覆盖 codex-host 的能力。
新场景的工具名称/CLI选项在实现后以真实 help 为准；修改场景合同需同步 task、matrix 与代码测试，不只改断言令测试变绿。
最终 FINAL-AUDIT.md 按此表逐项列出证据与残留，不将消费项目状态作为验收条件。

