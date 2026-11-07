import { sourceAuditFixture } from "./source-audit-fixture.mjs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { sha256 } from "../server/evidence.mjs";
export const quote =
  "Definition: Shift n is n + 0. Theorem: every natural n satisfies Shift n = n.";
export const proposal = {
  label: "Theorem 1",
  quote,
  statement: "每个自然数的 Shift 值等于自身",
  assumptions: ["n 是自然数"],
  leanTarget: "∀ n : Nat, LemmaPaper.Shift n = n",
  ambiguity: "",
};
export const plan = () => ({
  queries: [],
  modules: [],
  definitions: [
    {
      name: "Shift",
      type: "Nat → Nat",
      value: "fun n => n + 0",
      meaning: "Shift 把自然数映射到自身加零",
      anchors: [{ pageIndex: 0, quote: "Definition: Shift n is n + 0." }],
      dependsOn: [],
    },
  ],
  lemmas: [
    {
      name: "ShiftZero",
      target: "∀ n : Nat, LemmaPaper.Shift n = n",
      proof: "by intro n; rfl",
      purpose: "展开定义证明加零不变",
      dependsOn: ["Shift"],
    },
    {
      name: "ShiftTwice",
      target: "∀ n : Nat, LemmaPaper.Shift (LemmaPaper.Shift n) = n",
      proof: "by intro n; rw [LemmaPaper.ShiftZero, LemmaPaper.ShiftZero]",
      purpose: "组合两个已核验结论",
      dependsOn: ["ShiftZero"],
    },
  ],
});
export async function input() {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman);
  pdf.addPage().drawText(quote, { x: 20, y: 700, font, size: 10 });
  const bytes = Buffer.from(await pdf.save());
  return {
    pdfBase64: bytes.toString("base64"),
    paperSha256: sha256(bytes),
    pageIndex: 0,
    mode: "manual",
    libraryProfile: "std-v1",
    proposal: structuredClone(proposal),
  };
}
export async function settled(p, id, timeout = 20000) {
  const end = Date.now() + timeout;
  while (p.active.has(id)) {
    if (Date.now() >= end) throw new Error("Pipeline did not settle");
    await new Promise((r) => setTimeout(r, 20));
  }
  return p.store.getRun(id);
}
export const approval = (r) => ({
  confirmed: true,
  targetHash: r.contract.targetHash,
  semanticArtifact: r.semanticArtifact,
  resolutions: r.semanticReview.issues.map((i) => ({
    issueId: i.id,
    decision: "confirmed_with_reason",
    reason:
      "Controlled fixture attestation: checked the exact elementary source and definition; not a real paper review.",
  })),
  proof: "by exact LemmaPaper.ShiftZero",
  proofMode: "proof",
});
export const fixtureModel = async (_, request) => {
  let parsed;
  if (request.role === "RDDR")
    parsed = {
      status: "aligned",
      explanation: "Controlled fixture only: definition matches source.",
      anchors: [{ pageIndex: 0, quote }],
    };
  else if (request.role === "R04")
    parsed = {
      targetHash: request.input.contract.targetHash,
      ...(["lemma.source-audit.v4", "lemma.source-audit.v5"].includes(
        request.input.context?.semanticProtocol,
      )
        ? { findings: [] }
        : {}),
      ...(request.input.stage
        ? {}
        : {
            sourceAudit: sourceAuditFixture(
              request.input.contract,
              request.input.targetStructure,
              request.input.context.semanticProtocol,
            ),
          }),
      backTranslation: "Shift 是自然数加零，结果不变。",
      checks: [
        "variables",
        "quantifiers",
        "domain",
        "assumptions",
        "conclusion",
        "definitions",
      ].map((category) => ({
        category,
        status: "aligned",
        explanation: "Controlled fixture alignment only.",
        anchors: [{ pageIndex: 0, quote }],
      })),
    };
  else if (request.role === "RDLP") parsed = { proof: "by intro n; rfl" };
  else if (request.role === "RDDF")
    parsed = { type: "Nat → Nat", value: "fun n => n + 0" };
  else throw new Error(`Unexpected fixture request ${request.role}`);
  return {
    parsed,
    record: {
      provider: "controlled_fixture_no_live_model",
      role: request.role,
    },
  };
};
