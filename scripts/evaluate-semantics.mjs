// Two separately reported experiments: a single-factor comparison-prompt test,
// and source-audit diagnostics. No gold is loaded before dispatch completes.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callModel, semanticModelConfig } from '../server/model.mjs';
import { digest, sha256 } from '../server/evidence.mjs';
import { contentTree } from '../server/toolchain-tree.mjs';
import { controlledPlan, pairedSchedule, summarizeControlled } from '../server/controlled-evaluation.mjs';
import { BLIND_PROMPT, COMPARISON_PROMPT, blindSemanticInput } from '../server/semantic-blind.mjs';
import { semanticReview } from '../server/semantics.mjs';
import { structuredReviewCall, recoveryConcerns } from '../server/structured-review.mjs';
import { SOURCE_AUDIT_PROTOCOL, validateSourceAudit } from '../server/source-audit.mjs';
import { leanStatus } from '../server/lean.mjs';
const [configRoot,out,baselineDirectory,baselinePromptFile]=process.argv.slice(2);
if(!baselinePromptFile) throw Error('Usage: evaluate-semantics CONFIG_ROOT NEW_OUTPUT FIRST_CALL_DIRECTORY BASELINE_PROMPT_SOURCE');
await mkdir(out,{recursive:false});
const save=async(name,value)=>writeFile(path.join(out,name),JSON.stringify(value,null,2),{flag:'wx'});
const configured=await semanticModelConfig(path.resolve(configRoot));
if(!configured)throw Error('Local configuration missing');
const config={...configured,concurrency:1,timeoutMs:120000,maxOutputTokens:4000};
const implementation=await contentTree(process.cwd(),['server','shared']);
const environment=await leanStatus({verifyLibraries:true});
const baselineSource=await readFile(baselinePromptFile,'utf8');
const baselinePrompt=baselineSource.match(/export const COMPARISON_PROMPT = `([^`]+)`;/)?.[1];
if(!baselinePrompt)throw Error('Cannot locate archived prompt');
const inputs=[];
for(const number of [2,11,13]) {
  const raw=await readFile(path.join(baselineDirectory,`call-${number}.json`));
  const receipt=JSON.parse(raw), input=JSON.parse(receipt.record.request.messages.find(m=>m.role==='user').content);
  inputs.push({id:`archived-comparison-${number}`,input,sourceReceiptSha256:sha256(raw)});
}
const plan=controlledPlan({datasetHash:digest(inputs),model:{name:config.model,endpointHost:new URL(config.endpoint).host,
  reasoningEffort:config.reasoningEffort||null,temperature:0,revision:'provider_immutable_revision_not_reported'},
  environmentHash:digest(environment),implementationHash:implementation.sha256,
  budget:{maxCallsPerCase:2,outputTokens:4000,timeoutMs:120000,concurrency:1},factor:'prompt',
  arms:[{id:'baseline',value:baselinePrompt},{id:'explicit-schema',value:COMPARISON_PROMPT}],repetitions:2});
await save('plan.json',{plan,inputs,implementation,environment,baselinePromptSourceSha256:sha256(baselineSource),
  protocol:'comparison_only_with_identical_archived_blind_response_in_both_arms',secondFamily:'not_accepted'});
let calls=0;
async function invoke(configuration,request) {
  const number=++calls;
  try { const r=await callModel(configuration,request);await save(`call-${number}.json`,r);return r; }
  catch(e){await save(`call-${number}-failed.json`,{message:e.message,record:e.modelRecord||null});throw e;}
}
const status=(review)=>review.checks.some(c=>c.status==='concern')?'rejected':review.issues.length?'unknown':'accepted';
const paired=[];
for(const row of pairedSchedule(plan,inputs.map(c=>c.id))) {
  const c=inputs.find(c=>c.id===row.caseId),before=calls,started=Date.now();
  const r={...row,planHash:plan.planHash,status:'unknown',cost:null};
  console.log(JSON.stringify({phase:'paired',...row}));
  try {
    const contract={...c.input.contract,statement:c.input.contract.quote,assumptions:[]};
    const result=await structuredReviewCall(invoke,config,{role:'R04',system:plan.arms.find(a=>a.id===row.arm).value,input:c.input,maxTokens:4000},
      response=>semanticReview(contract,c.input.context,c.input.alignment,response,null));
    r.status=status(result.value);if(r.status==='accepted'&&recoveryConcerns(result.attempts).length)r.status='unknown';
    r.review=result.value;r.attempts=result.attempts;r.inputHash=result.inputHash;
  }catch(e){r.status=e.modelRecord?.error?.code?.includes('TIMEOUT')?'timeout':'error';r.error=e.message;r.attempts=e.structuredAttempts||[];}
  r.calls=calls-before;r.elapsedMs=Date.now()-started;paired.push(r);await save(`paired-${row.sequence}.json`,r);
}
await save('paired-report.json',summarizeControlled(plan,inputs.map(c=>c.id),paired));
const dataset=JSON.parse(await readFile('evaluation/sets/source-semantics/inputs.json','utf8'));
await save('audit-plan.json',{dataset,datasetHash:digest(dataset),implementationHash:implementation.sha256,
  model:plan.model,budget:plan.budget,prompt:BLIND_PROMPT,secondFamily:'not_accepted',repeatCount:1});
const auditRows=[];
for(const c of dataset.cases) {
  const before=calls,started=Date.now(),r={caseId:c.id,status:'unknown',cost:null};
  const paperSha256=digest(c.pages),contract={paperSha256,pageIndex:c.pageIndex,quote:c.quote,statement:c.quote,
    leanTarget:c.candidate,assumptions:[],imports:[],libraryProfile:'std-v1',targetHash:digest(c)};
  const context={paperSha256,selectedPage:c.pageIndex,pages:c.pages,supplements:[],omittedPages:[],semanticProtocol:SOURCE_AUDIT_PROTOCOL};
  console.log(JSON.stringify({phase:'source-audit',caseId:c.id}));
  try {
    const result=await structuredReviewCall(invoke,config,{role:'R04',system:BLIND_PROMPT,input:blindSemanticInput(contract,context),maxTokens:4000},response=>{
      const review=semanticReview(contract,context,[],response,null),sourceAudit=validateSourceAudit(response.sourceAudit,contract,context);
      return {...review,sourceAudit,issues:[...review.issues,...sourceAudit.issues]};
    });
    r.review=result.value;r.attempts=result.attempts;
    r.status=status({...result.value,issues:result.value.issues.filter(i=>i.code!=='alignment_missing')});
    r.productAcceptance='not_evaluated_blind_stage_only';r.nativeTypeChecked=false;
    if(r.status==='accepted'&&recoveryConcerns(result.attempts).length)r.status='unknown';
    r.originalTargetUnchanged=result.value.targetHash===contract.targetHash;
  }catch(e){r.status=e.modelRecord?.error?.code?.includes('TIMEOUT')?'timeout':'error';r.error=e.message;r.attempts=e.structuredAttempts||[];}
  r.calls=calls-before;r.elapsedMs=Date.now()-started;auditRows.push(r);await save(`audit-${c.id}.json`,r);
}
const gold=JSON.parse(await readFile('evaluation/sets/source-semantics/evaluator-gold.json','utf8'));
if(gold.datasetHash!==digest(dataset))throw Error('Evaluator dataset changed');
const rows=auditRows.map(r=>({...r,reference:gold.labels.find(g=>g.caseId===r.caseId)}));
const after=await contentTree(process.cwd(),['server','shared']);
await save('audit-report.json',{rows,calls,denominator:dataset.cases.length,
  counts:Object.fromEntries(['accepted','rejected','unknown','error','timeout'].map(s=>[s,rows.filter(r=>r.status===s).length])),
  falseAccepts:rows.filter(r=>r.status==='accepted'&&r.reference.expectation==='reject').length,
  falseRejects:rows.filter(r=>r.status==='rejected'&&r.reference.expectation==='accept').length,
  implementationUnchanged:after.sha256===implementation.sha256,researchAccuracy:null,crossFamilyValidated:false,
  caveat:'Authored development diagnostics, no independent gold; repeated provider calls do not prove independent model families.'});
console.log(JSON.stringify({out,calls,implementationUnchanged:after.sha256===implementation.sha256}));
