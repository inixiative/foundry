import { test, expect } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextLayer, ContextStack, Thread, ToolRegistry, type NativeEvidence } from "@inixiative/foundry-core";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { enrollLocalDevice } from "../src/devices/local-inventory";
import { starterConfig } from "../src/viewer/config";
import { nativeBridgeSource } from "../src/mcp/native-bridge";
import { LocalSessionStore } from "../src/persistence/local-session-store";
import { withNativeBridge, nativeLaunchEvidence } from "../src/providers/native-launch";
import { MemoryToolAdapter } from "../src/tools/memory-adapter";
import { ClaudeCodeSessionAdapter, CodexSessionAdapter, InMemoryExternalSessionStore } from "../src/providers/session-adapter";

const req = createRequire(new URL("../package.json", import.meta.url));
const { Client } = await import(req.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StdioClientTransport } = await import(req.resolve("@modelcontextprotocol/sdk/client/stdio.js"));

async function fixture(tools = new ToolRegistry(), deviceProfile = false) {
  const dir = await mkdtemp(join(tmpdir(), "foundry-t3-"));
  const layer = new ContextLayer({id:"memory"}); layer.set("OWN_PUBLIC_FACT");
  const thread = new Thread("owner", new ContextStack([layer]), {projectId:"P", ...(deviceProfile ? {cwd:dir} : {})});
  const identityPath = deviceProfile ? join(dir,"device.json") : undefined;
  const device = deviceProfile ? enrollLocalDevice("Controlled native device", identityPath) : null;
  const runtime = new ThreadRuntimeManager({config:starterConfig("fake","fake"), domains:[], llm:{id:"fake",async complete(){return {content:"{}",model:"fake"};}},log(){},warn(){}});
  runtime.attach(thread);
  const store = new LocalSessionStore(join(dir,"sessions.sqlite")); store.saveThread(thread);
  let publish = () => true;
  const source = nativeBridgeSource(thread,runtime,tools,record=>store.persistNativeTool(thread,record,()=>publish()),identityPath);
  const lease = await source.acquire();
  const cfg = JSON.parse(lease.launch.claudeJson).mcpServers[lease.name];
  const client = new Client({name:"controlled-t3",version:"1"});
  const transport = new StdioClientTransport({command:cfg.command,args:cfg.args,stderr:"pipe"});
  try { await client.connect(transport); } catch(error) {await lease.close();runtime.disposeAll();store.close();await rm(dir,{recursive:true,force:true});throw error;}
  const admit = (n:number):NativeEvidence => {
    const messageId=`message-${n}`;store.beginTurn(thread,messageId,"controlled");
    const e:NativeEvidence={schema:1,admissionId:`admission-${n}`,nativeOutcome:"unknown",dispatch:"not-dispatched",localOutcome:"pending",
      owner:{threadId:thread.id,projectId:"P",generation:runtime.get(thread.id)!.generation,messageId,dispatchId:`dispatch-${n}`}};
    store.registerNative(thread,e);lease.register(e);return e;
  };
  return {dir,thread,runtime,store,source,lease,client,admit,device,setPublish(fn:()=>boolean){publish=fn;},
    call:()=>client.callTool({name:"foundry_query",arguments:{topic:"OWN_PUBLIC_FACT",detail:"full"}}),
    async close(){await client.close();await lease.close();runtime.disposeAll();store.close();await rm(dir,{recursive:true,force:true});}};
}

