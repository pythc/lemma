# Lemma · 数学论文评审工作台

当前数学评审入口是 `team-v1`：协调、任务和独立验收三种身份，使用本地 Codex CLI（gpt-6-sol / high）。Agent 自主选择拆分、工具与证明路线，精确命题核验、独立验收和整篇结论分别保留。

本仓库包含项目代码、测试和静态资源；运行档案、论文历史、模型/数学库缓存及本机密钥保留在本地。Node 版本按 `.nvmrc` 与 `package.json` 配置；原生环境需要单独安装。

以下保留历史实现与验证记录。

2026-10-20：通用闭环修复增加完整命题范围选择与独立复核、前置工具执行、失败状态去重、实际有限计算及取消归档。调研、冻结输入与验证记录保存在 `evidence/generic-remediation-20261020/`；真实论文结果与机制测试分别报告，不据此宣称一般数学证明成功率。
本轮通用能力改造：新 Agent 会话隔离历史开发证明，支持库源码查阅、即时导入、条件引理项目、失败修复、同会话中间候选恢复及独立 Lean 回放。方法约束另由 Agent 对照原文审查；格式失败不会抹去已经收到的内核检查。实现和两篇真实论文的结果分别见 [技术说明](docs/自主原证明构造与干净复测.md) 与 [复测报告](docs/自主Lean复测结果-20261020.md)，不能把局部通过当作整篇论文通过。

2026-10-20：新模型评审使用独立证明会话。原证明规划可调用真实库声明检索和条件接口检查；证明工作器可递归拆引理、逐条构造、修复失败，并在全部闭合后重新编译根证明。历史开发者证明不进入新会话。运行 `npm run evaluate:autonomous-paper -- paper.pdf new-output-directory '核查范围'` 从原始 PDF 做隔离复测；旧的 `retest:workspace` 等脚本是历史辅助实验，不是自主能力验收。实现与实际结果见 `docs/自主原证明构造与干净复测.md`。

2026-10-19：自主评审由 Agent 独立复核翻译并决定证明、反例或修复，不再等待人工语义确认。引用位置采用可追溯的确定性修复；相同失败和文献请求不重复空转。AI 决策与 Lean 机器核验分开记录。见 `docs/引用定位与自主核验修复-20261019.md`。

当前界面增量 D10-007 / D10-008：连续滚动阅读，页码、目录和搜索用于定位；确认后批注直接显示在原文旁，结果与进度侧栏可收起。删除统计、全调度日志和重复开发文案。阅读失败不再误报为零命题完成。详见 `docs/数学论文评审-用户界面精简与连续阅读-20261018.md`。以下版本记录保留。

当前版本 **0.10.0**：直接开始评审，全文扫描后按命题自动选择形式化环境。独立 LangGraph worker、全入口模型资源池、单进程 Lean 配额、局部诊断恢复、任务与尝试分离、外部文献来源保存、独立复核与覆盖记录均已接入。真实模型和受控测试分开记录，见 `REVIEW-0.10.md`。

历史版本 0.9.0：新上传论文通过 LangGraph.js 读取全文并根据产物决定下一步；右侧显示真实任务路径，每个节点可展开原文与证据。暂停/恢复和失败重试保留检查点。单命题 Lean 核验仍保留人工语义确认。见 `REVIEW-0.9.md` 与 `docs/数学论文评审-0.9自主评审路径.md`。

项目文档空间：https://knowledge.110-lab.cn/s/mathematics-paper-review-bot

0.8.1 历史补丁：修复 Node 文件监控通知被误判为 PDF 解析结果、导致 R02 立即受阻的问题；补齐空错误原因。详见 `REVIEW-0.8.1.md`。

0.8.0：首次进入仅上传论文；导入后阅读器右侧显示评审进度。完成后点击“确定，查看结果”，再通过“评审结论 / 批注”切换。批注独立排列在对应文字旁，展开详情、证据与问答；覆盖信息收进结论详情。见 `REVIEW-0.8.md`、`docs/数学论文评审-0.8上传阅读与结果确认.md`。下列版本记录保留。

