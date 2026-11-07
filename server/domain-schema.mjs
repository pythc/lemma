import { MODULE_PATTERN } from "../shared/agent-tool-fields.mjs";
import { DOMAIN_RUNTIME, LEAN_RUNTIME } from "./runtime-limits.mjs";
import { digest, isHash } from "./evidence.mjs";
import { text, validateLeanText } from "./contracts.mjs";
import { anchorInContext } from "./context.mjs";
import { MATHLIB_COMMIT } from "../shared/library-profiles.mjs";

export const DOMAIN_LIMITS = DOMAIN_RUNTIME;
export function preserveDomainPlan(prior, raw) {
  if (!prior) return raw;
  if (!raw || typeof raw !== "object") throw Error("领域补全方案缺失。");
  const merge = (kind) => {
    const entries = [...(raw[kind] || [])];
    for (const existing of prior[kind] || []) {
      const at = entries.findIndex((entry) => entry.name === existing.name);
      if (at < 0) {
        entries.push(structuredClone(existing));
        continue;
      }
      const withoutProof = (entry) =>
        Object.fromEntries(
          Object.entries(entry).filter(([key]) => key !== "proof"),
        );
      if (digest(withoutProof(entries[at])) !== digest(withoutProof(existing)))
        throw Error(`既有补充声明 ${existing.name} 不能在补库时被重新定义。`);
      entries[at] = {
        ...existing,
        ...entries[at],
        ...(kind === "lemmas"
          ? { proof: entries[at].proof || existing.proof }
          : {}),
      };
    }
    return entries;
  };
  return {
    ...raw,
    modules: [
      ...new Set([
        ...(prior.modules || []).map((m) => m.name),
        ...(raw.modules || []),
      ]),
    ],
    definitions: merge("definitions"),
    lemmas: merge("lemmas"),
  };
}
const list = (value, max, label) => {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`${label}清单缺失或超过预算。`);
  return value;
};
export function moduleName(value) {
  if (
    typeof value !== "string" ||
    value.length > 180 ||
    !new RegExp(MODULE_PATTERN).test(value)
  )
    throw new Error(
      "modules 接受固定版本的 Mathlib 或 Mathlib.* 模块名。Std/Init/Lean 属于工具链；用 inspect_execution_environment 查询，勿填入追加列表。",
    );
  return value;
}
export function definitionName(value) {
  if (typeof value !== "string" || !/^[A-Z][A-Za-z0-9_]{0,63}$/.test(value))
    throw new Error("补充声明名需大写字母开头，只含字母、数字和下划线。");
  return value;
}
const fields = (value, allowed) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw new Error("补充方案含未声明字段；不能修改目标、前提或信任规则。");
};
export function validateDomainPlan(raw, context) {
  fields(raw, [
    "queries",
    "modules",
    "definitions",
    "lemmas",
    "proposal",
    "libraryIds",
  ]);
  const queries = list(raw.queries || [], 8, "检索词").map((q) =>
    text(q, 100, "检索词"),
  );
  const modules = list(raw.modules || [], DOMAIN_LIMITS.modules, "模块").map(
    moduleName,
  );
  if (new Set(modules).size !== modules.length) throw new Error("模块重复。");
  const definitions = list(
    raw.definitions || [],
    DOMAIN_LIMITS.definitions,
    "定义",
  ).map((d) => {
    fields(d, ["name", "type", "value", "meaning", "anchors", "dependsOn"]);
    if (!d.anchors?.length) throw new Error("新定义必须有论文原文依据。");
    return {
      name: definitionName(d.name),
      type: validateLeanText(
        d.type,
        "定义类型",
        LEAN_RUNTIME.helperTargetCharacters,
      ),
      value: validateLeanText(
        d.value,
        "定义内容",
        LEAN_RUNTIME.helperTargetCharacters,
      ),
      meaning: text(d.meaning, 3000, "定义含义"),
      anchors: list(d.anchors, 8, "定义依据").map((a) =>
        anchorInContext(a, context),
      ),
      dependsOn: list(
        d.dependsOn || [],
        DOMAIN_LIMITS.definitions + DOMAIN_LIMITS.lemmas,
        "依赖",
      ).map(definitionName),
    };
  });
  const lemmas = list(raw.lemmas || [], DOMAIN_LIMITS.lemmas, "引理").map(
    (l) => {
      fields(l, ["name", "target", "proof", "purpose", "dependsOn"]);
      return {
        name: definitionName(l.name),
        target: validateLeanText(
          l.target,
          "辅助引理目标",
          LEAN_RUNTIME.targetCharacters,
        ),
        ...(l.proof
          ? {
              proof: validateLeanText(
                l.proof,
                "辅助引理证明",
                LEAN_RUNTIME.proofCharacters,
              ),
            }
          : {}),
        purpose: text(l.purpose, 3000, "引理用途"),
        dependsOn: list(
          l.dependsOn || [],
          DOMAIN_LIMITS.definitions + DOMAIN_LIMITS.lemmas,
          "依赖",
        ).map(definitionName),
      };
    },
  );
  orderedComponents({ definitions, lemmas });
  if (
    definitions.some((d) =>
      d.dependsOn.some((n) => lemmas.some((l) => l.name === n)),
    )
  )
    throw new Error("定义只能依赖其他定义，不能依赖待证引理。");
  return {
    queries,
    modules,
    definitions,
    lemmas,
    ...(raw.libraryIds
      ? {
          libraryIds: list(raw.libraryIds, 8, "外部库收据").map((id) => {
            if (!/^[a-f0-9]{64}$/.test(id)) throw Error("外部库收据身份无效。");
            return id;
          }),
        }
      : {}),
    ...(raw.proposal ? { proposal: raw.proposal } : {}),
  };
}
export function orderedComponents(context) {
  const entries = [
    ...context.definitions.map((d) => ({ ...d, kind: "definition" })),
    ...context.lemmas.map((l) => ({ ...l, kind: "lemma" })),
  ];
  const map = new Map(entries.map((d) => [d.name, d]));
  if (map.size !== entries.length) throw new Error("补充声明重名。");
  const visiting = new Set(),
    visited = new Set(),
    result = [];
  const visit = (d) => {
    if (visiting.has(d.name)) throw new Error("辅助声明存在循环依赖。");
    if (visited.has(d.name)) return;
    visiting.add(d.name);
    if (new Set(d.dependsOn).size !== d.dependsOn.length)
      throw new Error("声明依赖重复。");
    for (const n of d.dependsOn) {
      if (!map.has(n)) throw new Error(`声明 ${d.name} 引用了未知依赖 ${n}。`);
      visit(map.get(n));
    }
    visiting.delete(d.name);
    visited.add(d.name);
    result.push(d);
  };
  entries.forEach(visit);
  return result;
}
export function dependencyContext(context, component) {
  const byName = new Map(orderedComponents(context).map((c) => [c.name, c]));
  const selected = new Set();
  const add = (name) => {
    if (selected.has(name)) return;
    const c = byName.get(name);
    if (!c) throw new Error("缺少已核验依赖。");
    selected.add(name);
    c.dependsOn.forEach(add);
  };
  component.dependsOn.forEach(add);
  return {
    ...context,
    definitions: context.definitions.filter((d) => selected.has(d.name)),
    lemmas: context.lemmas.filter((d) => selected.has(d.name)),
  };
}
export function validateDomainContext(context) {
  fields(context, [
    "schemaVersion",
    "revision",
    "modules",
    "definitions",
    "lemmas",
  ]);
  if (
    context.schemaVersion !== "lemma.domain.v1" ||
    context.revision !== MATHLIB_COMMIT
  )
    throw new Error("领域上下文版本无效。");
  for (const m of list(context.modules, DOMAIN_LIMITS.modules, "模块")) {
    fields(m, ["name", "file", "sourceSha256"]);
    moduleName(m.name);
    if (
      m.file !== m.name.replaceAll(".", "/") + ".lean" ||
      !isHash(m.sourceSha256)
    )
      throw new Error("模块来源身份无效。");
  }
  if (
    new Set(context.modules.map((m) => m.name)).size !== context.modules.length
  )
    throw new Error("模块重复。");
  list(context.definitions, DOMAIN_LIMITS.definitions, "定义");
  list(context.lemmas, DOMAIN_LIMITS.lemmas, "引理");
  for (const raw of [...context.definitions, ...context.lemmas]) {
    const definition = context.definitions.includes(raw);
    fields(
      raw,
      definition
        ? ["name", "type", "value", "meaning", "anchors", "dependsOn"]
        : ["name", "target", "proof", "purpose", "dependsOn"],
    );
    list(
      raw.dependsOn,
      DOMAIN_LIMITS.definitions + DOMAIN_LIMITS.lemmas,
      "声明依赖",
    ).forEach(definitionName);
    if (
      definition &&
      raw.dependsOn.some((n) => context.lemmas.some((l) => l.name === n))
    )
      throw new Error("定义不能依赖辅助引理。");
  }
  for (const c of orderedComponents(context)) {
    definitionName(c.name);
    if (c.kind === "definition") {
      validateLeanText(c.type, "定义类型", LEAN_RUNTIME.helperTargetCharacters);
      validateLeanText(
        c.value,
        "定义内容",
        LEAN_RUNTIME.helperTargetCharacters,
      );
    } else {
      validateLeanText(c.target, "引理目标", LEAN_RUNTIME.targetCharacters);
      validateLeanText(c.proof, "引理证明", LEAN_RUNTIME.proofCharacters);
    }
  }
  return context;
}
export function domainPrelude(context) {
  if (!context) return "";
  validateDomainContext(context);
  return orderedComponents(context)
    .map((c) =>
      c.kind === "definition"
        ? `noncomputable def LemmaPaper.${c.name} : (\n${c.type}\n) := (\n${c.value}\n)\n`
        : `theorem LemmaPaper.${c.name} : (\n${c.target}\n) := (\n${c.proof}\n)\n`,
    )
    .join("\n");
}
export function domainTerms(context) {
  return context
    ? orderedComponents(context).flatMap((c) =>
        c.kind === "definition" ? [c.type, c.value] : [c.target, c.proof],
      )
    : [];
}
export function domainIssues(context) {
  return (context?.definitions || []).map((d) => ({
    id: digest({ definition: d }).slice(0, 24),
    code: "domain_definition_fidelity",
    category: "definitions",
    detail: `请核对定义 LemmaPaper.${d.name} 与原文的对象、量词和条件：${d.meaning}。类型检查不证明语义忠实。`,
  }));
}
export function domainImports(profile, context) {
  return [
    ...new Set([
      ...profile.imports,
      ...(context?.modules || []).map((m) => m.name),
    ]),
  ];
}
