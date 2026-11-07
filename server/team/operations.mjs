import { randomUUID } from "node:crypto";
import { ActionJournal } from "./action-journal.mjs";
import { actionIdentity, navigationTools } from "./action-identity.mjs";
import { errorView } from "./tool-errors.mjs";
import { registerReference, referenceProjection } from "./references.mjs";
import { executionContext } from "../execution-context.mjs";
import { evidenceView } from "./evidence-view.mjs";
import { digest } from "../evidence.mjs";

const settled = (status) =>
  ["completed", "failed", "cancelled", "unknown"].includes(status);

// Durable tool execution is independent of the lifetime of an HTTP request or
// model turn. Reconnection observes the original operation; it never replays it.
export class TeamOperations {
  constructor(runtime) {
    this.runtime = runtime;
    this.jobs = new Map();
    this.journal = new ActionJournal(runtime.store?.root);
  }
  async start(session, request) {
    const { runId, actorId } = session;
    const run = this.runtime.runs.get(runId);
    if ((run?.protocolVersion || 0) < 7)
      return this.startLegacy(session, request);
    const actor = run.tasks.find((t) => t.id === actorId);
    if (run.status !== "running" || actor?.status !== "running")
      throw Error("Actor is not running; operation was not dispatched");
    if (!/^[a-f0-9-]{36}$/.test(request.operationId || ""))
      throw Error(
        "A client-generated operation UUID is required before dispatch",
      );
    let identity;
    try {
      identity = actionIdentity(
        run,
        actor,
        request.name,
        request.arguments || {},
      );
    } catch (e) {
      const error = { ...errorView(e), dispatchState: "not_dispatched" };
      const fingerprint = digest({
        name: request.name,
        arguments: request.arguments || {},
      });
      await this.journal.call("reject", { runId, actorId, request, error });
      await this.runtime.edit(
        runId,
        async (r) => {
          const admission = await this.journal.call("claim", {
            runId,
            actorId,
            requestId: request.operationId,
            transportId: request.operationId,
            fingerprint,
            logicalKey: digest({
              runId,
              actorId,
              version: actor.version,
              fingerprint,
              rejected: true,
            }),
            coalesce: false,
            operation: {
              id: request.operationId,
              actorId,
              version: actor.version,
              name: request.name,
              fingerprint,
              logicalKey: digest({
                runId,
                actorId,
                version: actor.version,
                fingerprint,
                rejected: true,
              }),
              originalArguments: request.arguments || {},
              startedAt: new Date().toISOString(),
            },
          });
          if (!admission.created) return false;
          const patch = {
            status: "failed",
            phase: "settled",
            executionDispatched: false,
            error,
            receivedOutcome: { status: "failed", error },
            endedAt: new Date().toISOString(),
          };
          await this.journal.call("update", {
            runId,
            id: request.operationId,
            patch,
          });
          const {
            originalArguments,
            resolvedArguments,
            receivedOutcome,
            ...projection
          } = { ...admission.action, ...patch };
          r.operations.push(projection);
        },
        { skipIfUnchanged: true },
      );
      return this.get(runId, request.operationId);
    }
    let claimed;
    try {
      await this.runtime.edit(
        runId,
        async (r) => {
          if (r.status !== "running" || actor.status !== "running")
            throw Error("Actor is not running");
          claimed = await this.journal.call("claim", {
            runId,
            actorId,
            requestId: identity.actionId || request.operationId,
            transportId: request.operationId,
            fingerprint: identity.fingerprint,
            logicalKey: identity.logicalKey,
            coalesce: identity.coalesce,
            forceNew: identity.forceNew,
            operation: {
              id: identity.actionId || request.operationId,
              actorId,
              version: actor.version,
              actionId: identity.actionId || request.operationId,
              attemptId: randomUUID(),
              name: request.name,
              fingerprint: identity.fingerprint,
              logicalKey: identity.logicalKey,
              originalArguments: request.arguments || {},
              resolvedArguments: identity.resolved,
              newExecutionReason: identity.reason,
              startedAt: new Date().toISOString(),
            },
          });
          if (!claimed.created) return false;
          const op = claimed.action;
          try {
            if (!navigationTools.has(op.name)) {
              op.inputArtifact = await this.runtime.store.put(
                "team:operation_input",
                {
                  runId,
                  actorId,
                  result: {
                    operationId: op.id,
                    name: op.name,
                    originalArguments: request.arguments || {},
                    resolvedArguments: identity.resolved,
                  },
                },
                [r.sourceArtifact],
              );
              r.receipts.push(op.inputArtifact);
              registerReference(r, "artifact", op.inputArtifact);
            }
            op.status = "running";
            await this.journal.call("update", { runId, id: op.id, patch: op });
            const { originalArguments, resolvedArguments, ...projection } = op;
            r.operations.push(projection);
          } catch (e) {
            await this.journal.call("update", {
              runId,
              id: op.id,
              patch: { status: "not_sent", reason: e.message },
            });
            throw e;
          }
        },
        { skipIfUnchanged: true },
      );
    } catch (error) {
      if (claimed?.created) {
        const patch = {
          status: "failed",
          executionDispatched: false,
          reason: `Input persistence failed; work was not dispatched: ${error.message}`,
          endedAt: new Date().toISOString(),
        };
        await this.journal
          .call("update", { runId, id: claimed.action.id, patch })
          .catch(() => {});
        const op = run.operations.find((o) => o.id === claimed.action.id);
        if (op) {
          Object.assign(op, patch);
          await this.runtime.edit(runId, () => {}).catch(() => {});
        }
      }
      throw error;
    }
    const id = claimed.action.id;
    if (claimed.created) {
      const job = this.execute(session, {
        ...request,
        operationId: id,
        arguments: identity.input,
      })
        .catch(async (error) => {
          const saved = await this.journal
            .call("get", { runId, id })
            .catch(() => null);
          const patch =
            saved && settled(saved.status)
              ? {
                  status: saved.status,
                  artifactId: saved.artifactId || null,
                  endedAt: saved.endedAt,
                  error: saved.error || null,
                  resultSummary: saved.resultSummary || null,
                }
              : {
                  status: "unknown",
                  reason: `Result persistence failed: ${error.message}`,
                };
          if (!saved || !settled(saved.status))
            await this.journal
              .call("update", { runId, id, patch })
              .catch(() => {});
          await this.runtime.edit(runId, (r) => {
            const op = r.operations.find((o) => o.id === id);
            if (op) Object.assign(op, patch);
          });
        })
        .finally(() => {
          this.jobs.delete(id);
          this.runtime.pump(runId);
          const r = this.runtime.runs.get(runId);
          if (
            r.status !== "running" &&
            !this.runtime.active.get(runId)?.jobs.size
          )
            return this.runtime.seal(runId);
        });
      this.jobs.set(id, job);
      void job.catch(() => {});
    }
    const view = await this.get(runId, id);
    return {
      ...view,
      delivery: claimed.created
        ? "new_execution"
        : view.status === "completed"
          ? "received_result"
          : "reconnected",
      requestOperationId: request.operationId,
      ...(claimed.created
        ? {}
        : {
            newNativeExecution: false,
            resultMeaning:
              "Original received result at its recorded version and environment, not a fresh environment verification. Use an explicit new execution to recheck; unknown work is never replayed.",
          }),
    };
  }
  async sealJournal(runId) {
    const run = this.runtime.runs.get(runId);
    let after = run.journalThrough || 0,
      previous = run.journalRoot || null;
    while (true) {
      const events = await this.journal.call("events", {
        runId,
        after,
        limit: 100,
      });
      if (!events.length) break;
      const references = new Set(previous ? [previous] : []);
      for (const e of events)
        for (const k of [
          "inputArtifact",
          "artifactId",
          "resolvedInputArtifact",
        ])
          if (e.body[k]) references.add(e.body[k]);
      const id = await this.runtime.store.put(
        "team:event_segment",
        {
          schema: "lemma.action-events.v1",
          runId,
          previous,
          after,
          through: events.at(-1).seq,
          events,
        },
        [...references],
      );
      previous = id;
      after = events.at(-1).seq;
    }
    run.journalRoot = previous;
    run.journalThrough = after;
    return previous;
  }
  async close() {
    await this.journal.close();
  }
  async startLegacy(session, request) {
    const { runId, actorId } = session;
    const { operationId, name, arguments: args = {} } = request;
    if (!/^[a-f0-9-]{36}$/.test(operationId || ""))
      throw Error(
        "A client-generated operation UUID is required before dispatch",
      );
    const fingerprint = digest({ name, arguments: args });
    let fresh = false;
    try {
      await this.runtime.edit(runId, async (run) => {
        run.operations ||= [];
        const old = run.operations.find((o) => o.id === operationId);
        if (old) {
          if (old.actorId !== actorId || old.fingerprint !== fingerprint)
            throw Error(
              "Operation ID already belongs to different input or actor",
            );
          return;
        }
        const actor = run.tasks.find((t) => t.id === actorId);
        if (run.status !== "running" || actor?.status !== "running")
          throw Error("Actor is not running; operation was not dispatched");
        const inputArtifact = await this.runtime.store.put(
          "team:operation_input",
          {
            runId,
            actorId,
            result: { operationId, name, originalArguments: args },
          },
          [run.sourceArtifact],
        );
        if (!run.receipts.includes(inputArtifact))
          run.receipts.push(inputArtifact);
        registerReference(run, "artifact", inputArtifact);
        fresh = true;
        run.operations.push({
          id: operationId,
          actorId,
          version: actor.version,
          name,
          fingerprint,
          status: "running",
          startedAt: new Date().toISOString(),
          inputArtifact,
        });
      });
    } catch (error) {
      // Dispatch is after the durable write. A failed acknowledgement must not
      // leave an in-memory "running" operation that can never finish.
      if (fresh) {
        const op = this.runtime.runs
          .get(runId)
          ?.operations?.find((o) => o.id === operationId);
        if (op) {
          Object.assign(op, {
            status: "failed",
            executionDispatched: false,
            reason: `Input persistence failed; work was not dispatched: ${error.message}`,
            endedAt: new Date().toISOString(),
          });
          await this.runtime.edit(runId, () => {}).catch(() => {});
        }
      }
      throw error;
    }
    if (fresh) {
      const job = this.execute(session, request)
        .catch(async (error) => {
          await this.runtime.edit(runId, (run) => {
            const op = run.operations.find((o) => o.id === operationId);
            op.status = "unknown";
            op.reason = `Result persistence failed: ${error.message}`;
          });
        })
        .finally(() => {
          this.jobs.delete(operationId);
          this.runtime.pump(runId);
          const run = this.runtime.runs.get(runId);
          if (
            run.status !== "running" &&
            !this.runtime.active.get(runId)?.jobs.size
          )
            return this.runtime.seal(runId);
        });
      this.jobs.set(operationId, job);
      void job.catch(() => {}); // Missing final persistence remains running/unknown, never silently retried.
    }
    return this.get(runId, operationId);
  }
  async resourcePhase(runId, operationId, resource, phase) {
    await this.runtime.edit(runId, (run) => {
      const op = run.operations.find((o) => o.id === operationId);
      if (!op || settled(op.status)) return;
      const at = new Date().toISOString();
      op.resource = resource;
      op.phase = phase;
      op.resourceEvents ||= [];
      op.resourceEvents.push({ resource, phase, at });
      op.resourceStages ||= [];
      const previous = op.resourceStages.at(-1);
      if (previous && !previous.endedAt) previous.endedAt = at;
      op.resourceStages.push({ resource, phase, startedAt: at, endedAt: null });
      if (phase === "queued") {
        op.queuedAt = at;
        op.executionStartedAt = null;
      } else op.executionStartedAt = at;
    });
  }
  async execute(session, request) {
    const { runId, actorId } = session;
    const { operationId, name, arguments: args = {} } = request;
    let outcome;
    try {
      if (this.runtime.runs.get(runId).protocolVersion >= 7) {
        session.signal?.throwIfAborted();
        await this.journal.call("update", {
          runId,
          id: operationId,
          patch: { status: "dispatching", executionDispatched: true },
        });
        await this.runtime.edit(runId, (r) => {
          Object.assign(
            r.operations.find((o) => o.id === operationId),
            { executionDispatched: true, phase: "preparing" },
          );
        });
      }
      const value = await executionContext.run(
        {
          ...executionContext.getStore(),
          onNativeStage: ({ name, phase }) =>
            name === "native.kernel"
              ? this.resourcePhase(
                  runId,
                  operationId,
                  "lean",
                  phase === "started"
                    ? "native_executing"
                    : "post_verification",
                )
              : undefined,
          onNativeSpan: (span) =>
            this.runtime.edit(runId, (run) => {
              const op = run.operations.find((o) => o.id === operationId);
              (op.nativeTimings ||= []).push(span);
            }),
          onToolQueued: (resource) =>
            this.resourcePhase(runId, operationId, resource, "queued"),
          onToolFinished: (resource) =>
            this.resourcePhase(
              runId,
              operationId,
              resource,
              "post_verification",
            ),
          onToolStarted: (resource) =>
            this.resourcePhase(runId, operationId, resource, "executing"),
        },
        () =>
          this.runtime.call(
            runId,
            actorId,
            name,
            args,
            session.signal,
            operationId,
          ),
      );
      outcome = { status: "completed", value: value ?? null };
      const result = value?.result;
      outcome.resultSummary = result
        ? {
            status: result.status ?? null,
            exitCode: result.exitCode ?? null,
            termination: result.termination ?? null,
            scope: value.scope || null,
            nativeCheckExecuted: value.nativeCheckExecuted ?? null,
          }
        : null;
    } catch (error) {
      outcome = {
        status: session.signal?.aborted ? "cancelled" : "failed",
        error: errorView(error),
      };
    }
    // Save the received result before publishing a terminal state.
    const original = this.runtime.runs
      .get(runId)
      .operations.find((o) => o.id === operationId);
    const inline =
      this.runtime.runs.get(runId).protocolVersion >= 7 &&
      navigationTools.has(name) &&
      JSON.stringify(outcome).length <= 64000;
    const artifactId = inline
      ? null
      : await this.runtime.record(
          runId,
          actorId,
          "operation",
          {
            operationId,
            name,
            inputArtifact: original.inputArtifact || null,
            resolvedInputArtifact: original.resolvedInputArtifact || null,
            ...outcome,
          },
          [original.inputArtifact, original.resolvedInputArtifact].filter(
            Boolean,
          ),
        );
    if (this.runtime.runs.get(runId).protocolVersion >= 7)
      await this.journal.call("update", {
        runId,
        id: operationId,
        patch: {
          status: outcome.status,
          resultSummary: outcome.resultSummary || null,
          artifactId,
          endedAt: new Date().toISOString(),
          error: outcome.error || null,
          ...(inline ? { receivedOutcome: outcome } : {}),
        },
      });
    await this.runtime.edit(runId, (run) => {
      const last = run.operations
        .find((o) => o.id === operationId)
        ?.resourceStages?.at(-1);
      if (last && !last.endedAt) last.endedAt = new Date().toISOString();
      Object.assign(
        run.operations.find((o) => o.id === operationId),
        {
          status: outcome.status,
          phase: "settled",
          artifactId,
          endedAt: new Date().toISOString(),
          error: outcome.error || null,
          resultSummary: outcome.resultSummary || null,
        },
      );
    });
  }
  async get(runId, operationId) {
    const run = this.runtime.runs.get(runId);
    let op = run?.operations?.find((o) => o.id === operationId);
    if (!op && run?.protocolVersion >= 7) {
      const saved = await this.journal.call("get", { runId, id: operationId });
      op = run.operations.find((o) => o.id === saved?.id) || saved;
    }
    if (op) operationId = op.id;
    if (!op)
      return {
        operationId,
        status: "not_found",
        guidance:
          "No received operation with this ID. Do not infer an external outcome or replay unknown work.",
      };
    const view = {
      operationId,
      name: op.name,
      actorId: op.actorId,
      version: op.version,
      status: op.status,
      phase: settled(op.status) ? "settled" : op.phase || "preparing",
      resource: op.resource || null,
      resourceStages: op.resourceStages || [],
      startedAt: op.startedAt,
      queuedAt: op.queuedAt || null,
      executionStartedAt: op.executionStartedAt || null,
      endedAt: op.endedAt || null,
      artifactId: op.artifactId || null,
      inputArtifact: op.inputArtifact || null,
      resolvedInputArtifact: op.resolvedInputArtifact || null,
      ...(op.reason ? { reason: op.reason } : {}),
      ...(op.executionDispatched === false
        ? { executionDispatched: false }
        : {}),
    };
    if (op.artifactId) {
      const receipt = await this.runtime.getArtifact(run, op.artifactId);
      const result = receipt.payload.result;
      if (op.status === "completed")
        view.result = evidenceView(result.value, op.artifactId, [
          "payload",
          "result",
          "value",
        ]);
      else view.error = result.error;
    }
    if (!op.artifactId && settled(op.status) && run.protocolVersion >= 7) {
      const saved = await this.journal.call("get", { runId, id: operationId });
      if (saved?.receivedOutcome) {
        if (Object.hasOwn(saved.receivedOutcome, "value"))
          view.result = saved.receivedOutcome.value;
        if (saved.receivedOutcome.error)
          view.error = saved.receivedOutcome.error;
        view.eventEvidence = {
          actionId: operationId,
          storage: "durable_action_journal",
          segmentRoot: run.journalRoot || null,
        };
      }
    }
    if (!settled(op.status))
      view.guidance =
        "Use get_operation with this ID, yield_work with operationIds, or continue independent work. Do not start this operation again.";
    return referenceProjection(run, view);
  }
}

export const operationSettled = settled;
