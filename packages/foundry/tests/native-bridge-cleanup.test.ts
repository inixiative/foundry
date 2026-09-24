import {test,expect} from "bun:test";
import type {NativeBridgeLease} from "@inixiative/foundry-core";
import {ClaudeCodeSessionAdapter,CodexSessionAdapter,InMemoryExternalSessionStore} from "../src/providers/session-adapter";

for(const engine of ["claude","mcp"] as const)for(const cleanupFailures of [0,1])test(`${engine}: physical exit alone cannot claim pending bridge cleanup was released (failures=${cleanupFailures})`,async()=>{
  let output!:ReadableStreamDefaultController<Uint8Array>,exit!:(n:number)=>void,release!:()=>void;
  let didExit=false,closeCalls=0,pending=true;const held=new Promise<void>(r=>release=()=>{pending=false;r();});
  const emit=(v:unknown)=>output.enqueue(new TextEncoder().encode(JSON.stringify(v)+"\n"));
  const spawn=()=>({stdout:new ReadableStream<Uint8Array>({start(c){output=c;}}),stderr:new ReadableStream<Uint8Array>({start(c){c.close();}}),
    exited:new Promise<number>(r=>exit=r),kill(){if(!didExit){didExit=true;output.close();exit(0);}},stdin:{write(s:string){const v=JSON.parse(s);queueMicrotask(()=>{
      if(v.method==="initialize"||v.method==="tools/list")emit({id:v.id,result:{}});
      else if(engine==="claude")emit({type:"result",subtype:"success",is_error:false,result:"done",session_id:"owned"});
      else {for(const type of ["task_started","task_complete"])emit({method:"codex/event",params:{id:"turn",msg:{type,turn_id:"turn"}}});emit({id:v.id,result:{structuredContent:{threadId:"owned",content:"done"}}});}
    });},flush(){},end(){}}});
  const bridge:NativeBridgeLease={id:"test",name:"foundry_test",owner:{threadId:"owner",generation:"g"},configurationHash:"test",
    launch:{claudeJson:'{"mcpServers":{}}',codexOverrides:[]},check(){},register(){},observe(){},evidence(){return [];},
    close(){closeCalls++;return held;},status(){return {closed:true,pendingCleanups:pending?1:0,cleanupFailures,evictedRecords:0};}};
  const defaults={spawn};const store=new InMemoryExternalSessionStore();
  const adapter=engine==="claude"?new ClaudeCodeSessionAdapter({store,defaults}):new CodexSessionAdapter({store,defaults});
  const session=await adapter.createSession({threadId:"owner",cwd:"/controlled",nativeBridge:bridge});
  let cleanup:Promise<unknown>|undefined;
  try{await session.start();await session.send("controlled");let settled=false;cleanup=adapter.releaseIdleSession(session).then(r=>{settled=true;return r;});
    await Bun.sleep(5);expect(didExit).toBe(true);expect(closeCalls).toBeGreaterThan(0);expect(settled).toBe(false);
    release();expect(await cleanup).toBe(cleanupFailures?"unknown":"released");
  }finally{release();await cleanup;session.kill();}
});
