// New internal cases; full blind + comparison protocol. Independent labels are
// deliberately not claimed. No schema retries or external-outcome replay.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { callModel, semanticModelConfig } from "../server/model.mjs";
import { digest } from "../server/evidence.mjs";
import { contentTree } from "../server/toolchain-tree.mjs";
import { createContract } from "../server/contracts.mjs";
import { inspectTarget } from "../server/lean-query.mjs";
import {
  ANCHOR_PROTOCOL,
  COMPACT_AUDIT_PROMPT,
} from "../server/source-anchor-index.mjs";
import {
  blindSemanticInput,
  COMPARISON_PROMPT,
  mergeSemanticReviews,
} from "../server/semantic-blind.mjs";
import {
  semanticReview,
  validateAlignment,
  ALIGNMENT_CATEGORIES,
} from "../server/semantics.mjs";
import {
  SOURCE_AUDIT_PROTOCOL,
  validateSourceAudit,
} from "../server/source-audit.mjs";
import { infrastructureFailure } from "../server/model-delivery.mjs";
const [configRoot, out] = process.argv.slice(2);
await mkdir(out, { recursive: false });
const save = (n, v) =>
  writeFile(path.join(out, n), JSON.stringify(v, null, 2), { flag: "wx" });
const dataset = JSON.parse(
  await readFile("evaluation/sets/third-batch-semantics/inputs.json", "utf8"),
);
const implementation = await contentTree(process.cwd(), ["server", "shared"]);
const config = {
  ...(await semanticModelConfig(configRoot)),
  concurrency: 1,
  reasoningEffort: "low",
  maxOutputTokens: 4000,
  timeoutMs: 60000,
};
await save("plan.json", {
  dataset,
  datasetHash: digest(dataset),
  implementation,
  model: {
    name: config.model,
    host: new URL(config.endpoint).host,
    requestedEffort: "low",
  },
  budget: {
    cases: 20,
    repetitions: 3,
    maxCallsPerCase: 2,
    maxRequests: 120,
    maxOutputTokens: 4000,
    timeoutMs: 60000,
  },
  thresholds: {
    complete: 57,
    faithfulAccepted: 27,
    falseAccepted: 0,
    ambiguityFalselyCleared: 0,
  },
  independentExpertLabels: false,
  secondFamily: "not_accepted",
  scope: "internal_authored_full_protocol_not_independent_accuracy",
});
let calls = 0,
  halt = false;
const rows = [],
  native = new Map();
async function invoke(system, input) {
  const id = ++calls;
  try {
    const v = await callModel(config, {
      role: "R04",
      system,
      input,
      maxTokens: 4000,
    });
    await save(`call-${id}.json`, v);
    return v;
  } catch (e) {
    await save(`call-${id}-failed.json`, {
      message: e.message,
      record: e.modelRecord || null,
    });
    throw e;
  }
}
for (let repeat = 0; repeat < 3; repeat++)
  for (const c of dataset.cases) {
    const row = {
      caseId: c.id,
      repeat,
      status: "not_run",
      complete: false,
      calls: 0,
    };
    if (!halt) {
      const before = calls;
      try {
        const paperSha256 = digest(c.pages),
          source = {
            text: c.quote,
            paperSha256,
            pageIndex: c.pageIndex,
            artifact: digest(c),
          };
        const contract = createContract(
          source,
          {
            label: c.id,
            quote: c.quote,
            statement: c.quote,
            assumptions: [],
            leanTarget: c.candidate,
          },
          "std-v1",
        );
        const context = {
          paperSha256,
          selectedPage: c.pageIndex,
          pages: c.pages,
          supplements: [],
          omittedPages: [],
          semanticProtocol: SOURCE_AUDIT_PROTOCOL,
          anchorProtocol: ANCHOR_PROTOCOL,
        };
        // A disclosed supplied candidate table, not gold, proof, or translator authority.
        const alignment = validateAlignment(
          ALIGNMENT_CATEGORIES.map((category) => ({
            category,
            explanation: "候选原文与目标对应，尚未复核其正确性。",
            leanFragment: c.candidate,
            anchors: [{ pageIndex: c.pageIndex, quote: c.quote }],
          })),
          contract,
          context,
        );
        let check = native.get(c.id);
        if (!check) {
          check = await inspectTarget(contract);
          native.set(c.id, check);
          await save(`native-${c.id}.json`, { contract, check });
        }
        if (check.status !== "well_typed")
          throw Error("Native candidate type inspection failed");
        const input = blindSemanticInput(contract, context),
          blind = await invoke(COMPACT_AUDIT_PROMPT, input);
        semanticReview(contract, context, [], blind.parsed, check);
        validateSourceAudit(blind.parsed.sourceAudit, contract, context);
        const comparison = await invoke(COMPARISON_PROMPT, {
          ...input,
          stage: "comparison_after_immutable_blind_review",
          blindResponse: blind.parsed,
          alignment,
          typeInspection: {
            status: check.status,
            targetStructure: check.targetStructure || null,
          },
        });
        const review = mergeSemanticReviews(
          contract,
          context,
          alignment,
          blind.parsed,
          comparison.parsed,
          check,
        );
        row.complete = true;
        row.status = review.checks.some((x) => x.status === "concern")
          ? "rejected"
          : review.issues.length
            ? "unknown"
            : "accepted";
        row.review = review;
      } catch (e) {
        row.status = "error";
        row.error = e.message;
        row.model = e.modelRecord || null;
        halt = infrastructureFailure(e);
      }
      row.calls = calls - before;
    }
    rows.push(row);
    await save(`case-${repeat}-${c.id}.json`, row);
    console.log(
      JSON.stringify({
        caseId: c.id,
        repeat,
        status: row.status,
        calls: row.calls,
      }),
    );
  }
const gold = JSON.parse(
  await readFile(
    "evaluation/sets/third-batch-semantics/evaluator-gold.json",
    "utf8",
  ),
);
if (gold.datasetHash !== digest(dataset)) throw Error("Gold identity mismatch");
for (const r of rows)
  r.reference = gold.labels.find((x) => x.caseId === r.caseId);
const metrics = {
  complete: rows.filter((r) => r.complete).length,
  faithfulAccepted: rows.filter(
    (r) => r.reference.expectation === "accept" && r.status === "accepted",
  ).length,
  falseAccepted: rows.filter(
    (r) => r.reference.expectation === "reject" && r.status === "accepted",
  ).length,
  ambiguityFalselyCleared: rows.filter(
    (r) => r.reference.expectation === "unknown" && r.status === "accepted",
  ).length,
};
await save("report.json", {
  rows,
  calls,
  metrics,
  internalThresholdsPassed:
    metrics.complete >= 57 &&
    metrics.faithfulAccepted >= 27 &&
    metrics.falseAccepted === 0 &&
    metrics.ambiguityFalselyCleared === 0,
  independentQualityAccepted: false,
  crossFamilyValidated: false,
  implementationUnchanged:
    (await contentTree(process.cwd(), ["server", "shared"])).sha256 ===
    implementation.sha256,
});
console.log(JSON.stringify({ complete: true, calls, metrics }));
