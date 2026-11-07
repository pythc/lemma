import { resolveDeclarationModules } from "./premise-index.mjs";
import { validateDomainPlan } from "./domain-schema.mjs";
import { moduleManifest, ensureDomainModules } from "./domain-library.mjs";

// Shared by the full-paper entry and tool workers. A source hit is only a
// candidate: preparation and a native query are still required by callers.
export async function prepareInspectionModules({
  profile,
  modules = [],
  names = [],
  definitions = [],
  context,
  autoResolveNames = true,
  signal,
}) {
  const resolutions = autoResolveNames
    ? await resolveDeclarationModules(names, { signal })
    : [];
  const plan = validateDomainPlan(
    {
      modules: [
        ...new Set([
          ...profile.imports.filter((n) => n.startsWith("Mathlib.")),
          ...modules,
          ...resolutions
            .filter((r) => r.status === "resolved_candidate")
            .flatMap((r) => r.modules),
        ]),
      ],
      definitions,
      lemmas: [],
    },
    context,
  );
  const manifest = await moduleManifest(plan.modules, { signal });
  const preparation = await ensureDomainModules(manifest, { signal });
  return { plan, manifest, preparation, resolutions };
}
