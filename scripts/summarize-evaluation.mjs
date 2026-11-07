import { readFile, writeFile } from "node:fs/promises";
import { summarizeExperiment, compareExperiments } from "../server/evaluation-protocol.mjs";
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const [mode, ...args] = process.argv.slice(2);
if (mode === "compare") {
  const [before, after, output] = args;
  await writeFile(output, JSON.stringify(compareExperiments(await read(before), await read(after)), null, 2), { flag: "wx" });
} else if (mode === "summarize") {
  const [inputs, gold, execution, output] = args, run = await read(execution);
  await writeFile(output, JSON.stringify(summarizeExperiment(await read(inputs), await read(gold), run.rows, run.experiment), null, 2), { flag: "wx" });
} else throw Error("Usage: summarize inputs gold execution NEW-output | compare before after NEW-output");
