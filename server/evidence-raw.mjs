import { createReadStream } from "node:fs";
import { open, rm, rename, link } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isHash } from "./evidence.mjs";
import { syncDirectory } from "./durable-files.mjs";
// Stored objects use canonical {inputs,kind,payload} JSON. Graph traversal only
// needs the small envelope; decoding a 30 MB payload just to copy it multiplies
// heap pressure. The full original bytes are still checked against their hash.
export async function streamArtifact(
  file,
  id,
  { signal, onChunk, maxHeaderBytes = 64 * 1024 * 1024 } = {},
) {
  if (!isHash(id)) throw Error("Invalid evidence identity");
  const hash = createHash("sha256"),
    marker = Buffer.from(',"payload":');
  let bytes = 0,
    parts = [],
    header = null,
    tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, {
    signal,
    highWaterMark: 65536,
  })) {
    hash.update(chunk);
    if (!header) {
      const scan = Buffer.concat([tail, chunk]),
        at = scan.indexOf(marker);
      parts.push(chunk);
      if (at >= 0) {
        const end = bytes - tail.length + at + marker.length;
        if (end > maxHeaderBytes)
          throw Error("Artifact edge envelope exceeds bounded memory");
        const prefix = Buffer.concat(parts, bytes + chunk.length)
          .subarray(0, end)
          .toString("utf8");
        if (!prefix.startsWith('{"inputs":'))
          throw Error("Artifact is not canonical content-addressed JSON");
        header = JSON.parse(prefix + "null}");
        if (
          Object.keys(header).join(",") !== "inputs,kind,payload" ||
          !Array.isArray(header.inputs) ||
          !header.inputs.every(isHash) ||
          typeof header.kind !== "string"
        )
          throw Error("Invalid artifact envelope");
        parts = [];
        tail = Buffer.alloc(0);
      } else {
        if (bytes + chunk.length > maxHeaderBytes)
          throw Error("Artifact edge envelope exceeds bounded memory");
        tail = scan.subarray(Math.max(0, scan.length - marker.length + 1));
      }
    }
    bytes += chunk.length;
    await onChunk?.(chunk);
  }
  if (!header || hash.digest("hex") !== id)
    throw Error("Evidence byte digest mismatch");
  return { id, kind: header.kind, inputs: header.inputs, bytes };
}
export async function copyArtifactFile(
  source,
  destination,
  id,
  { signal, immutable = false } = {},
) {
  const temp = destination + "." + randomUUID() + ".tmp";
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    const result = await streamArtifact(source, id, {
      signal,
      onChunk: (bytes) => handle.writeFile(bytes),
    });
    await handle.sync();
    await handle.close();
    handle = null;
    if (immutable) {
      try {
        await link(temp, destination);
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        await streamArtifact(destination, id, { signal });
      }
    } else await rename(temp, destination);
    await syncDirectory(path.dirname(destination));
    return result;
  } finally {
    await handle?.close();
    await rm(temp, { force: true });
  }
}
