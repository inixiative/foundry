import {test,expect} from 'bun:test';
import {mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {liveWatchFixture,until} from './helpers/live-watch-fixture';
import {StreamBufferRegistry} from '../src/viewer/stream-buffer';
// Browser modules are intentionally native JS, exercised by the same tests and app.
// @ts-expect-error no declaration for browser JS
import {applyTurnFrame,mergeLiveSnapshot,liveThreadStatus} from '../src/viewer/ui/live-state.js';
// @ts-expect-error native browser JS
import {failurePresentation} from '../src/viewer/ui/inspector-data.js';

test('streamed send: accepted before text, owned activity separate from final, terminal retained',async()=>{
 const dir=await mkdtemp(resolve('.foundry/qa/lw-source-'));const f=await liveWatchFixture(dir);
 try {const turn=f.send('external');expect((await turn.response).status).toBe(202);await until(()=>f.attempts.length===1,'admission');
   let state=await f.snapshot();expect(state.turns[0].status).toBe('running');expect(state.turns[0].messageId).toBe('external');
   const a=f.attempts[0];a.emit({kind:'text',itemId:'progress',text:'PUBLIC_PROGRESS'});a.emit({kind:'thinking',text:'PRIVATE_REASONING'});
   a.emit({kind:'tool_use',callId:'call-1',toolName:'Bash',toolInput:{command:'controlled'}});
   await until(async()=>JSON.stringify(await f.snapshot()).includes('PUBLIC_PROGRESS'),'owned progress');state=await f.snapshot();
   expect(state.turns[0].content).toBe('');expect(JSON.stringify(state)).not.toContain('PRIVATE_REASONING');expect(state.turns[0].activity.some((x:any)=>x.toolName==='Bash')).toBe(true);
   // The sender's own open stream carried the same activity as it happened, never the private reasoning.
   const live=turn.client.data(`thread:${f.thread.id}`);
   expect(live.some(x=>x.payload.kind==='activity'&&x.payload.row.text==='PUBLIC_PROGRESS')).toBe(true);expect(JSON.stringify(live)).not.toContain('PRIVATE_REASONING');
   a.finish();expect((await turn.done).type).toBe('done');state=await f.snapshot();expect(state.turns[0].status).toBe('completed');expect(state.turns[0].content).toBe('FINAL_ONLY');
   expect(f.viewer.streams.turns.get('external')?.unresolved).toBe(false);
   expect(f.viewer.localStore!.nativeHistory(f.thread.id,'external').some(e=>e.kind==='tool_use')).toBe(true);expect(f.attempts).toHaveLength(1);
 }finally {await f.close();console.log(`Live watch evidence: ${dir}`);}
});

test('public Codex/Claude forms, exact original isolation, duplicate snapshots and terminal failure',async()=>{
 const dir=await mkdtemp(resolve('.foundry/qa/lw-source-'));const f=await liveWatchFixture(dir);
 try {const turn=f.send('events');await turn.response;await until(()=>f.attempts.length===1,'admission');const a=f.attempts[0];
   a.emit({kind:'text_delta',itemId:'answer',text:'Hello '});a.emit({kind:'text_delta',itemId:'answer',text:'world'});
   a.emit({kind:'text',itemId:'answer',text:'Hello world'});a.emit({kind:'text',itemId:'answer',text:'Hello world'});
   a.emit({kind:'text',itemId:'foreign',text:'FOREIGN',owner:{threadId:'other'}});
   a.emit({kind:'text',itemId:'foreign-native',text:'FOREIGN_NATIVE',turnId:'wrong-turn'});
   a.emit({kind:'text',itemId:'unregistered',text:'UNREGISTERED',admissionId:'wrong-admission'});
   a.emit({kind:'text',itemId:'private',text:'PRIVATE_REASONING',raw:{reasoning:'not forwarded'},correlation:'unknown'});
   a.emit({kind:'tool_use',itemId:'tool-item',toolName:'foundry_query',toolInput:{query:'public',authorization:'SECRET'}});
   a.emit({kind:'tool_result',itemId:'tool-item',toolName:'foundry_query',toolOutput:'PUBLIC_RESULT',toolError:true});
   a.emit({kind:'tool_use',itemId:'tool-item',toolName:'foundry_query'});
   const snapshot=await f.snapshot(),body=JSON.stringify(snapshot);expect(snapshot.turns[0].activity.filter((x:any)=>x.kind==='text')).toHaveLength(1);
   expect(body).toContain('Hello world');for(const marker of ['FOREIGN','UNREGISTERED','PRIVATE_REASONING','SECRET'])expect(body).not.toContain(marker);
   expect(snapshot.turns[0].activity.find((x:any)=>x.kind==='tool').state).toBe('failed');
   // Replaying the appends a viewer received reproduces the server's snapshot.
   const frames=turn.client.data(`thread:${f.thread.id}`).filter(x=>x.action==='snapshot'||['turn','delta','activity'].includes(x.payload.kind));
   const replayed=frames.reduce((turns:any,frame:any)=>applyTurnFrame(turns,frame),new Map()).get('events');
   expect(replayed.activity).toEqual(snapshot.turns[0].activity);expect(replayed.content).toBe(snapshot.turns[0].content);
   for(const marker of ['FOREIGN','UNREGISTERED','PRIVATE_REASONING','SECRET'])expect(JSON.stringify(frames)).not.toContain(marker);
   // Scoped: the other thread's stream knows nothing of this turn.
   expect((await f.snapshot('watch-B')).turns).toHaveLength(0);
   a.finish(true);expect((await turn.done).type).toBe('error');const final=await f.snapshot();expect(final.turns[0].status).toBe('failed');expect(final.turns[0].terminal.meta.nativeOutcome).toBe('failed');
   a.emit({kind:'text',text:'LATE_REWRITE'});expect(JSON.stringify(await f.snapshot())).not.toContain('LATE_REWRITE');expect(f.attempts).toHaveLength(1);
 }finally{await f.close();}
});

test('completed but write failed stays visible without replay',async()=>{
 const dir=await mkdtemp(resolve('.foundry/qa/lw-source-'));const f=await liveWatchFixture(dir);
 try{const turn=f.send('unsaved');await turn.response;await until(()=>f.attempts.length===1,'admission');
   (f.viewer.localStore as any).db.exec("CREATE TRIGGER reject_result BEFORE INSERT ON session_messages WHEN NEW.actor = 'agent' BEGIN SELECT RAISE(ABORT, 'controlled-write-failure'); END;");
   f.attempts[0].finish();const body=await turn.done;expect(JSON.stringify(body)).toContain('FINAL_ONLY');expect(body.meta.persistence).toBe('failed');
   const state=await f.snapshot();expect(state.turns[0].status).toBe('completed');expect(state.turns[0].terminal.meta.persistence).toBe('failed');expect(state.turns[0].content).toBe('FINAL_ONLY');expect(f.attempts).toHaveLength(1);
 }finally{await f.close();}
});

test('merging live turns preserves unsaved and durable terminal evidence',()=>{
 const registry=new StreamBufferRegistry(),b=registry.open('one','T','P');b.append('partial');
 const snapshot=()=>({buffers:registry.forThread('T')});
 const first=snapshot();b.complete({content:'answer',meta:{persistence:'committed',turnStatus:'completed',executionOutcome:'completed'}});const final=snapshot();
 const prior=[{actor:'agent',turnId:'one',content:'answer',meta:{persistence:'committed',turnStatus:'completed',browserFailureEvidence:{partialOutput:'saved only here'}}}];
 const merged=mergeLiveSnapshot(prior,final);expect(merged).toHaveLength(1);expect(merged[0].meta.browserFailureEvidence).toEqual({partialOutput:'saved only here'});
 expect(mergeLiveSnapshot(merged,first)[0].streaming).not.toBe(true);expect(mergeLiveSnapshot(merged,final)[0].content).toBe('answer');
 const partial=mergeLiveSnapshot([],first);expect(mergeLiveSnapshot(partial,{buffers:[]})[0].connectionStatus).toBe('unconfirmed');
});

test('bounded buffer admission, activity and terminal projection do not expose private metadata',()=>{
 const r=new StreamBufferRegistry(),b=r.open('T1','T','P');const owner={threadId:'T',projectId:'P',messageId:'T1',dispatchId:'D',generation:'G',providerSessionKey:'T'};
 b.register({schema:1,owner,admissionId:'A',nativeOutcome:'unknown'});
 for(let i=0;i<80;i++)b.observe({schema:1,owner,admissionId:'A',nativeOutcome:'unknown',kind:'text',itemId:String(i),text:'x'.repeat(5000)});
 expect(b.snapshot().activity).toHaveLength(64);expect(b.snapshot().truncated).toBe(true);
 b.complete({content:'answer',meta:{persistence:'failed',private:'PRIVATE',injection:{secret:'SECRET'}}});expect(JSON.stringify(b.snapshot())).not.toContain('PRIVATE');expect(JSON.stringify(b.snapshot())).not.toContain('SECRET');
 b.observe({schema:1,owner,admissionId:'A',nativeOutcome:'completed',rpcOutcome:'resolved',kind:'result'});
 for(let i=0;i<128;i++)r.open(`active-${i}`,'T');expect(r.canOpen('extra')).toBe(false);expect(()=>r.open('extra','T')).toThrow();expect(r.canOpen('T1')).toBe(false);
});

test('local failure and exact late terminal remain separate; pending RPC never displays idle',()=>{
 const r=new StreamBufferRegistry(),b=r.open('M','T','P'),owner={threadId:'T',projectId:'P',messageId:'M',dispatchId:'D',generation:'G',providerSessionKey:'T'};
 const e={schema:1 as const,owner,admissionId:'A',nativeOutcome:'unknown' as const,rpcOutcome:'pending' as const};b.register(e);
 b.fail('local observation timeout',{meta:{turnStatus:'failed',nativeOutcome:'unknown',persistence:'committed'}});
 const snapshot=()=>({buffers:r.forThread('T')});expect(liveThreadStatus(mergeLiveSnapshot([],snapshot()))).toBe('unconfirmed');
 b.observe({...e,kind:'result',nativeOutcome:'completed'});expect(b.snapshot().native).toEqual({outcome:'completed',rpc:'pending'});
 expect(b.snapshot().status).toBe('failed');expect(b.snapshot().terminal?.meta).toMatchObject({nativeOutcome:'unknown'});
 b.observe({...e,kind:'result',nativeOutcome:'completed',rpcOutcome:'resolved'});
 expect(b.snapshot().native).toEqual({outcome:'completed',rpc:'resolved'});expect(b.snapshot().content).toBe('');
 expect(failurePresentation({turnStatus:'failed',persistence:'committed',nativeOutcome:'failed'}).notices).toContain('Native failure observed; call capacity and cleanup are separate.');
});

test('full sender evidence survives lighter terminal snapshot and duplicate reconciliation',()=>{
 const r=new StreamBufferRegistry(),b=r.open('M','T');b.complete({content:'answer',meta:{executionOutcome:'completed',persistence:'failed'}});
 const full={actor:'agent',turnId:'M',content:'answer',streaming:false,meta:{executionOutcome:'completed',persistence:'failed',injection:{providerMessages:['owned-full-input']}},traceSnapshot:{root:{annotations:{original:'full'}}}};
 const out=mergeLiveSnapshot([full],{buffers:r.forThread('T')});expect(out[0].traceSnapshot).toEqual(full.traceSnapshot);expect(out[0].meta.injection).toEqual(full.meta.injection);expect(out[0].content).toBe('answer');
});

test('notification failure preserves snapshot and result; unresolved originals outlive terminal grace',()=>{
 const r=new StreamBufferRegistry({active:()=>true,publish(){throw Error('controlled notification failure');}}),b=r.open('M','T');b.append('public');
 expect(b.snapshot().notificationFailed).toBe(true);expect(b.content).toBe('public');
 const owner={threadId:'T',messageId:'M',dispatchId:'D',generation:'G',providerSessionKey:'T'};
 b.register({schema:1,owner,admissionId:'A',nativeOutcome:'unknown',rpcOutcome:'pending'});b.fail('timeout');
 const now=Date.now;try{Date.now=()=>now()+600000;expect(r.forThread('T')).toHaveLength(1);}finally{Date.now=now;}
 expect(b.unresolved).toBe(true);
});

test('protocol-labelled final answer preview is not repeated as activity after completion',()=>{
 const r=new StreamBufferRegistry(),b=r.open('M','T'),owner={threadId:'T',messageId:'M',dispatchId:'D',generation:'G',providerSessionKey:'T'};
 b.register({schema:1,owner,admissionId:'A',nativeOutcome:'unknown'});
 b.observe({schema:1,owner,admissionId:'A',nativeOutcome:'unknown',kind:'text',itemId:'final',text:'ANSWER',textPhase:'final_answer'});
 expect(b.snapshot().activity[0].text).toBe('ANSWER');b.complete({content:'ANSWER'});
 expect(b.snapshot().content).toBe('ANSWER');expect(b.snapshot().activity).toHaveLength(0);
});

test('plain external POST has the same live turn; its full result stays in its HTTP response',async()=>{
 const dir=await mkdtemp(resolve('.foundry/qa/lw-source-'));const f=await liveWatchFixture(dir);let turn:ReturnType<typeof f.send>|undefined;
 try {turn=f.send('plain',false);await until(()=>f.attempts.length===1,'admission');expect((await f.snapshot()).turns[0]?.messageId).toBe('plain');f.attempts[0].finish();
   expect((await turn.response).status).toBe(200);const frames=turn.client.data(`thread:${f.thread.id}`);
   expect(frames.some(x=>x.payload?.kind==='turn'&&x.payload.turn.status==='completed')).toBe(true);expect(frames.some(x=>x.payload?.kind==='done')).toBe(false);
 }finally{await f.close();await turn?.done;}
});
