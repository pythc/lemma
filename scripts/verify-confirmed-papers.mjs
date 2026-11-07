// Run only the two exact targets explicitly confirmed by the user on 2026-10-19.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { EvidenceStore } from "../server/evidence.mjs";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { ProvingEngine } from "../server/proving-engine.mjs";
import { modelConfig, callModel } from "../server/model.mjs";
import { analysisLibraryStatus } from "../server/libraries.mjs";
import { proverCapabilities } from "../server/prover-session.mjs";

const root = process.cwd();
const output = path.join(
  root,
  "evidence/prover-integration-20261018/confirmed-targets-20261019",
);
await mkdir(output, { recursive: true });
const environment = {
  library: await analysisLibraryStatus({ verify: true }),
  prover: await proverCapabilities(),
};
if (!environment.library.ready || !environment.prover.ready)
  throw Error("Verification environment failed preflight");
await writeFile(
  path.join(output, "environment.json"),
  JSON.stringify(environment, null, 2),
  { flag: "wx" },
);
const config = {
  ...(await modelConfig(root)),
  timeoutMs: 300000,
  maxOutputTokens: 32768,
};
const budget = {
  maxElapsedMs: 600000,
  maxCandidates: 3,
  maxModelCalls: 3,
  maxCompletionTokens: 98304,
  perCallCompletionTokens: 32768,
  maxInputCharacters: 180000,
};
const targets = [
  {
    name: "aktan-vural",
    id: "b4cc00a1-1818-47d5-bf6f-b3cc8fd9c7be",
    hash: "4a83a2455137aa5235edf63d8f61cbc0ea048f2c9c3c6075468c113cb52d631c",
  },
  {
    name: "yang-zhu",
    id: "da738981-5c54-46e2-bdae-43182d967500",
    hash: "6654ad46f8716c8503700efa4aeed9aeee84b787641843b9f35b69634b880f35",
  },
];
await writeFile(
  path.join(output, "authorization.json"),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      userStatement: "确认这两个目标，继续核验",
      targets,
      reviewedDocument: "https://knowledge.110-lab.cn/p/XPTWVwYY6w",
      budget,
      scope:
        "Two explicitly confirmed targets; independent proofs. No whole-paper or original-proof certification.",
    },
    null,
    2,
  ),
  { flag: "wx" },
);
await Promise.all(
  targets.map(async (target) => {
    const store = new EvidenceStore(
      path.join(
        root,
        ".runtime/prover-benchmark/deepseek-flash-20261018/integrated",
        target.name,
      ),
    );
    let calls = 0;
    const observed = async (cfg, input) => {
      const number = ++calls;
      try {
        const result = await callModel(cfg, input);
        await writeFile(
          path.join(output, `${target.name}-model-${number}.json`),
          JSON.stringify(result.record, null, 2),
          { flag: "wx" },
        );
        return result;
      } catch (error) {
        await writeFile(
          path.join(output, `${target.name}-model-${number}.json`),
          JSON.stringify(
            { error: error.message, record: error.modelRecord },
            null,
            2,
          ),
          { flag: "wx" },
        );
        throw error;
      }
    };
    const pipeline = new ReviewPipeline({
      store,
      getConfig: () => config,
      model: observed,
      concurrent: true,
      prover: new ProvingEngine({ model: observed }),
      provingBudget: budget,
    });
    await pipeline.init();
    const draft = await store.getRun(target.id);
    if (
      draft.contract?.targetHash !== target.hash ||
      draft.status !== "awaiting_confirmation"
    )
      throw Error("Confirmed target identity/state changed");
    await writeFile(
      path.join(output, `${target.name}-before.json`),
      JSON.stringify(draft, null, 2),
      { flag: "wx" },
    );
    const issues = draft.semanticReview.issues || [];
    if (target.name === "aktan-vural" && issues.length)
      throw Error("Unexpected unconfirmed issue");
    if (
      target.name === "yang-zhu" &&
      issues.some((issue) => issue.id !== "222bd36d08f2f1adc885506b")
    )
      throw Error("Unexpected unconfirmed issue");
    const start = Date.now();
    await pipeline.approve(target.id, {
      confirmed: true,
      targetHash: target.hash,
      semanticArtifact: draft.semanticArtifact,
      proofMode: "proof",
      resolutions: issues.map((issue) => ({
        issueId: issue.id,
        decision: "confirmed_with_reason",
        reason:
          "用户已审阅指定目标文档并明确确认：单调包括非降与非升，绝对连续采用区间上全局 ε–δ 定义。",
      })),
    });
    let last = "",
      run;
    const deadline = Date.now() + 22 * 60 * 1000;
    while (Date.now() < deadline) {
      run = await store.getRun(target.id);
      const state = `${run.status}:${calls}:${run.tasks.length}`;
      if (state !== last)
        console.log(
          JSON.stringify({
            name: target.name,
            status: run.status,
            calls,
            tasks: run.tasks.length,
            active: run.tasks
              .filter((t) => t.status === "running")
              .map((t) => t.title),
          }),
        );
      last = state;
      if (!pipeline.active.has(target.id)) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (pipeline.active.has(target.id)) {
      await pipeline.cancel(target.id);
      while (pipeline.active.has(target.id))
        await new Promise((resolve) => setTimeout(resolve, 100));
      run = await store.getRun(target.id);
    }
    const bundle = run.root ? await store.bundle(run.root) : null;
    if (bundle)
      await writeFile(
        path.join(output, `${target.name}-bundle.json`),
        JSON.stringify(bundle, null, 2),
        { flag: "wx" },
      );
    let replay = null;
    if (run.check?.status === "verified")
      replay = await pipeline.replay(bundle, run.root);
    await writeFile(
      path.join(output, `${target.name}-integrated.json`),
      JSON.stringify(
        {
          name: target.name,
          arm: "integrated",
          model: config.model,
          budget,
          run,
          replay,
          modelCalls: calls,
          elapsedMs: Date.now() - start,
          wallClockComparable: false,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    console.log(
      JSON.stringify({
        name: target.name,
        status: run.status,
        check: run.check?.status,
        stop: run.provingSearch?.stopReason,
        root: run.root,
        replay: replay?.status,
      }),
    );
  }),
);
