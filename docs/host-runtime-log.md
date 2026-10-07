# Host Runtime 运行日志

Codex Desktop 接管 Host Runtime 的 stderr，只保留最后一行。Host 崩溃、卡住或某个 Harness 列表加载不出来时，没有落盘的诊断就无从排查。Host Runtime 因此把自己的 stderr 同时写进一个有大小上限的私有文件；Desktop 收到的 stderr 不变。

## 位置与格式

- 路径：`$CODEXHOST_DATA_DIR/logs/host-runtime-<pid>.log`，未设置时为 `~/.codexhost/logs/host-runtime-<pid>.log`。
- 每行以 UTC 时间和进程号开头，例如 `2026-10-07T10:00:00.000Z [4242] ...`。
- 启动时记一行 `Host Runtime started`，退出时记一行 `Host Runtime exited with code <n>`。
- 未捕获异常与未处理的 rejection 由进程守卫（`process-guard.ts`）写到 stderr，因此连同堆栈一起进入日志；日志本身不注册任何异常处理，不改变崩溃时的行为。
- 只记录常驻的 Host Runtime。委派 CLI、远程 CLI、Harness broker 等子命令仍只输出到各自的 stderr。

## 上限与清理

- 单个文件超过 5 MiB 时轮转为 `host-runtime-<pid>.log.1`，每个进程只保留一份旧文件；单次写入超过上限时只保留最新部分，且不截断 UTF-8 字符。
- 目录中所有 `host-runtime-*.log` 合计超过 50 MiB 或超过 20 个文件时，从最旧的开始删除：轮转出的旧文件和已退出进程的文件可以删，仍在运行的进程的当前文件不删。同目录的其他诊断文件不受影响。
- 目录权限 `0700`，文件权限 `0600`。

## 敏感信息

写入前，名称含 token、secret、password、passwd、api_key / apikey、credential、cookie、auth（不区分大小写）的环境变量，若取值不少于 8 个字符，其值会被替换为 `[redacted]`。这只能识别出现在同一次写入中的完整取值；一个取值被拆在两次写入之间时识别不到。不要在诊断中主动输出凭据。

## 失败行为

日志目录不可写、文件无法打开或写入失败时，日志静默停用，Host 照常运行，stderr 照常转发给 Desktop。

## 验证

`packages/host-runtime/test/runtime-log.test.ts`：路径、时间戳与转发、退出记录、轮转、目录上限与活动进程保护、UTF-8 截断、权限、失败不影响 Runtime、凭据脱敏。

来源：借鉴上游 `49fbe920`（BytePioneer-AI/codex-host，#404），新增脱敏，致命堆栈改由进程守卫提供；见 [上游对比 V06](upstream-comparison-20261007/README.md)。
