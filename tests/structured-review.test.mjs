import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callModel } from "./controlled-model-receipt.mjs";
import { structuredReviewCall, recoveryConcerns, validateStructuredAttempts } from "../server/structured-review.mjs";

async function fixture(t, responses) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const b of req) body += b;
    requests.push(JSON.parse(body));
    const answer = responses[Math.min(requests.length - 1, responses.length - 1)];
    if (answer === "disconnect") { res.destroy(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ finish_reason: answer.finish || "stop", message: { content: JSON.stringify(answer.value) } }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  return { requests, config: { endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: "fixture",
    key: "LOCAL_HTTP_SECRET_947625", timeoutMs: 3000, concurrency: 1 } };
}
const request = { role: "R04", system: "Return status aligned, concern or unresolved.", input: { target: "∀ x : ℝ, x = x", source: "each x equals itself" }, maxTokens: 1000 };
const validate = (r) => { if (!['aligned','concern','unresolved'].includes(r.status)) throw Error("status enum invalid"); return r; };
test("real HTTP schema retry preserves original input and failed receipt and charges both attempts", async (t) => {
  const f = await fixture(t, [{value:{status:'mismatch'}},{value:{status:'concern'}}]); let charged=0;
  const r=await structuredReviewCall(callModel,f.config,request,validate,{reserve:async()=>{charged++;}});
  assert.equal(charged,2); assert.equal(r.attempts[0].response.status,'mismatch');
  assert.deepEqual(f.requests.map((x)=>JSON.parse(x.messages[1].content)),[request.input,request.input]);
  validateStructuredAttempts(r.attempts,request.input,r.parsed,r.record);
  const changed=structuredClone(r.attempts);changed[0].model.request.messages[1].content='{"target":"True"}';
  assert.throws(()=>validateStructuredAttempts(changed,request.input,r.parsed,r.record),/改变/);
});
test("truncation and unknown transport each dispatch once, never auto-replay", async(t)=>{
  for(const responses of [[{finish:'length',value:{status:'aligned'}}],['disconnect']]) {
    const f=await fixture(t,responses);
    await assert.rejects(structuredReviewCall(callModel,f.config,request,validate),e=>e.structuredAttempts.length===1);
    assert.equal(f.requests.length,1);
  }
});
test("budget or cancellation prevents the second request and retains the first failure", async(t)=>{
  const f=await fixture(t,[{value:{status:'mismatch'}}]);let reserved=0;
  await assert.rejects(structuredReviewCall(callModel,f.config,request,validate,{reserve:async()=>{if(++reserved>1)throw Error('budget');}}),e=>e.message==='budget'&&e.structuredAttempts.length===2);
  assert.equal(f.requests.length,1);
  const controller=new AbortController();controller.abort();
  await assert.rejects(structuredReviewCall(callModel,f.config,{...request,signal:controller.signal},validate));
  assert.equal(f.requests.length,1);
});
test("schema recovery cannot erase concerns in an earlier complete response",()=>{
  const issues=recoveryConcerns([{outcome:'schema_rejected',response:{checks:[{category:'conclusion',status:'mismatch'}]}}]);
  assert.equal(issues.length,1);assert.equal(issues[0].sourceEvidenceRequired,true);
  const source=recoveryConcerns([{outcome:'schema_rejected',response:{sourceAudit:{coverage:{status:'complete'},fidelity:{status:'changed'},missing:[],boundaries:[]}}}]);
  assert.equal(source.length,1);assert.equal(source[0].sourceEvidenceRequired,true);
  const malformed=recoveryConcerns([{outcome:'schema_rejected',response:{checks:[null,17],sourceAudit:{coverage:{status:'complete'},fidelity:{status:'preserved'},missing:[],boundaries:{some:'invalid'}}}}]);
  assert.equal(malformed.length,3);assert(malformed.every(i=>i.sourceEvidenceRequired));
});
test("optional undefined fields match wire JSON and receipt failure never retries",async(t)=>{
  const f=await fixture(t,[{value:{status:'aligned'}}]);
  const optional={...request,input:{...request.input,typeInspection:{stderr:undefined,stdout:''}}};
  const r=await structuredReviewCall(callModel,f.config,optional,validate);
  assert.equal(r.attempts.length,1);
  validateStructuredAttempts(r.attempts,optional.input,r.parsed,r.record);
  await assert.rejects(structuredReviewCall(callModel,f.config,optional,validate,{onAttempt:async()=>{throw Error('disk failure');}}),e=>e.message==='disk failure'&&e.structuredAttempts.length===1&&e.structuredAttempts[0].outcome==='validated');
  assert.equal(f.requests.length,2);
});
