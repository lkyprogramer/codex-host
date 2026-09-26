# R3 Desktop 稳定性实施记录

工作区：`/Users/luo/Documents/github/codex-host-r1`；分支：`codex/upstream-r1`。R3 基线 `2d048f9d`。范围为 [原始计划](../upstream-comparison-20260926/README.md) 的 U09、U10、U30。

状态：R3 实现、定向验证和 Astra/high 全面评审及修补复审已完成；F1–F5 全部关闭，无剩余明确 P1/P2。真实运行 Desktop 的新 binding 安装和原生多 Host 验收边界见下文。

## 实现范围

- U09：分离稳定 Host 连接与当前 Composer 路由。发现已提交 React 树上的 manager/registry，按 Host 解析连接，连接替换后旧 client/policy 失效。保留工作区、side-chat、草稿身份及 fork 原有 remote-control 能力。
- U10：CDP 跳过没有可 attach WebSocket 的目标；Agent 身份集合重排不触发重注入；发送按钮及 footer 替换时重新绑定控件并保留菜单状态。
- U30：update/start 请求超时视为结果未知，继续查询后台状态；重复点击不重复 start，关闭页面清理轮询；手动发布链接来自现有 update/check 返回值，无 UI 硬编码兜底。
- 保持现有多账号、Usage 和 Harness 能力语义；未增加账号/额度优化、CodeBuddy、历史导入、新 Harness 或 R4/R5 功能。更新服务的发布源与 URL schema 未改变。

## 验证环境与边界

Node `22.22.0`：`/Users/luo/.nvm/versions/node/v22.22.0/bin`；运行 Node 命令时移除 `NODE_USE_ENV_PROXY`。Playwright 使用本机 Google Chrome 的独立 headless 实例，额外移除 `NO_COLOR`：

```sh
export PATH=/Users/luo/.nvm/versions/node/v22.22.0/bin:$PATH
unset NODE_USE_ENV_PROXY
unset NO_COLOR
export CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

仓库默认 Playwright Chromium revision 1234 未安装，首次默认浏览器启动失败；没有安装浏览器或重启正在运行的 Desktop，改用本机 Chrome 完成 fixture 验证。

最终候选：TypeScript build（含插件）、Renderer 四份 bundle、typecheck、lint（含包边界检查）全部通过。受影响 17 个 Vitest 文件共 253 项通过，采用联合运行加失败/变更文件定向复跑：联合运行 244 通过、7 项旧 picker mock 缺字段失败；补齐真实 mock 合同后该 7 项通过；更新重连修复新增 2 项，最终相关 3 文件 49/49 通过，其余 14 文件 204 项字节未变且此前通过。没有用跳过、宽松断言或生产兜底消除失败。

Playwright 共 25 项通过：新跨层 Host routing 7 项、既有 Composer/startup/adapter lifecycle 16 项、Updates 2 项。Renderer owner 运行新 7 项，root 运行既有 16 项和最终 Updates 2 项。已查看菜单重绑定和更新页截图；最小 Composer fixture 的截图不是完整 Desktop 页面验收。

U30 最终 schema 合法 URL fixture：

```sh
npm exec -- playwright test --config tests/e2e/playwright.config.js tests/e2e/renderer-settings-update.spec.ts
```

结果：2/2 通过。测试挂载真实 Settings shell/Updates 页、模拟 update client，验证超时后进度恢复、单次 start、页面关闭清理、失败状态及发布链接。不是后端升级或任意 fork 发布源验收。

## 已运行 Desktop 的只读证据

见 [desktop-readonly-audit.json](desktop-readonly-audit.json)。已运行 `ChatGPT.app` 26.917.71314 / build 10954，Renderer CDP `127.0.0.1:63600`：Composer/Model/Permission/Send owner 可识别，96 个 sidebar Thread 全部解析且无歧义；新的只读 Host discovery 找到 1 个 editor、1 个 Host、1 个 manager、3 个 registry，并成功解析 Host。

该检查没有向现有 Desktop 安装本次生产 binding/routing，没有发送消息、切换模型、导航、执行更新或重启。主进程 Inspector 不可用，完整 `audit:codex-desktop` CLI 未运行；真实多 Host/remote-control、实际 Harness 发送及新 binding 在运行 Desktop 内的安装生命周期未验收。浏览器 fixture 不替代这些原生验证。

## 评审与提交

见 [REVIEW.md](REVIEW.md) 和 [plan.md](plan.md)。最终候选摘要见 [review-candidate.json](review-candidate.json)；R3 功能提交：

- `b62046eb`：CDP 可 attach 目标筛选、Renderer 注入身份集合。
- `e380a43c`：稳定 Host 连接、Composer 路由与控件生命周期、F1–F4 修复及跨层回归。
- `1568ba38`：更新超时与重连接续观察、F5 修复及回归。

R1/R2 已有 5 批提交见执行计划；R3 文档和截图独立一批提交。所有提交仅在本地，未推送、创建 PR 或部署。

## 最终候选检查命令

以下命令均已执行；测试包含上述联合运行与定向复跑。

```sh
npm run build:typescript
npm run build:renderer
npm run typecheck
npm run lint
npx vitest run --config tests/vitest.config.js \
  packages/desktop-control/test/cdp-client.test.ts \
  packages/desktop-control/test/renderer-cdp-control-session.test.ts \
  packages/desktop-control/test/production-controller.test.ts \
  packages/desktop-control/test/renderer-draft-prewarm-policy.test.ts \
  packages/desktop-control/test/renderer-host-routing.test.ts \
  packages/desktop-control/test/renderer-react-ownership.test.ts \
  packages/desktop-control/test/contract-audit.test.ts \
  packages/renderer-extension/test/versioned-renderer-adapter.test.ts \
  packages/renderer-extension/test/agent-selection-state.test.ts \
  packages/renderer-extension/test/renderer-binding-probe.test.ts \
  packages/renderer-extension/test/renderer-binding-probe-host-catalog.test.ts \
  packages/renderer-extension/test/renderer-host-clients.test.ts \
  packages/renderer-extension/test/renderer-model-client.test.ts \
  packages/renderer-extension/test/renderer-external-queue.test.ts \
  packages/renderer-extension/test/renderer-external-steering.test.ts \
  packages/renderer-extension/test/settings/pages.test.ts \
  packages/renderer-extension/test/settings/update-request.test.ts
npm exec -- playwright test --config tests/e2e/playwright.config.js tests/e2e/renderer-host-routing.spec.ts
npm exec -- playwright test --config tests/e2e/playwright.config.js \
  tests/e2e/renderer-chat-composer-isolation.spec.ts \
  tests/e2e/renderer-binding-startup.spec.ts \
  tests/e2e/renderer-adapter-lifecycle.spec.ts
git diff --check
```

U30 独立 E2E 命令与结果见上节。源码没有 Rust 变更，本轮不重复 Rust 全仓检查；无实际升级、发布、推送或 PR。

最终修复后的定向复跑命令：

```sh
npx vitest run --config tests/vitest.config.js \
  packages/renderer-extension/test/settings/pages.test.ts \
  packages/renderer-extension/test/settings/update-request.test.ts \
  packages/renderer-extension/test/renderer-binding-probe-host-catalog.test.ts
```

结果 3 文件、49 项通过。Pages 新增测试覆盖首次 start 超时、local client 消失、替换连接返回 succeeded/failed，以及 320 次轮询后手动继续观察使用新 client；均断言不再次 start。

最终 25 个源代码/测试文件 Prettier 检查、SHA-256 对照和 `git diff --check` 均通过。
