# 训练阶段 Agent Loop + 真实 AI 接入 + 自适应提问 + 3D 联动（M6）

日期：2026-07-23（用户需求原文见本节末）
状态：双路评审已回（opus-4.8 / gpt-5.6-sol max，报告见 scratchpad），收敛为 **M6-lite**（见文末决议）；完整 agent loop 列为赛后 T2。待用户确认。

用户需求（2026-07-23）：
1. 尽快把真实 AI 调用接入整个项目（替换 development 阶段的 mock）。
2. 训练阶段按前测结果针对性提问：已掌握的快速过，掌握不好的给更详细引导。
3. 学生-agent 聊天改为完整 agent loop：agent 自主决定下一个问题；提供学生画像，画像随训练更新。
4. 给 agent 足够工具：实时驱动 3D 视图、跟踪量表维度进度、适时点亮对应部分。

## 0. 不可动摇的架构前提

- **判分零 AI 裁量不变**：agent 只决定"问什么、怎么问、何时追问"，学生作答仍走
  确定性引擎（choice/builder/equation）或抽取层（闭集槽位→规则映射）。agent 永远
  不产生分数、不产生误区标签。这是答辩可解释性的根基。
- **断网兜底不变**：demo 模式 + recordings 回放必须在每一步改造后保持可用（9 月初
  断网彩排×3）。live 失败降级 needs-review 的既有语义不变。
- **provider 无关**：赛场无 Claude 订阅。一切新能力以 `LLMProvider.structured()`
  （JSON 闭集输出）为最大公约数实现，不依赖任何厂商原生 function calling。
  claude-agent 仅作本地开发通道；生产通道 = modelverse(glm-5.2) 或后续国内 key。

## 1. Track A：真实 AI 通道打通（先行，独立）

