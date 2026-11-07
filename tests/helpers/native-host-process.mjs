import { runBounded } from "../../server/lean.mjs";
import { executionContext } from "../../server/execution-context.mjs";
const controller = new AbortController();
process.on("message", (m) => {
  if (m === "cancel") controller.abort();
});
const result = await executionContext.run(
  {
    onToolQueued: () => process.send({ event: "queued" }),
    onToolStarted: () => process.send({ event: "executing" }),
  },
  () =>
    runBounded(
      process.execPath,
      [
        "-e",
        "process.stdout.write(String(process.pid)); setTimeout(()=>{}, 60000)",
      ],
      { nativeAdmission: true, timeoutMs: 90000, signal: controller.signal },
    ),
);
process.send({ event: "settled", result });
process.disconnect();
