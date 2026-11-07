// A separate output-budget experiment. Never overwrite or pool the 4000-token
// cohort, and never replay an unknown call automatically inside product work.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {semanticModelConfig,callModel} from '../server/model.mjs';
import {digest} from '../server/evidence.mjs';
import {contentTree} from '../server/toolchain-tree.mjs';
import {semanticReview} from '../server/semantics.mjs';
import {validateSourceAudit,SOURCE_AUDIT_PROTOCOL} from '../server/source-audit.mjs';
import {blindSemanticInput,BLIND_PROMPT} from '../server/semantic-blind.mjs';
import {structuredReviewCall,recoveryConcerns} from '../server/structured-review.mjs';
const [configRoot,previous,out]=process.argv.slice(2);
await mkdir(out,{recursive:false});
const save=(name,r)=>writeFile(path.join(out,name),JSON.stringify(r,null,2),{flag:'wx'});
const prior=JSON.parse(await readFile(previous+'/audit-plan.json','utf8'));
// Reading the completed report enforces that the previous experiment finished.
const completed=JSON.parse(await readFile(previous+'/audit-report.json','utf8'));
if(!completed.implementationUnchanged)throw Error('Previous implementation drifted');
const implementation=await contentTree(process.cwd(),['server','shared']);
if(implementation.sha256!==prior.implementationHash||prior.prompt!==BLIND_PROMPT)throw Error('Not a budget-only experiment');
const config={...await semanticModelConfig(path.resolve(configRoot)),concurrency:1,timeoutMs:120000,maxOutputTokens:8000};
if(config.model!==prior.model.name||new URL(config.endpoint).host!==prior.model.endpointHost||config.reasoningEffort!==prior.model.reasoningEffort)
  throw Error('Model configuration changed');
await save('plan.json',{...prior,budget:{...prior.budget,outputTokens:8000},changedFactor:'outputTokens',
  previousBudget:prior.budget,previousPlanHash:digest(prior),scope:'separate_budget_diagnostic_not_pooled_with_prior_cohort'});
let calls=0;const rows=[];
async function invoke(c,req){const id=++calls;try{const r=await callModel(c,req);await save(`call-${id}.json`,r);return r;}
catch(e){await save(`call-${id}-failed.json`,{message:e.message,record:e.modelRecord||null});throw e;}}
for(const c of prior.dataset.cases){
  const before=calls,r={caseId:c.id,status:'unknown',cost:null};
  const paperSha256=digest(c.pages),contract={paperSha256,pageIndex:c.pageIndex,quote:c.quote,statement:c.quote,
    leanTarget:c.candidate,assumptions:[],imports:[],libraryProfile:'std-v1',targetHash:digest(c)};
  const context={paperSha256,selectedPage:c.pageIndex,pages:c.pages,supplements:[],omittedPages:[],semanticProtocol:SOURCE_AUDIT_PROTOCOL};
  console.log(JSON.stringify({caseId:c.id,budget:8000}));
  try{
    const result=await structuredReviewCall(invoke,config,{role:'R04',system:BLIND_PROMPT,input:blindSemanticInput(contract,context),maxTokens:8000},response=>{
      const review=semanticReview(contract,context,[],response,null),sourceAudit=validateSourceAudit(response.sourceAudit,contract,context);
      return {...review,sourceAudit,issues:[...review.issues,...sourceAudit.issues]};
    });
    r.review=result.value;r.attempts=result.attempts;
    // This measures only the blind stage. Missing translator alignment is
    // expected here; the product still requires the separate comparison stage.
    const unresolved=[...result.value.issues.filter(i=>i.code!=='alignment_missing'),...recoveryConcerns(result.attempts)];
    r.status=result.value.checks.some(c=>c.status==='concern')?'rejected':unresolved.length?'unknown':'accepted';
    r.productAcceptance='not_evaluated_blind_stage_only';
  }catch(e){r.status='error';r.error=e.message;r.attempts=e.structuredAttempts||[];}
  r.calls=calls-before;rows.push(r);await save(`case-${c.id}.json`,r);
}
const gold=JSON.parse(await readFile('evaluation/sets/source-semantics/evaluator-gold.json','utf8'));
if(gold.datasetHash!==prior.datasetHash)throw Error('Reference dataset changed');
const report={rows:rows.map(r=>({...r,reference:gold.labels.find(g=>g.caseId===r.caseId)})),calls,denominator:rows.length,
  counts:Object.fromEntries(['accepted','rejected','unknown','error'].map(s=>[s,rows.filter(r=>r.status===s).length])),
  implementationUnchanged:(await contentTree(process.cwd(),['server','shared'])).sha256===implementation.sha256,
  budget:8000,researchAccuracy:null,crossFamilyValidated:false,scope:'blind_stage_only_not_end_to_end_acceptance'};
report.falseAccepts=report.rows.filter(r=>r.status==='accepted'&&r.reference.expectation==='reject').length;
report.falseRejects=report.rows.filter(r=>r.status==='rejected'&&r.reference.expectation==='accept').length;
await save('report.json',report);console.log(JSON.stringify({out,calls,counts:report.counts}));
