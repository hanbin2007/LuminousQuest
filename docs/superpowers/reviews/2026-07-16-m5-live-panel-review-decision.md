# M5(live 链路 + 训练分屏 3D 面板)双评审终审决议

日期:2026-07-16 | 输入:opus-4.8(有条件通过,0 阻断 4 建议)、gpt-5.6-sol max(不通过,4 严重 + 6 高 + 4 中 + 2 低)
终审(Fable 5)结论:**有条件通过——codex #4/#5 两项成立且必须修,其余分级处理;codex #2 驳回。**

## 裁决(按 codex 编号;opus 重叠项并入)

| # | 裁决 | 处置 |
|---|---|---|
| 1 实体槽关系语义信任(否定句构造 hit) | **成立,存量**(M1 起的抽取信任边界,非本批引入;codex 修法"确定性中文关系解析"不可行) | 延期 D1:下一里程碑把布尔槽的否定感知扩展到实体槽 groundingContext,对抗样本进 eval 语料后校准 |
| 2 芯片/aria/场景展示节点陈述与通用框架标注=泄题 | **驳回** | 知识模型陈述是《统一认知模型》通用教学框架:模块三、前测诊断页本就全量公开展示(公开配置刻意保留 knowledgeModel),陆老师板书即此模型。可判分的秘密是案例级绑定(极性/材料/acceptedValues/误区映射),这些已门控。litSignature 只含学生自己的灯态,非答案 |
| 3 miss 时 correctValue 随 session 下发(devtools 可见) | **成立,存量**(会话 schema 要求 correctValue,裁剪需 schema/导入导出/教师端联动设计) | 延期 D2:客户端会话投影设计,短期风险接受(课堂工具,devtools 翻网络响应属主动作弊,教学场景可控);记录在案 |
| 4 SEA 比赛包因静态导入 Agent SDK 启动即崩 | **成立(已核实 esbuild 无 externals,CJS 打包 ESM SDK)** | **必修 C1**:claude-agent 动态加载 + SEA external + 打包产物启动冒烟测试 |
| 5 冷迁移案例面板实时点亮,违反"不显示即时对错" | **成立(我的设计疏漏)** | **必修 F1**(Fable 5):transfer 案例不渲染实时面板,以静态说明占位 |
| 6 provider 60s 下限对抗调用方 deadline,超时进程堆积 | 成立 | 修 C2:移除下限,按 request.timeoutMs 自我 abort(缺省 60s);claude-agent 下辅导仍将优雅降级,GLM 接入后消失 |
| 7a SDK 会话落盘(学生文本) | 部分成立(SDK 无 persistSession 选项,codex 修法无效;风险真实) | 缓解并入 C1(动态加载+仅开发环境启用+文档注明);正式链路(GLM)无此问题 |
| 7b eval-candidates(学生原文)被打进发布物 | 成立(已核实 copyExternalContent) | 修 C3:打包排除 recordings/eval-candidates + .gitignore |
| 8 非 substantive 时 errorIds 免证据,幻觉误区进 unanswered 事件 | 成立(真实边界洞) | 修 C4:errorIds 非空无条件要证据;非 substantive 强制清空 slots/errorIds;补 blank/敷衍回归 |
| 9 槽值粒度错误不可重试,浪费可恢复抽取 | 成立但保守方向(落 needs-review,不产生假 hit) | 延期 D3:重试类别细分待 eval 语料驱动决策 |
| 10 测试缺口 + 全量 437/438(ac2-hotload 组合超时) | 测试缺口并入各修复项;超时为负载敏感偶发(本机多次 438 全绿,codex 并行跑 build 挤压),终审复跑确认 | 修复后复跑全量为准;若再现则单独立项 |
| 11 factsMatchRequirements 别名盲(跟随错误欠给分) | 成立(opus #2 同发现,保守方向) | 修 C5:统一复用 alias-aware 匹配 + 交叉表示回归 |
| 12 别名互撞(氧气侧)+ typo 元数据 | 成立但涉配置与教学裁量(改 config 会失效全部 demo 冻结物) | 修 C6:加载期反向索引**警告**(不 error);「氧气侧」宽容度提交陆老师裁量,配置修改留到 M5 冻结窗口;typo 元数据延期 D4 |
| 13 aria-hidden 盖住无 WebGL 回退;芯片名无状态;div onClick 无键盘 | 前两项成立 | 修 F2(Fable 5):aria-hidden 仅在有 WebGL 时;芯片 aria-label 带灯态。div onClick 保留为指针增强(键盘路径=芯片+提示按钮),记录决定 |
| 14 探测上下文未释放;reduced-motion 仍 always;1.3MB chunk 静态进训练页 | 成立(质量项) | 修 F3(Fable 5):STAGE 抽轻量 tokens 模块 + CellScene 懒加载 + loseContext + reduced-motion 用 demand 帧循环 |
| 15 单列布局面板位于页首,与规格文字不符 | 成立(轻微) | 修 F4:规格措辞改为"单列时面板置顶"(比赛为桌面场景,窄屏非关键路径) |
| 16 .codex-fix-report.md 过期 | 成立 | 修 F5:根目录 codex 报告不入库,结论并入本决议 |

## 复核安排

C1-C6 由 codex(max)实施,F1-F5 由 Fable 5 实施;完成后全量测试+typecheck+SEA 打包冒烟,Fable 5 复核 codex diff 后视为关闭。D1-D4 列入下一里程碑待办与教师决策清单。
