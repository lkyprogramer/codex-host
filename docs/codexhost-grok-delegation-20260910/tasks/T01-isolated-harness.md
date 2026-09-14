# T01 — 建立隔离真实 Grok/CLI 验证入口

依赖：T00。Owner：Host writer。交付：可重复调用的测试入口和候选绑定，不修改现用 Desktop/Host。

## 输入与阅读
- /Users/luo/Documents/github/codex-host/AGENTS.md、package.json、.node-version、tests/vitest.config.js。
- packages/host-runtime/src/index.ts、run-host-runtime.ts、delegation-control-server.ts、delegation-control-registry.ts、app-server-host.ts 的装配路径。
- packages/host-runtime/test/harness-delegation-coordinator.test.ts 和现有 tools/gate-c、tools/gate-claude-code 中真正可复用的测试装配片段；只按必要方法读，不复制整个 Gate。

## 允许修改
新增 tools/delegation/verify.mjs、该目录的测试辅助模块和 *.test.mjs；新增 tools/delegation/fixtures/ 合成材料；必要时小幅暴露 host-runtime 已有生产装配工厂并加对应测试。不得修改 adapters 的业务语义、现用安装、用户配置、真实映射存储、业务仓库。

## 实现任务
1. 实现 EXECUTION.md 的 --list、--mode hermetic|live、--scenario、--output；未知用例与不支持模式明确失败。`--scenario all-required` 展开 TEST_MATRIX.md 中适用于所选 mode 的全部必需场景，并在结果中列出实际展开集合；单一 mode 的成功不能代替另一 mode 的验收。
2. 每 run 使用独立 repo/worktree、mapping/data 目录、loopback 控制端点及可追踪进程。不要隐式继承当前 Host 的 endpoint/token 作为测试对象。
3. live 经真实生产 CLI、control server/registry/Host、真实 Grok Adapter；复用生产事件处理和状态持久化。需要 public factory 时只增加真正需要的注入边界，不写另一份 Coordinator。官方 Codex 仅允许为控制元数据提供真实或明确标记的 fixture，严禁发送官方模型推理请求来冒充 Grok 测试。
4. Grok 使用现有 native 登录能力；不复制认证文件、不打印凭据。stdout 记录状态和数据目录，token 只在子进程环境传递。
5. 命令默认有界；记录 Node/npm、source SHA、所加载候选 bundle/hash、PID、argv、stdout/stderr、退出码、生成物和 cleanup。finally 保留原始失败，另记清理失败。
6. 实现 SMOKE-01：真实 Grok 回复唯一 token，配置生效、父子关联、cwd 可核验，显式 read 取得结果。退出后无本 run 活动命令或未说明记录。

## 测试
- ENTRY-01：--list 可读且用例唯一；无效模式/场景/不可写输出目录非零退出。
- ENTRY-02：不能把继承的现用 endpoint 误作隔离目标；token 不出现在报告。
- ENTRY-03：故障与清理失败同时存在时保留两个原因；fixture 数据不会写到用户仓库。
- SMOKE-01：真实 Grok 端到端成功；fake mode 必须标 hermetic，禁止 live。
- 不运行 npm start；它会停止现用 Desktop。

命令（入口实现后）：node tools/delegation/verify.mjs --mode hermetic --scenario ENTRY-01,ENTRY-02,ENTRY-03 --output <run-dir>；再运行 --mode live --scenario SMOKE-01。
定向 Vitest：npx --no-install vitest run --config tests/vitest.config.js tools/delegation。

## 完成与停止
提交 helper 与测试；返回候选和原始日志。无法建立真实隔离装配时报告具体缺少的 public seam，不改用现用 Host 或 mocked provider 宣称通过。只允许为该入口增加必要装配边界，不升级为通用 CI 平台。
