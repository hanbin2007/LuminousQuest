# 训练阶段 Agent Loop（双轨制）+ 真实 AI 接入 + 3D 联动（M6 v2）

日期：2026-07-23 ｜ 状态：v2。用户裁决（2026-07-23）：**要完整 agent 自主性**——给
agent 足够信息让它自主评判，不做规则木偶；**原生 function calling**；**影子记录保留**
（用户明确同意）。v1 的"frontier 规则层掌权/socratic 扩展"路线作废；v1 评审中机制性
风险与门禁仍然有效（见 §6）。Modelverse 暂不充值：开发与实验通道 = claude-agent。

## 0. 双轨制（本规格的核心）

- **驾驶轨（agent，自主）**：agent 拿到全部信息——只读 `DiagnosticProfile`（前测
  基线：逐节点 outcome + 误区 id + 证据引文）、量表全文、知识模型、题库、逐轮学生
  作答、**以及影子判分结果（作为参考信息注入，可采纳可不采纳）**。它自主决定：问
  什么、怎么问、如何评价学生（评语即它自己的判断）、何时深入/跳过/结束。前测结果
  的"已掌握快速过、薄弱处细引导"通过系统词指引表达，不做硬性规则约束。
- **记录轨（确定性，权威账本）**：学生每次作答，后台静默运行既有判分管线
  （choice/builder/equation 确定性引擎；text 走抽取+规则），写既有 assessment 事件。
  3D 灯态、量表维度进度**只由记录轨派生**（现状机制不动）。agent 的结论写
  `agent-judgment` 事件（新类型，非量表事件）；两轨分歧写 `divergence` 事件，教师端
  可见，不打断对话。
- agent 输出永不产生/修改 assessment、灯态、进度事件——不是限制它的自主性，而是
  记账权分离：它的判断有自己的事件通道。

## 1. 工具层：原生 function calling

- 工具定义统一声明一份（name/description/JSON Schema），provider 适配层转译：
  OpenAI 兼容系（glm/deepseek/tongyi）走 `tools` 参数原生 function calling；
  claude-agent（开发通道）走 SDK 原生工具协议。zod 校验工具参数（原生 ≠ 免校验），
  非法参数带原因回传一次重试，再失败按工具语义兜底。
- 工具集 v1：
  - `ask_student { text }`：向学生发问（题库题、自组织追问、过渡语均可；出题类
    文本过既有泄漏守卫——守卫拦下不是禁止提问，而是拦"直接泄答案"）；
  - `present_material { materialId }`：展示题库图/素材；
  - `focus_node { nodeId }`：3D 非权威聚焦（镜头+呼吸提示，不改灯态）；
  - `get_profile {}`：拉取画像最新快照（含影子判分累计）；
  - `conclude_node { nodeId, verdict, rationale }`：记录 agent 对某节点的结论
    （→ agent-judgment 事件；与影子分歧自动派生 divergence）；
  - `end_session { summary }`：收尾并生成给学生/教师的小结。
- 学生作答不经工具——作答提交即触发记录轨判分，结果自动注入 agent 下一回合上下文。

## 2. Loop 运行时

- 服务器端回合制：学生消息/作答落事件流 → 组装上下文（系统词 + DiagnosticProfile +
  对话事件重建的 last-K 轮 + 影子判分摘要）→ provider 调用（温度 0.1）→ 工具执行 →
  事件落流 → 前端渲染（agent activity stream + 逐轮聊天 UI）。
- **上下文一律从事件流重建**（不持有进程内会话状态）：服务重启/换机可恢复；这也是
  断网 demo 的回放基础。K 轮截断，不做摘要 LLM 调用。
- 降级：provider 不可用 → 聊天区提示 + 训练退回既有确定性脚手架流程（现状行为）。

## 3. 直接评判实验（准入证据，先行）

