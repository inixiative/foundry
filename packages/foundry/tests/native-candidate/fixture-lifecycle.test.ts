import { test, expect } from "bun:test";
import { FixtureLifecycle, throwFixtureFailures } from "./fixture-lifecycle";

test("fixture cleanup runs every owned handle once and retains original error identities",async()=>{
  const lifecycle=new FixtureLifecycle();const primary=Error("original observation");const rejected=Error("owned cleanup");const calls:string[]=[];
  lifecycle.own("first",0,()=>{calls.push("first");throw rejected;});lifecycle.own("last",1,()=>{calls.push("last");});
  const errors=await lifecycle.cleanup();expect(await lifecycle.cleanup()).toBe(errors);expect(calls).toEqual(["first","last"]);expect(errors).toEqual([rejected]);
  try{throwFixtureFailures(primary,errors);}catch(error){expect((error as AggregateError).cause).toBe(primary);expect((error as AggregateError).errors).toEqual([primary,rejected]);}
});
test("bounded failed observation remains failed after late completion; cleanup still runs",async()=>{
  const lifecycle=new FixtureLifecycle();let release!:()=>void;const late=new Promise<void>(r=>{release=r;});let cleaned=false;
  lifecycle.own("handle",0,()=>{cleaned=true;});
  try {await expect(lifecycle.step("held observation",()=>late,5)).rejects.toThrow("Fixture phase deadline");expect(lifecycle.phases[0].status).toBe("failed");}
  finally{release();await late;expect(await lifecycle.cleanup()).toEqual([]);}
  expect(cleaned).toBe(true);expect(lifecycle.phases[0].status).toBe("failed");
});
test("a resource acquired after setup observation expires is still owned and closed",async()=>{
  const lifecycle=new FixtureLifecycle();let release!:(value:object)=>void;const pending=new Promise<object>(r=>{release=r;});const resource={};const closed:object[]=[];
  await expect(lifecycle.acquire("late-browser",0,()=>pending,value=>{closed.push(value);},5)).rejects.toThrow("Fixture phase deadline");
  const cleaning=lifecycle.cleanup();release(resource);expect(await cleaning).toEqual([]);expect(closed).toEqual([resource]);expect(lifecycle.phases[0].status).toBe("failed");
});
