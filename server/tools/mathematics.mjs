import { sourceParagraphs } from "../team/source-spans.mjs";
import { WarmLeanPool } from "../lean-warm.mjs";
import { nativeSpan } from "../native-timing.mjs";
import {
  draftModules,
  inspectExecutionEnvironment,
} from "../execution-environment.mjs";
import { digest } from "../evidence.mjs";
import {
  preparePythonEnvironment,
  numericInventory,
} from "../python-environments.mjs";
import { selectEvidence, evidenceView } from "../team/evidence-view.mjs";
import { reuseAcceptedProof } from "./accepted-proof.mjs";
import {
  locateSource,
  selectSource,
  targetSourceArguments,
  sourceSpan,
  resolveSourceSpans,
} from "../team/source-spans.mjs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import {
  createContract,
  validateProposal,
  withExternalLibraries,
  withExecutionEnvironment,
} from "../contracts.mjs";
import {
  checkProof,
  checkEnvironment,
  withCheckedEnvironment,
  runBounded,
  sandboxProfile,
} from "../lean.mjs";
import { inspectTarget } from "../lean-query.mjs";
import {
  moduleManifest,
  ensureDomainModules,
  searchMathlib,
} from "../domain-library.mjs";
import { readPinnedMathlibSource } from "../library-source.mjs";
import {
  discoverLibraries,
  inspectLibrary,
  installLibrary,
  libraryVersions,
  readExternalLibrarySource,
} from "../external-libraries.mjs";
import { environmentCatalog } from "../lean-environments.mjs";
import {
  MATHLIB_COMMIT,
  LIBRARY_PROFILES,
  libraryProfile,
} from "../../shared/library-profiles.mjs";
import { extractPageGeometry } from "../pdf.mjs";
import { runNumericExperiment } from "../numeric-execution.mjs";
import { retrieveReference } from "../reference-reader.mjs";

