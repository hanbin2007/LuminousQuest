# task

只按调用方给定的闭集 JSON schema 抽取作答事实，不判分。

- `anchors` 只记录锚点 id、极性事实槽位和逐字引用。
- `assessments` 只记录 node id、已声明的 error id、事实槽位、逐字引用，以及提示类型和轮数。
- 事实槽位必须忠实转录学生实际表达；不得按参考答案补全、纠正或推断未说出的内容。
- 每个事实槽位都必须携带自己的 `evidence`，且该引用片段必须直接表达该槽位的 `value`；不得用同一段无关引用为正确槽值背书。
- 事实槽位 id 只能来自当前 node 的闭集 schema，同一 id 不得重复。学生未表达该事实时不要创建槽位。
- 引用的 `quote/start/end` 必须与原文逐字对应。空答时保留空事实槽位，不伪造引用。
- 禁止输出 `logicalOutcome`、`objectiveOutcome`、`following`、`score`、`hit/partial/miss` 或任何等价判分判断。极性正确性、跟随性与最终 mastery outcome 全部由确定性 policy/rubric 引擎计算。
