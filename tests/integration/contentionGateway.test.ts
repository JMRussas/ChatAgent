import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { startGateway } from '../../experiments/doc-agent/contention_gateway';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean) {
  for (let n=0;n<200;n++) { if(check())return; await sleep(5); }
  throw Error('test condition timed out');
}
async function setup(timeout=2000) {
  const server = createServer(async (req,res) => {
    let raw='';for await(const c of req)raw+=c;
    const { model } = JSON.parse(raw);
    if(model==='fail'){res.writeHead(503);res.end('{}');return;}
    res.writeHead(200, {'Content-Type':'application/x-ndjson'});
    if(model==='hang') { res.flushHeaders(); return; }
    const frames=[
      {message:{content:'',thinking:'do not record'},done:false},
      {message:{content:'',tool_calls:[{function:{name:'search',arguments:{}}}]},done:false},
      {message:{content:'hello'},done:false},
      {message:{content:''},done:true,done_reason:'stop',eval_count:1,total_duration:123},
    ];
    if(model==='tool-only')frames.splice(2,1);
    const body=frames.map(f=>JSON.stringify(f)+'\n').join('');
    res.write(body.slice(0,17)); await sleep(10); res.end(model==='truncated'?body.slice(17,body.lastIndexOf('{"message"')):body.slice(17));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const gateway=await startGateway(`http://127.0.0.1:${(server.address() as {port:number}).port}`,'foreground-priority',timeout);
  cleanups.push(gateway.close);
  const request=(model:string,signal?:AbortSignal)=>fetch(gateway.url+'/foreground/test/api/chat',{method:'POST',body:JSON.stringify({model,stream:true}),signal});
  return {gateway,request};
}
it('measures answer separately from thinking/tools, handles split frames, records only timing and usage', async()=>{
  const {gateway,request}=await setup();const body=await(await request('ok')).text();
  expect(body).toContain('hello');
  const r=gateway.records[0];expect(r.outcome).toBe('completed');
  expect(r.firstAnswerMs).toBeGreaterThanOrEqual(r.firstToolMs!);
  expect(r.firstAnswerMs).toBeGreaterThanOrEqual(r.admittedMs!);
  expect(r.finishedMs).toBeGreaterThanOrEqual(r.firstAnswerMs!);
  expect(r.usage).toEqual({eval_count:1,total_duration:123});
  expect(JSON.stringify(r)).not.toMatch(/hello|do not record|arguments/);
});
it('releases admission after HTTP failure and truncated streams', async()=>{
  const {gateway,request}=await setup();expect((await request('fail')).status).toBe(503);
  await(await request('truncated')).text().catch(()=>{});
  await(await request('ok')).text();
  expect(gateway.records.map(r=>r.outcome)).toEqual(['http_error','MISSING_DONE','completed']);
});
it('cancels a queued call without dispatch and recovers after active cancellation', async()=>{
  const {gateway,request}=await setup();const active=new AbortController(), queued=new AbortController();
  const first=request('hang',active.signal).then(r=>r.text()).catch(()=>{});
  await until(()=>gateway.records[0]?.admittedMs!==undefined);
  const second=request('ok',queued.signal).then(r=>r.text()).catch(()=>{});
  await until(()=>gateway.records.length===2 && gateway.records[1].readyMs!==undefined);
  queued.abort();await second;await until(()=>gateway.records[1].finishedMs!==undefined);
  expect(gateway.records[1].admittedMs).toBeUndefined();
  expect(gateway.records[1].outcome).toBe('CLIENT_CANCELLED');
  active.abort();await first;await until(()=>gateway.records[0].finishedMs!==undefined);
  await(await request('ok')).text();expect(gateway.records[2].outcome).toBe('completed');
});
it('includes queued time in deadline and frees a stalled slot',async()=>{
  const {gateway,request}=await setup(100);
  await request('hang').then(r=>r.text()).catch(()=>{});
  await until(()=>gateway.records[0].finishedMs!==undefined);
  expect(gateway.records[0].outcome).toBe('DEADLINE');
  await(await request('ok')).text();expect(gateway.records[1].outcome).toBe('completed');
});
it('leaves first answer absent for tool-only calls and sanitizes parser failures', async()=>{
  const {gateway,request}=await setup();
  await(await request('tool-only')).text();
  expect(gateway.records[0].firstAnswerLatencyMs).toBeUndefined();
  expect(gateway.records[0].firstToolMs).toBeDefined();
  const response=await fetch(gateway.url+'/foreground/test/api/chat',{method:'POST',body:'{"secret":"DO_NOT_LOG'});
  await response.text();expect(response.status).toBe(502);
  expect(gateway.records[1].outcome).toBe('GATEWAY_ERROR');
  expect(JSON.stringify(gateway.records)).not.toContain('DO_NOT_LOG');
});
