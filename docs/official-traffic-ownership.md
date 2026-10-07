# 官方流量归属

Host 位于 Codex Desktop 与官方 app-server 之间。官方协议的方法和参数会随 Desktop 版本持续增加，Host 无法提前枚举，因此采用“默认放行、显式截获”：只处理确认属于 codexhost 的请求，其余原样转发给官方，由官方自己校验。

## 归属判别

判别只读取以下字段，且判别本身不抛错；字段缺失或看不懂，就视为官方请求：

- `method` 以 `codexhost/` 开头。
- `thread/start` 的 `params.model` 是带 codexhost 前缀的文本运输标记（`decodeCreateRoute`）。
- 默认 Agent 设为 Pi（`defaultAgent: "pi"`）时，带文本 Model 的 `thread/start` 也归 Host，交给 Pi；这是 fork 保留的设置，上游已移除。
- 非文本或缺失的 Model 一律属于官方，不受默认 Agent 影响。例如原生 MCP App 打开的 Thread 不带 Model，它不是默认 Agent 设置所指的 Composer 新建会话。若将来 Desktop 的普通新建会话也不带 Model，这类会话会进入 Codex 而不是 Pi，需要重新评估。
- `params.threadId` 指向 Mapping Store 中的外部 Thread（`#locateRequestThread` / `#resolveExternalThread`）。
- `thread/list` 的 `params.cursor` 是 Host 合并分页的游标（`carriesHostThreadListCursor`）。官方无法解析 Host 游标，所以带 Host 游标的列表即使还带有 Host 不认识的字段，也由 Host 以 `-32602` 拒绝，不转发。

只有确认归 Host 所有之后，才对请求做严格校验。外部 Thread 的 `thread/metadata/update` 不论参数如何都返回 `-32078`（尚不支持，见上游对比 V10）；外部 Thread 的 archive / unarchive 不再单独校验参数，因为能定位到外部 Thread 已说明 `threadId` 合法。格式错误的 codexhost 运输标记和 Host 游标仍返回 `-32602`，因为这些格式由 Host 定义；官方请求的参数错误交给官方处理。

## 请求必有回应

Desktop 发出的每个请求都在 [`DesktopReplyGuards`](../packages/host-runtime/src/desktop-reply-guard.ts) 下执行：

- 处理函数意外失败时，若这个请求还没有回复、也没有交给官方，Host 返回 `-32076 "Host request failed"`，避免 Desktop 一直等待。
- 处理函数转入后台继续执行的工作（`#dispatchDesktopReply`）有自己的保护，处理函数提前返回不会让它失去兜底。
- 写给 Desktop 的响应（带 `id`、不带 `method`），以及成功转发给官方的请求，都会标记为已回复；已回复的请求失败时只记诊断，不重复回复。

## 验证

- `packages/host-runtime/test/desktop-reply-guard.test.ts`：兜底回复、已回复或已转发后不重复回复、后台工作的独立保护。
- `packages/host-runtime/test/app-server-host.test.ts` 的 “answers a request whose detached work fails”：后台工作失败时 Desktop 收到 `-32076`。“已转发给官方后又抛错”在 Host 中没有可触发的路径（转发成功后不再有可能抛错的代码），只由单元测试覆盖。
- `packages/host-runtime/test/app-server-host.test.ts`：官方无法由 Host 解读的请求（含未知方法、非对象或缺失的 params、对象形式的 Model）原样转发；默认 Agent 为 Pi 时不带 Model 的 `thread/start` 仍交给官方；格式错误或带未知字段的 Host 游标由 Host 拒绝。
- `packages/protocol-core/test/model-routing.test.ts`、`thread-management.test.ts`：不带文本 Model 的 `thread/start` 不属于 Host；Host 游标不能与未知字段同时使用。

来源：借鉴上游 `8d35e131`、`893fd07e`（BytePioneer-AI/codex-host，#480/#481），按 fork 的请求分发与错误码适配；见 [上游对比 V01/V02](upstream-comparison-20261007/README.md)。
