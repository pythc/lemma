import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TeamRuntime } from "../server/team/runtime.mjs";
import { TeamResources } from "../server/resources/team-resources.mjs";
import { MathematicalTools } from "../server/tools/mathematics.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import {
  preparePythonEnvironment,
  resolvePythonEnvironment,
} from "../server/python-environments.mjs";
import { runNumericExperiment } from "../server/numeric-execution.mjs";
test(
  "actual import preparation, source handles, cross-Agent public history and explicit diagnostic reuse",
  // Strong mode verifies the full environment for execution and explicit reuse.
  // This engineering deadline covers both; it does not change runtime budgets.
  { timeout: 600000 },
  async (t) => {
    const root = await mkdtemp(
        path.join(os.tmpdir(), "lemma-efficiency-native-"),
      ),
      store = new EvidenceStore(root),
      source = {
        paperSha256: sha256("fixture"),
        pageCount: 1,
        pages: [{ index: 0, text: "A source fixture." }],
      };
    const runtime = new TeamRuntime({
      store,
      mathTools: new MathematicalTools({ store }),
      executor: {
        run: async () => {
          throw Error("No model in controlled fixture");
        },
      },
      resources: new TeamResources(),
      extract: async () => source,
    });
    runtime.pump = () => {};
    await runtime.init();
    t.after(async () => {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    });
    const { id } = await runtime.start({ pdfBase64: "fixture" });
    const run = runtime.runs.get(id),
      a = run.tasks[0];
    a.status = "running";
    const call = (n, args = {}) => runtime.call(id, a.id, n, args);
    const span = await call("read_source_span", {
      pageIndex: 0,
      start: 0,
      end: 17,
    });
    const target = await call("propose_target", {
      locatorSelectionId: span.selectionId,
      proposal: {
        label: "fixture",
        statement: "True",
        assumptions: [],
        leanTarget: "True",
      },
      pageIndex: 0,
      sourceSpans: [{ selectionId: span.selectionId }],
      kind: "claim",
    });
    assert.equal(target.contract.quote, "A source fixture.");
    const code =
      "import Mathlib.Data.Nat.Basic\nexample (n : Nat) : n = n := by rfl";
    const draft = await call("lean_draft", { code });
    assert.equal(draft.result.exitCode, 0);
    assert.match(draft.scope, /diagnostic/);
    const other = await call("create_task", {
      title: "Peer",
      goal: "Inspect shared evidence",
      criteria: "No proof claim",
    });
    run.tasks.find((x) => x.id === other.taskId).status = "running";
    const history = await runtime.call(
      id,
      other.taskId,
      "read_execution_history",
      {
        kind: "lean_draft",
      },
    );
    assert.ok(history.entries.some((x) => x.artifactId === draft.artifactId));
    const reuse = await runtime.call(id, other.taskId, "lean_draft", {
      code,
      reuseArtifactId: draft.artifactId,
    });
    assert.equal(reuse.nativeCheckExecuted, false);
    assert.equal(reuse.originalArtifactId, draft.artifactId);
    await assert.rejects(
      call("lean_draft", {
        code: code + "\n--changed",
        reuseArtifactId: draft.artifactId,
      }),
      /changed/,
    );
  },
);
test(
  "real isolated PyPI wheel environment, numeric execution, reusable identity and mutation rejection",
  { timeout: 180000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lemma-pyenv-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const env = await preparePythonEnvironment([
      { name: "mpmath", version: "1.3.0" },
    ]);
    assert.ok(env.environmentId);
    const result = await runNumericExperiment(
      root,
      "import mpmath\nprint(mpmath.__version__)",
      { environmentId: env.environmentId },
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /1\.3\.0/);
    assert.equal(
      (await preparePythonEnvironment([{ name: "mpmath", version: "1.3.0" }]))
        .reused,
      true,
    );
    const resolved = await resolvePythonEnvironment(env.environmentId);
    assert.equal(resolved.contentSha256, env.contentSha256);
    const changed = path.join(resolved.prefix, "lib", "identity-test.pyc");
    await writeFile(changed, "changed");
    try {
      await assert.rejects(
        resolvePythonEnvironment(env.environmentId),
        /identity changed/,
      );
    } finally {
      await rm(changed);
    }
  },
);