0.7.0：阅读器默认以简述显示批注，点击后展开协作与证据；支持人工评论、选区 AI 小窗口、多轮追问和局部论证。新文件导入后进入真实任务工作流。实现与边界见 `REVIEW-0.7.md` 和 `docs/数学论文评审-0.7阅读批注与工作流.md`。问答需要现有本机模型配置，解释不等于证明；本轮使用隔离受控模型验收界面，真实网关恢复继续联调。

`npm run test:reader` 运行问答与存储回归。`node scripts/reader-ui-fixture.mjs` 在 4180/4181 启动受控界面验收，不调用真实模型，不是正式运行方式。人工批注及评论在浏览器，问答和评审记录在本机 API，请分别备份。

0.5.0：增加跨页上下文与补充材料、六类翻译对照、独立模型复核、真实类型检查、数学库检索和有预算的证明修复。实分析、基础线性映射、数论/有限集合计数各有窄范围配置与样例。模型仍为本机 GPT-6 Thinking / high；实际调用、失败记录及边界见 `REVIEW-0.5.md`。

## 本机运行

2026-10-18 增量：已接入 LeanInteract 0.11.6、LeanCopilot/Aesop 的交互搜索与可选本地 Goedel-Prover-V2-8B。搜索结果必须交给原有干净 Lean 检查器重放；原文语义由独立 Agent 复核，结果展示另由用户确认。实现与评测记录见 `docs/Lean证明器接入与模型切换-20261018.md`。安装成功不代表真实论文证明成功率已经提升。

使用 Node.js >=24.15.0 且 <25；本机版本参考 `.nvmrc`。

```sh
npm ci
npm run setup:lean
npm run setup:analysis
npm run setup:prover
# 可选：下载并校验约 16 GB 的固定 BF16 证明模型
npm run setup:specialist
npm run dev
```

页面 http://127.0.0.1:4178/ ，API 仅监听 127.0.0.1:4179。当前 Lean 安装和隔离方案针对 macOS arm64。

证明搜索默认启用。需要对照或回退时，使用 `LEMMA_PROVER_SEARCH=0 npm run dev`，只改变新任务的证明路由，不删除历史证据。`npm run test:prover` 检查真实 Lean 会话、回退、恢复、占位拒绝与独立重放。当前证明预算独立于阅读配置：每条目标最多 12 小时、128 个候选、256 次证明调用、2048 次策略调用，累计输入 5000 万字符、单次输入 100 万字符、单次输出最多 393216 tokens；本地专用模型每次最多 30 分钟，并按原生 40960-token 上下文扣除实际输入后限制输出。单次远端请求默认等待 2 小时。默认值统一维护于 `server/runtime-limits.mjs`，本机模型设置见 `.env.local`，实际生效值可从 `/api/status` 的 `runtimeLimits` 读回。时间、调用、输入及输出预算任一先到即停止。RSS 采样保护不是操作系统硬内存配额。

本机已按用户要求改为 DeepSeek 官方兼容接口 `https://api.deepseek.com/v1`、`deepseek-flash`、`high`；真实调用已经验证。密钥仅保存在被 Git 忽略的 `.env.local`（权限 0600），文档及证据不包含密钥。新旧实验使用相同模型；历史 Pro 用量限制记录保持不变。

模型配置：复制 `.env.example` 为本机 `.env.local`，填写兼容 Chat Completions 的接口基础地址（含 `/v1` 等版本路径）、模型名和密钥。`LEMMA_MODEL_REASONING_EFFORT` 可设 low、medium、high；`LEMMA_MODEL_TIMEOUT_MS` 范围 1000–14400000 毫秒，默认 7200000；`LEMMA_MODEL_MAX_OUTPUT_TOKENS` 范围 1–393216；`LEMMA_MODEL_MAX_RESPONSE_BYTES` 范围 32768–33554432 字节，默认 33554432。本机读回为 2 小时请求超时、393216 输出上限、32 MiB 响应体和模型并发 1。客户端上限不代表服务商一定生成相应长度；实际请求与结束原因单独存证。配置文件已忽略，密钥不进入评审产物。

## 使用路径

