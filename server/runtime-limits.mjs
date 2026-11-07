// Large-run policy selected by the user on 2026-10-19. Concurrency, trusted
// imports, semantic approval and unknown-outcome retry rules are independent.
const hour = 60 * 60 * 1000;
const minute = 60 * 1000;
export const MODEL_RUNTIME = Object.freeze({
  outputTokens: 393216,
  timeoutMs: 4 * hour,
  defaultTimeoutMs: 2 * hour,
  responseBytes: 32 * 1024 * 1024,
});
export const PROOF_RUNTIME = Object.freeze({
  maxElapsedMs: 12 * hour,
  maxCandidates: 128,
  maxModelCalls: 256,
  maxTacticSteps: 2048,
  maxRestarts: 8,
  maxInputCharacters: 50000000,
  maxRequestCharacters: 1000000,
  maxCompletionTokens: 256 * MODEL_RUNTIME.outputTokens,
  maxDecompositionPlans: 8,
  maxDecompositionDepth: 5,
  maxHelperParts: 16,
  maxHelperModelCalls: 64,
  perCallCompletionTokens: MODEL_RUNTIME.outputTokens,
  perSpecialistMs: 30 * minute,
  perStepMs: 5 * minute,
});
export const PROOF_CEILINGS = Object.freeze({
  maxElapsedMs: 48 * hour,
  maxCandidates: 512,
  maxModelCalls: 512,
  maxTacticSteps: 8192,
  maxRestarts: 32,
  maxInputCharacters: 200000000,
  maxRequestCharacters: 2000000,
  maxCompletionTokens: 512 * MODEL_RUNTIME.outputTokens,
  maxDecompositionPlans: 16,
  maxDecompositionDepth: 8,
  maxHelperParts: 32,
  maxHelperModelCalls: 256,
  perCallCompletionTokens: MODEL_RUNTIME.outputTokens,
  perSpecialistMs: 2 * hour,
  perStepMs: 30 * minute,
});
export const REVIEW_RUNTIME = Object.freeze({
  maxActions: 512,
  maxDecisions: 512,
  maxReadCalls: 256,
  chunkCharacters: 96000,
  maxClaims: 512,
  maxRetries: 6,
  maxModelCalls: 4096,
  maxRunMs: 48 * hour,
  recursionLimit: 50000,
});
export const DOMAIN_RUNTIME = Object.freeze({
  modules: 32,
  definitions: 16,
  lemmas: 24,
  attempts: 8,
  modelCalls: 512,
  elapsedMs: 12 * hour,
  requestCharacters: 1000000,
  generations: 8,
});
export function domainProvingBudget(overrides, limits, remainingMs, usedCalls) {
  const calls = Math.max(
    0,
    Math.min(
      limits.modelCalls - usedCalls,
      overrides.maxModelCalls ?? PROOF_RUNTIME.maxModelCalls,
    ),
  );
  const perCall = Math.min(
    overrides.perCallCompletionTokens ?? PROOF_RUNTIME.perCallCompletionTokens,
    limits.perCallCompletionTokens ?? PROOF_RUNTIME.perCallCompletionTokens,
  );
  return {
    ...PROOF_RUNTIME,
    ...overrides,
    maxElapsedMs: Math.max(
      1,
      Math.min(
        remainingMs,
        overrides.maxElapsedMs ?? PROOF_RUNTIME.maxElapsedMs,
      ),
    ),
    maxModelCalls: calls,
    perCallCompletionTokens: perCall,
    maxCompletionTokens: Math.min(
      overrides.maxCompletionTokens ?? PROOF_RUNTIME.maxCompletionTokens,
      perCall * calls,
    ),
  };
}
export const CONTEXT_RUNTIME = Object.freeze({
  pages: 120,
  characters: 750000,
  supplements: 16,
  supplementCharacters: 250000,
});
export const LEAN_RUNTIME = Object.freeze({
  goalMemoryMiB: 8192,
  stdTimeoutMs: 2 * minute,
  analysisTimeoutMs: 10 * minute,
  expandedTimeoutMs: 20 * minute,
  maxHeartbeats: 3000000,
  maxRecDepth: 8192,
  outputBytes: 4 * 1024 * 1024,
  proverRequestBytes: 8 * 1024 * 1024,
  proverResponseBytes: 16 * 1024 * 1024,
  proofCharacters: 1000000,
  targetCharacters: 512000,
  helperTargetCharacters: 24000,
  helperCandidates: 32,
  specialistOutputTokens: 40000, // Fits native 40,960 context; Python subtracts prompt tokens.
});
export const NETWORK_RUNTIME = Object.freeze({
  referenceTimeoutMs: 2 * minute,
  requestTimeoutMs: 10 * minute,
  fullExtractionMs: 5 * minute,
  pageExtractionMs: 2 * minute,
});
export const EVIDENCE_RUNTIME = Object.freeze({
  artifacts: 10000,
  paperArtifacts: 20000,
  replayBytes: 200 * 1024 * 1024,
  streamReplayBytes: 2 * 1024 * 1024 * 1024,
});
