import {
  moduleInput,
  helperNameInput,
} from "../../shared/agent-tool-fields.mjs";
import { LIBRARY_PROFILES } from "../../shared/library-profiles.mjs";
import {
  assertSupportedSchema,
  validateToolArguments,
} from "./tool-arguments.mjs";
import { boardSections, boardKinds } from "./board.mjs";
const str = { type: "string" },
  arr = { type: "array", items: str },
  obj = { type: "object", additionalProperties: true };
const tool = (name, description, properties = {}, required = []) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties: {
      ...properties,
      _execution: {
        type: "object",
        additionalProperties: false,
        properties: {
          actionId: { type: "string" },
          mode: { enum: ["connect", "new"] },
          reason: { type: "string" },
        },
      },
    },
    required,
    additionalProperties: false,
  },
});
export const TEAM_TOOLS = [
  tool(
    "lean_explore",
    "Optional warm Lean LSP diagnostic exploration in a version-bound scratch. Does not issue proof certificates or close objectives. Three managed host execution groups; cancellation invalidates the worker. Ordinary lean_draft and independent check_lean remain available.",
    { code: str, profile: str, modules: { type: "array", items: str } },
    ["code"],
  ),
  tool(
    "read_resume_context",
    "Read your pending/unknown actions and received checks for this task version. Navigation, not a proof or a forced workflow.",
    {
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  ),
  tool(
    "find_operation",
    "Find received operations by exact actor/task version, tool or action identity. Never executes or retries. Read the returned operation IDs.",
    {
      name: str,
      actorId: str,
      version: { type: "integer", minimum: 1 },
      actionId: str,
      status: str,
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  ),
  tool(
    "read_execution_history",
    "Query public same-run environment, search, diagnostic and failure receipts across Agents. Read exact evidence before reuse; no private reasoning or automatic replay.",
    {
      kind: str,
      codeSha256: str,
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1 },
    },
  ),
  tool(
    "inspect_execution_environment",
    "Inspect actual isolated Lean/Python inventory. No preparation or proof check. Imports may be prepared by the optional prepare_modules tool.",
    { imports: arr, environmentId: str },
  ),
  tool(
    "prepare_python_environment",
    "Prepare reusable isolated Python packages from PyPI wheels with exact versions. No system environment changes; list transitive dependencies explicitly. Returns environmentId for run_python.",
    {
      packages: {
        type: "array",
        items: {
          type: "object",
          properties: { name: str, version: str },
          required: ["name", "version"],
          additionalProperties: false,
        },
      },
    },
    ["packages"],
  ),
  tool(
    "reuse_verified_check",
    "Explicitly reuse the same target and proof already independently accepted in this run. Validates current native environment identity; records provenance, NOT a new Lean execution. Any changed target/proof/environment requires check_lean.",
    {
      targetId: str,
      proof: str,
      mode: { enum: ["proof", "counterexample"] },
      acceptanceArtifactId: str,
      replayArtifactId: str,
    },
    ["targetId", "proof", "acceptanceArtifactId", "replayArtifactId"],
  ),
  tool(
    "workspace_list",
    "List this review's persistent proof projects and exact read handles. Available in every role; no mandatory workspace workflow.",
    {},
  ),
  tool(
    "get_operation",
    "Retrieve the original durable operation by ID; never repeats execution.",
    { operationId: str },
    ["operationId"],
  ),
  tool(
    "list_operations",
    "Page received operations, including late results and unknown outcomes.",
    {
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1 },
      actorId: str,
      status: str,
    },
  ),
  tool(
    "read_object",
    "Read a board object UUID or an exact artifact hash. Copy the read handle returned by read_board; kind is optional. Artifact hashes support path/offset/limit.",
    {
      id: str,
      kind: { enum: boardKinds },
      path: arr,
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1 },
    },
    ["id"],
  ),
  tool(
    "save_progress",
    "Checkpoint public progress without completing the task or creating acceptance. Continue tools freely afterward.",
    { summary: str, artifactIds: arr, nextAction: str },
    ["summary"],
  ),
  tool(
    "locate_source",
    "Find exact or whitespace-only candidates in the immutable paper. Returns ORIGINAL text and offsets; no mathematical symbols are normalized.",
    {
      query: str,
      pageIndex: { type: "integer", minimum: 0 },
      ignoreWhitespace: { type: "boolean" },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1 },
    },
    ["query"],
  ),
  tool(
    "read_source_span",
    "Select original UTF-16 text offsets without retyping. Use returned {selectionId} directly in sourceSpans or locatorSelectionId for a target locator. Original source identity remains checked.",
    {
      pageIndex: { type: "integer", minimum: 0 },
      start: { type: "integer", minimum: 0 },
      end: { type: "integer", minimum: 1 },
    },
    ["pageIndex", "start", "end"],
  ),

  tool(
    "discover_tools",
    "Read tool contracts and examples. No phase-specific tool restrictions.",
  ),
  tool(
    "read_board",
    "Read compact paginated navigation; full evidence remains accessible through read_object/read_evidence.",
    {
      section: { enum: boardSections },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1 },
      actorId: str,
      status: str,
    },
  ),
  tool(
    "read_source",
    "Read immutable PDF text. Omit pages for all pages. Page indices are zero-based.",
    { pages: { type: "array", items: { type: "integer", minimum: 0 } } },
  ),
  tool(
    "view_page",
    "Inspect the rendered original PDF page and glyph geometry; use for ambiguous formulas.",
    { pageIndex: { type: "integer", minimum: 0 } },
    ["pageIndex"],
  ),
  tool(
    "create_task",
    "Create an independent task Agent; returns immediately. Goal and acceptance criteria must be explicit. No prescribed depth or role lanes.",
    { title: str, goal: str, criteria: str, dependsOn: arr, objectiveIds: arr },
    ["title", "goal", "criteria"],
  ),
  tool(
    "message_agent",
    "Send a public factual message to an existing task ID or all. Does not change its acceptance criteria.",
    { to: str, message: str },
    ["to", "message"],
  ),
  tool(
    "save_note",
    "Persist public working notes, exact diagnostics and next actions. Never private chain of thought.",
    { text: str },
    ["text"],
  ),
  tool(
    "yield_work",
    "Release the CLI slot while waiting for named tasks to reach an outcome. End your turn immediately.",
    { taskIds: arr, operationIds: arr },
    [],
  ),
  tool(
    "submit_task",
    "Submit this task version for automatic independent acceptance. resultKind distinguishes report, translation, lemma, theorem, counterexample, author_route. Theorem/lemma require proof mode; counterexample requires counterexample mode (a proof of the exact negation). An author_route submission is an Agent-reviewed correspondence proposal plus exact-target checks, not an automatic original-route certificate. Artifact IDs must come from this run.",
    {
      summary: str,
      resultKind: {
        enum: [
          "report",
          "translation",
          "lemma",
          "theorem",
          "counterexample",
          "author_route",
        ],
      },
      artifactIds: arr,
      targetIds: arr,
      limitations: arr,
      objectiveIds: arr,
      afterAcceptance: { enum: ["complete", "continue"] },
    },
    ["summary", "resultKind", "artifactIds", "targetIds", "limitations"],
  ),
  tool(
    "assess_submission",
    "Acceptance Agent only. Independently recheck evidence then pass, rework, or unresolved. Pass never substitutes for native Lean.",
    {
      verdict: { enum: ["pass", "rework", "unresolved"] },
      explanation: str,
      issues: arr,
      replayIds: arr,
      objectiveDecisions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            objectiveId: str,
            version: { type: "integer", minimum: 1 },
            outcome: { enum: ["continue", "covered", "proved", "refuted"] },
            explanation: str,
            sourceAssessment: str,
            evidenceIds: arr,
            scopeDisposition: { enum: ["no_mathematical_claims"] },
          },
          required: ["objectiveId", "version", "outcome", "explanation"],
          additionalProperties: false,
        },
      },
      stopVerdict: { enum: ["continue", "stop"] },
      stopExplanation: str,
      reviewedObjectiveIds: arr,
    },
    ["verdict", "explanation", "issues", "replayIds"],
  ),
  tool(
    "finish_review",
    "Propose ending this run, independently assessed separately from report quality. Not a progress-report tool. stopProposal: {reason:goals_resolved|no_viable_path|external_blocked,explanation,objectives:[{objectiveId,version,attemptIds,whyStop,nextOptions}]}. Every unresolved required objective needs actual work evidence when stopping incomplete.",
    {
      summary: str,
      limitations: arr,
      artifactIds: arr,
      stopProposal: {
        type: "object",
        properties: {
          reason: {
            enum: ["goals_resolved", "no_viable_path", "external_blocked"],
          },
          explanation: str,
          objectives: {
            type: "array",
            items: {
              type: "object",
              properties: {
                objectiveId: str,
                version: { type: "integer", minimum: 1 },
                attemptIds: arr,
                whyStop: str,
                nextOptions: str,
              },
              required: [
                "objectiveId",
                "version",
                "attemptIds",
                "whyStop",
                "nextOptions",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["reason", "explanation"],
        additionalProperties: false,
      },
    },
    ["summary", "limitations", "stopProposal"],
  ),
  tool(
    "register_objective",
    "Retain a mathematical objective before or after formalization. No prescribed order. Source context may justify an auxiliary lemma not literally stated by the paper. Scope objectives link major goals via dependencies; a partial proof does not close the scope.",
    {
      title: str,
      description: str,
      kind: { enum: ["scope", "theorem", "lemma", "author_route"] },
      sourceSpans: { type: "array", items: obj },
      dependencies: arr,
      targetId: str,
      required: { type: "boolean" },
      parentId: str,
    },
    ["title", "description", "kind"],
  ),
  tool(
    "revise_objective",
    "Publish a new objective version. Rebinding a target or changing dependencies invalidates its old acceptance and dependent results; never silently weaken the source objective.",
    {
      objectiveId: str,
      reason: str,
      title: str,
      description: str,
      sourceSpans: { type: "array", items: obj },
      dependencies: arr,
      targetId: str,
      required: { type: "boolean" },
    },
    ["objectiveId", "reason"],
  ),
  tool(
    "record_attempt",
    "Persist an objective's actual attempt, diagnostics and next options. Identical repeats receive feedback, not a fixed retry cap.",
    {
      objectiveId: str,
      approach: str,
      result: str,
      nextAction: str,
      artifactIds: arr,
    },
    ["objectiveId", "approach", "result", "nextAction", "artifactIds"],
  ),
  tool(
    "read_evidence",
    "Read an immutable artifact using its complete 64-character hash. Copy returned read handles and paths, never infer IDs. Arrays, strings and object entries support offset/limit. Large source material should use read_source.",
    {
      artifactId: str,
      path: arr,
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1 },
    },
    ["artifactId"],
  ),
  tool(
    "publish_artifact",
    "Save a draft, proof skeleton, source correspondence or other public deliverable; it cannot create a proof certificate.",
    { title: str, content: obj },
    ["title", "content"],
  ),
  tool(
    "publish_route",
    "Publish a source proof route. steps: {id,targetId,dependsOn:[stepId],sourceSpans:[{pageIndex,quote}],completion:boolean}. Each step needs a closed formal target; independent acceptance replays every step and root. Semantic route completeness remains Agent-reviewed.",
    { rootTargetId: str, steps: { type: "array", items: obj } },
    ["rootTargetId", "steps"],
  ),
  tool(
    "list_libraries",
    "List profiles and versioned environments. Profiles are starting points; modules can be added.",
  ),
  tool(
    "search_mathlib",
    "Search pinned Mathlib sources, including before any target exists.",
    {
      queries: arr,
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1 },
    },
    ["queries"],
  ),
  tool(
    "search_premises",
    "Rank pinned qualified declarations by name, type and current goal terms. Candidates are not proof; use native Lean to test applicability. Pagination and module filtering keep truncated results accessible.",
    {
      queries: arr,
      targetId: str,
      goal: str,
      module: str,
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1 },
    },
    ["queries"],
  ),
  tool(
    "read_library",
    "Read pinned Mathlib source or an inspected external repository module.",
    {
      module: str,
      startLine: { type: "integer" },
      lineCount: { type: "integer" },
      libraryReceipt: str,
    },
    ["module"],
  ),
  tool(
    "find_libraries",
    "Discover public Lean library repositories.",
    { query: str },
    ["query"],
  ),
  tool(
    "inspect_library",
    "Inspect an immutable repository version and toolchain compatibility.",
    { repo: str, revision: str },
    ["repo"],
  ),
  tool(
    "library_versions",
    "Find compatible repository revisions.",
    { repo: str, match: str },
    ["repo"],
  ),
  tool(
    "install_library",
    "Install compatible immutable modules in a separate environment. Uses inspect_library receipt.",
    { receiptId: str, modules: arr },
    ["receiptId", "modules"],
  ),
  tool(
    "prepare_modules",
    "Prepare pinned Mathlib modules without needing a fixed formal target.",
    { modules: arr },
    ["modules"],
  ),
  tool(
    "propose_target",
    "Publish a NEW formal target version. Uses exact source quote and full source spans; old targets/evidence remain immutable. Definitions and module imports are optional.",
    {
      proposal: obj,
      source: {
        type: "object",
        properties: {
          locator: {
            oneOf: [
              {
                type: "object",
                properties: {
                  kind: { const: "selection" },
                  ref: { type: "string", "x-reference": "selection" },
                },
                required: ["kind", "ref"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { const: "literal" },
                  pageIndex: { type: "integer", minimum: 0 },
                  quote: { type: "string", minLength: 1 },
                },
                required: ["kind", "pageIndex", "quote"],
                additionalProperties: false,
              },
            ],
          },
          coverage: { type: "array", minItems: 1, items: obj },
        },
        required: ["locator", "coverage"],
        additionalProperties: false,
      },
      locatorSelectionId: str,
      pageIndex: { type: "integer" },
      sourceSpans: { type: "array", items: obj },
      profile: { enum: LIBRARY_PROFILES.map((p) => p.id) },
      modules: arr,
      definitions: { type: "array", items: obj },
      lemmas: { type: "array", items: obj },
      externalReceiptIds: arr,
      environment: str,
      replaces: str,
      kind: { enum: ["claim", "lemma", "route_step"] },
      objectiveId: str,
    },
    ["proposal", "kind"],
  ),
  tool(
    "workspace_create",
    "Create a persistent versioned Lean source project, or fork a saved workspace revision / diagnostic lean_draft artifact (fromArtifact). Math environment is pinned; no historical paper proofs are imported.",
    { title: str, targetId: str, modules: arr, fromArtifact: str },
    ["title"],
  ),
  tool(
    "workspace_read",
    "Read the saved project and its versioned files. Other Agents in this review can inspect and fork it.",
    { workspaceId: str, file: str, revisionArtifact: str },
    ["workspaceId"],
  ),
  tool(
    "workspace_write",
    "Edit project files with an expected revision to prevent overwriting concurrent work. files is a map from relative .lean filenames to contents; deletion requires deleteFiles. Every revision retains its predecessor.",
    {
      workspaceId: str,
      expectedRevision: { type: "integer" },
      files: obj,
      deleteFiles: arr,
      modules: arr,
    },
    ["workspaceId", "expectedRevision", "files"],
  ),
  tool(
    "workspace_merge",
    "Merge selected files from another branch. expectedFiles maps file names to current content hashes (or null for absent); conflicting edits are returned instead of overwritten.",
    {
      workspaceId: str,
      expectedRevision: { type: "integer" },
      fromArtifact: str,
      expectedFiles: obj,
    },
    ["workspaceId", "expectedRevision", "fromArtifact", "expectedFiles"],
  ),
  tool(
    "workspace_check",
    "Build selected Lean files and local imports in the pinned environment. Compiler output includes remaining goals and local hypotheses. No target required. Diagnostic build success never certifies a paper theorem.",
    { workspaceId: str, revisionArtifact: str, files: arr },
    ["workspaceId"],
  ),
  tool(
    "check_workspace_target",
    "Check a self-contained proof term saved in a workspace file against an exact target, producing native proof evidence. Use lemma assembly for dependent helpers; arbitrary scratch declarations cannot be trusted as imports.",
    {
      workspaceId: str,
      revisionArtifact: str,
      file: str,
      targetId: str,
      mode: { enum: ["proof", "counterexample"] },
    },
    ["workspaceId", "file", "targetId"],
  ),
  tool(
    "plan_lemmas",
    "Create a freely chosen lemma decomposition for an exact target, optionally nested under {projectId,name}. parts: [{name,target,purpose,dependsOn}]; assembly is a Lean proof of the root conditional on those lemmas. This validates interfaces, not the lemmas. No prescribed decomposition depth.",
    {
      targetId: str,
      parts: { type: "array", items: obj },
      assembly: str,
      parent: obj,
    },
    ["targetId", "parts", "assembly"],
  ),
  tool(
    "read_lemma_projects",
    "Read durable lemma plans, checked helpers, failures and missing obligations in this review.",
    {},
  ),
  tool(
    "check_lemma",
    "Prove a selected helper's exact dependency-quantified interface. The result is conditional until its predecessors are proved and the root is assembled.",
    { projectId: str, name: str, proof: str },
    ["projectId", "name", "proof"],
  ),
  tool(
    "assemble_lemmas",
    "Compose actually proved helpers and recheck the fully expanded root. Missing helpers cannot be assumed. A failed connection returns diagnostics for free revision.",
    { projectId: str, assembly: str },
    ["projectId"],
  ),
  tool(
    "inspect_target",
    "Type check a target and query declaration signatures. This is not a proof.",
    { targetId: str, names: arr, definitions: arr },
    ["targetId"],
  ),
  tool(
    "lean_draft",
    "Compile arbitrary exploratory Lean code in an isolated directory, including definitions, holes and queries, before any formal target. Diagnostic only; never a certificate. Fixed Mathlib imports in code are prepared automatically without altering code. Optional modules add dependencies. reuseArtifactId explicitly reuses an identical same-run diagnostic and environment; never a fresh check.",
    {
      code: str,
      profile: { enum: LIBRARY_PROFILES.map((p) => p.id) },
      modules: arr,
      reuseArtifactId: str,
    },
    ["code"],
  ),
  tool(
    "check_lean",
    "Check an exact target with a self-contained proof. Identical same-task-version requests reconnect to their original operation/result; this is NOT a new check of the current environment. Set _execution.mode to new with a reason for a deliberate fresh check, or reuse_verified_check for validated proof reuse.",
    { targetId: str, proof: str, mode: { enum: ["proof", "counterexample"] } },
    ["targetId", "proof"],
  ),
  tool(
    "run_python",
    "Run isolated finite computation. Not a theorem certificate.",
    { code: str, timeoutMs: { type: "integer" }, environmentId: str },
    ["code"],
  ),
  tool(
    "read_reference",
    "Download and extract a public reference, recording identity and availability.",
    { url: str },
    ["url"],
  ),
];

