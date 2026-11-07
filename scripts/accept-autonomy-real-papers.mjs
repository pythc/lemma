import { EvidenceStore } from "../server/evidence.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const main = new EvidenceStore(root + ".runtime"),
  old = new EvidenceStore(root + ".runtime/real-papers-20261017/store");
const report = root + "evidence/autonomy-20261018/final-real-runs.json";
let output = [];
try {
  output = JSON.parse(await readFile(report, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const bw = await main.getRun("740507fd-d2ee-471c-b24f-260661094dbc"),
  yang = await old.getRun("f365fefe-5b22-4fc8-94c2-884fb2b85c3a");
const cases = [
  { name: "bw", source: (await main.get(bw.uploadArtifact)).payload },
  { name: "yang-zhu", source: (await old.get(yang.sourceArtifact)).payload },
];
const status = await fetch("http://127.0.0.1:4179/api/status").then((r) =>
  r.json(),
);
if (status.capabilities.version !== "0.10.0")
  throw Error("Expected reviewed API version");
for (const c of cases) {
  let info = output.find((v) => v.name === c.name);
  if (!info) {
    const res = await fetch("http://127.0.0.1:4179/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orchestration: "adaptive",
        mode: "model",
        paperSha256: c.source.paperSha256,
        pdfBase64: c.source.pdfBase64,
      }),
    });
    const run = await res.json();
    if (!res.ok) throw Error(JSON.stringify(run));
    info = {
      name: c.name,
      id: run.id,
      sha256: run.paperSha256,
      createdAt: run.createdAt,
      initialLibraryProfile: run.libraryProfile,
      model: status.model.name,
    };
    output.push(info);
    await writeFile(report, JSON.stringify(output, null, 2));
    console.log(JSON.stringify(info));
  }
  let last = "";
  const deadline = Date.now() + 4 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const r = await main.getRun(info.id);
    const key = r.status + ":" + r.tasks.length;
    if (key !== last) {
      console.log(
        JSON.stringify({
          name: c.name,
          status: r.status,
          calls: r.modelCalls,
          tasks: r.tasks.length,
          active: r.tasks
            .filter((t) =>
              ["running", "queued", "recovering"].includes(t.status),
            )
            .map((t) => t.title),
        }),
      );
      last = key;
    }
    if (
      ["completed", "blocked", "awaiting_confirmation", "cancelled"].includes(
        r.status,
      )
    ) {
      info.status = r.status;
      info.root = r.root;
      info.finishedAt = new Date().toISOString();
      await writeFile(report, JSON.stringify(output, null, 2));
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!info.finishedAt)
    throw Error(
      "Review still active at acceptance deadline; not cancelled or automatically repeated.",
    );
}
