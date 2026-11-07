import { Worker } from "node:worker_threads";
import path from "node:path";
import { walkEvidence } from "../evidence-stream.mjs";
// The raw graph is streamed. Only compact counters enter the report. Payload
// decoding runs in a bounded worker so old large board/report objects cannot
// cause unbounded V8 heap growth in the delivery or reader service.
const kinds = new Set([
  "team:lean",
  "team:lean_reuse",
  "team:workspace_revision",
  "team:workspace_check",
  "team:workspace_lemma_plan",
  "team:workspace_lemma_check",
  "team:workspace_lemma_assembly",
  "team:search",
  "team:premise_search",
  "team:library_discovery",
  "team:library_inspection",
  "team:library_install",
  "team:library_source",
  "team:lean_draft",
  "team:lean_exploration",
  "team:typing",
]);
export function inventoryEntry(a) {
  if (!kinds.has(a.kind)) return null;
  const p = a.payload.result || {};
  return {
    id: a.id,
    kind: a.kind,
    payload: {
      result: {
        targetId: p.targetId || null,
        success: p.success ?? null,
        scope: p.scope || null,
        accepted: p.accepted ?? null,
        parent: p.parent
          ? {
              accepted: p.parent.accepted ?? null,
              status: p.parent.status || null,
            }
          : null,
        result: {
          status: p.result?.status || null,
          targetHash: p.result?.targetHash || null,
        },
      },
    },
  };
}
export async function evaluationInventory(artifacts) {
  const inventory = [];
  for await (const a of artifacts) {
    const entry = inventoryEntry(a);
    if (entry) inventory.push(entry);
  }
  return inventory;
}
export async function evaluationInventoryFromStore(
  store,
  root,
  { signal } = {},
) {
  let worker = null,
    pending = null,
    failure = null,
    decodedBytes = 0;
  const fail = (e) => {
    failure = e;
    pending?.reject(e);
    pending = null;
  };
  const start = () => {
    const current = new Worker(
      new URL("./inventory-worker.mjs", import.meta.url),
      {
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 8,
        },
      },
    );
    worker = current;
    decodedBytes = 0;
    current.on("error", (e) => {
      if (worker === current) fail(e);
    });
    current.on("exit", (code) => {
      if (worker === current) fail(Error(`Inventory decoder exited (${code})`));
    });
    current.on("message", (m) => {
      const p = pending;
      pending = null;
      if (m.error) p?.reject(Error(m.error));
      else p?.resolve(m.entry);
    });
  };
  const close = async () => {
    const old = worker;
    worker = null;
    await old?.terminate();
  };
  const abort = () => fail(signal.reason || Error("Inventory cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  const inventory = [];
  try {
    for await (const a of walkEvidence(store, root, {
      signal,
      metadataOnly: true,
    })) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      if (!kinds.has(a.kind)) continue;
      // A bounded decoder is recycled by bytes, not only object count. This
      // returns large parsed payload arenas to the OS before reading the next.
      if (worker && decodedBytes + a.bytes > 32 * 1024 * 1024) await close();
      if (!worker) start();
      const entry = await new Promise((resolve, reject) => {
        pending = { resolve, reject };
        worker.postMessage({
          file: path.join(store.root, "artifacts", a.id + ".json"),
          id: a.id,
        });
      });
      decodedBytes += a.bytes;
      if (entry) inventory.push(entry);
    }
    return inventory;
  } finally {
    signal?.removeEventListener("abort", abort);
    await close();
  }
}
