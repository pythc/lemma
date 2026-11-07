import { fileURLToPath } from "node:url";
import { quarantineGeneration } from "../server/library-generation.mjs";
// Explicit, recoverable maintenance. Does not delete or collect any snapshot.
console.log(
  JSON.stringify(
    await quarantineGeneration(
      fileURLToPath(new URL("../.tools/mathlib-generations", import.meta.url)),
      process.argv[2],
    ),
    null,
    2,
  ),
);
