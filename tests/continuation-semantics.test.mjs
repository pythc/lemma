import test from "node:test";
import assert from "node:assert/strict";
import {
  adjudicateFidelity,
  validateEpistemicFindings,
} from "../server/epistemic-audit.mjs";
import {
  WITNESSED_AUDIT_PROTOCOL,
  INDEXED_ANCHOR_V2,
  WITNESSED_AUDIT_PROMPT,
} from "../server/audit-wire.mjs";
import {
  sourceAnchorIndex,
  sourceScopeCandidates,
} from "../server/source-anchor-index.mjs";
import { blindSemanticInput } from "../server/semantic-blind.mjs";
import { reconstructProjectedAnchors } from "../server/semantic-projection.mjs";
import { validateSourceAudit } from "../server/source-audit.mjs";
import { sourceAuditFixture } from "./source-audit-fixture.mjs";
import { auditBodyPrompt } from "../server/audit-envelope.mjs";

const quote = "For every x, T(x) is positive.";
const context = {
  semanticProtocol: WITNESSED_AUDIT_PROTOCOL,
  pages: [{ pageIndex: 0, text: quote }],
  supplements: [],
  omittedPages: [],
};
const contract = { leanTarget: "∃ x : Int, -x > 0" };
const missing = {
  kind: "source_missing",
  category: "definitions",
  anchors: [{ pageIndex: 0, quote }],
  targetFragment: "-x",
  missingSymbols: ["T"],
  independentOfMissing: false,
  basis: "No source definition for T",
  changeWitness: null,
};
const change = (
  fragment = "T(x)",
  category = "definitions",
  targetFragment = "-x",
) => ({
  kind: "established_change",
  category,
  anchors: [{ pageIndex: 0, quote }],
  targetFragment,
  missingSymbols: [],
  independentOfMissing: true,
  basis: "Controlled candidate judgement",
  changeWitness: {
    kind: category,
    sourceAnchorIndex: 0,
    sourceFragment: fragment,
  },
});
const response = (findings) => ({ checks: [{ status: "aligned" }], findings });

