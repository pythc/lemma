import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "lemma-process-lock-"),
  );
  const children = [];
  t.after(async () => {
    await Promise.all(
      children.map(async (c) => {
        if (c.exitCode === null && c.signalCode === null) {
          const stopped = once(c, "exit");
          c.kill("SIGKILL");
          await stopped;
        }
      }),
    );
    await rm(directory, { recursive: true, force: true });
  });
  function start(mode) {
    const child = fork(
      new URL("./helpers/library-process.mjs", import.meta.url),
      [path.join(directory, "library.lock"), mode],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    children.push(child);
    const events = [];
    child.on("message", (m) => events.push(m));
    child.wait = async (event) => {
      for (let i = 0; i < 300; i++) {
        const found = events.find((e) => e.event === event);
        if (found) return found;
        if (child.exitCode !== null || child.signalCode !== null)
          throw Error(
            `Child exited before ${event}: ${JSON.stringify(events)}`,
          );
        await delay(20);
      }
      throw Error(`Timed out awaiting ${event}: ${JSON.stringify(events)}`);
    };
    child.events = events;
    return child;
  }
  return { start };
}

test("independent writer cannot publish while another process holds a proof read", async (t) => {
  const { start } = await fixture(t);
  const reader = start("read");
  await reader.wait("entered");
  const writer = start("write");
  await writer.wait("attempting");
  await delay(300);
  assert.equal(
    writer.events.some((e) => e.event === "entered"),
    false,
  );
  reader.send("release");
  await reader.wait("released");
  await writer.wait("entered");
  writer.send("release");
  await writer.wait("released");
});

test("independent readers coexist, while publication excludes new readers", async (t) => {
  const { start } = await fixture(t);
  const a = start("read"),
    b = start("read");
  await Promise.all([a.wait("entered"), b.wait("entered")]);
  a.send("release");
  b.send("release");
  await Promise.all([a.wait("released"), b.wait("released")]);
  const writer = start("write");
  await writer.wait("entered");
  const c = start("read");
  await c.wait("attempting");
  await delay(300);
  assert.equal(
    c.events.some((e) => e.event === "entered"),
    false,
  );
  writer.send("release");
  await writer.wait("released");
  await c.wait("entered");
  c.send("release");
  await c.wait("released");
});

test("a killed owner releases its OS lease and a cancelled waiter never enters", async (t) => {
  const { start } = await fixture(t);
  const owner = start("write");
  await owner.wait("entered");
  const cancelled = start("read");
  await cancelled.wait("attempting");
  cancelled.send("cancel");
  await cancelled.wait("rejected");
  assert.equal(
    cancelled.events.some((e) => e.event === "entered"),
    false,
  );
  const next = start("write");
  await next.wait("attempting");
  const exited = once(owner, "exit");
  owner.kill("SIGKILL");
  await exited;
  await next.wait("entered");
  next.send("release");
  await next.wait("released");
});
