import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { createContract } from "../server/contracts.mjs";
import { freshProofSession } from "../server/proof-autonomy.mjs";
import { executionContext } from "../server/execution-context.mjs";
import { DeepProofHarness } from "../server/deep-harness.mjs";
import {
  OriginalProofEngine,
  replayOriginalProof,
} from "../server/original-proof.mjs";
import { checkProof } from "../server/lean.mjs";
test(
  "real SDK candidates retain their required pinned imports after invalid final metadata and close under a fresh native source replay",
  { timeout: 240000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-native-received-"));
    const store = new EvidenceStore(dir);
    await store.init();
    const text = "Use reflexivity, then pair it with truth.";
    const sourceArtifact = await store.put("explicit_native_cache_fixture", {
      text,
      paperSha256: sha256(text),
      pageIndex: 0,
      pages: [{ index: 0, text }],
    });
    const context = { pages: [{ pageIndex: 0, text }], supplements: [] };
    const contextArtifact = await store.put("explicit_context", context, [
      sourceArtifact,
    ]);
    const translationArtifact = await store.put(
      "explicit_fixture_translation",
      { scope: "scripted fixture" },
      [sourceArtifact],
    );
    const contract = createContract(
      {
        text,
        artifact: sourceArtifact,
        paperSha256: sha256(text),
        pageIndex: 0,
      },
      {
        label: "fixture",
        quote: text,
        statement: "execution fixture",
        assumptions: [],
        leanTarget: "(∀ n : Nat, n = n) ∧ True",
      },
      "analysis-continuity-v1",
      { contextArtifact, translationArtifact },
    );
    const contractArtifact = await store.put("explicit_contract", contract, [
      sourceArtifact,
    ]);
    const graph = {
      steps: [
        {
          name: "Fact",
          title: "reflexivity",
          kind: "explicit",
          anchors: [{ pageIndex: 0, quote: text }],
          target: "∀ n : Nat, n = n",
          dependsOn: [],
          explanation: "fixture",
        },
        {
          name: "Truth",
          title: "truth",
          kind: "explicit",
          anchors: [{ pageIndex: 0, quote: text }],
          target: "True",
          dependsOn: [],
          explanation: "fixture",
        },
      ],
      assembly: "by intro h1 h2; exact ⟨h1,h2⟩",
      policy: {},
      methodClaims: [],
      limitations: [],
    };
    const owner = {
      id: randomUUID(),
      engine: "original-proof-v1",
      status: "running",
      autonomy: freshProofSession(),
      contract,
      sourceArtifact,
      paperSha256: contract.paperSha256,
    };
    await store.saveRun(owner);
    const harness = new DeepProofHarness({ store, checker: checkProof });
    let phase = "first",
      constructionCalls = 0,
      audits = 0;
    const engine = new OriginalProofEngine({
      store,
      checker: checkProof,
      proofWorkspace: false,
      limits: { maxAttempts: 1, maxPlans: 1 },
      model: async (cfg, r) => {
        let parsed;
        if (r.role === "R06_GRAPH") parsed = graph;
        else if (r.role === "R06_ALIGN")
          parsed = {
            coverage: "complete",
            missingSteps: [],
            checks: r.input.graph.steps.map((s) => ({
              name: s.name,
              status: "faithful",
              explanation: "fixture",
              anchors: s.anchors,
            })),
            policyAdditions: {},
            summary: "fixture",
          };
        else if (["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role)) {
          audits++;
          parsed = {
            status: "faithful",
            explanation: "independent scripted route fixture",
          };
        } else if (["R06_STEP", "R06_REPAIR"].includes(r.role)) {
          assert.equal(
            phase,
            "first",
            "no new construction request may be made after candidate recovery",
          );
          constructionCalls++;
          const worker = await harness.run({
            config: { model: "scripted" },
            contract: r.input.contract,
            inputs: [sourceArtifact],
            goal:
              "explicit native cache fixture local target: " +
              r.input.contract.leanTarget,
            routeContext: { ...r.input, autonomy: owner.autonomy },
            maxCalls: 4,
          });
          return worker;
        } else
          parsed = {
            kind: "construction",
            explanation: "fixture preserves unavailable state",
            modules: [],
            queries: [],
          };
        return { parsed, record: { scripted: true } };
      },
    });
    // Each worker checks a real term, then returns malformed route metadata.
    // This is an explicit scripted executor fixture, not paper proving evidence.
    harness.model = async (_cfg, r) => {
      const tools = r.messages.filter((m) => m.role === "tool");
      if (!tools.length)
        return {
          message: {
            content: null,
            tool_calls: [
              {
                id: "imports",
                function: {
                  name: "add_mathlib_modules",
                  arguments: JSON.stringify({
                    modules: ["Mathlib.Analysis.Convex.Function"],
                  }),
                },
              },
            ],
          },
          record: { scripted: true },
        };
      if (tools.length === 1) {
        const instruction = r.messages
          .filter((m) => m.role === "user")
          .map((m) => String(m.content))
          .join("\n");
        const proof = instruction.includes("∀ n : Nat, n = n")
          ? "by intro n; have h : ConvexOn ℝ (Set.univ : Set ℝ) (fun _ : ℝ => (0 : ℝ)) := convexOn_const 0 convex_univ; exact rfl"
          : "by trivial";
        return {
          message: {
            content: null,
            tool_calls: [
              {
                id: "check",
                function: {
                  name: "check_lean",
                  arguments: JSON.stringify({ proof }),
                },
              },
            ],
          },
          record: { scripted: true },
        };
      }
      return {
        message: {
          content: JSON.stringify({
            mode: "proof",
            proof: "by trivial",
            route: "invalid_fixture_route",
            explanation: "invalid route only",
          }),
        },
        record: { scripted: true },
      };
    };
    try {
      const input = {
        contract,
        context,
        sourceArtifact,
        contractArtifact,
        contextArtifact,
        config: { model: "scripted" },
        autonomy: owner.autonomy,
      };
      const first = await executionContext.run({ run: owner }, () =>
        engine.review(input),
      );
      assert(first.steps.every((s) => s.status === "unverified"));
      assert.equal(constructionCalls, 2);
      owner.status = "completed";
      owner.root = first.root;
      owner.originalProofRoute = first;
      await store.saveRun(owner);
      const firstBundle = await store.bundle(first.root);
      assert(
        firstBundle.artifacts.some(
          (a) =>
            a.kind === "proof:memory" && a.payload.check.status === "verified",
        ),
      );
      phase = "resume";
      const next = await engine.review({ ...input, resume: first });
      assert.equal(constructionCalls, 2);
      assert(audits >= 3);
      assert.equal(next.assembly.status, "verified");
      const replay = await replayOriginalProof(
        await store.bundle(next.root),
        next.root,
      );
      assert.equal(replay.reproduced, true);
      assert.equal(replay.replayedChecks, 3);
      const resultRoot = await store.get(next.root);
      const forged = await store.put(
        "original_proof_report",
        {
          ...resultRoot.payload,
          receivedArtifacts: [
            ...resultRoot.payload.receivedArtifacts,
            sha256("missing receipt"),
          ],
        },
        resultRoot.inputs,
      );
      await assert.rejects(
        replayOriginalProof(await store.bundle(forged), forged),
        /receipt is missing/,
      );
    } finally {
      await harness.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
