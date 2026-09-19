# Command Code 接入

`packages/adapters/command-code` 通过 Command Code CLI（npm `command-code`，命令 `cmd` / `cmdc` / `command-code`）的 headless 打印模式接入。本文记录实际使用的原生接口、能力边界与验证状态；接口以源码为准。基线版本：1.58.0。

## 原生接口

Command Code 没有 ACP、SDK 或常驻 RPC。唯一可编程接口是：

```text
command-code -p --output-format json --skip-onboarding --trust --no-auto-update --max-turns <n>
             [--session <transcript.jsonl>] [-m <model>]
             [--dangerously-skip-permissions | --permission-mode plan]
```

- 每个 Host Turn 对应一个打印进程。Prompt 经 stdin 传入，stdout 逐行输出 `{"type":"event","event":<AgentEvent>}`，最后一行 `{"type":"result","subtype":"success|error|max_turns",...}`。result 行不单独决定终态：CLI 在模型无输出（exit 9）或拒绝提示（exit 1）时仍写 `success`，错误路径也先写 result 再以文档退出码退出，所以 Adapter 等进程退出后用退出码限定 result（最多等 5s，超时按 result 行判定）。
- 首轮 `run_start.sessionId` 只在进程内暂存；CLI 直到首条 assistant 消息或收尾 flush 才写转录，且 SIGTERM 路径不保证 flush，因此 Native Ref 在 Turn 终态并确认转录文件存在后才发布。首轮在落盘前被取消，Thread 不会指向不存在的 Session，下一轮重新创建。
- 后续 Turn 只通过 `--session <path>` 续接；`--resume <id>` 只查 cwd 项目目录且要求文件存在，没有作为回退的价值。转录缺失时 Turn 以 `sessionNotFound` 拒绝。
- Turn key 取 CLI 为本轮存储的 prompt 节点 ID，且必须比运行前更新；未落盘的失败（早期认证失败、stdin 超时）不产生 `nativeTurnRef`，不借用上一轮。
- 取消 = 结束打印进程（POSIX 受管进程树，先 SIGTERM 后强制；Windows 只终止 `.cmd` shim，与 Antigravity 同一限制），进程退出后发布 `cancelled` 终态。result 行到达后再取消只受理不发信号（CLI 的 SIGTERM 处理会以 130 退出，使已完成的 Turn 被误判），原生结果保持不变，退出由 5s 计时器兜底。
- 命令名使用 `command-code`：`cmd` 在 Windows 是系统 shell，`cmdc` 只是该平台别名。`CODEXHOST_COMMAND_CODE_COMMAND` 可显式指定可执行文件。

原生转录位于 `<home>/.commandcode/projects/<cwd-slug>/<sessionId>.jsonl`（`home` 与 CLI 同为 `HOME ?? USERPROFILE ?? os.homedir()`）（v3：`session` 头 + 通过 `parentId` 组成树的记录，其中 `compaction`、`model_change`、`effort_change`、`session_info`、`custom`、`label` 与 `message` 同在链上）。Adapter 只读取它：resume 时校验存在与 `cwd`（realpath 比较），沿完整链回放活动分支上的消息为历史 Turn，Item ID 由记录 ID 与块序号派生（`command-code-item-v1-<entry>-<n>`），重复读取稳定。读取有 64 MB 上限。`historyOnly` 的 resume 不要求 CLI 已安装，此时 Session 报告 `executionReady: false`；Turn 开始前若转录已被删除，返回 `sessionNotFound`。

## 事件映射

| 原生事件 | Host 投影 |
| --- | --- |
| `text_delta` | agentMessage 流式追加 |
| `thinking_start/delta/end` | reasoning Item |
| `tool_queued` / `tool_running` / `tool_completed` / `tool_errored` | toolExecution；`shell_command`、`powershell_command`、`monitor_command` 为 commandExecution |
| `edit_file` / `write_file` 完成 | fileChange：优先使用执行前快照（与当前内容不同即可证明先于写入）；快照与当前内容相同（读取竞争或无操作）时，仅对精确匹配的 `edit_file` 用工具输入反推（空 `old_string` 视为新建，`replacement_count` 与宽松匹配不反推）；无法证明补丁时保留 toolExecution |
| `tool_denied` | 失败的 tool Item：headless `confirmTool` 对带 risk 标记的工具在任何权限档下都自动拒绝 |
| `tool_hook_blocked` | 失败的 tool Item：打印模式内置 gate 或 hook 阻止（非 `bypass` 时注明权限档） |
| `subagent_start/stop` | subagentDelegation（仅观察，不读取过程正文） |
| `compaction_start/done` | contextCompaction |
| `turn_end.usage`、`run_end.result.usage`、`result.usage` | Session 累计 token 用量；打印模式不暴露上下文窗口 |
| `result.subtype` + 退出码 | `success`+0 → succeeded；`success`+9 无响应、`success`+1 拒绝 → failed 不可重试；`error` 按 `result.error` 分型（exit 3 / CLI 认证措辞 → `authenticationRequired`；exit 1/4/8/9/10 不可重试，5/6/7 可重试）；无 result 行时按退出码 3/4/5/6/7/8/9/10/130 映射，`unknown model` 等参数拒绝 → `invalidRequest` |

