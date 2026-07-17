# LuminousQuest M5 未提交改动严格代码评审

评审范围：以 `git status --short` 与 `git diff` 为准，覆盖评审开始时的 39 个已修改/未跟踪路径（含指定的 provider、归一化、3D、面板、测试与规格文件）。

1. **严重｜`prompts/structured-assessment.md:8-9`，`shared/workflows/extraction-validation.ts:437-460`，`shared/scoring/policy.ts:60-70`｜规则层仍信任 LLM 对语义槽位的指派。** 校验只证明实体字样出现在引用中，不证明该实体在句中确实承担 `electron-from`/`electron-to` 等关系；评分随后按 LLM 给出的 slot id 精确命中。我实测“电子不是从锌极流出，而是从银极流出”被构造为 `electron-from=锌极` 后通过校验并判为 `hit`；反向句也可通过交换 slot id 误判。**建议：**关系槽必须绑定含谓词/方向/否定的完整分句，由服务端确定性解析关系和实体位置；不能证明关系时一律 `needs-review`，并加否定、反向、换序对抗测试。

2. **严重｜`src/features/model/live-cell.ts:117-126`，`src/features/training/LiveModelPanel.tsx:104-126`，`src/features/model/CellScene.tsx:188-232,509-552`｜极性命中前直接泄露知识答案。** 任意点击尚未作答的 E1/P4 芯片，DOM 与 `aria-live` 会播报完整 `node.statement`；Canvas 同时常驻显示“放电·氧化·负极/还原·正极”、`+/-`、失/得电子场所及两条能量转换。公开配置仍携带完整 knowledge model（`server/config/public-view.ts:3-30`）。**建议：**以 `polarityLit`/节点已解锁状态统一门控 statement、标签和场景语义；命中前只渲染无方向、无正误、无陈述的中性骨架。当前 `litSignature` 虽不含电极 token，却含全部节点灯态（`live-cell.ts:148-152`），也应在门控后才驱动可见结果。

3. **严重｜`shared/workflows/assessment.ts:524-539`，`server/app.ts:717-723`｜服务端在极性答错时仍把正确答案发给学生端。** 每个 `polarity.assessed` 事件无论 hit/miss 都含 `correctValue`，API 又原样返回完整 session；UI 虽在 miss 时不读取它，网络响应、React 状态或 DevTools 中仍可直接看到 `negative=Zn;positive=Cu`。**建议：**保留服务端私有事件，但为学生 API 建立显式 serializer，在未解锁前删除 `correctValue`（及其他 rubric/答案字段）；只返回服务端推导后的安全展示 DTO，并加响应体防泄题测试。

4. **严重｜`server/llm/providers/index.ts:2,13-15`，`server/llm/providers/claude-agent.ts:1`，`scripts/package.mjs:297-308`｜当前 SEA 比赛包会在启动时崩溃。** provider 被静态导入，esbuild 又把 ESM Agent SDK 打成 CJS；我用同一打包参数做无落盘构建，产物为 `var import_meta = {}; createRequire(import_meta.url)`，即模块初始化即以 `undefined` 调用 `createRequire`。SDK 所需约 230 MB 平台原生 CLI 也未进入 release 内容。**建议：**临时 provider 必须按显式开发开关动态加载并从 SEA 排除；若比赛包确需它，则 externalize SDK、明确携带/定位原生 CLI，并新增实际 packaged executable 启动冒烟测试。

5. **高｜`src/features/training/TrainingPage.tsx:456-467,626-633,749-756`｜冷迁移路径违反“不显示即时对错”。** 面板对 transfer 案例同样常驻，首个 narrative 请求返回后立即合并 session，后续方程式请求尚未结束时灯态已经更新；初始状态又可点击芯片读陈述。**建议：**transfer 阶段隐藏或冻结面板，直到整次评估完成并进入既定 comparison；状态推导也应显式忽略未发布的 transfer 事件。

