export const ADAPTIVE_ENGINE = "langgraph-v1";
export const ACTIONS = Object.freeze({
  assess_target: {
    label: "复核翻译并选择核验路线",
    agent: "语义复核 Agent",
    role: "A_SEMANTIC_DECISION",
  },
  diagnose_child: {
    label: "诊断形式化受阻",
    agent: "形式化诊断子 Agent",
    role: "A_CHILD_DIAGNOSE",
  },
  retry_translation: {
    label: "修复提取与翻译复核",
    agent: "形式化修复 Agent",
    role: "A_TRANSLATION_REPAIR",
  },
  retrieve_reference: {
    label: "获取引用材料",
    agent: "文献检索工具",
    role: "REFERENCE",
  },
  reconstruct_proof: {
    label: "重建局部证明",
    agent: "证明重建 Agent",
    role: "A_RECONSTRUCT",
  },
  counterexample: {
    label: "构造并检查反例",
    agent: "反例检查 Agent",
    role: "A_COUNTEREXAMPLE",
  },
  inspect_definitions: {
    label: "核对定义与条件",
    agent: "原文理解 Agent",
    role: "A_DEFINITION",
  },
  inspect_proof: {
    label: "审阅关键推理",
    agent: "证明审阅 Agent",
    role: "A_PROOF",
  },
  inspect_citation: {
    label: "核查引用依赖",
    agent: "引用核查 Agent",
    role: "A_CITATION",
  },
  formalize: {
    label: "准备形式化核验",
    agent: "形式化 Agent",
    role: "A_FORMAL",
  },
  recover_domain: {
    label: "补充领域知识",
    agent: "领域补全 Agent",
    role: "A_DOMAIN",
  },
});
export const ACTION_STATES = Object.freeze({
  queued: "已安排",
  running: "正在执行",
  succeeded: "已完成",
  awaiting_confirmation: "等待确认",
  blocked: "受阻",
  interrupted: "已中断",
  cancelled: "已取消",
  paused: "已暂停",
  recovering: "正在修复",
  unresolved: "未解决",
});
export function isAdaptive(run) {
  return run?.engine === ADAPTIVE_ENGINE;
}
export function publicTask(task) {
  return {
    id: task.id,
    title: task.title,
    role: task.role,
    agent: task.agent,
    kind: task.kind,
    status: task.status,
    parents: task.parents || [],
    reason: task.reason,
    summary: task.summary || "",
    anchors: task.anchors || [],
    inputs: task.inputs || [],
    output: task.output || null,
    startedAt: task.startedAt || null,
    endedAt: task.endedAt || null,
    error: task.error || null,
    childRunId: task.childRunId || null,
    attempt: task.attempt || 1,
  };
}
