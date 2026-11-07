import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolchainTree } from "../server/toolchain-tree.mjs";
import {
  LEAN_VERSION,
  RELEASE_SHA256,
  LEAN_BINARY_SHA256,
} from "../server/lean.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("This pinned installer targets macOS arm64.");
const name = `lean-${LEAN_VERSION}-darwin_aarch64`,
  tools = path.join(root, ".tools");
const archive = path.join(tools, "downloads", `${name}.zip`);
const url = `https://github.com/leanprover/lean4/releases/download/v${LEAN_VERSION}/${name}.zip`;
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command}: exit ${code}`)),
    );
  });
await mkdir(path.dirname(archive), { recursive: true });
try {
  if ((await stat(archive)).size < 1000000)
    throw new Error("Incomplete archive");
} catch {
  await run("curl", [
    "--fail",
    "--location",
    "--connect-timeout",
    "15",
    "--max-time",
    "900",
    "--output",
    archive,
    url,
  ]);
}
const hash = createHash("sha256");
for await (const bytes of createReadStream(archive)) hash.update(bytes);
if (hash.digest("hex") !== RELEASE_SHA256)
  throw new Error(
    "Official release digest mismatch; archive was not extracted.",
  );
await run("unzip", ["-q", "-o", archive, "-d", tools]);
const binarySha256 = createHash("sha256")
  .update(await readFile(path.join(tools, name, "bin", "lean")))
  .digest("hex");
if (binarySha256 !== LEAN_BINARY_SHA256)
  throw new Error(
    "Extracted binary digest differs from the verified release manifest.",
  );
const distribution = await toolchainTree(path.join(tools, name));
await writeFile(
  path.join(tools, "toolchain.json"),
  JSON.stringify(
    {
      version: LEAN_VERSION,
      url,
      archiveSha256: RELEASE_SHA256,
      binarySha256,
      distribution,
    },
    null,
    2,
  ),
);
console.log(
  `Pinned Lean ${LEAN_VERSION} installed from its verified official release.`,
);