6. **高｜`server/llm/providers/claude-agent.ts:40-53,105-109`，`server/llm/service.ts:114-129,216-234`，`server/workflows/socratic-tutoring.ts:264-295`｜超时后 Claude 子进程继续运行并与重试叠加。** Socratic 上游通常 6 秒超时，但 provider 强制最少 60 秒；外层 `Promise.race` 只拒绝等待，无法 abort 第一个 query，随后重试会再启动一个进程。比赛中连续追问可快速堆积进程、消耗 OAuth 配额并产生迟到写入。**建议：**让 service/provider 共享同一个 AbortSignal，超时必须真正终止 query；不要擅自扩大调用方 deadline，冷启动预算应在各 workflow 配置中显式决定。

7. **高｜`server/llm/providers/claude-agent.ts:44-53`，`recordings/eval-candidates/README.md:3-5`，`scripts/package.mjs:223-230`，`.gitignore:8-11`｜学生文本的本地持久化与发布边界失守。** Agent SDK 未设置 `persistSession:false`，默认会写会话 transcript；新 candidate 又包含完整学生答案且标记 `requiresHumanAudit`，但 `recordings/eval-candidates` 未忽略，打包脚本还会复制除 cache 外的整个 `recordings`。**建议：**关闭 SDK session persistence；忽略并从 package 明确排除 eval candidates，只允许经过人工审核的脱敏导出进入发布物。

8. **高｜`shared/workflows/extraction-validation.ts:464-497`，`shared/workflows/assessment.ts:586-630`｜`errorIds` 非空并未无条件要求证据。** 条件被 `response === substantive` 包住；空白/“不知道”作答若 LLM 声明 `P4-M1` 且不给 evidence，服务端覆盖 response 后会放行，并把 misconception id 写入 unanswered 事件。**建议：**`errorIds.length > 0` 时始终要求可验证证据，或对非 substantive 响应强制清空 slots/errorIds；再增加 blank 与 non-answer 两条回归。若一个节点可声明多个 error id，还应逐 id 绑定证据，而不是用任意 aggregate quote 背书。

9. **高｜`shared/workflows/extraction-validation.ts:393-411,443-460`，`tests/extraction-pipeline.test.ts:475-505`，`recordings/eval-candidates/2026-07-16T11-59-44.327Z-fact-grounding-a31095e2-8254-4b78-ace5-63fdc63ad720.json:21-31`｜可恢复的槽值粒度错误绕过配置的 retry。** 首次真实 Claude 输出把 `electron-from` 写成短语“电子从锌极流出”，正确答案因此直接 `fact-grounding`/needs-review；该类别被标为不可重试，测试还固定断言只调用一次。**建议：**区分“引用不支持事实”的不可重试错误与“值非最小实体/格式不合 schema”的可重试错误，后者带纠错提示重试一次；最好使用 SDK 原生 structured output/schema 约束。

10. **高｜`tests/m5-live-model-panel.test.tsx:75-121`，`tests/policy-contract.test.ts:171-216`｜测试没有覆盖本次最高风险边界，且把泄题行为写成预期。** 面板测试只走 jsdom fallback，并明确断言任意聚焦会显示完整 statement；没有真实 WebGL、dispose/remount、reduced-motion、transfer 冻结、API redaction、Claude provider/SEA 或关系反向测试。全量 `pnpm test` 结果为 50 个文件通过、1 个失败（437/438）；`m3-ac2-hotload.test.tsx:249-253` 在组合运行超时，隔离运行才 2/2 通过。**建议：**先补上述安全/打包/画布测试并查明负载敏感超时，不能以隔离绿代替全量门禁。

11. **中｜`shared/scoring/policy.ts:127-136`，`shared/workflows/assessment.ts:660-677`｜跟随性错误仍使用旧的无别名比较。** objective/anchor 已支持别名，但 `factsMatchRequirements` 仍只做规范化字符串相等；若同一学生表达被 LLM 在 anchor 输出为 `Cu`、P4 输出为“铜极”，逻辑链会因表示法不同被判不自洽。**建议：**删除第二套 matcher，统一复用 alias-aware 精确匹配并传入同一 aliases/commonTypos；增加 canonical/中文交叉表示的 following-error 测试。

