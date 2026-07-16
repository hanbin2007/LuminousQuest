# 5 分钟演示回放步骤

演示入口:页面顶部打开“演示回放”开关。该动作同时完成三件事:

1. 服务端将 `executionMode` 切为 `demo`，禁止访问在线 provider。
2. 按 `start-state.json` 载入并校验 `session.json`、训练反馈轮次、手绘页状态和班级会话索引。
3. 跳转 `/training`；演示会话不覆盖本地 `latest`，关闭开关后恢复切换前的 execution mode 与会话。

## 点击脚本

| 时间 | 页面与动作 | 现场要点 | 回放资源 |
| --- | --- | --- | --- |
| 0:00–0:25 | 顶部打开“演示回放” | 指出 `executionMode=demo` 状态；固定反馈轮次直接可见 | `start-state.json`、`session.json` |
| 0:25–1:35 | `/training` 查看“本轮证据批注” | 说明程序控制脚手架，AI 不改规则分 | `config/cases/zinc-copper.json` |
| 1:35–2:15 | 在 P4 误区点击“请老师提示一下” | 第二轮提示来自录制回放，在线 provider 调用为零 | `tutor-p4.json`，step `demo-tutor-p4` |
| 2:15–2:50 | 点页头“前测”，再点“提交手绘点评” | 固定起点已在手绘页；响应 schema 只有 `comment` | `hand-drawing-feedback.json` |
| 2:50–4:10 | `/teacher` 展开 P4 证据链 | 展示量表规则、学生原文、误区 ID、判分引擎和脚手架轨迹 | `session.json` |
| 4:10–4:45 | 点“班级汇总”并导入三份会话 | 按学生去重、取最新会话，展示分布、错误率和 Top N | `class/student-01.json` 至 `student-03.json` |
| 4:45–5:00 | 点页头“外显” | 展示实装 3D 知识场景、点亮状态、节点详情和三维雷达 | `ModelPage.tsx`、`KnowledgeScene.tsx`、`lighting.ts` |

## 失败边界

- demo step 缺失或结构化响应不再符合当前 schema 时，只走确定性预设/`needs-review`，绝不回落在线 provider。
- `start-state.json`、主会话或三份班级会话与当前配置不一致时，一键切换失败，不加载陈旧分数。
- `demo-script.json` 在启动期校验 step ID、录制文件、资源路径、prompt/schema/config 版本。
