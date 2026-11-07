import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import { createContract } from "../server/contracts.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
const retainedDirectory = async (prefix) => {
  const base = path.resolve(
    process.env.LEMMA_TEST_EVIDENCE_DIR || "evidence/author-route-native",
  );
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, prefix));
};
const text = "First use zero. Then use zero twice.";
const graph = {
  steps: [
    {
      name: "First",
      title: "第一次加零",
      anchors: [{ pageIndex: 0, quote: "First use zero." }],
      kind: "explicit",
      target: "∀ n : Nat, n + 0 = n",
      dependsOn: [],
      explanation: "zero",
      proof: "by intro n; rfl",
    },
    {
      name: "Second",
      title: "再次加零",
      anchors: [{ pageIndex: 0, quote: "Then use zero twice." }],
      kind: "omitted",
      target: "∀ n : Nat, (n + 0) + 0 = n",
      dependsOn: ["First"],
      explanation: "twice",
      proof: "by intro h n; exact (h (n + 0)).trans (h n)",
    },
  ],
  assembly: "by intro h1 h2; exact ⟨h1,h2⟩",
};
test(
  "HTTP starts a real source-route review, exports and replays; continuation reuses source checks",
  { timeout: 360000 },
  async () => {
    const dir = await retainedDirectory("lemma-original-http-");
    const store = new EvidenceStore(dir);
    await store.init();
    const sourceArtifact = await store.put("task:R02", {
      paperSha256: sha256(text),
      text,
      pageIndex: 0,
      pages: [{ index: 0, text }],
    });
    const c = createContract(
      {
        text,
        paperSha256: sha256(text),
        pageIndex: 0,
        artifact: sourceArtifact,
      },
      {
        label: "fixture",
        quote: "First use zero.",
        statement: "controlled source proof",
        assumptions: [],
        leanTarget: "(∀ n : Nat, n + 0 = n) ∧ (∀ n : Nat, (n + 0) + 0 = n)",
      },
    );
    const contractArtifact = await store.put("task:R05", c, [sourceArtifact]);
    const context = { pages: [{ pageIndex: 0, text }], supplements: [] };
    const contextArtifact = await store.put("task:R02C", context, [
      sourceArtifact,
    ]);
    const id = randomUUID();
    await store.saveRun({
      id,
      createdAt: new Date().toISOString(),
      status: "completed",
      contract: c,
      paperSha256: c.paperSha256,
      sourceArtifact,
      contractArtifact,
      contextArtifact,
      context,
      tasks: [],
    });
    const calls = [];
    let rejectConnection = false;
    let rejectMapping = false;
    const app = await createApp({
      dataRoot: dir,
      configProvider: async () => ({ model: "fixture" }),
      model: async (_c, r) => {
        calls.push(r.role);
        return {
          parsed:
            r.role === "R06_CONNECTION_AUDIT" && rejectConnection
              ? {
                  status: "route_change",
                  explanation: "controlled source-route rejection",
                }
              : ["R06_INTERFACES", "R06_INTERFACE_REPAIR"].includes(r.role)
                ? { graph: r.input.graph, changes: [], interfaces: [] }
                : r.role === "R06_GRAPH"
                  ? graph
                  : ["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role)
                    ? {
                        status: "faithful",
                        explanation: "controlled source route",
                      }
                    : {
                        coverage: rejectMapping ? "incomplete" : "complete",
                        missingSteps: [],
                        checks: r.input.graph.steps.map((s) => ({
                          name: s.name,
                          status: rejectMapping ? "concern" : "faithful",
                          anchors: s.anchors,
                          explanation: "controlled mapping",
                        })),
                        summary: "fixture",
                      },
          record: { fixture: true },
        };
      },
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const request = async (url, body) => {
      const response = await fetch(
        base + url,
        body
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : undefined,
      );
      const value = await response.json();
      assert.ok(response.ok, JSON.stringify(value));
      return value;
    };
    const settle = async (id) => {
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const r = await request("/api/original-proofs/" + id);
        if (r.status !== "running") return r;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error("route timeout");
    };
    try {
      const first = await request("/api/original-proofs", { reviewRunId: id });
      const result = await settle(first.id);
      assert.equal(result.status, "completed", result.error);
      assert.equal(
        result.originalProofRoute.summary.status,
        "verified_with_completion",
      );
      const bundle = await request(`/api/original-proofs/${first.id}/bundle`);
      assert.equal(bundle.root, result.root);
      const streamed = await fetch(
        `${base}/api/original-proofs/${first.id}/bundle?format=ndjson`,
      );
      assert.equal(streamed.status, 200);
      assert.match(streamed.headers.get("content-type"), /ndjson/);
      const lines = (await streamed.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(lines[0].root, result.root);
      assert.deepEqual(
        lines
          .slice(1)
          .map((a) => a.id)
          .sort(),
        bundle.artifacts.map((a) => a.id).sort(),
      );
      const replay = await request(
        `/api/original-proofs/${first.id}/replay`,
        {},
      );
      assert.equal(replay.reproduced, true);
      const n = calls.length;
      const next = await request("/api/original-proofs", {
        reviewRunId: id,
        continuedFrom: first.id,
      });
      const continued = await settle(next.id);
      assert.equal(continued.status, "completed");
      assert.equal(
        continued.originalProofRoute.summary.status,
        "verified_with_completion",
        "cached local proofs must still be assembled and rechecked",
      );
      assert.equal(
        calls.length,
        n,
        "completed semantic and local steps must not generate new model requests",
      );
      assert.equal((await store.getRun(first.id)).root, result.root);
      // The product pipeline embeds this same source route. Versioned software
      // recovery must resume its Agent-only session rather than seed a new one.
      const embedded = {
        ...(await store.getRun(id)),
        root: continued.root,
        autonomy: continued.originalProofRoute.autonomy,
        originalProofRoute: continued.originalProofRoute,
      };
      await store.saveRun(embedded);
      const resumed = await settle(
        (
          await request("/api/original-proofs", {
            reviewRunId: id,
            continuedFrom: id,
            verificationOnly: true,
            replayUnknown: false,
          })
        ).id,
      );
      assert.equal(resumed.status, "completed", resumed.error);
      assert.equal(resumed.continuedFromEmbedded, true);
      assert.equal(resumed.originalProofRoute.assembly.status, "verified");
      assert.equal(resumed.autonomy.sessionId, embedded.autonomy.sessionId);
      assert.equal(
        calls.length,
        n,
        "native-only continuation must not ask a model for new answers",
      );
      assert.equal(
        (await store.getRun(id)).originalProofRoute.root,
        embedded.originalProofRoute.root,
      );
      await store.saveRun({
        ...embedded,
        autonomy: { ...embedded.autonomy, sessionId: randomUUID() },
      });
      await assert.rejects(
        request("/api/original-proofs", {
          reviewRunId: id,
          continuedFrom: id,
          verificationOnly: true,
          replayUnknown: false,
        }),
        /session|会话|checkpoint/i,
      );
      await store.saveRun(embedded);
      rejectConnection = true;
      const independentStart = await request("/api/original-proofs", {
        reviewRunId: id,
      });
      const independent = await settle(independentStart.id);
      assert.equal(independent.status, "completed", independent.error);
      assert.equal(independent.conclusion.originalProof, "partial");
      assert.equal(independent.conclusion.theorem, "formalized_proved");
      assert.equal(
        independent.originalProofRoute.assembly.status,
        "unverified",
      );
      assert.equal(
        independent.check.targetHash,
        independent.originalProofRoute.independentTheorem.contract.targetHash,
      );
      assert.notEqual(
        independent.autonomy.sessionId,
        result.autonomy.sessionId,
      );
      const independentReplay = await request(
        `/api/original-proofs/${independent.id}/replay`,
        {},
      );
      assert.equal(independentReplay.theorem.reproduced, true);
      assert.equal(independentReplay.allStepsVerified, false);
      const knownParent = await store.getRun(id);
      knownParent.check = result.originalProofRoute.assembly.check;
      knownParent.proofArtifact = await store.put(
        "task:R09",
        { mode: "proof", proof: result.originalProofRoute.assembly.proof },
        [contractArtifact],
      );
      await store.saveRun(knownParent);
      rejectMapping = true;
      const preservedStart = await request("/api/original-proofs", {
        reviewRunId: id,
      });
      const preserved = await settle(preservedStart.id);
      assert.equal(
        preserved.conclusion.theorem,
        "unknown",
        "legacy parent proof bytes must not bypass a fresh autonomous attempt",
      );
      assert.ok(
        preserved.originalProofRoute.steps.every(
          (s) => s.status === "unverified",
        ),
      );
      const preservedReplay = await request(
        `/api/original-proofs/${preserved.id}/replay`,
        {},
      );
      assert.equal(preservedReplay.theorem, undefined);
      assert.equal(preservedReplay.replayedChecks, 0);
      assert.equal(preservedReplay.allStepsVerified, false);
    } finally {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      // Retain the exact store on success and failure for independent audit.
    }
  },
);
