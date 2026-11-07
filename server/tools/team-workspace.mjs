import { evidenceView } from "../team/evidence-view.mjs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  mkdtemp,
  realpath,
  rm,
  readdir,
} from "node:fs/promises";
import { digest, sha256 } from "../evidence.mjs";
import { createContract, withExternalLibraries } from "../contracts.mjs";
import { moduleManifest, ensureDomainModules } from "../domain-library.mjs";
import { leanImports } from "../execution-environment.mjs";
import { MATHLIB_COMMIT } from "../../shared/library-profiles.mjs";
import {
  withCheckedEnvironment,
  runBounded,
  sandboxProfile,
} from "../lean.mjs";
import { LemmaProjects } from "../lemma-projects.mjs";

const validId = (v) => {
  if (!/^[a-f0-9-]{36}$/.test(v)) throw Error("Invalid workspace identity");
  return v;
};
const validFile = (v) => {
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)*\.lean$/.test(v))
    throw Error("Use relative Lean module filenames without traversal");
  return v;
};
const copy = (v) => JSON.parse(JSON.stringify(v));
export class TeamWorkspaceTools {
  constructor(store, checker) {
    Object.assign(this, { store, checker });
    this.locks = new Map();
    this.projects = new Map();
  }
  async locked(key, fn) {
    const before = this.locks.get(key) || Promise.resolve();
    const work = before.catch(() => {}).then(fn);
    this.locks.set(key, work);
    try {
      return await work;
    } finally {
      if (this.locks.get(key) === work) this.locks.delete(key);
    }
  }
  filename(runId, id) {
    return path.join(
      this.store.root,
      "team-projects",
      validId(runId),
      `${validId(id)}.json`,
    );
  }
  async save(run, state) {
    const file = this.filename(run.id, state.id);
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, file);
  }
  async load(run, id, artifact, getArtifact) {
    const state = artifact
      ? (await getArtifact(artifact)).payload.result
      : JSON.parse(await readFile(this.filename(run.id, id), "utf8"));
    if (
      state.schemaVersion !== "lemma.team.workspace.v1" ||
      state.id !== id ||
      state.runId !== run.id
    )
      throw Error("Workspace revision belongs to another project or review");
    return state;
  }
  async revision(state, ctx, previous = null, extra = []) {
    state.filesHash = digest(state.files);
    const { artifact: previousArtifact, ...snapshot } = state;
    state.artifact = await ctx.record(
      "workspace_revision",
      snapshot,
      [previous, ...extra].filter(Boolean),
    );
    await this.save(ctx.run, state);
    return {
      workspaceId: state.id,
      revision: state.revision,
      artifactId: state.artifact,
      files: Object.fromEntries(
        Object.entries(state.files).map(([n, c]) => [n, sha256(c)]),
      ),
      modules: state.modules,
    };
  }
  async run(name, a, ctx) {
    const { run, record, getArtifact, getTarget, signal } = ctx;
    if (
      [
        "plan_lemmas",
        "read_lemma_projects",
        "check_lemma",
        "assemble_lemmas",
      ].includes(name)
    )
      return this.lemma(name, a, ctx);
    if (name === "workspace_list") {
      const directory = path.join(
        this.store.root,
        "team-projects",
        validId(run.id),
      );
      const files = await readdir(directory).catch((e) => {
        if (e.code === "ENOENT") return [];
        throw e;
      });
      const projects = [];
      for (const file of files.filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))) {
        const state = await this.load(
          run,
          file.slice(0, -5),
          null,
          getArtifact,
        );
        projects.push({
          workspaceId: state.id,
          revision: state.revision,
          artifactId: state.artifact,
          files: Object.keys(state.files),
          read: {
            tool: "workspace_read",
            arguments: { workspaceId: state.id },
          },
        });
      }
      return {
        projects,
        guidance:
          "Choose persistent projects, helper decomposition or direct checks freely. No project is required.",
      };
    }
    if (name === "workspace_create") {
      let files = {},
        modules = a.modules || [],
        targetId = a.targetId || null;
      if (targetId) getTarget(targetId);
      if (a.fromArtifact) {
        const artifact = await getArtifact(a.fromArtifact),
          from = artifact.payload.result;
        if (
          artifact.kind === "team:lean_draft" &&
          artifact.payload.runId === run.id
        ) {
          files = { "Draft.lean": from.code };
          modules = [
            ...new Set([
              ...(from.modules || []).map((m) =>
                typeof m === "string" ? m : m.name,
              ),
              ...modules,
            ]),
          ];
        } else {
          if (
            from.schemaVersion !== "lemma.team.workspace.v1" ||
            from.runId !== run.id
          )
            throw Error(
              "Fork a workspace revision or diagnostic draft from this review",
            );
          files = copy(from.files);
          modules = [...new Set([...from.modules, ...modules])];
          targetId ||= from.targetId;
        }
      }
      const state = {
        schemaVersion: "lemma.team.workspace.v1",
        id: randomUUID(),
        runId: run.id,
        title: a.title,
        revision: 0,
        files,
        modules,
        targetId,
        parentArtifact: a.fromArtifact || null,
      };
      return this.revision(state, ctx, a.fromArtifact);
    }
    if (name === "workspace_read") {
      const state = await this.load(
        run,
        a.workspaceId,
        a.revisionArtifact,
        getArtifact,
      );
      if (a.file) {
        validFile(a.file);
        if (!(a.file in state.files)) throw Error("File not found");
        return {
          revision: state.revision,
          artifactId: state.artifact || a.revisionArtifact,
          file: a.file,
          content: state.files[a.file],
        };
      }
      return state;
    }
    if (["workspace_write", "workspace_merge"].includes(name))
      return this.locked(`${run.id}:${a.workspaceId}`, async () => {
        const state = await this.load(run, a.workspaceId, null, getArtifact);
        if (state.revision !== a.expectedRevision)
          throw Error(
            `Workspace changed; reread revision ${state.revision} before editing`,
          );
        const previous = state.artifact;
        let files = a.files || {};
        if (name === "workspace_merge") {
          const from = (await getArtifact(a.fromArtifact)).payload.result;
          if (
            from.schemaVersion !== "lemma.team.workspace.v1" ||
            from.runId !== run.id
          )
            throw Error("Merge a received workspace revision from this review");
          files = {};
          for (const [file, expected] of Object.entries(a.expectedFiles)) {
            validFile(file);
            if (
              (file in state.files ? sha256(state.files[file]) : null) !==
              expected
            )
              throw Error(
                `Merge conflict at ${file}; reread and reconcile explicitly`,
              );
            if (!(file in from.files))
              throw Error("Merge source file does not exist");
            files[file] = from.files[file];
          }
          state.modules = [...new Set([...state.modules, ...from.modules])];
        }
        for (const [file, content] of Object.entries(files)) {
          validFile(file);
          if (typeof content !== "string" || content.length > 1000000)
            throw Error("Invalid Lean source file");
          state.files[file] = content;
        }
        for (const file of a.deleteFiles || [])
          delete state.files[validFile(file)];
        state.modules = [...new Set([...state.modules, ...(a.modules || [])])];
        state.revision++;
        return this.revision(
          state,
          ctx,
          previous,
          [a.fromArtifact].filter(Boolean),
        );
      });
    const state = await this.load(
      run,
      a.workspaceId,
      a.revisionArtifact,
      getArtifact,
    );
    const revisionArtifact = a.revisionArtifact || state.artifact;
    if (name === "check_workspace_target") {
      const proof = state.files[validFile(a.file)];
      if (!proof?.trim()) throw Error("Proof term file not found");
      const target = getTarget(a.targetId);
      const result = await this.checker(target.contract, proof, {
        signal,
        mode: a.mode || "proof",
        dependencyAudit: true,
      });
      const artifactId = await record(
        "lean",
        {
          contract: target.contract,
          targetId: target.id,
          mode: a.mode || "proof",
          proof,
          result,
          workspaceArtifact: revisionArtifact,
          file: a.file,
        },
        [revisionArtifact, target.artifact],
      );
      return {
        result: evidenceView(result, artifactId, [
          "payload",
          "result",
          "result",
        ]),
        artifactId,
        targetId: target.id,
      };
    }
    if (name !== "workspace_check") throw Error("Unknown workspace operation");
    const selected = a.files || Object.keys(state.files);
    if (!selected.length)
      throw Error("Write a Lean module before building the workspace");
    for (const f of selected)
      if (!(validFile(f) in state.files)) throw Error("Build file not found");
    const imports = leanImports;
    const modules = [
      ...new Set([
        ...state.modules,
        ...Object.values(state.files)
          .flatMap(imports)
          .filter((n) => /^Mathlib(?:\.|$)/.test(n)),
      ]),
    ];
    const bound = state.targetId ? getTarget(state.targetId).contract : null;
    // A draft may import additional pinned modules without changing the formal
    // target. Never transplant default-version modules into an alternate Lean.
    const manifest = bound?.executionEnvironment
      ? []
      : await moduleManifest(
          [
            ...new Set([
              ...modules,
              ...(bound?.domainContext?.modules || []).map((m) => m.name),
            ]),
          ],
          { signal },
        );
    if (manifest.length) await ensureDomainModules(manifest, { signal });
    const environmentArtifact = await record("draft_environment", {
      modules: manifest,
      requestedModules: modules,
      executionEnvironment: bound?.executionEnvironment || null,
      workspaceArtifact: revisionArtifact,
    });
    let contract = bound?.executionEnvironment
      ? bound
      : createContract(
          {
            paperSha256: run.paperSha256,
            pageIndex: 0,
            text: "Diagnostic environment probe",
            artifact: run.sourceArtifact,
          },
          {
            label: "Workspace environment",
            quote: "Diagnostic environment probe",
            statement: "Diagnostic only",
            assumptions: [],
            leanTarget: "True",
          },
          bound?.libraryProfile || "std-v1",
          {
            contextArtifact: run.sourceArtifact,
            translationArtifact: environmentArtifact,
          },
          {
            context: {
              schemaVersion: "lemma.domain.v1",
              revision: MATHLIB_COMMIT,
              modules: manifest,
              definitions: [],
              lemmas: [],
            },
            artifact: environmentArtifact,
          },
        );
    if (bound?.externalLibraries)
      contract = withExternalLibraries(
        contract,
        bound.externalLibraries.map((e) => ({
          id: e.id,
          tree: { sha256: e.treeSha256 },
          modules: e.modules,
        })),
      );
    const order = [],
      done = new Set();
    const visit = (f, stack = new Set()) => {
      if (done.has(f)) return;
      if (stack.has(f)) throw Error("Cyclic local module imports");
      for (const m of imports(state.files[f])) {
        const local = `${m.replaceAll(".", "/")}.lean`;
        if (local in state.files) visit(local, new Set([...stack, f]));
      }
      done.add(f);
      order.push(f);
    };
    for (const f of selected) visit(f);
    const folder = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "lemma-project-check-")),
    );
    try {
      for (const [f, code] of Object.entries(state.files)) {
        await mkdir(path.dirname(path.join(folder, f)), { recursive: true });
        await writeFile(path.join(folder, f), code, { mode: 0o600 });
      }
      const checks = await withCheckedEnvironment(
        contract,
        async (env) => {
          if (!env.lean.ready || !env.library.ready)
            throw Error("Pinned workspace environment unavailable");
          const checks = [];
          for (const file of order) {
            signal?.throwIfAborted();
            const result = await runBounded(
              "/usr/bin/sandbox-exec",
              [
                "-p",
                sandboxProfile(folder, env.library.searchPaths, env.runtime),
                env.runtime.binary,
                "-M",
                "8192",
                "-o",
                file.replace(/\.lean$/, ".olean"),
                file,
              ],
              {
                cwd: folder,
                signal,
                timeoutMs: 1200000,
                maxOutput: 1000000,
                maxMemoryMiB: 8192,
                env: {
                  PATH: path.join(env.runtime.toolRoot, "bin"),
                  HOME: folder,
                  LEAN_PATH: [folder, ...env.library.searchPaths].join(
                    path.delimiter,
                  ),
                  LANG: "C.UTF-8",
                },
              },
            );
            checks.push({ file, ...result });
            if (result.exitCode !== 0) break;
          }
          return checks;
        },
        { signal },
      );
      const result = {
        workspaceArtifact: revisionArtifact,
        filesHash: state.filesHash,
        modules: manifest,
        checks,
        success:
          checks.length === order.length &&
          checks.every((c) => c.exitCode === 0),
        scope: "diagnostic_build_only_not_a_theorem_certificate",
      };
      return {
        ...result,
        artifactId: await record("workspace_check", result, [
          revisionArtifact,
          environmentArtifact,
        ]),
      };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
  async lemma(name, a, ctx) {
    const { run, signal, record, getTarget } = ctx;
    const directory = path.join(
      this.store.root,
      "team-lemmas",
      validId(run.id),
    );
    await mkdir(directory, { recursive: true });
    for (const file of await readdir(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const targetId = file.slice(0, -5),
        key = `${run.id}:${targetId}`;
      if (this.projects.has(key)) continue;
      const saved = JSON.parse(
        await readFile(path.join(directory, file), "utf8"),
      );
      const target = getTarget(targetId);
      if (saved.targetHash !== target.contract.targetHash)
        throw Error("Saved lemma project target mismatch");
      const manager = new LemmaProjects({
        contract: target.contract,
        checker: this.checker,
        persist: () => {
          throw Error("Caller persistence required");
        },
        limits: {
          maxHelperParts: Number.MAX_SAFE_INTEGER,
          maxDecompositionDepth: Number.MAX_SAFE_INTEGER,
        },
      });
      manager.projects = new Map(
        saved.projects.map(([id, p]) => [
          id,
          { ...p, solved: new Map(p.solved) },
        ]),
      );
      manager.checks = new Map(saved.checks);
      this.projects.set(key, { runId: run.id, targetId, manager });
    }
    if (name === "read_lemma_projects")
      return [...this.projects.values()]
        .filter((v) => v.runId === run.id)
        .flatMap((v) =>
          v.manager.status().map((p) => ({ ...p, targetId: v.targetId })),
        );
    let holder;
    if (name === "plan_lemmas") {
      const target = getTarget(a.targetId),
        key = `${run.id}:${target.id}`;
      holder = this.projects.get(key);
      if (!holder) {
        holder = {
          runId: run.id,
          targetId: target.id,
          manager: new LemmaProjects({
            contract: target.contract,
            checker: this.checker,
            persist: () => {
              throw Error("Caller persistence required");
            },
            limits: {
              maxHelperParts: Number.MAX_SAFE_INTEGER,
              maxDecompositionDepth: Number.MAX_SAFE_INTEGER,
            },
          }),
        };
        this.projects.set(key, holder);
      }
    } else
      holder = [...this.projects.values()].find(
        (v) => v.runId === run.id && v.manager.projects.has(a.projectId),
      );
    if (!holder) throw Error("Unknown lemma project in this review");
    const target = getTarget(holder.targetId);
    if (target.supersededBy)
      throw Error("Root target superseded; create a plan for the new target");
    // Per-call execution context: parallel agents share saved plans, not signals or identities.
    const manager = Object.assign(
      Object.create(Object.getPrototypeOf(holder.manager)),
      holder.manager,
      {
        signal,
        persist: (kind, payload, inputs = []) =>
          record(kind.replace("proof:", "workspace_"), payload, inputs),
      },
    );
    const result =
      name === "plan_lemmas"
        ? await manager.plan(
            { parts: a.parts, assembly: a.assembly },
            a.parent || null,
          )
        : name === "check_lemma"
          ? await manager.check(a.projectId, a.name, a.proof)
          : await manager.assemble(a.projectId, a.assembly || null);
    await this.locked(`lemmas:${run.id}:${holder.targetId}`, async () => {
      const file = path.join(directory, `${validId(holder.targetId)}.json`),
        temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(
        temp,
        JSON.stringify({
          targetHash: target.contract.targetHash,
          projects: [...manager.projects].map(([id, p]) => [
            id,
            { ...p, solved: [...p.solved] },
          ]),
          checks: [...manager.checks],
        }),
        { mode: 0o600 },
      );
      await rename(temp, file);
    });
    if (name !== "assemble_lemmas") return result;
    if (
      result.accepted &&
      result.contract.targetHash === target.contract.targetHash
    ) {
      result.proofArtifact = await record(
        "lean",
        {
          targetId: target.id,
          contract: target.contract,
          proof: result.proof,
          mode: "proof",
          result: result.check,
          lemmaProjectId: a.projectId,
        },
        [target.artifact, result.artifact],
      );
    }
    return result;
  }
}
