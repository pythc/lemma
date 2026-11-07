import test from "node:test";
import assert from "node:assert/strict";
import { parseUniqueJson } from "../server/unique-json.mjs";
import { captureStrictResponse } from "../server/strict-response.mjs";

for (const [name, text] of [
  ["root", '{"findings":["concern"],"findings":[]}'],
  ["nested", '{"checks":[{"status":"concern","status":"aligned"}]}'],
  ["escaped", '{"findings":[1],"find\\u0069ngs":[]}'],
  ["surrogate", '{"😀":1,"\\ud83d\\ude00":2}'],
  ["array", '[{"x":1,"x":2}]'],
  ["proto", '{"__proto__":1,"__proto__":2}'],
])
  test(
    "duplicate JSON keys rejected before ordinary object parsing: " + name,
    () => assert.throws(() => parseUniqueJson(text), /Duplicate JSON/),
  );

test("same keys in separate objects and valid mathematical strings are preserved exactly", () => {
  const text =
    '{"a":{"x":1},"b":{"x":2},"text":"∀ n : ℕ, n = n; \\"findings\\": []","unicode":"α😀","escape":"\\u03b1"}';
  assert.deepEqual(parseUniqueJson(text), JSON.parse(text));
  assert.deepEqual(parseUniqueJson('{"x":1,"X":2}'), { x: 1, X: 2 });
  assert.equal(parseUniqueJson('{"__proto__":1}').__proto__, 1);
});
for (const text of [
  "",
  '{"x":1,}',
  '{/*x*/"x":1}',
  '{"x":1}{}',
  "```json\n{}\n```",
  '{"x":NaN}',
])
  test(
    "strict parser does not accept JSONC recovery " + JSON.stringify(text),
    () => assert.throws(() => parseUniqueJson(text)),
  );

test("public response capture preserves conflict variants and hashes all private token ranges", () => {
  const secret = "provider-private-reasoning-should-never-be-archived";
  const raw = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "public doubt" }],
          reasoning_content: secret,
          tool_calls: [],
        },
      },
      {
        message: {
          role: "assistant",
          content: "second public doubt",
          reasoning_content: secret,
        },
      },
    ],
  });
  const receipt = captureStrictResponse(raw, "dummy-credential");
  assert(!JSON.stringify(receipt).includes(secret));
  assert(receipt.publicJson.includes("public doubt"));
  assert(receipt.publicJson.includes("second public doubt"));
  assert.equal(receipt.privateFields.length, 2);
  const escaped =
    '{"choices":[],"reasoning_content":"' +
    secret +
    '","reasoning_\\u0063ontent":"' +
    secret +
    '"}';
  const masked = captureStrictResponse(escaped, "dummy-credential");
  assert(!JSON.stringify(masked).includes(secret));
  assert.equal(masked.privateFields.length, 2);
  assert.throws(() => parseUniqueJson(masked.publicJson), /Duplicate JSON/);
  const privateChannel = captureStrictResponse(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", channel: "analysis", content: secret },
        },
      ],
    }),
  );
  assert(!JSON.stringify(privateChannel).includes(secret));
});
