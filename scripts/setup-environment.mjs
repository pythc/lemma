// Installs a second sealed native environment without replacing the default.
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  stat,
  readdir,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { ENV_ROOT, environmentCatalog } from "../server/lean-environments.mjs";
import { digest, sha256 } from "../server/evidence.mjs";
import { toolchainTree } from "../server/toolchain-tree.mjs";
import { ResourcePool } from "../server/resource-pool.mjs";
import { runBounded } from "../server/lean.mjs";

const lifetime = new AbortController();
for (const event of ["SIGINT", "SIGTERM"])
  process.on(event, () => lifetime.abort());
const version = process.argv[2] || "4.34.1";
const releases = {
  "4.34.1": {
    sha256: "9019fcd34e93fddf0ecf9d40d28f05a86ba563ac3b701a9c5116ce1c96379360",
    size: 797037816,
  },
};
const release = releases[version];
if (!release || process.platform !== "darwin" || process.arch !== "arm64")
  throw Error("Unpinned release or unsupported host");
const id = `lean-${version}`,
  destination = path.join(ENV_ROOT, id);
if (
  (await environmentCatalog()).some((e) => e.descriptor?.id === id && e.ready)
) {
  console.log(JSON.stringify({ id, status: "already_installed" }));
  const { resolveEnvironment } =
    await import("../server/lean-environments.mjs");
  await resolveEnvironment(
    (await environmentCatalog()).find((e) => e.descriptor?.id === id)
      .descriptor,
  );
  process.exit(0);
}
const downloads = path.join(ENV_ROOT, "downloads");
await mkdir(downloads, { recursive: true });
const archive = path.join(downloads, `${id}.zip`);
const url = `https://github.com/leanprover/lean4/releases/download/v${version}/lean-${version}-darwin_aarch64.zip`;
async function hashFile(file) {
  const h = createHash("sha256");
  for await (const b of createReadStream(file)) h.update(b);
  return h.digest("hex");
}
let valid = false;
try {
  valid = (await hashFile(archive)) === release.sha256;
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
if (!valid) {
  const temp = `${archive}.${randomUUID()}.tmp`;
  try {
    const count = 8,
      span = Math.ceil(release.size / count),
      parts = Array.from({ length: count }, (_, i) => `${archive}.part${i}`);
    const headers = await runBounded(
      "/usr/bin/curl",
      [
        "--disable",
        "--silent",
        "--show-error",
        "--fail",
        "--head",
        "--connect-timeout",
        "30",
        "--max-time",
        "60",
        url,
      ],
      { signal: lifetime.signal, timeoutMs: 65000, maxOutput: 30000 },
    );
    const location = headers.stdout
      .split(/\r?\n/)
      .find((l) => /^location:/i.test(l))
      ?.replace(/^location:\s*/i, "")
      .trim();
    if (
      !location ||
      new URL(location).protocol !== "https:" ||
      new URL(location).hostname !== "release-assets.githubusercontent.com"
    )
      throw Error("Official release redirect unavailable");
    const cancelDownload = new AbortController();
    const downloadPool = new ResourcePool(8);
    const outcomes = await Promise.allSettled(
      parts.map(async (file, i) => {
        try {
          const start = i * span,
            end = Math.min(release.size - 1, (i + 1) * span - 1),
            size = end - start + 1;
          try {
            if ((await stat(file)).size === size) return;
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
          const prefix = `${file}.prefix`;
          let prefixSize = 0;
          try {
            prefixSize = (await stat(prefix)).size;
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
          if (!prefixSize) {
            try {
              const n = (await stat(file)).size;
              if (n > 0 && n < size) {
                await rename(file, prefix);
                prefixSize = n;
              }
            } catch (e) {
              if (e.code !== "ENOENT") throw e;
            }
          }
          const chunks = prefixSize ? 4 : 1,
            remaining = size - prefixSize,
            chunkSize = Math.ceil(remaining / chunks);
          const tails = Array.from({ length: chunks }, (_, j) => ({
            file: `${file}.tail${j}`,
            start: start + prefixSize + j * chunkSize,
            end: Math.min(end, start + prefixSize + (j + 1) * chunkSize - 1),
          })).filter((t) => t.start <= t.end);
          const tailResults = await Promise.allSettled(
            tails.map((t) =>
              downloadPool.run(
                async () => {
                  const expected = t.end - t.start + 1;
                  try {
                    if ((await stat(t.file)).size === expected) return;
                  } catch (e) {
                    if (e.code !== "ENOENT") throw e;
                  }
                  const download = await runBounded(
                    "/usr/bin/curl",
                    [
                      "--disable",
                      "--silent",
                      "--show-error",
                      "--fail",
                      "--location",
                      "--connect-timeout",
                      "60",
                      "--retry",
                      "3",
                      "--retry-delay",
                      "2",
                      "--max-time",
                      "1800",
                      "--max-filesize",
                      String(expected),
                      "--range",
                      `${t.start}-${t.end}`,
                      "--output",
                      t.file,
                      location,
                    ],
                    {
                      signal: AbortSignal.any([
                        lifetime.signal,
                        cancelDownload.signal,
                      ]),
                      timeoutMs: 31 * 60 * 1000,
                      maxOutput: 10000,
                    },
                  );
                  if (
                    download.exitCode !== 0 ||
                    download.termination ||
                    (await stat(t.file)).size !== expected
                  )
                    throw Error(
                      download.stderr ||
                        download.termination ||
                        "Release part size mismatch",
                    );
                },
                { signal: cancelDownload.signal },
              ),
            ),
          );
          const rejected = tailResults.find((t) => t.status === "rejected");
          if (rejected) throw rejected.reason;
          const assembled = `${file}.assembled`;
          await pipeline(
            Readable.from(
              (async function* () {
                for (const f of [
                  ...(prefixSize ? [prefix] : []),
                  ...tails.map((t) => t.file),
                ])
                  for await (const b of createReadStream(f)) yield b;
              })(),
            ),
            createWriteStream(assembled, { mode: 0o600 }),
          );
          if ((await stat(assembled)).size !== size)
            throw Error("Assembled release size mismatch");
          await rename(assembled, file);
        } catch (e) {
          cancelDownload.abort();
          throw e;
        }
      }),
    );
    const failed = outcomes.find((o) => o.status === "rejected");
    if (failed) throw failed.reason;
    await pipeline(
      Readable.from(
        (async function* () {
          for (const f of parts)
            for await (const b of createReadStream(f)) yield b;
        })(),
      ),
      createWriteStream(temp, { flags: "wx", mode: 0o600 }),
    );
    if ((await hashFile(temp)) !== release.sha256)
      throw Error("Official release digest mismatch");
    await rename(temp, archive);
  } finally {
    await rm(temp, { force: true });
  }
}
// Remove only this installer's verified download fragments; retain the archive.
for (const name of await readdir(downloads)) {
  const base = `${id}.zip.part`;
  if (
    name.startsWith(base) &&
    /^[0-7](?:\.prefix|\.tail[0-9]+)?$/.test(name.slice(base.length))
  )
    await rm(path.join(downloads, name), { force: true });
}
const staging = path.join(ENV_ROOT, `${id}-staging-${randomUUID()}`);
await mkdir(staging, { recursive: true });
try {
  const extracted = await runBounded(
    "/usr/bin/unzip",
    ["-q", archive, "-d", staging],
    { signal: lifetime.signal, timeoutMs: 20 * 60 * 1000 },
  );
  if (extracted.exitCode !== 0) throw Error(extracted.stderr);
  const toolRoot = `lean-${version}-darwin_aarch64`;
  const full = path.join(staging, toolRoot);
  const receipt = {
    schemaVersion: "lemma.native-environment.v1",
    version,
    platform: process.platform,
    arch: process.arch,
    url,
    archiveSha256: release.sha256,
    toolRoot,
    binarySha256: sha256(await readFile(path.join(full, "bin/lean"))),
    distribution: await toolchainTree(full),
    libraryRevision: `lean-${version}-std`,
    libraryPaths: [],
    librarySha256: digest([]),
    profiles: ["std-v1"],
  };
  await writeFile(
    path.join(staging, "receipt.json"),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600 },
  );
  await rename(staging, destination);
  console.log(
    JSON.stringify({ id, status: "installed", profiles: receipt.profiles }),
  );
} finally {
  await rm(staging, { force: true, recursive: true });
}
