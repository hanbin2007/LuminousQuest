# 前测 Q4 组（血糖电池）——按前端既有「填空→choice 映射」模式实现

日期：2026-07-23
取代：`2026-07-23-pretest-blank-questions.md` 的 blank 新题型方案**作废**（留档）——前端已在 5c8413c/a204d21 落地「UI 填空、判分复用 choice 引擎」模式（`src/features/pretest/exam-flow.ts`：归一化填答→选项 id，学生不见选项，判分秘密不泄露）。本规格 = 用该模式补齐 Q4 组，Q1 三题维持前端现状不动。

## 1. config（pretest v1.2 → v1.3）

新增 group `exam-q4-glucose`（组题干与 figure 见作废规格 `2026-07-23-pretest-exam-q4.md` §2 开头；素材复制其 §1：`q4-glucose-implant.png` → `assets/exam/`）。六题：

1. `pretest-exam4-polarity`（choice，device，targets ["D1","D4"]）——选项集（供映射，UI 不展示）：
   - A（correct）：正｜负　B：负｜正 → ["D1-M1","D4-M2"]　C：正｜正 → ["D1-M1"]　D：其他作答 → []
2. `pretest-exam4-cathode-equation`（text，["P6"]）：同作废规格 §2 q4-2（referenceEquations 复用 aluminum-air/oxygen-positive；纯方程 text 放行）
3. `pretest-exam4-material`（choice，["D5","D1"]）：
   - A（correct）：纳米 CuO/导电聚合物（CuO）　B：Cu₂O/氧化亚铜 → ["D5-M1"]　C：石墨 → ["D5-M2"]　D：葡萄糖/C₆H₁₂O₆ → ["D5-M1"]　E：其他作答 → []
4. `pretest-exam4-electron-loser`（choice，["D5"]）：
   - A（correct）：Cu₂O/氧化亚铜　B：葡萄糖/C₆H₁₂O₆ → ["D5-M2"]　C：CuO/氧化铜 → ["D5-M1"]　D：葡萄糖酸/C₆H₁₂O₇ → ["D5-M2"]　E：其他作答 → []
5. `pretest-exam4-process`（text，["D5","P2"]）：同作废规格 §2 q4-3c（题目级 evidence 三槽 + §3 scaffold-policy 别名增补，原样采用）
6. `pretest-exam4-stoichiometry`（choice，["P6"]）：
   - A（correct）：0.2　B：0.1 → ["P6-M2"]　C：0.02/2×10⁻² → ["P6-M1"]　D：2/200 → ["P6-M1"]　E：其他作答 → []

「其他作答」兜底选项：correct=false、misconceptionIds=[]——映射层无法识别的填答落到它，判 miss 不贴标签（不阻塞提交、语料保真）。choice schema 若限定 4 选项数，放宽到 ≤6。错答选项文本仅作内部标注（UI 不展示），来源为 31 名学生真实错答分布。

## 2. 前端（沿用 exam-flow 模式，只动 `src/features/pretest/exam-flow.ts` + 必要的 QuestionCard 适配）

- fill kinds 新增：`polarity`（复用，Q4 极性两空）、`substance`（单空物质名：material/electron-loser 共用归一化——去空白/全半角/大小写/下标数字还原、「氧化亚铜→Cu₂O」「氧化铜→CuO」中文名映射）、`amount`（单空数值：0.2/.2/0.20/2×10⁻¹ 归一）。
- `ORIGINAL_EXAM_PROMPTS` 按原卷措辞增补 Q4 四道填空题；`originalExamTitle` 增补 `exam-q4-glucose` →「血糖微型电池」。
- 映射函数：接受值→A；已知错答→对应选项；其余→兜底选项 id（不再返回 null 阻塞）。Q1 三题现状不动。
- 4-2 与 4-3c 是 text 题，走既有简答/方程 UI，无需映射。

## 3. 同步与测试

- demo 预置（已答未判分）为 6 新题补 answer.submitted；configDigest 全链路同步 + generate-demo-class-sessions + font:subset（模式同 eced63c）；m1a 断言（13 题/两组）、exam-flow 映射单测（接受/错答/未识别兜底/归一化中文名与数值形态）、m2-pretest-flow 与 m3-real-e2e 填空作答步骤、public-view 门控回归。
- 全量 `pnpm test` + `pnpm run typecheck`；m3-ac2-hotload 偶发超时以孤立重跑为准。

## 4. 约束

- 不碰 `eval/**`、不运行 eval 命令（live 校准运行中，`eval/cases/synthetic` 的"删除"是临时挪位禁止修复）。
- 前端改动收敛在 `src/features/pretest/`（exam-flow.ts 为主，QuestionCard 仅必要适配）；不动训练/模型/AppShell 等其它前端。
- 不 git commit。
