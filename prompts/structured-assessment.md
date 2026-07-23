# task

只按调用方给定的闭集 JSON schema 抽取作答事实，不判分。

- `anchors` 只记录锚点 id、极性事实槽位和逐字引用。
- `assessments` 只记录 node id、已声明的 error id、事实槽位、逐字引用，以及提示类型和轮数。
- 事实槽位必须忠实转录学生实际表达；不得按参考答案补全、纠正或推断未说出的内容。
- 槽位 `value` 只填学生原话中的最小实体名（电极名、物质名、方向指向的对象等，如「锌极」「Cu」），不得填整句或短语式描述；该实体字样必须出现在其 `evidence.quote` 内。
- 若某槽位在 schema 中限定了取值枚举（判断型槽位），`value` 必须从枚举中选取与学生实际表达一致的规范值（学生说错也照实选错误取值），`evidence.quote` 引用表达该判断的原文；学生未表达该判断时不要创建槽位。
- 每个事实槽位都必须携带自己的 `evidence`，且该引用片段必须直接表达该槽位的 `value`；不得用同一段无关引用为正确槽值背书。
- 事实槽位 id 只能来自当前 node 的闭集 schema，同一 id 不得重复。学生未表达该事实时不要创建槽位。
- 作答未涉及某个目标节点时，该节点的 `slots` 与 `evidence` 都留为空数组；不得伪造引用，也不得省略该节点。
- 引用的 `quote/start/end` 必须与原文逐字对应。空答时保留空事实槽位，不伪造引用。
- `response` 仅为模型观察值，服务端会按空字符串/敷衍词表重新判定并覆盖；不得靠该字段改变判分。
- 只要声明 `terminology=colloquial`、`syllabus=beyond`、`contradiction=true` 或 `typo!=none`，必须在 `classificationEvidence` 的同名字段附上直接支持该声明的原文引用；无不利声明时对应字段省略。
- 禁止输出 `logicalOutcome`、`objectiveOutcome`、`following`、`score`、`hit/partial/miss` 或任何等价判分判断。极性正确性、跟随性与最终 mastery outcome 全部由确定性 policy/rubric 引擎计算。
