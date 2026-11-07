import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
const root = process.cwd(),
  ev = path.join(root, "evidence/third-batch-20261021"),
  snapshot = path.join(ev, "p0-raw-snapshot");
const intent =
  "自主选择一个命题核查，忠实保留原文条件，分别报告定理真假与原证明路线；证据不足保留未完成。";
const cases = [
  ["fixture-base-01", "public/analysis-fixtures.pdf", 12, 4],
  ["fixture-base-02", "public/analysis-fixtures.pdf", 12, 4],
  ["fixture-capacity-01", "public/analysis-fixtures.pdf", 24, 8],
];
await writeFile(
  path.join(ev, "raw-cohort-plan.json"),
  JSON.stringify(
    {
      cases,
      intent,
      outputTokens: 196608,
      requestTimeoutSeconds: 60,
      secondFamily: "not_accepted",
      capacityIsSeparate: true,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
for (const [name, pdf, calls, minutes] of cases) {
  console.log(JSON.stringify({ started: name }));
  const c = spawn(
    process.execPath,
    [
      "scripts/evaluate-autonomous-paper.mjs",
      pdf,
      path.join(ev, name),
      intent,
      `--max-model-calls=${calls}`,
      `--max-run-minutes=${minutes}`,
      "--model-output-tokens=196608",
      "--model-timeout-seconds=60",
    ],
    {
      cwd: snapshot,
      env: {
        ...process.env,
        LEMMA_EVALUATION_CONFIG_ROOT: path.resolve("../../math-review-bot"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "",
    err = "";
  c.stdout.on("data", (b) => (out += b));
  c.stderr.on("data", (b) => (err += b));
  const status = await new Promise((resolve, reject) => {
    c.on("error", reject);
    c.on("exit", (code, signal) => resolve({ code, signal }));
  });
  await writeFile(path.join(ev, `${name}.log`), out + "\n" + err, {
    flag: "wx",
  });
  await writeFile(
    path.join(ev, `${name}-process.json`),
    JSON.stringify(status),
    { flag: "wx" },
  );
  console.log(JSON.stringify({ ended: name, ...status }));
}