TEAM_TOOLS.push(
  tool(
    "select_source",
    "Select an original paragraph, a whole page, or a unique literal substring within an existing selection. No formula normalization or automatic ambiguity resolution.",
    {
      pageIndex: { type: "integer", minimum: 0 },
      paragraphIndex: { type: "integer", minimum: 0 },
      selectionId: str,
      text: str,
      occurrence: { type: "integer", minimum: 0 },
    },
    [],
  ),
);
// One executable contract supplies MCP schemas, preflight, and reference resolution.
const refFields = {
  artifactId: "artifact",
  artifactIds: "artifact",
  evidenceIds: "artifact",
  replayIds: "artifact",
  attemptIds: "artifact",
  receiptId: "artifact",
  libraryReceipt: "artifact",
  acceptanceArtifactId: "artifact",
  replayArtifactId: "artifact",
  reuseArtifactId: "artifact",
  externalReceiptIds: "artifact",
  fromArtifact: "artifact",
  revisionArtifact: "workspace_revision",
  selectionId: "selection",
  locatorSelectionId: "selection",
  targetId: "target",
  rootTargetId: "target",
  targetIds: "target",
  taskId: "task",
  actorId: "task",
  taskIds: "task",
  objectiveId: "objective",
  objectiveIds: "objective",
  reviewedObjectiveIds: "objective",
  workspaceId: "workspace",
  projectId: "project",
  operationId: "operation",
  operationIds: "operation",
  environmentId: "environment",
  replaces: "target",
};
const selectionSchema = {
  type: "object",
  properties: {
    selectionId: { type: "string", "x-reference": "selection" },
    pageIndex: { type: "integer", minimum: 0 },
    start: { type: "integer", minimum: 0 },
    end: { type: "integer", minimum: 1 },
    quote: { type: "string" },
    sourceRef: { type: "string" },
  },
  additionalProperties: false,
};
function annotate(schema) {
  for (const [k, s] of Object.entries(schema.properties || {})) {
    if (refFields[k]) {
      const item = s.type === "array" ? s.items : s;
      item["x-reference"] = refFields[k];
    }
    if (k === "sourceSpans" || k === "coverage")
      s.items = structuredClone(selectionSchema);
    annotate(s);
  }
  if (schema.items) annotate(schema.items);
  for (const k of ["oneOf", "anyOf", "allOf"])
    for (const s of schema[k] || []) annotate(s);
}
for (const t of TEAM_TOOLS) {
  // Do not mutate shared primitive schema objects used by unrelated fields.
  t.inputSchema = JSON.parse(JSON.stringify(t.inputSchema));
  if (
    t.inputSchema.properties.modules &&
    [
      "prepare_modules",
      "propose_target",
      "lean_draft",
      "workspace_create",
    ].includes(t.name)
  )
    t.inputSchema.properties.modules.items = structuredClone(moduleInput);
  if (t.name === "plan_lemmas") {
    t.inputSchema.properties.parts = {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          name: structuredClone(helperNameInput),
          target: { type: "string", minLength: 1 },
          purpose: { type: "string", minLength: 1, maxLength: 1200 },
          dependsOn: { type: "array", items: structuredClone(helperNameInput) },
          proof: { type: "string" },
        },
        required: ["name", "target", "purpose", "dependsOn"],
        additionalProperties: false,
      },
    };
    t.inputSchema.properties.parent = {
      type: "object",
      properties: {
        projectId: { type: "string" },
        name: structuredClone(helperNameInput),
      },
      required: ["projectId", "name"],
      additionalProperties: false,
    };
  }
  if (t.name === "check_lemma")
    t.inputSchema.properties.name = structuredClone(helperNameInput);
  if (t.name === "propose_target")
    t.inputSchema.properties.proposal = {
      type: "object",
      properties: {
        label: { type: "string", minLength: 1 },
        statement: { type: "string", minLength: 1 },
        assumptions: { type: "array", items: { type: "string" } },
        leanTarget: { type: "string", minLength: 1 },
        quote: { type: "string" },
      },
      required: ["label", "statement", "assumptions", "leanTarget"],
      additionalProperties: true,
    };
  annotate(t.inputSchema);
  if (t.name === "read_object")
    t.inputSchema.properties.id["x-reference"] = "any";
  if (t.name === "message_agent")
    t.inputSchema.properties.to["x-reference"] = "task";
  if (t.name === "create_task")
    t.inputSchema.properties.dependsOn.items["x-reference"] = "task";
  if (["register_objective", "revise_objective"].includes(t.name)) {
    t.inputSchema.properties.dependencies.items["x-reference"] = "objective";
    if (t.inputSchema.properties.parentId)
      t.inputSchema.properties.parentId["x-reference"] = "objective";
  }
  if (t.name === "propose_target") {
    t.inputSchema.oneOf = [
      {
        required: ["source"],
        not: {
          anyOf: [
            { required: ["sourceSpans"] },
            { required: ["locatorSelectionId"] },
            { required: ["pageIndex"] },
          ],
        },
      },
      {
        required: ["sourceSpans"],
        not: { required: ["source"] },
        anyOf: [
          { required: ["locatorSelectionId"] },
          { required: ["pageIndex"] },
        ],
      },
    ];
    t.description +=
      ' Preferred source: {locator:{kind:"selection",ref},coverage:[{selectionId}]}; omit proposal.quote in selection mode. Literal mode uses {kind:"literal",pageIndex,quote}. Legacy locator fields remain a separate mode. Profiles are presets, not research scope restrictions.';
  }
  assertSupportedSchema(t.inputSchema);
}
export function validateToolCall(name, args) {
  const schema = TEAM_TOOLS.find((t) => t.name === name)?.inputSchema;
  if (!schema) throw Error("Unknown tool");
  try {
    validateToolArguments(schema, args);
  } catch (e) {
    if (
      name === "propose_target" &&
      !args.source?.locator &&
      !args.locatorSelectionId &&
      args.pageIndex === undefined
    )
      e.code = "source_locator_missing";
    else if (
      args.profile !== undefined &&
      !LIBRARY_PROFILES.some((p) => p.id === args.profile)
    )
      e.code = "profile_unsupported";
    throw e;
  }
  return schema;
}
