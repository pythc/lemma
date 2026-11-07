import { open, rename, rm, link } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
// Staging is never a readable content-addressed object. Linking publishes a
// complete immutable file without overwriting an existing hash identity.
export async function durableFile(
  destination,
  bytes,
  { immutable = false } = {},
) {
  const temporary = destination + "." + randomUUID() + ".tmp";
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (immutable) await link(temporary, destination);
    else await rename(temporary, destination);
    await syncDirectory(path.dirname(destination));
  } finally {
    await rm(temporary, { force: true });
  }
}
