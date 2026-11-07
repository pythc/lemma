import { verifyValidationRuntime } from "../server/validation-runtime.mjs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
try {
  await verifyValidationRuntime();
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      pkg.scripts.test.split(" ").slice(1),
      { stdio: "inherit", env: process.env },
    );
    child.once("error", reject);
    child.once("close", resolve);
  });
  process.exitCode = code;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
