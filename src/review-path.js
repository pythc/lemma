import { readingStatus } from "../shared/reading-status.mjs";

// View groups reference original task IDs; they never manufacture executions.
export function pathTaskStatus(task) {
  if (task.childRunId && !task.childFinal) {
    if (task.childStatus === "awaiting_confirmation")
      return "awaiting_confirmation";
    if (["running", "preparing"].includes(task.childStatus)) return "running";
  }
  return task.status;
}

export function groupReviewTasks(run) {
  const tasks = run.tasks || [],
    byId = new Map(tasks.map((t) => [t.id, t]));
  const owner = new Map();
  const groupKey = (t, seen = new Set()) => {
    if (!t || seen.has(t.id)) return "dispatch";
    seen.add(t.id);
    if (t.kind === "diagnose") return groupKey(byId.get(t.recoveryFor), seen);
    if (t.kind === "import") return "import";
    if (["read", "paper_map"].includes(t.kind)) return "read";
    if (["environment", "environment_probe"].includes(t.kind))
      return "environment";
    if (t.kind === "conclude") return "report";
    if (t.kind === "decide") return "dispatch";
    return t.claimId ? `claim:${t.claimId}` : "other";
  };
  const buckets = new Map();
  for (const t of tasks) {
    const key = groupKey(t);
    owner.set(t.id, key);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }
  const keys = [
    "import",
    "read",
    "environment",
    "other",
    ...[...buckets.keys()].filter((k) => k.startsWith("claim:")),
    "report",
  ];
  const titles = {
    import: "导入论文",
    read: "理解原文",
    environment: "选择并检查数学库",
    other: "其他核查",
    report: "汇总评审结果",
  };
  const groups = keys
    .filter((k) => buckets.has(k))
    .map((key) => {
      const members = buckets.get(key),
        claim = (run.claims || []).find((c) => `claim:${c.id}` === key);
      const states = members.map(pathTaskStatus);
      const readingFailed = key === "report" && readingStatus(run).failed;
      const state = readingFailed
        ? "unresolved"
        : [
            "running",
            "recovering",
            "queued",
            "awaiting_confirmation",
            "interrupted",
            "unresolved",
            "blocked",
            "cancelled",
            "paused",
          ].find((s) => states.includes(s)) || "succeeded";
      const active = states.filter((s) =>
        ["running", "recovering"].includes(s),
      ).length;
      const unresolved = states.filter((s) =>
        ["unresolved", "blocked", "interrupted"].includes(s),
      ).length;
      const shortLabel =
        claim?.label?.match(
          /(?:Theorem|Lemma|Definition|Proposition|定理|引理|定义)\s*[\d.]+/i,
        )?.[0] ||
        claim?.label ||
        key.slice(6);
      return {
        id: `group:${key}`,
        key,
        claimId: claim?.id,
        kind: key.startsWith("claim:") ? "claim" : key,
        title: readingFailed
          ? "评审未完成"
          : claim
            ? `核查 ${shortLabel}`
            : titles[key] || shortLabel,
        fullTitle: readingFailed
          ? "评审未完成"
          : claim?.label || titles[key] || shortLabel,
        taskIds: members.map((t) => t.id),
        status: state,
        summary: readingFailed
          ? "正文阅读未完成"
          : `${members.length} 个步骤 · ${active ? `${active} 项执行中` : unresolved ? `${unresolved} 项未解决` : state === "succeeded" ? "已完成" : state === "awaiting_confirmation" ? (run.semanticPolicy === "agent" ? "正在复核翻译" : "待命题确认") : state === "queued" ? "等待执行" : "已停止"}`,
      };
    });
  return { groups, owner, dispatch: buckets.get("dispatch") || [] };
}

// Follow actual dependencies through omitted dispatch/diagnostic nodes.
export function visibleParents(task, allTasks, visibleIds) {
  const byId = new Map(allTasks.map((t) => [t.id, t])),
    result = new Map();
  const queue = (task.parents || []).map((id) => [id, 1]),
    seen = new Set([task.id]);
  for (let i = 0; i < queue.length; i++) {
    const [id, depth] = queue[i];
    if (seen.has(id)) continue;
    seen.add(id);
    if (visibleIds.has(id)) {
      result.set(id, depth);
      continue;
    }
    for (const p of byId.get(id)?.parents || []) queue.push([p, depth + 1]);
  }
  return [...result]
    .sort(
      (a, b) =>
        a[1] - b[1] ||
        allTasks.findIndex((t) => t.id === b[0]) -
          allTasks.findIndex((t) => t.id === a[0]),
    )
    .map(([id]) => id);
}

export function overviewDependencies(run, grouped) {
  const tasks = run.tasks || [],
    byId = new Map(tasks.map((t) => [t.id, t])),
    groups = new Map(grouped.groups.map((g) => [g.key, g]));
  const rank = (g) =>
    ({ import: 0, read: 1, environment: 2, other: 3, claim: 4, report: 5 })[
      g.kind
    ];
  const pairs = new Map();
  for (const group of grouped.groups)
    for (const id of group.taskIds) {
      const queue = [...(byId.get(id)?.parents || [])],
        seen = new Set([id]);
      for (let i = 0; i < queue.length; i++) {
        const p = queue[i];
        if (seen.has(p)) continue;
        seen.add(p);
        const parentGroup = groups.get(grouped.owner.get(p));
        if (parentGroup && parentGroup.id !== group.id) {
          // Cross-claim references stay in task details; no cycle is manufactured
          // by collapsing many earlier/later executions into one claim card.
          if (rank(parentGroup) < rank(group))
            pairs.set(`${parentGroup.id}:${group.id}`, {
              source: parentGroup.id,
              target: group.id,
            });
        } else queue.push(...(byId.get(p)?.parents || []));
      }
    }
  const edges = [...pairs.values()];
  function reaches(from, to, skip, seen = new Set()) {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return edges.some(
      (e) =>
        e !== skip && e.source === from && reaches(e.target, to, skip, seen),
    );
  }
  return edges.filter((e) => !reaches(e.source, e.target, e));
}
