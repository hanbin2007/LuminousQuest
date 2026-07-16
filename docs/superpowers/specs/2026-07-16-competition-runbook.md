# LuminousQuest 比赛运行手册

> 适用交付:macOS arm64 Node SEA 发布包。默认仅本机访问；需要同一可信局域网的第二台设备时才启用 `--lan`。

## 一、赛前冻结与启动

### 发布物核验

在仓库根目录执行:

```bash
test "$(node -p "require('./release/darwin-arm64/RELEASE.json').sourceCommit")" = "$(git rev-parse HEAD)"
shasum -a 256 -c dist/client.sha256
shasum -a 256 -c dist/release-darwin-arm64.sha256
codesign --verify --deep --strict release/darwin-arm64/LuminousQuest
```

三条命令均成功后，保持 `release/darwin-arm64/` 目录结构不变。可执行体与 `config/`、`prompts/`、`assets/`、`recordings/`、`.env` 是一个整体，不能只移动可执行体。

### 默认启动

```bash
cd release/darwin-arm64
./start.command
```

终端出现 `[startup] LuminousQuest is ready at http://127.0.0.1:<端口>` 即启动完成。默认端口为 `4173`；占用时程序自动选择后续空闲端口并打印实际地址。默认只绑定 `127.0.0.1`，不向局域网暴露。

### 局域网启动

```bash
cd release/darwin-arm64
./start.command --lan
```

只把终端打印的完整 `LAN URL` 发给现场演示设备。URL 含本次启动随机令牌，首次验证后令牌从地址栏移除并写入 HttpOnly Cookie。局域网模式是明文 HTTP，只能用于可信私有网络；不用时立即 `Ctrl+C` 关闭。完整边界见 `docs/2026-07-16-lan-security.md`。

## 二、2 分钟陈述稿

**0:00-0:25，问题。** LuminousQuest 面向高中化学电化学学习。它不把一次答案压成一个总分，而是把“装置理解、原理解释、能量判断”拆成可追溯的知识节点，让教师知道学生错在哪里、依据是什么、下一步如何训练。

**0:25-0:55，学生侧。** 学生先完成多模态前测，再进入案例训练。规则引擎负责正式判分，AI 只做结构化抽取和苏格拉底式提示；每条结果都保留量表条目、学生原文和引用区间。模块三再把同一画像映射成可交互 3D 知识场景，而不是另算一套分数。

**0:55-1:25，教师侧。** 单生视图串起诊断、训练和脚手架轨迹，待复核项单独列出。班级视图批量导入匿名会话，给出三维均值与分布带、节点错误率和高频误区，且明确拒绝损坏、重复或量表版本不一致的文件。

**1:25-1:45，可信与离线。** 比赛演示使用内置录制会话，打开“演示回放”后显示 `executionMode=demo`，整个流程不访问在线模型。发布物是 arm64 Node SEA 可执行体加可审计外置内容，配置、提示词、回放和哈希清单都可独立检查。

**1:45-2:00，价值。** 产品交付的不是更会聊天的模型，而是一条从学生原话到教学决策的证据链。它帮助教师把有限时间用在真正需要复核和干预的节点上。

## 三、5 分钟点击脚本

演示前关闭 Wi-Fi，确认应用已经打开。所有主跳转都可直接在地址后追加路由，例如 `http://127.0.0.1:4173/teacher`。

| 时间 | 主路径与点击 | 讲解证据 | 备用跳转或处置 |
| --- | --- | --- | --- |
| 0:00-0:25 | 页头打开“演示回放” | `start-state.json` 一键恢复训练反馈轮次，显示 `executionMode=demo` | 若开关报错，刷新后再开；仍失败则直接 `/teacher` 展示本地会话 |
| 0:25-1:25 | `/training` 查看“本轮证据批注” | 正式结果来自共享规则；AI 不改分，第一轮蓝笔追问已可见 | 页面状态不合适时关闭再打开演示开关 |
| 1:25-2:05 | P4 辅导处点“请老师提示一下” | 第二轮内容来自 `recordings/demo/tutor-p4.json`；在线 provider 调用为零 | 回放缺失时只给确定性预设，不回落在线模型 |
| 2:05-2:40 | 点页头“前测”，再点“提交手绘点评” | 固定起点直达手绘页；结构化响应只允许 `comment`，不可携带分数字段 | 不现场重画，直接说明真实 PNG 红队用例并跳教师视图 |
| 2:40-3:45 | `/teacher` 的“单生证据” | 展开 P4:量表条目、学生原文、证据、误区、训练记录、脚手架轨迹、待复核 | 若当前会话为空，重新打开演示开关；也可导入 `recordings/demo/session.json` |
| 3:45-4:40 | 切换“班级汇总”，导入 `recordings/demo/class/` 三份会话 | 以学生为统计单位：同一匿名 ID 取最新会话，均值、错误率、人数和 Top N 同口径 | 文件名不会出现在错误提示中；只显示“批次文件 N” |
| 4:40-5:00 | 点页头“外显” | 展示实装 3D 知识场景：节点点亮、依赖边、节点详情与三维雷达同源 | WebGL 不可用时页面自动显示同一 scene 的节点清单 |

