# 0.4.1 · 本机 High 模型接入 review

2026-10-17。用户指定本机 Chat2API 说明及 high 强度。本次配置和协议适配已完成，研究论文质量评测仍待开展。

## 变更与自审

- `.env.local` 保存本机地址、模型名、密钥、high 和 300000 ms 超时；文件权限 0600，Git 忽略。公开示例不含实际地址或密钥。
- 适配器显式发送 `reasoning_effort`；仅允许 low/medium/high。超时须为 1000–300000 ms 整数；未配置时保持原有 60000 ms。
- 归档请求强度与实际返回的模型、思考强度，缺少实际模型元数据时记录 null，不用请求值冒充。
- 实测本机服务返回 `<escape>JSON</escape>`。仅移除完整外层标签后执行 JSON.parse，保留原始响应和包装标识。混入额外文字、嵌套标签、截断、多个 JSON、数组、null 或字符串均拒绝。没有自动修复 JSON 或改写数学目标。
- 鉴权头不进入产物；源码归档逐文件检查不含当前本机密钥。页面只读模型名与请求强度。
- 检查了默认兼容性、原有取消信号与超时组合、响应预算、失败不提升结论和旧证据重放。模型输出仍是候选，Lean 判定规则和原证明边界未放宽。

## 执行证据

30 项基础/服务/账本检查加 2 项协议与真实 Lean 重放检查通过，日志 `evidence/high-final-tests.tap`；4 项模板检查与构建通过。HTTP fixture 的三次请求均检查显式 high、返回 extended 的归档及重放不再调用模型；fixture 不计真实模型质量。

随后进行真实浏览器模拟：选择原创实分析 A1 → 评审当前页 → 对照原文与量词确认固定目标 → R06 审计候选 → R09 模型构造 → R10 Lean 检查 → 原文定位 → 实际下载 → 页面重放 → 独立 CLI 重放。确认操作由助手按已知参考完成，不是独立研究者或经过身份认证的人工评审。

真实运行 `66e6fd24-f9ea-430b-942c-d2d95d907be8`。R03/R06/R09 均请求 gpt-6-thinking/high，服务元数据均返回 gpt-6-thinking/extended；三份原始响应均保留。固定目标：

```lean
∀ (a b : ℝ) (f : Set.Icc a b → ℝ), Continuous f → UniformContinuous f
```

Lean 4.35.0、固定 mathlib `56a005855ea17e0b0958f73ec801ae140b0a1679` 实际检查通过；仅依赖 propext、Classical.choice、Quot.sound。未增添 a ≤ b，保留空区间。模型采用区间子类型表述，区别于既有样本的环境函数 ContinuousOn 表述；对照了相同定义域与实值条件，没有把旧人工证明填入模型结果。

报告根 `6a8a57f6a6d2d3653dac894aa2b6255414eb893e70234c8a26ff9c41c2f78726`。独立 CLI 返回 reproduced/revalidated/sameEnvironment 均为 true；重放只重新运行归档证据，不请求模型。见 `high-live-summary.json`、`high-browser-export.json`、`high-cli-replay.json` 与 `high-workbench.png`。

首轮 `004e997b-7d51-45bb-a0a5-1f071280d011` 因包装不是直接 JSON 而受阻，保留失败记录及截图；独立诊断响应见 `high-probe-response.json`。修复的是协议包装，不是删除失败或调整目标以追求通过。

## 限制

模型把 R09 路线自标为 original，但页内没有原证明；这是模型的路线分类错误。该字段仅是候选自述，判定器未采信为原证明有效性，原证明仍为 unverified。此样本的证据应解释为独立构造，模型自述不能当作来源事实。

本轮只有一条自编实分析正例，不能推出模型成功率或研究论文级可靠性。该页没有提供完整原证明，所以原证明仍未核验；语义确认不是语义等价的机器证明。整篇论文 wholePaperVerified=false。三次模型记录不代表三个独立研究模型；这是同一模型承担不同职责的串行协作。Chat2API 的 token 用量属于服务估算，不作为计费或精确成本结论。

自动全文对象/义务提取、原证明组合、引用与跨 PDF 修订、LaTeX/附录、研究论文基准、线性代数及数论/组合仍按既定范围推进。没有提交、推送、部署或修改本机模型服务全局配置。
