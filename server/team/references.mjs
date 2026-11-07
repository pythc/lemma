import { randomBytes } from "node:crypto";
import { argumentErrors } from "./tool-arguments.mjs";
import { toolError } from "./tool-errors.mjs";
const artifactKinds = new Set([
  "artifact",
  "selection",
  "workspace_revision",
  "environment_receipt",
]);
// The persisted registry is append-only. Index it incrementally so each saved
// tool result does not scan all historical references for every object again.
const indexes = new WeakMap();
function referenceIndex(run) {
  const entries = run.references || [];
  let index = indexes.get(run);
  if (!index || index.entries !== entries || index.length > entries.length) {
    index = {
      entries,
      length: 0,
      keys: new Map(),
      refs: new Map(),
      ids: new Map(),
    };
    indexes.set(run, index);
  }
  for (; index.length < entries.length; index.length++) {
    const r = entries[index.length];
    index.keys.set(JSON.stringify([r.kind, r.id, r.version]), r);
    index.refs.set(r.ref, r);
    const ids = index.ids.get(r.id) || [];
    ids.push(r);
    index.ids.set(r.id, ids);
  }
  return index;
}
export function registerReference(run, kind, id, version = null) {
  if (typeof id !== "string" || !id)
    throw Error("Reference requires an exact identity");
  run.referenceNamespace ||= randomBytes(12).toString("base64url");
  run.references ||= [];
  const old = referenceIndex(run).keys.get(JSON.stringify([kind, id, version]));
  if (old) return old.ref;
  const ref = `ref:${kind}:${run.referenceNamespace}:${(run.references.length + 1).toString(36)}`;
  run.references.push({ ref, kind, id, version });
  return ref;
}
export function resolveReference(
  run,
  value,
  expected = "any",
  field = "reference",
) {
  if (typeof value !== "string" || !value.startsWith("ref:")) {
    const kinds = Array.isArray(expected) ? expected : [expected];
    if (
      kinds.some((k) => artifactKinds.has(k)) &&
      (!/^[a-f0-9]{64}$/.test(value || "") ||
        (run.receipts &&
          !run.receipts.includes(value) &&
          run.sourceArtifact !== value))
    )
      throw toolError(
        "reference_invalid",
        `${field}: use a complete received artifact identity or its typed reference`,
        {
          fieldErrors: [
            { field, message: "invalid or foreign artifact identity" },
          ],
          dispatchState: "not_dispatched",
          navigation: {
            tool: "read_board",
            arguments: { section: "receipts" },
          },
        },
      );
    return value;
  }
  const r = referenceIndex(run).refs.get(value);
  const accepted = Array.isArray(expected) ? expected : [expected];
  if (
    !r ||
    !(
      accepted.includes("any") ||
      accepted.includes(r.kind) ||
      (accepted.includes("artifact") && artifactKinds.has(r.kind))
    )
  )
    throw toolError(
      "reference_invalid",
      `${field}: reference is absent from this review or has the wrong type`,
      {
        fieldErrors: [{ field, message: `expected ${accepted.join(" or ")}` }],
        dispatchState: "not_dispatched",
        navigation: {
          tool: "read_board",
          arguments: {},
          guidance:
            "Select an exact same-run typed reference. No fuzzy identity repair or execution occurred.",
        },
      },
    );
  return r.id;
}
export function resolveArguments(run, schema, value, at = "arguments") {
  const errors = [];
  const walk = (schema, value, at) => {
    if (schema["x-reference"]) {
      try {
        return resolveReference(run, value, schema["x-reference"], at);
      } catch (e) {
        if (e.code !== "reference_invalid") throw e;
        errors.push(e);
        return value;
      }
    }
    if (Array.isArray(value))
      return value.map((v, i) => walk(schema.items || {}, v, `${at}[${i}]`));
    if (value && typeof value === "object") {
      let props = { ...schema.properties };
      for (const key of ["oneOf", "anyOf"])
        for (const branch of schema[key] || [])
          if (!argumentErrors(branch, value).length)
            props = { ...props, ...branch.properties };
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          walk(props[k] || {}, v, `${at}.${k}`),
        ]),
      );
    }
    return value;
  };
  const resolved = walk(schema, value, at);
  if (errors.length)
    throw toolError(
      "reference_invalid",
      errors.map((e) => e.message).join("; "),
      {
        fieldErrors: errors.flatMap((e) => e.fieldErrors),
        navigation: errors[0].navigation,
        dispatchState: "not_dispatched",
      },
    );
  return resolved;
}

const fields = {
  artifactId: "artifact",
  inputArtifact: "artifact",
  resolvedInputArtifact: "artifact",
  artifact: "artifact",
  selectionId: "selection",
  targetId: "target",
  taskId: "task",
  actorId: "task",
  objectiveId: "objective",
  submissionId: "submission",
  workspaceId: "workspace",
  revisionArtifact: "workspace_revision",
  projectId: "project",
  environmentId: "environment",
  operationId: "operation",
  fromArtifact: "artifact",
};
export function referenceProjection(run, value) {
  const lookup = (id, expected) =>
    referenceIndex(run)
      .ids.get(id)
      ?.find(
        (r) =>
          r.id === id &&
          (!expected ||
            r.kind === expected ||
            (expected === "artifact" && artifactKinds.has(r.kind))),
      );
  const walk = (v, navigation = false) => {
    if (Array.isArray(v)) return v.map((x) => walk(x, navigation));
    if (!v || typeof v !== "object") return v;
    const out = Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        walk(x, navigation || k === "arguments" || k === "use"),
      ]),
    );
    const refs = {};
    for (const [k, x] of Object.entries(v))
      if (typeof x === "string") {
        const r = lookup(x, fields[k]);
        if ((fields[k] || k === "id") && r) refs[k] = r.ref;
      }
    // Executable navigation must remain valid tool input, without display metadata.
    if (navigation) Object.assign(out, refs);
    else if (Object.keys(refs).length) out.refs = refs;
    return out;
  };
  return walk(value);
}
export function registerRunObjects(run) {
  for (const [section, kind] of Object.entries({
    tasks: "task",
    targets: "target",
    objectives: "objective",
    submissions: "submission",
    operations: "operation",
    messages: "message",
  }))
    for (const o of run[section] || []) registerReference(run, kind, o.id);
}
export function registerArtifactReferences(run, kind, artifact, result) {
  registerReference(
    run,
    kind === "source_selection"
      ? "selection"
      : kind === "workspace_revision"
        ? "workspace_revision"
        : "artifact",
    artifact,
  );
  if (kind === "workspace_revision" && result.id)
    registerReference(run, "workspace", result.id);
  if (kind === "python_environment" && result.environmentId)
    registerReference(run, "environment", result.environmentId);
  if (kind === "workspace_lemma_plan" && result.projectId)
    registerReference(run, "project", result.projectId);
}
