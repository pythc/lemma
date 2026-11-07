import os from "node:os";

// Host capacity only: no role, proof stage or paper can change admission.
// Reserve half of physical memory for the OS, CLI actors and library builds;
// each admitted Lean worker retains its existing 8 GiB process envelope.
export function nativePolicy({
  memoryBytes = os.totalmem(),
  cpus = os.availableParallelism(),
  override = process.env.LEMMA_LEAN_CONCURRENCY,
} = {}) {
  const memoryMiB = Math.floor(memoryBytes / 1048576);
  const automatic = Math.max(
    1,
    Math.min(3, cpus - 1, Math.floor(memoryMiB / 2 / 8192)),
  );
  const concurrency = override === undefined ? automatic : Number(override);
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > automatic
  )
    throw Error(
      `LEMMA_LEAN_CONCURRENCY must be between 1 and host capacity ${automatic}`,
    );
  return {
    concurrency,
    hostCapacity: automatic,
    workerMemoryMiB: 8192,
    memoryMiB,
    cpus,
    source: override === undefined ? "host_capacity" : "explicit_lower_limit",
  };
}
export const nativeResourcePolicy = nativePolicy();
