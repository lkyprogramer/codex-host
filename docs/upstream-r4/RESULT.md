# R4 数据与观测实施记录

工作区 `/Users/luo/Documents/github/codex-host-r1`，分支 `codex/upstream-r1`，基线 `1127cbc1`。R1–R3 已提交，本轮开始时 worktree 干净。R4 实现、必要验证和 Astra/high 全面评审及修补复审已完成；六项 findings 全部关闭。U33 按条件项保留暂缓，原生验收边界见下文。

## 范围

- U13：同一 Turn 文件变更汇总，实时与回放共用路径；保留原始 Item 与来源。评审要求补齐真实 Adapter provenance，涉及 Claude/Pi/Grok/OMP 直接输出路径，不增加这些 Harness 的新能力。
- U22：本地 Host 只读 Resources 页，从既有 ManagedHarnessSession / ExternalThreadRuntime 投影缓存状态；列出 Thread ID、Harness、运行状态、资源状态、最近活动和历史释放结果。无原生探测、唤醒、释放、强杀、账号/额度或 transcript 数据。
- U24：Claude `modelPicker.options`，尊重配置目录，支持追加/替换/去重和非法配置回退；不读取真实用户凭据。
- U25：已管理 OMP child JSONL 冷读取；验证父身份、路径/符号链接和文件大小/变化；缺失回退 RPC，坏文件显式失败，不创建任意导入入口。
- U32：本机 Desktop 安装代码有 `section_position` 分组分页调用，纳入官方请求/原生 cursor 透传；不注入外部 Thread 或跨账号时间排序。
- U33：按原计划的条件项暂缓。隔离环境确认无 override 时 Shim 会拒绝，但没有证据证明当前真实 Desktop node_repl 会清洗两个 override；保留 fail-closed。详见 [conditional-scope.md](conditional-scope.md)。

## 文件汇总的来源边界

`sourceItemIds` 只表达原生 fileChange 与真实 tool item 的来源关系。OpenCode 的 Turn diff 可能不完整，不能据此抑制整个 Turn；其每文件 `coveredToolItemIds` 仅表达已经验证为同一文件的展示覆盖。投影按工具 ID 和规范文件路径过滤，未覆盖文件、空/失败 diff 保留工具预览。历史中缺少原生补丁时不补造文件内容。可选元数据不改变已有 Native Session 文件格式，也不作为回滚文件的证据。

## 证据边界

使用 Node 22.22.0；`PATH=/Users/luo/.nvm/versions/node/v22.22.0/bin:$PATH`，移除 `NODE_USE_ENV_PROXY`。Playwright 另移除 `NO_COLOR`，通过 `CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` 使用独立 headless Chrome。没有重启或替换运行中的 Desktop。

Resources 页实际 Chrome fixture 截图见 [screenshots](screenshots)。root 已查看窄窗长列表截图。Browser fixture 运行生产 Settings/client 代码与合成 Host 边界，不能替代安装到真实 Desktop 后的验收。

U13 的已安装 Desktop 消费者静态证据：`ChatGPT.app/Contents/Resources/app.asar` 中 `webview/assets/app-initial-51da50e6c6e3.js` 的 `item/fileChange/patchUpdated` handler 找到已有 fileChange item 后替换完整 `changes`，缺失时创建 inProgress item；`item/completed` 按相同 ID 更新；`turn/diff/updated` 替换 Turn diff。这证明事件合同可消费，不是新汇总代码在真实 Desktop 文件卡片中的渲染验收。

真实 OMP 重启后的 child 打开、真实 Claude 配置/模型选择、新文件汇总在运行 Desktop 的卡片渲染、本次 Resources 安装到真实 Desktop、实时 section_position 分页均未运行。禁止读取个人 transcript/凭据、应用重启、实际升级/发布。

## 验证与评审

独立评审与逐项修复见 [REVIEW.md](REVIEW.md)。使用 `/Users/luo/.codex/agents/reviewer.toml` 的原生 reviewer；实际运行记录核验为 `gpt-6-astra / high`。最终 77 个代码/测试/依赖文件 SHA-256 清单见 [review-candidate.json](review-candidate.json)。

| 检查 | 已观察结果 |
| --- | --- |
| TypeScript build（含插件）与 Renderer 四份 bundle | 通过 |
| `npm run typecheck` | 最终通过，包含全部测试 TS 编译 |
| `npm run lint` | 最终通过，包含包依赖/源码 import 边界 |
| 统一定向 Vitest | 35 文件、843 项通过 |
| F5/F6 与资源 invariant 修复后定向复跑 | 15 文件、337 项通过 |
| 测试改用公开 exports 后复跑 | 3 文件、80 项通过 |
| Chrome Resources + Updates | 7/7 通过；迟到响应、断连/重连、关闭、超时恢复、窄窗长列表 |
| 所有候选文件 Prettier、`git diff --check`、最终摘要核对 | 通过 |
| U33 隔离 Shim 既有测试 | 1/1 通过，预期无 override 时拒绝；不证明真实 node_repl 触发 |

以上运行存在重叠，不把 843、337、80 相加当作独立用例数量。最终修复仅影响定向复跑覆盖的 Adapter/测试和资源 invariant；其余候选字节保持不变。首次 lint 的 non-null assertion 与后续跨包源码测试 import 错误均已修复；没有删除边界规则或削弱断言。页面冻结合同和新增页面 ID/label 预期、SDK 测试模型字段及事件类型也已修正。

精确测试文件见 [validation-files.json](validation-files.json)。统一运行与最终修复运行分别以该文件的 `vitest` / `finalRepairVitest` 数组传入以下实际执行器（首次使用 `vitest`，修复后改为 `finalRepairVitest`）：

```sh
node --input-type=module - <<'JS'
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const {vitest}=JSON.parse(readFileSync('docs/upstream-r4/validation-files.json','utf8'));
const r=spawnSync('node',['node_modules/vitest/vitest.mjs','run','--config','tests/vitest.config.js',...vitest],{stdio:'inherit'});
process.exit(r.status ?? 1);
JS
npm run build:typescript
npm run build:renderer
npm run typecheck
npm run lint
npx vitest run --config tests/vitest.config.js \
  packages/adapters/omp/test/omp-adapter.test.ts \
  packages/adapters/pi/test/pi-adapter.test.ts \
  packages/protocol-core/test/claude-history-file-change.test.ts
npm exec -- playwright test --config tests/e2e/playwright.config.js \
  tests/e2e/renderer-settings-resources.spec.ts \
  tests/e2e/renderer-settings-update.spec.ts
git diff --check
```

`package-lock.json` 通过 `npm install --package-lock-only --ignore-scripts --offline` 更新，仅新增 protocol-core 对现有版本 `diff@8.0.2` 的运行依赖。没有 Rust 源码改动，本轮未运行 Rust 全仓测试；U33 的单项既有测试记录在条件项文档。

## 提交

已完成本地功能提交：

- `6104a678`：U24 Claude 自定义模型目录。
- `d001ccbc`：U32 官方 section_position 分页透传。
- `de31ab15`：U13 文件汇总与来源一致性、U25 OMP child 冷恢复。
- `90f42506`：U22 本地 Session 资源只读观察。

OMP 冷历史读取与来源投影共用改动，因此 U13/U25 同批。文档、证据和截图作为第五批提交（`docs: record R4 delivery and Astra review closure`）。未推送、创建 PR、部署或重启 Desktop。