1. 首次进入上传 PDF，或从次要论文库入口打开已有论文。新文件自动启动自主全文评审，选区论证保留严格单命题入口。
2. 阅读器右侧查看实际进度；“发起新的评审”直接读取全文并自动选库；选中原文仍可发起局部论证。
3. Agent 独立核对原 PDF 与六类翻译对照，记录歧义处理理由并自行选择证明、反例、补库或修复。用户可查看过程和依据，无需逐条签名。人工目标入口保留独立使用。
4. 完成后点击“确定，查看结果”；结论显示在侧栏，批注显示在原文旁，可分别展开、收起。每个原证明步骤及整条证明的连接均可查看依据，完整证据可导出重放。
5. 导出包含原 PDF 的复现包，在界面重放或运行：

```sh
npm run replay -- evidence.json --expected-root=<导出报告根摘要>
```

复现重新执行归档证明，记录编译器、库文件和执行器身份。模型输入输出按原样归档，后续不会重新请求模型来替代复现。

## 实现范围

- PDF.js 原排版阅读、文本层、页码/缩放/搜索、选区批注、页内定位。
- IndexedDB 保存论文和人工批注；PDF 字节摘要隔离版本。API 磁盘保存评审和内容寻址产物。
- R02/R03/R05/R09/R10 的真实产物交接；模型路径另含 R06 候选原证明审计。手工路径标明人工来源。R12 报告由规则计算。
- 合同 v3 同时固定上下文与翻译产物；复核与类型检查单独归档，兼容 v1/v2 证据。库、模块、公理、完整 term 检查、预算和沙箱保留；证明、反驳、未知分离。
- 导出完整证据依赖图、原始 PDF、固定目标、确认与工具输出；新目录重放、篡改拒绝、近期历史恢复。
- 人工登记范围、主目标及命题/步骤/条件/定义/引用义务；不可变修订、传递依赖过期、冲突与循环阻断，排除项不从登记总数消失。
- 论文级包保留全部修订和关联运行，PDF 字节仅存一份；逐项重放并重算账本，未知和未完成项继续保留。

| 路径 | 职责 |
| --- | --- |
| src/App.jsx、PdfReader.jsx | 阅读、批注和原文定位 |
| src/PaperLedgerPanel.jsx | 范围、义务、依赖、修订及续审关联 |
| src/ReviewPanel.jsx | 结论、确认、实际任务、导出与重放 |
| src/domain.js、storage.js | 原文身份、锚点和浏览器事务 |
| server/paper-ledger.mjs、ledger-model.mjs | 范围版本、证据关联与论文级重放 |
| server/pipeline.mjs | 任务编排、确认屏障、报告与重放 |
| server/contracts.mjs、evidence.mjs | 固定目标、判定规则和产物图 |
| server/lean.mjs、libraries.mjs、toolchain-tree.mjs | 真实检查、隔离和库内容身份 |
| shared/library-profiles.mjs | 前后端共用的库白名单与支持范围 |
| server/model.mjs、pdf*.mjs、index.mjs | 模型接口、PDF 解析和本机 API |
| tests/、evidence/ | 自动测试、review 后用户模拟和可复现证据 |

## 范围与义务

范围账本保留在后端和历史核验详情中，不再作为阅读器的顶层标签。旧版账本可继续读取：写明主目标与排除项，再登记实际评审或尚未完成的定义、条件和引用。登记只是人工范围记录，不代表 Agent 已完整提取论文。

在条目中设置依赖、定位原文和查看核验依据。内容或依赖改变后，旧关联保留并过期；可以为该义务继续建立目标，核验后关联回原条目。不能直接输入“已验证”。原证明步骤的独立证明不能替代原证明组合检查。

导出“范围复现包”，使用同一 replay 命令可识别论文级格式、重新解析 PDF、逐项重跑全部关联证据并重算报告。空账本只检查结构，不称机器结果已复现。新 PDF 字节版本建立独立账本，不自动搬运语义结论。

本机预算为 512 条目、512 个独立运行、1024 修订、20000 个归档产物及 200 MB 重放文件。超限和归档失败保留上次修订。原 PDF 最多 500 页/25 MB，全文文本最多百万字符；空文本页明确保留，不静默跳过。

## 检查与边界

