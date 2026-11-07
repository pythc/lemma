import { spawn } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const helper = fileURLToPath(
  new URL("../worker/library_lease.py", import.meta.url),
);

export async function acquireFileLease(file, mode, { signal } = {}) {
  signal?.throwIfAborted();
  if (!["read", "write"].includes(mode))
    throw Error("Invalid library lease mode");
  if (!["darwin", "linux"].includes(process.platform))
    throw Error(
      "Kernel library leases require a separately validated POSIX host",
    );
  await mkdir(path.dirname(file), { recursive: true });
  const filename = path.join(
    await realpath(path.dirname(file)),
    path.basename(file),
  );
  signal?.throwIfAborted();
  const child = spawn(
    process.env.LEMMA_LOCK_PYTHON || "/usr/bin/python3",
    [helper, filename, mode],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    },
  );
  let acquired = false,
    releasing = false,
    lost = null,
    output = "",
    stderr = "";
  let accept, reject;
  const ready = new Promise((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  let closed;
  const ended = new Promise((resolve) => (closed = resolve));
  const failure = (message) =>
    Object.assign(new Error(message), {
      code: "library_lease_lost",
    });
  const abort = () => {
    child.stdin.destroy();
    child.kill("SIGTERM");
    reject(
      signal.reason || failure("Library lease cancelled before acquisition"),
    );
  };
  signal?.addEventListener("abort", abort, { once: true });
  child.stdin.on("error", () => {}); // Exit handler owns failure reporting.
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(0, 4000);
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (acquired || output.length > 1000) {
      lost = failure("Unexpected library lease protocol output");
      reject(lost);
      child.kill("SIGTERM");
      return;
    }
    if (!output.endsWith("\n")) return;
    try {
      const receipt = JSON.parse(output);
      if (receipt.acquired !== true || receipt.mode !== mode)
        throw Error("Invalid library lease receipt");
      if (signal?.aborted) return abort();
      acquired = true;
      signal?.removeEventListener("abort", abort);
      accept(receipt);
    } catch (error) {
      lost = failure(error.message);
      reject(lost);
      child.kill("SIGTERM");
    }
  });
  child.on("error", (error) => {
    lost = failure(`Library lease helper unavailable: ${error.message}`);
    reject(lost);
  });
  child.on("close", (code, exitSignal) => {
    signal?.removeEventListener("abort", abort);
    if (!releasing) {
      lost ||= failure(
        `Library lease helper exited (${code ?? exitSignal}): ${stderr}`,
      );
      reject(lost);
    }
    closed();
  });
  try {
    if (signal?.aborted) abort();
    const receipt = await ready;
    return {
      receipt: {
        ...receipt,
        mechanism: "local_posix_flock",
        scope: "local_host",
      },
      assertHeld() {
        if (lost) throw lost;
      },
      async release() {
        releasing = true;
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
        try {
          await ended;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  } catch (error) {
    releasing = true;
    child.stdin.destroy();
    child.kill("SIGTERM");
    await ended;
    throw error;
  }
}
