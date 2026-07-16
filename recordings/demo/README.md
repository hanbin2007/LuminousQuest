# 5 分钟演示回放步骤

演示入口:页面顶部打开“演示回放”开关。该动作同时完成三件事:

1. 服务端将 `executionMode` 切为 `demo`，禁止访问在线 provider。
2. 载入并校验 `session.json`，客户端与服务端使用同一份匿名会话。
3. 跳转 `/training`；关闭开关后恢复切换前的 execution mode 与本地会话。

## 点击脚本

| 时间 | 页面与动作 | 现场要点 | 回放资源 |
| --- | --- | --- | --- |
| 0:00–0:25 | 顶部打开“演示回放” | 指出 `executionMode=demo` 状态；可在断网下操作 | `session.json` |
| 0:25–1:35 | `/training` 查看锌铜案例一级脚手架 | 说明程序控制脚手架，AI 不改规则分 | 外置 `config/cases/zinc-copper.json` |
| 1:35–2:15 | 在 P4 误区处继续苏格拉底辅导 | 第二轮提示来自录制回放，在线 provider 调用为零 | `tutor-p4.json`，step `demo-tutor-p4` |
| 2:15–2:50 | `/pretest` 展示手绘点评入口 | 手绘点评只给表达建议，不写入正式分数 | `hand-drawing-feedback.json`，step `hand-drawing-feedback` |
| 2:50–4:10 | `/teacher` 展开 P4 证据链 | 展示量表规则、学生原文、误区 ID、判分引擎和脚手架轨迹 | `session.json` |
| 4:10–4:45 | `/teacher` 切到班级汇总并导入三份 fixture | 展示均值与四分位带、节点错误率、高频误区、匿名编号 | `tests/fixtures/teacher/*.json`；发布包使用赛前导出的三份会话 |
| 4:45–5:00 | `/model` | 仅跳转占位；3D 由独立交付线接入 | 无 |

## 失败边界

- demo step 缺失或结构化响应不再符合当前 schema 时，只走确定性预设/`needs-review`，绝不回落在线 provider。
- `session.json` 与当前量表或配置 digest 不一致时，一键切换失败并在开关旁显示错误，不加载陈旧分数。
- `demo-script.json` 在启动期校验 step ID、录制文件、资源路径、prompt/schema/config 版本。
