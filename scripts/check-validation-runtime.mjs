import { verifyValidationRuntime } from "../server/validation-runtime.mjs";
try {
  console.log(JSON.stringify(await verifyValidationRuntime(), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