`npm run test:all`（需要固定工具链与声明的数学库）；`npm run test:sites`；`npm run build`。测试中的 HTTP 模型 fixture 只检验协议与调度，模型质量须另做真实评测。`npm run evaluate:capabilities` 运行 31 条参考证明样例与 7 条结构规则样例，记录源码摘要和全部结果，不作为研究论文准确率。

当前核验选定命题及其原证明推导图，也可使用人工登记的义务范围；账本和推导图均不保证全篇无遗漏。实分析首批是原创正例、缺少紧致域限制的故障变体和无效证明，范围不代表整个实分析或研究论文级验收。独立重证与原证明有效性分别记录；人工确认只是一条语义审阅记录。自然数三样本是执行基础设施测试。选定原证明已接入逐步机器核验；全篇无遗漏的对象/义务抽取与证明认证、完整引用/修订影响、LaTeX/附录和 PDF 批注导出仍待完成。线性代数、数论/组合仍按后续阶段建设。数学库运行期只读并检查完整内容指纹；修复使用官方缓存强制重新取得，不直接给变化的本地文件重新背书。显式刷新可运行 `npm run setup:analysis -- --refresh`。

浏览器批注导出不含 PDF；API 复现包含原 PDF。浏览器数据与 `.runtime` 各自保存，应分别备份。清除任一存储会失去相应本机记录。源码快照不含 `.tools`、`.runtime`、`.env.local`、node_modules 或构建输出。

普通系统文件选择导入、实际评审/下载/重放，以及同名 PDF 的字节版本隔离已实测；复杂/扫描/加密/长论文和语义修订影响分析仍需验收。

详见 [本轮 review](REVIEW-0.4.md)、[用户模拟](evidence/m3-user-simulation.md)、[设计 QA](docs/数学论文评审-0.4设计QA.md) 及知识库。当前提供本机运行方式；代码纳入独立 Git 仓库，尚未线上部署。


## 0.5 capability implementation

See [0.5 implementation and acceptance](docs/数学论文评审-0.5能力实现与验收.md) and [review](REVIEW-0.5.md).

The prior paragraph describes the 0.4 baseline. Version 0.5 accepts supplemental LaTeX/plain text without compiling it, and adds narrow linear-map and number/counting profiles. Full research-paper evaluation, external-reference resolution, OCR, and original-proof composition remain pending.

Context: at most 120 pages / 750000 characters, plus 16 supplements / 250000 characters. Proof repair/search: at most 128 candidates, 12 hours, 256 proof calls, 100663296 reserved completion tokens and 50000000 aggregate input characters; each request is capped at 1000000 characters. Translation and original-proof audit run outside this proof budget. Reserved tokens are request limits, not measured billing.

## 0.6：领域补全

在已有任务的评审面板打开“补全领域知识”。自动入口使用当前 OpenAI 兼容模型规划检索、模块、定义和辅助引理；“高级：提供模块、定义与引理方案”接受结构化方案，不调用模型。

补全请求创建新任务，旧任务及其确认不会被覆盖。固定目标与原文保持不变；新增定义必须重新确认语义，辅助引理必须经 Lean 检查后才能被依赖。模块限定在固定 mathlib 版本内，缺失缓存从官方工具获取并记录追加前后的内容身份。整个过程可以取消、查看逐项证据、导出和复现。

人工方案格式（定义的 anchors 必须对应当前论文或已上传的补充原文，不能照抄示例）：

```json
{
  "queries": ["ConvexOn"],
  "modules": ["Mathlib.Analysis.Convex.Function"],
  "definitions": [],
  "lemmas": []
}
```

定义条目包含 `name/type/value/meaning/anchors/dependsOn`；引理条目包含 `name/target/proof/purpose/dependsOn`。声明通过 `LemmaPaper.Name` 引用。当前任务尚无目标时，方案还需提供 `proposal`，与人工提交目标的字段一致。

- `npm run test:domain`：真实 Lean 的定义、依赖、错误拦截、修复与复现检查。
- `node scripts/verify-domain-cache.mjs`：实际获取凸函数和区间绝对连续性模块，并查询其定义；会下载官方缓存，不调用模型。
- 缓存下载使用有限连接数与超时；官方 CDN 受阻时尝试该固定版本自带的官方 Azure 备用路径，仍不更改源码版本。已有编译文件变动会停止并保留审计目录。