- 52 个人工标注用例跑 direct-judge 模式：量表+题目+学生原文 → 模型直接给
  hit/partial/miss + 误区。与人工标注对表，与抽取管线（94.23%）同台比：宏命中、
  **全错判掌握率**、三跑一致率。provider = claude-agent（不充值）。
- **裁决修订（2026-07-23 深夜）**：v1 实验因提示词残缺无效（用户质询推动复检）。
  v2（完整上下文+量表全文+评分裁量）：**98.08%，全错判掌握 0/13，一致性 98.08%，
  全面反超抽取管线**。原「记录轨由抽取+规则独占」裁决作废；修订方向=直判为主判
  进记录轨、抽取管线转静默审计（分歧留痕教师）。详见 evidence/2026-07-23-direct-judge-v2.md；
  限制：语料仅膜题一题，外推需扩标注。

## 4. Track 划分

- **C'（主体，codex gpt-5.6-sol max）**：LLM 层原生 function calling（openai-compatible
  `tools` + claude-agent 适配 + 统一声明/校验/重试）→ loop 运行时 → session.v2 事件
  扩展（agent-turn / agent-judgment / divergence，新增最小化，导入导出/教师端/公开
  视图门控同步）→ 逐轮聊天 UI → 影子判分挂接 → 降级路径。开工 1–2 天内先冻结
  事件 schema 契约交付 Track D。
- **B'（小，并入 C' 首日）**：`buildLearnerProfile` 打包为 agent 上下文
  `DiagnosticProfile`（只读、版本化、训练不回写前测基线）+ 系统词 pacing 指引。
- **D（Fable 亲自）**：focus_node 联动、维度进度（判分派生）、聊天/活动流视觉。
- **E（Fable，先行）**：直接评判实验脚本与报告。

## 5. 顺序

E（今天）→ C' 规格双评审（评审 how，不评审 whether——自主性与双轨已由用户裁决）→
C'+B' 实现 → D 并行 → 联调 → 里程碑终审（gpt-5.6-sol max + fable-5）。

## 6. 继承自 v1 评审、仍然有效的门禁

- 断网 demo：脚本化会话回放（温度 0 + requestHash 命中，操作者照稿）；录制版本不
  一致**拒绝启动**（现仅告警，需改）。
- config 改动（若涉及）与 s12-p1 别名修复合并一批，configDigest 全链路重同步 +
  立即全量重录 demo。
- provider 断开训练可走确定性流程；全量测试 + 打包 + 一次断网彩排为冻结门禁。
- session.v2 闭集事件扩展波及面（导入导出/教师端/fixture/demo）在 C' 验收清单内
  逐项核对。

## 7. 双评审收敛终稿（2026-07-23，实现契约）

两报告全文见 scratchpad（spec-v2-review-gpt.md / opus 报告在会话记录）。共识与裁决：

**P0 契约（Phase 1，先冻结再开工，交付 Track D）**
1. **响应契约**：ask_student 类等待作答的工具必须绑定服务端生成的
   `responseContractId`（固化 questionId/caseId/targetNodeIds/判分入口）；学生端只提
   交 `turnId + answer`；题库结构化题走 `present_question { questionId }`；无法绑定
   契约的交流显式记 `unassessed`，不假装已判分。
2. **事件三元组**（session.v2 扩展，按 kind 分支校验，修掉"非 answer 即评测事件"
   的隐含假设；pipelineStage 单调性排除分支；schema 版本标记加
   `agentContractRevision + toolsetDigest + contextBuilderVersion`）：
   - `agent.turn.completed { turnId, triggerEventId, contextThroughSequence,
     requestHash, source, model, orderedActions, terminalAction, provenance }`
   - `agent.judgment.recorded { turnId, nodeId, verdict: hit|partial|miss|
     inconclusive, rationale, basisThroughSequence, basisEventIds,
     supersedesEventId?, provenance }`
   - `agent.divergence.changed { judgmentEventId, shadowAssessmentEventId,
     agentVerdict, shadowVerdict, status: detected|resolved,
     comparisonPolicyVersion }`（与 judgment 同事务；resolved 追加不删除历史；
     比较基准 = basisThroughSequence 时记录轨选中的 assessment，hit-with-help→hit，
     needs-review/unanswered/unassessed 不可比）
   - `answer.submitted` 增 `responseToAgentTurnId? + responseContractId?`
