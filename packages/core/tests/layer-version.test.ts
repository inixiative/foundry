import { expect, test } from "bun:test";
import { ContextLayer, computeHash } from "../src/context-layer";
import { evidenceDigest } from "../src/delivery-evidence";

test("portable evidence hashes agree with SHA256, including UTF8 and block boundaries", () => {
  for (const s of ["", "abc", "🙂é中", "x".repeat(55), "x".repeat(64), "x".repeat(130)])
    expect(evidenceDigest(s)).toBe(new Bun.CryptoHasher("sha256").update(s).digest("hex"));
});
test("version identity survives exact restore/clone, not foreign or unversioned writes, including identical bytes", async () => {
  const owner={threadId:"T",projectId:"P"}; const layer=new ContextLayer({id:"owned",owner,sources:[{id:"source",async load(){return "same";}}]});
  const mark=()=>layer.markVersion({...owner,domain:"architecture",revision:2,hash:computeHash("same")});
  layer.set("same");mark();const old=layer.snapshotInstance();
  expect(layer.clone(owner).version?.revision).toBe(2);
  expect(layer.clone({threadId:"B",projectId:"P"}).version).toBeUndefined();
  expect(layer.clone({threadId:"T",projectId:"Q"}).version).toBeUndefined();
  await layer.warm();expect(layer.version).toBeUndefined();mark();layer.set("same","compress");expect(layer.version).toBeUndefined();
  layer.restoreInstance(old);expect(layer.version?.revision).toBe(2);
  layer.restoreInstance({...old,threadId:"B"});expect(layer.version).toBeUndefined();
  layer.restoreInstance({...old,definitionId:"other"});expect(layer.version).toBeUndefined();
  layer.restoreInstance({...old,content:"changed"});expect(layer.version).toBeUndefined();
  layer.restoreInstance(old);layer.clear();expect(layer.version).toBeUndefined();expect(old.version?.revision).toBe(2);
  const defined=ContextLayer.fromDefinition({id:"defined"},[],{owner});defined.set("same");
  expect(()=>defined.markVersion({...owner,threadId:"foreign",revision:1,hash:computeHash("same")})).toThrow();
  defined.markVersion({...owner,revision:1,hash:computeHash("same")});expect(defined.snapshotInstance().projectId).toBe("P");
});
test("invalid version marks never replace a valid mark", () => {
  const owner={threadId:"T",projectId:"P"};const layer=new ContextLayer({id:"l",owner});layer.set("x");
  const good={...owner,revision:1,hash:computeHash("x"),domain:"testing"};layer.markVersion(good);
  for(const delta of [{revision:-1},{revision:1.1},{revision:NaN},{revision:Infinity},{revision:Number.MAX_SAFE_INTEGER+1},{hash:"foreign"},{threadId:"B"},{projectId:"Q"},{domain:""},{author:""}]) {
    expect(()=>layer.markVersion({...good,...delta})).toThrow();expect(layer.version).toEqual(good);
    layer.restoreInstance({...layer.snapshotInstance(),version:{...good,...delta}});expect(layer.version).toBeUndefined();layer.markVersion(good);
  }
});
