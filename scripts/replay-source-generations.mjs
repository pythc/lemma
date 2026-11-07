import {mkdir,writeFile} from 'node:fs/promises';
import {EvidenceStore} from '../server/evidence.mjs';
import {replayOriginalProof} from '../server/original-proof.mjs';
const store=new EvidenceStore('.runtime/original-proof-20261019/store');await store.init();
const directory='evidence/original-proof-20261019/generation-replays';await mkdir(directory,{recursive:true});
const sources=[['bolzano-weierstrass','ad575b42-d11e-479d-a26b-d0513940a02e'],['yang-zhu','270eb3a5-6e59-4a4a-99de-a99b068ef774']];
const seen=new Set(), summaries=[];
for(const [name,id]of sources){
 const run=await store.getRun(id);
 for(const task of run.tasks.filter(t=>t.role==='R06_GRAPH'))for(const root of task.inputs){
  if(seen.has(root))continue;seen.add(root);const a=await store.get(root);
  if(a.kind!=='original_proof_report'||a.payload.targetHash!==run.contract.targetHash)continue;
  const file=`${directory}/${name}-generation-${a.payload.generation}`;
  const bundle=await store.bundle(root);await writeFile(`${file}-bundle.json`,JSON.stringify(bundle,null,2));
  const record={name,sourceRunId:id,root,generation:a.payload.generation,summary:a.payload.summary,scope:'historical_immutable_local_obligations_not_latest_route_closure',steps:a.payload.steps.map(s=>({name:s.name,title:s.title,status:s.status,targetHash:s.contract?.targetHash,artifact:s.artifact,anchors:s.anchors,routeAssessment:s.routeAssessment?.explanation}))};
  try{const replay=await replayOriginalProof(bundle,root);await writeFile(`${file}-replay.json`,JSON.stringify(replay,null,2));record.replay={reproduced:replay.reproduced,replayedChecks:replay.replayedChecks,uncheckedSteps:replay.uncheckedSteps,allStepsVerified:replay.allStepsVerified};}
  catch(e){record.replayError=e.message;}
  await writeFile(`${file}-summary.json`,JSON.stringify(record,null,2));summaries.push(record);console.log(JSON.stringify({name,generation:record.generation,replay:record.replay,error:record.replayError}));
 }
}
await writeFile(`${directory}/index.json`,JSON.stringify(summaries,null,2));
