import { test, expect } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, rm, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeSession } from "@inixiative/agent-session";
import { ContextLayer, ContextStack, EventStream, Harness, InterventionLog, ToolRegistry } from "@inixiative/foundry-core";
import { ClaudeCodeSessionAdapter, CodexSessionAdapter, InMemoryExternalSessionStore } from "../../src/providers/session-adapter";
import { SessionBackedProvider } from "../../src/providers/session-backed";
import { ThreadFactory, buildAgents } from "../../src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../src/agents/thread-runtime";
import { starterConfig, ConfigStore } from "../../src/viewer/config";
import { createViewer } from "../../src/viewer/server";
import { postStreamedTurn } from "../helpers/data-stream";
import { matchesNativeToolRecord } from "../../../../scripts/native-retrieval-guard";
import { FixtureLifecycle, throwFixtureFailures } from "./fixture-lifecycle";

const req=createRequire(new URL("../../package.json",import.meta.url));
const {Client}=await import(req.resolve("@modelcontextprotocol/sdk/client/index.js"));
const {StdioClientTransport}=await import(req.resolve("@modelcontextprotocol/sdk/client/stdio.js"));

async function fixture(engine:"claude"|"mcp", mode:"success"|"rpc-error"|"write-failed"|"late"|"tool-error"|"tool-transport-error"|"non-text"|"foreign-duplicate"="success",
  options: { lifecycle?: FixtureLifecycle; connectGate?: Promise<void>; handshakeFailure?: boolean; setupFailure?: boolean; toolFailure?: boolean } = {}) {
  expect((new ClaudeCodeSession() as any).admissionProtocol).toBe("prewrite-v1");
  const lifecycle=options.lifecycle??new FixtureLifecycle();
  const dir=await mkdtemp(join(tmpdir(),"foundry-t3-candidate-"));
  lifecycle.own("directory",90,()=>rm(dir,{recursive:true,force:true}));
  let controller!:ReadableStreamDefaultController<Uint8Array>,exit!:(n:number)=>void,closed=false;
  let writes=0,spawns=0;let client:any;let transport:InstanceType<typeof StdioClientTransport>|undefined;let work:Promise<void>|undefined;let proxyReady:Promise<void>|undefined;let nativeArgs:readonly string[]=[];
  const bridges: Array<NonNullable<Parameters<CodexSessionAdapter["createSession"]>[0]["nativeBridge"]>>=[];
  const proxyDiagnostics={stderrBytes:0,signals:[] as string[]};
  const writeReport=async(errors:unknown[])=>{const base=process.env.FOUNDRY_QA_OUTPUT_ROOT??join(process.cwd(),".foundry/qa");await mkdir(base,{recursive:true});const output=await mkdtemp(join(base,`bridge-fixture-${engine}-`));await Bun.write(join(output,"report.json"),JSON.stringify({engine,scope:"Controlled transport/real SDK fixture; no model process",phases:lifecycle.phases,counts:{writes,spawns},controlledExited:spawns>0&&closed,proxyPid:transport?.pid??null,proxyDiagnostics,bridges:bridges.map(b=>b.status?.()),cleanupFailures:errors.length},null,2));};
  lifecycle.own("work",0,()=>work);
  lifecycle.own("proxy-ready",1,()=>proxyReady);
  lifecycle.own("sdk-client",10,()=>client?.close());
  lifecycle.own("sdk-transport",11,()=>transport?.close());
  lifecycle.own("controlled-exit",20,()=>{if(!closed){closed=true;controller?.close();exit?.(0);}});
  lifecycle.own("bridge",30,async()=>{const results=await Promise.allSettled(bridges.map(b=>b.close()));const errors=results.flatMap(r=>r.status==="rejected"?[r.reason]:[]);for(const bridge of bridges){const state=bridge.status?.();if(!state?.closed||state.pendingCleanups||state.cleanupFailures)errors.push(Error("Owned fixture bridge cleanup incomplete"));}throwFixtureFailures(undefined,errors);});
  let checkRegistration=()=>false;const replies:unknown[]=[];
  let late: (()=>void)|undefined;
  const emit=(v:unknown)=>{if(!closed)controller.enqueue(new TextEncoder().encode(JSON.stringify(v)+"\n"));};
  const spawn=(argv:readonly string[])=>{
    spawns++;nativeArgs=argv;
    expect(argv).not.toContain("--max-turns");
    const launch=engine==="claude"?Object.values(JSON.parse(argv[argv.indexOf("--mcp-config")+1]).mcpServers)[0] as any
      : {command:JSON.parse(argv.find(v=>/mcp_servers\.foundry_.*\.command=/.test(v))!.split("=").slice(1).join("=")),
        args:JSON.parse(argv.find(v=>/mcp_servers\.foundry_.*\.args=/.test(v))!.split("=").slice(1).join("="))};
    const serverName=engine==="claude"?Object.keys(JSON.parse(argv[argv.indexOf("--mcp-config")+1]).mcpServers)[0]
      :argv.find(v=>/mcp_servers\.foundry_.*\.command=/.test(v))!.split(".")[1];
    client=new Client({name:"controlled-native-proxy",version:"1"});
    transport=new StdioClientTransport({command:launch.command,args:launch.args,stderr:"pipe"});
    // Persist only fixed diagnostic labels, never arbitrary stderr or launch text.
    let stderrTail="";
    transport.stderr?.on("data",(chunk:Buffer)=>{
      proxyDiagnostics.stderrBytes+=chunk.length;stderrTail=(stderrTail+chunk.toString()).slice(-1024);
      for(const signal of ["foundry-bridge-proxy:","ENOENT","ECONNREFUSED","ECONNRESET","EPIPE","Unauthorized","Invalid","Failed to fetch","Unable to connect","Connection closed","fetch failed","SSE error","HTTP 400","HTTP 401","HTTP 403","HTTP 404","HTTP 500","error sending message","TransportError","SQLITE","launch file","capability","session"])
        if(stderrTail.includes(signal)&&!proxyDiagnostics.signals.includes(signal))proxyDiagnostics.signals.push(signal);
    });
    const send=transport.send.bind(transport);
    transport.send=async(message: Parameters<NonNullable<typeof transport>["send"]>[0])=>{if(message&&typeof message==="object"&&"method" in message&&message.method==="initialize"){
      if(options.connectGate)await options.connectGate;
      if(options.handshakeFailure){await transport!.close();return;}
    }return send(message);};
    const ready=lifecycle.step("sdk-connect",()=>client.connect(transport));
    proxyReady=ready;void ready.catch(()=>{});
    return {stdout:new ReadableStream<Uint8Array>({start(c){controller=c;}}),stderr:new ReadableStream<Uint8Array>({start(c){c.close();}}),
      exited:new Promise<number>(r=>{exit=r;}),kill(){if(!closed){closed=true;controller.close();exit(0);}},
      stdin:{write(line:string){const v=JSON.parse(line);
        // The fake native process must not announce successful setup while its
        // actual SDK proxy is still starting. Preserve genuine SDK failures.
        if(["initialize","tools/list"].includes(v.method)){void ready.then(()=>emit({id:v.id,result:{}}),()=>emit({id:v.id,error:{code:-32000,message:"Controlled SDK proxy setup failed"}}));return;}
        if(v.type!=="user"&&v.method!=="tools/call")return;
        writes++;expect(checkRegistration()).toBe(true);
        if(mode==="write-failed")throw Error("ORIGINAL_WRITE_ERROR");
        const turn=`turn-${writes}`,call=`call-${writes}`;
        work=lifecycle.step("controlled-tool-work",async()=>{
          await ready;
          // Synthetic protocol.rs-derived MCP notifications plus an actual SDK
          // result. This is not a captured installed legacy notification shape.
          const name=`mcp__${serverName}__foundry_query`;
          const invocation={server:serverName,tool:"foundry_query",arguments:{topic:"OWN_FACT",detail:"full"}};
          const event=(msg:unknown,id=turn)=>emit({method:"codex/event",params:{id,msg}});
          if(engine==="claude") {
            emit({type:"system",subtype:"init",session_id:"own",model:"controlled"});
            emit({type:"assistant",session_id:"own",message:{content:[{type:"tool_use",id:call,name,input:{topic:"OWN_FACT",detail:"full"}}]}});
          } else {
            event({type:"task_started",turn_id:turn});
            if(mode==="foreign-duplicate")event({type:"mcp_tool_call_begin",call_id:"foreign-call",invocation},"foreign-turn");
            event({type:"mcp_tool_call_begin",call_id:call,invocation});
            if(mode==="foreign-duplicate")event({type:"mcp_tool_call_begin",call_id:call,invocation});
          }
          if(options.toolFailure)throw Error("CONTROLLED_SDK_TOOL_REJECTION");
          const result:any=await lifecycle.step("sdk-tool-call",()=>client.callTool({name:"foundry_query",arguments:{topic:"OWN_FACT",detail:"full"}}),1000);replies.push(result);
          const text=JSON.stringify(result);
          if(engine==="claude") {
            emit({type:"user",session_id:"own",message:{content:[{type:"tool_result",tool_use_id:call,content:text}]}});
            late=()=>emit({type:"result",uuid:turn,session_id:"own",subtype:"success",is_error:false,result:"COMPLETE"});
          } else {
            const toolResult={type:"mcp_tool_call_end",call_id:call,invocation,duration:{secs:0,nanos:1},result:mode==="tool-transport-error"?{Err:"CONTROLLED_TOOL_ERROR"}
              :{Ok:mode==="tool-error"?{...result,isError:true}:mode==="non-text"?{content:[{type:"image",data:"PRIVATE_BINARY"}]}:result}};
            event(toolResult);
            if(mode==="foreign-duplicate")event(toolResult);
            emit({method:"codex/event",params:{id:turn,msg:{type:"agent_message",turn_id:turn,message:"COMPLETE"}}});
            late=()=>{event({type:"task_complete",turn_id:turn});
              emit({id:v.id,...(mode==="rpc-error"?{error:{code:-1,message:"ORIGINAL_RPC_ERROR"}}:{result:{structuredContent:{threadId:"own",content:"COMPLETE"}}})});};
          }
          if(mode!=="late"||writes>1)late();
        },1500);void work.catch(()=>{
          // A failed fake-native script must end its controlled transport rather
          // than leave the real class awaiting an invented terminal forever.
          // The original SDK error remains in work/cleanup evidence; EOF is not
          // a native completed/cancelled acknowledgment.
          if(!closed){closed=true;controller.close();exit(1);}
        });
      },flush(){},end(){}}};
  };
  try {
  const bindings=new InMemoryExternalSessionStore();await bindings.save("main",engine==="claude"?"claude-code":"codex","own");
  const adapter=engine==="claude"?new ClaudeCodeSessionAdapter({store:bindings,defaults:{spawn}}):new CodexSessionAdapter({store:bindings,defaults:{spawn}});
  const create=adapter.createSession.bind(adapter);adapter.createSession=async(opts)=>{if(opts.nativeBridge)bridges.push(opts.nativeBridge);return create(opts);};
  const provider=new SessionBackedProvider({id:"native",adapter,defaultModel:"controlled",defaultCwd:dir});
  if(mode==="late"){const complete=provider.complete.bind(provider);provider.complete=(messages,opts)=>complete(messages,{...opts,timeout:writes===0?10:2000});}
  const config=starterConfig("native","controlled");config.setupComplete=true;
  config.agents={worker:{id:"worker",kind:"executor",provider:"native",model:"controlled",prompt:"Controlled",temperature:0,visibleLayers:[],peers:[],maxDepth:1,enabled:true}};
  const layer=new ContextLayer({id:"memory"});layer.set("OWN_FACT: rollback is blue before green");
  const stack=new ContextStack([layer]),events=new EventStream();
  const runtime=new ThreadRuntimeManager({config,eventStream:events,domains:[],llm:{id:"fake",async complete(){return {content:'{"domains":[],"layers":[],"confidence":1}',model:"fake"};}},log(){},warn(){}});
  lifecycle.own("runtime",60,()=>runtime.disposeAll());
  const factory=new ThreadFactory({stack,runtime,nativeTools:new ToolRegistry(),agents:buildAgents(config,stack,{provider})});
  const thread=factory.create("main",{cwd:dir,projectId:"P"});const harness=new Harness(thread);harness.setDefaultExecutor("worker");
  lifecycle.own("thread",50,()=>thread.dispose());
  if(options.setupFailure)throw Error("CONTROLLED_PARTIAL_SETUP");
  const configStore=new ConfigStore(dir);await configStore.save(config);
  const viewer=createViewer({harness,eventStream:events,interventions:new InterventionLog(thread.signals),configStore,configDir:dir,threadFactory:factory});
  lifecycle.own("journal",80,()=>viewer.localStore?.close());
  checkRegistration=()=>viewer.localStore!.nativeHistory("main",`logical-${writes}`).some(e=>e.dispatch==="not-dispatched"&&e.owner?.generation===runtime.get("main")!.generation);
  return {...viewer,thread,provider,bindings,replies,events,lifecycle,dir,counts:()=>({writes,spawns}),argv:()=>nativeArgs,
    resources:()=>({controlledExited:spawns>0&&closed,proxyPid:transport?.pid??null,runtimeDisposed:runtime.get("main")===undefined,bridges:bridges.map(b=>b.status?.())}),
    async settle(){await work;late?.();for(let i=0;i<1000&&!viewer.localStore!.nativeHistory("main","logical-1").some(e=>e.nativeOutcome==="completed");i++)await Bun.sleep(1);},
    async post(stream=false,id=`logical-${writes+1}`){const turn={id,threadId:"main",message:"Controlled"};
      if(stream)return lifecycle.step("http-dispatch",()=>postStreamedTurn(viewer,turn),3600);
      const r=await lifecycle.step("http-dispatch",()=>viewer.app.request("/api/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(turn)}),1800);const t=await lifecycle.step("http-body",()=>r.text(),1800);return {status:r.status,body:JSON.parse(t)};},
    async close(){const errors=await lifecycle.cleanup();await writeReport(errors);throwFixtureFailures(undefined,errors);}};
  }catch(error){const errors=await lifecycle.cleanup();await writeReport(errors);throwFixtureFailures(error,errors);throw error;}
}

async function browserEvidence(engine: "claude"|"mcp", fault?: "fresh-observation") {
  const base=process.env.FOUNDRY_QA_OUTPUT_ROOT??join(process.cwd(),".foundry/qa");await mkdir(base,{recursive:true});
  const output=await mkdtemp(join(base,`t3-browser-${engine}-`));
  const lifecycle=new FixtureLifecycle();
  const report:any={passed:false,engine,scope:"Actual installed class over controlled streams and real SDK proxy; no model calls; MCP notifications synthetic upstream-derived"};
  let f:Awaited<ReturnType<typeof fixture>>|undefined;let browser:any;let server:ReturnType<typeof Bun.serve>|undefined;let primary:unknown;
  const pages:any[]=[];
  const bodyDeadline=performance.now()+20000;
  const step=<T>(name:string,action:()=>Promise<T>|T)=>lifecycle.step(name,action,Math.max(1,Math.min(4000,bodyDeadline-performance.now())));
  lifecycle.own("observer-server",20,()=>{server?.stop(true);});
  try {
    const {chromium}=await step("browser-module",()=>req(process.env.FOUNDRY_QA_PLAYWRIGHT!));
    f=await lifecycle.acquire("fixture-setup",30,()=>fixture(engine),owned=>owned.close());
    const owned=f;
    server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:owned.fetch,websocket:owned.websocket});
    const origin=`http://127.0.0.1:${server.port}`;
    browser=await lifecycle.acquire("browser-launch",10,()=>chromium.launch({channel:"chrome",headless:true,timeout:4000}),(owned:any)=>owned.close());
    const page:any=await step("old-page",()=>browser.newPage());pages.push(page);page.setDefaultTimeout(4000);page.setDefaultNavigationTimeout(4000);
    await step("old-navigation",()=>page.goto(`${origin}/#thread=main`));await step("old-connected",()=>page.locator(".status-text").filter({hasText:/^connected$/}).waitFor());
    await step("owned-dispatch",()=>owned.post());await step("old-inspector-click",()=>page.locator(".chat-agent").filter({hasText:"COMPLETE"}).locator(".chat-trace-btn").click());
    const toolName=f.localStore!.nativeHistory("main","logical-1").find(e=>e.kind==="tool_use")!.toolName!;
    await step("old-native-evidence",()=>page.locator(".native-journal-evidence").filter({hasText:toolName}).waitFor());
    const oldNative=await step("old-native-text",()=>page.locator(".native-journal-evidence").textContent());
    expect(oldNative).toContain('"tool_result"');expect(oldNative).toContain("OWN_FACT");
    await step("old-sdk-evidence",()=>page.locator(".native-bridge-evidence").filter({hasText:"OWN_FACT"}).waitFor());
    const historical=JSON.stringify(f.localStore!.traceForTurn("logical-1"));
    const old=f.localStore!.nativeTools("main","logical-1")[0];
    f.localStore!.persistNativeTool(f.thread,{...old.record,id:"controlled-late-record",finishedAt:Date.now(),result:"CONTROLLED_LATE_PUBLIC_RESULT"},()=>{owned.events.push({kind:"journal",threadId:"main",turnId:"logical-1",timestamp:Date.now()});return true;});
    await step("old-late-evidence",()=>page.locator(".native-bridge-evidence").filter({hasText:"CONTROLLED_LATE_PUBLIC_RESULT"}).waitFor());
    await step("old-scroll",()=>page.locator(".native-bridge-evidence").scrollIntoViewIfNeeded());
    await step("old-screenshot",()=>page.screenshot({path:join(output,"old-observer.png"),fullPage:true}));
    const context:any=await lifecycle.acquire("fresh-context",5,()=>browser.newContext(),(owned:any)=>owned.close());
    const fresh:any=await step("fresh-page",()=>context.newPage());pages.push(fresh);fresh.setDefaultTimeout(4000);fresh.setDefaultNavigationTimeout(4000);
    await step("fresh-navigation",()=>fresh.goto(`${origin}/#thread=main`));
    await step("fresh-inspector-click",()=>fresh.locator(".chat-agent").filter({hasText:"COMPLETE"}).locator(".chat-trace-btn").click());
    await step("fresh-native-evidence",()=>fresh.locator(".native-journal-evidence").filter({hasText:toolName}).waitFor());
    const freshNative=await step("fresh-native-text",()=>fresh.locator(".native-journal-evidence").textContent());
    expect(freshNative).toContain('"tool_result"');expect(freshNative).toContain("OWN_FACT");
    if(fault==="fresh-observation")await lifecycle.step("fresh-controlled-missing-evidence",()=>fresh.locator("#controlled-absent-evidence").waitFor({timeout:80}),200);
    await step("fresh-late-evidence",()=>fresh.locator(".native-bridge-evidence").filter({hasText:"CONTROLLED_LATE_PUBLIC_RESULT"}).waitFor());
    await step("fresh-scroll",()=>fresh.locator(".native-bridge-evidence").scrollIntoViewIfNeeded());
    await step("fresh-screenshot",()=>fresh.screenshot({path:join(output,"fresh-history.png"),fullPage:true}));
    expect(JSON.stringify(f.localStore!.traceForTurn("logical-1"))).toBe(historical);expect(f.counts().writes).toBe(1);report.passed=true;
  }catch(error){primary=error;report.failedPhase=lifecycle.phases.findLast(p=>p.status==="failed")?.name??"assertion";
    for(let i=0;i<pages.length;i++){try{await lifecycle.step(`failure-screenshot-${i}`,()=>pages[i].screenshot({path:join(output,`failure-${i}.png`),timeout:1000}),1200);}catch{/* Recorded screenshot failure does not hide the original observation error. */}}
  }finally{
    const errors=await lifecycle.cleanup();if(errors.length)report.passed=false;
    report.phases=lifecycle.phases;report.fixturePhases=f?.lifecycle.phases;report.counts=f?.counts();report.resources=f?.resources();report.cleanupFailures=errors.length;
    await Bun.write(join(output,"report.json"),JSON.stringify(report,null,2));
    if(primary!==undefined||errors.length){const failure=new AggregateError([...(primary!==undefined?[primary]:[]),...errors],`Browser fixture failed at ${report.failedPhase??"cleanup"}`,{cause:primary??errors[0]});Object.assign(failure,{report,output});throw failure;}
  }
  return {report,output};
}
if(process.env.FOUNDRY_QA_PLAYWRIGHT)for(const engine of ["claude","mcp"] as const)test(`${engine} actual viewer: old and fresh inspector reconcile tool evidence without another native write`,()=>browserEvidence(engine),30000);
for(const engine of ["claude","mcp"] as const)for(const stream of [false,true]) {
  test(`${engine} ${stream?"streamed":"HTTP"}: installed class, one configured bridge/process and two prewritten owned admissions`,async()=>{
    const f=await fixture(engine);try {
      const first=await f.post(stream);expect(first.body.output).toBe("COMPLETE");expect(first.body.meta.native.nativeOutcome).toBe("completed");
      const old=f.localStore!.nativeTools("main","logical-1");expect(old).toHaveLength(1);expect(old[0].record.result).toContain("OWN_FACT");expect(old[0].persistence).toBe("committed");
      const native=f.localStore!.nativeHistory("main","logical-1");
      const begins=native.filter(e=>e.kind==="tool_use"),ends=native.filter(e=>e.kind==="tool_result");
      expect(begins).toHaveLength(1);expect(ends).toHaveLength(1);
      expect(matchesNativeToolRecord(begins[0],ends[0],old[0])).toBe(true);
      expect(ends[0].toolOutput).toContain(old[0].record.digest);
      if(engine==="mcp"){expect(begins[0].toolServer).toBe(`foundry_${old[0].record.bridgeId.replaceAll("-","")}`);expect(ends[0].toolMethod).toBe("foundry_query");}
      const bytes=JSON.stringify(old);await f.post(stream);
      const next=f.localStore!.nativeTools("main","logical-2");expect(next).toHaveLength(1);expect(next[0].record.bridgeId).toBe(old[0].record.bridgeId);
      expect(next[0].record.association.admissionId).not.toBe(old[0].record.association.admissionId);expect(JSON.stringify(old)).toBe(bytes);
      expect(f.counts()).toEqual({writes:2,spawns:1});
      const history=await (await f.app.request("/api/messages?threadId=main")).json() as any;
      expect(history.messages.filter((m:any)=>m.actor==="agent").every((m:any)=>m.meta.nativeTools.length===1)).toBe(true);
    }finally{await f.close();}
  });
  test(`${engine} ${stream?"streamed":"HTTP"}: tool and completed-output SQL failures remain independent of native success`,async()=>{
    const f=await fixture(engine);try{
      const db=(f.localStore as any).db;
      db.exec("CREATE TEMP TRIGGER deny_tool BEFORE INSERT ON session_native_tools BEGIN SELECT RAISE(ABORT,'TOOL_WRITE'); END");
      db.exec("CREATE TEMP TRIGGER deny_output BEFORE INSERT ON session_messages WHEN NEW.actor='agent' BEGIN SELECT RAISE(ABORT,'OUTPUT_WRITE'); END");
      const r=await f.post(stream);expect(r.body.output).toBe("COMPLETE");expect(r.body.meta.nativeOutcome).toBe("completed");expect(r.body.meta.persistence).toBe("failed");
      expect(r.body.meta.native.bridge.tools[0].persistence).toBe("failed");expect(r.body.meta.partialOutput).toBeUndefined();expect(f.counts().writes).toBe(1);
    }finally{await f.close();}
  });
}
test("MCP bridge result and completed native terminal survive subsequent RPC error",async()=>{const f=await fixture("mcp","rpc-error");try{const r=await f.post();expect(r.body.output).toBe("COMPLETE");expect(r.body.meta.native.localOutcome).toBe("rejected");expect(f.localStore!.nativeTools("main")[0].persistence).toBe("committed");}finally{await f.close();}});
for(const engine of ["claude","mcp"] as const)test(`${engine}: rejected prewrite registration prevents SDK tool operation and native write`,async()=>{
  const f=await fixture(engine);try{(f.localStore as any).db.exec("CREATE TEMP TRIGGER deny_registration BEFORE INSERT ON session_native BEGIN SELECT RAISE(ABORT,'NO_ADMISSION'); END");const r=await f.post();expect(r.status).toBe(500);expect(r.body.error).toContain("NO_ADMISSION");expect(f.counts().writes).toBe(0);expect(f.replies).toHaveLength(0);expect(f.localStore!.nativeTools("main")).toHaveLength(0);}finally{await f.close();}
  expect(f.resources().controlledExited).toBe(true);expect(f.resources().proxyPid).toBeNull();expect(f.resources().bridges.every(b=>b?.closed&&!b.pendingCleanups&&!b.cleanupFailures)).toBe(true);
});

test("fixture MCP startup cannot acknowledge initialize ahead of its held real SDK handshake",async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const f=await fixture("mcp","success",{connectGate:gate});
  let pending:ReturnType<typeof f.post>|undefined;
  try {
    (f.localStore as any).db.exec("CREATE TEMP TRIGGER deny_registration BEFORE INSERT ON session_native BEGIN SELECT RAISE(ABORT,'NO_ADMISSION'); END");
    pending=f.post();await f.lifecycle.step("controlled-spawn-observed",async()=>{while(f.counts().spawns===0)await Bun.sleep(1);});await Bun.sleep(10);
    expect(f.counts()).toEqual({spawns:1,writes:0});expect(f.localStore!.nativeHistory("main","logical-1")).toHaveLength(0);
    release();const result=await pending;expect(result.body.error).toContain("NO_ADMISSION");expect(f.counts().writes).toBe(0);expect(f.replies).toHaveLength(0);
  }finally{release();await pending;await f.close();}
  expect(f.resources().proxyPid).toBeNull();expect(f.lifecycle.phases.filter(p=>p.name.startsWith("cleanup:")).every(p=>p.status==="completed")).toBe(true);
});

