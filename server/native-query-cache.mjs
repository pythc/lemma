import { executionContext } from "./execution-context.mjs";
import { digest } from "./evidence.mjs";
const owners = new WeakMap();
export function queryCache(
  contract,
  environment,
  { names, definitions, signal },
) {
  const owner = executionContext.getStore()?.run;
  if (!owner || !environment.ready || signal?.aborted) {
    if (owner) owners.delete(owner);
    return null;
  }
  let cache = owners.get(owner);
  if (!cache) {
    cache = new Map();
    owners.set(owner, cache);
  }
  if (signal && !cache.signals?.has(signal)) {
    cache.signals ||= new WeakSet();
    cache.signals.add(signal);
    signal.addEventListener(
      "abort",
      () => {
        cache.clear();
        owners.delete(owner);
      },
      { once: true },
    );
  }
  const key = digest({
    protocol: "lemma.native-query-cache.v1",
    contract,
    environment,
    names,
    definitions,
  });
  return {
    key,
    get: () => (cache.has(key) ? structuredClone(cache.get(key)) : null),
    put: (value) => {
      if (value.status === "well_typed" && !signal?.aborted) {
        if (cache.size >= 32) cache.delete(cache.keys().next().value);
        cache.set(key, structuredClone(value));
      }
    },
  };
}

export function invalidateNativeQueryOwner() {
  const owner = executionContext.getStore()?.run;
  if (owner) {
    owners.get(owner)?.clear();
    owners.delete(owner);
  }
}
