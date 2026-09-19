# Command Code 接入

`packages/adapters/command-code` 通过 Command Code CLI（npm `command-code`，命令 `cmd` / `cmdc` / `command-code`）的 headless 打印模式接入。本文记录实际使用的原生接口、能力边界与验证状态；接口以源码为准。基线版本：1.58.0。

## 原生接口

Command Code 没有 ACP、SDK 或常驻 RPC。唯一可编程接口是：

```text
command-code -p --output-format json --skip-onboarding --trust --no-auto-update --max-turns <n>
             [--session <transcript.jsonl> | --resume <id>] [-m <model>] [--effort <level>]
             [--dangerously-skip-permissions | --permission-mode plan]
```

- 每个 Host Turn 对应一个打印进程。Prompt 经 stdin 传入，stdout 逐行输出 `{"type":"event","event":<AgentEvent>}`，最后一行 `{"type":"result","subtype":"success|error|max_turns",...}`。
- 首轮 `run_start.sessionId` 建立 Native Ref；后续 Turn 通过 `--session <path>` 续接同一转录文件，找不到文件时退回 `--resume <id>`。
- 取消 = 结束打印进程（受管进程树，先 SIGTERM 后强制），进程退出后发布 `cancelled` 终态；下一轮照常续接。
- 命令名使用 `command-code`：`cmd` 在 Windows 是系统 shell，`cmdc` 只是该平台别名。`CODEXHOST_COMMAND_CODE_COMMAND` 可显式指定可执行文件。

原生转录位于 `<home>/.commandcode/projects/<cwd-slug>/<sessionId>.jsonl`（v3：`session` 头 + 通过 `parentId` 组成树的 `message` 节点）。Adapter 只读取它：resume 时校验存在与 `cwd`，回放活动分支为历史 Turn，并用最新 prompt 节点 ID 作为 Turn key。文件不可读时使用序号 key。

## 事件映射

| 原生事件 | Host 投影 |
| --- | --- |
| `text_delta` | agentMessage 流式追加 |
| `thinking_start/delta/end` | reasoning Item |
| `tool_queued` / `tool_running` / `tool_completed` / `tool_errored` | toolExecution；`shell_command`、`powershell_command`、`monitor_command` 为 commandExecution |
| `edit_file` / `write_file` 完成 | fileChange：`edit_file` 用工具输入反推编辑前文本，`write_file` 用执行前快照；无法证明补丁时保留 toolExecution |
| `tool_denied` / `tool_hook_blocked` | 失败的 tool Item，说明当前权限档 |
| `subagent_start/stop` | subagentDelegation（仅观察，不读取过程正文） |
| `compaction_start/done` | contextCompaction |
| `turn_end.usage`、`run_end.result.usage`、`result.usage` | Session 累计 token 用量；打印模式不暴露上下文窗口 |
| `result.subtype` / 退出码 3、4、5、6、7、8、9、10、130 | 终态与类型化错误（3 → `authenticationRequired`） |

## 权限档

headless 下没有可回调客户端的审批：`confirmTool` 在打印模式内自动决定，`ask_user_question` 默认被 withheld；不带 `--yolo` 时内置 `print-permission-gate` 无条件拦截 `edit_file` / `write_file` / `shell_command` / `monitor_command` / `kill_shell`，`--permission-mode auto-accept` 不能解除。因此只提供三档真实语义：

| ID | 原生参数 | 语义 |
| --- | --- | --- |
| `bypass`（默认，危险） | `--dangerously-skip-permissions` | 全部工具直接执行 |
| `read-only` | 无 | CLI 自身拦截写与 shell，其余工具照常 |
| `plan` | `--permission-mode plan` | 只读探索，无 MCP 工具 |

codexhost 不添加审批、allow / deny 匹配或工作区限制。通过 `--mod` 的 `beforeToolCall` 桥接 Desktop 审批 / 提问在技术上可行，但 Mod API 标注为 experimental，且等同于在 `--yolo` 之上自定义策略；与 [Antigravity 权限](antigravity-tool-approval.md)的取舍一致，暂不提供。

## 能力声明

- Model：`--list-models` 文本表解析；原生 ID 含 `/` 与 `:`，以 base64url 编码为 opaque Model Ref。
- Thinking：`--effort low|medium|high`，按 CLI 文档为会话级参数，是否被具体模型接受由 CLI 判定。
- Fork / Rollback：不支持。`--fork-session` 只能派生整段会话尾部而非 checkpoint，打印模式没有 `/rewind`。
- Steering：`restart`；Work mode 仅 `default`。
- 空闲释放：Turn 之间没有常驻进程，`resourceLifecycle.suspend` 在已有 Native Ref 时结束输出。

## 已知副作用与限制

- CLI 在每次打印运行时于 cwd 创建 `.commandcode/taste/taste.md`（taste 功能自身行为，`--skip-onboarding` 不影响）。
- `--list-models` 需要有效登录；未登录时 inspection 为 `error` / `authenticationRequired`。
- 只在 `--session` 路径可用时按路径续接；若转录在 CLI 本地存储之外（远程 Host），resume 会返回 `sessionNotFound`。

## 验证状态

已执行（stand-in CLI fixture，非真实 Provider）：`packages/adapters/command-code/test/`

- 协议帧解析（含 1.58.0 实机捕获的失败流）、退出码映射、Model 目录、参数装配、权限档。
- 转录回放、活动分支、按 ID 定位。
- Adapter 生命周期：create / Turn / 流投影 / fileChange / cancel / 认证退出 / 结构化错误 / read-only 拦截 / resume 与身份不匹配。
- 公共 conformance 收据：核心场景 `passed`，`subagents` 为 `notCovered`，收据为 `incomplete`。

未验证（依赖可用账号额度）：真实 `-p` 成功流的完整事件顺序与 `tool_completed.result` 形状、`--effort` 对各模型的接受情况、`--session` 续接与取消后的原生持久化行为。本机实测仅拿到 `run_start → turn_start → … → run_error → run_end → result(error)` 的失败流。