## 权限档

headless 下没有可回调客户端的审批：`confirmTool` 在打印模式内自动决定，`ask_user_question` 默认被 withheld；不带 `--yolo` 时内置 `print-permission-gate` 无条件拦截 `edit_file` / `write_file` / `shell_command` / `monitor_command` / `kill_shell`，`--permission-mode auto-accept` 不能解除。因此只提供三档真实语义：

| ID | 原生参数 | 语义 |
| --- | --- | --- |
| `bypass`（默认，危险） | `--dangerously-skip-permissions` | 全部工具直接执行；CLI 同时会加载项目级 `.commandcode/mods`（其余档只加载用户级 mods） |
| `read-only` | 无 | CLI 自身拦截写与 shell，其余工具照常 |
| `plan` | `--permission-mode plan` | 只读探索，无 MCP 工具 |

codexhost 不添加审批、allow / deny 匹配或工作区限制。通过 `--mod` 的 `beforeToolCall` 桥接 Desktop 审批 / 提问在技术上可行，但 Mod API 标注为 experimental，且等同于在 `--yolo` 之上自定义策略；与 [Antigravity 权限](antigravity-tool-approval.md)的取舍一致，暂不提供。

## 能力声明

- Model：`--list-models` 文本表解析（内置静态表，不需要登录，也不反映认证状态）；原生 ID 含 `/` 与 `:`，以 base64url 编码为 opaque Model Ref；列表中的小写 display ID 由 CLI 解析回 canonical ID（实测 `moonshotai/kimi-k3` → `moonshotai/Kimi-K3`）。
- Thinking：**不提供**。`--effort` 不是每次运行的参数，而是写入 `~/.commandcode/config.json` 的 `reasoningEffort[model]`（实测在未认证退出前已落盘），会改写用户全局默认并泄漏到其他 Thread 与交互式 `cmd`；且各模型档位不同（Claude/GPT-5.6 `low…max`，deepseek-v4 仅 `high/max`，Qwen3.8 `low/medium/xhigh`）。effort 跟随用户自己的 CLI 配置。
- Fork / Rollback：不支持。`--fork-session` 只能派生整段会话尾部而非 checkpoint，打印模式没有 `/rewind`。
- Steering：`restart`；Work mode 仅 `default`。
- 空闲释放：Turn 之间没有常驻进程，`resourceLifecycle.suspend` 在已有 Native Ref 时结束输出。

## 已知副作用与限制

- CLI 在每次打印运行时于 cwd 创建 `.commandcode/taste/taste.md`（taste 功能自身行为，`--skip-onboarding` 不影响）。
- inspection 不反映认证状态；未登录在首个 Turn 以 `authenticationRequired` 暴露。
- 转录必须位于本机 `~/.commandcode/projects`（远程 Host 需要 Runtime 所在机器的 CLI 存储），否则 resume 返回 `sessionNotFound`。

## 验证状态

已执行（stand-in CLI fixture，按真实 CLI 的落盘时机与退出码行为编写）：`packages/adapters/command-code/test/`

- 协议帧解析（含 1.58.0 实机捕获的失败流）、退出码与参数拒绝映射、result + 退出码终态判定、认证措辞边界、Model 目录、参数装配、权限档。
- 转录回放：活动分支跨 `compaction` / `model_change` 节点、被回退的分支、按 ID 定位。
- Adapter 生命周期：create / Turn / 流投影（含仅 `tool_running` 的工具、`tool_denied`、`tool_errored`、shell `cwd`）/ fileChange / finalText 不重复 / 取消未落盘首轮不绑定身份并可重新创建 / result 后取消保持原生结果 / resume 会话取消 Turn 带已落盘 key / 终态前转录消失不绑定身份 / `success`+exit 9、+exit 1 / 认证失败 result 无 sessionId 不借用旧 key / `unknown model` → invalidRequest / read-only 拦截 / historyOnly 无 CLI 回放 / Turn 进行中 close 终结输出 / 身份不匹配。
- 公共 conformance 收据：核心场景 `passed`，`subagents` 为 `notCovered`，收据为 `incomplete`。

实机验证（1.58.0，隔离 HOME，未登录）：`--list-models` 不需登录；`-m` 小写 ID 解析；`--effort` 落盘与按模型拒绝；未认证 result 行无 `sessionId` + exit 3。未验证（依赖可用额度）：真实 `-p` 成功流的完整事件顺序、`tool_completed.result` 图像块形状、SIGTERM 与 flush 的实际竞争概率。
