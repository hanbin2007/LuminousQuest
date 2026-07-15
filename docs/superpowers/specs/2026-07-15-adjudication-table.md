# M1a 教学裁量决策表

日期：2026-07-15  
基线：`rubrics.v1`  
裁量版本：`adjudication-table.v1.1`
教师细调截止：2026-07-17 23:59:59（UTC+08:00）。到期未反馈时继续使用本表默认，不阻塞 golden set 与 M1a。

状态口径：量表 v1 已获认可，因此原清单带 ▲ 的给定默认及带 ✓ 的模型图裁定记为“教师已核”；其余由开发侧给出教学上保守的默认，记为“待教师细调”。配置中的 `rubrics.adjudications` 与 §1-§20 的 23 行一一对应；§21 是 M1c.1 终审授权的 eval 标注裁量，不倒推生产引擎输出。

| § | 采用的默认值 | 对应配置字段 | 状态 |
|---|---|---|---|
| 1 | 三值 `hit / partial / miss`；`partial` 表示方向正确但不完整，或守恒正确但介质不匹配 | `rubrics.policy.outcomeScale.mode`、`partialDefinition` | 教师已核 |
| 2 | 极性认定错误而后续逻辑自洽时，按逻辑链给分，并标注 `following` | `rubrics.policy.followingError.*` | 教师已核 |
| 3 | 口语化但语义正确可判 `hit`；模型图术语用于反馈，不作为满分硬门槛 | `rubrics.policy.terminology.*` | 待教师细调 |
| 4 | 超纲但正确判 `hit`，不设额外加分 | `rubrics.policy.beyondSyllabus.*` | 教师已核 |
| 5 | 同一作答内自相矛盾判 `miss`，不取其中较优片段 | `rubrics.policy.contradiction.outcome` | 待教师细调 |
| 6 | 空答或敷衍记 `unanswered`，提示重答，不进入诊断分母 | `rubrics.policy.nonResponse.*` | 教师已核 |
| 7 | 不影响语义的错别字、大小写笔误提醒但不扣分；产生歧义时转 `needs-review` | `rubrics.policy.typos.*` | 待教师细调 |
| 8 | 电极式守恒但介质不匹配判 `partial`，定向回指 P3 | `rubrics.policy.equation.mediumMismatchOutcome`、`feedbackNodeId` | 待教师细调 |
| 9 | 接受 `=`；不要求 `⇌`，不要求物态标注 | `rubrics.policy.equation.acceptEqualsSign`、`requireEquilibriumArrow`、`requireStates` | 教师已核 |
| 10 | 三维度雷达等权；维度内沿用核心/次要节点权重 2/1 | `rubrics.policy.weighting.*` | 待教师细调 |
| 11 | 维度比率 `< 0.60` 判薄弱；`partial` 在 3D 中半亮 | `rubrics.policy.weakness.*` | 待教师细调 |
| 12 | 同节点多次作答取最新一次完成判分 | `rubrics.policy.repeatedAnswers.strategy` | 教师已核 |
| 13 | 连续 2 次无帮助 `hit` 升一级；1 次 `miss` 降一级 | `scaffoldPolicy.promotion.*`、`demotion.*` | 待教师细调 |
| 14 | 案例加权得分率至少 0.75，且核心节点无 `miss`，方可进入下一案例 | `scaffoldPolicy.passing.*` | 待教师细调 |
| 15 | 提示后答对记 `hit-with-help`；保留得分与掌握证据，但不计入升级连击 | `scaffoldPolicy.assistance.*` | 待教师细调 |
| 16 | 苏格拉底三轮内改对与 §15 同口径，记 `hit-with-help` | `scaffoldPolicy.socratic.*` | 待教师细调 |
| 17 | “自发氧化还原反应”归原理维度 P1 | `rubrics.policy.dimensionAssignments.spontaneousRedox` | 待教师细调 |
| 18 | 盐桥是离子导体的一种实现，归装置维度 D3 | `rubrics.policy.dimensionAssignments.saltBridge` | 教师已核 |
| 18b | D5 量表归装置维度，在 3D 中以 D5→P2 跨轴边表达 | `rubrics.policy.dimensionAssignments.siteReactantDistinction`、`knowledgeModel.edges[D5-P2]` | 教师已核 |
| 18c | P5 现象层暂按次要节点，权重 1 | `rubrics.policy.weighting.nodeOverrides.P5`、`knowledgeModel.nodes[P5].weight` | 待教师细调 |
| 19 | 通用模型以四功能要素及闭合拓扑为准；单液模型可合格，盐桥不是独立必备件 | `pretest.builder.assessment.generalModel.*` | 待教师细调 |
| 19b | 组件以功能化、未命名形式呈现；绑定 Zn/Cu 等具体材料时整体最高 `partial` | `pretest.builder.assessment.abstraction.*` | 待教师细调 |
| 20 | 学生雷达同时显示分数和等级；班级侧显示均值/分布、节点错误率、高频误区，学生仅用匿名编号 | `rubrics.policy.presentation.*` | 待教师细调 |
| 21 | 高歧义句式（双重否定、反问等）统一判 `needs-review`，不由模型或确定性引擎猜测唯一语义 | `eval-case.v2.expectedScore`、`rationale` | M1c.1 终审授权 |

## 实现注记

- `rubrics.json` 保存裁量索引、判分政策、跟随性锚点及 15 个节点量表；`scaffold-policy.json` 与 `pretest.json` 保存流程和前测边界的实际参数。
- 权威量表正文声称有 15 个节点，但表内实际仅列出 14 个。为满足 M1a 的 15 节点契约，默认补入次要节点 P7“总反应整合”，由 P6 的“两极电子转移数相等”拆出；该疑点按 48 小时 SLA 待人工裁决，详见教材核验报告。
- 配置校验与 `tests/m1a-config.test.ts` 对 23 个裁量编号逐条断言默认值、字段路径、状态及截止时间。

## M1a 疑点终审裁决(Fable 5,2026-07-15,待陆老师追认)

1. 节点计数:v1 标题 15 实为 14,系重构计数错误;**采纳 P7 总反应整合**(权重 1,依赖 P6),量表 v1.1 为真 15 节点。
2. D4 表述收窄:"材料一般不参与电极反应——惰性电极(Pt/碳)或不参与反应的普通导体(如 Cu)"。
3. 铝-空气碱性负极产物:AlO₂⁻ 与 [Al(OH)₄]⁻ **均入等价集**,界面展示与参考答案用 AlO₂⁻(高考主流写法)。
4. 选择性透过膜(质子交换膜等)案例:P4 离子迁移以 **case 级口径覆盖**(仅可透过离子迁移,方向不变),量表通用表述不改。
5. E3 表述对齐教材:"直接燃烧发电"改"火力发电"。
