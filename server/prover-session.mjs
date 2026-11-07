import { nativeSpan } from "./native-timing.mjs";
import { PROOF_RUNTIME, LEAN_RUNTIME } from "./runtime-limits.mjs";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { digest, sha256 } from "./evidence.mjs";
import {
  validateContract,
  validateLeanText,
  MAX_PROOF_CHARACTERS,
} from "./contracts.mjs";
import { domainPrelude } from "./domain-schema.mjs";
import {
  libraryEnvironment,
  analysisLibraryStatus,
  LIBRARY_ROOTS,
  MATHLIB_ROOT,
} from "./libraries.mjs";
import { leanStatus, sandboxProfile, binary } from "./lean.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const tools = path.join(root, ".tools");
const proving = path.join(tools, "proving");
const python = path.join(tools, "proving-venv/bin/python");
const repl = path.join(proving, "repl/.lake/build/bin/repl");
const copilot = path.join(proving, "LeanCopilot/.lake/build/lib");
const batteries = path.join(proving, "batteries/.lake/build/lib/lean");

export async function proverCapabilities({ includeManifest = false } = {}) {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(proving, "manifest.json"), "utf8"),
    );
    for (const item of manifest.files) {
      const absolute = path.resolve(root, item.path);
      if (!absolute.startsWith(tools + path.sep))
        throw Error("Invalid tool path");
      if (sha256(await readFile(absolute)) !== item.sha256)
        throw Error(`Prover artifact changed: ${item.path}`);
    }
    await access(python);
    const runner = {
      adapterSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
      workerSha256: sha256(
        await readFile(path.join(root, "worker/proving.py")),
      ),
      pythonLockSha256: sha256(
        await readFile(path.join(root, "worker/proving-requirements.lock")),
      ),
    };
    return {
      ready: true,
      schemaVersion: "lemma.prover-capabilities.v1",
      environmentHash: digest({ manifest, runner }),
      runner,
      ...(includeManifest ? { manifest } : {}),
      lean: manifest.lean,
      leanInteract: manifest.leanInteract,
      copilot: manifest.copilotTag,
      artifactCount: manifest.files.length,
      operations: [
        "createSession",
        "inspectGoal",
        "queryPremises",
        "applyTactic",
        "runSearch",
        "checkpoint",
        "resume",
        "cancel",
        "exportCandidate",
      ],
      trust: "candidate_only_independent_kernel_required",
    };
  } catch (e) {
    return {
      ready: false,
      reason: e.message,
      trust: "candidate_only_independent_kernel_required",
    };
  }
}

