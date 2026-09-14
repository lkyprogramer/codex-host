# 最终验证证据

本目录绑定 `codex/full-review-remediation-20260912` 的本地工作树。原始提交 HEAD 仍为 `38964658185bd090b4044f0cc9f5b575d8284b87`；实际修改文件及 SHA-256 见 `tree-manifest.json`。该 manifest 排除评审报告自身、构建产物和既存用户调研目录，避免自引用；不把未提交工作树冒充提交对象。

- `typescript-tests.log` / `typescript-results.json`：最终全仓 3,771 passed、22 skipped，后者含逐文件结果、27 个 conformance 用例和精确跳过项。
- `rust-tests.log` / `rust-results.json`：完整 Rust 工作区 172 passed；`clippy.log`、`rust-format.log` 是额外静态检查。
- `e2e.log`：73 项系统 Chrome 合成页面回归；`dynamic-submit.log` 是随后增强的未知固定模型提交事件复跑。
- `typecheck.log`、`lint.log`、`format.log`、`docs-format.log`、`diff-check.log`：类型、边界、格式和 diff 检查。
- `plugin-build-receipts.json`：十个实际生成的插件收据，已逐一核对 Bundle 字节的 SHA-256。
- `remote-reuse-profile-before.log` / `remote-reuse-profile-after.log`：临时测量的 lsof 阶段耗时；采样结束已移除 production instrumentation，没有放宽测试阈值。

所有原生版本未知字段保留 null。fixture、Bundle 加载和合成 UI 各自构成独立证据，不拼接成一次真实 Harness/安装态 Desktop E2E。原始失败及 owner 工作日志保存在 `/tmp/codexhost-remediation-20260912/`，本目录保存最终可读的验证结果。
