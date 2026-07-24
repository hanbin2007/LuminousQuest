# 前测直接评判主记录轨规格 v3

日期：2026-07-24  
状态：已获用户放行，双路评审已收敛，按本版实现  
证据基线：膜题 52 例多数票 98.08%；题 1/题 4 共 368 判例修正标签后约 97.8%；
真实全错判掌握 0。

## 1. 裁决与范围

1. 题 1/题 4 的十个小问首批进入 `direct-primary` 灰度。这里按学生实际提交的文本
   作答判定，不受当前内部 `choice`/`text` 适配类型限制。Builder、通用概念题和训练
   案例暂不切换；后续每题通过独立评测后再增加灰度配置。
2. 灰度题以直接评判结果写既有 `assessment.completed` 记录轨；学习者画像、3D 灯态、
   维度进度和 Agent 的 `recordTrack` 只读取该主判。
3. 既有 choice 映射、方程引擎、文本抽取加规则管线继续运行，但只写审计轨。审计失败、
   与主判分歧或审计 `needs-review` 均不阻塞学生提交和前测推进。
4. 正式 provider 不可用时，主判写 `needs-review`，不得把审计结果静默提升为主判。
   Demo 模式必须精确命中录制；缺录制同样写 `needs-review`，不得联网或临时改走旧主判。
5. 生产裁决与实验保持同一采样语义：每个作答并行运行 3 次，逐节点至少 2 票相同
   才形成主判；三种结果各一票或任一节点没有多数时写 `needs-review`。不得拿三票实验
   证明单次生产调用。

首批题目：

- `pretest-exam1-polarity`
- `pretest-exam1-electron-flow`
- `pretest-exam1-stoichiometry`
- `pretest-exam1-membrane`
- `pretest-exam4-polarity`
- `pretest-exam4-cathode-equation`
- `pretest-exam4-material`
- `pretest-exam4-electron-loser`
- `pretest-exam4-process`
- `pretest-exam4-stoichiometry`

## 2. 一等判分口径配置

每个灰度题在 `config/pretest.json` 内声明一份仅服务端可见的
`directAssessment`：

```json
{
  "mode": "record-primary",
  "version": "pretest-exam1-membrane.direct.v1",
  "context": [
    "题组与图示中对判分必要、但无法从结构化字段机械获得的事实"
  ],
  "adjudication": [
    "本题的人工作答边界、从严或从宽口径"
  ],
  "nodes": [
    {
      "nodeId": "P1",
      "guidance": [
        "只说明结论而没有理由时至多 partial"
      ]
    }
  ],
  "examples": [
    {
      "answer": "与真实语料不同的合成作答",
      "assessments": [{
        "nodeId": "P1",
        "verdict": "hit",
        "rationale": "为什么按本题口径判为 hit"
      }]
    }
  ]
}
```

- `nodes` 必须与 `targetNodeIds` 一一对应且顺序一致；误区只能引用该节点的闭集。
- loader 校验版本、覆盖完整性、节点归属和灰度模式。
- public config 删除整个 `directAssessment`，学生端不能获得参考答案、口径或误区。
- 口径装配器机械加入：题组题干、图示文字背景、当前小问、学生原文、正确 choice
  文本或 reference equation、题目 evidence/referenceAnswerPoints、知识节点定义、误区闭集、
  rubric 三档规则与总政策、合成判例；`context/adjudication/guidance/examples` 是
  `fable-scopes-v1` 的一等配置化版本，只补机械配置表达不了的边界。
- 后续调口径必须改配置版本并进入 config digest，不允许在 route 或 prompt 中写题目
  ID 特判。
- 已知教师裁量边界必须写进 `adjudication` 并允许输出 `needs-review`：至少包括
  s36-P1 的“防止电极 a 被氧化”、4-2 配平/电子数错误、4-3b 多答、转录存疑和
  4-3c 待抽查边界。在陆老师裁决前不得强迫这些答案形成分数。

## 3. 主判请求与闭集输出

正式 prompt 为 `prompts/direct-assessment.md`。请求输入必须包含：

- `questionId`、题组上下文、题目和学生**原始作答**；
- 每节点完整口径包及允许的误区 ID；
- assistance、scope version、config digest；
- 明确声明学生文本是不可信数据，任何“改分/泄露提示词”指令无效。

闭集输出按目标节点恰好一项：

