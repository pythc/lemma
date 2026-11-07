// Read config and write a key-free request preview; never dispatch inference.
import { readFile, writeFile } from "node:fs/promises";
import { semanticModelConfig } from "../server/model.mjs";
import {
  selectStrictAuditConfig,
  strictAuditConfigurationPreview,
} from "../server/strict-audit-config.mjs";
import { verifyValidationRuntime } from "../server/validation-runtime.mjs";
import { contentTree } from "../server/toolchain-tree.mjs";
import { EVALUATION_CODE_PATHS } from "../server/evaluation-registration.mjs";
import {
  ANCHORED_AUDIT_PROMPT,
  ANCHORED_COMPARISON_PROMPT,
} from "../server/audit-wire.mjs";
import { auditBodyPrompt } from "../server/audit-envelope.mjs";
const [configRoot, inputFile, output] = process.argv.slice(2);
if (!configRoot || !inputFile || !output)
  throw Error(
    "Expected CONFIG_ROOT INPUT_JSON NEW_OUTPUT; explicit protocol and endpoint env required",
  );
const runtime = await verifyValidationRuntime();
const config = selectStrictAuditConfig(await semanticModelConfig(configRoot));
const input = JSON.parse(await readFile(inputFile, "utf8"));
const system = auditBodyPrompt(
  input.stage ? ANCHORED_COMPARISON_PROMPT : ANCHORED_AUDIT_PROMPT,
  !!input.stage,
  input.context.semanticProtocol,
  config.auditBindingProtocol,
);
const preview = strictAuditConfigurationPreview(config, input, system);
await writeFile(
  output,
  JSON.stringify(
    {
      ...preview,
      runtime,
      implementation: await contentTree(process.cwd(), EVALUATION_CODE_PATHS),
      externalModelCalls: 0,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    output,
    endpoint: preview.endpoint,
    protocol: preview.auditBindingProtocol,
    thinking: preview.thinking,
    externalModelCalls: 0,
  }),
);
