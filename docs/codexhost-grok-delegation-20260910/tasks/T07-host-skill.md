# T07 — Host 委派技能与通用使用文档

依赖：T04、T06。Owner：Host writer。

## 输入与允许路径
仅在 codex-host 独立 worktree 内修改 packages/host-runtime/src/delegation-skill.ts、其直接测试，以及由仓库现有生成链管理的委派技能与必要 CLI 文档。安装副本不是维护真源。先读取 managed skill 的版本、digest、生成及升级规则；不新增项目策略系统，不修改消费项目或用户全局配置。

## 实现任务
1. 更新通用 skill，使用 Host 提供的 CODEXHOST_CLI_PATH 与真实 help；示例参数须对应 T02–T06 的最终实现，不硬编码本机路径。
2. 明确 cwd、输入文件、parent/task/turn 身份、幂等请求、busy、UNKNOWN、取消后静止确认、恢复与 release 的使用顺序。
3. 默认协调采用紧凑状态与 wait-many 增量；需要核验时显式读取 activity/evidence，不能从摘要或文件 hash 推导工具操作成功。
4. 给出 Grok writer 与独立 reviewer 的通用例子：派发前 inspect，核对实际 harness/model/thinking/权限；保留调用者指定的 Harness 和模型，不在产品中强制全局 Grok 默认，也不静默切换 Codex。
5. 按仓库既有机制更新 managed skill 的 version/digest、生成结果和直接测试；验证新安装与旧版本升级，不直接改写现用安装。

## 测试与验收
- SKILL-01：delegation-skill 的直接测试覆盖内容生成、version/digest 一致性、新安装和现有受管版本升级；保留现有用户编辑处理语义。
- SKILL-02：文档中新增命令与参数可由当前 CLI help 及隔离入口验证；无本机绝对路径、消费项目规则或不存在的选项。
- SKILL-03：新建独立 Grok 任务读取生成技能，在合成工作区正确处理 busy、UNKNOWN 与取消未静止；不会盲重试创建或提前释放资源。
- SKILL-04：显式选择的 Harness/配置被保留；缺能力准确报告；真实观察使用增量读取，证据缺失保持未验证，不冒充独立审查已通过。

定向命令：npx --no-install vitest run --config tests/vitest.config.js packages/host-runtime/test/delegation-skill.test.ts。若仓库调整了测试路径，按当前源码定位同一直接测试并记录实际命令。通过 T01 入口执行对应 hermetic 场景和真实 Grok 技能前测；生成/结构检查使用仓库现有命令，保存实际结果。

## 交付与停止
交付 codex-host 内完整提交、生成一致性与直接测试证据。能力或命令变更同步对应通用文档；不扩展为业务接入、外部规则迁移或新的编排平台。