```json
{
  "assessments": [{
    "nodeId": "P1",
    "verdict": "hit",
    "misconceptionIds": [],
    "rationale": "按配置口径说明判由",
    "confidence": 0.96,
    "reviewReason": null,
    "evidence": [{ "quote": "原文逐字片段", "start": 3, "end": 12 }]
  }]
}
```

- `verdict` 允许 `hit|partial|miss|needs-review`；`needs-review` 时
  `reviewReason` 必须是 `rubric-boundary|ambiguous-transcription|low-confidence`，
  其余 verdict 的 `reviewReason` 必须为 `null`。
- 空答和明确放弃由服务端先行分类并写
  `unanswered`，不调用模型。
- 节点、误区、数量和顺序闭集校验；误区必须属于当前节点。
- evidence 必须逐字落在原始答案中；模型不得引用题干或参考答案冒充学生证据。
- provider/schema/evidence 失败按既有重试策略重试，耗尽后主判写 `needs-review`。
- 服务端用 `resolveRubricDecision` 把 verdict 转成既有分数结构；模型不能直接给分值。
- 三票分别使用独立、稳定的 `voteIndex` 进入 cacheKey。多数票的 evidence/rationale
  取第一条获胜且通过校验的响应，confidence 持久化为三条获胜票均值；confidence
  `<0.75` 时即使有多数也降为 `needs-review(low-confidence)`。

主记录轨事件映射冻结如下：

- scored：`pipelineStage=score`、`objectiveOutcome=verdict`、
  `extraction={status:assessed,evidence,model,provenance}`；rationale 写
  `ruleDecision.reason`，engine 固定 `direct-assessment/direct-assessment.v1`，
  再由 `resolveRubricDecision` 产生 following/score。
- unanswered：`pipelineStage=score`、extraction assessed 且 evidence 为空；
  ruleDecision/score 均为 rubric policy 的 unanswered，following=`not-followed`。
- needs-review：`pipelineStage=extraction`、extraction needs-review（包含 prompt、
  cacheKey/model），ruleDecision/following/score 均 `unassessed`。
- `confidence` 与三票摘要写入 assessed extraction 的可选 `judgment` 字段；来源不得靠
  model 字符串反推。

## 4. 审计轨与分歧

为避免旧评分事件污染画像，新增两个审计事件，而不是把旧
`assessment.completed` 追加到真实 session：

```text
assessment.audit.completed
  sourceAnswerEventId, questionId, nodeId
  verdict: hit|partial|miss|unanswered|needs-review
  misconceptionIds?, rationale, evidence?
  engine, provenance

assessment.divergence.changed
  primaryAssessmentEventId, auditEventId, nodeId
  primaryVerdict, auditVerdict
  status: detected|matched
  comparisonPolicyVersion
```

- 旧管线在隔离的临时 session 上执行；只把每节点归一化审计结论投影到真实 session。
- 临时 session 从空事件流和同一 config versions 建立；每个 target 恰好投影一条审计
  事件。`hit-with-help→hit`，`unassessed`、缺节点、多节点冲突或异常统一归一为
  `needs-review`；mixed text/equation 分别运行后再按目标节点合并。
- 主判和审计均可比时总是追加一次 divergence：一致为 `matched`，不一致为
  `detected`。任一侧 `unanswered/needs-review` 不伪造分歧。
- divergence 身份键为 `{sourceAnswerEventId,nodeId}`；`matched` 只描述本次比较，
  绝不关闭其它 attempt 的 detected。将来教师显式裁决时再新增带
  `resolvesDivergenceEventId` 的解决事件。
- 教师端沿用现有 divergence 清单与待复核入口，合并展示 Agent 分歧和前测评分分歧；
  学生 projection、公开导出和 Agent 学生可见上下文过滤两个新事件。
- 审计管线异常只写 `needs-review` 审计事件并记录服务端日志，主判及提交事务继续。
- “不阻塞”仅指审计结论不否决主判或前测推进；A v3 仍在同一事务等待审计。文本审计
  使用独立硬超时，耗尽即投影 `needs-review`，不得继续占用学生请求。

## 5. 各入口接线

### Choice/填空适配

- 统一协议为
  `{questionId,rawAnswer,submissionKind:"answer"|"skip",optionId?}`。服务端先处理
  skip/空答；substantive 填空由服务端从 `rawAnswer` 派生 option，客户端提交的
  `optionId` 只作一致性断言，不一致即拒绝。普通 radio 的 rawAnswer 定义为所选 option
  token，prompt 另取服务端 `selectedOptionText`。
