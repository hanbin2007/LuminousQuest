# 前测「高考真题诊断」第二组：血糖微型电池（选题 Q4）实现规格

日期：2026-07-23
背景：陆老师定前测采用选题 Q1 + Q4（Q1 被认为过于简单，Q4 补难度与 D5 深度）。沿用 eced63c 的 question group 机制与 53618a4/393f247 的题目级证据机制，**本任务应为纯配置 + 测试/冻结物同步，不需要新引擎代码**。
内容（Fable 5 定稿，干扰项与提示语均来自 31 名学生真实错答分布）：

## 1. 素材

`docs/superpowers/sources/2026-07-22-teacher-selected-questions/figures/q4-glucose-implant.png` 复制为 `assets/exam/q4-glucose-implant.png`（manifest 豁免段已有 assets/exam/ 条目，无需新增豁免）。

## 2. 新增 6 题（group id = `exam-q4-glucose`，追加在 Q1 组之后）

组题干：「【高考真题】一种可植入体内的微型电池工作原理如图所示，通过 CuO 催化消耗血糖发电，从而控制血糖浓度。当传感器检测到血糖浓度高于标准，电池启动；血糖浓度下降至标准，电池停止工作。（血糖浓度以葡萄糖浓度计）」figure = `assets/exam/q4-glucose-implant.png`。

### q4-1 `pretest-exam4-polarity`（choice，device）
- prompt：该电池中，电极 a、b 分别为什么极？
- targetNodeIds ["D1","D4"]；rubricIds ["rubric-d1","rubric-d4"]
- A（correct）：a 为正极，b 为负极——a 侧 O₂ 得电子被还原，b 侧葡萄糖一侧发生氧化。
- B：a 为负极，b 为正极。→ ["D1-M1","D4-M2"]
- C：无法判断，因为不知道电极材料是否参与反应。→ ["D5-M2"]
- D：两极都可能是正极，取决于血糖浓度高低。→ ["D1-M1"]

### q4-2 `pretest-exam4-cathode-equation`（text，principle）
- prompt：写出该电池正极的电极反应式。
- targetNodeIds ["P6"]；rubricIds ["rubric-p6"]
- referenceEquations：[{ caseId: "aluminum-air", equationSetId: "oxygen-positive", equation: "O₂ + 2H₂O + 4e⁻ = 4OH⁻" }]（复用铝-空气碱性氧还原方程组做判分）
- answerGuidance：["O₂ + 2H₂O + 4e⁻ = 4OH⁻（血液近中性，按碱性式书写，产物为 OH⁻）。"]
- 该题为纯方程作答：无 answer 抽取目标，全部 target 走 equation 路径（与现有 loader/app 的 sourceByNode 分流一致；若 loader 对「无 answer 路径的 text 题」有阻塞校验，按本规格放行该形态并补测试）。

### q4-3a `pretest-exam4-material`（choice，device）
- prompt：b 电极的电极材料是什么？
- targetNodeIds ["D5","D1"]；rubricIds ["rubric-d5","rubric-d1"]
- A（correct）：纳米 CuO/导电聚合物。
- B：Cu₂O。→ ["D5-M1"]（真实错答：把转化中间体当材料）
- C：葡萄糖。→ ["D5-M1"]
- D：石墨。→ ["D5-M2"]（真实错答）

### q4-3b `pretest-exam4-electron-loser`（choice，device）
- prompt：在 b 电极上，实际失电子的物质是什么？
- targetNodeIds ["D5"]；rubricIds ["rubric-d5"]
- A（correct）：Cu₂O。
- B：葡萄糖（C₆H₁₂O₆）。→ ["D5-M2"]（第一批真实高频错答）
- C：CuO。→ ["D5-M1"]
- D：葡萄糖酸（C₆H₁₂O₇）。→ ["D5-M2"]（真实错答）

