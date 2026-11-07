# 0.8.1 · PDF 解析修复与自审

用户上传真实 Aktan–Vural 五页论文，新任务 R02 在约 20ms 内受阻，run.error、task.error 和证据 reason 均为空。与此前模型 HTTP 502 不同，本次尚未请求模型。

根因已复现：Node.js 24.19.0 的 --watch 模式设置 WATCH_REPORT_DEPENDENCIES=1；Worker 的 ESM 依赖通知通过 parentPort 发送 watch:import。原父进程 worker.once(message) 把第一条通知当解析响应，读取不到 ok/error，创建空 Error 并终止 Worker。原 Worker 实际可解析论文；原始观察中第 1 条为 watch:import，约第 31 条才是成功结果。

修复：父子协议显式 type=lemma.pdf.result.v1；父进程持续监听，只接受该类型。初始化 import 纳入子进程捕获；非空错误仍保留，空错误在任务与证据中有可读原因。旧空错误记录的工作流显示缺少原因提示。没有重写或美化旧数学证据。

自行复核：通知忽略后仍受原 60/20 秒预算、512MiB 限制与取消约束；真正的解析失败继续拒绝，不能误记为成功。相同错误原因在任务和归档证据一致；模型/领域原有错误记录仍保留。未关闭文件监控，也未修改数学信任规则。

新增 2 项回归：在真实 WATCH_REPORT_DEPENDENCIES 环境解析文本 PDF 并验证无效 PDF 仍正确失败；空异常产生可读任务错误与相同证据原因。78/78 回归、4/4 Sites 检查和构建通过。已有主包体积提示保留。

实际常驻 --watch API 复测同一真实论文，R02/R02C 成功，全部五页文本字符数 2134/2454/3110/2156/1113；这与独立解析一致。手工诊断故意省略提案，在后续 R03 因提案缺失停止，没有模型/Lean 调用。三条诊断运行已移出活动历史，用户两条真实失败记录保留。页面已切到新的评审准备界面，未代替用户提交真实模型任务。

证据：evidence/pdf-parser-recovery-20261017/ 的 tests.log、pipeline-tests.log、sites-tests.log、build.log、actual-api-extraction.json、watch-notification-repro.json、new-review-ready.jpg 和 before/。与 Node worker 协议有关的外部信息以本机 Node 运行时源码和真实消息复现为主要依据。

本机修复已生效；无 Git 提交、推送、线上部署或网关重启。后续模型翻译与证明质量需要独立验证。