精确的录制 step ID、文件映射与失败边界见 `docs/README.md`（发布包内由 `recordings/demo/README.md` 复制而来）。

## 四、3 分钟答辩问答

### Q1:AI 幻觉会不会直接改学生分数？

不会。模型输出先过 schema、证据位置和事实接地校验，再由共享规则生成节点结果。证据不足进入 `needs-review`。苏格拉底辅导只读取已判定的薄弱节点，不回写正式结果。证据:`shared/scoring/`、`server/workflows/`、`tests/socratic-hardening.test.ts`、`tests/m4-red-team.test.ts`。

### Q2:为什么说证据可追溯？

每个节点保留 rubric 条目与版本、学生原文、引用区间、判分引擎、误区 ID、训练事件和辅助轮次。教师视图按同一会话对象展示，而不是重新让模型总结。证据:`src/features/teacher/TeacherPage.tsx`、`src/features/teacher/teacher-data.ts`、`tests/m4-teacher-data.test.ts`。

### Q3:断网时演示是否真的可用？

是。`demo` 模式只读取启动时完成 digest/schema 校验的录制资源，禁止调用在线 provider；缺失时使用确定性预设或待复核，不偷偷联网。证据:`recordings/demo/`、`server/app.ts`、`tests/m4-demo-mode.test.tsx`。

### Q4:班级数据如何保护隐私和避免脏数据？

界面只展示匿名编号；单次最多 24 份、每份最大 512 KiB，`Promise.allSettled` 保证单份失败不阻断其余文件。错误只显示匿名批次序号，不回显原文件名或 session ID。同一匿名 ID 只取最新会话。证据:`src/features/teacher/teacher-data.ts`、`recordings/demo/class/`、`tests/m4-teacher-page.test.tsx`。

### Q5:为什么发布包还保留外置目录？

可执行逻辑冻结在 Node SEA 中，而课程配置、prompt、资产和录制作为外置、带哈希的内容交付，便于赛前审计和替换课程内容；启动时版本和 digest 不一致会明确失败。证据:`scripts/package.mjs`、`scripts/release-manifest.mjs`、`dist/release-darwin-arm64.sha256`。

### Q6:局域网访问是否安全？

默认根本不开放局域网。显式 `--lan` 才绑定 `0.0.0.0`，每次启动生成高熵令牌，所有 UI、静态资源和 API 都先鉴权，首次验证后用 HttpOnly 严格 Cookie。它不是公网部署方案，HTTP 边界必须现场说明。证据:`server/runtime/launch-options.ts`、`tests/m4-lan-mode.test.ts`、`docs/2026-07-16-lan-security.md`。

### Q7:3D 模块在哪里？

`/model` 已实装为独立路由 chunk。`ModelPage.tsx` 从当前会话和配置生成 scene，`lighting.ts` 将同一学习者画像映射为节点点亮状态与边，`KnowledgeScene.tsx` 负责 Three.js 交互渲染；WebGL 不可用时保留同源节点清单。证据:`src/features/model/ModelPage.tsx`、`KnowledgeScene.tsx`、`lighting.ts`。

## 五、证据索引

| 主张 | 一手证据 | 自动化证据 |
| --- | --- | --- |
| 单生诊断证据链与待复核 | `src/features/teacher/TeacherPage.tsx` | `tests/m4-teacher-data.test.ts` |
| 班级雷达、分布带、错误率、误区 | `src/features/teacher/teacher-data.ts`、`ClassRadar.tsx` | `tests/m4-teacher-data.test.ts`、`tests/m4-teacher-page.test.tsx` |
| 离线演示与录制校验 | `recordings/demo/start-state.json`、`recordings/demo/class/`、`server/app.ts` | `tests/m4-demo-mode.test.tsx`、`tests/m4-runbook-e2e.test.tsx` |
| LAN 默认关闭与令牌门禁 | `server/runtime/launch-options.ts`、`server/app.ts` | `tests/m4-lan-mode.test.ts` |
| SEA 与冻结 manifest | `scripts/package.mjs`、`RELEASE.json` | `tests/m4-package-manifest.test.ts` |
| 三类红队防线 | `tests/fixtures/red-team/*.png`、`eval/cases/synthetic/red-team-variants.json`、`server/app.ts` | `tests/m4-red-team.test.ts`、`tests/eval-data.test.ts` |
| 3D 实装、知识场景与点亮裁量 | `src/features/model/ModelPage.tsx`、`KnowledgeScene.tsx`、`lighting.ts` | `tests/m4-model-lighting.test.ts`、`dist/client/assets/ModelPage-*.js` |

