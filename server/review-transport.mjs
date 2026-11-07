import { preFidelityReserve } from "./path-budget.mjs";
import { reserveObligation, guardObligation } from "./obligation-budget.mjs";
import {
  reserveRequest,
  dispatchRequest,
  settleRequest,
  withBudgetLock,
  budgetSnapshot,
  budgetError,
  protectedReviewCalls,
} from "./review-budget.mjs";
import { executionContext } from "./execution-context.mjs";
import {
  infrastructureFailure,
  providerAccountBlocked,
} from "./model-delivery.mjs";

const persistenceStops = new WeakMap();

// All product review models, including SDK iterations and prover helpers, share
// this dispatch boundary. Check again after the provider queue is acquired:
// requests queued before a sibling failed must not become new network requests.
export function reviewModelTransport({ model, getReview, saveReview, store }) {
  return async (config, request) => {
    const owner = executionContext.getStore()?.run;
    const reviewId =
      owner?.parentReviewId ||
      owner?.admissionBudgetId ||
      (owner?.orchestrationVersion === 2 ? owner.id : null);
    const taskRole = executionContext.getStore()?.task?.role || request.role;
    const logicalStage =
      request.budgetPurpose ||
      request.logicalStage ||
      (/^R0[89]/.test(taskRole) ||
      /^R06_(STEP|REPAIR|ASSEMBLY_REPAIR|THEOREM)$/.test(taskRole)
        ? "proof_construction"
        : /^R06_(GRAPH|INTERFACE|FORMALIZE|BLUEPRINT|ALIGN)/.test(taskRole)
          ? "source_planning"
          : taskRole);
    request = { ...request, logicalStage };
    let parent = reviewId ? await getReview(reviewId) : null;
    if (
      parent?.orchestrationVersion !== 2 &&
      !(
        parent?.schemaVersion === "lemma.admission-budget.v1" &&
        !owner.parentReviewId
      )
    )
      parent = null;
    const guard = async (alreadyReserved = false) => {
      if (!parent) return;
      parent = await getReview(reviewId);
      if (
        parent.infrastructureFailure ||
        parent.budgetPersistenceFailure ||
        persistenceStops.get(store)?.has(reviewId)
      ) {
        const message =
          parent.infrastructureFailure?.kind === "provider_account_blocked"
            ? "模型供应商账户或余额受限，本次请求尚未发送。"
            : "模型连接异常，本次请求尚未发送。";
        throw Object.assign(new Error(message), {
          recoveryStop: "infrastructure_unavailable",
          modelRecord: {
            role: request.role,
            model: config?.model || null,
            source: "local_review_dispatch_guard",
            request: null,
            content: null,
            resource: { executionStarted: false },
            error: {
              code: "model_dispatch_blocked",
              message,
              delivery: {
                outcome: "not_sent",
                requestCreated: false,
                headersSent: false,
              },
            },
          },
        });
      }
      if (
        parent.budgetStop &&
        !alreadyReserved &&
        !(
          owner.parentReviewId &&
          owner.contract &&
          (request.role === "R04" || /R06_.*_AUDIT$/.test(request.role || ""))
        )
      )
        throw budgetError(parent, parent.budgetStop.reason);
      if (
        ["cancelled", "completed", "blocked", "closed"].includes(parent.status)
      )
        throw new Error("父评审已结束，未发起模型请求。");
    };
    await guard();
    reserveObligation(owner);
    const update = async (event, action) =>
      withBudgetLock(store, reviewId, async () => {
        parent = await getReview(reviewId);
        try {
          return await action(parent);
        } finally {
          try {
            await saveReview(parent, event, owner.parentTaskId);
          } catch (error) {
            parent.budgetPersistenceFailure = true;
            if (!persistenceStops.has(store))
              persistenceStops.set(store, new Set());
            persistenceStops.get(store).add(reviewId);
            throw error;
          }
        }
      });
    const reservation = parent
      ? await update("model_reserved", (r) => {
          if (
            r.schemaVersion === "lemma.admission-budget.v1" &&
            !request.budgetPurpose?.startsWith("semantic_")
          ) {
            const translation = (r.modelBudget?.entries || []).filter(
              (e) =>
                !e.purpose?.startsWith("semantic_") && e.state !== "not_sent",
            );
            if (translation.length >= 2)
              throw budgetError(r, "translation_stage_cap");
          }
          return reserveRequest(r, {
            role: request.role,
            ...(request.phaseDecision
              ? { phaseDecision: request.phaseDecision }
              : {}),
            ownerRunId: owner.id,
            protectedCalls: owner?.activeObligation
              ? 0
              : protectedReviewCalls(
                  owner,
                  request,
                  executionContext.getStore()?.task,
                ),
            ...(owner?.activeObligation
              ? {
                  protectedMs:
                    owner.activeObligation.pathEstimate?.native.archive.ms ||
                    10000,
                  pathEstimate: owner.activeObligation.pathEstimate || null,
                }
              : r.schemaVersion === "lemma.admission-budget.v1"
                ? {}
                : preFidelityReserve(
                    r,
                    owner,
                    protectedReviewCalls(
                      owner,
                      request,
                      executionContext.getStore()?.task,
                    ),
                  )),
            taskId:
              owner.parentTaskId ||
              executionContext.getStore()?.task?.id ||
              null,
            purpose:
              request.budgetPurpose ||
              executionContext.getStore()?.task?.kind ||
              request.role,
          });
        })
      : null;
    const deadline =
      parent?.limits?.maxRunMs && parent.createdAt
        ? Math.max(
            1,
            parent.limits.maxRunMs -
              (Date.now() -
                Date.parse(parent.budgetStartedAt || parent.createdAt)),
          )
        : null;
    const signal = deadline
      ? AbortSignal.any([
          ...(request.signal ? [request.signal] : []),
          AbortSignal.timeout(deadline),
        ])
      : request.signal;
    let settled = false;
    const settle = async (record, error) => {
      if (!reservation || settled) return;
      settled = true;
      // Receipt storage must succeed before linking it into the ledger. If it
      // fails, retain the charged reservation and stop dispatch conservatively.
      try {
        const receipt = await store.put(
          "review_budget_receipt",
          {
            reviewId,
            reservation,
            ownerRunId: owner.id,
            model: record || null,
            error: error?.message || null,
          },
          [parent.sourceArtifact].filter(Boolean),
        );
        await update("model_settled", (r) =>
          settleRequest(r, reservation, record, error, receipt),
        );
      } catch (persistenceError) {
        parent.budgetPersistenceFailure = true;
        if (!persistenceStops.has(store))
          persistenceStops.set(store, new Set());
        persistenceStops.get(store).add(reviewId);
        throw persistenceError;
      }
    };
    const reported = new WeakSet();
    const publishFailure = async (error) => {
      if (reported.has(error)) return;
      if (parent && budgetSnapshot(parent).remainingMs === 0) {
        budgetError(parent, "wall_time");
        error.recoveryStop = "review_budget_exhausted";
        await saveReview(parent, "budget_limit", owner.parentTaskId);
        await request.onFailure?.(error);
        reported.add(error);
        return;
      }
      reported.add(error);
      if (
        parent &&
        infrastructureFailure(error) &&
        !parent.infrastructureFailure
      ) {
        const record = error.modelRecord;
        const failure = {
          taskId:
            owner.parentTaskId || executionContext.getStore()?.task?.id || null,
          artifact: null,
          message: providerAccountBlocked(record)
            ? "模型供应商返回 HTTP 402，账户或余额受限；评审未完成。"
            : record.error.message || error.message,
          kind: providerAccountBlocked(record)
            ? "provider_account_blocked"
            : "provider_unavailable",
          httpStatus: record.http?.status || null,
          code: record.error.code,
          outcome: record.error.delivery?.outcome || "unknown",
        };
        parent.infrastructureFailure = failure;
        failure.artifact = await store.put(
          "review_model_failure",
          {
            reviewId: parent.id,
            ownerRunId: owner.id,
            // Component admission budgets have no document identity; bind the
            // failure to the actual child source instead of serializing undefined.
            paperSha256: parent.paperSha256 || owner.paperSha256 || null,
            model: record,
          },
          [
            ...new Set(
              [parent.sourceArtifact, owner.sourceArtifact].filter(Boolean),
            ),
          ],
        );
        await saveReview(parent, "model_transport_blocked", owner.parentTaskId);
      }
      await request.onFailure?.(error);
    };
    try {
      const result = await model(config, {
        ...request,
        signal,
        deadlineSource: parent
          ? "minimum_of_stage_and_parent_review"
          : "stage_or_product_default",
        onStarted: async () => {
          await guard(!!reservation);
          guardObligation(owner);
          await request.onStarted?.();
          if (reservation)
            await update("model_dispatched", (r) =>
              dispatchRequest(r, reservation),
            );
        },
        onFailure: publishFailure,
      });
      await settle(result.record, null);
      return result;
    } catch (error) {
      // Also covers injected transports and rejections before slot acquisition.
      await settle(error.modelRecord, error);
      await publishFailure(error);
      throw error;
    }
  };
}
