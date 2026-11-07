import { publicModelResult } from "../server/public-model-view.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { callModel as invoke } from "../server/model.mjs";
// Only local scripted providers use this wrapper. Preserve responses even when
// a later test assertion fails. Configuration/authorization headers are omitted.
async function save(value) {
  if (!process.env.LEMMA_TEST_EVIDENCE_DIR) return;
  const root = path.join(
    process.env.LEMMA_TEST_EVIDENCE_DIR,
    "controlled-model-receipts",
  );
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, randomUUID() + ".json"),
    JSON.stringify(value, null, 2),
    { flag: "wx" },
  );
}
export async function callModel(config, request) {
  let value;
  try {
    value = await invoke(config, request);
  } catch (error) {
    await save({
      classification: "controlled_HTTP_fixture_not_external_model",
      error: error.message,
      record: error.modelRecord || null,
    });
    throw error;
  }
  await save({
    classification: "controlled_HTTP_fixture_not_external_model",
    response: publicModelResult(value),
  });
  return value;
}
