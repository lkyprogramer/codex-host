# T00 — 已修复基线与 npm CLI 复验

状态：VERIFIED。不是待开发任务。

用户确定从 /Users/luo/Documents/github/codex-host/local/all-fixes@80f3116530c47e05ec24b97f267c011bbf7be982 继续。现有 CLI/npm/Windows shell/Account 分页修复保留。严禁因整理 PR 改从旧 origin/main 起步。

已执行：原始 CODEXHOST_CLI_PATH 的 delegate --help、harness inspect grok、旧任务 read；创建一个只读 Grok child 检查其原始 CLI；原样运行返回的 next.wait、next.read。结果均成功。child 结果为 PATH_RECHECK_OK，task 0560586f-7af7-42ca-a278-87b1a1ba2d52，实际 grok-4.6/medium，completed。

证据：/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/evidence/npm-path-start.json、npm-path-next-wait.json、npm-path-next-read.json、npm-path-help.json、npm-path-inspect.json、host-baseline.json。

开始开发时只核验对象存在、输入和运行环境是否漂移。无漂移复用本证据，不重写已存在的 npm 修复。若未来新安装导致回归，先根据实际 failure 定位，不自动推翻本轮结果。