for(const engine of ["claude","mcp"] as const)test(`${engine} fixture SDK handshake rejection is retained and cannot skip owned cleanup`,async()=>{
  const f=await fixture(engine,"success",{handshakeFailure:true});
  (f.localStore as any).db.exec("CREATE TEMP TRIGGER deny_registration BEFORE INSERT ON session_native BEGIN SELECT RAISE(ABORT,'NO_ADMISSION'); END");
  const result=await f.post();expect(result.status).toBe(500);expect(f.counts().writes).toBe(0);expect(f.replies).toHaveLength(0);expect(f.localStore!.nativeTools("main")).toHaveLength(0);
  let failure:unknown;try{await f.close();}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(AggregateError);expect((failure as AggregateError).errors.some(e=>e.code===-32000)).toBe(true);
  expect(f.lifecycle.phases.find(p=>p.name==="cleanup:proxy-ready")?.status).toBe("failed");
  for(const name of ["sdk-client","sdk-transport","controlled-exit","bridge","thread","runtime","journal","directory"])expect(f.lifecycle.phases.find(p=>p.name===`cleanup:${name}`)?.status).toBe("completed");
  expect(f.resources().controlledExited).toBe(true);expect(f.resources().proxyPid).toBeNull();expect(f.resources().runtimeDisposed).toBe(true);
  expect(f.resources().bridges.every(b=>b?.closed&&!b.pendingCleanups&&!b.cleanupFailures)).toBe(true);expect(await access(f.dir).then(()=>true,()=>false)).toBe(false);
});

