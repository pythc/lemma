// Explicit offline preparation only; the local /resume API starts execution.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EvidenceStore } from "../server/evidence.mjs";
import { contentTree } from "../server/toolchain-tree.mjs";
import { EVALUATION_CODE_PATHS } from "../server/evaluation-registration.mjs";
import { preparePaperContinuation } from "../server/paper-continuation.mjs";
export async function prepare({ storeRoot, previousId, implementationBefore }) {
  const store = new EvidenceStore(path.resolve(storeRoot));
  await store.init();
  const implementation = await contentTree(
    process.cwd(),
    EVALUATION_CODE_PATHS,
  );
  return preparePaperContinuation(store, previousId, {
    implementationBefore,
    implementationAfter: implementation.sha256,
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [storeRoot, previousId, implementationBefore] = process.argv.slice(2);
  if (!storeRoot || !previousId || !implementationBefore)
    throw Error(
      "Usage: prepare-paper-continuation.mjs STORE PREVIOUS_ID PREVIOUS_SOURCE_HASH",
    );
  const r = await prepare({ storeRoot, previousId, implementationBefore });
  console.log(
    JSON.stringify(
      {
        id: r.id,
        status: r.status,
        continuedFrom: r.continuedFrom,
        continuation: r.continuation,
      },
      null,
      2,
    ),
  );
}
