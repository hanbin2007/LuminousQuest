# 前测真题「填空题型」规格（替代选择题化；Q1 改造 + Q4 新增）

日期：2026-07-23
决策（用户 2026-07-23）：真题保持**原卷填空形态**（「本来怎么填就怎么填」），不做选择题化。本规格取代 `2026-07-23-pretest-exam-q4.md` 中全部 choice 设计（该文件仅留档）；此前基于它的半成品已回滚，工作树基线 = 13010af。
注意：用户正在独立 worktree 改造前端——**UI 改动收敛在 `src/features/pretest/QuestionCard.tsx` 单文件 + `src/styles.css` 追加段**，不动其它前端文件，降低合并冲突面。

## 1. 新题型 `blank`（确定性判分，零 AI）

schema（`shared/config/schemas.ts`，与 choice/text 并列）：

```
{
  id, type: 'blank', prompt, dimensionId, targetNodeIds, rubricIds, group?,
  blanks: [
    { id, label,                    // label 如「电极 a」用于渲染与判分溯源
      nodeIds,                      // ⊆ targetNodeIds
      accepted: string[],           // 归一化匹配任一即对
      wrongAnswers?: [ { values: string[], misconceptionIds: string[] } ] }
  ],
  wrongPatterns?: [                 // 跨空组合误区(如方向整体填反)
    { blanks: { <blankId>: string }, misconceptionIds: string[] } ]
}
```

- 匹配归一化：复用 `shared/fact-value-normalization.ts` 的现有归一化（全半角/大小写/上下标数字/空白），不重写。
- 判分（确定性引擎，风格对齐 choice/builder）：逐空判对错；**每个 node 的 outcome：其关联 blanks 全对 → hit，部分对 → partial，全错 → miss**；命中 wrongAnswers/wrongPatterns 的 misconceptionIds 记入诊断。未匹配任何已知错答的错误填写 → miss、无误区标签。判分记录带每空的填写原文（证据溯源）。
- UI（仅 QuestionCard.tsx）：prompt 中以 `{blank:<id>}` 占位符标记空位，渲染为行内文本输入（原卷样式「电极 a 为 __ 极」）；提交按钮沿用「提交作答」。无占位符时 blanks 依序渲染在 prompt 下方（label + 输入框）。
- loader 校验：blank.nodeIds ⊆ targetNodeIds；accepted 非空；wrongPatterns 的 blankId 存在；misconception id 已声明（同 choice 校验口径）。
- 公开配置（public-view）：**剔除 accepted / wrongAnswers / wrongPatterns**（可判分秘密门控，同 question.evidence 处理）。

## 2. Q1 组改造（v1.2 的三道 choice 换回填空，id 不变以保 demo/e2e 引用最小变动）

原卷措辞照录（docs/superpowers/sources/.../questions.md）：

- `pretest-exam1-polarity` → blank：prompt「该电池中，电极 a 为 {blank:a} 极，电极 b 为 {blank:b} 极。」
  - a：accepted ["负"]；wrongAnswers [{values:["正"], misconceptionIds:["D1-M1","D4-M2"]}]；nodeIds ["D1"]
  - b：accepted ["正"]；wrongAnswers [{values:["负"], misconceptionIds:["D4-M2"]}]；nodeIds ["D4"]
- `pretest-exam1-electron-flow` → blank：prompt「放电时，外电路中电子从 {blank:from} 极流向 {blank:to} 极（填"a"或"b"）。」
  - from accepted ["a"]、to accepted ["b"]；nodeIds 均 ["P4","D4"]
  - wrongPatterns [{blanks:{from:"b",to:"a"}, misconceptionIds:["P4-M1"]}]
- `pretest-exam1-stoichiometry` → blank：prompt「该电池放电时（生成 KO₂），消耗 K 与消耗 O₂ 的物质的量之比为 {blank:ratio} 。」
  - ratio accepted ["1:1","1∶1","1比1"]；wrongAnswers [{values:["2:1","4:1"],misconceptionIds:["P6-M2"]},{values:["1:2","1:3"],misconceptionIds:["P6-M1"]}]；nodeIds ["P6"]
- `pretest-exam1-membrane`（text）不变。