import { TEAM_TOOLS } from "../team/tool-catalog.mjs";
import { TeamWorkspaceTools } from "./team-workspace.mjs";
import { searchPremises } from "../premise-index.mjs";
export class MathematicalTools {
  constructor({ store, checker = checkProof, inspector = inspectTarget }) {
    this.store = store;
    this.warm = new WarmLeanPool();
    this.checker = checker;
    this.inspector = inspector;
    this.workspaces = new TeamWorkspaceTools(store, checker);
  }
  async pauseRun(id) {
    await this.warm.closeOwner(id);
  }
  async close() {
    await this.warm.close();
  }
  async run(
    name,
    a,
    { run, actor, source, signal, record, getArtifact, getTarget, addTarget },
  ) {
    if (
      name.startsWith("workspace_") ||
      [
        "check_workspace_target",
        "plan_lemmas",
        "read_lemma_projects",
        "check_lemma",
        "assemble_lemmas",
      ].includes(name)
    )
      return this.workspaces.run(name, a, {
        run,
        actor,
        source,
        signal,
        record,
        getArtifact,
        getTarget,
      });
    if (name === "discover_tools")
      return {
        tools: TEAM_TOOLS,
        examples: {
          source: {
            locator: {
              kind: "selection",
              ref: "copy refs.selectionId returned by select_source",
            },
            coverage: [
              {
                selectionId:
                  "copy refs.selectionId for full premises and conclusion",
              },
            ],
          },
          proposal: {
            label: "source lemma label",
            quote: "unique exact short source locator",
            statement: "full meaning",
            assumptions: [],
            leanTarget: "a closed Lean proposition",
            ambiguity: "",
          },
          sourceSpans: [
            {
              pageIndex: 0,
              quote: "complete premises and conclusion copied from source",
            },
          ],
          definitions: [
            {
              name: "MyObject",
              type: "Type",
              value: "Nat",
              meaning: "source-grounded definition",
              anchors: [{ pageIndex: 0, quote: "source quote" }],
              dependsOn: [],
            },
          ],
          lemmas: [
            {
              name: "Helper",
              target: "closed proposition",
              proof: "by ...",
              purpose: "reason",
              dependsOn: [],
            },
          ],
          note: "No target is required for search, source inspection, module preparation or experiments. Definitions and helper proofs are checked again in the final assembled theorem. Use nested let/have inside a proof freely; no fixed decomposition depth.",
        },
      };
    const selection = async (span) => {
      const artifactId = await record("source_selection", {
        ...span,
        paperSha256: run.paperSha256,
      });
      return {
        ...span,
        selectionId: artifactId,
        use: { selectionId: artifactId },
      };
    };
    if (name === "locate_source") {
      const result = locateSource(source, a);
      return {
        ...result,
        selections: await Promise.all(result.selections.map(selection)),
      };
    }
    if (name === "read_source_span")
      return selection(sourceSpan(source, a.pageIndex, a.start, a.end));
    if (name === "inspect_execution_environment")
      return {
        lean: await inspectExecutionEnvironment(a.imports || []),
        python: await numericInventory(a.environmentId),
      };
    if (name === "prepare_python_environment") {
      const result = await preparePythonEnvironment(a.packages, { signal });
      return {
        ...result,
        artifactId: await record("python_environment", result),
      };
    }
    const resolveSelection = async (s) => {
      if (!s?.selectionId) return s;
      const e = await getArtifact(s.selectionId);
      if (
        e.kind !== "team:source_selection" ||
        e.payload.result.paperSha256 !== run.paperSha256
      )
        throw Error(
          "selectionId must reference this paper's original source selection",
        );
      return e.payload.result;
    };
    if (name === "select_source") {
      const within = a.selectionId
        ? await resolveSelection({ selectionId: a.selectionId })
        : null;
      return selection(selectSource(source, a, within));
    }
    if (name === "read_source")
      return {
        paperSha256: run.paperSha256,
        pageCount: source.pageCount,
        extraction: source.extraction,
        pages: source.pages
          .filter((p) => !a.pages || a.pages.includes(p.index))
          .map((p) => ({ ...p, paragraphs: sourceParagraphs(p) })),
      };
    if (name === "view_page") {
      const r = await extractPageGeometry(source.pdfBase64, a.pageIndex);
      const artifactId = await record("page", r);
      return { ...r, artifactId };
    }
    if (name === "reuse_verified_check")
      return reuseAcceptedProof(
        a,
        { run, actor, getArtifact, getTarget, record },
        checkEnvironment,
      );
    if (name === "read_evidence")
      return selectEvidence(await getArtifact(a.artifactId), a);
    if (name === "publish_artifact")
      return {
        artifactId: await record("draft", {
          title: a.title,
          content: a.content,
        }),
      };
    if (name === "publish_route") {
      getTarget(a.rootTargetId);
      if (!Array.isArray(a.steps) || !a.steps.length)
        throw Error("Source steps required");
      const seen = new Set();
      for (const step of a.steps) {
        step.sourceSpans = resolveSourceSpans(
          source,
          await Promise.all((step.sourceSpans || []).map(resolveSelection)),
        );
        getTarget(step.targetId);
        if (
          typeof step.id !== "string" ||
          seen.has(step.id) ||
          !Array.isArray(step.dependsOn) ||
          step.dependsOn.some((d) => !seen.has(d))
        )
          throw Error(
            "Route steps must have unique IDs and acyclic prior dependencies",
          );
        if (
          !Array.isArray(step.sourceSpans) ||
          !step.sourceSpans.length ||
          step.sourceSpans.some(
            (s) =>
              !s.quote?.trim() ||
              !source.pages[s.pageIndex]?.text.includes(s.quote),
          )
        )
          throw Error("Every route step needs exact source anchors");
        seen.add(step.id);
      }
      return {
        artifactId: await record(
          "route",
          {
            ...a,
            scope: "source_correspondence_proposal_not_a_route_certificate",
          },
          [
            getTarget(a.rootTargetId).artifact,
            ...a.steps.map((s) => getTarget(s.targetId).artifact),
          ],
        ),
      };
    }
    if (name === "list_libraries")
      return {
        profiles: LIBRARY_PROFILES,
        environments: await environmentCatalog(),
      };
    if (name === "search_mathlib") {
      const result = await searchMathlib(a.queries, {
        signal,
        offset: a.offset,
        limit: a.limit,
      });
      return { result, artifactId: await record("search", result) };
    }
    if (name === "search_premises") {
      const result = await searchPremises(a.queries, {
        signal,
        offset: a.offset,
        limit: a.limit,
        module: a.module,
        target: a.targetId
          ? getTarget(a.targetId).contract.leanTarget
          : a.goal || "",
      });
      return { result, artifactId: await record("premise_search", result) };
    }
    if (name === "read_library") {
      const result = a.libraryReceipt
        ? await readExternalLibrarySource(
            (await getArtifact(a.libraryReceipt)).payload.result,
            a.module,
            { signal },
          )
        : await readPinnedMathlibSource(a.module, {
            signal,
            startLine: a.startLine,
            lineCount: a.lineCount,
          });
      return { result, artifactId: await record("library_source", result) };
    }
    if (name === "find_libraries") {
      const result = await discoverLibraries(a.query, { signal });
      return { result, artifactId: await record("library_discovery", result) };
    }
    if (name === "inspect_library") {
      const result = await inspectLibrary(a.repo, {
        signal,
        revision: a.revision,
      });
      return { result, artifactId: await record("library_inspection", result) };
    }
    if (name === "library_versions")
      return libraryVersions(a.repo, { signal, match: a.match });
    if (name === "install_library") {
      const r = await getArtifact(a.receiptId);
      if (r.kind !== "team:library_inspection")
        throw Error("Use an inspected library receipt");
      const result = await installLibrary(r.payload.result, a.modules, {
        signal,
      });
      return { result, artifactId: await record("library_install", result) };
    }
    if (name === "prepare_modules") {
      const manifest = await moduleManifest(a.modules, { signal }),
        result = await ensureDomainModules(manifest, { signal });
      return {
        manifest,
        result,
        artifactId: await record("modules", { manifest, result }),
      };
    }
    if (name === "propose_target") {
      try {
        libraryProfile(a.profile || "std-v1");
      } catch (e) {
        e.code = "profile_unsupported";
        e.dispatchState = "not_dispatched";
        throw e;
      }
      a = await targetSourceArguments(source, a, resolveSelection);
      const page = source.pages.find((p) => p.index === a.pageIndex);
      validateProposal(a.proposal, { text: page.text });
      if (a.replaces) getTarget(a.replaces);
      const modules = await moduleManifest(a.modules || [], { signal });

      const context = {
        schemaVersion: "lemma.domain.v1",
        revision: MATHLIB_COMMIT,
        modules,
        definitions: a.definitions || [],
        lemmas: a.lemmas || [],
      };
      const domainArtifact = await record("domain", context);
      const translationArtifact = await record("translation", {
        proposal: a.proposal,
        sourceSpans: a.sourceSpans,
      });
      let contract = createContract(
        {
          paperSha256: run.paperSha256,
          pageIndex: a.pageIndex,
          text: page.text,
          artifact: run.sourceArtifact,
        },
        a.proposal,
        a.profile || "std-v1",
        { contextArtifact: run.sourceArtifact, translationArtifact },
        context.modules.length ||
          context.definitions.length ||
          context.lemmas.length
          ? { context, artifact: domainArtifact }
          : null,
      );
      for (const id of a.externalReceiptIds || []) {
        const r = await getArtifact(id);
        if (r.kind !== "team:library_install")
          throw Error("Use installed library receipt");
        contract = withExternalLibraries(contract, [r.payload.result]);
      }
      if (a.environment && a.environment !== "lean-4.35.0") {
        const e = (await environmentCatalog()).find(
          (e) => e.ready && e.descriptor.id === a.environment,
        );
        if (!e) throw Error("Environment unavailable");
        contract = withExecutionEnvironment(contract, e.descriptor);
      }
      if (modules.length) await ensureDomainModules(modules, { signal });
      const target = {
        id: randomUUID(),
        taskId: actor.id,
        taskVersion: actor.version,
        kind: a.kind,
        label: contract.label,
        contract,
        sourceSpans: a.sourceSpans,
        replaces: a.replaces || null,
        objectiveId: a.objectiveId || null,
      };
      target.artifact = await record("target", target, [domainArtifact]);
      await addTarget(target);
      return target;
    }
    if (name === "inspect_target") {
      const t = getTarget(a.targetId),
        result = await this.inspector(t.contract, {
          names: a.names || [],
          definitions: a.definitions || [],
          signal,
        });
      return {
        result,
        artifactId: await record(
          "typing",
          { targetId: t.id, contract: t.contract, result },
          [t.artifact],
        ),
      };
    }
    if (["lean_draft", "lean_explore"].includes(name)) {
      if (
        typeof a.code !== "string" ||
        !a.code.trim() ||
        a.code.length > 1000000
      )
        throw Error("Draft code missing or exceeds source byte envelope");
      const modules = await moduleManifest(
        draftModules(a.code, a.modules, a.profile),
        { signal },
      );
      if (modules.length) await ensureDomainModules(modules, { signal });
      const context = {
        schemaVersion: "lemma.domain.v1",
        revision: MATHLIB_COMMIT,
        modules,
        definitions: [],
        lemmas: [],
      };
      const artifact = await record("draft_environment", context);
      const contract = createContract(
        {
          paperSha256: run.paperSha256,
          pageIndex: 0,
          text: "Diagnostic environment probe",
          artifact: run.sourceArtifact,
        },
        {
          label: "Environment only",
          quote: "Diagnostic environment probe",
          statement: "Diagnostic only",
          assumptions: [],
          leanTarget: "True",
        },
        a.profile || "std-v1",
        { contextArtifact: run.sourceArtifact, translationArtifact: artifact },
        { context, artifact },
      );
      const checked = await withCheckedEnvironment(
        contract,
        async (environment) => {
          if (!environment.lean.ready || !environment.library.ready)
            throw Error("Draft environment unavailable");
          const environmentIdentity = {
            lean: environment.lean,
            library: environment.library,
          };
          if (a.reuseArtifactId) {
            const prior = await getArtifact(a.reuseArtifactId),
              p = prior.payload.result;
            if (
              prior.kind !== "team:lean_draft" ||
              p.code !== a.code ||
              digest(p.modules) !== digest(modules) ||
              digest(p.environment) !== digest(environmentIdentity)
            )
              throw Error(
                "Diagnostic input or environment changed; omit reuseArtifactId for a fresh execution",
              );
            return {
              result: p.result,
              originalArtifactId: a.reuseArtifactId,
              nativeCheckExecuted: false,
              scope: "diagnostic_only_not_proof",
            };
          }
          if (name === "lean_explore")
            return {
              result: await this.warm.run(a.code, environment, sandboxProfile, {
                signal,
                runId: run.id,
              }),
              environment: environmentIdentity,
            };
          const folder = await realpath(
            await mkdtemp(path.join(os.tmpdir(), "lemma-team-draft-")),
          );
          try {
            const result = await (async () => {
              await writeFile(path.join(folder, "Draft.lean"), a.code, {
                mode: 0o600,
              });
              return runBounded(
                "/usr/bin/sandbox-exec",
                [
                  "-p",
                  sandboxProfile(
                    folder,
                    environment.library.searchPaths,
                    environment.runtime,
                  ),
                  environment.runtime.binary,
                  "-M",
                  "8192",
                  "Draft.lean",
                ],
                {
                  cwd: folder,
                  signal,
                  timeoutMs: 1200000,
                  maxOutput: 1000000,
                  maxMemoryMiB: 8192,
                  env: {
                    PATH: path.join(environment.runtime.toolRoot, "bin"),
                    HOME: folder,
                    LEAN_PATH: environment.library.searchPaths.join(
                      path.delimiter,
                    ),
                    LANG: "C.UTF-8",
                  },
                },
              );
            })();
            return { result, environment: environmentIdentity };
          } finally {
            await rm(folder, { recursive: true, force: true });
          }
        },
        { signal },
      );
      if (a.reuseArtifactId)
        return {
          ...checked,
          artifactId: await record("lean_draft_reuse", {
            originalArtifactId: a.reuseArtifactId,
            nativeCheckExecuted: false,
            scope: "diagnostic_only_not_proof",
          }),
        };
      const artifactId = await record(
        name === "lean_explore" ? "lean_exploration" : "lean_draft",
        {
          code: a.code,
          modules,
          environment: checked.environment,
          inputFingerprint: digest({
            code: a.code,
            modules,
            environment: checked.environment,
          }),
          result: checked.result,
          scope: "diagnostic_only_not_a_certificate",
        },
      );
      return {
        result: checked.result,
        artifactId,
        scope: "diagnostic_only_even_if_exit_code_zero",
        workspaceOption: {
          tool: "workspace_create",
          arguments: {
            title: "Saved diagnostic source",
            fromArtifact: artifactId,
          },
          guidance:
            "Optional: preserve this source for collaboration or repair. A diagnostic is not a proof certificate.",
        },
      };
    }
    if (name === "check_lean") {
      const t = getTarget(a.targetId),
        result = await this.checker(t.contract, a.proof, {
          mode: a.mode || "proof",
          signal,
          dependencyAudit: true,
        });
      const artifactId = await record(
        "lean",
        {
          targetId: t.id,
          contract: t.contract,
          proof: a.proof,
          mode: a.mode || "proof",
          result,
        },
        [t.artifact],
      );
      return {
        result: evidenceView(result, artifactId, [
          "payload",
          "result",
          "result",
        ]),
        artifactId,
      };
    }
    if (name === "run_python") {
      const result = await runNumericExperiment(
        path.join(this.store.root, "team-workspaces", run.id, actor.id),
        a.code,
        { signal, timeoutMs: a.timeoutMs, environmentId: a.environmentId },
      );
      return { result, artifactId: await record("experiment", result) };
    }
    if (name === "read_reference") {
      const result = await retrieveReference({ url: a.url }, source, [], {
        signal,
        allowDiscoveredUrl: true,
      });
      return { result, artifactId: await record("reference", result) };
    }
    throw Error("Unknown tool");
  }
}
