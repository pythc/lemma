export const MAX_PDF_BYTES = 25 * 1024 * 1024;

export async function identifyPdf(bytes) {
  if (
    !(bytes instanceof ArrayBuffer) ||
    bytes.byteLength > MAX_PDF_BYTES ||
    bytes.byteLength < 5
  ) {
    throw new Error("请选择 25 MB 以内的 PDF 文件。");
  }
  const header = new TextDecoder().decode(new Uint8Array(bytes, 0, 5));
  if (header !== "%PDF-") throw new Error("文件内容不是 PDF，无法导入。");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}

export function validateAnchor(anchor, pageCount) {
  if (
    !Number.isInteger(anchor?.pageIndex) ||
    anchor.pageIndex < 0 ||
    anchor.pageIndex >= pageCount
  )
    throw new Error("批注页码无效。");
  if (!Array.isArray(anchor.rects) || anchor.rects.length === 0)
    throw new Error("请先选择原文或框选区域。");
  for (const r of anchor.rects) {
    if (
      ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
      r.x < 0 ||
      r.y < 0 ||
      r.width <= 0 ||
      r.height <= 0 ||
      r.x + r.width > 1.001 ||
      r.y + r.height > 1.001
    )
      throw new Error("批注区域超出页面。");
  }
  return anchor;
}

export function createAnnotation(paper, anchor, title, body) {
  validateAnchor(anchor, paper.pageCount);
  if (!title.trim() || !body.trim()) throw new Error("请填写批注标题和依据。");
  return {
    id: crypto.randomUUID(),
    paperId: paper.id,
    paperSha256: paper.id,
    title: title.trim(),
    body: body.trim(),
    anchor,
    kind: "manual",
    status: "needs_review",
    origin: "human",
    evidence: [],
    tasks: [],
    createdAt: new Date().toISOString(),
  };
}

export function reportFor(paper, annotations) {
  return {
    schemaVersion: "lemma.review.v1",
    title: paper.title,
    paper: {
      id: paper.id,
      sha256: paper.id,
      pageCount: paper.pageCount,
      isDemo: paper.isDemo,
    },
    generatedAt: new Date().toISOString(),
    scope: "阅读批注及所关联评审记录的索引；导出操作未执行额外评审或核验。实际核验结论以对应完整证据包为准，不代表整篇论文验证通过。",
    annotations: annotations.filter(
      (a) => a.paperId === paper.id && a.paperSha256 === paper.id,
    ),
  };
}

export const ROLE_CATALOG = [
  ["R01", "研究脉络", "先行结果与贡献对照"],
  ["R02", "定义与符号", "对象、定义及作用域"],
  ["R03", "命题语义", "原文与目标一致性"],
  ["R04", "证明结构", "依赖与关键步骤"],
  ["R05", "假设与边界", "条件、常数和参数"],
  ["R06", "原证明审计", "逐步核查论证"],
  ["R07", "引用与版本", "外部定理及条件"],
  ["R08", "反例与后果", "构造与核验反例"],
  ["R09", "形式化证明", "Lean 目标与证明"],
  ["R10", "证据审计", "证据、公理与检查记录"],
  ["R11", "解释与复用", "思想和可用引理"],
  ["R12", "修订与报告", "问题归纳及重验"],
];

export function demoAnnotations(paper) {
  if (!paper.isDemo) return [];
  const shared = {
    paperId: paper.id,
    paperSha256: paper.id,
    origin: "demo",
    status: "needs_review",
    createdAt: "2026-10-17T00:00:00+08:00",
  };
  return [
    {
      ...shared,
      id: `demo-f01-${paper.id}`,
      label: "F-01",
      title: "逐点收敛不能保证极限连续",
      kind: "counterexample",
      body: "取 fₙ(x) = xⁿ，x ∈ [0,1]。每个 fₙ 连续；逐点极限在 x < 1 时为 0，在 x = 1 时为 1，因此在 1 处不连续。",
      anchor: {
        pageIndex: 2,
        quote:
          "The pointwise limit of continuous functions on [0,1] is continuous.",
        rects: [{ x: 0.105, y: 0.237, width: 0.79, height: 0.061 }],
      },
      tasks: [
        {
          id: "R03",
          name: "语义 Agent",
          action: "命题对齐",
          artifact: "区分逐点收敛与一致收敛",
          state: "示例产物",
          color: "rose",
        },
        {
          id: "R05",
          name: "假设 Agent",
          action: "条件核查",
          artifact: "原命题没有一致收敛假设",
          state: "示例产物",
          color: "sand",
        },
        {
          id: "R08",
          name: "反例 Agent",
          action: "反例构造",
          artifact: "在 [0,1] 上取 fₙ(x) = xⁿ",
          state: "示例产物",
          color: "blue",
        },
        {
          id: "R10",
          name: "证据 Agent",
          action: "证据复核",
          artifact: "待执行独立复核",
          state: "未运行",
          color: "olive",
        },
      ],
      evidence: [
        {
          id: "E-01",
          title: "原文命题",
          type: "原文",
          body: "原命题只假设连续函数列逐点收敛，声称极限函数连续。",
          source: "教学论文 v1 · 第 3 页 · 命题 2.1",
        },
        {
          id: "E-02",
          title: "反例推导",
          type: "数学说明",
          body: "n ≥ 1。fₙ(x)=xⁿ 在 [0,1] 上连续。0≤x<1 时 xⁿ→0；x=1 时 xⁿ=1。所以 lim(x→1⁻) f(x)=0≠f(1)=1。该说明尚未通过机器核验。",
          source: "自拟教学示例",
        },
        {
          id: "E-03",
          title: "Lean 核验",
          type: "未运行",
          body: "本轮没有生成或执行 Lean 证明，不存在机器检查证书。",
          source: "待接入 Lean 后端",
        },
      ],
    },
    {
      ...shared,
      id: `demo-f02-${paper.id}`,
      label: "F-02",
      title: "量词次序需要核查",
      kind: "question",
      body: "逐点收敛中的 N 可以依赖 x。一致收敛要求同一个 N 适用于所有 x。不能在证明中无依据地交换量词。",
      anchor: {
        pageIndex: 2,
        quote: "Choosing a single N for every x would require justification.",
        rects: [{ x: 0.105, y: 0.39, width: 0.79, height: 0.065 }],
      },
      tasks: [],
      evidence: [],
    },
    {
      ...shared,
      id: `demo-f03-${paper.id}`,
      label: "F-03",
      title: "修正命题应当单独记录",
      kind: "note",
      body: "将逐点收敛改为一致收敛可得到正确版本，但它是修改后的命题，不能据此把原命题标成已验证。",
      anchor: {
        pageIndex: 2,
        quote: "A corrected statement",
        rects: [{ x: 0.105, y: 0.78, width: 0.79, height: 0.06 }],
      },
      tasks: [],
      evidence: [],
    },
  ];
}
