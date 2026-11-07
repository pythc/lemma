import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile,open} from 'node:fs/promises';
import path from 'node:path';
import {PDFDocument,StandardFonts} from 'pdf-lib';

test('raw PDF evaluator instrumentation retains the production SDK and archives its HTTP outage', {timeout:180000}, async()=>{
  const base=path.resolve(process.env.LEMMA_TEST_EVIDENCE_DIR||'evidence/raw-evaluator-native');
  await mkdir(base,{recursive:true});
  const dir=await mkdtemp(path.join(base,'runner-'));
  const text='For every natural number n, n equals n.';
  const pdf=await PDFDocument.create();
  pdf.addPage().drawText(text,{x:30,y:700,size:10,font:await pdf.embedFont(StandardFonts.TimesRoman)});
  await writeFile(path.join(dir,'input.pdf'),await pdf.save());
  const wires=[];
  const errors=[];
  const provider=createServer(async(req,res)=>{
    try {
      let raw='';for await(const b of req)raw+=b;
      const body=JSON.parse(raw);
      let system=body.messages.find(m=>m.role==='system').content;
      let input=JSON.parse(body.messages.find(m=>m.role==='user').content);
      const sdk=typeof input.goal==='string';
      if(sdk){const boundary=input.goal.lastIndexOf('\n{');system=input.goal.slice(0,boundary);input=JSON.parse(input.goal.slice(boundary+1));}
      const role=system.startsWith('你是数学论文原文理解 Agent')?'read':
        system.startsWith('你是形式化环境选择 Agent')?'environment':
        system.startsWith('你是数学论文评审协调 Agent')?'coordinate':
        system.startsWith('定位片段不是完整命题')?'scope':
        system.startsWith('你负责 R03 命题语义')?'translation':input.scope?'scopeReview':'unexpected';
      wires.push({role,sdk,tools:body.tools?.map(t=>t.function.name)||[]});
      await writeFile(path.join(dir,`wire-${wires.length}.json`),JSON.stringify(body,null,2),{flag:'wx'});
      let parsed;
      if(role==='read')parsed={summary:'Controlled runner wiring fixture.',claims:[{label:'Q',pageIndex:0,quote:text,statement:text}]};
      else if(role==='environment')parsed={summary:'Use standard naturals.',choices:input.paperMap.claims.map(c=>({claimId:c.id,profile:'std-v1',reason:'Standard naturals',queries:[],names:['Nat']}))};
      else if(role==='coordinate')parsed={mode:'act',reason:'Exercise actual runner.',actions:[{kind:'formalize',claimId:input.claims[0].id,title:'Formalize Q',question:'Check exact source.',reason:'Controlled entry.',strategy:'First attempt.',basedOn:input.tasks.filter(t=>t.kind==='read'||t.kind==='environment').map(t=>t.id)}]};
      else if(role==='scope')parsed={spans:[{pageIndex:0,quote:text}],premises:[],conclusion:[{pageIndex:0,quote:text}],explanation:'Complete proposition.'};
      else if(role==='scopeReview')parsed={scopeHash:input.scope.scopeHash,decision:'complete',explanation:'Entire proposition selected.',anchors:[{pageIndex:0,quote:text}]};
      else if(role==='translation'){
        assert.equal(sdk,true,'The evaluator must not bypass Deep Agents');
        assert(body.tools.some(t=>t.function.parameters?.properties?.alignment),'Typed submission tool missing');
        res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"intentional controlled stop after SDK entry"}');return;
      }else throw Error('Unexpected controlled stage: '+system.slice(0,120));
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:'local-controlled-provider',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(parsed)}}]}));
    }catch(error){errors.push(error.message);res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  const log=await open(path.join(dir,'process.log'),'wx');
  try{
    const child=spawn(process.execPath,['scripts/evaluate-autonomous-paper.mjs',path.join(dir,'input.pdf'),path.join(dir,'run'),'Choose one claim and check its source and proof.','--max-model-calls=12','--max-run-minutes=4','--fifth-stage-profile'],{
      env:{...process.env,LEMMA_EVALUATION_CONFIG_ROOT:dir,LEMMA_MODEL_BASE_URL:`http://127.0.0.1:${provider.address().port}/v1`,LEMMA_MODEL:'controlled-raw-runner',LEMMA_MODEL_API_KEY:'local-fixture'},stdio:['ignore',log.fd,log.fd]
    });
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    assert.equal(code,0);
    assert.deepEqual(errors,[]);
    assert.equal(wires.filter(w=>w.role==='translation').length,1);
    assert(wires.some(w=>w.role==='scope'&&w.sdk));
    const result=JSON.parse(await readFile(path.join(dir,'run/result.json')));
    const run=JSON.parse(await readFile(path.join(dir,'run/run.json')));
    assert.equal(run.conclusion?.reviewComplete,false);
    // A 503 response is received, but the provider-side generation outcome is
    // conservatively unknown. It must never trigger an automatic retry.
    assert.equal(run.infrastructureFailure?.code,'model_http_error');
    assert.equal(run.infrastructureFailure?.outcome,'unknown');
    assert(wires.at(-1).role==='translation','No model dispatch after the outage');
    assert(result.executionFootprint.artifactCounts['harness:model']>0);
    assert.deepEqual(result.implementationChangedDuringRun,[]);
    await writeFile(path.join(dir,'result.json'),JSON.stringify({passed:true,wires,resultStatus:result.status},null,2),{flag:'wx'});
  }finally{
    await log.close();provider.closeAllConnections();await new Promise(r=>provider.close(r));
    await writeFile(path.join(dir,'wire-summary.json'),JSON.stringify({wires,errors},null,2),{flag:'wx'});
  }
});
