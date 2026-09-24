import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextLayer, ContextStack, EventStream, Harness, InterventionLog, ToolRegistry } from "@inixiative/foundry-core";
import { CodexSessionAdapter, InMemoryExternalSessionStore } from "../../src/providers/session-adapter";
import { SessionBackedProvider } from "../../src/providers/session-backed";
import { ThreadRuntimeManager } from "../../src/agents/thread-runtime";
import { ThreadFactory, buildAgents } from "../../src/agents/thread-factory";
import { starterConfig, ConfigStore } from "../../src/viewer/config";
import { createViewer } from "../../src/viewer/server";
import { postStreamedTurn } from "../helpers/data-stream";
import { matchesNativeToolRecord } from "../../../../scripts/native-retrieval-guard";

const req=createRequire(new URL("../../package.json",import.meta.url));
const {Client}=await import(req.resolve("@modelcontextprotocol/sdk/client/index.js"));
const {StdioClientTransport}=await import(req.resolve("@modelcontextprotocol/sdk/client/stdio.js"));

async function fixture(mode:"success"|"inventory"|"registration"|"sql"|"binding"="success") {
  const dir=await mkdtemp(join(tmpdir(),"foundry-app-controlled-"));
  const clients:any[]=[],kills:Array<()=>void>=[],requests:any[]=[];let writes=0,spawns=0;let task:Promise<void>|undefined;
  let checkRegistered=()=>false;
  const spawn=()=>{
    spawns++;let out!:ReadableStreamDefaultController<Uint8Array>,exit!:(n:number)=>void,closed=false,client:any,ready:Promise<void>|undefined,name="";
    const emit=(v:unknown)=>{if(!closed)out.enqueue(new TextEncoder().encode(JSON.stringify(v)+"\n"));};
    const kill=()=>{if(!closed){closed=true;out.close();exit(0);}};kills.push(kill);
    return {stdout:new ReadableStream<Uint8Array>({start(c){out=c;}}),stderr:new ReadableStream<Uint8Array>({start(c){c.close();}}),exited:new Promise<number>(r=>exit=r),kill,
      stdin:{write(line:string){const v=JSON.parse(line);requests.push(v);
        if(v.method==="initialize")queueMicrotask(()=>emit({id:v.id,result:{userAgent:"controlled",platformFamily:"unix",platformOs:"macos",codexHome:"/controlled-native-home"}}));
        if(["thread/start","thread/resume"].includes(v.method)){
          expect(checkRegistered()).toBe(true);
          const key=Object.keys(v.params.config).find(k=>k.startsWith("mcp_servers.foundry_"))!;expect(key).toBeTruthy();
          const launch=v.params.config[key];name=key.slice("mcp_servers.".length);
          client=new Client({name:"controlled-app-server",version:"1"});clients.push(client);
          ready=client.connect(new StdioClientTransport({command:launch.command,args:launch.args,stderr:"pipe"}));void ready?.catch(()=>{});
          queueMicrotask(()=>emit({id:v.id,result:{thread:{id:"native-thread",sessionId:"native-tree",status:{type:"idle"},turns:spawns>1?[{id:"native-turn-1",status:"completed",items:[]}]:[]},model:"observed-model",modelProvider:"openai",cwd:dir,approvalPolicy:"never",approvalsReviewer:"user",sandbox:{type:"dangerFullAccess"},reasoningEffort:"xhigh"}}));
        }
        if(v.method==="mcpServerStatus/list")task=(async()=>{await ready;const list=await client.listTools();emit({id:v.id,result:{data:mode==="inventory"?[]:[{name,runtimeStatus:"connected",tools:Object.fromEntries(list.tools.map((t:any)=>[t.name,t])),resources:[],resourceTemplates:[],authStatus:"unsupported"}]}});})();
        if(v.method==="turn/start"){
          writes++;expect(checkRegistered()).toBe(true);const turnId=`native-turn-${writes}`;
          task=(async()=>{await ready;emit({id:v.id,result:{turn:{id:turnId,status:"inProgress",items:[]}}});
            const item={id:`item-${writes}`,type:"mcpToolCall",server:name,tool:"foundry_query",arguments:{topic:"OWN_FACT",detail:"full"},status:"inProgress"};
            const notify=(method:string,extra:unknown)=>emit({method,params:{threadId:"native-thread",turnId,...extra as object}});
            notify("item/started",{item});const result=await client.callTool({name:item.tool,arguments:item.arguments});
            notify("item/completed",{item:{...item,status:"completed",result:{content:result.content}}});
            notify("item/agentMessage/delta",{itemId:`answer-${writes}`,delta:"COMPLETE"});
            notify("item/completed",{item:{id:`answer-${writes}`,type:"agentMessage",text:"COMPLETE"}});
            notify("turn/completed",{turn:{id:turnId,status:"completed",items:[]}});
          })();void task.catch(()=>{});
        }
      },flush(){},end(){}}};
  };
  const bindings=new InMemoryExternalSessionStore();await bindings.save("main","codex","legacy-untouched");
  if(mode==="binding"){const save=bindings.save.bind(bindings);bindings.save=async(thread,runtime,id)=>{if(runtime==="codex-app-server")throw Error("BINDING_WRITE_DENIED");await save(thread,runtime,id);};}
  const adapter=new CodexSessionAdapter({engine:"app-server",store:bindings,defaults:{spawn,effort:"xhigh"}});
  const provider=new SessionBackedProvider({id:"native",adapter,defaultModel:"requested-model",defaultCwd:dir});
  const config=starterConfig("native","requested-model");config.setupComplete=true;config.agents={worker:{id:"worker",kind:"executor",provider:"native",model:"requested-model",prompt:"Controlled",temperature:0,visibleLayers:[],peers:[],maxDepth:1,enabled:true}};
  const layer=new ContextLayer({id:"memory"});layer.set("OWN_FACT: keep the rollback receipt");const stack=new ContextStack([layer]),events=new EventStream();
  const runtime=new ThreadRuntimeManager({config,eventStream:events,domains:[],llm:{id:"controlled",async complete(){return {content:'{"domains":[],"layers":[],"confidence":1}',model:"controlled"};}},log(){},warn(){}});
  const factory=new ThreadFactory({stack,runtime,nativeTools:new ToolRegistry(),agents:buildAgents(config,stack,{provider})});
  const thread=factory.create("main",{cwd:dir,projectId:"P"});const harness=new Harness(thread);harness.setDefaultExecutor("worker");const configStore=new ConfigStore(dir);await configStore.save(config);
  const viewer=createViewer({harness,eventStream:events,interventions:new InterventionLog(thread.signals),configStore,configDir:dir,threadFactory:factory});
  let sent=0;checkRegistered=()=>viewer.localStore!.nativeHistory("main",`logical-${sent}`).some(e=>e.dispatch==="not-dispatched");
  if(mode==="registration")(viewer.localStore as any).registerNative=()=>{throw Error("REGISTRATION_DENIED");};
  if(mode==="sql")(viewer.localStore as any).db.exec("CREATE TEMP TRIGGER reject_app_trace BEFORE INSERT ON session_traces BEGIN SELECT RAISE(ABORT, 'APP_COMMIT_FAILED'); END");
  return {...viewer,provider,bindings,requests,counts:()=>({writes,spawns}),
    async post(stream=false){sent++;const turn={id:`logical-${sent}`,threadId:"main",message:"Controlled"};if(stream)return postStreamedTurn(viewer,turn);
      const response=await viewer.app.request("/api/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(turn)});return {status:response.status,body:await response.json() as any};},
    async close(){await task?.catch(()=>{});for(const c of clients)await c.close();for(const kill of kills)kill();runtime.disposeAll();viewer.localStore?.close();await rm(dir,{recursive:true,force:true});}};
}

test("actual app-server class: native config creates SDK path; HTTP/streamed retain item joins and immutable warm history",async()=>{
  const f=await fixture();try{
    const first=await f.post();expect(first.body.error).toBeUndefined();expect(first.status).toBe(200);expect(first.body.output).toBe("COMPLETE");
    expect(first.body.meta.native.configuration).toMatchObject({engine:"app-server",requestedModel:"requested-model",observedModel:"observed-model",requestedEffort:"xhigh",observedEffort:"xhigh"});
    const old=JSON.stringify(f.localStore!.traceForTurn("logical-1"));const history=f.localStore!.nativeHistory("main","logical-1"),begin=history.find(e=>e.kind==="tool_use")!,end=history.find(e=>e.kind==="tool_result")!,record=f.localStore!.nativeTools("main","logical-1")[0];
    expect(begin.itemId).toBe(end.itemId);expect(begin.callId).toBeUndefined();expect(matchesNativeToolRecord(begin,end,record)).toBe(true);
    expect(end.toolOutput).toContain("OWN_FACT");expect(history.some(e=>e.runtimeStatus?.type==="mcp-ready")).toBe(true);
    const second=await f.post(true);expect(second.body.output).toBe("COMPLETE");expect(f.counts()).toEqual({writes:2,spawns:1});expect(f.requests.filter(v=>v.method==="thread/start")).toHaveLength(1);expect(f.requests.filter(v=>v.method==="mcpServerStatus/list")).toHaveLength(2);expect(JSON.stringify(f.localStore!.traceForTurn("logical-1"))).toBe(old);
    expect(await f.bindings.load("main","codex")).toBe("legacy-untouched");expect(await f.bindings.load("main","codex-app-server")).toBe("native-thread");
  }finally{await f.close();}
});
for(const mode of ["inventory","registration","binding"] as const)test(`production refusal ${mode} sends no model work`,async()=>{const f=await fixture(mode);try{const r=await f.post();expect(r.status).toBeGreaterThanOrEqual(400);expect(f.counts().writes).toBe(0);expect(await f.bindings.load("main","codex")).toBe("legacy-untouched");if(mode==="binding")expect(await f.bindings.load("main","codex-app-server")).toBeNull();}finally{await f.close();}});
test("exact owned release preserves binding; new process resumes with refreshed SDK config and frozen prior history",async()=>{
  const f=await fixture();try{
    const first=await f.post();const native=first.body.meta.native;expect(native.nativeOutcome).toBe("completed");
    const old=JSON.stringify(f.localStore!.traceForTurn("logical-1"));
    expect(await f.provider.completionLifecycle.releaseOwnedAdmission!({...native.owner,generation:"foreign"},native.admissionId)).toBe("unavailable");
    expect(await f.provider.completionLifecycle.releaseOwnedAdmission!(native.owner,native.admissionId)).toBe("released");
    const second=await f.post();expect(second.body.error).toBeUndefined();expect(second.body.meta.native.configuration.history).toMatchObject({source:"thread/resume",available:true,turns:[{id:"native-turn-1",status:"completed"}]});
    expect(f.counts()).toEqual({writes:2,spawns:2});expect(f.requests.filter(v=>v.method==="thread/resume")).toHaveLength(1);
    expect(first.body.meta.native.bridge.id).not.toBe(second.body.meta.native.bridge.id);expect(JSON.stringify(f.localStore!.traceForTurn("logical-1"))).toBe(old);
  }finally{await f.close();}
});
for(const stream of [false,true])test(`native success survives SQL failure (${stream?"streamed":"HTTP"})`,async()=>{
  const f=await fixture("sql");try{const r=await f.post(stream);expect(r.body.output).toBe("COMPLETE");expect(r.body.meta.native.nativeOutcome).toBe("completed");expect(r.body.meta.persistence).toBe("failed");expect(r.body.meta.persistenceError).toContain("APP_COMMIT_FAILED");expect(r.body.meta.partialOutput).toBeUndefined();expect(f.counts().writes).toBe(1);}finally{await f.close();}
});
test("app-server adapter refuses auxiliary policy and unknown engine without fallback",async()=>{
  const store=new InMemoryExternalSessionStore();const adapter=new CodexSessionAdapter({store,engine:"app-server"});
  await expect(adapter.createSession({threadId:"owner:aux:review:x",cwd:"/controlled",tools:false})).rejects.toThrow("text-only");
  expect(()=>new CodexSessionAdapter({store,engine:"foreign" as any})).toThrow("Unsupported");
});