## 六、故障处置

| 现象 | 判断 | 现场动作 |
| --- | --- | --- |
| 双击后没有页面 | 浏览器未自动打开或启动校验失败 | 看终端首条 `[startup]`；有 URL 就手动打开，无 URL 就按错误中的文件、字段、原因恢复外置内容 |
| `4173` 无法访问 | 端口被占用后自动换端口 | 只使用终端打印的实际 URL，不强杀其他服务 |
| 页面提示配置载入失败 | 外置目录缺失、损坏或版本不一致 | 用 manifest 复核；恢复整套 `config/`、`prompts/`、`recordings/`，不要只改版本号 |
| 演示开关失败 | demo 录制与当前 schema/config digest 不一致 | 不接网络；重新部署完整发布目录。现场先走 `/teacher` 和固定证据索引 |
| 辅导没有在线回答 | 断网或 provider 不可用 | 这是可接受降级；展示预置脚手架/回放来源和 `needs-review`，不要现场填写 API key |
| LAN 设备 401 | URL 没带本次令牌、Cookie 失效或重启后令牌已轮换 | 从当前终端重新取得完整 LAN URL；不要复用上一次启动链接 |
| LAN URL 不出现 | 没有私有 IPv4 或不在同一网络 | 回到本机默认模式；不改防火墙、不绑定公网地址 |
| 发布物校验失败 | 文件被改动或漏拷贝 | 停止使用该目录，从冻结发布物整体恢复，重新跑两份 SHA-256 manifest |
| 应用需要退出 | 正常关闭本地服务 | 终端按 `Ctrl+C`，看到 `[shutdown] ... closing local server` 后再拔电源或换网络 |

## 七、10 分钟彩排清单

### 0:00-2:00 启动与环境

- [ ] 比赛 Mac 为 Apple Silicon，电源充足，系统时间正确。
- [ ] `dist/client.sha256`、`dist/release-darwin-arm64.sha256` 与代码签名校验通过。
- [ ] 默认模式启动，确认实际端口和 `127.0.0.1` 地址。
- [ ] 浏览器缩放 100%，关闭通知、自动更新和无关标签页。

### 2:00-4:00 离线与固定起点

- [ ] 关闭 Wi-Fi 后刷新页面，核心 UI、前测、训练、教师视图仍可打开。
- [ ] 打开“演示回放”，确认显示 `executionMode=demo` 并进入固定训练会话。
- [ ] 关闭再打开开关，确认原会话可恢复、演示起点可重复。

### 4:00-7:00 主路径

- [ ] 按 5 分钟脚本完整点击一次，不临场输入大段答案。
- [ ] P4 回放、手绘安全边界、单生证据链均能在各自时间窗出现。
- [ ] 批量导入三份匿名会话，班级雷达、分布带、错误率和 Top N 均有数据。
- [ ] 追加一个重复或损坏 JSON，确认提示清楚且有效数据仍保留。
- [ ] `/model` 显示 3D 节点场景；无 WebGL 时显示同源节点清单。

### 7:00-9:00 备用路径

- [ ] 手动输入 `/training`、`/teacher`、`/model` 均能刷新直达。
- [ ] 模拟 demo step 不可用时，能在 15 秒内转教师视图并用证据索引继续讲解。
- [ ] 记住实际端口；纸面备份写有三个路由和 2 分钟陈述稿。

### 9:00-10:00 收尾

- [ ] 重启一次应用，确认端口、演示开关和匿名会话处于预期初始状态。
- [ ] 若确需第二设备，单独彩排 `--lan`、令牌 URL、401 恢复和 `Ctrl+C` 关闭；否则坚持默认本机模式。
- [ ] 发布目录、manifest、HDMI/转接线和离线备份 U 盘各有一份可用副本。
- [ ] 计时器完成一次 2 分钟陈述、5 分钟点击、3 分钟答辩，总时长不超过 10 分钟。
