// Explicit delivery-only continuation. Never initialize/recover any agent store.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createApp } from "../server/index.mjs";
import { finalizeTeamPaper } from "../server/team/finalization.mjs";
const out = path.resolve(process.argv[2] || "");
if (!process.argv[2])
  throw Error("Usage: finalize-team-paper output-directory");
const started = JSON.parse(
  await readFile(path.join(out, "started.json"), "utf8"),
);
const app = await createApp({
  dataRoot: path.join(out, "store"),
  readOnly: true,
});
try {
  console.log(
    await finalizeTeamPaper({
      team: app.team,
      store: app.store,
      runId: started.runId,
      out,
    }),
  );
} finally {
  await app.team.close();
}