## 3. Q4 组新增（group `exam-q4-glucose`，组题干与 figure 同作废规格 §2 开头；素材复制同其 §1）

- `pretest-exam4-polarity`（blank，device，targets ["D1","D4"]，rubrics 对应）：prompt「该电池中，电极 a 为 {blank:a} 极，电极 b 为 {blank:b} 极。」a accepted ["正"] wrong [{["负"],["D1-M1","D4-M2"]}] nodeIds ["D4"]；b accepted ["负"] wrong [{["正"],["D1-M1"]}] nodeIds ["D1"]
- `pretest-exam4-cathode-equation`（text，P6）：同作废规格 §2 q4-2（referenceEquations 复用 aluminum-air/oxygen-positive；纯方程 text 形态放行）
- `pretest-exam4-material`（blank，device，targets ["D5","D1"]）：prompt「b 电极的电极材料是什么？{blank:material}」
  - accepted ["纳米CuO/导电聚合物","纳米CuO","CuO"]；wrongAnswers [{["Cu₂O","氧化亚铜"],["D5-M1"]},{["石墨"],["D5-M2"]},{["葡萄糖","C₆H₁₂O₆"],["D5-M1"]}]；nodeIds ["D5","D1"]
- `pretest-exam4-electron-loser`（blank，device，targets ["D5"]）：prompt「在 b 电极上，实际失电子的物质是什么？{blank:loser}」
  - accepted ["Cu₂O","氧化亚铜"]；wrongAnswers [{["葡萄糖","C₆H₁₂O₆"],["D5-M2"]},{["CuO","氧化铜"],["D5-M1"]},{["葡萄糖酸","C₆H₁₂O₇"],["D5-M2"]}]
- `pretest-exam4-process`（text，targets ["D5","P2"]）：同作废规格 §2 q4-3c（题目级 evidence 三槽 + §3 别名增补，原样采用）
- `pretest-exam4-stoichiometry`（blank，principle，targets ["P6"]）：prompt「消耗 18 mg 葡萄糖（C₆H₁₂O₆，M=180 g/mol）时，理论上 a 电极有 {blank:amount} mmol 电子流入。」
  - accepted ["0.2",".2","0.20"]；wrongAnswers [{["0.1"],["P6-M2"]},{["0.02","2×10⁻²"],["P6-M1"]},{["2","200"],["P6-M1"]}]

错答表全部来自 31 名学生真实作答分布（S06/S11 的 Cu₂O、S20 的石墨、S12 的 0.02 等）。

## 4. 同步与测试

- pretest v1.2 → v1.3；configDigest 全链路同步（sed tests/recordings + generate-demo-class-sessions + font:subset，模式同 eced63c）。
- demo 预置：新增/改型题目补 answer.submitted（已答未判分口径）；Q1 三题原 choice 预置事件改为 blank 作答形态。
- 测试：blank 判分单测（全对 hit、部分对 partial、已知错答带误区、未知错答 miss 无标签、跨空 wrongPatterns、归一化 1∶1/全角）；loader 坏配置（nodeIds 越界、accepted 空、未声明误区）；public-view 门控断言；m1a 断言更新（13 题、两组精确转录）；m2-pretest-flow 与 m3-real-e2e 作答步骤改为填空输入（按题干 gate）；全量 `pnpm test` + `pnpm run typecheck` 通过。
- 一次性提醒：m3-ac2-hotload 在全量套件下偶发超时属已知 flake，孤立重跑为准。

## 5. 约束

- UI 只动 `src/features/pretest/QuestionCard.tsx` + `src/styles.css` 追加；判分引擎/记录放 shared/server 既有分层。
- 不得改动并行 WIP：`src/runtime/api.ts`、`tests/m2-runtime.test.ts`、`src/App.tsx`、`src/app/**`、`src/features/model/**`、`src/features/training/LiveModelPanel.tsx`、`src/features/training/TrainingPage.tsx`。
- **不得触碰 `eval/**`、不运行任何 eval 命令**（live 校准运行中；`eval/cases/synthetic` 当前的"删除"状态是跑批临时挪位，严禁"修复"）。
- 不 git commit。