完整范围与验收：[领域补全技术方案](https://knowledge.110-lab.cn/p/IAnwl5SGgX)。源码自审见 `REVIEW-0.6.md`。这不是任意论文或整篇论文已获得完整核验的承诺。

### 2026-10-17 真实论文复测

已重新运行 Aktan–Vural 与 Yang–Zhu 两篇论文的主要命题；目前均在模型翻译/补全阶段受阻，没有进入这两篇的 Lean 证明。修复了领域检索结果被前序关键词占满及补全职责提示不清的问题；真实复杂请求仍返回空正文 403，8,000 → 65,536 输出额度对照未改变结果。详情与证据见[复测报告](https://knowledge.110-lab.cn/p/P4okoCmEgN)。

## 0.10 并发与恢复

`LEMMA_MODEL_CONCURRENCY` 范围 1–4，默认 1。历史 Pro 曾验证双并发；当前 DeepSeek 配置为 1，未据此提高新服务商的并发。Lean 单进程、文献网络获取最多 2 个并发。模型配置和私密密钥只留在 `.env.local`。

同一任务最多六次自动修复；正式核查动作最多 512 个、协调决策最多 512 次、模型调用总预算 4096 次、单轮调度窗口 48 小时（在安排下一步时检查；已发出的调用另受单请求超时约束）。达到预算保留未解决义务；外部结果未知不自动重发。Agent 的语义决策限定对应形式化目标，独立分支仍继续；该决策与最终查看结果是两个不同操作。

`npm run test:adaptive` 包含并行、局部恢复、未知请求、重启以及 HTTP 到真实 Lean 的回归。隔离页面验收可用 `LEMMA_ACCEPTANCE_FRONTEND=1 node scripts/adaptive-ui-acceptance.mjs`，端口 4182/4183，数据在 `.runtime-acceptance`，始终显示预设模型标识。

### 沿原文检查证明

新模型评审会提取作者的推导图，独立复核各步含义，再执行局部 Lean 检查、实际常量依赖审计与整条连接。原文步骤、AI 补全、局部反例、替代证明与未完成义务分别保存；局部检查通过不代表整条原证明通过。自然语言到 Lean 的对应仍由 Agent 判断。

已有固定目标可调用 `POST /api/original-proofs`，请求体为 `{ "reviewRunId": "已有命题任务 ID" }`。通过 `GET /api/original-proofs/:id` 读取进度，`GET .../bundle` 导出，`POST .../replay` 独立重查，`POST .../cancel` 取消。接续发送原 `reviewRunId` 与 `continuedFrom`，保留旧记录并复用可复用检查点；结果未知的请求不会在服务重启时自动重发。

`npm run test:original-proof` 执行受控模型配合真实 Lean 的验证，不是论文通过率评测。原证明包可使用 `npm run replay -- evidence.json --expected-root=<root>` 重查；重放区分实际重查数、未核验步骤与整条路线状态。

设计、双论文复测与验收记录：[原证明逐步核验](https://knowledge.110-lab.cn/p/Wl9fUkr3Ww)。

固定候选复核可向 `/api/original-proofs` 提交 `{reviewRunId, continuedFrom, verificationOnly:true}`；需要已有的图和语义记录。它重新执行 Lean，仅复核已收到的证明，不生成新的证明。局部路线评估、连接评估与相应范围指纹纳入不可变证据链。诊断出翻译遗漏时，新图版本修正表达，旧目标与失败记录保留。


### 当前语义策略与大证据归档

前文明确标注历史版本的人工确认与 Pro 并发记录属于历史配置。当前使用 Agent 独立语义决策，不要求人工签字；本机模型为官方 `deepseek-flash`、`high`、模型并发 1。结果确认按钮只控制结论与批注的展示。

源文是否被忠实翻译，与该推理是否成立分开记录。即使作者的命题可能错误，只要翻译相符，也交给 Lean 尝试证明或精确否定；数学疑点本身不会成为跳过核验的理由。

阅读器现在导出 NDJSON：首行是 `lemma.evidence-stream.v1` 和根哈希，其后每行是一个完整的不可变产物。`GET .../bundle?format=ndjson` 返回流式文件；不带参数仍兼容原 JSON。根哈希与产物哈希不变，未裁剪失败记录或证明。CLI 同时接受旧 JSON 与新 NDJSON。

```sh
npm run replay -- evidence.ndjson --expected-root=<root>
# 本机的大型历史包可给 CLI 更大的堆空间：
node --max-old-space-size=8192 scripts/replay.mjs evidence.ndjson --expected-root=<root>
```

流式包总读取上限 2 GiB，单条产物上限 200 MiB。它避免把整包拼成一个字符串；重放仍会保存证据集合，并非恒定内存或无限容量。导出先写临时文件再原子替换，失败保留旧文件；HTTP 下载中断不被记为已完成。

图中明确陈述或省略推导的步骤若缺少形式目标，自动交给独立的目标恢复 Agent。它只能补空白目标，随后重新做原文一致性复核；未取得陈述的引用保持未核验。历史目标只是带来源的候选提示，不是语义背书。接续收集历史候选改为逐产物读取，避免复制整包历史。

诊断性接续支持 `{reviewRunId,continuedFrom,goalRecoveryOnly:true,replayUnknown:false}`：仅补缺失目标并重新核验已收到的局部证明，不生成新的局部证明；必要时仍可补连接证明。它与 `verificationOnly:true` 互斥，后者连图和目标也固定。正常新评审自动进行目标恢复，无须用户选择此模式。

2026-10-19：按用户要求暂缓知识库同步，最终增量与复测证据先保存在本项目及上级 `docs/`、`artifacts/`。此前的知识库链接为历史记录，不代表本轮已同步。

局部证明和条件连接已通过 Lean，但独立评估认为偏离作者路线时，系统仍尝试将已有局部事实闭合成原始精确命题，并单独保存 `independentTheorem` 证书。它不改变原路线的未通过判断。证书在接续和重放中重新核验；正常评审若已有完全相同目标与环境的证书，只做 Lean 复查，不再请求新的证明。新增模块或变更目标的证书不会跳过原有目标身份检查。

原证明子评审会取父任务同一目标的已有证明重新核验；新组合脚本失败时继续检查其他已收到候选，保留每次检查产物。独立命题证书不能把作者路线的部分通过升级为整条通过。最终本地实现与验收记录见 [增量文档](docs/原证明逐步核验-实现与复测-20261019.md)。

同一源文、同一精确命题已有其他库环境的证明时，可以仅复用其证明文本和固定版本模块，重新交给 Lean；当前定义、引理和允许公理保持不变，不导入旧环境的定义/辅助引理。新模块环境单列目标哈希，不复制旧的通过状态，也不升级作者路线。

### 自主构造与可追溯接续 · 2026-10-20

新论文评审使用独立 Agent 证明会话：从 PDF 出发，自行定义目标、检查语义、拆分作者路线、递归构造引理并根据 Lean 报错修复。新会话拒绝开发者证明种子和其他会话的证明图、候选及证书。`plan_lemmas` 的条件连接通过后，各引理仍须实际证明；`assemble_lemmas` 重新检查完整父命题。失败经验和候选缓存按精确目标、环境与会话隔离。

长工具对话采用公共历史摘要，精确 `Task.json`、`current-contract.json`、`Goal.lean` 与原始收据继续保存。摘要调用计入共同预算，不保存或公开模型私有推理。切换环境同步更新工作区与证书；命令工具只使用已核验库的编译路径，离线执行且不产生证明证书。完整收到的最终 JSON 仅在多出末尾右花括号时做可审计的外框规范化；工具参数与截断结果不做该恢复。

通用测试入口不接收数学答案：

```sh
npm run evaluate:autonomous-paper -- paper.pdf NEW-output-directory '自然语言核查范围'
npm run fork:autonomous-source -- source-store source-report-root NEW-checkpoint-directory owner-review-id
npm run continue:autonomous-source -- checkpoint-store previous-run-id NEW-output-directory
npm run continue:autonomous-source -- checkpoint-store previous-run-id NEW-output-directory --verify-only
```

续跑须使用独占且已终止的存储，未完成的存储会在恢复逻辑运行前被拒绝。分叉只复制同会话的原始证据，不改命题、证明图或证明内容。`--verify-only` 重新运行 Lean，不发模型请求；普通接续保留未知请求且不自动重发。版本化接续另计预算，不能称为新的空库盲测。

设计与真实结果见上级 `docs/自主原证明构造与干净复测.md`、`docs/自主Lean复测结果-20261020.md`。历史 `retest-*-yang` 等辅助脚本不作为自主能力验收入口。`npm run test:autonomy-native` 验证真实 SDK、引理闭合、环境、上下文和失败修复机制，脚本化测试不代表论文成功率。

`read_library_source` 默认使用 `repo: "mathlib"`，从本地固定 Git 提交分页读取 Mathlib；无需先联网检查仓库。`startLine` 默认 1、`lineCount` 默认 160，返回全文及窗口哈希、行号和 `nextLine`。窗口不表示对应模块已导入或引理已证明。外部仓库仍须先固定提交，下载限制为 1 MB，并验证 UTF-8；其他封装环境不借用默认版本的 Mathlib 源码身份。全文与独立证明服务生成的两种接口收据均可原样接续，任意其他类型仍拒绝。

工作区同时接受 `/Scratch.lean` 和当前工作区的真实路径，文件工具与命令行可读写同一个探针文件；其他宿主路径仍被隔离。`prepare_goal` 编译 `Goal.lean` 为探针可导入的目标签名，不是目标证明；`add_mathlib_modules` 准备固定 Mathlib 模块并建立新的环境合同，保持命题、定义、已有引理和来源不变。切换环境／导入后重新准备 Goal，旧编译缓存失效。任务、目标和编译 Goal 文件不能由文件工具或普通命令改写。探针与签名准备共享 Lean 执行资源；正式证明仍交给 `check_lean`，不能依赖临时 Goal／Scratch 模块。

## 来源与语义审计（第二批）

新的模型评审先封存盲审，再对照翻译理由。盲审记录定义的原文锚点、作用域和使用关系、量词依赖、六类边界条件，以及原命题是否被忠实保留。来源疑点不能通过填写一段确认理由消除。修正建议另有身份；采用时必须建立新目标，不能继承原目标的证明。独立 Lean 诊断只核验诊断目标，不替代原文忠实性或原命题证书。

只有已完整收到、结束原因明确为 `stop` 的结构错误才允许一次重新请求；输入固定，保留第一次响应、收据和疑点，两次均计入模型预算。截断、取消或未知传输结果不自动重放。本机全局模型配置可能覆盖请求的默认输出量，真实评测会另设并记录明确上限。

```sh
npm run test:semantics
npm run accept:semantic-native -- NEW-output-directory
npm run accept:release -- NEW-output-directory
npm run evaluate:semantics -- CONFIG_ROOT NEW-output-directory FIRST_BATCH_CALL_DIRECTORY ARCHIVED_PROMPT_SOURCE
npm run evaluate:semantic-budget -- CONFIG_ROOT COMPLETED_4000_OUTPUT NEW-output-directory
```

`accept:release` 包含完整回归、真实 HTTP/SDK/Lean 主链、原生回放、构建、Sites 和新目录断网回放；它只验收工程链路。真实模型质量、解析质量和第二模型家族单列，不能从此命令通过推断完成。所有验收输出目录必须新建。

BEq+ 复用固定版本 LeanInteract 的 MIT 源码，仅在隔离评价器中执行；其辅助 `sorry` 不得进入产品证书。当前本机实测存在战术兼容限制和不同真命题匹配的情况，不能用它认证自然语言同义。MinerU 本轮只做固定版本依赖解析，未安装或验收解析质量。Docling 实测保留公式错误和隐藏文字限制，公式规则 v3 仍支持 v1/v2 证据回放。

实施方案、失败记录和实际验收结论见上级 `docs/math-review-research-20261021/第二批实施方案与验收标准.md` 与 `第二批验证记录.md`。第二模型家族继续未验收。
