import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeSession } from "@inixiative/agent-session";
import { ContextStack, EventStream, Harness, InterventionLog } from "@inixiative/foundry-core";
import { ClaudeCodeSessionAdapter, CodexSessionAdapter, InMemoryExternalSessionStore } from "../../src/providers/session-adapter";
import { SessionBackedProvider } from "../../src/providers/session-backed";
import { ThreadFactory, buildAgents } from "../../src/agents/thread-factory";
import { starterConfig, ConfigStore } from "../../src/viewer/config";
import { createViewer } from "../../src/viewer/server";
import { postStreamedTurn } from "../helpers/data-stream";
import { LocalSessionStore } from "../../src/persistence/local-session-store";

async function fixture(engine:"claude"|"mcp", mode:"success"|"failed"|"rpc-error"|"unknown"="success", seedUnknown=false) {
  expect((new ClaudeCodeSession() as any).admissionProtocol).toBe("prewrite-v1");
  const dir=await mkdtemp(join(tmpdir(),"foundry-native-candidate-"));
  let output!:ReadableStreamDefaultController<Uint8Array>, finish!:(code:number)=>void;
  let writes=0, spawns=0, closed=false; const seen:any[]=[];
  let late: (()=>void)|undefined;
  const emit=(value:unknown)=>output.enqueue(new TextEncoder().encode(JSON.stringify(value)+"\n"));
  let registered=()=>false;
  const spawn=()=> { spawns++; return {
    stdout:new ReadableStream<Uint8Array>({start(c){output=c;}}),stderr:new ReadableStream<Uint8Array>({start(c){c.close();}}),
    exited:new Promise<number>(r=>{finish=r;}),kill(){if(!closed){closed=true;output.close();finish(0);}},
    stdin:{write(line:string){const v=JSON.parse(line);if(["initialize","tools/list"].includes(v.method)) {queueMicrotask(()=>emit({id:v.id,result:{}}));return;}
      if(v.type!=="user"&&v.method!=="tools/call")return;
      writes++; expect(registered()).toBe(true); const turn=`turn-${writes}`,call=`call-${writes}`;
      queueMicrotask(()=>{
        if(engine==="claude") {
          emit({type:"system",subtype:"init",session_id:"own",model:"controlled"});
          emit({type:"assistant",session_id:"own",message:{id:`msg-${writes}`,content:[{type:"text",text:"PUBLIC_OUTPUT"},{type:"tool_use",id:call,name:"Bash",input:{command:"bun --version"}}]}});
          emit({type:"user",session_id:"own",message:{content:[{type:"tool_result",tool_use_id:call,content:"1.3.14"}]}});
          late=()=>emit({type:"result",uuid:turn,session_id:"own",subtype:"success",is_error:mode==="failed",api_error_status:mode==="failed"?429:undefined,result:"PUBLIC_OUTPUT"});
          if(mode!=="unknown")late();
        } else {
          const event=(msg:any)=>emit({method:"codex/event",params:{id:turn,msg:{turn_id:turn,...msg}}});
          event({type:"task_started"});event({type:"exec_command_begin",call_id:call,command:["zsh","-lc","bun --version"]});
          event({type:"exec_command_end",call_id:call,exit_code:0,stdout:"1.3.14"});
          event({type:"agent_message",message:"PUBLIC_OUTPUT"});
          late=()=>{event({type:"task_complete"});emit({id:v.id,...(mode==="rpc-error"?{error:{code:-1,message:"ORIGINAL_RPC_ERROR"}}:{result:{structuredContent:{threadId:"own",content:"PUBLIC_OUTPUT"}}})});};
          if(mode!=="unknown")late();
        }
      });
    },flush(){},end(){}}};};
  const bindings=new InMemoryExternalSessionStore(); await bindings.save("main",engine==="claude"?"claude-code":"codex","own");
  const adapter=engine==="claude"?new ClaudeCodeSessionAdapter({store:bindings,defaults:{spawn}}):new CodexSessionAdapter({store:bindings,defaults:{spawn}});
  const provider=new SessionBackedProvider({id:"native",adapter,defaultModel:"controlled",defaultCwd:dir});
  if(mode==="unknown") {const complete=provider.complete.bind(provider);provider.complete=(messages,opts)=>complete(messages,{...opts,timeout:10});}
  const config=starterConfig("native","controlled");config.setupComplete=true;
  config.agents={worker:{id:"worker",kind:"executor",provider:"native",model:"controlled",prompt:"Controlled task",temperature:0,visibleLayers:[],peers:[],maxDepth:1,enabled:true}};
  const stack=new ContextStack();const factory=new ThreadFactory({stack,agents:buildAgents(config,stack,{provider})});const thread=factory.create("main",{cwd:dir,projectId:"P"});
  const harness=new Harness(thread);harness.setDefaultExecutor("worker");const configStore=new ConfigStore(dir);await configStore.save(config); const events=new EventStream();events.subscribe(e=>seen.push(e));
  if(seedUnknown) {
    const prior=new LocalSessionStore(join(dir,"sessions.sqlite"));
    prior.beginTurn(thread,"previous-process","Prior controlled task");
    const evidence={schema:1 as const,admissionId:"previous-admission",nativeOutcome:"unknown" as const,localOutcome:"pending" as const,
      dispatch:"not-dispatched" as const,owner:{threadId:"main",projectId:"P",generation:"previous-runtime",messageId:"previous-process",dispatchId:"previous-dispatch",providerSessionKey:"main"}};
    prior.registerNative(thread,evidence);prior.appendNative(thread,{...evidence,dispatch:"attempted"});prior.close();
  }
  const viewer=createViewer({harness,eventStream:events,interventions:new InterventionLog(thread.signals),configStore,configDir:dir,threadFactory:factory});
  registered=()=>viewer.localStore!.nativeHistory("main",`logical-${writes}`).some(e=>e.dispatch==="not-dispatched"&&e.owner?.dispatchId&&e.owner?.projectId==="P");
  const post=async(stream=false,id=`logical-${writes+1}`)=>{const turn={id,threadId:"main",message:"Read controlled sentinel"};
    if(stream)return postStreamedTurn(viewer,turn);
    const response=await viewer.app.request("/api/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(turn)});
    return {status:response.status,body:await response.json() as any};};
  return {...viewer,thread,provider,bindings,seen,post,late:()=>late?.(),counts:()=>({writes,spawns}),sql:(viewer.localStore as unknown as{db:Database}).db,
    close:async()=>{if(!closed){closed=true;output?.close();finish?.(0);}viewer.localStore?.close();thread.dispose();await rm(dir,{recursive:true,force:true});}};
}
for(const engine of ["claude","mcp"] as const) {
  test(`${engine}: reconstructed unknown occupancy prevents even native construction`,async()=>{const f=await fixture(engine,"success",true);try{
    const result=await f.post();expect(result.status).toBe(500);
    expect(result.body.error).toContain("Previous native outcome unresolved");expect(f.counts()).toEqual({writes:0,spawns:0});
    expect(f.localStore!.nativeHistory("main","previous-process").at(-1)?.nativeOutcome).toBe("unknown");
    expect(await f.bindings.load("main",engine==="claude"?"claude-code":"codex")).toBe("own");
  }finally{await f.close();}});
  test(`${engine}: failed prewrite journal registration has no native write`,async()=>{const f=await fixture(engine);try{
    f.sql.exec("CREATE TEMP TRIGGER reject_admission BEFORE INSERT ON session_native BEGIN SELECT RAISE(ABORT,'REGISTRATION_DENIED'); END");
    const r=await f.post();expect(r.status).toBe(500);expect(r.body.meta.native.dispatch).toBe("not-dispatched");expect(f.counts().writes).toBe(0);
    expect(await f.bindings.load("main",engine==="claude"?"claude-code":"codex")).toBe("own");
  }finally{await f.close();}});
  test(`${engine}: timeout and refused followup retain late original terminal without rewriting delivery`,async()=>{const f=await fixture(engine,"unknown");try{
    const one=await f.post();expect(one.body.meta.nativeOutcome).toBe("unknown");
    const trace=f.localStore!.traceForTurn("logical-1")!;const frozen=JSON.stringify(trace);
    const second=await f.post(false,"refused");expect(second.status).toBe(500);expect(f.counts().writes).toBe(1);
    f.late();await Bun.sleep(15);const history=f.localStore!.nativeHistory("main","logical-1");
    expect(history.some(e=>e.nativeOutcome==="completed")).toBe(true);
    expect(f.localStore!.nativeHistory("main","refused").some(e=>e.nativeOutcome==="completed")).toBe(false);
    expect(JSON.stringify(f.localStore!.traceForTurn("logical-1"))).toBe(frozen);
    expect(f.counts()).toEqual({writes:1,spawns:1});
  }finally{await f.close();}});
}
for(const engine of ["claude","mcp"] as const) for(const stream of [false,true]) {
  test(`${engine} ${stream?"streamed":"HTTP"}: prewrite registration, tools, terminal, durable output and two admissions`,async()=>{
    const f=await fixture(engine);try {
      const one=await f.post(stream);expect(one.body.output).toBe("PUBLIC_OUTPUT");expect(one.body.meta.native.nativeOutcome).toBe("completed");
      const first=f.localStore!.messages("main").find(m=>m.actor==="agent")!;
      expect(first.meta?.nativeHistory).toBeDefined(); const native=f.localStore!.nativeHistory("main","logical-1");
      expect(native.some(e=>e.kind==="tool_use"&&e.callId)).toBe(true);expect(native.some(e=>e.kind==="tool_result"&&e.callId&&e.toolOutput==="1.3.14")).toBe(true);
      expect((await f.post(stream)).body.output).toBe("PUBLIC_OUTPUT");expect(f.counts()).toEqual({writes:2,spawns:1});
      expect(f.localStore!.messages("main").filter(m=>m.actor==="agent")[0].meta?.native).toEqual(first.meta?.native);
    } finally {await f.close();}
  });
  test(`${engine} ${stream?"streamed":"HTTP"}: SQL failure after success retains completed output without another send`,async()=>{
    const f=await fixture(engine);try {
      f.sql.exec("CREATE TEMP TRIGGER reject_output BEFORE INSERT ON session_messages WHEN NEW.actor='agent' BEGIN SELECT RAISE(ABORT,'SQL_COMMIT_ERROR'); END");
      const result=await f.post(stream);expect(result.body.output).toBe("PUBLIC_OUTPUT");expect(result.body.meta.persistence).toBe("failed");expect(result.body.meta.nativeOutcome).toBe("completed");
      expect(result.body.meta.partialOutput).toBeUndefined();expect(f.counts().writes).toBe(1);
      expect((await f.post(stream,"logical-1")).status).toBe(409);
    } finally {await f.close();}
  });
  test(`${engine} ${stream?"streamed":"HTTP"}: guard failure after execution preserves normal output and original error`,async()=>{
    const f=await fixture(engine);try {
      f.thread.middleware.use("after-success",async(_ctx,next)=>{await next();throw Error("POST_EXECUTION_GUARD");});
      const result=await f.post(stream);expect(result.body.output).toBe("PUBLIC_OUTPUT");expect(result.body.meta.postExecutionError).toBe("POST_EXECUTION_GUARD");expect(result.body.meta.nativeOutcome).toBe("completed");
      expect(result.body.meta.partialOutput).toBeUndefined();expect(f.localStore!.turn("logical-1")?.status).toBe("completed");expect(f.counts().writes).toBe(1);
    } finally {await f.close();}
  });
}
test("MCP native terminal success followed by original RPC error remains completed",async()=>{const f=await fixture("mcp","rpc-error");try{const r=await f.post();expect(r.body.output).toBe("PUBLIC_OUTPUT");expect(r.body.meta.native.localOutcome).toBe("rejected");expect(r.body.meta.native.nativeOutcome).toBe("completed");}finally{await f.close();}});
test("Claude contradictory success/429 is native failure with partial output",async()=>{const f=await fixture("claude","failed");try{const r=await f.post();expect(r.status).toBe(500);expect(r.body.meta.nativeOutcome).toBe("failed");expect(r.body.meta.partialOutput).toBe("PUBLIC_OUTPUT");expect(f.counts().writes).toBe(1);}finally{await f.close();}});
