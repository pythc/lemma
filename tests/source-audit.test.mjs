import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../server/evidence.mjs";
import { validateSourceAudit, SOURCE_AUDIT_PROTOCOL, BOUNDARY_KINDS } from "../server/source-audit.mjs";
import { validateResolutions } from "../server/semantics.mjs";
const a=(pageIndex,quote)=>({pageIndex,quote});
const source='For each n there is C such that n < C.';
const context={paperSha256:digest('paper'),pages:[{pageIndex:0,text:'In section one C denotes a fixed bound. End of section one.'},{pageIndex:1,text:'In section two C depends on n. '+source}],supplements:[],omittedPages:[],semanticProtocol:SOURCE_AUDIT_PROTOCOL};
const contract={paperSha256:context.paperSha256,targetHash:digest('target'),pageIndex:1,quote:source,leanTarget:'∀ n : ℝ, ∃ C : ℝ, n < C'};
const raw=()=>({coverage:{status:'complete',anchors:[a(1,source)]},bindings:[],uses:[],quantifiers:[
 {variable:'n',kind:'forall',dependsOn:[],anchor:a(1,'For each n'),leanFragment:'∀ n : ℝ'},
 {variable:'C',kind:'exists',dependsOn:['n'],anchor:a(1,'there is C'),leanFragment:'∃ C : ℝ'}],
 boundaries:BOUNDARY_KINDS.map(kind=>({kind,status:'matched',explanation:'Explicit engineering fixture comparison.',anchors:[a(1,source)]})),
 fidelity:{status:'preserved',explanation:'Exact quantifier order.',anchors:[a(1,source)]},missing:[],corrections:[]});
test('distinct scoped definitions keep distinct identities and reject wrong-section use',()=>{
 const v=raw();v.bindings=[{key:'C1',symbol:'C',kind:'definition',anchor:a(0,'C denotes a fixed bound'),scope:{start:a(0,'In section one'),end:a(0,'End of section one.')}},
 {key:'C2',symbol:'C',kind:'definition',anchor:a(1,'C depends on n'),scope:{start:a(1,'In section two'),end:a(1,source)}}];
 v.uses=[{binding:'C2',relation:'uses_definition',anchor:a(1,'there is C')}];
 let result=validateSourceAudit(v,contract,context);assert.equal(result.issues.length,0);assert.notEqual(result.bindings[0].id,result.bindings[1].id);
 v.uses[0].binding='C1';result=validateSourceAudit(v,contract,context);assert(result.issues.some(i=>i.code==='binding_out_of_scope'));
});
test('reversed quantifiers, missing source and forged fragments cannot pass by confirmation',()=>{
 const v=raw();v.quantifiers.reverse();v.missing=[{symbol:'finite dimension',reason:'Not stated in source.',anchors:[a(1,source)]}];
 const result=validateSourceAudit(v,contract,context);
 assert(result.issues.some(i=>i.code==='quantifier_order_or_kind_changed'));
 assert.throws(()=>validateResolutions({issues:result.issues},[]),/原文/);
 v.quantifiers[0].leanFragment='∃ C : Nat';assert.throws(()=>validateSourceAudit(v,contract,context),/固定目标/);
});
test('false source can remain faithful; corrections have a separate unapproved identity',()=>{
 const c={...contract,quote:'Every real x has x squared strictly positive.',leanTarget:'∀ x : ℝ, 0 < x ^ 2'};
 const ctx={...context,pages:[{pageIndex:1,text:c.quote}]};
 const v=raw();v.coverage.anchors=[a(1,c.quote)];v.quantifiers=[{variable:'x',kind:'forall',dependsOn:[],anchor:a(1,c.quote),leanFragment:'∀ x : ℝ'}];
 v.boundaries=v.boundaries.map(b=>({...b,anchors:[a(1,c.quote)]}));v.fidelity.anchors=[a(1,c.quote)];
 v.corrections=[{statement:'Nonnegative instead of positive.',leanTarget:'∀ x : ℝ, 0 ≤ x ^ 2',reason:'Zero is a counterexample.',anchors:[a(1,c.quote)]}];
 const checked=validateSourceAudit(v,c,ctx);assert.equal(checked.fidelity.status,'preserved');assert.equal(checked.issues.length,0);
 assert.equal(checked.corrections[0].parentTargetHash,c.targetHash);assert.equal(checked.corrections[0].proofAcceptance,'none_new_contract_required');assert.equal(c.leanTarget,'∀ x : ℝ, 0 < x ^ 2');
});
test('invented native certification and missing boundary categories are refused',()=>{
 const v=raw();v.boundaries[0].status='verified';assert.throws(()=>validateSourceAudit(v,contract,context),/边界/);
 v.boundaries=[];assert.throws(()=>validateSourceAudit(v,contract,context),/完整/);
});
