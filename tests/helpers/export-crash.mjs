import { EvidenceStore } from "../../server/evidence.mjs";
import { exportEvidenceSegments } from "../../server/evidence-stream.mjs";
const [store, root, out] = process.argv.slice(2);
await exportEvidenceSegments(new EvidenceStore(store), root, out, {
  onChunk: async ({ seq }) => {
    if (seq === 2) {
      process.send({ committed: true });
      await new Promise(() => {});
    }
  },
});