test("fixture partial setup failure disposes acquired runtime and thread before removing its directory",async()=>{
  const lifecycle=new FixtureLifecycle();await expect(fixture("mcp","success",{setupFailure:true,lifecycle})).rejects.toThrow("CONTROLLED_PARTIAL_SETUP");
  for(const name of ["thread","runtime","directory"])expect(lifecycle.phases.find(p=>p.name===`cleanup:${name}`)?.status).toBe("completed");
  expect(lifecycle.phases.some(p=>p.name==="sdk-connect")).toBe(false);
});

for(const engine of ["claude","mcp"] as const)test(`${engine} fixture failed SDK work rejects the local waiter without inventing native completion`,async()=>{
  const f=await fixture(engine,"success",{toolFailure:true});
  const result=await f.post();expect(result.status).toBe(500);expect(result.body.meta.nativeOutcome).toBe("unknown");expect(f.counts()).toEqual({spawns:1,writes:1});expect(f.replies).toHaveLength(0);
  let failure:unknown;try{await f.close();}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(AggregateError);expect((failure as AggregateError).errors.some(e=>e.message==="CONTROLLED_SDK_TOOL_REJECTION")).toBe(true);
  expect(f.resources().proxyPid).toBeNull();expect(f.resources().controlledExited).toBe(true);expect(f.resources().bridges.every(b=>b?.closed&&!b.pendingCleanups&&!b.cleanupFailures)).toBe(true);
});

