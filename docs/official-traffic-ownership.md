# 官方流量归属

Host 位于 Codex Desktop 与官方 app-server 之间。官方协议的方法和参数会随 Desktop 版本持续增加，Host 无法提前枚举，因此采用“默认放行、显式截获”：只处理确认属于 codexhost 的请求，其余原样转发给官方，由官方自己校验。

## 归属判别

判别只读取以下字段，且判别本身不抛错；字段缺失或看不懂，就视为官方请求：

- `method` 以 `codexhost/` 开头。
- `thread/start` 的 `params.model` 是带 codexhost 前缀的文本运输标记（`decodeCreateRoute`）。非文本或缺失的 Model 属于官方，例如原生 MCP App 打开的 Thread 不带 Model。
- `params.threadId` 指向 Mapping Store 中的外部 Thread（`#locateRequestThread` / `#resolveExternalThread`）。
- `thread/list` 的 `params.cursor` 是 Host 合并分页的游标（`carriesHostThreadListCursor`）。

只有确认归 Host 所有之后，才对请求做严格校验。格式错误的 codexhost 运输标记和 Host 游标仍返回 `-32602`，因为这些格式由 Host 定义；官方请求的参数错误交给官方处理。

## 请求必有回应

Desktop 发出的每个请求都在 [`DesktopReplyGuards`](../packages/host-runtime/src/desktop-reply-guard.ts) 下执行：

- 处理函数意外失败时，若这个请求还没有回复、也没有交给官方，Host 返回 `-32076 "Host request failed"`，避免 Desktop 一直等待。
- 处理函数转入后台继续执行的工作（`#dispatchDesktopReply`）有自己的保护，处理函数提前返回不会让它失去兜底。
- 写给 Desktop 的响应（带 `id`、不带 `method`），以及成功转发给官方的请求，都会标记为已回复；已回复的请求失败时只记诊断，不重复回复。

## 验证

- `packages/host-runtime/test/desktop-reply-guard.test.ts`：兜底回复、已回复或已转发后不重复回复、后台工作的独立保护。
- `packages/host-runtime/test/app-server-host.test.ts`：官方无法由 Host 解读的请求原样转发；格式错误的 Host 游标仍由 Host 拒绝。
- `packages/protocol-core/test/model-routing.test.ts`：不带文本 Model 的 `thread/start` 不属于 Host。

来源：借鉴上游 `8d35e131`、`893fd07e`（BytePioneer-AI/codex-host，#480/#481），按 fork 的请求分发与错误码适配；见 [上游对比 V01/V02](upstream-comparison-20261007/README.md)。
