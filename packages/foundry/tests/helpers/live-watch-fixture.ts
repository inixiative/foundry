import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ContextStack, EventStream, Harness, InterventionLog, TokenTracker } from '@inixiative/foundry-core';
import { ThreadFactory, buildAgents } from '../../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../../src/agents/thread-runtime';
import { ProjectRegistry } from '../../src/agents/project';
import { ConfigStore, starterConfig } from '../../src/viewer/config';
import { createViewer } from '../../src/viewer/server';
import { SessionBackedProvider } from '../../src/providers/session-backed';
import type { SessionAdapter } from '../../src/providers/session-adapter';
import { connectStreams } from './data-stream';

export async function until(check:()=>unknown|Promise<unknown>, label:string) {
  const end=performance.now()+8000; while(!await check()){if(performance.now()>end)throw Error(label);await Bun.sleep(10);}
}
/** Controlled normalized public Claude/Codex events; no native process or invented receipt.
 * Real provider, factory/runtime, file-backed journal and actual viewer HTTP entry. */
export async function liveWatchFixture(dir:string) {
  await mkdir(dir,{recursive:true}); await mkdir(join(dir,'P'));
  const attempts:any[]=[],sessions:any[]=[],exits:string[]=[],requests:Promise<unknown>[]=[];
  let startHold=Promise.resolve(),releaseStart=()=>{},closing=false;
  const adapter:SessionAdapter={runtime:'claude-code',async getExternalSessionId(){return null;},async clearSession(){throw Error('No binding clear');},
    async releaseIdleSession(s:any){if(attempts.some(a=>a.session===s&&!a.done))return 'unknown';s.detach();if(!exits.includes(s.resource))exits.push(s.resource);return 'released';},
    async createSession(){const listeners=new Set<(e:any)=>void>();const s:any={resource:`controlled-resource-${sessions.length+1}`,externalSessionId:`controlled-native-${sessions.length+1}`,
      admissionProtocol:'prewrite-v1',turnBudgetProtocol:'optional-max-turns-v1',async start(){await startHold;},kill(){throw Error('No native process');},
      onEvent(fn:(e:any)=>void){listeners.add(fn);return()=>listeners.delete(fn);},inspectAttempt(id:string){const a=attempts.find(a=>a.session===s&&a.native.admissionId===id);return a?structuredClone(a.native):undefined;},
      detach(){listeners.clear();},
      async send(_prompt:string,opts:any){let finish!:()=>void, reject!:(error:Error)=>void;const hold=new Promise<void>((r,j)=>{finish=r;reject=j;});const n=attempts.length+1;
        const native:any={admissionId:`admission-${n}`,nativeSessionId:s.externalSessionId,externalSessionId:s.externalSessionId,threadId:s.externalSessionId,turnId:`native-turn-${n}`,
          dispatch:'not-dispatched',nativeOutcome:'unknown',localOutcome:'pending',rpcOutcome:'pending',transportOutcome:'open',events:[]};
        const a={session:s,native,done:false,localRejected:false,emit(value:any){const event={...structuredClone(native),timestamp:Date.now(),...value};for(const fn of listeners)fn(event);},
          rejectObservation(){a.localRejected=true;native.localOutcome='rejected';native.content='OWNED_PARTIAL';reject(Object.assign(Error('CONTROLLED_LOCAL_OBSERVATION_EXPIRED'),{attempt:structuredClone(native)}));},
          observeTerminal(failed=false){native.nativeOutcome=failed?'failed':'completed';native.terminal={type:'result',subtype:failed?'error_controlled':'success'};a.emit({kind:'result'});},
          finish(failed=false,content='FINAL_ONLY'){native.localOutcome=a.localRejected?'rejected':'resolved';native.rpcOutcome='resolved';native.content=failed?'':content;a.observeTerminal(failed);if(a.localRejected)a.done=true;finish();}};
        attempts.push(a);await opts.onAdmission?.(structuredClone(native));native.dispatch='attempted';if(closing)a.finish();await hold;a.done=true;return structuredClone(native);
      }};sessions.push(s);return s;}};
  const provider=new SessionBackedProvider({id:'controlled-native',adapter,defaultModel:'fable'});
  const config=starterConfig(provider.id,'fable');config.setupComplete=true;config.projects.P={id:'P',path:join(dir,'P')};
  config.agents={worker:{id:'worker',kind:'executor',provider:provider.id,model:'fable',prompt:'Perform owned work',enabled:true,visibleLayers:[],peers:[],maxDepth:1,temperature:0}};
  const events=new EventStream(),stack=new ContextStack();
  const manager=new ThreadRuntimeManager({config,llm:provider,eventStream:events,domains:[],log(){},warn(){}});
  const factory=new ThreadFactory({stack,runtime:manager,agents:buildAgents(config,stack,{provider})});
  const projects=new ProjectRegistry();projects.register({id:'P',label:'Watch project',path:join(dir,'P'),tags:[],runtime:'claude-code'});
  const thread=factory.create('watch-A',{projectId:'P',cwd:join(dir,'P')}),other=factory.create('watch-B',{projectId:'P',cwd:join(dir,'P')});
  thread.describe('Watched work');other.describe('Unrelated sentinel');projects.get('P')!.addThread(thread);projects.get('P')!.addThread(other);
  const harness=new Harness(thread);harness.setDefaultExecutor('worker');const configStore=new ConfigStore(dir);await configStore.save(config);
  const viewer=createViewer({harness,eventStream:events,interventions:new InterventionLog(thread.signals),threadFactory:factory,projectRegistry:projects,configStore,configDir:dir,tokenTracker:new TokenTracker()});
  /** Send a turn from a connection holding `thread:<id>`; `done` is its streamed terminal (or the plain route's JSON). */
  const send=(id:string,stream=true)=>{const client=connectStreams(viewer);
    const response=client.open(`thread:${thread.id}`).then(()=>viewer.app.request(`/api/messages${stream?'/send':''}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,threadId:thread.id,message:'Do the work',...(stream?{clientId:client.socket.data.clientId}:{})})}));
    const done=response.then(r=>stream?client.terminal(thread.id,id):r.json() as Promise<any>).finally(()=>client.disconnect());
    requests.push(done.catch(()=>{}));return {response,done,client};};
  return {viewer,manager,events,thread,other,provider,attempts,sessions,exits,send,
    holdConstruction(){startHold=new Promise<void>(r=>releaseStart=r);},releaseConstruction(){releaseStart();},
    /** A fresh `thread:<id>` snapshot, exactly as a (re)opening viewer receives it. */
    async snapshot(threadId=thread.id){const client=connectStreams(viewer);await client.open(`thread:${threadId}`);
      const frame=client.data(`thread:${threadId}`).find(f=>f.action==='snapshot');client.disconnect();return frame!.payload;},
    async close(){closing=true;releaseStart();for(const a of attempts)if(!a.done)a.finish();await Promise.allSettled(requests);await until(()=>attempts.every(a=>a.done)&&thread.activeDispatches===0,'original controlled settlement');
      const turns=new Set(viewer.localStore!.messages(thread.id).map(m=>m.turnId));
      const history=[...turns].flatMap(id=>viewer.localStore!.nativeHistory(thread.id,id));for(const a of attempts){const e=history.find(e=>e.admissionId===a.native.admissionId&&e.owner);if(!e?.owner)throw Error('Missing original cleanup owner');
        await until(async()=>{const i=await provider.completionLifecycle.inspectOwnedAdmission!(e.owner!,e.admissionId!);return i?.call==='settled'&&i.capacity==='settled';},'exact original capacity before cleanup');
        if(await provider.completionLifecycle.releaseOwnedAdmission!(e.owner,e.admissionId!)!=='released')throw Error('Original cleanup unresolved');}
      manager.disposeAll();viewer.localStore!.close();},
  };
}
