import test from "node:test";
import assert from "node:assert/strict";
import {
  captureStrictResponse,
  validateStrictResponseShape,
  verifyStrictResponseReceipt,
} from "../server/strict-response.mjs";
import {
  captureStrictResponse as captureV2,
  validateStrictResponseShape as validateV2,
} from "../server/strict-response-v2.mjs";
import { parseUniqueJson } from "../server/unique-json.mjs";
import { publicToolCalls } from "../server/public-model-view.mjs";
const response = () => ({
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "local",
            type: "function",
            function: { name: "submit_semantic_audit", arguments: "{}" },
          },
        ],
      },
    },
  ],
});
const record = (r, capture = captureStrictResponse) => {
  const strictResponse = capture(JSON.stringify(r));
  return {
    strictResponse,
    http: { bodySha256: strictResponse.originalBodySha256 },
    content: null,
    finishReason: "tool_calls",
    toolCalls: publicToolCalls(r.choices[0].message.tool_calls),
  };
};
test("v3 preserves index zero without rewriting historical v2 validation", () => {
  const r = response();
  const old = record(r, captureV2);
  assert.doesNotThrow(() => verifyStrictResponseReceipt(old));
  r.choices[0].message.tool_calls[0].index = 0;
  assert.throws(() => validateV2(r), /tool shape/);
  const current = record(r);
  assert.equal(
    current.strictResponse.protocol,
    "lemma.model-public-response.v3",
  );
  assert.equal(
    verifyStrictResponseReceipt(current).message.tool_calls[0].index,
    0,
  );
  const changed = structuredClone(current);
  delete changed.toolCalls[0].index;
  assert.throws(() => verifyStrictResponseReceipt(changed), /information loss/);
  const mislabeled = structuredClone(current);
  mislabeled.strictResponse.protocol = "lemma.model-public-response.v2";
  assert.throws(() => verifyStrictResponseReceipt(mislabeled), /tool shape/);
});
test("provider index rejects wrong values, duplicates and conflicting response shapes", () => {
  for (const value of [1, -1, "0", null, false, {}, [], 0.5]) {
    const r = response();
    r.choices[0].message.tool_calls[0].index = value;
    assert.throws(() => validateStrictResponseShape(r));
  }
  for (const mutate of [
    (r) => r.choices.push(structuredClone(r.choices[0])),
    (r) =>
      r.choices[0].message.tool_calls.push(
        structuredClone(r.choices[0].message.tool_calls[0]),
      ),
    (r) =>
      (r.choices[0].message.content = [
        { type: "text", text: "A conflicting finding" },
      ]),
    (r) => (r.choices[0].message.tool_calls[0].unknown = "sensitive"),
  ]) {
    const r = response();
    r.choices[0].message.tool_calls[0].index = 0;
    mutate(r);
    assert.throws(() => validateStrictResponseShape(r));
  }
  const raw = JSON.stringify(response()).replace(
    '"id":"local"',
    '"index":1,"index":0,"id":"local"',
  );
  assert.throws(() => parseUniqueJson(raw), /duplicate/i);
});

test("invalid provider index does not reintroduce opaque secrets in failure receipts", () => {
  const marker = "SYNTHETIC_INDEX_SECRET_NO_ARCHIVE";
  for (const value of [marker, { access_token: marker }, [marker]]) {
    const r = response();
    r.choices[0].message.tool_calls[0].index = value;
    assert.throws(() => validateStrictResponseShape(r));
    assert(
      !captureStrictResponse(JSON.stringify(r)).publicJson.includes(marker),
    );
  }
});
