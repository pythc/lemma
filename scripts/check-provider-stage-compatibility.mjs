import { privateModelMessage } from "../server/public-model-view.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { callModel, modelConfig } from "../server/model.mjs";
const [configRoot, out] = process.argv.slice(2);
if (
  !out ||
  process.env.LEMMA_EXPERIMENT_COHORT !== "capability" ||
  !process.env.LEMMA_EXPERIMENT_LEDGER
)
  throw Error("Compatibility cohort required");
await mkdir(out, { recursive: false });
const cfg = {
  ...(await modelConfig(configRoot)),
  concurrency: 1,
  timeoutMs: 90000,
  maxOutputTokens: 2500,
  reasoningEffort: "low",
};
const tool = (name) => ({
  type: "function",
  function: {
    name,
    description: "Transport compatibility probe only",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
});
const cases = [
  {
    id: "thinking-explore",
    thinking: { type: "enabled" },
    toolChoice: "auto",
    tools: [
      tool("inspect_probe"),
      tool("submit_probe"),
      tool("unavailable_probe"),
    ],
    instruction:
      "Call inspect_probe with value current; do not answer in plain text.",
  },
  {
    id: "thinking-submit",
    thinking: { type: "enabled" },
    toolChoice: "auto",
    tools: [tool("submit_probe"), tool("unavailable_probe")],
    instruction:
      "Call submit_probe with value compatible; do not answer in plain text.",
  },
  {
    id: "nonthinking-forced-submit",
    thinking: { type: "disabled" },
    toolChoice: "required",
    tools: [tool("submit_probe"), tool("unavailable_probe")],
    instruction: "Call submit_probe with value compatible.",
  },
  {
    id: "phase-transition",
    thinking: { type: "disabled" },
    toolChoice: "required",
    tools: [tool("submit_probe"), tool("unavailable_probe")],
    instruction:
      "After the received inspection, call submit_probe with value compatible.",
  },
];
const rows = [];
let prior;
for (const c of cases) {
  const messages = [{ role: "user", content: c.instruction }];
  if (c.id === "phase-transition") {
    if (!prior?.message?.tool_calls?.length) {
      rows.push({
        id: c.id,
        passed: false,
        error: "No successful exploration receipt",
      });
      break;
    }
    messages.splice(
      0,
      0,
      { role: "user", content: cases[0].instruction },
      privateModelMessage(prior),
      ...prior.message.tool_calls.map((t) => ({
        role: "tool",
        tool_call_id: t.id,
        content: '{"status":"available"}',
      })),
    );
  }
  try {
    const r = await callModel(cfg, {
      messages,
      thinking: c.thinking,
      toolChoice: c.toolChoice,
      tools: c.tools,
      role: "STAGE_COMPATIBILITY",
      logicalStage: c.id,
    });
    if (c.id === "thinking-explore") prior = r;
    const expected =
      c.id === "thinking-explore" ? "inspect_probe" : "submit_probe";
    const passed =
      r.message?.tool_calls?.length === 1 &&
      r.message.tool_calls[0].function.name === expected;
    const row = { id: c.id, passed, record: r.record };
    await writeFile(`${out}/${c.id}.json`, JSON.stringify(row, null, 2), {
      flag: "wx",
    });
    rows.push(row);
    if (!passed) break;
  } catch (e) {
    const row = {
      id: c.id,
      passed: false,
      error: e.message,
      record: e.modelRecord || null,
    };
    await writeFile(
      `${out}/${c.id}-failure.json`,
      JSON.stringify(row, null, 2),
      { flag: "wx" },
    );
    rows.push(row);
    break;
  }
}
await writeFile(
  `${out}/result.json`,
  JSON.stringify(
    { passed: rows.length === 4 && rows.every((r) => r.passed), rows },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(
  JSON.stringify(rows.map(({ id, passed, error }) => ({ id, passed, error }))),
);
