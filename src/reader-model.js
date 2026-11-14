import { ORIGINAL_STEP_LABELS } from "./original-step-labels.js";
export const RUN_LABELS = {
  paused: "已暂停",
  preparing: "分析中",
  running: "论证中",
  awaiting_confirmation: "待确认命题",
  completed: "已汇总",
  blocked: "受阻",
  cancelled: "已取消",
  interrupted: "已中断",
  incomplete: "已记录",
};
export const isActiveRun = (run) =>
  ["preparing", "running"].includes(run?.status);
export function brief(text, limit = 68) {
  const value = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(value);
  return characters.length > limit
    ? characters.slice(0, Math.max(0, limit - 1)).join("") + "…"
    : value;
}
const sourceStepTitle = (step, route) =>
  step.title ||
  route.graph?.steps?.find((s) => s.name === step.name)?.title ||
  step.name;
function sourceStepBrief(step, route) {
  const status =
    {
      passed: "本步通过核验",
      completed: "补全推导后通过核验",
      conditional: "条件推导通过，前序尚未闭合",
      refuted: "形式目标的否定已通过 Lean",
      route_violation: "局部通过 Lean，方法审计未通过",
      alternative_only: "仅替代证明通过",
    }[step.status] || "本步暂未通过核验";
  return brief(`${sourceStepTitle(step, route)} · ${status}`);
}
const pendingReview = (run, finding) =>
  finding.status === "no_issue_found" &&
  run.claims.find((c) => c.id === finding.claimId)?.independentReview
    ?.status === "unresolved";
