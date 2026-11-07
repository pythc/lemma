# 数学评审基础能力：9、10、11、1、3

本批实现对应 2026-10-21 对标清单，保留原文忠实性、原证明路线和形式目标三个判断。模型意见、开发者给定证明、原生 Lean 核验和真实自主评测不能互相替代。

## 9．共享库和不可变快照

- `server/library-access.mjs` 仍负责进程内排队；`server/file-lease.mjs` 与 `worker/library_lease.py` 使用操作系统共享/排他文件锁。锁由父进程的管道生命周期持有，没有“超时后偷锁”的分支。不要删除 `.tools/library-access.lock`。
- 安装、缓存扩展和验证使用相同锁身份。已存在的 `ensureDomainModules` 写入边界沿用新锁；`setup-analysis.mjs` 也纳入排他边界。
- `server/library-snapshot.mjs` 将已核对内容发布到 `.tools/library-snapshots/<sha256>`；APFS/COW 文件拥有不同 inode，不使用硬链接。先校验临时目录，后原子发布；失败目录保留。
- 原生检查使用快照。增加模块不会修改既有快照。归档回放指定旧身份；可以从保留的历史文件清单重建完全一致的旧内容，但不能用新缓存冒充旧环境。
- 适用边界是本机 POSIX 文件系统；本轮实际验证平台为 macOS arm64。没有宣称支持跨机器共享存储或对抗拥有宿主写权限的恶意用户。

## 10．独立回放

```sh
npm run replay:clean -- /absolute/evidence.ndjson \
  --expected-root=<外部保存的归档根> \
  --output=/absolute/全新目录
```

输出目录必须位于调用项目之外且尚不存在。入口复制运行代码、Node 依赖和已固定数学环境，创建空应用目录和空 HOME，然后在新 Node 进程中回放。不会复制 `.env.local`、原应用状态或解析模型。当前复制方式依赖 macOS APFS 的 `cp -cR`。

开始回放前，实际探测对原项目文件的读取和对本机监听端口的连接，二者均须被操作系统拒绝。模型分发另有硬性关闭开关。原生 Lean 子进程继续使用已有的更严格沙箱。

输出字段分别表达：

- `integrity`：证据图与外部根一致。
- `sameEnvironment`：原生环境和检查器身份一致。
- `reproduced`：相同环境中得到相同且稳定的结果。稳定拒绝也可以复现。
- `revalidated`：当前环境重新接受归档中的原生检查。旧检查器与新检查器不同，可能只有这一项为真。
- `originalRouteFullyVerified`：原路线的实际检查及覆盖要求满足。未完成的步骤仍保留。

自主评审父根通过 `execution-replay.mjs` 回放所有可达的原生子检查；范围明示为 `reachable_archived_native_checks_only_not_whole_paper_or_model_judgment`。空检查集合、模型意见或完成标签都不能产生整篇论文证明。

```sh
npm run accept:library-snapshots
npm run accept:clean-replay -- /absolute/新的验收目录
```

这些验收脚本使用明确标注的人工候选，验证运行基础设施，不能作为自动证明能力的统计样本。

## 11．三个数据层

`server/evaluation-protocol.mjs` 定义语义、固定正式目标、原始 PDF 三层输入。结果保留来源、划分、污染状态、真值来源、模型配置、预算、实现与协议身份。

`evaluation/sets/authored-regression` 是 13 个工程案例：9 个语义、3 个形式目标、1 份原始 PDF。它们不是独立专家标注的研究测试集。相同来源家族不跨开发集和保留集。

`evaluation/upstream/proofnet-verified/160414332dc196583f6c37c310b420d2a3b07c58` 保存上游 367 条数据、许可证和来源；导入得到 734 个分层任务。参考答案与非形式证明单独保存在 `evaluator-gold.json`，不发送给被测端。公开题的训练污染状态为未知。

**版本边界：**这版 ProofNet-Verified 标注 Lean 4.28.0，本项目是 4.35.0。已完成真实下载、固定摘要、去除占位证明、来源划分和输入隔离；尚未完成 367 个题目的本地 Lean 迁移或完整评测。`evaluate-foundations.mjs` 的固定目标执行器用于本项目 profile 格式的工程样本，不能直接将上游完整 theorem/header 当成本项目 profile。

```sh
npm run import:proofnet -- /absolute/新的导入目录
npm run evaluate:foundations -- evaluation/sets/authored-regression \
  /absolute/本机模型配置目录 /absolute/新的评测目录
node scripts/summarize-paper-evaluation.mjs \
  /absolute/原始PDF运行目录 evaluation/sets/authored-regression \
  authored/paper/analysis-fixtures /absolute/新的报告.json
```

