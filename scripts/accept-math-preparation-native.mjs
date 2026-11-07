import { verifyValidationRuntime } from "../server/validation-runtime.mjs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { contentTree } from "../server/toolchain-tree.mjs";
import { EVALUATION_CODE_PATHS } from "../server/evaluation-registration.mjs";
const out = path.resolve(process.argv[2]);
await mkdir(out, { recursive: false });
const before = await contentTree(process.cwd(), EVALUATION_CODE_PATHS);
const report = {
  implementation: before.sha256,
  passed: false,
  steps: [],
  classification: "scripted_actual_HTTP_SDK_Lean_not_model_accuracy",
  startedAt: new Date().toISOString(),
};
const groups = [
  [
    "indexed-admission",
    [
      "math-preparation-native",
      "seventh-admission-native",
      "native-bound-audit-native",
      "witness-audit-native",
      "anchored-audit-native",
      "structure-equivalence-native",
    ],
  ],
  [
    "runtime-boundaries",
    [
      "continuation-phase-native",
      "strict-receiving-native",
      "public-evaluator-native",
      "harness-context-lean",
      "continuation-semantic-http-native",
      "review-transport",
      "model-delivery",
      "structured-review",
      "fourth-runtime",
      "cancel-archive",
      "evaluation-outage-native",
    ],
  ],
  ["author-route", ["original-proof-lean", "original-proof-http"]],
];
try {
  report.runtimeBefore = await verifyValidationRuntime();
  for (const [name, files] of groups) {
    const logfile = path.join(out, name + ".log"),
      fd = await open(logfile, "wx");
    let exitCode;
    try {
      exitCode = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--test",
            "--test-reporter=tap",
            "--test-concurrency=1",
            ...files.map((f) => `tests/${f}.test.mjs`),
          ],
          {
            env: {
              ...process.env,
              LEMMA_TEST_EVIDENCE_DIR: path.join(out, name),
            },
            stdio: ["ignore", fd.fd, fd.fd],
          },
        );
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      await fd.close();
    }
    const log = await readFile(logfile, "utf8");
    report.steps.push({
      name,
      exitCode,
      tests: Number(/# tests (\d+)/.exec(log)?.[1] || 0),
      failures: Number(/# fail (\d+)/.exec(log)?.[1] ?? -1),
    });
    if (exitCode !== 0)
      throw Error(name + " failed; all original logs/stores retained");
  }
  report.implementationUnchanged =
    (await contentTree(process.cwd(), EVALUATION_CODE_PATHS)).sha256 ===
    before.sha256;
  report.runtimeAfter = await verifyValidationRuntime();
  report.passed = report.implementationUnchanged;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  report.endedAt = new Date().toISOString();
  await writeFile(
    path.join(out, "result.json"),
    JSON.stringify(report, null, 2),
    { flag: "wx" },
  );
  console.log(JSON.stringify(report));
}