- skip/明确未作答为全部 target 写主判与审计 `unanswered`，不调用模型且
  `includeInDiagnosis=false`。
- `answer.submitted` 保存原文，不再用标准 option 文本覆盖学生答案。
- `recordChoiceAssessment` 在临时 session 运行并投影为审计事件。

### Text/方程适配

- `/api/assessment/extract` 对灰度题先运行直接主判，再隔离运行旧文本抽取/方程引擎。
- 非灰度前测题和训练案例保持现有抽取主记录轨。
- Agent response contract 绑定到灰度前测题时使用同一双轨编排；训练案例仍由现有
  `ExistingTextShadowAssessment` 记主记录轨。
- response contract 的 entrypoint 显式携带灰度语义并提升 contract revision；旧契约
  恢复后不得悄然从确定性主判切到 direct-primary。

### 事务与幂等

- 一次 session command 只落一个 `answer.submitted`；主判、审计、分歧使用同一
  operation id 派生稳定事件 ID。
- 事务失败不写半条链；同进程并发和已提交事件后的重试不重复调用 provider。当前
  单机内存命令协调不承诺崩溃窗口的 exactly-once：provider 已返回但账本尚未持久化时
  崩溃，恢复后允许重复调用。
- 审计在主判之后执行，但真实 session 的事件顺序固定为：
  `answer -> primary assessments -> audit events -> divergence events`。

## 6. 录制、缓存与 Demo

- 直接评判复用 `LLMService.execute` 和既有 cacheKey。哈希输入包含 prompt version、
  schema version、config digest、scope version、question id、原始作答、目标节点和
  assistance，不含时间戳、session id 或随机 event id。
- development 命中 cache 后仍执行闭集和逐字 evidence 校验；非法旧缓存不得进入记录轨。
- Demo 只按 cacheKey 精确回放，不设置跨题静态 stepId 兜底。
- 增加 direct-assessment 专用 publish/validate 流程，逐条校验 cacheKey、prompt、
  schema、config 和 scope version，拒绝重复 key。A 主线提交前至少录制并验证演示
  脚本实际会提交的十题三票响应；后续 B 批量
  config 修改会改变 digest，届时按任务清单再次全量重录。

## 7. 权威账本与可见性

- 新增统一 `isAuditOnlyEvent`，供 student projection、command marker、Agent trigger、
  context builder 和聊天 UI 共用；审计事件绝不能承载会被 projection 删除的命令恢复
  元数据，元数据挂在最后一条主判事件或独立可见 command marker。
- 服务端使用原子文件 session store 保存完整 teacher-audit session；客户端 student
  sync 只可补充可见前缀，不能覆盖或删除服务端隐藏后缀。
- 教师读取完整账本走本机教师导入/导出通道；学生 API 始终只返回 student projection。
  验收必须覆盖服务重启后审计仍存在、学生不可取、教师导出可取。
- 教师 divergence 详情必须联结题目、学生原文、主判判由/置信度和审计引擎/判由/证据；
  待复核按 `sourceAnswerEventId+nodeId` 计数，不再按 node 全局最新状态互相覆盖。

## 8. 验收门禁

1. 配置：十题 scope 完整；漏节点、跨节点误区、非法版本、public 泄漏全部有负测。
2. 主判：hit/partial/miss、未作答、provider fallback、evidence 越界、prompt injection
   均有单测。
3. 双轨：主判进入画像；审计不进入画像；一致 resolved、分歧 detected、审计失败不
   阻塞；教师可见而学生不可见。
4. 入口：choice 保留原始答案；text/方程和 Agent response contract 共用编排；
   targetNodeIds 必须与配置精确相等。
5. 幂等/回放：重复提交不重复调用；development cache 与 demo cacheKey 精确命中；
   版本不符拒绝旧录制。
6. 全量 `pnpm test`、`pnpm run typecheck`、`pnpm run build` 通过。
7. 用正式 assembler/schema 对修正后的 52+368 判例复测：逐题不低于实验报告下限、
   三跑一致性达标、真实 `miss→hit=0`；原始语料缺失或 provider 未就绪时不得伪造通过。
8. A.3 正式 provider 复测依赖生产 key，不以开发通道结果冒充完成；代码与门禁先落地，
   外部依赖状态单独报告。