12. **中｜`shared/fact-value-normalization.ts:58-66`，`config/scaffold-policy.json:24-65`，`shared/scoring/policy.ts:60-70`｜归一化表缺少互撞与 typo 元数据约束。** 当前“氧气侧”同时属于 `oxygen-side` 与 `oxygen-Pt`；另外评分会无条件把“电级”改成“电极”，即使 LLM 声明 `typo:none`，从而丢失应由规则层产生的 typo warning（策略改为 penalize 时还会绕过扣分）。`银极` 与“锌极错误”目前确实不会子串命中，但这不解决别名互撞。**建议：**配置加载时建立反向索引并拒绝未显式声明的碰撞；归一化函数返回 applied-typo 元数据，由规则层确定 `verified.typo` 与 warning。

13. **中｜`src/features/training/TrainingPage.tsx:691-696`，`src/features/training/LiveModelPanel.tsx:82-126`｜键盘与读屏路径不完整。** 可点击反馈项是无 role/tabIndex/键盘处理的 `div`；`aria-hidden=true` 包住了无 WebGL 文本 fallback；芯片可达但 accessible name 只有节点 id，灯态仅由 CSS 表达。**建议：**反馈项改为真正的 button/独立聚焦按钮；只隐藏 Canvas，不隐藏 fallback；芯片 `aria-label` 加安全的状态文本，aria-live 只播报已解锁内容。

14. **中｜`src/features/training/LiveModelPanel.tsx:5,23-29`，`src/features/model/CellScene.tsx:5,640-665`｜3D 初始成本与 reduced-motion 资源策略不足。** `webglAvailable` 创建上下文后不显式释放；Canvas 即使 reduced-motion 也保持默认 `frameloop=always`。生产构建还显示 TrainingPage 静态依赖 897.11 kB 的 `KnowledgeScene` chunk 与 449.50 kB 的 renderer chunk，无 WebGL 设备也会先下载/解析。**建议：**把 `STAGE` 抽到轻量 token 模块，WebGL 检测后再 lazy import 场景；释放探测上下文，并在 reduced-motion/静态态使用 demand loop。其余自建 texture/geometry 已有 dispose，`useFrame` 主循环未见逐帧对象分配，`React.memo` 也避免了输入时重建场景。

15. **低｜`src/styles.css:2772-2785`，`docs/superpowers/specs/2026-07-16-live-cell-panel.md:35-39`｜单列布局位置与规格不符。** `order:-1` 作用于整个 rail，使面板排到包含页面标题和案例标题的 `.training-main` 之前，而不是“案例标题之下”。**建议：**拆出 heading 为独立 grid area，或在窄屏 DOM 中把 panel 插入 case heading 与作答区之间，并做桌面/移动截图回归。

16. **低｜`.codex-fix-report.md:31-35`｜随改动携带的验证报告已过期。** 它声称当前最终全量为 49 文件/430 测试全绿且“未改 provider/prompts”，与当前工作树和本次 437/438 结果均不一致。**建议：**不要把该文件作为 M5 发布证据；更新为当前命令、commit/worktree 状态和真实失败，或从提交中移除。

## 已确认项

- 未覆盖节点的 `slots=[]/errorIds=[]/evidence=[]` 现在可合法通过并在规则层按缺失事实判定；不利分类仍逐项要求自己的 grounded quote（`extraction-validation.ts:263-318,492-497`），此处未见回归。
- 评分别名采用归一化后的精确等值，不是子串匹配；现有测试对“银极”和“锌极错误”均为 miss。`tests/m3-training-flow.test.tsx:55-60` 将查询收窄到作答区是为避开新芯片，不弱化原本的作答字段断言。
- M4 冻结 runbook、`recordings/demo`、`release` 与 `dist` 均无未提交改动；新增的是 eval candidate，不是 demo 录制。演示模式也未发现专用特判。

## 验证结果

- `git diff --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm build:client`：通过，但有上述大 chunk 警告。
- `pnpm test`：437/438 通过，`tests/m3-ac2-hotload.test.tsx` 组合运行超时；该文件隔离重跑 2/2 通过，因此全量门禁仍不算绿。

## 整体结论

**不通过。** 当前同时存在可复现的 LLM 语义槽位误判、多个学生端泄题通道、SEA 比赛包启动级故障，以及全量测试未绿。至少修复 1-10 后才适合重新评审；其余中低项应在比赛发布前关闭或形成明确、可测试的风险接受记录。
