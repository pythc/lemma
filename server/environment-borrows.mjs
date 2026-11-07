import { mkdir, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { executionContext } from "./execution-context.mjs";
const root = fileURLToPath(
  new URL("../.tools/environment-borrows", import.meta.url),
);

// Durable borrow records supplement the host read lease. Abnormal exits leave
// an unresolved borrow; they are not guessed to be released from PID alone.
// Historical snapshots are retained unconditionally, including archive refs.
export async function withEnvironmentBorrow(
  identity,
  reservationId,
  snapshotId,
  action,
  { borrowRoot = root } = {},
) {
  const directory = path.join(borrowRoot, identity);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${reservationId}.json`);
  const owner = executionContext.getStore();
  const record = {
    identity,
    reservationId,
    snapshotId,
    ownerId: owner?.run?.id || null,
    taskId: owner?.task?.id || null,
    pid: process.pid,
    status: "borrowed",
    borrowedAt: new Date().toISOString(),
    retention: "all_snapshots_retained_no_gc",
  };
  const save = async () => {
    await writeFile(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  };
  await save();
  try {
    return await action();
  } finally {
    record.status = "released";
    record.releasedAt = new Date().toISOString();
    await save();
  }
}
