# M1a 里程碑评审终审决议

日期:2026-07-15
输入:opus-4.8(有条件通过,4 中 4 低)、gpt-5.6-sol max(不通过,27 条)
终审(Fable 5)结论:**不通过,开 M1a.1 大修轮。** 两评审矛盾处经亲自查证,codex 的两项关键指控坐实:

- `config/pretest.json:140` 官方参考答案 `Zn - 2e⁻ = Zn²⁺`(教材减电子写法)无法被当前 grammar 解析(`-` 仅作电荷符号)——官方答案自判 parse-error,实锤。
- `shared/workflows/assessment.ts` 的抽取 schema 要求 LLM 直接输出 `logicalOutcome/objectiveOutcome` 与跟随性判断——违反"AI 只做闭集抽取、判分由确定性规则完成"的核心架构,实锤。opus 判"切片真端到端"过宽:切片仅覆盖 LLM 文本路径且 outcome 由 mock 预塞,拓扑/方程式引擎未被调用。

opus 的化学逐条验算(三案例反应式全对)仍然有效;codex 补的两条内容级发现(同材料电极干扰项与自家氢氧燃料电池矛盾;参考答案 grammar 失配)是 opus 漏检。v1.1 裁决未转录 config 一条按计划本就排在修复轮,不计新缺陷。

## M1a.1 修复范围(合并去重,详见任务单)

A 架构级:抽取契约重做(LLM 只出 node/error id+事实槽位+引用;判分与跟随性全部回到规则层,极性锚点为独立有证据事件);统一 policy evaluator(23 条裁量真正被运行时消费+逐条契约测试);统一 mastery outcome(hit-with-help 独立化,脚手架读 §15/§16);引擎→session 适配器(连线 DTO 统一、判定带 ruleId/score);session 持久化 config digest。
B 引擎正确性:拓扑六项(角色白名单/重复组件按功能网络/闭环 witness/矛盾方向=miss/structural rules 真消费/结构化材料绑定);化学式七项(减电子写法兼容、介质 partial 需匹配目标等价族、P3/P6 判据分离、unanswered 贯通、canonical 物种身份、数字安全上限、pair 校验参数化 medium)。
C 内容:删/限定同材料干扰项;v1.1 裁决落 config;pretest 选项映射精修;铝-空气 P4 参考答案补 OH⁻ 方向;各案例补 overall 等价集且 loader 强制三组;targetNodeIds⊆evidencePaths 校验;evaluateCasePass 收 CaseConfig;profile 空答不抹除有效证据。
D 测试:纵向切片重做(真实 builder+方程式作答、不注入 outcome、新进程离线回放);测试异味清理。
