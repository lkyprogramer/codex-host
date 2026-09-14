# 隔离复现记录

以下5项由主代理在当前源树执行。全部使用临时目录或内存替身，不调用真实Harness/模型、不操作Desktop、不读取用户凭据。动态脚本用Node22.20.0；直接导入dist的3项发生在本轮build:typescript成功之后，Renderer的2项由esbuild直接绑定当前源代码。

## R01 · stock Codex steer 被扩展RPC阻断（F14）

用esbuild将packages/renderer-extension/src/renderer-external-steering.ts打成Node ESM临时Bundle。安装hook到合成manager：原生steer计数；sendRequest对扩展ownership方法抛code=-32601；其余必需方法按实际接口形状提供。调用steerTurn。

```json
{"error":"Method not found","code":-32601,"nativeCalls":0,"rpc":["codexhost/thread/ownership/list"]}
```

Bundle位置：/tmp/codexhost-review-20260912/steering-repro-bundle.mjs。结论仅证明当前hook的控制流，不是实际Desktop渲染验收。

## R02 · Antigravity clone裁剪失败仍成功（F03）

在临时HOME创建source conversation DB，使用真实node:sqlite，故意保留steps表而没有trajectory_meta，以模拟关键schema不匹配。

```sql
CREATE TABLE steps (idx INTEGER, step_type INTEGER);
INSERT INTO steps VALUES (0,14),(1,14),(2,14);
```

调用本轮编译的cloneNativeConversationDb('source','derived',1,tmpHome)，读取derived中step_type=14计数：

```json
{"cloned":true,"expectedRetainedUserSteps":1,"actualUserSteps":3,"fixtureHome":"/tmp/codexhost-review-antigravity-MWSYkC"}
```

这证明关键SQL异常被吞、保留边界未实现仍报告成功；没有据此声称当前用户DB恰好缺该表，也没有执行真实agy下一Turn。

## R03 · Kiro未知mode进入autopilot（F04）

把四个字符串先通过当前harnessPermissionModeIdSchema，再交给真实decodeKiroPermissionMode：

```json
[{"input":"supervised","nativeAutopilot":"off"},{"input":"autopilot","nativeAutopilot":"on"},{"input":"deny-all","nativeAutopilot":"on"},{"input":"ask","nativeAutopilot":"on"}]
```

公共Host RPC对合法形状ID没有额外catalog membership过滤，调用链见报告。没有启动Kiro或执行受权限控制的工具。

## R04 · Store重开删除Thread却保留委派去重记录（F06）

真实MappingStore初始化临时directory，createDelegatedThread写入creating Thread和delegation（requestId=req-1、latestHostTurnId=turn-1），不提交Native Ref；close后用新Store实例initialize，并读取child-1与findDelegationByRequest。

```json
{"thread":null,"duplicateRetained":true,"duplicateStatus":"creating","duplicateTurnId":"turn-1","fixtureDirectory":"/tmp/codexhost-review-mapping-nQ5m4Q"}
```

该过程模拟相同持久落盘边界下的恢复，不是实际kill/断电测试。close不主动删除provisional记录；删除发生于下一次initialize。

## R05 · Usage relay拒绝重绑新Host client（F23）

用esbuild将renderer-model-client.ts直接打包。真实createThreadUsageSubscriptionRelay先subscribe一个listener，再依次connect合成client A与B，然后用A保留的通知回调推送一条更新。

```json
{"aSubscriptions":1,"bSubscriptions":0,"aUnsubscribes":0,"oldHostUpdatesReceived":1}
```

统计发生在relay.dispose之前；dispose随后执行清理。Bundle位置：/tmp/codexhost-review-20260912/model-client-repro-bundle.mjs。该复现证明relay自身不切换客户端；完整跨Host UI显示仍需目标环境验证。

临时Bundle和两个SQLite/Store夹具保留为必要复现证据；报告中的步骤和输出已持久保存，即使系统清理/tmp仍可重建。