export function annotationsFromRuns(runs, paperId) {
  const seen = new Set();
  const adaptive = runs
    .filter((r) => r.paperSha256 === paperId && r.engine === "langgraph-v1")
    .flatMap((run) =>
      (run.findings || []).map((f, i) => ({
        id: `finding-${run.id}-${i}`,
        paperId,
        paperSha256: paperId,
        origin: "agent",
        runId: run.id,
        createdAt: run.createdAt,
        status: "needs_review",
        label: run.claims.find((c) => c.id === f.claimId)?.label || "核查意见",
        title: pendingReview(run, f)
          ? "初步意见，复核未完成"
          : {
              concern: "候选疑点",
              unresolved: "尚待核查",
              no_issue_found: "本步未发现问题",
            }[f.status],
        summary: brief(
          (pendingReview(run, f) ? "复核未完成 · " : "") + f.summary,
        ),
        body:
          f.summary +
          "\n\n" +
          (f.nextQuestion || "") +
          "\nAI 审阅意见，尚非机器证明。",
        kind: "question",
        anchor: {
          ...(f.anchors.find((a) => !a.referenceId) ||
            run.claims.find((c) => c.id === f.claimId)?.anchor),
          rects: [],
        },
        tasks: run.tasks.filter((t) => t.id === f.taskId),
        evidence: [{ id: f.evidence, title: "核查依据", type: "model" }],
        root: run.root,
        runStatus: run.status,
        sourceArtifact: run.sourceArtifact,
      })),
    );
  const formal = runs
    .filter((r) => r.paperSha256 === paperId && r.engine === "langgraph-v1")
    .flatMap((run) =>
      (run.claims || [])
        .filter((c) => c.formalResult && c.formalArtifact)
        .map((c) => ({
          id: `formal-${run.id}-${c.id}`,
          paperId,
          paperSha256: paperId,
          origin: "agent",
          runId: run.id,
          createdAt: run.createdAt,
          status: "needs_review",
          label: c.label,
          title: c.formalResult.conclusion?.headline || "形式化尝试尚无判定",
          summary: brief(
            c.formalResult.conclusion?.headline ||
              c.formalResult.error ||
              "尚未完成机器核验",
          ),
          body: [
            c.statement,
            c.formalResult.error,
            ...(c.formalResult.conclusion?.limitations || []),
          ]
            .filter(Boolean)
            .join("\n\n"),
          kind: "question",
          anchor: { ...c.anchor, rects: [] },
          tasks: c.formalResult.tasks,
          evidence: [
            { id: c.formalArtifact, title: "形式化核验依据", type: "formal" },
          ],
          targetHash: c.formalResult.contract?.targetHash,
          root: run.root,
          runStatus: run.status,
          dimensions: {
            semantic:
              c.formalResult.approval?.authority ===
              "autonomous_agent_semantic_assessment_not_human"
                ? "Agent 已复核"
                : c.formalResult.approval
                  ? "人工已确认"
                  : "尚未确认",
            original: "尚未机器验证",
            theorem:
              { formalized_proved: "形式化已证明", refuted: "否定已证明" }[
                c.formalResult.conclusion?.theorem
              ] || "未知",
          },
        })),
    );
  const sourceSteps = runs.flatMap((run) => {
    if (run.paperSha256 !== paperId) return [];
    const routes = [
      ...(run.originalProofRoute ? [run.originalProofRoute] : []),
      ...(run.claims || [])
        .map((c) => c.formalResult?.originalProofRoute)
        .filter(Boolean),
    ];
    return routes.flatMap((route) =>
      (route.steps || [])
        .filter((s) => s.anchors?.some((a) => Number.isInteger(a.pageIndex)))
        .map((s) => ({
          id: `original-step-${run.id}-${route.targetHash}-${s.name}`,
          paperId,
          paperSha256: paperId,
          origin: "agent",
          runId: run.id,
          createdAt: run.createdAt,
          status: "needs_review",
          label: sourceStepTitle(s, route),
          title: ORIGINAL_STEP_LABELS[s.status] || "暂未核验",
          summary: sourceStepBrief(s, route),
          body: [
            s.explanation,
            s.routeAssessment?.explanation,
            s.status === "conditional"
              ? "仅在前序步骤成立的条件下通过；整条证明尚未成立。"
              : null,
          ]
            .filter(Boolean)
            .join("\n\n"),
          kind: "question",
          anchor: {
            ...s.anchors.find((a) => Number.isInteger(a.pageIndex)),
            rects: [],
          },
          tasks: [],
          evidence: [
            { id: s.artifact, title: "本步 Lean 核验与依据", type: "formal" },
          ],
          targetHash: s.contract?.targetHash,
          root: run.root,
          runStatus: run.status,
          dimensions: {
            semantic:
              route.review?.checks?.find((c) => c.name === s.name)?.status ===
              "faithful"
                ? "Agent 已复核对应关系"
                : "原文对应关系待复核",
            original: ORIGINAL_STEP_LABELS[s.status] || "暂未核验",
            theorem:
              s.check?.status === "verified"
                ? s.check.mode === "counterexample"
                  ? "局部命题否定已证明"
                  : "局部条件目标通过"
                : "未核验",
          },
        })),
    );
  });
  return [
    ...runs
      .filter((r) => r.paperSha256 === paperId && r.engine === "team-v1")
      .flatMap((r) =>
        r.submissions
          .filter((s) => s.status !== "pending" && !s.final && !s.superseded)
          .flatMap((s) =>
            s.targetIds
              .map((id) => {
                const target = r.targets.find((t) => t.id === id);
                if (!target) return null;
                return {
                  id: `team-${r.id}-${s.id}-${id}`,
                  paperId,
                  paperSha256: paperId,
                  origin: "agent",
                  runId: r.id,
                  createdAt: r.createdAt,
                  status: "needs_review",
                  label: target.label,
                  title: s.status === "pass" ? "独立验收意见" : "尚待完成",
                  summary: brief(s.summary),
                  body: s.summary,
                  kind: "question",
                  anchor: {
                    pageIndex: target.contract.pageIndex,
                    quote: target.contract.quote,
                    rects: [],
                  },
                  tasks: r.tasks.filter(
                    (t) => t.id === s.taskId || t.submissionId === s.id,
                  ),
                  evidence: [
                    {
                      id: s.acceptanceArtifact || s.artifact,
                      title: "验收依据",
                      type: "model",
                    },
                  ],
                  root: r.root,
                  sourceArtifact: r.sourceArtifact,
                  runStatus: r.status,
                };
              })
              .filter(Boolean),
          ),
      ),
    ...sourceSteps,
    ...adaptive,
    ...formal,
    ...runs
      .filter((run) => run.paperSha256 === paperId && run.contract)
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      .filter((run) => {
        const key = `${run.contract.pageIndex}:${run.contract.quote.normalize("NFC").replace(/\s+/g, " ").trim()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .flatMap((run) => {
        const status = RUN_LABELS[run.status] || "待核查";
        const tasks = run.tasks || [];
        const shared = {
          paperId,
          paperSha256: paperId,
          origin: "agent",
          runId: run.id,
          createdAt: run.createdAt,
          status: "needs_review",
          tasks,
          evidence: tasks
            .filter((t) => t.output)
            .map((t) => ({ id: t.output, title: t.title, type: t.type })),
          sourceArtifact: run.sourceArtifact,
          targetHash: run.contract.targetHash,
          root: run.root,
          runStatus: run.status,
        };
        const note = {
          ...shared,
          id: `run-${run.id}`,
          label: run.contract.label,
          title:
            run.conclusion?.headline || `${run.contract.label} · ${status}`,
          summary: brief(
            run.conclusion?.headline || `${status}：${run.contract.statement}`,
          ),
          body: [
            run.contract.statement,
            run.error,
            run.conclusion?.limitations?.join?.("；"),
          ]
            .filter(Boolean)
            .join("\n\n"),
          kind: "question",
          anchor: {
            pageIndex: run.contract.pageIndex,
            quote: run.contract.quote,
            rects: [],
          },
          dimensions: {
            semantic:
              run.originalProofRoute?.review ||
              run.approval?.authority ===
                "autonomous_agent_semantic_assessment_not_human"
                ? "Agent 已复核"
                : run.approval
                  ? "人工已确认"
                  : "待确认",
            original: "尚未机器验证",
            theorem:
              { formalized_proved: "形式化已证明", refuted: "否定已证明" }[
                run.conclusion?.theorem
              ] || "未知",
          },
        };
        const gap = run.originalProof;
        if (gap?.status !== "gap_candidate" || !gap.anchor?.quote)
          return [note];
        return [
          note,
          {
            ...shared,
            id: `gap-${run.id}`,
            label: "证明疑点",
            title: "原证明中的候选疑点",
            summary: brief(gap.explanation),
            body: gap.explanation,
            kind: "question",
            anchor: { ...gap.anchor, rects: [] },
          },
        ];
      }),
  ];
}

// These lanes organize actual responsibilities. They do not claim concurrency.
export const WORKFLOW_LANES = [
  {
    id: "meaning",
    title: "原文与语义",
    description: "命题、条件与翻译是否一致",
    roles: ["R03", "R05", "R04T", "R04K", "R04"],
  },
  {
    id: "proof",
    title: "原证明审阅",
    description: "推理步骤与潜在缺口",
    roles: ["R06"],
  },
  {
    id: "formal",
    title: "构造与机器核验",
    description: "知识检索、证明及反例尝试",
    roles: ["R07", "R07C", "R09", "R08", "R10"],
  },
];
export function workflowTasks(run, roles) {
  return (run?.tasks || []).filter((task) => roles.includes(task.role));
}
export function dependencyTasks(run, task) {
  return (run?.tasks || []).filter(
    (other) => other.output && task.inputs?.includes(other.output),
  );
}
