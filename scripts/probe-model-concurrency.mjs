import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { modelConfig, callModel } from "../server/model.mjs";
const config = await modelConfig(
  fileURLToPath(new URL("../", import.meta.url)),
);
if (!config) throw Error("模型未配置");
const tasks = [
  '判断反例：在非负实数上 M(x) 等价于 x<1 或 x=2，其成立集合是否必为 [0,U)？只返回 JSON {answer:"简短数学解释"}。',
  '解释一个实数序列无收敛子列时，某点的每个邻域不能都含无限多个序列下标。只返回 JSON {answer:"简短数学解释"}。',
];
const results = await Promise.allSettled(
  tasks.map((question, i) =>
    callModel(
      { ...config, concurrency: 2 },
      {
        role: `CONCURRENCY_PROBE_${i + 1}`,
        system: "核对公开基础数学问题，返回有效 JSON，不调用其他工具。",
        input: { question },
        signal: AbortSignal.timeout(180000),
      },
    ),
  ),
);
const evidence = {
  at: new Date().toISOString(),
  model: config.model,
  endpoint: config.endpoint,
  concurrency: 2,
  results: results.map((r) =>
    r.status === "fulfilled"
      ? { status: r.status, record: r.value.record, answer: r.value.parsed }
      : {
          status: r.status,
          error: r.reason.message,
          record: r.reason.modelRecord || null,
        },
  ),
};
const good = results.every(
  (r) => r.status === "fulfilled" && typeof r.value.parsed.answer === "string",
);
evidence.success = good;
if (good) {
  const records = results.map((r) => r.value.record);
  evidence.overlapMs =
    Math.min(...records.map((r) => Date.parse(r.startedAt) + r.elapsedMs)) -
    Math.max(...records.map((r) => Date.parse(r.startedAt)));
  evidence.success =
    Number.isFinite(evidence.overlapMs) && evidence.overlapMs > 0;
}
await writeFile(
  new URL(
    "../evidence/autonomy-20261018/model-concurrency.json",
    import.meta.url,
  ),
  JSON.stringify(evidence, null, 2),
);
console.log(
  JSON.stringify({
    success: evidence.success,
    overlapMs: evidence.overlapMs,
    requests: evidence.results.map((r) => ({
      status: r.status,
      id: r.record?.requestId,
      elapsedMs: r.record?.elapsedMs,
      error: r.error,
    })),
  }),
);
if (!evidence.success) process.exitCode = 1;