失败、未知、超时、未运行都留在分母，费用未知时为 `null`。当前汇总明确不计算研究准确率。不同预算、数据或协议的结果不能作为同一实验混算；模型或实现变化会明确显示。

## 1．数学 PDF 来源

默认保留 PDF.js 历史文本，并增加版本化文本项、坐标变换、字体、页图和摘要。原文本不会被猜测出的数学符号替换。回放重新核对 PDF 页图与几何来源。

可选 Docling 公式解析固定到：

- Docling 2.140.0、Transformers 5.8.0，Python 3.12 依赖及哈希见 `worker/document-requirements.lock`。
- CodeFormulaV2：`ecedbe111d15c2dc60bfd4a823cbe80127b58af4`，CDLA-Permissive-2.0。
- docling-layout-heron：`8f39ad3c0b4c58e9c2d2c84a38465abf757272d8`，Apache-2.0。

安装和推理分开。安装器下载固定版本并保存文件摘要；推理禁用网络、远程代码和模型编译，使用 CPU、独立目录及墙钟预算。模型缺失、失败、取消和超时均有收据，启用后失败会成为阻断性的抽取疑点。

```sh
uv venv --python python3.12 .tools/document-venv
uv pip sync --python .tools/document-venv/bin/python --require-hashes worker/document-requirements.lock
npm run setup:document-models
# 公开模型下载不稳定时，可在独立安装阶段执行：
.tools/document-venv/bin/python scripts/download-document-weights.py
npm run setup:document-models
```

在本机 `.env.local` 设置 `LEMMA_DOCUMENT_PARSER=docling` 后，后续新命题检查会调用解析器。未设置时仅生成位置/页图证据，状态为 `not_requested`，不能声称运行过 Docling。历史归档不重新调用解析模型。

解析输出保留原始文本、公式候选、框位置和公式裁图。上划线/根号等操作符与原文本不一致、LaTeX 大括号不配对、替换字符或已请求解析未完成会进入语义未决条件，普通“确认无误”不能消除它们。规则有独立版本，历史解析按当时版本复查，并单独给出当前规则新增的疑点，不修改旧记录。

真实执行发现 CodeFormulaV2 会把某个上划线读成根号，并生成括号不配对的分式候选；因此保留为选配组件，不默认启用，也不自动替换原文。`accept-document-parser` 区分 `executionAccepted` 与 `qualityAccepted`：解析器运行成功不代表公式正确。当前冲突规则覆盖范围有限，不代表能够自动发现所有分数、矩阵或阅读顺序错误。

**图像使用边界：**页图和裁图进入证据包；当前文本模型接收公式候选、位置和图像身份，不接收图像像素。因此不能声称语义模型已经视觉核对原页。本批几何解析针对命题选中页，没有完成全文所有数学公式的逐一验收。

```sh
node scripts/accept-document-parser.mjs /absolute/paper.pdf 2 /absolute/新的解析验收目录
```

## 3．两阶段语义复核

第一阶段 `R04B` 只接收固定原文、Lean 目标及必要数学定义。翻译者说明、假设解释、对照理由和修复反馈不进入首次输入。输入摘要、实际 HTTP 请求和返回值一起归档。

第二阶段再提供翻译对照及已封存的盲审结果。两阶段有分歧时，疑点继续保留；后一次“同意”不能覆盖前一次 concern。回放重建盲审输入与合并结果，防止收据删除疑点。

独立接口可使用 `.env.example` 中的 `LEMMA_SEMANTIC_MODEL*` 字段；未配置时明确采用同模型的独立请求。部分配置会报错，不静默退回主模型。家族名称只是操作者声明，不能凭不同模型名称宣称跨家族独立性。

本轮按用户决定只完成同模型机制和评测；第二家族对照明确为**未验收**。

## 验证与回退

```sh
npm test
npm run test:replay
LEMMA_TEST_EVIDENCE_DIR=/absolute/新目录 npm run test:mainflow
npm run build
npm run test:sites
```

使用 `.nvmrc` 对应的 Node 24；当前共享 Node 依赖中的原生 SQLite 模块不能直接由本机默认 Node 26 加载。不要在指向原项目的 `node_modules` 符号链接上执行依赖升级。

每次验收使用新目录。隔离实施副本 `workspaces/math-review-foundations-20261021/evidence/foundations-20261021` 保留本批成功、失败和同步备份；原项目中新增的真实运行在 `evidence/foundations-integrated-20261021`。各次独立回放还在项目外保存独立目录。完整索引见竞赛目录下的 `docs/math-review-research-20261021/五项改进验证记录.md`。旧证据的检查器身份不会被新版本改写。

回退应恢复本次变更清单中对应的代码版本，保留新增证据、失败日志及数学库快照。不要删除锁文件、改写旧归档，或将不同版本的库清单和缓存拼接使用。
