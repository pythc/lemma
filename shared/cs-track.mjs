// Computer-science reviews choose a checker per claim.
// A sandboxed numeric comparison, a Lean check, and a Rocq replay are different results.
export const CS_ENGINE = "cs-review-v1";
export const CS_TRACK = "cs";
export const MATH_TRACK = "math";

export const KIND_LABELS = Object.freeze({
  unknown: "种类不明",
  prose_proof: "散文证明",
  computation: "小型确定性计算",
  math: "数学命题",
  mechanized_artifact: "机器证明工件",
  other: "其他实验",
});

export const OUTCOME_LABELS = Object.freeze({
  unknown: "种类不明，尚未检查",
  unmechanized: "原句已定位，散文证明未经机器检查",
  artifact_absent: "没有可重放的工件",
  unsupported_prover: "证明器尚未接入",
  environment_unsupported: "当前环境不支持这类实验",
  profile_unsupported: "不在已支持的数学库配置内",
  incomplete_proof: "证明脚本未完成，未发给内核",
  not_run: "计算或证明没有运行",
  reproduced: "输出与原文中的对照值一致",
  within_tolerance: "输出与原文相差在容差以内，不是逐字相同",
  mismatch: "输出与原文中的对照值不符",
  execution_failed: "检查未能完成",
  formalized_proved: "该命题已通过 Lean 检查",
  lean_unproved: "Lean 已执行，未取得证明",
  tool_unavailable: "检查器不可用",
  source_unlocated: "引句未在原文中唯一定位，未运行",
  mechanized_checked: "Rocq 已重放提交的证明，没有 admit 或额外公理",
  mechanized_incomplete: "Rocq 已记录，存在 admit 或额外公理，不是证明完成",
  bounded_checked: "有界搜索在界内没有发现错误，更深处未检查",
  bounded_counterexample: "有界搜索在界内发现一条行为，不是证明完成",
});