- 盘点 app 运行时所有 LLM 触点（server/workflows/**、server/app.ts 路由），确认每个
  触点在 `LQ_LLM_PROVIDER` 指向真 provider 时走 live 全链路（含录音写入、降级、
  candidates 记录），mock 仅在显式 `mock`/demo 模式下使用。
- 新增 `GET /api/llm/health`：返回 provider id/model、一次轻量探活结果（缓存 60s，
  不得每次请求都打真调用）、余额类错误的可读提示（如 Modelverse 403 overdue）。
- 前端 AppShell 显示 provider 状态徽标（live 绿 / demo 灰 / 故障红），故障时提示语
  面向教师（"AI 通道不可用，作答将转人工复核"）。
- `.env.example` 补全变量文档（LQ_LLM_PROVIDER/LQ_LLM_MODEL/各 key/LLM_TIMEOUT_MS）。
- 验收：`LQ_LLM_PROVIDER=claude-agent pnpm dev` 下，前测 text 题真实抽取判分全链路
  跑通；provider 杀掉后降级 needs-review 且 UI 有提示；demo 模式回归全绿。

## 2. Track B：前测驱动的自适应提问边界（规则层）

- 新增 `config/training-frontier.json`（或并入 scaffold-policy）：定义
  mastery→pacing 映射：
  - `hit` → `verify`：该节点 1 道快速验证题（从题库标 `verify` 用途题选取），
    答对即过、答错降级为 `standard`；
  - `partial` → `standard`：既有脚手架路径；
  - `miss`/`unanswered` → `guided`：细粒度引导（步子更小的子问题序列 + 已检出
    误区的针对性反例/追问模板 id 列表）。
- 服务器计算 `TrainingFrontier`：输入前测判分事件，输出按节点的 pacing、候选题目/
  模板 id 集、每节点预算（如 verify≤1 题、guided≤N 轮）。纯函数、有单测、可回放。
- 前测未覆盖节点默认 `standard`。教师端可覆写单节点 pacing（沿用教师决定日志机制）。

## 3. Track C：Agent Loop 与学生画像

- **回合制 orchestrator（服务器端）**：每回合组装上下文 → `structured()` 请求 →
  zod 校验的闭集 action envelope → 执行 → 事件入会话流。上下文 =
  角色与约束系统词 + 学生画像 + TrainingFrontier 当前状态 + 最近 K 轮对话摘要 +
  可用 action 清单（含 3D 操作）。
- **Action 闭集**（v1）：
  - `ask_question { questionId | templateId, phrasing }`：从 frontier 候选集内选题，
    phrasing 允许 agent 自组织语言但题干语义由题库/模板锚定；
  - `evaluate_answer`：显式触发既有判分管线（结果由系统回填，agent 只读）；
  - `light_node { nodeId, state }` / `set_view { presetId }` / `show_progress
    { dimensionId }`：3D 与进度 UI 指令，落到 agent activity stream 事件；
  - `note_profile { text }`：向画像追加观察（自由文本区，与结构化区隔离）;
  - `advance { nodeId }` / `end_stage { reason }`：在预算内推进/收尾。
  - 越界 action（题目不在候选集、节点不在 frontier）→ 拒绝并带原因重试一次，
    再失败则由规则层兜底选下一题（系统可继续，不卡死）。
- **学生画像（StudentProfile）**：结构化区 = 逐节点 {mastery, 误区 id + 证据引用,
  最近表现}；风格区 = 作答长度/术语习惯等观察；自由 note 区（agent 写入，上限截断）。
  判分事件后由规则更新结构化区；画像全量存入会话事件流（可回放、可导出给教师）。
- **降级**：live 不可用时 orchestrator 退回规则层顺序提问（现状行为），聊天区提示。

## 4. Track D：3D 视图联动与量表进度（Fable 亲自做）

- 前端消费 `light_node`/`set_view`/`show_progress` 事件：3D 模型对应节点发光/呼吸、
  镜头平滑切换到预设机位、量表维度进度条实时推进并在达标时点亮。
- 进度追踪：按 rubric 维度聚合判分事件 → 维度进度（已验证节点数/总数、误区消除数），
  与 agent 无关、纯前端派生，保证与判分记录一致。
- 视觉语言沿用 glass design system 与既有动效审计标准。

## 5. 顺序、分工与约束

- 顺序：A（codex，立即）→ 规格评审收敛 → B+C（codex，同一任务承接，B 是 C 的输入）
  → D（Fable，B/C 联调期并行）→ 全链路联调 → 里程碑终审（gpt-5.6-sol max + fable-5）。
- 实现一律 gpt-5.6-sol `max`；评审一律 opus-4.8 + gpt-5.6-sol 双路。
- 冻结窗口约束：本轮**不动 `eval/**`**（校准运行中）；config 改动集中一批做
  （与 s12-p1 别名修复合并），一次性完成 configDigest 全链路重同步。
- 测试：每 Track 附单测 + 相关 m 级测试；全量 `pnpm test` 在校准运行结束后统一跑
  （避免资源争抢与 m3-ac2-hotload 假红）。

## 6. 双路评审收敛决议（2026-07-23，M6-lite）

两份评审共识：方向成立（闭集 envelope / frontier 规则层掌权 / 判分零裁量不动），
但完整 agent loop 8/8 前达不到交付级（gpt 估 17–29 工程日 vs 16 个自然日；且原
冻结设计明确"不上完整 Agent Loop"，变更需决策记录）。收敛如下：

**M6-lite 范围（冻结前交付）**
- A（真实 AI 通道）：保留原样。修正验收命令（`pnpm dev` 只启 Vite，须以
  server+vite 双进程或既有一体化脚本验收）。追加"正式 provider 过既有 live/eval
  门槛"为 M6 准入条件。
- B（自适应）：收缩为纯函数 `deriveInitialScaffold(pretestEvents)` + pacing——
  miss/unanswered/needs-review→Level 1 细引导、partial/unassessed→Level 2、
  全 hit→Level 3 快检（复用既有题，不新建 verify 题库，零新内容）。教师可覆写。
- C（agent 化）：**不建通用 orchestrator**。把既有 socratic cycle 扩为
  frontier-pacing 驱动：轮数预算/引导深度/误区针对模板由 pacing 决定；
  evaluate/advance/end 一律规则层决定；题干只用教师审核文本，模型自由度限于
  过渡语/鼓励语等非题干文本且过既有泄漏守卫；`note_profile` 自由笔记本期删除。
- 画像：版本化纯投影。只读 `DiagnosticProfile`（前测基线，训练不回写）与训练期
  `TrainingState` 分离；证据只引 event ID；显式处理 needs-review/unassessed/
  重复作答/有帮助命中。不做画像快照入事件流。
- D（3D/进度）：灯态与维度进度**只从判分事件派生**（现状机制，权威）；agent 侧
  仅保留非权威 `focus_node` 聚焦提示（镜头/呼吸引导，不改灯态）；`effects[]` 由
  服务器按题目映射生成，不由模型直接指定视图指令。
- 门禁追加：断网 demo 全程零网络且录制版本不一致**拒绝启动**（现仅告警）；
  provider 断开训练可走确定性流程；agent 输出永不产生/修改 assessment、灯态、
  进度、结课事件；config 改动（frontier + s12-p1 别名）一批完成并立即全量重录。

**延期 T2（8/15 后/赛后）**：通用 agent orchestrator、模型决定跨节点跳转与
evaluate/advance/end、自由题干改写、画像自由笔记回灌、摄像机 preset 全集、
误区消除进度语义、完整自适应题库、provider 原生 function calling 优化。

**风险台账（合并两报告 top）**：① config 重录税（最重，批量一次做）；② 服务端
session 内存态无恢复权威（M6-lite 靠"事件流可回放"绕开，orchestrator 持久化列 T2
前提）；③ session.v2 闭集事件 schema 扩展波及导入导出/教师端/fixture/demo（B/C 事件
类型新增最小化）；④ D 依赖 C 事件契约——C 开工 1–2 天内先冻结事件 schema 交付。
