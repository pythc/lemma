import { replayOriginalProof } from "../server/original-proof.mjs";
import { readEvidenceFile } from "../server/evidence-io.mjs";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { replayPaperBundle } from "../server/paper-ledger.mjs";
import { replayExecutionBundle } from "../server/execution-replay.mjs";
import { writeFile } from "node:fs/promises";
const output = process.argv
  .find((arg) => arg.startsWith("--output="))
  ?.slice(9);
const publish = async (value) => {
  if (output)
    await writeFile(output, JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  else console.log(JSON.stringify(value, null, 2));
};
const file = process.argv[2],
  expectedRoot = process.argv
    .find((arg) => arg.startsWith("--expected-root="))
    ?.split("=")[1];
if (!file) {
  console.error(
    "Usage: npm run replay -- evidence.json|evidence.ndjson --expected-root=<exported root SHA256>",
  );
  process.exit(2);
}
try {
  const pipeline = new ReviewPipeline({});
  const bundle = await readEvidenceFile(file);
  const result =
    bundle.artifacts?.find((a) => a.id === bundle.root)?.kind?.startsWith("adaptive:")
      ? await replayExecutionBundle(bundle, expectedRoot, (b, r) => pipeline.replay(b, r))
      : bundle.artifacts?.find((a) => a.id === bundle.root)?.kind ===
    "original_proof_report"
      ? await replayOriginalProof(bundle, expectedRoot)
      : bundle.schemaVersion === "lemma.paper-evidence.v1"
        ? await pipeline.reserve(() =>
            replayPaperBundle(bundle, expectedRoot, (value, root) =>
              pipeline.replayReserved(value, root),
            ),
          )
        : await pipeline.replay(bundle, expectedRoot);
  await publish(result);
  process.exitCode = result.reproduced ? 0 : 1;
} catch (error) {
  await publish({
    reproduced: false,
    revalidated: false,
    error: { message: error.message, code: error.code || null },
  });
  process.exitCode = 1;
}
