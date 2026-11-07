import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const birth = (pid) => {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
};

mkdirSync(workerData.root, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path.join(workerData.root, "team-actions.sqlite"));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS projections(run_id TEXT PRIMARY KEY,revision INTEGER,layout TEXT);
 CREATE TABLE IF NOT EXISTS cells(run_id TEXT,key TEXT,value TEXT,PRIMARY KEY(run_id,key));
 CREATE TABLE IF NOT EXISTS successors (run_id TEXT, root TEXT, epoch TEXT, PRIMARY KEY(run_id,root));
 CREATE TABLE IF NOT EXISTS owner (slot INTEGER PRIMARY KEY, epoch TEXT, pid INTEGER, birth TEXT);
 CREATE TABLE IF NOT EXISTS actions (
  run_id TEXT NOT NULL, id TEXT NOT NULL, actor_id TEXT NOT NULL,
  logical_key TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
  body TEXT NOT NULL, PRIMARY KEY(run_id,id));
 CREATE INDEX IF NOT EXISTS actions_key ON actions(run_id,logical_key);
 CREATE TABLE IF NOT EXISTS aliases (
  run_id TEXT NOT NULL, request_id TEXT NOT NULL, action_id TEXT NOT NULL,
  PRIMARY KEY(run_id,request_id));
 CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
  action_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL);`);
const parse = (row) => (row ? JSON.parse(row.body) : null);
const event = (run, id, kind, body) =>
  db
    .prepare(
      "INSERT INTO events(run_id,action_id,kind,at,body) VALUES(?,?,?,?,?)",
    )
    .run(run, id, kind, new Date().toISOString(), JSON.stringify(body));
function transaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const v = fn();
    db.exec("COMMIT");
    return v;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
// An epoch is exclusive even to another runtime in the same process. No timeout
// steals a live owner. Process birth identity prevents PID-reuse mistakes.
const ownBirth = birth(process.pid);
transaction(() => {
  const old = db.prepare("SELECT * FROM owner WHERE slot=1").get();
  if (
    old &&
    old.epoch !== workerData.epoch &&
    birth(old.pid) === old.birth &&
    old.birth
  )
    throw Error("Action store already has a live owner");
  db.prepare("INSERT OR REPLACE INTO owner VALUES(1,?,?,?)").run(
    workerData.epoch,
    process.pid,
    ownBirth,
  );
  // Recovery never dispatches. A crash before acknowledgement is still unknown.
  for (const row of db
    .prepare(
      "SELECT * FROM actions WHERE state IN ('accepted','queued','dispatching','running','cancelling')",
    )
    .all()) {
    const old = parse(row),
      patch = {
        status: "unknown",
        reason:
          "Writer ownership changed; execution outcome must be reconciled, never replayed",
      };
    db.prepare("UPDATE actions SET state=?,body=? WHERE run_id=? AND id=?").run(
      "unknown",
      JSON.stringify({ ...old, ...patch }),
      row.run_id,
      row.id,
    );
    event(row.run_id, row.id, "owner_recovery", patch);
  }
});
const fence = () => {
  if (
    db.prepare("SELECT epoch FROM owner WHERE slot=1").get()?.epoch !==
    workerData.epoch
  )
    throw Error("Action owner epoch lost");
};
function registerAlias(runId, requestId, actionId) {
  if (!requestId) return;
  const old = db
    .prepare("SELECT action_id FROM aliases WHERE run_id=? AND request_id=?")
    .get(runId, requestId);
  if (old && old.action_id !== actionId)
    throw Error("Transport identity already belongs to another action");
  db.prepare("INSERT OR IGNORE INTO aliases VALUES(?,?,?)").run(
    runId,
    requestId,
    actionId,
  );
}
const api = {
  project({ runId, revision, layout, changes, removed }) {
    return transaction(() => {
      const old = db
        .prepare("SELECT revision FROM projections WHERE run_id=?")
        .get(runId);
      if (old && revision < old.revision)
        throw Error("Public projection revision went backwards");
      for (const [key, value] of changes)
        db.prepare("INSERT OR REPLACE INTO cells VALUES(?,?,?)").run(
          runId,
          key,
          value,
        );
      for (const key of removed)
        db.prepare("DELETE FROM cells WHERE run_id=? AND key=?").run(
          runId,
          key,
        );
      db.prepare("INSERT OR REPLACE INTO projections VALUES(?,?,?)").run(
        runId,
        revision,
        JSON.stringify(layout),
      );
      return { revision, changed: changes.length };
    });
  },
  projection({ runId }) {
    const saved = db
      .prepare("SELECT * FROM projections WHERE run_id=?")
      .get(runId);
    if (!saved) return null;
    const layout = JSON.parse(saved.layout),
      cells = new Map(
        db
          .prepare("SELECT key,value FROM cells WHERE run_id=?")
          .all(runId)
          .map((r) => [r.key, JSON.parse(r.value)]),
      ),
      run = {};
    for (const [key, v] of Object.entries(layout)) {
      if (v.kind === "array")
        run[key] = Array.from({ length: v.length }, (_, i) =>
          cells.get(`${key}/${i}`),
        );
      else if (v.kind === "object")
        run[key] = Object.fromEntries(
          v.keys.map((k) => [k, cells.get(`${key}/${k}`)]),
        );
      else run[key] = cells.get(key);
    }
    return run;
  },
  importEvents({ runId, events }) {
    return transaction(() => {
      for (const e of events) {
        if (e.run_id !== runId) throw Error("Journal segment run mismatch");
        const existing = db
          .prepare("SELECT * FROM events WHERE seq=?")
          .get(e.seq);
        if (existing) {
          if (
            existing.run_id !== runId ||
            existing.body !== JSON.stringify(e.body) ||
            existing.kind !== e.kind
          )
            throw Error("Journal segment sequence collision");
          continue;
        }
        db.prepare(
          "INSERT INTO events(seq,run_id,action_id,kind,at,body) VALUES(?,?,?,?,?,?)",
        ).run(e.seq, runId, e.action_id, e.kind, e.at, JSON.stringify(e.body));
        if (e.kind === "accepted") {
          const a = e.body;
          db.prepare("INSERT INTO actions VALUES(?,?,?,?,?,?,?)").run(
            runId,
            a.id,
            a.actorId,
            a.logicalKey,
            a.fingerprint,
            a.status,
            JSON.stringify(a),
          );
          db.prepare("INSERT OR IGNORE INTO aliases VALUES(?,?,?)").run(
            runId,
            a.id,
            a.id,
          );
        } else if (
          ["updated", "owner_recovery", "reconciled_unknown"].includes(e.kind)
        ) {
          const a = parse(
            db
              .prepare("SELECT body FROM actions WHERE run_id=? AND id=?")
              .get(runId, e.action_id),
          );
          if (!a) throw Error("Journal update precedes action");
          const next = { ...a, ...e.body };
          db.prepare(
            "UPDATE actions SET state=?,body=? WHERE run_id=? AND id=?",
          ).run(next.status, JSON.stringify(next), runId, e.action_id);
        } else if (e.kind === "reconnected") {
          registerAlias(runId, e.body.requestId, e.action_id);
          registerAlias(runId, e.body.transportId, e.action_id);
        }
      }
      return events.length;
    });
  },
  resumeClaim({ runId, root }) {
    try {
      db.prepare("INSERT INTO successors VALUES(?,?,?)").run(
        runId,
        root,
        workerData.epoch,
      );
    } catch (e) {
      throw Error(
        "Checkpoint already has a durable resume claim; reconcile it before further dispatch",
      );
    }
    return true;
  },
  health() {
    return { epoch: workerData.epoch, pid: process.pid, birth: ownBirth };
  },
  reconcile({ runId, operations }) {
    return transaction(() => {
      // The journal acknowledgement is authoritative. A crash between its commit
      // and projection publication cannot erase a received result or invent a retry.
      for (const row of db
        .prepare("SELECT body FROM actions WHERE run_id=? ORDER BY rowid")
        .all(runId)) {
        const {
          originalArguments,
          resolvedArguments,
          receivedOutcome,
          ...saved
        } = parse(row);
        const op = operations.find((o) => o.id === saved.id);
        if (op) Object.assign(op, saved);
        else operations.push(saved);
      }
      return operations;
    });
  },
  reject({ runId, actorId, request, error }) {
    event(runId, request.operationId, "admission_rejected", {
      actorId,
      request,
      error,
    });
    return true;
  },
  claim(a) {
    return transaction(() => {
      const alias = db
        .prepare(
          "SELECT a.* FROM aliases x JOIN actions a ON a.run_id=x.run_id AND a.id=x.action_id WHERE x.run_id=? AND x.request_id=?",
        )
        .get(a.runId, a.requestId);
      if (alias) {
        if (
          alias.actor_id !== a.actorId ||
          alias.fingerprint !== a.fingerprint ||
          alias.logical_key !== a.logicalKey
        )
          throw Error(
            "Action identity belongs to different input or actor version",
          );
        const transport = db
          .prepare(
            "SELECT action_id FROM aliases WHERE run_id=? AND request_id=?",
          )
          .get(a.runId, a.transportId || a.requestId);
        if (transport && transport.action_id !== alias.id)
          throw Error("Transport identity already belongs to another action");
        if (a.transportId && a.transportId !== a.requestId)
          db.prepare("INSERT OR IGNORE INTO aliases VALUES(?,?,?)").run(
            a.runId,
            a.transportId,
            alias.id,
          );
        event(a.runId, alias.id, "reconnected", {
          requestId: a.requestId,
          transportId: a.transportId,
        });
        return { created: false, action: parse(alias) };
      }
      let previous = a.coalesce
        ? db
            .prepare(
              "SELECT * FROM actions WHERE run_id=? AND logical_key=? ORDER BY rowid DESC LIMIT 1",
            )
            .get(a.runId, a.logicalKey)
        : null;
      if (
        a.forceNew &&
        previous &&
        ["completed", "failed", "cancelled", "not_sent"].includes(
          previous.state,
        )
      )
        previous = null;
      if (
        previous &&
        !["failed", "cancelled", "not_sent"].includes(previous.state)
      ) {
        registerAlias(a.runId, a.requestId, previous.id);
        registerAlias(a.runId, a.transportId, previous.id);
        event(a.runId, previous.id, "reconnected", {
          requestId: a.requestId,
          transportId: a.transportId,
          explicitNew: a.forceNew,
        });
        return { created: false, action: parse(previous) };
      }
      const action = {
        ...a.operation,
        status: "accepted",
        executionDispatched: false,
      };
      db.prepare("INSERT INTO actions VALUES(?,?,?,?,?,?,?)").run(
        a.runId,
        action.id,
        a.actorId,
        a.logicalKey,
        a.fingerprint,
        action.status,
        JSON.stringify(action),
      );
      db.prepare("INSERT INTO aliases VALUES(?,?,?)").run(
        a.runId,
        a.requestId,
        action.id,
      );
      if (a.transportId && a.transportId !== a.requestId)
        db.prepare("INSERT INTO aliases VALUES(?,?,?)").run(
          a.runId,
          a.transportId,
          action.id,
        );
      event(a.runId, action.id, "accepted", action);
      event(a.runId, action.id, "reconnected", {
        requestId: a.requestId,
        transportId: a.transportId,
      });
      return { created: true, action };
    });
  },
  update({ runId, id, patch }) {
    return transaction(() => {
      const old = parse(
        db
          .prepare("SELECT body FROM actions WHERE run_id=? AND id=?")
          .get(runId, id),
      );
      if (!old) throw Error("No durable action");
      const next = { ...old, ...patch };
      db.prepare(
        "UPDATE actions SET state=?,body=? WHERE run_id=? AND id=?",
      ).run(next.status, JSON.stringify(next), runId, id);
      event(runId, id, "updated", patch);
      return next;
    });
  },
  get({ runId, id }) {
    return (
      parse(
        db
          .prepare(
            "SELECT a.body FROM aliases x JOIN actions a ON a.run_id=x.run_id AND a.id=x.action_id WHERE x.run_id=? AND x.request_id=?",
          )
          .get(runId, id),
      ) ||
      parse(
        db
          .prepare("SELECT body FROM actions WHERE run_id=? AND id=?")
          .get(runId, id),
      )
    );
  },
  events({ runId, after = 0, limit = 100 }) {
    return db
      .prepare(
        "SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(runId, after, Math.min(limit, 1000))
      .map((x) => ({ ...x, body: JSON.parse(x.body) }));
  },
  close() {
    db.prepare("DELETE FROM owner WHERE epoch=?").run(workerData.epoch);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    return true;
  },
};
parentPort.on("message", ({ id, method, args }) => {
  try {
    fence();
    if (!Object.hasOwn(api, method)) throw Error("Unknown journal method");
    parentPort.postMessage({ id, value: api[method](args) });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