export class ProverSession {
  constructor({
    signal,
    perStepMs = PROOF_RUNTIME.perStepMs,
    memoryLimitMB = 8192,
  } = {}) {
    if (
      !Number.isInteger(memoryLimitMB) ||
      memoryLimitMB < 1 ||
      memoryLimitMB > 16384
    )
      throw Error("Invalid prover memory limit");
    this.signal = signal;
    this.perStepMs = perStepMs;
    this.memoryLimitMB = memoryLimitMB;
    this.pending = new Map();
    this.events = [];
    this.closed = false;
  }
  async create(contract, { mode = "proof" } = {}) {
    validateContract(contract);
    if (contract.executionEnvironment)
      throw Error(
        "Interactive proof search is not sealed for this execution environment; use its native check_lean tool instead.",
      );
    if (!["proof", "counterexample"].includes(mode))
      throw Error("Invalid proof direction");
    const { capabilities, lean, library, searchLibrary } = await nativeSpan(
      "prover.prepare",
      async () => ({
        capabilities: await proverCapabilities(),
        lean: await leanStatus({ verifyLibraries: true }),
        library: await libraryEnvironment(
          contract.libraryProfile,
          contract.domainContext,
          contract.externalLibraries,
        ),
        searchLibrary: await analysisLibraryStatus({ verify: true }),
      }),
      { targetHash: contract.targetHash },
    );
    if (
      !capabilities.ready ||
      !lean.ready ||
      !library.ready ||
      !searchLibrary.ready
    )
      throw Error(
        capabilities.reason ||
          lean.reason ||
          library.reason ||
          searchLibrary.reason ||
          "Proving environment unavailable",
      );
    this.contract = contract;
    this.mode = mode;
    this.environmentHash = digest({
      search: capabilities.environmentHash,
      library,
      searchLibrary,
      mode,
      imports: contract.imports,
    });
    this.directory = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "lemma-prover-")),
    );
    this.suggestionFile = path.join(this.directory, "suggestions.json");
    await writeFile(this.suggestionFile, "[]", { mode: 0o600 });
    const searchPaths = [
      ...new Set([
        ...library.searchPaths,
        ...LIBRARY_ROOTS.map((p) => path.resolve(MATHLIB_ROOT, p)),
      ]),
    ];
    const readPaths = [repl, copilot, batteries, ...searchPaths];
    const sandbox =
      sandboxProfile(this.directory, readPaths) +
      `\n(allow process-exec (literal ${JSON.stringify(repl)}))`;
    this.process = spawn(python, [path.join(root, "worker/proving.py")], {
      cwd: this.directory,
      detached: true,
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        PYTHONUNBUFFERED: "1",
        LEMMA_PROVER_REQUEST_BYTES: String(LEAN_RUNTIME.proverRequestBytes),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      stderr = "";
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (s) => {
      stderr = (stderr + s).slice(-4000);
    });
    this.process.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > LEAN_RUNTIME.proverResponseBytes) {
        this.terminate(Error("Prover output budget exhausted"));
        return;
      }
      let end;
      while ((end = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, end);
        output = output.slice(end + 1);
        try {
          const message = JSON.parse(line),
            pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          message.error
            ? pending.reject(Error(`${message.errorType}: ${message.error}`))
            : pending.resolve(message.result);
        } catch {
          this.terminate(Error("Malformed proving worker response"));
        }
      }
    });
    this.process.on("error", (e) => this.terminate(e));
    this.process.on("exit", (code) =>
      this.terminate(Error(`Proving worker exited (${code}): ${stderr}`)),
    );
    this.abort = () =>
      this.terminate(this.signal?.reason || Error("Cancelled"));
    this.signal?.addEventListener("abort", this.abort, { once: true });
    if (this.signal?.aborted) this.abort();
    const target =
      mode === "counterexample"
        ? `¬ (${contract.leanTarget})`
        : contract.leanTarget;
    // This declaration with a hole exists only in the disposable search process.
    // It is never exported as a proved premise or passed to the final checker.
    const source = `${contract.imports.map((n) => `import ${n}`).join("\n")}\nimport LeanCopilot
set_option autoImplicit false
set_option maxHeartbeats ${LEAN_RUNTIME.maxHeartbeats}
set_option maxRecDepth ${LEAN_RUNTIME.maxRecDepth}
${domainPrelude(contract.domainContext)}
#eval LeanCopilot.registerGenerator "lemma" (.generic ⟨fun _ _ => do
  let raw ← IO.FS.readFile ${JSON.stringify(this.suggestionFile)}
  let parsed := (Lean.Json.parse raw).toOption.bind (fun j => (Lean.fromJson? j : Except String (Array String)).toOption)
  pure ((parsed.getD #[]).map (fun s => (s, 0.8)))⟩)
set_option LeanCopilot.suggest_tactics.model "lemma"
#configure_llm_aesop
theorem lemma_search_target : (${target}) := by sorry
`;
    const response = await nativeSpan(
      "prover.bootstrap",
      () =>
        this.request(
          "createSession",
          {
            source,
            replRoot: path.join(proving, "repl"),
            replBinary: repl,
            directory: this.directory,
            sandbox,
            memoryLimitMB: this.memoryLimitMB,
            environment: {
              PATH: path.dirname(binary),
              LANG: "C.UTF-8",
              TMPDIR: this.directory,
              LEAN_PATH: [
                batteries,
                path.join(copilot, "lean"),
                ...searchPaths,
              ].join(path.delimiter),
              DYLD_LIBRARY_PATH: copilot,
            },
          },
          Math.max(this.perStepMs, LEAN_RUNTIME.analysisTimeoutMs),
        ),
      {
        targetHash: contract.targetHash,
        environmentHash: this.environmentHash,
      },
    );
    if (response.status !== "ready")
      throw Object.assign(Error("Proving session initialization failed"), {
        detail: response,
      });
    this.initialState = response.state;
    this.state = response;
    return response;
  }
  request(operation, data = {}, timeoutMs = this.perStepMs) {
    if (this.closed || !this.process)
      return Promise.reject(Error("Proving session closed"));
    const id = randomUUID(),
      started = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.terminate(Error("Prover step deadline exceeded")),
        timeoutMs + 1000,
      );
      this.pending.set(id, {
        timer,
        reject,
        resolve: (result) => {
          this.events.push({
            id,
            operation,
            targetHash: this.contract.targetHash,
            environmentHash: this.environmentHash,
            elapsedMs: Date.now() - started,
            ...data,
            result,
          });
          resolve(result);
        },
      });
      this.process.stdin.write(
        JSON.stringify({
          id,
          operation,
          ...data,
          timeoutSeconds: timeoutMs / 1000,
        }) + "\n",
        (e) => {
          if (e) this.terminate(e);
        },
      );
    });
  }
  async inspectGoal() {
    return this.request("inspectGoal", { state: this.state.state });
  }
  async queryPremises(queries) {
    return this.request("queryPremises", { queries });
  }
  async applyTactic(tactic, { state = this.state.state } = {}) {
    validateLeanText(`by\n${tactic}`, "策略", LEAN_RUNTIME.proofCharacters);
    if (
      /\blemma_search_target\b|\bsearch_proof\b|\bsuggest_tactics\b|\bselect_premises\b/.test(
        tactic,
      )
    )
      throw Error("Search-only declaration cannot be used as a proof");
    const result = await this.request("applyTactic", { state, tactic });
    if (result.status !== "rejected") this.state = result;
    return result;
  }
  async runSearch(suggestions = []) {
    if (!Array.isArray(suggestions) || suggestions.length > 16)
      throw Error("Invalid tactic budget");
    for (const t of suggestions) {
      validateLeanText(`by\n${t}`, "策略", LEAN_RUNTIME.proofCharacters);
      if (
        /\blemma_search_target\b|\bsearch_proof\b|\bsuggest_tactics\b|\bselect_premises\b/.test(
          t,
        )
      )
        throw Error("Search-only declaration cannot be used as a proof");
    }
    const result = await this.request("runSearch", {
      state: this.state.state,
      suggestionFile: this.suggestionFile,
      suggestions,
    });
    if (result.status !== "rejected") this.state = result;
    return result;
  }
  async rollback(state) {
    this.state = await this.request("rollback", { state });
    return this.state;
  }
  checkpoint() {
    const payload = {
      schemaVersion: "lemma.prover-checkpoint.v1",
      targetHash: this.contract.targetHash,
      environmentHash: this.environmentHash,
      mode: this.mode,
      journal: this.state.journal,
      goals: this.state.goals,
      completed: this.state.completed,
    };
    return { ...payload, checkpointHash: digest(payload) };
  }
  async resume(checkpoint) {
    const { checkpointHash, ...payload } = checkpoint;
    if (
      digest(payload) !== checkpointHash ||
      payload.targetHash !== this.contract.targetHash ||
      payload.environmentHash !== this.environmentHash ||
      payload.mode !== this.mode
    )
      throw Error("Checkpoint identity mismatch");
    if (this.state.journal.length) throw Error("Resume requires a new session");
    for (const tactic of payload.journal) {
      const r = await this.applyTactic(tactic);
      if (r.status === "rejected") throw Error("Checkpoint replay rejected");
    }
    if (
      digest(this.state.goals) !== digest(payload.goals) ||
      this.state.completed !== payload.completed
    )
      throw Error("Checkpoint replay diverged");
    return this.state;
  }
  exportCandidate() {
    if (!this.state?.completed || this.state.exportable === false)
      throw Error("No exportable complete candidate");
    const proof =
      "by\n" +
      this.state.journal
        .map((t) =>
          t
            .split("\n")
            .map((l) => "  " + l)
            .join("\n"),
        )
        .join("\n");
    validateLeanText(proof, "证明", MAX_PROOF_CHARACTERS);
    return {
      proof,
      mode: this.mode,
      route: "independent",
      targetHash: this.contract.targetHash,
      environmentHash: this.environmentHash,
      origin: "LeanInteract/LeanCopilot",
      status: "candidate_only",
    };
  }
  terminate(error = Error("Session closed")) {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.abort);
    if (this.process?.pid)
      try {
        process.kill(-this.process.pid, "SIGKILL");
      } catch {}
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  async close() {
    this.terminate();
    if (this.directory)
      await rm(this.directory, { recursive: true, force: true });
  }
}
