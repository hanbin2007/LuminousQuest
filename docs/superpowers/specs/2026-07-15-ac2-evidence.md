# AC2 配置热加载实测证据

## 结论

AC2 通过。前三个训练案例、训练 UI、冷迁移、脚手架、辅导与回归测试完成后，先在提交
`a477b0625b43895b79e12b66858f4dd8b22b9869` 构建并冻结客户端产物；冻结后没有修改代码、
测试或构建产物，只新增 `config/cases/methane-fuel.json`，并把一条量表默认值
`rubrics.policy.weakness.threshold` 从 `0.6` 改为 `0.61`。

同一 Hono 应用实例在不重启、不重建的情况下，通过下一次 `/api/config` 请求发现新案例和新
配置摘要。训练 UI 从前三个案例进入固定三级的甲烷冷迁移案例，完成后生成共同节点归一化的
前后雷达对比。甲烷案例为 `caseType: transfer`、`medium: acidic`，与签收素材图一致。

## 冻结点

- 时间：`2026-07-15 23:16:53 EDT`（`2026-07-16T03:16:53Z`）
- 分支：`codex/m3-training`
- 冻结提交：`a477b0625b43895b79e12b66858f4dd8b22b9869`
- 配置专用提交：`7e9fd74`（仅新增案例 JSON 与修改一条量表默认值）
- 冻结前工作树：干净，且与 `origin/codex/m3-training` 同步
- 冻结前完整测试：`37` 个测试文件、`378/378` 测试通过
- 冻结命令：`pnpm build`
- 构建结果：Vite `2505` 个模块构建成功，随后 `tsc --noEmit` 通过
- 冻结产物：`dist/client`
- 产物清单聚合 SHA-256：`4a108a4fa42203da3d4f76f0d2daa8a55a332067ea2c09d7c254bc63dbf44eeb`

聚合值由以下确定性清单生成：

```sh
shasum -a 256 dist/client/index.html dist/client/assets/* | shasum -a 256
```

## 冻结后操作

严格按以下顺序操作，期间没有执行 `pnpm build`、`vite build` 或字体子集重建：

```text
1. A  config/cases/methane-fuel.json
2. M  config/rubrics.json
3. pnpm typecheck
4. pnpm exec vitest run <AC2 与配置/流程聚焦测试>
5. pnpm test
6. 对 dist/client 重新计算 SHA-256 清单并与冻结值逐项比较
```

新增案例文件 SHA-256：

```text
483b3ecb760e8ddda5dd5d199e2ed9cc3ce1b667821d9f1f598789c6dacb99d9  config/cases/methane-fuel.json
```

## Git Diff 记录

冻结后、写入本证据文件前的 `git status --short --branch`：

```text
## codex/m3-training...origin/codex/m3-training
 M config/rubrics.json
?? config/cases/methane-fuel.json
```

新增文件统计：

```text
/dev/null => config/cases/methane-fuel.json | 189 ++++++++++++++++++++++++++++
1 file changed, 189 insertions(+)
```

量表默认值的完整 diff：

```diff
diff --git a/config/rubrics.json b/config/rubrics.json
index 4d5042b..71c37e1 100644
--- a/config/rubrics.json
+++ b/config/rubrics.json
@@ -53,7 +53,7 @@
       }
     },
     "weakness": {
-      "threshold": 0.6,
+      "threshold": 0.61,
       "partialVisualization": "half-lit"
     },
     "repeatedAnswers": {
```

新案例关键配置：

```json
{
  "id": "methane-fuel",
  "sequence": 4,
  "caseType": "transfer",
  "medium": "acidic",
  "materialRef": "assets/cases/methane-fuel/schematic.png",
  "tutoring": []
}
```

## 热加载与全流程证据

自动化用例 `tests/m3-ac2-hotload.test.tsx` 在一个未重启的 Hono 应用实例上执行：

1. 首次 `/api/config` 仅返回基线案例与阈值 `0.6`。
2. 测试运行中新增甲烷 transfer JSON，并把阈值改为 `0.61`。
3. 对同一应用实例再次请求 `/api/config`，断言配置摘要改变、甲烷案例为酸性、素材路径正确、
   `tutoring` 为空。
4. 不重建前端，挂载既有 `App`，完成训练案例后进入固定三级冷迁移作答。
5. 断言冷迁移没有苏格拉底入口，提交后显示“训练前后对比”与缺测语义。

对当前真实配置的应用内请求结果：

```json
{
  "status": 200,
  "configVersion": "sha256:1a9839512c4c46ba93b96fdff2558b9b99c2203d3f75c36b9e72c98d12a0830f",
  "caseIds": ["zinc-copper", "aluminum-air", "hydrogen-oxygen", "methane-fuel"],
  "methane": {
    "sequence": 4,
    "caseType": "transfer",
    "medium": "acidic",
    "materialRef": "assets/cases/methane-fuel/schematic.png",
    "tutoring": []
  },
  "weaknessThreshold": 0.61,
  "assetStatus": 200,
  "assetType": "image/png"
}
```

## 验证结果

- 配置、方程式、真实 transfer UI、AC2 热加载、字体冻结契约聚焦测试：`105/105` 通过
- 完整测试：`37` 个测试文件、`378/378` 通过
- 类型检查：`pnpm typecheck` 通过
- 冻结后 `dist/client` 清单逐项比较：`MATCH`
- 冻结后产物清单聚合 SHA-256：仍为
  `4a108a4fa42203da3d4f76f0d2daa8a55a332067ea2c09d7c254bc63dbf44eeb`

因此，本次 AC2 验证没有借助重新编译吸收新增案例；案例发现、素材读取、固定三级冷迁移约束、
作答与前后对比均由冻结代码对外部配置的热加载完成。
