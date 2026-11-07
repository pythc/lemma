import test from "node:test";
import assert from "node:assert/strict";
import { LibraryAccess } from "../server/library-access.mjs";
const barrier = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
test("cache writer waits for active proof, and later readers wait for publication", async () => {
  const lock = new LibraryAccess(),
    first = barrier(),
    started = barrier(),
    order = [];
  const proof = lock.read(async () => {
    order.push("proof");
    started.release();
    await first.promise;
  });
  await started.promise;
  const writer = lock.write(async () => {
    order.push("write");
  });
  const reader = lock.read(async () => {
    order.push("read");
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ["proof"]);
  first.release();
  await Promise.all([proof, writer, reader]);
  assert.deepEqual(order, ["proof", "write", "read"]);
});
test("nested final checking can read during a queued cache update without deadlock", async () => {
  const lock = new LibraryAccess(),
    inside = barrier(),
    nested = barrier();
  const proof = lock.read(async () => {
    inside.release();
    await nested.promise;
    return lock.read(async () => 42);
  });
  await inside.promise;
  const update = lock.write(async () => true);
  nested.release();
  assert.equal(await proof, 42);
  assert.equal(await update, true);
  await assert.rejects(
    lock.read(() => lock.write(async () => {})),
    /活跃证明/,
  );
});
test("cancelling a waiting cache operation never executes it or holds the lock", async () => {
  const lock = new LibraryAccess(),
    first = barrier(),
    inside = barrier(),
    controller = new AbortController();
  let executed = false;
  const read = lock.read(async () => {
    inside.release();
    await first.promise;
  });
  await inside.promise;
  const write = lock.write(
    async () => {
      executed = true;
    },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(write);
  controller.abort();
  await rejected;
  first.release();
  await read;
  assert.equal(executed, false);
  assert.equal(await lock.write(async () => 7), 7);
});
