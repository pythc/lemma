import { sourceAuditFixture } from "./source-audit-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createApp } from "../server/index.mjs";
import { sha256, inspectBundle } from "../server/evidence.mjs";
import { ALIGNMENT_CATEGORIES } from "../server/semantics.mjs";

const quote = "For every natural number n, n + 0 = n.";
const anchor = { pageIndex: 0, quote };
const proofSentence = "Proof. Addition by zero is reflexive by definition.";
async function fixture() {
  const p = await PDFDocument.create();
  p.addPage().drawText(quote + "\n" + proofSentence, {
    x: 30,
    y: 700,
    size: 11,
    font: await p.embedFont(StandardFonts.TimesRoman),
  });
  const b = Buffer.from(await p.save());
  return {
    orchestration: "adaptive",
    mode: "model",
    paperSha256: sha256(b),
    pdfBase64: b.toString("base64"),
    libraryProfile: "std-v1",
  };
}
async function settle(app, id, predicate) {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    const r = await app.store.getRun(id);
    if (predicate(r) && !app.adaptive.active.has(id)) return r;
    await new Promise((r) => setTimeout(r, 20));
  }
  const last = await app.store.getRun(id);
  throw Error(
    "not settled: " +
      JSON.stringify({
        status: last.status,
        error: last.error,
        tasks: last.tasks.map((t) => ({
          kind: t.kind,
          status: t.status,
          error: t.error,
          childRunId: t.childRunId,
        })),
        claims: last.claims?.map((c) => ({
          formalStatus: c.formalResult?.status,
          formalError: c.formalResult?.error,
        })),
      }),
  );
}
const model = async (_, req) => {
  let parsed;
  if (req.role === "A_READ")
    parsed = {
      summary: "算术测试材料，仅用于执行验收。",
      claims: [
        { label: "Theorem 1", ...anchor, statement: "任意自然数加零不变。" },
      ],
    };
  else if (req.role === "A_SOURCE_SCOPE")
    parsed = {
      spans: [anchor],
      premises: [],
      conclusion: [anchor],
      explanation: "The source fixture is a complete quantified statement.",
    };
  else if (req.role === "A_SCOPE_REVIEW")
    parsed = {
      scopeHash: req.input.scope.scopeHash,
      decision: "complete",
      explanation: "The complete fixture statement is present.",
      anchors: [anchor],
    };
  else if (req.role === "A_COORDINATOR")
    parsed = req.input.tasks.some((t) => t.kind === "formalize")
      ? {
          mode: "finish",
          reason: "固定算术命题的核验已经返回。",
          coverage: req.input.claims.map((c) => ({
            claimId: c.id,
            formalization: "attempted",
            reason: "固定目标等待确认或已由实际 Lean 检查，原证明保持独立。",
          })),
        }
      : {
          mode: "act",
          reason: "该算术目标可以形式化。",
          actions: [
            {
              kind: "formalize",
              claimId: req.input.claims[0].id,
              title: "核验自然数加零",
              question: "核验原目标",
              reason: "与 Std 能力对应。",
              strategy: "首次准备固定算术目标并交给实际 Lean。",
              basedOn: [req.input.tasks.at(-1).id],
            },
          ],
        };
  else if (req.role === "A_ENV")
    parsed = {
      summary: "算术样本选择 Std。",
      choices: req.input.paperMap.claims.map((c) => ({
        claimId: c.id,
        profile: "std-v1",
        reason: "自然数加法。",
        queries: [],
        names: ["Nat.add_zero"],
      })),
    };
  else if (req.role === "A_DIAGNOSE")
    parsed = { action: "stop", guidance: "受控测试意外失败，应保留失败记录。" };
  else if (req.role === "R03")
    parsed = {
      label: "Theorem 1",
      quote,
      statement: "任意自然数右加零不变",
      assumptions: ["n 为自然数"],
      leanTarget: "∀ n : Nat, n + 0 = n",
      ambiguity: "",
      alignment: ALIGNMENT_CATEGORIES.map((category) => ({
        category,
        explanation: "算术执行样本，非领域评测。",
        leanFragment: "n",
        anchors: [anchor],
      })),
    };
  else if (req.role === "R04")
    parsed = {
      targetHash: req.input.contract.targetHash,
      ...(["lemma.source-audit.v4", "lemma.source-audit.v5"].includes(
        req.input.context?.semanticProtocol,
      )
        ? { findings: [] }
        : {}),
      ...(req.input.stage
        ? {}
        : {
            sourceAudit: sourceAuditFixture(
              req.input.contract,
              req.input.targetStructure,
              req.input.context.semanticProtocol,
            ),
          }),
      backTranslation: "任意自然数右加零等于自身。",
      checks: ALIGNMENT_CATEGORIES.map((category) => ({
        category,
        status: "aligned",
        explanation: "算术测试目标一致。",
        anchors: [anchor],
      })),
    };
  else if (req.role === "R06")
    parsed = {
      status: "unchecked",
      quote: "",
      explanation: "受控算术证明交由逐步核验流程检查。",
    };
  else if (req.role === "R06_GRAPH")
    parsed = {
      steps: [
        {
          name: "Identity",
          title: "按加法定义化简",
          kind: "explicit",
          anchors: [{ pageIndex: 0, quote: proofSentence }],
          target: "∀ n : Nat, n + 0 = n",
          dependsOn: [],
          explanation: "原文给出的定义化简",
          proof: "by intro n; rfl",
        },
      ],
      assembly: "by intro h; exact h",
    };
  else if (
    ["R06_INTERFACES", "R06_INTERFACE_REPAIR", "R06_BLUEPRINT_REPAIR"].includes(
      req.role,
    )
  )
    parsed = { graph: req.input.graph, changes: [], interfaces: [] };
  else if (req.role === "R06_ALIGN")
    parsed = {
      coverage: "complete",
      missingSteps: [],
      checks: req.input.graph.steps.map((s) => ({
        name: s.name,
        status: "faithful",
        anchors: s.anchors,
        explanation: "受控样本对应原文定义化简",
      })),
      summary: "受控语义记录",
    };
  else if (["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(req.role))
    parsed = {
      status: "faithful",
      explanation: "原文定义化简和实际 rfl 一致；受控路线评估",
    };
  else
    parsed = {
      proof: "by intro n; rfl",
      mode: "proof",
      route: "independent",
      explanation: "预设候选；由真实 Lean 检查。",
    };
  return { parsed, record: { provider: "scripted-test-only", role: req.role } };
};
for (const [repairAlignment, automatic, repairTarget, sourceScopes] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
  [false, true, true],
  [false, true, false, true],
])
  test(`HTTP -> LangGraph -> ${sourceScopes ? "complete source scope -> " : ""}${repairTarget ? "automatic target repair -> " : ""}${repairAlignment ? "automatic alignment repair -> " : ""}${automatic ? "Agent semantic decision" : "legacy manual semantic gate"} -> real Lean -> parent convergence + SSE replay`, async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "lemma-adaptive-livelean-"),
    );
    const app = await createApp({
      dataRoot: dir,
      adaptiveOptions: {
        autonomousSemantics: automatic,
        sourceScopes: !!sourceScopes,
      },
      configProvider: async () => ({ model: "scripted-test-only" }),
      model: async (config, req) => {
        if (repairTarget && req.role === "R03_TARGET_REPAIR") {
          assert.match(
            req.input.previousSemanticReview.targetCheck.parser.stderr,
            /expected/,
          );
          return model(config, { ...req, role: "R03" });
        }
        if (repairAlignment && req.role === "A_CHILD_DIAGNOSE")
          return {
            parsed: {
              action: "retry_translation",
              guidance:
                "Repair only the nonexistent alignment anchor; keep the mathematical target fixed.",
            },
            record: { provider: "scripted-test-only", role: req.role },
          };
        if (repairAlignment && req.role === "R03_ALIGNMENT_FIX")
          return {
            parsed: {
              alignment: ALIGNMENT_CATEGORIES.map((category) => ({
                category,
                explanation: "Exact arithmetic source restored.",
                leanFragment: "n",
                anchors: [anchor],
              })),
              leanTarget: "True",
            },
            record: { provider: "scripted-test-only", role: req.role },
          };
        if (req.role === "A_SEMANTIC_DECISION")
          return {
            parsed: {
              targetHash: req.input.contract.targetHash,
              semanticArtifact: req.input.semanticArtifact,
              decision:
                repairTarget &&
                req.input.semanticReview.targetCheck.status !== "well_typed"
                  ? "retry_translation"
                  : "proof",
              summary:
                "The fixed arithmetic source matches the full quantified target.",
              resolutions: [],
            },
            record: { provider: "scripted-test-only", role: req.role },
          };
        const out = await model(config, req);
        if (repairTarget && req.role === "R03")
          out.parsed.leanTarget = "∀ n : Nat, (n + 0 = n";
        if (repairAlignment && req.role === "R03")
          out.parsed.alignment[0].anchors = [
            { pageIndex: 0, quote: "invented source" },
          ];
        return out;
      },
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const post = async (url, body) => {
      const resp = await fetch(base + url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await resp.json();
      assert.equal(resp.status, 202, JSON.stringify(value));
      return value;
    };
    try {
      const id = (await post("/api/reviews", await fixture())).id;
      let r, child;
      if (automatic) {
        r = await settle(app, id, (r) =>
          ["completed", "blocked"].includes(r.status),
        );
        const task = [...r.tasks]
          .reverse()
          .find(
            (t) => t.childRunId && t.childFinal && t.status === "succeeded",
          );
        assert.ok(
          task,
          JSON.stringify({
            status: r.status,
            error: r.error,
            tasks: r.tasks.map((t) => ({
              kind: t.kind,
              status: t.status,
              error: t.error,
            })),
          }),
        );
        child = await app.store.getRun(task.childRunId);
        assert.equal(
          child.approval.authority,
          "autonomous_agent_semantic_assessment_not_human",
        );
        assert.ok(r.tasks.some((t) => t.kind === "assess_target"));
        if (repairTarget) {
          assert.equal(
            child.translationRepair.kind,
            "unapproved_target_retranslation",
          );
          assert(r.tasks.some((t) => t.kind === "retry_translation"));
          const old = await app.store.getRun(child.continuedFrom);
          assert.equal(old.semanticReview.targetCheck.status, "not_well_typed");
          assert.equal(old.approval, null);
        }
      } else {
        r = await settle(app, id, (r) =>
          ["awaiting_confirmation", "blocked"].includes(r.status),
        );
        assert.equal(r.status, "awaiting_confirmation", r.error);
        const task = r.tasks.find(
          (t) => t.childRunId && t.status === "awaiting_confirmation",
        );
        child = await app.store.getRun(task.childRunId);
        assert.equal(child.status, "awaiting_confirmation", child.error);
        assert.equal(child.check, null);
        assert.equal(child.approval, null);
        if (repairAlignment) {
          assert.equal(child.translationRepair.mathTargetUnchanged, true);
          assert.equal(child.contract.leanTarget, "∀ n : Nat, n + 0 = n");
          assert.ok(r.tasks.some((t) => t.kind === "diagnose_child"));
          assert.ok(r.tasks.some((t) => t.kind === "retry_translation"));
          assert.ok(
            r.tasks.some((t) => t.childRunId && t.childRunId !== child.id),
          );
        }
        const list = await (
          await fetch(base + `/api/reviews?paper=${r.paperSha256}`)
        ).json();
        assert.equal(list.items.length, 1);
        const ctrl = new AbortController();
        const stream = await fetch(
          base + `/api/reviews/${id}/events?after=${r.revision - 1}`,
          { signal: ctrl.signal },
        );
        assert.match(stream.headers.get("content-type"), /event-stream/);
        const reader = stream.body.getReader();
        const first = new TextDecoder().decode((await reader.read()).value);
        assert.match(first, /event: review/);
        assert.match(first, new RegExp(`id: ${r.revision}`));
        ctrl.abort();
        await assert.rejects(app.adaptive.resume(id), /请先完成/);
        await post(`/api/reviews/${child.id}/approve`, {
          confirmed: true,
          targetHash: child.contract.targetHash,
          semanticArtifact: child.semanticArtifact,
          resolutions: child.semanticReview.issues.map((i) => ({
            issueId: i.id,
            decision: "confirmed_with_reason",
            reason: "明确算术执行样本的人工作证，仅验收流程。",
          })),
        });
        r = await settle(
          app,
          id,
          (r) => r.status === "completed" || r.status === "blocked",
        );
      }
      assert.equal(r.status, "completed", r.error);
      const final = await app.store.getRun(child.id);
      assert.equal(final.check.status, "verified", JSON.stringify(final.check));
      assert.equal(
        final.originalProofRoute?.summary.status,
        "verified_route",
        final.originalProofRoute?.error,
      );
      assert.equal(
        r.claims[0].formalResult.originalProofRoute.summary.status,
        "verified_route",
      );
      const replay = await app.pipeline.replay(
        await app.store.bundle(final.root),
        final.root,
      );
      assert.equal(replay.reproduced, true, JSON.stringify(replay));
      assert.equal(
        r.claims[0].formalResult.conclusion.theorem,
        "formalized_proved",
      );
      assert.equal(r.conclusion.theorem, "unknown");
      const bundle = await (
        await fetch(base + `/api/reviews/${id}/bundle`)
      ).json();
      inspectBundle(bundle, r.root);
      assert.ok(
        bundle.artifacts.some((a) => a.kind === "adaptive_child_result"),
      );
    } finally {
      await new Promise((r) => app.server.close(r));
      await app.adaptive.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
