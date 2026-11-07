import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../server/evidence.mjs';
import { controlledPlan, pairedSchedule, summarizeControlled } from '../server/controlled-evaluation.mjs';
const make=()=>controlledPlan({datasetHash:digest('data'),model:{name:'same',endpointHost:'example'},environmentHash:digest('env'),budget:{maxCallsPerCase:2,outputTokens:4000},implementationHash:digest('code'),factor:'prompt',arms:[{id:'before',value:'v1'},{id:'after',value:'v2'}],repetitions:2});
test('paired schedule balances order and retains missing and failed results in denominator',()=>{
 const p=make(),s=pairedSchedule(p,['a','b']);assert.deepEqual(s.slice(0,4).map(r=>r.arm),['before','after','after','before']);
 const report=summarizeControlled(p,['a','b'],[{...s[0],planHash:p.planHash,status:'error',calls:1,cost:null}]);
 assert.equal(report.rows.length,8);assert.equal(report.groups[0].counts.error,1);assert.equal(report.groups[0].counts.not_run,3);assert.equal(report.groups[0].cost,null);
});
test('changed budget, duplicate pairs, excess calls and undeclared arm factors are rejected',()=>{
 const p=make(),r={...pairedSchedule(p,['a'])[0],planHash:p.planHash,status:'accepted',calls:1};
 assert.throws(()=>summarizeControlled(p,['a'],[r,r]));
 assert.throws(()=>summarizeControlled(p,['a'],[{...r,calls:3}]));
 const edited=structuredClone(p);edited.budget.outputTokens=8000;assert.throws(()=>summarizeControlled(edited,['a'],[]),/改写/);
 assert.throws(()=>controlledPlan({...p,arms:[{id:'a',value:'v1',budget:999},{id:'b',value:'v2'}]}));
});
