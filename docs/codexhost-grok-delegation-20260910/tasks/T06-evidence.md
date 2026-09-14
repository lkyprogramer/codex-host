# T06 — 用户可见活动证据与实际执行配置

依赖：T05。Owner：Host writer。目标：协调者能核验 reviewer 实际工具读取/测试，恢复后也能查询真实模型与权限，默认读取仍简洁。

## 输入
HostCommandExecutionItem/HostToolExecutionItem/HostFileChangeItem（packages/harness-adapter/src/text-session.ts）；Grok tool output projection；delegation-snapshot.test.ts 的隐藏内容测试。

## 写边界
Host normalized activity 投影、delegation API/types/CLI、必要 snapshot/repository 接入和直接测试。不得开放原生 transcript 文件下载、隐藏推理、全量会话导出；不在 Host 存第二套未经必要性的 transcript。

## 实现合同
1. 新增显式 activity/evidence 视图，只来源于已有用户可见 command/tool/file-change items；按 thread/turn/item 身份和稳定 cursor 分页。默认 result/status 继续过滤这些内容。
2. 默认只给操作类型、item ID、关联 turn、允许的文件/命令信息、退出/完成状态、输出是否截断等元数据。输出正文通过显式选项按条取，并有字节上限与 truncated 标识。
3. reasoning/thought/internal auth/私人原生事件永不因选项出现；对现有敏感测试 fixture 增加负例。不能把 Host token 或环境全量输出当调试证据。
4. 配置查询区分 requested/effective 与 unknown：harness、model、thinking、permission mode、cwd、delegation/parent/turn；不得用默认值填补未观察信息。
5. 文件 hash 仅证明版本绑定。阅读证据需要成功的真实工具操作与可复核返回；输出截断或所读路径/内容不匹配时不能标“完整已读”。不要让 validator 靠自报 read_files 通过。
6. 对已不存在的旧 activity 明确 unavailable，不从聊天总结补造原始工具证据。公开 API 只导出适用 task 的事件，不自动抓取其它 Session。

## 测试
- EVIDENCE-01：真实 Grok 在 temp repo 读取含唯一 sentinel 的文件；可取对应用户可见工具条目并核对路径/结果，不能只返回 agent 宣称已读。
- EVIDENCE-02：成功、失败、截断、旧结果缺失各有准确状态；cursor 重复读取稳定，跨 thread 拒绝/明确重置。
- EVIDENCE-03：默认 read 不泄露工具/思考；显式 activity 仍不暴露 reasoning/private/auth fixture。
- EVIDENCE-04：恢复后的实际 Grok model/thinking/permission 可查询且等于运行配置；未知状态不猜测。
- 公共 evidence 是运行证据，不自动成为 review PASS；绑定与语义判断由调用方对冻结候选独立判断。

命令：Vitest delegation-snapshot、CLI、API、external-thread-runtime 和 Grok projection 相关文件；live verify.mjs --scenario EVIDENCE-01,EVIDENCE-04。

## 完成
读取轨迹可由调用方验证，默认界面保持现有隐私边界；不以“hash 对上”替代 reviewer 阅读事实。

