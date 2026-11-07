import { nativeHostSnapshot } from "./native-host.mjs";
import { nativeResourcePolicy } from "./native-policy.mjs";
import { ResourcePool, leanPool } from "../resource-pool.mjs";
import { setTimeout as delay } from "node:timers/promises";

export const budgetUsedMs = (account, now = Date.now()) =>
  Math.max(
    0,
    (account.policy === "active-v1"
      ? (account.pausedAt || now) - (account.pausedMs || 0)
      : now) - account.startedAt,
  );

// Resource admission knows nothing about roles, proofs, or task transitions.
export class TeamResources {
  constructor({
    concurrency = 4,
    maxTurns = 4096,
    maxRunMs = 48 * 3600000,
  } = {}) {
    for (const n of [concurrency, maxTurns, maxRunMs])
      if (!Number.isSafeInteger(n) || n < 1)
        throw Error("Invalid resource capacity");
    this.pool = new ResourcePool(concurrency);
    this.policy = {
      concurrency,
      maxTurns,
      maxRunMs,
      native: nativeResourcePolicy,
    };
  }
  snapshot() {
    return { model: this.pool.snapshot(), lean: leanPool.snapshot() };
  }
  async observe() {
    return { ...this.snapshot(), hostLean: await nativeHostSnapshot() };
  }
  capacityRetryDelay(attempt) {
    return Math.min(30000, 1000 * 2 ** Math.min(5, Math.max(0, attempt - 1)));
  }
  async execute(account, action, { signal, onStarted, notBefore = 0 } = {}) {
    if (notBefore > Date.now())
      await delay(notBefore - Date.now(), null, { signal });
    return this.pool.run(
      async () => {
        signal?.throwIfAborted();
        if (
          account.turns >= this.policy.maxTurns ||
          budgetUsedMs(account) >= this.policy.maxRunMs
        )
          throw Object.assign(Error("本轮总运行预算已用尽"), {
            code: "team_budget_exhausted",
          });
        account.turns++;
        await onStarted?.();
        const remaining = this.policy.maxRunMs - budgetUsedMs(account);
        const deadline = AbortSignal.timeout(Math.max(1, remaining));
        return action(signal ? AbortSignal.any([signal, deadline]) : deadline);
      },
      { signal },
    );
  }
}