### q4-3c `pretest-exam4-process`（text，device）
- prompt：请简单描述 CuO 在 b 电极上参与反应的完整过程，并说明 CuO 在该过程中所起的作用。
- targetNodeIds ["D5","P2"]；rubricIds ["rubric-d5","rubric-p2"]
- evidence（题目级）：
```json
[
  { "nodeId": "D5",
    "description": "CuO 的角色定性与再生循环。",
    "referenceAnswerPoints": ["CuO 氧化葡萄糖后被还原为 Cu₂O，Cu₂O 在电极失电子再生成 CuO，CuO 起催化作用。"],
    "factRequirements": [
      { "id": "cuo-role", "acceptedValues": ["catalyst"], "valueDomain": ["catalyst", "intermediate", "oxidant"],
        "hint": "学生对 CuO 作用的定性：说催化剂/催化作用取 catalyst；说中间产物取 intermediate；只说氧化剂取 oxidant；未定性不建槽。" },
      { "id": "cuo-regenerated", "acceptedValues": ["cuo-regenerated"], "valueDomain": ["cuo-regenerated"],
        "hint": "是否描述了 Cu₂O 失电子重新生成 CuO 的再生/循环过程；描述了才建槽并引用该句。" }
    ] },
  { "nodeId": "P2",
    "description": "氧化关系：CuO 将葡萄糖氧化（葡萄糖为还原剂被氧化）。",
    "referenceAnswerPoints": ["CuO 将葡萄糖氧化为葡萄糖酸。"],
    "factRequirements": [
      { "id": "glucose-oxidized", "acceptedValues": ["glucose-oxidized"], "valueDomain": ["glucose-oxidized"],
        "hint": "是否表达了 CuO 将葡萄糖氧化（葡萄糖被氧化为葡萄糖酸）；表达了才建槽并引用该句。" }
    ] }
]
```
- answerGuidance：["CuO 将葡萄糖氧化为葡萄糖酸，自身被还原为 Cu₂O；Cu₂O 在 b 电极失电子又生成 CuO；CuO 起催化作用。",
  "只定性催化未描述再生循环 → D5 partial；把 CuO 说成中间产物/仅氧化剂 → 照实转录后按规则层判。"]
- referenceEquations：[{ caseId: "zinc-copper", equationSetId: "zinc-negative", equation: "Zn - 2e⁻ = Zn²⁺" }]（仅满足 schema 的占位引用，与 q1-4 相同模式；抽取槽位由题目级 evidence 提供）

### q4-4 `pretest-exam4-stoichiometry`（choice，principle）
- prompt：消耗 18 mg 葡萄糖（C₆H₁₂O₆，M=180 g/mol）时，理论上 a 电极有多少 mmol 电子流入？
- targetNodeIds ["P6"]；rubricIds ["rubric-p6"]
- A（correct）：0.2——18mg/180=1×10⁻⁴ mol，每 mol 葡萄糖转移 2 mol 电子。
- B：0.1。→ ["P6-M2"]（漏乘转移电子数，真实错答）
- C：0.02。→ ["P6-M1"]（数量级滑步，真实错答 S12 型）
- D：2。→ ["P6-M1"]

## 3. `scaffold-policy.json` factValueAliases 增补

```
"catalyst": ["催化剂", "催化作用", "催化"],
"intermediate": ["中间产物"],
"oxidant": ["氧化剂"],
"cuo-regenerated": ["再生", "又生成", "变回", "重新生成", "回到"],
"glucose-oxidized": ["氧化葡萄糖", "葡萄糖氧化", "将葡萄糖氧化", "葡萄糖被氧化"]
```

## 4. 同步与测试（模式同 eced63c）

- pretest 版本 v1.2 → v1.3；configDigest 全链路重算同步；demo 预置沿用「已答未判分」口径为 6 新题补 answer.submitted；`node scripts/generate-demo-class-sessions.mjs`；`pnpm run font:subset`。
- 测试更新：m1a 题目数/维度序列断言（7→13）、exam 组精确转录断言扩到两组、q4-3c 判分单测（催化+再生+氧化 → D5 hit + P2 hit；仅催化 → D5 partial；说中间产物 → 照录 intermediate 后 D5 非 hit）、q4-2 纯方程题加载与判分测试、m2-pretest-flow 与 m3-real-e2e 的作答步骤扩展（按题干文本 gate，参考 m3 现有 examChoicePrompts 模式）、config-loader 坏配置测试沿用。
- 全量 `pnpm test` + `pnpm run typecheck` 通过。

## 5. 约束

- 不得改动并行 WIP：`src/runtime/api.ts`、`tests/m2-runtime.test.ts`、`src/App.tsx`、`src/app/AppContext.tsx`、`src/app/ElectronFlowProgress.tsx`、`src/features/model/**`、`src/features/training/LiveModelPanel.tsx`、`src/features/training/TrainingPage.tsx`。
- **不得触碰 `eval/**`**（live 校准正在后台运行）；不要运行任何 eval 命令。
- 不 git commit。
