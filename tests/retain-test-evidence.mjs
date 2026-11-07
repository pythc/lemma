import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
// Opt-in evidence retention happens before any cleanup, including failed tests.
export async function cleanupTestEvidence(directory) {
  const root = process.env.LEMMA_TEST_EVIDENCE_DIR;
  if (root) {
    await mkdir(root, { recursive: true });
    await cp(directory, path.join(root, path.basename(directory)), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  await rm(directory, { recursive: true, force: true });
}