3. **工具二分与回合事务**：terminal（ask_student/end_session，结束本轮等外部输入）
   vs continuation（get_profile/present_material/focus_node/conclude_node，即时回
   灌）；写类工具进 TurnTransaction，唯一 terminal 出现后原子提交，失败整体丢弃；
   上限：6 次 continuation、8 次工具调用、每节点每 turn 至多 1 次 judgment；handler
   串行 + terminal latch。
4. **会话权威与恢复**：新增 `/api/session/sync`（启动/导入/服务端 404 后全量上传，
   服务端校验 schema+configDigest+事件前缀）；所有命令带
   `expectedSequence + idempotencyKey`，per-session mutex 串行。
5. **投影安全边界**：agent.turn 不存系统词/题库答案/thinking/get_profile 原始结果，
   只存规范化动作；学生 projection 与教师 audit projection 分离，导出同规则；
   既有"评测响应返回完整 session"的泄漏面纳入本次验收。
6. **回放确定性**：loop provider 每轮以 cacheKey(requestHash) 回放（demo 模式接通
   cacheKey 查找，不再用静态 stepId）；重建上下文禁含 occurredAt/耗时等非确定量；
   K 按逻辑轮次（agentTurnId↔responseToAgentTurnId 分组）截断；claude 路不响应
   temperature——确定性只依赖事件+录制+hash，不写成跨 provider 保证。

**适配层裁决**（两报告分歧点）：不硬扩 LLMProvider；新增 provider-neutral
`AgentTurnAdapter`（返回规范化 tool-call trace + usage）。claude-agent 路采
**gpt 方案**：SDK `tool + createSdkMcpServer`，`tools:[]`（真正移除内置工具——现
实现 allowedTools:[] 并未移除，属既有 bug）+ `allowedTools:["mcp__lq__*"]` +
`strictMcpConfig:true` + `persistSession:false` + 足量 maxTurns（opus 的直连
Messages API 方案因订阅 OAuth 凭据面向 Claude Code 表面，弃）。openai-compatible
路：保存 assistant tool_calls、同 id 回填 role:"tool"、`parallel_tool_calls:false`、
zod 终审，仅认证一个冻结用 provider。健康检查加真实 tool-call canary。

**泄漏守卫三路**：题库题按内容 hash 原样展示；自由追问按 responseContractId 查未公
开目标事实；学生可见总结查全案例未公开事实+最近 2–3 条 agent 输出拼接。失败返回
错误类别允许一次修复，二次用教师审核兜底文本；end_session 学生总结必过守卫；
proxyReference/completeEquation 两启发式对提问文本停用（防误杀反问）。

**DiagnosticProfile**：仅前测阶段事件的纯投影（buildLearnerProfile 现聚合全场会
回写基线，需新投影函数），并补出 misconceptionIds。

**排期（gpt 版，采纳）**：7/23–24 契约冻结（Phase 1）；7/25–28 sync/锁/context
builder/TurnTransaction/两适配器；7/29–31 影子判分+守卫+judgment/divergence；
8/1–3 最小聊天 UI+教师分歧表+离线 replay；8/4–5 全量测试打包；8/6 真断网彩排；
8/7 只修阻断。砍序：token streaming→多 provider 实机认证→教师端复杂可视化→
自由生成结构化题（结构化只走题库契约，自由生成保 text）→双份 AI 总结→自动跨设备
同步。不可砍：响应契约、原子/幂等执行器、泄漏守卫、judgment/divergence 引用链。
