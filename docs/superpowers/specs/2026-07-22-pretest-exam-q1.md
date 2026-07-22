# 前测「高考真题诊断」段：K—O₂ 电池（选题 Q1）实现规格

日期：2026-07-22
背景：陆老师选题 Q1 加入前测（`docs/superpowers/sources/2026-07-22-teacher-selected-questions/`：questions.md 题面、answer-key.md 权威答案、final-annotations.md 节点映射）。已有 20 名学生的纸面真实作答（本机 `eval/human-raw/`，不入库），加入前测后可用纸面数据校准工具判分链路。
决策（Fable 5，用户授权）：仅加 Q1，拆 4 小题；1-1/1-2/1-3 为 choice（确定性判分），1-4 为 text（AI 抽取）。Q2–4 不进前测。

## 1. Schema 扩展（最小改动）

- `pretest.json` 的 question 增加可选字段 `group`：`{ id, title, stimulus, figure }`——同组题目共享题干与装置图，UI 上渲染为一个「真题」区块（题干 + 图 + 依次小题）。zod schema（`shared/config/schemas.ts`）同步；loader 校验 figure 路径存在。
- 兼容性：现有 3 题不带 `group`，行为不变（AC2 口径：老师改 JSON 加题仍然成立）。

## 2. 素材

- 装置图：`docs/superpowers/sources/2026-07-22-teacher-selected-questions/figures/q1-k-o2.png` 复制为 `assets/exam/q1-k-o2.png`。
- `assets/exam/` 为教师原题图目录，**不纳入** STYLE.md 风格 manifest 与机检范围（在 manifest 说明中注明豁免及理由：教师提供的真题原图）。

## 3. 题目内容（新增 4 题，group id = `exam-q1-k-o2`）

组题干（stimulus）：「【高考真题】K—O₂ 电池结构如图，a 和 b 为两个电极，其中之一为单质钾片。」figure = `assets/exam/q1-k-o2.png`。

### q1-1 `pretest-exam1-polarity`（choice，dimensionId: device）
- prompt：该电池中，电极 a、b 分别为什么极？
- targetNodeIds: ["D1","D4"]；rubricIds: ["rubric-d1","rubric-d4"]
- options：
  - A（correct）：a 为负极，b 为正极——钾片失电子被氧化，O₂ 得电子被还原。
  - B：a 为正极，b 为负极。→ ["D1-M1","D4-M2"]
  - C：a、b 都可以是负极，取决于外电路接法。→ ["D1-M1"]
  - D：无法判断，因为不知道电极材料是否参与反应。→ ["D5-M2"]

### q1-2 `pretest-exam1-electron-flow`（choice，dimensionId: principle）
- prompt：放电时，外电路中电子的流向是？
- targetNodeIds: ["P4","D4"]；rubricIds: ["rubric-p4","rubric-d4"]
- options：
  - A（correct）：从 a 极经外电路流向 b 极。
  - B：从 b 极经外电路流向 a 极。→ ["P4-M1"]
  - C：从 a 极经隔膜（电解质）流向 b 极。→ ["P4-M2","D3-M1"]
  - D：外电路和隔膜中都有电子流动。→ ["P4-M2"]

### q1-3 `pretest-exam1-stoichiometry`（choice，dimensionId: principle）
- prompt：该电池放电时（生成 KO₂），消耗 K 与消耗 O₂ 的物质的量之比为？
- targetNodeIds: ["P6"]；rubricIds: ["rubric-p6"]
- options：
  - A（correct）：1:1——K − e⁻ = K⁺ 与 O₂ + e⁻ = O₂⁻ 各转移 1 个电子。
  - B：2:1。→ ["P6-M2"]
  - C：4:1。→ ["P6-M2"]
  - D：1:2。→ ["P6-M1"]

### q1-4 `pretest-exam1-membrane`（text，dimensionId: device）
- prompt：该装置中的隔膜能否通过 O₂？请说明理由。
- targetNodeIds: ["D3","P1"]；rubricIds: ["rubric-d3","rubric-p1"]
- evidencePath：简答原文 -> 隔膜选择性、半反应分隔理由
- answerGuidance（参考 answer-key.md，含真实作答中出现的另类正确理由）：
  - 「不能。防止 K 与 O₂ 直接反应（两个半反应必须分隔在两个场所）。」
  - 另类正确：「不能。若 O₂ 通过隔膜到 a 极，会直接与 K 反应（或在 a 极得电子生成 O²⁻/K₂O 而非 KO₂），电池无法正常工作。」——判 hit。
  - 只答「不能」无理由 → partial；答「能」→ miss。

## 4. Demo 冻结物同步（关键）

- `recordings/demo/session.json` 预置会话补上这 4 题的已答状态（全对口径，1-4 的作答文本用参考答案原文），使演示流程与 5 分钟脚本不出现未答题。
- `recordings/demo/class/`（由 `scripts/generate-demo-class-sessions.mjs` 从 teacher fixtures 再生）与 `tests/fixtures/teacher/session-{a,b,c}.json` 同步：三份 fixture 中至少一份对 q1-4 给 partial/miss（班级视图有区分度）。
- `pretest.v1.1` → `pretest.v1.2`；configDigest 全链路重算同步（模式同提交 90375cf）。
- 演示脚本 step 校验、runbook 标签测试如引用题目数量/列表，相应更新。

## 5. 验收

- 全量测试 + typecheck 通过；新增：group 渲染测试、4 题判分测试（choice 误区映射、q1-4 抽取路径 mock）、坏配置（figure 缺失）报错测试。
- `pnpm run font:subset` 重生成（新题文案字符）。
- 约束：**不得改动** `src/runtime/api.ts`、`tests/m2-runtime.test.ts`（并行会话 WIP）。
- UI：真题区块视觉沿用现有前测题卡风格，组题干上方加「高考真题」徽标（样式与现有 token 一致即可，最终视觉由 Fable 5 终审微调）。