test("real SDK proxy: startup stays unassociated; two registrations retain distinct immutable journal records",async()=>{
  const f=await fixture();try {
    await f.call();expect(f.lease.evidence()[0].record.association.kind).toBe("unassociated");
    const first=f.admit(1);await f.call();const old=f.lease.evidence(first.admissionId);const bytes=JSON.stringify(old);
    expect(old[0].record.association.owner).toEqual(first.owner);expect(old[0].record.result).toContain("OWN_PUBLIC_FACT");
    expect(old[0].record.nativeCorrelation).toBe("unknown");expect(old[0].persistence).toBe("committed");
    expect(()=>f.lease.register({...first,admissionId:"foreign"})).toThrow("unresolved");
    f.store.appendNative(f.thread,{...first,nativeOutcome:"completed"});
    f.lease.observe({...first,nativeOutcome:"completed"});const second=f.admit(2);await f.call();
    expect(f.lease.evidence(second.admissionId)).toHaveLength(1);expect(JSON.stringify(old)).toBe(bytes);
    expect(f.store.nativeTools("owner","message-1")).toHaveLength(1);
    f.store.close();const fresh=new LocalSessionStore(join(f.dir,"sessions.sqlite"));try{expect(fresh.nativeTools("owner","message-2")[0].record.association.owner).toEqual(second.owner);}finally{fresh.close();}
  }finally{await f.close();}
});

test("held SDK operation retains its start owner after a later admission and project reassignment",async()=>{
  let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  const tools=new ToolRegistry();
  const view={write:async()=>{},search:async()=>[],get:async()=>{entered();await held;return undefined;}};
  tools.register(MemoryToolAdapter.from("held",{...view,view:()=>view}),"Held scoped memory");
  const f=await fixture(tools);let pending:Promise<unknown>|undefined;
  try {
    const first=f.admit(1);
    pending=f.client.callTool({name:"foundry_memory",arguments:{id:"missing"}});await started;
    f.store.appendNative(f.thread,{...first,nativeOutcome:"completed"});f.lease.observe({...first,nativeOutcome:"completed"});
    f.admit(2);f.thread.meta.projectId="replacement-project";release();await pending;
    const old=f.store.nativeTools("owner","message-1");expect(old).toHaveLength(1);
    expect(old[0].record.status).toBe("refused");expect(old[0].record.owner.projectId).toBe("P");
    expect(old[0].record.association.owner).toEqual(first.owner);expect(old[0].persistence).toBe("committed");
    expect(f.store.nativeTools("owner","message-2")).toHaveLength(0);
  }finally{release();await pending?.catch(()=>{});await f.close();}
});

test("real SDK proxy: tool SQL failure and durable success/publication failure cannot veto delivered result",async()=>{
  const f=await fixture();try {
    f.admit(1);
    const db=(f.store as any).db;
    db.exec("CREATE TEMP TRIGGER deny_tool BEFORE INSERT ON session_native_tools BEGIN SELECT RAISE(ABORT,'deny'); END");
    const result=await f.call();expect(JSON.stringify(result)).toContain("OWN_PUBLIC_FACT");
    expect(f.store.nativeTools("owner").at(-1)?.persistence).toBe("failed");
    db.exec("DROP TRIGGER deny_tool");f.setPublish(()=>{throw Error("observer");});await f.call();
    const record=f.store.nativeTools("owner").at(-1)!;expect(record.persistence).toBe("committed");expect(record.publication).toBe("reconciliation-needed");
    f.store.close();const fresh=new LocalSessionStore(join(f.dir,"sessions.sqlite"));try{expect(fresh.nativeTools("owner")[0].publication).toBe("reconciliation-needed");}finally{fresh.close();}
  }finally{await f.close();}
});

test("bridge grant rejects foreign generation and disposed owner without adopting a new binding",async()=>{
  const f=await fixture();try {
    const e=f.admit(1);expect(()=>f.source.check({...e.owner!,generation:"other"})).toThrow("mismatch");
    expect(()=>f.lease.register({...e,owner:{...e.owner!,projectId:"other"}})).toThrow("mismatch");
    f.thread.dispose();expect(()=>f.lease.check()).toThrow("stale");await expect(f.source.acquire()).rejects.toThrow("stale");
  }finally{await f.close();}
});

