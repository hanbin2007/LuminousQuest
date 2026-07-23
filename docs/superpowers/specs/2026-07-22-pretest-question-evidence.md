# 前测文本题「题目级证据槽位」规格（q1-4 判分适配）

日期：2026-07-22
问题：`pretest-exam1-membrane`（q1-4）当前经 `referenceEquations[0].caseId` 借用锌铜案例的 D3/P1 槽位判分，但锌铜的 D3 槽是盐桥语义（`ion-path=salt-bridge`）——本题正确作答（隔膜/K⁺/防止直接反应）无法命中，会被系统性压分。真实学生数据（15 份 q1-4 作答）已确认该冲突。
方案（Fable 5 定稿）：文本题目支持**可选的题目级 factRequirements**，优先于参考案例槽位。

## 1. Schema 与链路

- `textQuestionSchema` 增加可选字段 `evidence`：数组，元素 `{ nodeId, description, referenceAnswerPoints, factRequirements }`（与案例 `evidencePaths` 条目同构，`source` 恒为 `answer` 可省略）。zod + loader 校验：nodeId ∈ 该题 targetNodeIds、factRequirements 的 acceptedValues 在 `scaffold-policy.factValueAliases` 中有定义（与现有案例校验同口径）。
- `createClosedExtractionSchema` 与 `/api/assessment/extract`：当 question 配置了 `evidence` 时，对这些 nodeId 用题目级槽位构建闭集与规则判分；未配置的保持现状（借参考案例）。原有 3 题不配置 `evidence`，行为不变（AC2 兼容）。

## 2. q1-4 的槽位内容（写入 config/pretest.json）

```json
"evidence": [
  {
    "nodeId": "D3",
    "description": "判断隔膜不允许 O₂ 通过（离子导体的选择性）。",
    "referenceAnswerPoints": ["不能（隔膜不允许 O₂ 通过）。"],
    "factRequirements": [
      { "id": "o2-passes", "acceptedValues": ["false"] }
    ]
  },
  {
    "nodeId": "P1",
    "description": "说明理由：防止 K 与 O₂ 直接反应，两个半反应必须分隔。",
    "referenceAnswerPoints": ["防止 K 与 O₂ 直接反应（半反应分隔）。"],
    "factRequirements": [
      { "id": "separation-purpose", "acceptedValues": ["prevent-direct-reaction"] }
    ]
  }
]
```

- `scaffold-policy.json` 的 `factValueAliases` 增补：
  - `"false"` 增加别名：`"否"`、`"不能"`；
  - 新值 `"prevent-direct-reaction"`：`["直接反应", "直接接触", "不接触", "发生反应", "防止"]`（该值仅用于本槽，别名不影响其它槽）。
- 口径依据：陆老师解析版（answer-key.md）q1-4 关键词 = 「不能、防止 K 与 O₂ 直接反应」——两槽恰好一一对应；「隔膜只允许 K⁺ 通过」类表述作为 o2-passes 的证据引用即可，不设必需槽（解析版已删去该关键词）。

## 3. 测试

- 单测（判分链路，mock 抽取按契约产出槽位）：
  - 「不能，防止 O₂ 与 K 直接反应」→ D3 hit + P1 hit；
  - 「不能，只允许 K⁺ 通过」→ D3 hit + P1（无 separation 槽）非 hit；
  - 「能通过」→ D3 miss；
  - 空答 → unanswered 现有路径。
- 坏配置测试：evidence.nodeId 不在 targetNodeIds、acceptedValues 无别名定义 → 启动报错。
- 原 3 题回归不变；demo/digest/版本串按既有模式同步（configDigest 重算，pretest 版本号 v1.2 内容变更即可，不再升号；重新生成 demo class sessions；`pnpm run font:subset`）。
- 全量 `pnpm test` + `pnpm run typecheck` 通过。

## 4. 约束

- 不得改动：`src/runtime/api.ts`、`tests/m2-runtime.test.ts`、`src/App.tsx`、`src/app/AppContext.tsx`、`src/app/ElectronFlowProgress.tsx`、`src/features/model/**`、`src/features/training/LiveModelPanel.tsx`、`src/features/training/TrainingPage.tsx`（并行会话 WIP）。
- 不 git commit。
