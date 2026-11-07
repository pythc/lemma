import assert from "node:assert/strict";
import { auditBodyFixture } from "./source-audit-fixture.mjs";
import { ANCHORED_AUDIT_PROTOCOL } from "../server/audit-wire.mjs";
import {
  strictAuditTool,
  AUDIT_SUBMISSION_TOOL,
} from "../server/strict-audit.mjs";

// Explicit controlled provider data, never a product recovery function.
export function strictBodyFixture(canonical, comparison = false) {
  const body = auditBodyFixture(canonical, ANCHORED_AUDIT_PROTOCOL);
  return {
    ...body,
    findings: body.findings.map((f) => ({
      ...f,
      changeWitness: f.changeWitness ? [f.changeWitness] : [],
    })),
    ...(!comparison ? { probes: body.probes || [] } : {}),
  };
}
export function assertStrictRequest(request, input) {
  assert.deepEqual(request.tools, [strictAuditTool(input)]);
  assert.equal(request.tool_choice, "required");
  assert.deepEqual(request.thinking, { type: "disabled" });
  assert.equal(request.response_format, undefined);
  assert.equal(request.messages.length, 2);
  assert.equal(request.messages[0].role, "system");
  assert.equal(request.messages[1].role, "user");
}
export function strictMessageFixture(
  body,
  id = "controlled-semantic-submission",
) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: {
          name: AUDIT_SUBMISSION_TOOL,
          arguments: JSON.stringify(body),
        },
      },
    ],
  };
}
