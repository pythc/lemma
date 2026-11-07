import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeepProofHarness } from "../server/deep-harness.mjs";
import { ProofMemory, proofMemoryScope } from "../server/proof-memory.mjs";
import { createContract } from "../server/contracts.mjs";
import { freshProofSession } from "../server/proof-autonomy.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { checkProof } from "../server/lean.mjs";
test(
  "native planning tools inspect and connect interfaces without certifying the root",
  { timeout: 180000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-planner-sdk-")),
      store = new EvidenceStore(dir);
    await store.init();
    const source = await store.put("explicit_scripted_planning_fixture", {
      text: "fixture",
    });
    const contract = createContract(
      {
        text: "fixture",
        artifact: source,
        paperSha256: sha256("fixture"),
        pageIndex: 0,
      },
      {
        label: "fixture",
        quote: "fixture",
        statement: "fixture",
        assumptions: [],
        leanTarget: "(∀ n : Nat, n + 0 = n) ∧ (0 = 0)",
      },
    );
    let calls = 0;
    const harness = new DeepProofHarness({
      store,
      model: async (_cfg, r) => {
        calls++;
        const names = r.tools.map((t) => t.function.name);
        const schema = r.tools.find((t) => t.function.name === "plan_lemmas")
          .function.parameters;
        assert.equal(
          schema.properties.parts.items.properties.name.pattern,
          "^[A-Z][A-Za-z0-9_]{0,47}$",
        );
        assert(
          names.includes("inspect_declarations") &&
            names.includes("plan_lemmas"),
        );
        for (const name of [
          "check_lean",
          "check_lemma",
          "assemble_lemmas",
          "proof_memory",
          "install_library",
          "select_environment",
        ])
          assert(!names.includes(name));
        if (calls === 1)
          return {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "inspect",
                  function: {
                    name: "inspect_declarations",
                    arguments: JSON.stringify({
                      definitions: ["Nat.add_zero"],
                    }),
                  },
                },
              ],
            },
            record: { scripted: true },
          };
        if (calls === 2) {
          assert.match(
            r.messages.filter((m) => m.role === "tool").at(-1).content,
            /Nat.add_zero/,
          );
          return {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "plan",
                  function: {
                    name: "plan_lemmas",
                    arguments: JSON.stringify({
                      parts: [
                        {
                          name: "Base",
                          target: "∀ n : Nat, n + 0 = n",
                          purpose: "fixture identity",
                          dependsOn: [],
                        },
                      ],
                      assembly: "by intro h; exact ⟨h, rfl⟩",
                    }),
                  },
                },
              ],
            },
            record: { scripted: true },
          };
        }
        const data = JSON.parse(
          r.messages.filter((m) => m.role === "tool").at(-1).content,
        );
        assert.equal(data.ready, true);
        assert.equal(data.connectionCheck.status, "verified");
        return {
          message: {
            content:
              JSON.stringify({
                graph: { steps: [], assembly: "by intro h; exact h" },
              }) + "}",
          },
          record: { scripted: true },
        };
      },
    });
    try {
      const result = await harness.run({
        config: { model: "scripted-only", maxOutputTokens: 2000 },
        contract,
        inputs: [source],
        goal: "Explicit planning fixture",
        planningOnly: true,
        routeContext: { autonomy: freshProofSession() },
        maxCalls: 4,
      });
      assert.equal(result.check, null);
      assert.equal(result.record.finalContentNormalization.count, 1);
      assert.deepEqual(result.contract, contract);
      const run = await store.getRun(result.record.harnessRunId);
      assert.equal(run.taskKind, "proof_planning");
    } finally {
      await harness.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "real SDK tools ignore seeded memory, repair a helper and assemble under native Lean",
  { timeout: 240000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-project-sdk-")),
      store = new EvidenceStore(dir);
    await store.init();
    const source = await store.put(
      "explicit_native_scripted_provider_fixture",
      { text: "native fixture" },
    );
    const c = createContract(
      {
        text: "native fixture",
        artifact: source,
        paperSha256: sha256("native fixture"),
        pageIndex: 0,
      },
      {
        label: "native fixture",
        quote: "native fixture",
        statement: "fixture",
        assumptions: [],
        leanTarget: "(∀ n : Nat, n + 0 = n) ∧ (∀ n : Nat, (n + 0) + 0 = n)",
      },
    );
    const autonomy = freshProofSession();
    // Poison the persistent exact-target cache with a developer-provided answer.
    // Fresh execution must return no entry, even though the bytes are well formed.
    await new ProofMemory(store).remember({
      contract: c,
      proof: "by constructor <;> intro n <;> rfl",
      check: { targetHash: c.targetHash, status: "verified" },
      scope: proofMemoryScope(c, { context: null, policy: {} }),
    });
    const call = (id, name, args) => ({
      id,
      function: { name, arguments: JSON.stringify(args) },
    });
    let calls = 0,
      projectId;
    const harness = new DeepProofHarness({
      store,
      model: async (_cfg, r) => {
        calls++;
        const toolMessages = r.messages
          .filter((m) => m.role === "tool")
          .map((m) => JSON.parse(m.content));
        if (calls === 2) {
          const memory = toolMessages.find(
            (v) => v.scope === "exact_target_candidates_recompile_required",
          );
          assert.deepEqual(
            memory.entries,
            [],
            "external seeded answers must not enter the model context",
          );
        }
        projectId ||= toolMessages.find((v) => v.projectId)?.projectId;
        const callsByRound = {
          1: [call("memory", "proof_memory", {})],
          2: [
            call("plan", "plan_lemmas", {
              parts: [
                {
                  name: "Once",
                  target: "∀ n : Nat, n + 0 = n",
                  purpose: "zero identity",
                  dependsOn: [],
                },
                {
                  name: "Twice",
                  target: "∀ n : Nat, (n + 0) + 0 = n",
                  purpose: "use identity twice",
                  dependsOn: ["Once"],
                },
              ],
              assembly: "by intro h1 h2; exact ⟨h1,h2⟩",
            }),
          ],
          3: [
            call("syntax", "check_lemma", {
              projectId,
              name: "Once",
              proof: "by exact (",
            }),
            call("bad", "check_lemma", {
              projectId,
              name: "Twice",
              proof: "by exact missing",
            }),
            call("base", "check_lemma", {
              projectId,
              name: "Once",
              proof: "by intro n; rfl",
            }),
          ],
          4: [
            call("repair", "check_lemma", {
              projectId,
              name: "Twice",
              proof: "by intro h n; exact (h (n+0)).trans (h n)",
            }),
          ],
          5: [call("assemble", "assemble_lemmas", { projectId })],
        };
        if (calls === 4) {
          const syntax = toolMessages.find(
            (v) => v.check?.failureKind === "syntax_rejected",
          );
          assert(
            syntax,
            "native malformed term must be reported as a parser failure",
          );
          assert.match(syntax.check.parser.stderr, /ProofTerm\.txt|expected/);
          assert(syntax.check.reason);
        }
        return {
          message:
            calls <= 5
              ? { content: null, tool_calls: callsByRound[calls] }
              : {
                  content: JSON.stringify({
                    proofProjectId: projectId,
                    mode: "proof",
                    route: "completion",
                    explanation: "explicit scripted SDK acceptance",
                  }),
                },
          record: { role: r.role, scripted: true },
        };
      },
    });
    try {
      const result = await harness.run({
        config: { model: "scripted-test-only", maxOutputTokens: 2000 },
        contract: c,
        inputs: [source],
        goal: "Explicit scripted provider fixture, not a real autonomous model benchmark",
        routeContext: { autonomy, policy: {} },
        maxCalls: 8,
      });
      assert.equal(
        result.check.status,
        "verified",
        JSON.stringify(result.check),
      );
      assert.match(result.parsed.proof, /have ProofPart_Once/);
      assert.equal(
        (await checkProof(c, result.parsed.proof)).status,
        "verified",
      );
      const bundle = await store.bundle(result.record.harnessRoot);
      assert.equal(
        bundle.artifacts.some(
          (a) => a.kind === "proof:lemma_check" && !a.payload.accepted,
        ),
        true,
      );
      assert.equal(
        bundle.artifacts.some(
          (a) => a.kind === "proof:lemma_assembly" && a.payload.accepted,
        ),
        true,
      );
    } finally {
      await harness.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
