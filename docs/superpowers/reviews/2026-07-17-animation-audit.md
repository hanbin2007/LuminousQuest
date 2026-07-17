# 全量动画审计与修复(improve-animations)

日期:2026-07-17 | 审计:4 路并行子代理(八类目)→ Fable 5 逐条复核终审 | 修复:Fable 5(动效属亲自域)

## 已修复

| # | 严重度 | 发现 | 修复 |
|---|---|---|---|
| 1 | HIGH | reduced-motion 下 3D demand 帧循环 + 输入不 invalidate → 拖拽/缩放冻结 | orbit-controls 增 `input` 回调,双场景 Rig 接 `invalidate`;KnowledgeScene 统一 demand(顺带修功耗不一致) |
| 2 | MEDIUM | `eflow-complete` 动 `left`(布局属性) | 改 transform + 容器查询单位(100cqw) |
| 3 | MEDIUM | 庆祝电子流 `forwards` 冻结堆叠残留 | 末段(80%→100%)淡出收尾 |
| 4 | MEDIUM | 训练电子流 ease-out 违背匀速母题 | 改 linear;行程 198px 硬编码改 100cqw+18px |
| 5 | MEDIUM | 8 处可按元素零按压反馈;按压深度 0.92-0.94 超准则;两套按压词汇混用 | 纸面域统一 translateY(1px)、暗态域 scale(0.96/0.95/0.97),含模块三重放钮补 hover+active |
| 6 | MEDIUM | reduced-motion 一刀切:spinner 静止似卡死、叙事淡入被清除 | 归零块内回补:spinner 换 1600ms 透明度脉冲、关灯舞台保留 400ms 淡入 |
| 7 | MEDIUM | 手绘 pointermove 每事件 getBoundingClientRect+getComputedStyle | 笔画 pointerdown 缓存一次,move 路径零读取 |
| 8 | MEDIUM | 7 处散装时长字面量绕开 token;三套 reduced-motion 通道;fallback 走私第二曲线 | 新增 `--dur-press/--dur-enter/--dur-panel` token 收编;删两个冗余 reduced-motion 局部块;fallback 清除 |
| M1 | HIGH | 前测步骤切换整体瞬移 | `.step-content` keyed 进场(content-in 250ms,与批注同语言) |
| M2 | HIGH | 训练案例切换左列换血、右侧死寂 | 左列 keyed content-in;面板 meta 随案例 focus-text 淡入(3D 画布不重建) |
| M3 | MEDIUM | 反馈区瞬现、批注卡整组同帧 | `.training-feedback` 进场 + 批注卡 50ms 错峰(≤6 张,纯装饰不阻塞) |
| M5 | MEDIUM | 顶栏进度填充 0→50% 瞬跳(且 width 属布局动画) | 改 `scaleX(--progress-scale)` + 600ms 里程碑过渡(双向) |
| 10 | LOW(顺手) | matchMedia 一次性读取不监听 | 新增订阅式 `useReducedMotion()`,LiveModelPanel/ModelPage 接入 |
| 11 | LOW(部分顺手) | 分段控件/tabs/芯片选中底色瞬跳 | 按压批次的过渡声明连带覆盖 background/color |

## 已驳回(审计报了、终审否了)

- hover 用强 ease-out 而非 `ease`:单缓动 token 是成文体系。
- needs-review 无限脉冲:语义即"待处理",M4 决议在案。
- 按压对称计时:准则针对 deliberate phase,不适用小按钮。
- focus-text keyframes 重播:内容替换语义下 keyframes 是正确工具。
- 反馈卡键盘路径:M5 评审已裁决(芯片=键盘路径)。

## 推迟清单(记账,后续里程碑取用)

| 项 | 严重度 | 内容 | 推迟理由 |
|---|---|---|---|
| M4 | MEDIUM | 冷迁移对比页(训练终点)整页瞬换,应花 delight 预算(进场 + 前后测分数错峰揭示) | 涉及 TransferRadarComparison 编排设计,值得单独一次专注实现而非顺手 |
| M6 | MEDIUM | 训练分屏每次提交全场景熄灭重燃 → 应增量点亮(只点新增节点,外显"这次多亮了什么") | 需在面板层 diff 前后灯态、改 ignition 语义,触及 3D 核心;与 M4 一起做 |
| #9 | LOW | FocusHalo/选中缩放阶跃值 → useFrame 内 lerp 包络 | 纯打磨 |
| #12 | LOW | test-nav 浮层 keyframes 不可中断、无退场 → transition + @starting-style | 仅测试模式可见 |
| P-3 | 备案 | 反馈卡聚焦 box-shadow 过渡(paint 属性) | 偶发 + 2px 描边,成本可忽略,接受 |
| 附带 | 备案 | HandDrawingPanel 画布尺寸变化在笔画中途触发会清空画布(context() 内 resize 检查) | 非动效缺陷,列入下次功能修 |

## 验证

447/447 测试、typecheck、构建全绿;实机走查:案例切换中间帧确认左列浮现+面板 meta 应答、进度线双向 600ms 过渡、测试跳转回退正确回收完成态。
