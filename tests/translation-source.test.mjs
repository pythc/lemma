import test from "node:test";
import assert from "node:assert/strict";
import {
  translationSourcePacket,
  translationSourceMessage,
} from "../server/translation-source.mjs";
import { HarnessChatModel } from "../server/harness-model.mjs";
import { HumanMessage } from "@langchain/core/messages";
import { sha256 } from "../server/evidence.mjs";
const context = {
  paperSha256: sha256("source"),
  pages: [
    { pageIndex: 0, text: "Define x to be a natural number." },
    { pageIndex: 2, text: "Proposition. Every x equals itself." },
  ],
  supplements: [],
};
const input = {
  context,
  selectedPage: 2,
  selectedQuote: "Proposition.",
  propositionScope: {
    locator: { pageIndex: 2, quote: "Proposition." },
    spans: context.pages.map((p) => ({
      pageIndex: p.pageIndex,
      quote: p.text,
    })),
  },
};
test("fixed source preserves all cross-page spans and detects changed source/locator/scope", () => {
  const build = (i = input, c = context) =>
    translationSourcePacket({
      input: i,
      context: c,
      sourceIdentity: { paperSha256: context.paperSha256 },
    });
  const packet = build();
  assert.deepEqual(
    packet.spans.map((s) => s.quote),
    context.pages.map((p) => p.text),
  );
  for (const mutate of [
    (i) => (i.context.paperSha256 = sha256("other")),
    (i) => (i.context.pages[0].text = "An invented definition."),
    (i) => (i.propositionScope.paperSha256 = sha256("other")),
    (i) => (i.propositionScope.spans[0].quote = "An invented definition."),
    (i) => (i.propositionScope.spans = []),
    (i) => i.propositionScope.spans.pop(),
    (i) => (i.propositionScope.locator.pageIndex = 0),
    (i) => (i.propositionScope.scopeHash = sha256("wrong")),
  ]) {
    const i = structuredClone(input);
    mutate(i);
    assert.throws(() => build(i));
  }
  const before = translationSourceMessage(packet).content;
  const copy = structuredClone(packet);
  copy.spans.pop();
  assert.throws(() => translationSourceMessage(copy), /changed/);
  assert.equal(translationSourceMessage(packet).content, before);
});
test("mandatory source capacity fails before reserve or model invocation", async () => {
  let reserve = 0,
    invoke = 0;
  const model = new HarnessChatModel({
    config: {},
    maxContextCharacters: 1001,
    fixedMessages: async () => [
      { role: "user", content: "source".repeat(1000) },
    ],
    reserve: async () => reserve++,
    invoke: async () => invoke++,
  });
  try {
    await assert.rejects(
      model.invoke([new HumanMessage("short history")]),
      /Mandatory translation source/,
    );
    assert.equal(reserve, 0);
    assert.equal(invoke, 0);
  } finally {
    await model.closeAndDrain();
  }
});
