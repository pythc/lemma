import { parentPort } from "node:worker_threads";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { inventoryEntry } from "./evaluation-report.mjs";
parentPort.on("message", async ({ file, id }) => {
  try {
    if ((await stat(file)).size > 64 * 1024 * 1024)
      throw Error("Single inventory object exceeds bounded decoder envelope");
    const raw = await readFile(file);
    if (raw.length > 64 * 1024 * 1024)
      throw Error("Single inventory object exceeds bounded decoder envelope");
    if (createHash("sha256").update(raw).digest("hex") !== id)
      throw Error("Inventory artifact changed");
    const a = JSON.parse(raw);
    parentPort.postMessage({ entry: inventoryEntry({ id, ...a }) });
  } catch (e) {
    parentPort.postMessage({ error: e.message });
  }
});
