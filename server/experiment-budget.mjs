// Opt-in evaluation accounting only. A reserved attempt is never refunded, even
// if delivery is unknown or the process dies; this conservatively bounds wire calls.
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
async function update(root, fn) {
  const lock = path.join(root, "ledger.lock");
  let held = false;
  for (let i = 0; i < 100; i++) {
    try {
      await mkdir(lock);
      held = true;
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      await delay(20);
    }
  }
  if (!held)
    throw Error(
      "Experiment ledger locked; fail closed, inspect prior process before recovery",
    );
  try {
    const file = path.join(root, "ledger.json"),
      v = JSON.parse(await readFile(file, "utf8"));
    const result = await fn(v);
    const tmp = file + "." + randomUUID();
    await writeFile(tmp, JSON.stringify(v, null, 2), { flag: "wx" });
    await rename(tmp, file);
    return result;
  } finally {
    await rm(lock, { recursive: true });
  }
}
export async function reserveExperiment(meta, env = process.env) {
  const root = env.LEMMA_EXPERIMENT_LEDGER,
    cohort =
      env.LEMMA_EXPERIMENT_COHORT === "semanticBase" &&
      meta.structuredAttempt > 0
        ? "semanticRepair"
        : env.LEMMA_EXPERIMENT_COHORT;
  if (!root && !cohort) return null;
  if (!root || !cohort)
    throw Error("Evaluation ledger and cohort must be configured together");
  return update(root, async (v) => {
    if (
      !Number.isSafeInteger(v.maxCalls) ||
      v.maxCalls < 1 ||
      v.maxCalls > 296 ||
      !Number.isSafeInteger(v.caps?.[cohort]) ||
      v.caps[cohort] < 0 ||
      !Array.isArray(v.entries)
    )
      throw Error("Invalid experiment ledger");
    if (
      v.entries.length >= v.maxCalls ||
      v.entries.filter((e) => e.cohort === cohort).length >= v.caps[cohort]
    )
      throw Object.assign(
        Error("Experiment call cap exhausted; request not sent"),
        { recoveryStop: "experiment_budget_exhausted" },
      );
    const e = {
      id: randomUUID(),
      cohort,
      ...meta,
      state: "reserved_charged",
      reservedAt: new Date().toISOString(),
    };
    await writeFile(
      path.join(root, e.id + "-reserved.json"),
      JSON.stringify(e, null, 2),
      { flag: "wx" },
    );
    v.entries.push(e);
    return { root, id: e.id };
  });
}
export async function settleExperiment(ticket, record, error) {
  if (!ticket) return;
  await update(ticket.root, async (v) => {
    const e = v.entries.find((e) => e.id === ticket.id);
    if (!e) throw Error("Lost experiment reservation");
    Object.assign(e, {
      state: error ? "failed_charged" : "received",
      endedAt: new Date().toISOString(),
      requestId: record?.requestId || null,
      finishReason: record?.finishReason || null,
      errorCode: record?.error?.code || null,
      delivery: record?.error?.delivery || null,
      usage: record?.usage || null,
    });
    await writeFile(
      path.join(ticket.root, e.id + "-settled.json"),
      JSON.stringify(e, null, 2),
      { flag: "wx" },
    );
  });
}
