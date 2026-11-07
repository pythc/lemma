import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nativeResourcePolicy } from "./native-policy.mjs";
export const nativeHost = {
  helper: fileURLToPath(
    new URL("../../worker/native_slot.py", import.meta.url),
  ),
  root:
    process.env.LEMMA_NATIVE_RESOURCE_ROOT ||
    path.join(os.homedir(), ".cache/lemma/native-v1"),
  python: "/usr/bin/python3",
  capacity: nativeResourcePolicy.hostCapacity,
};
export function needsNativeAdmission(command, args) {
  return [command, ...args].some(
    (s) => typeof s === "string" && ["lean", "lake"].includes(path.basename(s)),
  );
}
let pending, cached;
export async function nativeHostSnapshot() {
  if (cached && Date.now() - cached.at < 500) return cached.value;
  if (!pending)
    pending = promisify(execFile)(
      nativeHost.python,
      [
        nativeHost.helper,
        nativeHost.root,
        String(nativeHost.capacity),
        "--snapshot",
      ],
      { timeout: 5000, maxBuffer: 4000 },
    )
      .then(({ stdout }) => {
        const value = {
          ...JSON.parse(stdout),
          observedAt: new Date().toISOString(),
        };
        cached = { at: Date.now(), value };
        return value;
      })
      .catch((error) => ({
        scope: "local_host",
        status: "unavailable",
        reason: error.message,
      }))
      .finally(() => {
        pending = null;
      });
  return pending;
}
