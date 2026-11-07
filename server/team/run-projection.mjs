// Public projections are reconstructable from durable cells, not a second proof
// source. Large append-only arrays are committed as changed cells in one WAL
// transaction instead of rewriting every historical receipt on every phase.
export class RunProjection {
  constructor(journal) {
    this.journal = journal;
    this.cache = new Map();
  }
  async save(run) {
    const before = this.cache.get(run.id) || new Map(),
      next = new Map(),
      layout = {};
    for (const [key, value] of Object.entries(run)) {
      if (Array.isArray(value)) {
        layout[key] = { kind: "array", length: value.length };
        for (let i = 0; i < value.length; i++)
          next.set(`${key}/${i}`, JSON.stringify(value[i]));
      } else if (value && typeof value === "object" && key === "references") {
        layout[key] = { kind: "object", keys: Object.keys(value) };
        for (const [k, v] of Object.entries(value))
          next.set(`${key}/${k}`, JSON.stringify(v));
      } else {
        layout[key] = { kind: "value" };
        next.set(key, JSON.stringify(value));
      }
    }
    const changes = [...next].filter(
      ([key, value]) => before.get(key) !== value,
    );
    const removed = [...before.keys()].filter((key) => !next.has(key));
    await this.journal.call("project", {
      runId: run.id,
      revision: run.revision,
      layout,
      changes,
      removed,
    });
    this.cache.set(run.id, next);
  }
  async read(runId) {
    return this.journal.call("projection", { runId });
  }
}
