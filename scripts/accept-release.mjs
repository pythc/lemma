import { verifyValidationRuntime } from "../server/validation-runtime.mjs";
// Release acceptance includes a real native HTTP/SDK path and an independent
// offline replay. It is intentionally broader than npm test.
import { mkdir, readFile, writeFile, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { contentTree } from "../server/toolchain-tree.mjs";
import { cleanReplay } from "../server/clean-replay.mjs";
import { EVALUATION_CODE_PATHS } from "../server/evaluation-registration.mjs";
const out = path.resolve(process.argv[2] || `evidence/release-${randomUUID()}`);
await mkdir(out, { recursive: false });
const codePaths = [
  "server",
  "shared",
  "worker",
  "src",
  "scripts",
  "tests",
  "package.json",
];
const before = await contentTree(process.cwd(), codePaths, {
  includeFiles: true,
});
const report = {
  classification: "engineering_release_acceptance_not_model_accuracy",
  startedAt: new Date().toISOString(),
  implementation: before,
  steps: [],
  passed: false,
  autonomousQualityAccepted: false,
  secondFamily: "not_accepted",
};
report.evaluationImplementation = await contentTree(
  process.cwd(),
  EVALUATION_CODE_PATHS,
);
const save = () =>
  writeFile(out + "/result.json", JSON.stringify(report, null, 2));
async function command(name, args, env = {}) {
  const log = await open(out + `/${name}.log`, "wx");
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        stdio: ["ignore", log.fd, log.fd],
      });
      child.once("error", reject);
      child.once("close", resolve);
    });
    report.steps.push({ name, exitCode: code, log: `${name}.log` });
    await save();
    if (code !== 0) throw Error(`${name} failed; original log retained`);
  } finally {
    await log.close();
  }
}
try {
  report.runtimeBefore = await verifyValidationRuntime();
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  await command("regression", pkg.scripts.test.split(" ").slice(1));
  await command(
    "native-mainflow",
    ["--test", "--test-concurrency=1", "tests/mainflow-native.test.mjs"],
    { LEMMA_TEST_EVIDENCE_DIR: out + "/mainflow" },
  );
  await command("native-replay", ["--test", "tests/replay.test.mjs"], {
    LEMMA_TEST_EVIDENCE_DIR: out + "/native-replay-store",
  });
  await command("build", ["node_modules/vite/bin/vite.js", "build"]);
  await command("sites-package", ["scripts/prepare-sites-build.mjs"]);
  await command("sites-tests", ["--test", "tests/sites-worker.test.mjs"]);
  const native = JSON.parse(
    await readFile(out + "/mainflow/native-mainflow.json", "utf8"),
  );
  const independent = path.resolve(
    process.cwd(),
    "..",
    `math-review-release-clean-${randomUUID()}`,
  );
  report.cleanReplay = await cleanReplay(
    out + "/mainflow/bundle.json",
    native.root,
    independent,
  );
  report.independentDirectory = independent;
  if (
    !report.cleanReplay.integrity ||
    !report.cleanReplay.reproduced ||
    !report.cleanReplay.revalidated ||
    !report.cleanReplay.sameEnvironment
  )
    throw Error("Independent native replay was not fully reproduced");
  report.implementationUnchanged =
    (await contentTree(process.cwd(), codePaths)).sha256 === before.sha256;
  report.implementationUnchanged &&=
    (await contentTree(process.cwd(), EVALUATION_CODE_PATHS)).sha256 ===
    report.evaluationImplementation.sha256;
  if (!report.implementationUnchanged)
    throw Error("Implementation changed during release acceptance");
  report.runtimeAfter = await verifyValidationRuntime();
  report.passed = true;
} catch (e) {
  report.error = e.message;
  process.exitCode = 1;
} finally {
  report.endedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({ out, passed: report.passed, error: report.error || null }),
  );
}