const BLOCKED_ENVIRONMENTS = new Set(["gpu", "cluster", "exploit"]);
const UNWIRED_PROVERS = new Set([
  "isabelle",
  "agda",
  "fstar",
  "easycrypt",
  "dafny",
]);
const ROCQ_PROVERS = new Set(["coq", "rocq"]);
const TLA_PROVERS = new Set(["tla"]);
export const COMPUTATION_COMMAND = "python3 experiment.py";
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const INCOMPLETE_PROOF =
  /(?:sorry|admit|sorryAx|axiom|unsafe|native_decide|run_tac|run_elab|initialize|builtin_initialize|\b(?:elab|macro|syntax|set_option|import|namespace|export|notation|command_elab)\b|#)/u;

const record = (kind, outcome, reason) => ({
  kind,
  disposition: "record",
  outcome,
  reason,
});

export function normalizeQuote(value) {
  return String(value || "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}

export function locateQuote(pages, quote) {
  const found = locateEach(pages, [quote]);
  if (found.status !== "unique")
    return { status: found.status, occurrences: found.occurrences || 0 };
  return {
    status: "unique",
    occurrences: 1,
    page: found.items[0].page,
    quote: found.items[0].quote,
  };
}

const CANDIDATE_FORBIDDEN = [
  "code",
  "expected",
  "expectedValues",
  "proof",
  "source",
  "leanTarget",
  "tolerance",
  "profileId",
  "files",
  "command",
  "config",
  "bound",
];

export function readCandidate(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const sentence = typeof item.sentence === "string" ? item.sentence.trim() : "";
  const discarded = CANDIDATE_FORBIDDEN.filter((key) => key in item);
  if ("kind" in item) discarded.push("kind");
  return { sentence, discarded };
}

export function expectedLines(claim) {
  if (!claim || typeof claim !== "object") return [];
  const source = Array.isArray(claim.expectedValues)
    ? claim.expectedValues
    : typeof claim.expected === "string"
      ? claim.expected.split(/\n/)
      : [];
  return source.map((value) => String(value).trim()).filter(Boolean);
}

function tlaConfigBody(config) {
  return String(config || "")
    .split(/\n/)
    .map((line) => line.split("\\*")[0])
    .join("\n");
}

export function tlaConfigChecksProperty(config) {
  return /\b(?:INVARIANTS?|PROPERT(?:Y|IES))\b/.test(tlaConfigBody(config));
}

export function tlaConfigDisablesDeadlock(config) {
  return /\bCHECK_DEADLOCK\s+FALSE\b/.test(tlaConfigBody(config));
}

export function tlaConfigNarrowsSearch(config) {
  return /\b(?:CONSTRAINTS?|ACTION_CONSTRAINTS?|TYPE_CONSTRAINT|VIEW|SYMMETRY)\b/.test(
    tlaConfigBody(config),
  );
}

const TLA_CONFIG_KEYWORDS = new Set([
  "CONSTANT",
  "CONSTANTS",
  "INIT",
  "NEXT",
  "SPECIFICATION",
  "INVARIANT",
  "INVARIANTS",
  "PROPERTY",
  "PROPERTIES",
  "CONSTRAINT",
  "CONSTRAINTS",
  "ACTION_CONSTRAINT",
  "ACTION_CONSTRAINTS",
  "TYPE_CONSTRAINT",
  "VIEW",
  "SYMMETRY",
  "ALIAS",
  "CHECK_DEADLOCK",
  "POSTCONDITION",
]);
const TLA_PROPERTY_KEYWORDS = new Set([
  "INVARIANT",
  "INVARIANTS",
  "PROPERTY",
  "PROPERTIES",
]);

function tlaSourceBody(source) {
  return String(source || "")
    .replace(/\(\*[\s\S]*?\*\)/g, " ")
    .split(/\n/)
    .map((line) => line.split("\\*")[0])
    .join("\n");
}

function tlaDefinitionBody(source, name) {
  const body = tlaSourceBody(source);
  const match = new RegExp(
    `(?:^|\\n)[ \\t]*(?:LOCAL[ \\t]+)?${name}[ \\t]*==[ \\t]*`,
  ).exec(body);
  if (!match) return "";
  const lines = body.slice(match.index + match[0].length).split("\n");
  const kept = [lines[0]];
  for (const line of lines.slice(1)) {
    if (/^(?:LOCAL[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*==/.test(line)) break;
    if (line.trim() === "====") break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function formulaTokens(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index])) {
      index += 1;
      continue;
    }
    if (text.startsWith("<=>", index)) return null;
    const operator = ["/\\", "\\/", "=>"].find((item) => text.startsWith(item, index));
    if (operator) {
      tokens.push(operator);
      index += operator.length;
      continue;
    }
    const word = /^(?:TRUE|FALSE)(?![A-Za-z0-9_])/.exec(text.slice(index));
    if (word) {
      tokens.push(word[0]);
      index += word[0].length;
      continue;
    }
    tokens.push(text[index]);
    index += 1;
  }
  return tokens;
}

function formulaProvenTrue(text) {
  const body = String(text || "").trim();
  if (!body || /\\[AE]\b|\bLET\b/.test(body)) return false;
  const boxed = /^\[\]\s*([\s\S]+)$/.exec(body);
  if (boxed) {
    const inner = boxed[1].trim();
    if (inner.startsWith("[]") || inner.startsWith("<>")) return false;
    return formulaProvenTrue(inner);
  }
  const tokens = formulaTokens(body);
  if (!tokens) return false;
  const truth = (value) => value === "true";
  const combineOr = (left, right) =>
    truth(left) || truth(right)
      ? "true"
      : left === "false" && right === "false"
        ? "false"
        : "unknown";
  const combineAnd = (left, right) =>
    left === "false" || right === "false"
      ? "false"
      : truth(left) && truth(right)
        ? "true"
        : "unknown";
  const combineImply = (left, right) =>
    left === "false" || truth(right)
      ? "true"
      : left === "true"
        ? right
        : "unknown";
  const combineNot = (value) =>
    value === "true" ? "false" : value === "false" ? "true" : "unknown";
  const stops = new Set(["/\\", "\\/", "=>", ")"]);
  const parseNot = () => {
    if (tokens[0] === "~") {
      tokens.shift();
      return combineNot(parseNot());
    }
    return parseAtom();
  };
  const parseAnd = () => {
    let value = parseNot();
    while (tokens[0] === "/\\") {
      tokens.shift();
      value = combineAnd(value, parseNot());
    }
    return value;
  };
  const parseOr = () => {
    let value = parseAnd();
    while (tokens[0] === "\\/") {
      tokens.shift();
      value = combineOr(value, parseAnd());
    }
    return value;
  };
  const parseImply = () => {
    let value = parseOr();
    if (tokens[0] === "=>") {
      tokens.shift();
      value = combineImply(value, parseImply());
    }
    return value;
  };
  const parseAtom = () => {
    const token = tokens.shift();
    if (token === "TRUE") return "true";
    if (token === "FALSE") return "false";
    if (token === "(") {
      const value = parseImply();
      if (tokens[0] === ")") tokens.shift();
      return value;
    }
    while (tokens.length && !stops.has(tokens[0])) tokens.shift();
    return "unknown";
  };
  return truth(parseImply());
}

function tlaOperatorIsTrue(source, name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  return formulaProvenTrue(tlaDefinitionBody(source, name));
}

function tlaConfigTokens(config) {
  return tlaConfigBody(config)
    .split(/(<-|=|\s+)/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function tlaConfigVacuousProperty(config, source = "") {
  const names = [];
  const assigned = new Map();
  let section = "";
  let pending = "";
  let awaitValue = false;
  for (const token of tlaConfigTokens(config)) {
    if (TLA_CONFIG_KEYWORDS.has(token)) {
      section = token;
      pending = "";
      awaitValue = false;
      continue;
    }
    if (section === "CONSTANT" || section === "CONSTANTS") {
      if (token === "=" || token === "<-") {
        awaitValue = pending !== "";
        continue;
      }
      if (awaitValue) {
        assigned.set(pending, token);
        pending = "";
        awaitValue = false;
        continue;
      }
      pending = token;
      continue;
    }
    if (TLA_PROPERTY_KEYWORDS.has(section)) names.push(token);
  }
  const resolvesTrue = (name, seen = new Set()) => {
    if (name === "TRUE") return true;
    if (seen.has(name)) return false;
    seen.add(name);
    if (assigned.has(name)) return resolvesTrue(assigned.get(name), seen);
    return tlaOperatorIsTrue(source, name);
  };
  return names.length > 0 && names.every((name) => resolvesTrue(name));
}

export function computationFiles(claim) {
  if (!claim || claim.files == null) return { ok: true, files: [] };
  if (!Array.isArray(claim.files) || claim.files.length > 6)
    return { ok: false, reason: "附加文件超过 6 个，计算未运行。" };
  const names = new Set();
  const files = [];
  for (const file of claim.files) {
    if (!file || typeof file.name !== "string" || typeof file.content !== "string")
      return { ok: false, reason: "附加文件无效，计算未运行。" };
    const folded = file.name.toLowerCase();
    if (!FILE_NAME.test(file.name))
      return { ok: false, reason: "附加文件名无效，计算未运行。" };
    if (folded === "experiment.py")
      return { ok: false, reason: "附加文件不能替换主程序，计算未运行。" };
    if (names.has(folded))
      return { ok: false, reason: "附加文件名在不区分大小写时相撞，计算未运行。" };
    if (file.content.length > 64000)
      return { ok: false, reason: "附加文件超限，计算未运行。" };
    names.add(folded);
    files.push({ name: file.name, content: file.content });
  }
  return { ok: true, files };
}

function hasGroupedTail(body, index) {
  let cursor = index;
  if (body[cursor] === ",") cursor += 1;
  if (body[cursor] !== " ") return false;
  while (body[cursor] === " ") cursor += 1;
  const digits = /^\d+/.exec(body.slice(cursor));
  return !!digits && digits[0].length === 3;
}

function hasGroupedHead(body, at, needle) {
  if (!/^\d{3}\.?$/.test(needle)) return false;
  let cursor = at - 1;
  while (cursor >= 0 && body[cursor] === " ") cursor -= 1;
  if (cursor >= 0 && body[cursor] === ",") cursor -= 1;
  while (cursor >= 0 && body[cursor] === " ") cursor -= 1;
  const end = cursor;
  while (cursor >= 0 && /[0-9]/.test(body[cursor])) cursor -= 1;
  const width = end - cursor;
  return width >= 1 && width <= 3 && !/[0-9]/.test(body[cursor] || "");
}

function keepsNumericToken(body, at, needle) {
  if (/^\d{1,3}(?: \d{3})+$/.test(needle) || /^\d{1,3}(?:, \d{3})+$/.test(needle)) {
    const before = at > 0 ? body[at - 1] : "";
    return !/[0-9]/.test(before) && !hasGroupedTail(body, at + needle.length);
  }
  if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?|\.\d+)\.?$/.test(needle))
    return true;
  const before = at > 0 ? body[at - 1] : "";
  const after = body[at + needle.length] || "";
  const next = body[at + needle.length + 1] || "";
  const prev = at > 1 ? body[at - 2] : "";
  if (/[0-9]/.test(before) || /[A-Za-z]/.test(before)) return false;
  if (/[A-Za-z]/.test(after)) return false;
  if (before === "." && /[0-9]/.test(prev)) return false;
  if (before === "," && /[0-9]/.test(prev)) return false;
  if (/[0-9]/.test(after)) return false;
  if (after === "." && /[0-9]/.test(next)) return false;
  if (after === "," && /[0-9]/.test(next)) return false;
  if ((after === "e" || after === "E") && /[0-9+-]/.test(next)) return false;
  if (hasGroupedTail(body, at + needle.length) || hasGroupedHead(body, at, needle))
    return false;
  return true;
}

export function locateEach(pages, quotes) {
  const bodies = (pages || []).map((page) => ({
    page,
    body: normalizeQuote(page?.text || ""),
  }));
  const items = [];
  for (const quote of quotes) {
    const needle = normalizeQuote(quote);
    if (!needle) return { status: "missing", occurrences: 0 };
    const hits = [];
    let embedded = false;
    for (const item of bodies) {
      let from = 0;
      while (from < item.body.length) {
        const at = item.body.indexOf(needle, from);
        if (at < 0) break;
        if (keepsNumericToken(item.body, at, needle)) {
          hits.push({ item, at });
          if (hits.length > 1) return { status: "repeated", occurrences: hits.length };
        } else embedded = true;
        from = at + needle.length;
      }
    }
    if (hits.length !== 1) {
      if (
        hits.length === 0 &&
        items.some((item) => normalizeQuote(item.quote) === needle)
      )
        return { status: "used", occurrences: 0 };
      return {
        status: embedded ? "embedded" : "missing",
        occurrences: 0,
      };
    }
    const hit = hits[0];
    items.push({ quote: String(quote).trim(), page: hit.item.page });
    hit.item.body =
      hit.item.body.slice(0, hit.at) +
      " ".repeat(needle.length) +
      hit.item.body.slice(hit.at + needle.length);
  }
  return { status: "unique", items };
}

export function sourceSentence(claim) {
  if (!claim || typeof claim !== "object") return "";
  if (claim.kind === "computation") return claim.expected || "";
  if (claim.kind === "prose_proof") return claim.quote || claim.statement || "";
  return claim.quote || claim.statement || "";
}

export function classifyCsClaim(claim, profileIds) {
  const profiles = profileIds || [
    "std-v1",
    "analysis-continuity-v1",
    "linear-maps-v1",
    "number-combinatorics-v1",
  ];
  if (!claim || typeof claim !== "object" || Array.isArray(claim))
    return record("unknown", "unknown", "主张不是一条记录。");
  if (BLOCKED_ENVIRONMENTS.has(claim.environment))
    return record(
      claim.kind || "other",
      "environment_unsupported",
      "GPU、集群和漏洞利用代码不在这一期执行。",
    );
  if (claim.kind === "prose_proof")
    return record(
      "prose_proof",
      "unmechanized",
      "散文证明只在原句唯一定位后保留，不进入证明器。",
    );
  if (claim.kind === "mechanized_artifact") {
    const prover = String(claim.prover || "").toLowerCase();
    if (TLA_PROVERS.has(prover)) {
      const source = typeof claim.source === "string" ? claim.source.trim() : "";
      const config = typeof claim.config === "string" ? claim.config.trim() : "";
      if (!source || !config)
        return record(
          "mechanized_artifact",
          "artifact_absent",
          "没有提供可重放的 TLA+ 规格和配置。",
        );
      if (!tlaConfigChecksProperty(config))
        return record(
          "mechanized_artifact",
          "not_run",
          "TLC 配置没有不变量或性质，未运行。",
        );
      if (tlaConfigDisablesDeadlock(config))
        return record(
          "mechanized_artifact",
          "not_run",
          "TLC 配置关闭了死锁检查，未运行。",
        );
      if (tlaConfigNarrowsSearch(config))
        return record(
          "mechanized_artifact",
          "not_run",
          "TLC 配置含有约束、对称或视图，会藏起一部分行为，未运行。",
        );
      if (tlaConfigVacuousProperty(config, source))
        return record(
          "mechanized_artifact",
          "not_run",
          "TLC 要检查的不变量或性质恒为 TRUE，没有检查规格，未运行。",
        );
      if (!Number.isInteger(claim.bound) || claim.bound < 1 || claim.bound > 20)
        return record(
          "mechanized_artifact",
          "not_run",
          "搜索界必须是 1 到 20 的整数，未运行。",
        );
      return {
        kind: "mechanized_artifact",
        disposition: "execute_tla",
        outcome: null,
        reason: "先定位论文原句，再按写明的搜索界运行 TLC。",
      };
    }
    if (UNWIRED_PROVERS.has(prover))
      return record(
        "mechanized_artifact",
        "unsupported_prover",
        "该证明器尚未接入，不能改用 Rocq、TLA+ 或 Lean 代替。",
      );
    if (!ROCQ_PROVERS.has(prover))
      return record(
        "mechanized_artifact",
        "unsupported_prover",
        "Lean 命题请作为数学主张提交，由现有检查器重放。",
      );
    const source = typeof claim.source === "string" ? claim.source.trim() : "";
    if (!source)
      return record(
        "mechanized_artifact",
        "artifact_absent",
        "没有提供可重放的 Rocq 源码。",
      );
    return {
      kind: "mechanized_artifact",
      disposition: "execute_rocq",
      outcome: null,
      reason: "先定位论文原句，再用固定的 Rocq 命令重放并列出公理。",
    };
  }
  if (claim.kind === "other")
    return record(
      "other",
      "environment_unsupported",
      "这类实验没有对应的检查器。",
    );
  if (claim.kind === "computation") {
    const files = computationFiles(claim);
    if (!files.ok) return record("computation", "not_run", files.reason);
    if (claim.command !== undefined && claim.command !== COMPUTATION_COMMAND)
      return record("computation", "not_run", "只接受命令 python3 experiment.py。");
    if (typeof claim.code !== "string" || !claim.code.trim())
      return record("computation", "not_run", "没有可执行代码，计算未运行。");
    if (!expectedLines(claim).length)
      return record("computation", "not_run", "没有对照原文，计算未运行。");
    if (expectedLines(claim).length > 8)
      return record("computation", "not_run", "对照值超过 8 个，计算未运行。");
    return {
      kind: "computation",
      disposition: "execute_computation",
      outcome: null,
      reason: "对照原文唯一定位后，才在隔离沙箱中运行。",
    };
  }
  if (claim.kind === "math") {
    if (!profiles.includes(claim.profileId))
      return record(
        "math",
        "profile_unsupported",
        "库配置不在已验收的四套之内。",
      );
    if (typeof claim.proof === "string" && INCOMPLETE_PROOF.test(claim.proof))
      return record(
        "math",
        "incomplete_proof",
        "证明含未完成标记或禁止指令，未交给 Lean。",
      );
    if (
      typeof claim.quote !== "string" ||
      !claim.quote.trim() ||
      typeof claim.leanTarget !== "string" ||
      !claim.leanTarget.trim() ||
      typeof claim.proof !== "string" ||
      !claim.proof.trim()
    )
      return record("math", "not_run", "缺少引句、目标或证明，未调用 Lean。");
    return {
      kind: "math",
      disposition: "execute_lean",
      outcome: null,
      reason: "引句唯一定位后，使用已有 Lean 配置检查这一条命题。",
    };
  }
  return record("unknown", "unknown", "种类不在封闭清单内。");
}

export function needsSourceQuote(classified) {
  return (
    classified.kind === "prose_proof" ||
    classified.disposition === "execute_computation" ||
    classified.disposition === "execute_lean" ||
    classified.disposition === "execute_rocq" ||
    classified.disposition === "execute_tla" ||
    classified.outcome === "incomplete_proof"
  );
}

export function csPaperSummary(claims) {
  return {
    headline: "计算机评审记录已保存",
    track: CS_TRACK,
    theorem: "unknown",
    reviewComplete: false,
    certificate: null,
    provedClaimIds: claims
      .filter((claim) => claim.outcome === "formalized_proved")
      .map((claim) => claim.id),
    notice:
      "整篇论文没有验证结论。沙箱比对、单条 Lean 检查、Rocq 的三列记录和 TLA+ 有界搜索只属于对应主张。存在 admit、额外公理，或搜索没有覆盖更深状态时，都不能视为证明完成。",
  };
}
