import { LEAN_RUNTIME, PROOF_RUNTIME } from "./runtime-limits.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { ResourcePool } from "./resource-pool.mjs";
import { sha256, digest } from "./evidence.mjs";
import {
  validateLeanText,
  validateContract,
  MAX_PROOF_CHARACTERS,
} from "./contracts.mjs";
import { domainPrelude } from "./domain-schema.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const modelPath = path.join(root, ".tools/models/Goedel-Prover-V2-8B");
export const SPECIALIST = {
  name: "Goedel-LM/Goedel-Prover-V2-8B",
  revision: "dfd02e6271a58375dfbf3ece0175277cf6b6a89a",
  backend: "mlx",
  precision: "bfloat16",
};
const pool = new ResourcePool(1);

export async function specialistStatus() {
  try {
    const m = JSON.parse(
      await readFile(path.join(modelPath, "lemma-manifest.json"), "utf8"),
    );
    if (m.revision !== SPECIALIST.revision)
      throw Error("Specialist model revision mismatch");
    for (const f of m.files) {
      const s = await stat(path.join(modelPath, f.name));
      if (s.size !== f.size || s.mtimeMs !== f.mtimeMs)
        throw Error("Specialist model files changed; run setup verification");
    }
    return { ready: true, ...SPECIALIST, manifestHash: digest(m) };
  } catch (e) {
    return { ready: false, ...SPECIALIST, reason: e.message };
  }
}

export function extractSpecialistProof(content, target) {
  // Accept only the unchanged single theorem. Ignore prose and never execute a
  // complete model-produced file (which could add assumptions or commands).
  const blocks = [
    ...content.matchAll(/```(?:lean4?|Lean4?)?\s*\n([\s\S]*?)```/g),
  ].map((m) => m[1]);
  for (const block of blocks.reverse()) {
    const marker = "theorem lemma_candidate : (" + target + ") :=";
    const pos = block.indexOf(marker);
    if (pos < 0) continue;
    if (block.indexOf("theorem lemma_candidate", pos + marker.length) >= 0)
      throw Error("Duplicate target declaration");
    const proof = block.slice(pos + marker.length).trim();
    validateLeanText(proof, "专用证明模型候选", MAX_PROOF_CHARACTERS);
    if (!proof.startsWith("by"))
      throw Error("Specialist must return a tactic proof");
    return proof;
  }
  throw Error(
    "Specialist did not return an unchanged target and a complete fenced Lean proof",
  );
}

export async function generateSpecialist(
  contract,
  {
    mode = "proof",
    previous = null,
    premises = [],
    signal,
    maxTokens = LEAN_RUNTIME.specialistOutputTokens,
    timeoutMs = PROOF_RUNTIME.perSpecialistMs,
    seed = 0,
    onProgress,
  } = {},
) {
  validateContract(contract);
  if (!["proof", "counterexample"].includes(mode))
    throw Error("Invalid specialist proof direction");
  if (
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > LEAN_RUNTIME.specialistOutputTokens
  )
    throw Error("Invalid specialist token budget");
  const identity = await specialistStatus();
  if (!identity.ready) throw Error(identity.reason);
  return pool.run(
    async () => {
      const target =
        mode === "proof" ? contract.leanTarget : `¬ (${contract.leanTarget})`;
      const stub = `${contract.imports.map((n) => `import ${n}`).join("\n")}\n${domainPrelude(contract.domainContext)}\ntheorem lemma_candidate : (${target}) := by\n  sorry`;
      const prompt = `Complete the following Lean 4 code:\n\n\`\`\`lean4\n${stub}\n\`\`\`\nBefore producing the Lean 4 code, provide a proof plan outlining the main steps and strategies. You may freely use existing theorems and tactics from the listed imports. Replace only the sorry with a proof; copy the theorem declaration exactly. The current Lean version is 4.35.0.\n${premises.length ? `Available premise signatures:\n${JSON.stringify(premises).slice(0, 16000)}` : ""}\n${previous ? `Previous candidate and actual compiler diagnostic:\n${JSON.stringify(previous).slice(0, 16000)}` : ""}`;
      const start = Date.now(),
        record = {
          ...identity,
          targetHash: contract.targetHash,
          mode,
          seed,
          maxTokens,
          promptSha256: sha256(prompt),
          prompt,
          startedAt: new Date(start).toISOString(),
        };
      const result = await new Promise((resolve, reject) => {
        const proc = spawn(
          path.join(root, ".tools/proving-venv/bin/python"),
          [path.join(root, "worker/specialist.py")],
          {
            cwd: root,
            detached: true,
            env: {
              PATH: "/usr/bin:/bin",
              LANG: "C.UTF-8",
              HF_HUB_OFFLINE: "1",
              TRANSFORMERS_OFFLINE: "1",
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let buffer = "",
          content = "",
          stderr = "",
          done = null,
          settled = false,
          bytes = 0,
          lastProgress = 0;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (proc.pid)
            try {
              process.kill(-proc.pid, "SIGKILL");
            } catch {}
          error
            ? reject(
                Object.assign(error, {
                  specialistRecord: {
                    ...record,
                    elapsedMs: Date.now() - start,
                    partialContent: content,
                  },
                }),
              )
            : resolve({ content, done });
        };
        const abort = () => finish(Error("Specialist generation cancelled"));
        const timer = setTimeout(
          () => finish(Error("Specialist generation deadline exceeded")),
          timeoutMs,
        );
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        proc.on("error", finish);
        proc.stderr.on("data", (s) => {
          stderr = (stderr + s).slice(-3000);
        });
        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", (s) => {
          bytes += Buffer.byteLength(s);
          if (bytes > 4 * 1024 * 1024)
            return finish(Error("Specialist output limit exceeded"));
          buffer += s;
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            try {
              const event = JSON.parse(line);
              if (event.type === "budget") record.contextBudget = event;
              if (event.type === "token") content += event.text;
              if (event.type === "done") done = event;
            } catch {
              return finish(Error("Invalid specialist transport"));
            }
          }
          if (Date.now() - lastProgress > 5000) {
            lastProgress = Date.now();
            onProgress?.({
              elapsedMs: Date.now() - start,
              outputCharacters: content.length,
            });
          }
        });
        proc.on("exit", (code) => {
          if (code !== 0 || !done)
            finish(Error(`Specialist exited (${code}): ${stderr}`));
          else finish();
        });
        proc.stdin.end(
          JSON.stringify({
            modelPath,
            prompt,
            maxTokens,
            seed,
            temperature: 0.6,
          }) + "\n",
        );
      });
      record.elapsedMs = Date.now() - start;
      record.content = result.content;
      record.usage = result.done;
      if (result.done.finishReason === "length")
        throw Object.assign(Error("Specialist response truncated"), {
          specialistRecord: record,
        });
      try {
        return {
          proof: extractSpecialistProof(result.content, target),
          mode,
          route: "independent",
          origin: SPECIALIST.name,
          record,
        };
      } catch (e) {
        e.specialistRecord = record;
        throw e;
      }
    },
    { signal },
  );
}