test("foreign settlement and duplicate registration cannot release or rewrite the original admission",async()=>{
  const f=await fixture();try {
    const first=f.admit(1);
    f.lease.observe({...first,nativeOutcome:"completed",owner:{...first.owner!,dispatchId:"foreign-dispatch"}});
    expect(()=>f.lease.register({...first,admissionId:"second"})).toThrow("unresolved");
    expect(()=>f.lease.register({...first,owner:{...first.owner!,messageId:"foreign-message"}})).toThrow();
    await f.call();expect(f.lease.evidence(first.admissionId)[0].record.association.owner).toEqual(first.owner);
    f.lease.observe({...first,nativeOutcome:"completed"});expect(()=>f.lease.register(first)).toThrow("already registered");
  }finally{await f.close();}
});

test("launch composition preserves unrelated tools, model/effort/budget and sanitizes all values",async()=>{
  const f=await fixture();try {
    const prior=["claude","--model","chosen","--effort","max","--mcp-config",'{"mcpServers":{"existing":{"command":"existing"}}}',"--resume","owned"];
    const after=withNativeBridge(prior,"claude",f.lease);
    expect(after.filter(x=>x!==f.lease.launch.claudeJson)).toEqual(prior);
    expect(withNativeBridge(["claude","--mcp-config=old.json","--model","chosen"],"claude",f.lease)).toContain("old.json");
    for(const flag of ["--strict-mcp-config","--bare","--safe-mode"]) expect(()=>withNativeBridge(["claude",flag],"claude",f.lease)).toThrow("conflicts");
    expect(()=>withNativeBridge(["claude","--mcp-config",f.lease.launch.claudeJson],"claude",f.lease)).toThrow("collision");
    expect(()=>withNativeBridge(["claude","--mcp-config"],"claude",f.lease)).toThrow("Ambiguous");
    const mcp=["codex","mcp-server","-c","model=chosen","-c","mcp_servers.existing.command=other"];
    expect(withNativeBridge(mcp,"codex",f.lease).slice(0,mcp.length)).toEqual(mcp);
    const safe=JSON.stringify(nativeLaunchEvidence([...after,"--config=token=PRIVATE_SECRET","--system-prompt","REASONING_PAYLOAD","123456"]));
    expect(safe).not.toMatch(/PRIVATE_SECRET|REASONING_PAYLOAD|123456|chosen|mcpServers|owned/);
    expect(Object.isFrozen(nativeLaunchEvidence(after)[0])).toBe(true);
  }finally{await f.close();}
});

for(const engine of ["claude","mcp"] as const)test(`${engine}: an auxiliary cannot receive the launch capability`,async()=>{
  const f=await fixture();let spawns=0;
  try {
    const defaults={spawn:()=>{spawns++;throw Error("must not launch");}};
    const adapter=engine==="claude"?new ClaudeCodeSessionAdapter({store:new InMemoryExternalSessionStore(),defaults}):new CodexSessionAdapter({store:new InMemoryExternalSessionStore(),defaults});
    await expect(adapter.createSession({threadId:"owner:aux:review:memory",cwd:f.dir,nativeBridge:f.lease,tools:false})).rejects.toThrow();
    expect(spawns).toBe(0);
  }finally{await f.close();}
});


test("real SDK proxy carries the isolated device profile and journals scoped device context",async()=>{
  const f=await fixture(new ToolRegistry(),true);try {
    const admission=f.admit(1);
    const result=await f.client.callTool({name:"foundry_device",arguments:{}});
    const inventory=JSON.parse(result.content[0].text);
    expect(inventory.device.id).toBe(f.device!.id);
    expect(inventory.checkouts).toHaveLength(1);
    expect(inventory.checkouts[0]).toMatchObject({projectId:"P",path:f.dir,observation:"session-bound"});
    const records=f.lease.evidence(admission.admissionId);
    expect(records).toHaveLength(1);
    expect(records[0].record.operation).toBe("foundry_device");
    expect(records[0].persistence).toBe("committed");
  }finally{await f.close();}
});