test("v5 keeps unknown substitution unestablished; v4 evidence retains its historic decision", () => {
  const rows = [response([missing]), response([change()])];
  const r = adjudicateFidelity(contract, context, rows, []);
  assert.equal(r.fidelity, "unknown");
  assert.equal(r.admission, "blocked");
  assert.equal(
    r.findings[1].kind,
    "established_change",
    "keep the original model finding",
  );
  assert.equal(r.findings[1].evidenceStatus, "unsubstantiated");
  assert.equal(
    adjudicateFidelity(
      contract,
      { ...context, semanticProtocol: "lemma.source-audit.v4" },
      rows,
      [],
    ).fidelity,
    "changed",
  );
});
test("an independently located quantifier change remains changed alongside missing definitions", () => {
  const r = adjudicateFidelity(
    contract,
    context,
    [response([missing, change("For every x", "quantifiers", "∃ x : Int")])],
    [],
  );
  assert.equal(r.fidelity, "changed");
  assert.equal(r.admission, "blocked");
  assert.equal(r.findings[1].evidenceStatus, "supported_model_judgement");
});
test("cross-stage and rejected-response missing symbols constrain a later claim of certainty", () => {
  for (const rows of [
    [response([change()]), response([missing])],
    [response([change()])],
  ]) {
    const r = adjudicateFidelity(contract, context, rows, [], {
      blind: [{ outcome: "schema_rejected", response: response([missing]) }],
    });
    assert.equal(r.fidelity, "unknown");
    assert.equal(r.history.length, 1);
  }
});
test("malformed rejected history remains archived without crashing final adjudication", () => {
  const r = adjudicateFidelity(contract, context, [response([missing])], [], {
    blind: [
      {
        outcome: "schema_rejected",
        response: {
          findings: { bad: true },
          sourceAudit: { missing: "invalid" },
        },
      },
    ],
  });
  assert.equal(r.fidelity, "unknown");
  assert.deepEqual(r.history[0].findings, { bad: true });
});
test("change evidence rejects invented source, target, category and missing witness", () => {
  for (const f of [
    change("For no x"),
    change("For every x", "quantifiers", "∀ x"),
    { ...change(), changeWitness: null },
    {
      ...change(),
      changeWitness: { ...change().changeWitness, kind: "domain" },
    },
  ])
    assert.throws(
      () => validateEpistemicFindings(response([f]), contract, context),
      /差异|改写/,
    );
});
test("missing symbol matching respects identifier boundaries and literal punctuation", () => {
  const c = { ...context, pages: [{ pageIndex: 0, text: "TT(x) and T+(x)." }] };
  const f = {
    ...change(),
    anchors: [{ pageIndex: 0, quote: c.pages[0].text }],
    changeWitness: { ...change().changeWitness, sourceFragment: "TT(x)" },
  };
  const m = { ...missing, anchors: f.anchors };
  assert.equal(
    adjudicateFidelity(contract, c, [response([m, f])], []).fidelity,
    "changed",
  );
  f.changeWitness.sourceFragment = "T+(x)";
  m.missingSymbols = ["T+"];
  assert.equal(
    adjudicateFidelity(contract, c, [response([m, f])], []).fidelity,
    "unknown",
  );
});
test("cross-page candidates are authentic navigation; source-scope guards still reject a short range", () => {
  const pages = [
    { pageIndex: 0, text: "Define S(x) = -x." },
    { pageIndex: 1, text: "For every x, S(x) = -x." },
  ];
  const c = {
    ...context,
    paperSha256: "a".repeat(64),
    selectedPage: 1,
    anchorProtocol: INDEXED_ANCHOR_V2,
    pages,
  };
  const target = {
    ...contract,
    targetHash: "b".repeat(64),
    pageIndex: 1,
    quote: pages[1].text,
  };
  const before = JSON.stringify(c);
  const input = blindSemanticInput(target, c);
  const catalog = reconstructProjectedAnchors(input);
  assert.equal(input.context.scopeCandidates.length, 1);
  assert.deepEqual(catalog, sourceAnchorIndex(c));
  assert.equal(JSON.stringify(c), before, "never widen the stored context");
  const a = pages.map((p) => ({ pageIndex: p.pageIndex, quote: p.text }));
  const raw = sourceAuditFixture(target, null, c.semanticProtocol);
  raw.bindings = [
    {
      key: "S",
      symbol: "S",
      kind: "definition",
      anchor: a[0],
      scope: { start: a[0], end: a[1] },
    },
  ];
  raw.uses = [{ binding: "S", relation: "uses_definition", anchor: a[1] }];
  assert(
    !validateSourceAudit(raw, target, c).issues.some(
      (i) => i.code === "binding_out_of_scope",
    ),
  );
  raw.bindings[0].scope.end = a[0];
  assert(
    validateSourceAudit(raw, target, c).issues.some(
      (i) => i.code === "binding_out_of_scope",
    ),
  );
  raw.bindings[0].scope.end = a[1];
  raw.bindings.push({ ...raw.bindings[0], key: "another_S" });
  assert(
    validateSourceAudit(raw, target, c).issues.some(
      (i) => i.code === "ambiguous_symbol_scope",
    ),
  );
  assert.deepEqual(
    sourceScopeCandidates({
      ...c,
      pages: [pages[0], { ...pages[1], pageIndex: 2 }],
    }),
    [],
  );
});
test("bound v5 wire schema requires a witness without asking the model to repeat identity", () => {
  const p = auditBodyPrompt(
    WITNESSED_AUDIT_PROMPT,
    false,
    WITNESSED_AUDIT_PROTOCOL,
  );
  const schema = JSON.parse(p.split("\nJSON Schema: ")[1]);
  assert(!schema.properties.targetHash);
  assert(schema.properties.findings.items.required.includes("changeWitness"));
});
