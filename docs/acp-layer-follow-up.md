# ACP 接入与复用边界

当前生产路径中使用 ACP 的 Harness 有 Grok、Kiro CLI、CodeBuddy 和 Cursor CLI。早期“只有 Grok，等第二个 Adapter 再比较”的前提已经失效；目前仍未实现独立通用 ACP package 或 `GenericAcpAdapter`。本文说明当前差异和后续抽取条件，不声明共享 Transport 已经交付。

## 当前实现

| Harness | 源码入口 | 必须保留的差异 |
| --- | --- | --- |
| Grok | [acp-transport.ts](../packages/adapters/grok/src/acp-transport.ts) | 私有扩展、Model/Usage、原生插话与 Plan、fork/load/delete 和历史边界 |
| Kiro CLI | [kiro-adapter.ts](../packages/adapters/kiro-cli/src/kiro-adapter.ts)及所属 ACP 模块 | agent engine v3、异步配置确认、并发 Question/Approval、原生派生与子代理能力 |
| CodeBuddy | [acp-client.ts](../packages/adapters/codebuddy/src/acp-client.ts) | 原生配置、认证、交互与持久历史身份；不支持 Fork/rollback |
| Cursor CLI | [transport.ts](../packages/adapters/cursor-cli/src/transport.ts) | 配置超时后的 transport 退休、原生历史读取、有限能力和权限策略 |

Host 只依赖 `HarnessAdapter / HarnessSession`。ACP SDK、扩展方法、原生 `_meta`、历史 schema 和错误文本解释留在相应 Adapter。Claude SDK、Pi / OMP RPC、DeepSeek Web 与 Antigravity Hook/CLI 不因此改为 ACP。

## 已共享的合同

- 公共 Session 生命周期、输出 schema、Native Ref 与 Host 投影。
- Manifest / 工厂加载、运行时 Session 校验和版本兼容检查。
- 可执行文件发现辅助、Host operation reservation、配置持久化与故障终结。
- 十 Adapter 共用的[一致性验证驱动](adapter-conformance.md)，包括单一 outputs 消费者、超时、唯一终态、跨重启身份和清理。

这些共享部分不等于已经共享了 ACP Transport。`harness-broker` 的 Aqua 进程执行设施可被部分 Adapter 使用，但其中保留的 Claude Session 协议不是 ACP 基类。

## 持久身份与恢复

同为 ACP，不代表具有相同的历史能力。每个实现必须证明：

1. Native Session ID 在重启后保持稳定。
2. Native Turn key 来自持久、opaque、唯一的原生身份，不是随机 UUID、回放下标或临时 Tool call ID。
3. 实时终态与 fresh Adapter resume 后 Snapshot 使用相同 Native Turn identity。
4. Snapshot 依据原生权威历史；仅 `session/load` 能回放文字不足以证明恢复合同。
5. 支持 fork/rollback 时，验证源不变、派生边界、新身份、下一 Turn 及失败清理；不支持时保持 unsupported。

原生 ACP 没有返回稳定身份时，可由所属 Adapter 读取其原生历史。私有 SQLite、JSONL 或扩展 profile 不应移入通用层，也不能仅凭 ACP SDK 版本判断它们兼容。

## 可抽取范围与条件

已有多个真实实现可供比较，但不能只按协议名称合并。后续抽取应针对两个以上实际调用方中已确认重复、语义一致的机制：连接建立、stdio 生命周期、请求关联、协议协商、取消传输、deadline 和连接关闭传播。

抽取前须对照 native 方法、响应形状、异步通知、权限范围、原生版本和 close 语义。共享层不生成 Model/权限目录、不解释 Harness 私有错误、不决定 capabilities，也不构造历史或 Host Event。若需要大量按 Harness ID 判断的回调，应继续保留所属 Adapter 的实现。

验证应分别覆盖共享机制与具体 Adapter：配置 reject/timeout、迟到响应、取消与终态交错、进程退出、close 后拒绝操作、fork/load 后失败清理，以及真实 native identity 的恢复。已有能力不得因抽取而被降为看似等价的 Host 行为。

是否新增共享 package 是后续实现决策，不是这次文档同步隐含的开发任务。当前结构与代码入口见[插件架构](harness-plugin-architecture.md)。
