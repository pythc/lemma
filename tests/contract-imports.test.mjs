import test from "node:test";
import assert from "node:assert/strict";
import {
  createContract,
  withExecutionEnvironment,
} from "../server/contracts.mjs";
import {
  withPinnedMathlibModules,
  sameContractMathematics,
} from "../server/contract-imports.mjs";
import { moduleManifest } from "../server/domain-library.mjs";
import { digest, sha256 } from "../server/evidence.mjs";
const contract = () =>
  createContract(
    {
      text: "fixture",
      artifact: sha256("source"),
      paperSha256: sha256("paper"),
      pageIndex: 0,
    },
    {
      label: "fixture",
      quote: "fixture",
      statement: "fixture",
      assumptions: [],
      leanTarget: "∀ n : Nat, n = n",
    },
    "analysis-continuity-v1",
    {
      contextArtifact: sha256("context"),
      translationArtifact: sha256("translation"),
    },
  );
const rehash = (value) => {
  const { targetHash, ...body } = value;
  return { ...body, targetHash: digest(body) };
};
test("pinned import extension retains exact mathematical scope and existing module identities", async () => {
  const c = contract(),
    modules = await moduleManifest(["Mathlib.Analysis.Convex.Function"]);
  const n = withPinnedMathlibModules(c, modules, sha256("module receipt"));
  assert.notEqual(c.targetHash, n.targetHash);
  assert.equal(c.leanTarget, n.leanTarget);
  assert.equal(n.schemaVersion, "lemma.contract.v4");
  assert(n.imports.includes("Mathlib.Analysis.Convex.Function"));
  assert(sameContractMathematics(c, n));
  const more = await moduleManifest([
    "Mathlib.Analysis.Convex.Function",
    "Mathlib.Data.Real.Basic",
  ]);
  assert(
    sameContractMathematics(
      n,
      withPinnedMathlibModules(n, more, sha256("second receipt")),
    ),
  );
  assert.throws(
    () => withPinnedMathlibModules(n, [], sha256("invalid removal")),
    /scope/,
  );
});
test("environment extension cannot weaken the target, assumptions, source or definitions", async () => {
  const c = contract(),
    n = withPinnedMathlibModules(
      c,
      await moduleManifest(["Mathlib.Analysis.Convex.Function"]),
      sha256("receipt"),
    );
  for (const patch of [
    { leanTarget: "True" },
    { assumptions: ["extra assumption"] },
    { sourceArtifact: sha256("foreign source") },
    { contextArtifact: sha256("foreign context") },
  ])
    assert.equal(sameContractMathematics(c, rehash({ ...n, ...patch })), false);
  const changed = structuredClone(n);
  changed.domainContext.definitions.push({
    name: "Injected",
    type: "Prop",
    value: "True",
    meaning: "fixture",
    anchors: [{ pageIndex: 0, quote: "fixture" }],
    dependsOn: [],
  });
  assert.equal(sameContractMathematics(c, rehash(changed)), false);
  const replaced = structuredClone(n);
  replaced.domainContext.modules[0].sourceSha256 = sha256("wrong source");
  assert.equal(sameContractMathematics(n, rehash(replaced)), false);
});
test("import extension refuses unported sealed environments and missing provenance", async () => {
  const c = contract(),
    m = await moduleManifest(["Mathlib.Analysis.Convex.Function"]);
  const legacy = { ...c };
  delete legacy.contextArtifact;
  delete legacy.translationArtifact;
  legacy.schemaVersion = "lemma.contract.v2";
  assert.throws(
    () => withPinnedMathlibModules(rehash(legacy), m, sha256("receipt")),
    /fixed context/,
  );
  const base = createContract(
    {
      text: "fixture",
      artifact: sha256("source"),
      paperSha256: sha256("paper"),
      pageIndex: 0,
    },
    {
      label: "fixture",
      quote: "fixture",
      statement: "fixture",
      assumptions: [],
      leanTarget: "∀ n : Nat, n = n",
    },
  );
  const sealed = withExecutionEnvironment(base, {
    id: "lean-4.34.1",
    version: "4.34.1",
    receiptSha256: sha256("fixture-receipt"),
    distributionSha256: sha256("fixture-distribution"),
    librarySha256: sha256("fixture-library"),
    libraryRevision: "explicit-unit-fixture-only",
  });
  assert.throws(
    () => withPinnedMathlibModules(sealed, m, sha256("receipt")),
    /unported/,
  );
});