if(process.env.FOUNDRY_QA_PLAYWRIGHT)test("fixture fresh-browser failure records exact phase, screenshots and complete owned cleanup",async()=>{
  let failure:any;try{await browserEvidence("mcp","fresh-observation");}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(AggregateError);expect(failure.report.failedPhase).toBe("fresh-controlled-missing-evidence");expect(failure.report.passed).toBe(false);
  expect(failure.report.cleanupFailures).toBe(0);expect(failure.report.counts).toEqual({spawns:1,writes:1});expect(failure.report.resources.proxyPid).toBeNull();
  expect(failure.report.resources.controlledExited).toBe(true);expect(failure.report.resources.bridges.every((b:any)=>b.closed&&!b.pendingCleanups&&!b.cleanupFailures)).toBe(true);
  await access(join(failure.output,"failure-0.png"));await access(join(failure.output,"failure-1.png"));await access(join(failure.output,"report.json"));
},30000);
for(const engine of ["claude","mcp"] as const){
  test(`${engine}: actual installed late terminal frees only its registered bridge lease`,async()=>{
    const f=await fixture(engine,"late");try{
      const first=await f.post();expect(first.body.meta.nativeOutcome).toBe("unknown");
      const snapshot=JSON.stringify(f.localStore!.traceForTurn("logical-1"));
      const refused=await f.post(false,"refused");expect(refused.status).toBe(500);expect(f.counts().writes).toBe(1);
      await f.settle();expect(f.localStore!.nativeHistory("main","logical-1").some(e=>e.nativeOutcome==="completed"&&e.owner?.messageId==="logical-1")).toBe(true);
      expect(f.localStore!.nativeHistory("main","refused").some(e=>e.nativeOutcome==="completed")).toBe(false);
      const next=await f.post();expect(next.status).toBe(200);expect(next.body.output).toBe("COMPLETE");
      expect(f.counts()).toEqual({writes:2,spawns:1});expect(JSON.stringify(f.localStore!.traceForTurn("logical-1"))).toBe(snapshot);
      expect(await f.bindings.load("main",engine==="claude"?"claude-code":"codex")).toBe("own");
    }finally{await f.close();}
  });
  test(`${engine}: warm owner change is refused without a second process or native write`,async()=>{
    const f=await fixture(engine);try{await f.post();
      await expect(f.provider.complete([{role:"user",content:"no replay"}],{threadId:"main",model:"changed"})).rejects.toThrow("profile");
      f.thread.meta.projectId="foreign";const r=await f.post();expect(r.status).toBe(503); // existing directory guard refuses an unavailable project before dispatch
      expect(f.counts()).toEqual({spawns:1,writes:1});expect(await f.bindings.load("main",engine==="claude"?"claude-code":"codex")).toBe("own");}finally{await f.close();}
  });
  test(`${engine}: original native write failure keeps bridge work unexecuted and unknown admission owned`,async()=>{
    const f=await fixture(engine,"write-failed");try{const r=await f.post();expect(r.status).toBe(500);expect(f.replies).toHaveLength(0);expect(f.localStore!.nativeTools("main")).toHaveLength(0);expect(f.counts().writes).toBe(1);await f.post(false,"refused");expect(f.counts()).toEqual({spawns:1,writes:1});}finally{await f.close();}
  });
}
for(const stream of [false,true])for(const mode of ["tool-error","tool-transport-error","non-text","foreign-duplicate"] as const)test(`MCP ${stream?"streamed":"HTTP"} ${mode}: typed tool outcome stays separate from completed turn`,async()=>{
  const f=await fixture("mcp",mode);try{
    const r=await f.post(stream);expect(r.body.output).toBe("COMPLETE");expect(r.body.meta.native.nativeOutcome).toBe("completed");
    const native=f.localStore!.nativeHistory("main","logical-1"),begins=native.filter(e=>e.kind==="tool_use"),ends=native.filter(e=>e.kind==="tool_result");
    expect(begins).toHaveLength(1);expect(ends).toHaveLength(1);expect(ends[0].callId).toBe(begins[0].callId);
    if(mode==="non-text"){expect(ends[0].toolOutputOmitted).toBe(true);expect(JSON.stringify(ends)).not.toContain("PRIVATE_BINARY");}
    else if(mode==="foreign-duplicate")expect(matchesNativeToolRecord(begins[0],ends[0],f.localStore!.nativeTools("main","logical-1")[0])).toBe(true);
    else expect(ends[0].toolError).toBe(true);
    expect(f.counts()).toEqual({writes:1,spawns:1});
  }finally{await f.close();}
});
