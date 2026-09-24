/** Portable SHA-256 for public evidence, shared by Bun and the historical browser.
 * This is an integrity join, not a signature or native delivery acknowledgment. */
export function evidenceDigest(text: string): string {
  const input = new TextEncoder().encode(text), bytes = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  bytes.set(input); bytes[input.length] = 128;
  const view = new DataView(bytes.buffer), bits = input.length * 8;
  view.setUint32(bytes.length - 8, Math.floor(bits / 4294967296)); view.setUint32(bytes.length - 4, bits >>> 0);
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const rr = (v: number, n: number) => (v >>> n) | (v << (32 - n)), w = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + 4 * i);
    for (let i = 16; i < 64; i++) { const x=w[i-15]!, y=w[i-2]!; w[i]=w[i-16]!+(rr(x,7)^rr(x,18)^(x>>>3))+w[i-7]!+(rr(y,17)^rr(y,19)^(y>>>10)); }
    let [a,b,c,d,e,f,g,j] = h as [number,number,number,number,number,number,number,number];
    for (let i=0;i<64;i++) { const t=(j+(rr(e,6)^rr(e,11)^rr(e,25))+((e&f)^(~e&g))+k[i]!+w[i]!)|0;
      const u=((rr(a,2)^rr(a,13)^rr(a,22))+((a&b)^(a&c)^(b&c)))|0; j=g;g=f;f=e;e=(d+t)|0;d=c;c=b;b=a;a=(t+u)|0; }
    [a,b,c,d,e,f,g,j].forEach((v,i)=>{h[i]=(h[i]!+v)>>>0;});
  }
  return h.map(v=>v.toString(16).padStart(8,"0")).join("");
}

export interface DeliveryOwner { threadId: string; messageId: string; projectId?: string }
export interface ProviderBoundaryReceipt {
  schema: 1; owner: DeliveryOwner; assemblyHash: string; messagesHash: string;
  /** Exactly one initial system message starts with the assembled context. */
  systemMessageIndex: number;
}
// Fixed top-level field order over the preserved serialization, never the current cache.
export function assemblyDigest(i: any): string {
  return evidenceDigest(JSON.stringify([i.threadId,i.projectId ?? null,i.messageId,i.executorContext,i.userMessage,
    i.layers,i.blocks,i.decoration]));
}
export function boundaryReceipt(i: any, owner: DeliveryOwner): ProviderBoundaryReceipt {
  const matches = i.providerMessages.flatMap((m: any, n: number) => m.role === "system" && typeof m.content === "string"
    && typeof i.executorContext === "string" && i.executorContext.length > 0
    && (m.content === i.executorContext || m.content.startsWith(i.executorContext + "\n\n")) ? [n] : []);
  return { schema: 1, owner: { ...owner }, assemblyHash: assemblyDigest(i),
    messagesHash: evidenceDigest(JSON.stringify(i.providerMessages)), systemMessageIndex: matches.length === 1 ? matches[0] : -1 };
}
export interface ExpertDeliveryProof {
  domain: string; layerId: string; assessedRevision: number; deliveredRevision: number;
  deliveredHash: string; relation: "assessed" | "advanced"; content: string;
}
/** One validation contract used by inspection, the runner and the copy-only audit. */
export function verifyExpertDelivery(i: any, delivery: any, domain: string, expected: DeliveryOwner): ExpertDeliveryProof {
  const fail = () => { throw Error("Recorded expert delivery invalid"); };
  const one = (rows: any, predicate: (row: any) => boolean): any => {
    if (!Array.isArray(rows)) return fail(); const found = rows.filter(predicate); return found.length === 1 ? found[0] : fail();
  };
  const owner = (x: any) => x?.threadId === expected.threadId && x?.projectId === expected.projectId;
  const receipt = i?.providerBoundary;
  if (!expected.threadId || !expected.messageId || !owner(i) || i.messageId !== expected.messageId
    || !owner(i.decoration?.input?.currentMessage) || i.decoration.input.currentMessage.messageId !== expected.messageId
    || receipt?.schema !== 1 || !owner(receipt.owner) || receipt.owner.messageId !== expected.messageId
    || receipt.assemblyHash !== assemblyDigest(i) || !Array.isArray(i.providerMessages)
    || receipt.messagesHash !== evidenceDigest(JSON.stringify(i.providerMessages))) fail();
  const system = i.providerMessages[receipt.systemMessageIndex];
  if (!Number.isSafeInteger(receipt.systemMessageIndex) || system?.role !== "system" || typeof system.content !== "string"
    || !i.executorContext || !(system.content === i.executorContext || system.content.startsWith(i.executorContext + "\n\n"))) fail();
  const p = one(i.decoration?.participants, p => p?.id === domain), id = `thread-knowledge:${domain}`;
  const e = one(delivery?.layers, e => e?.id === id), l = one(i.layers, l => l?.id === id);
  if (new Set(delivery.layers.map((row: any) => row?.id)).size !== delivery.layers.length) fail();
  for (const row of delivery.layers.filter((x: any) => x?.domain === domain && x.id !== id)) {
    const cache = one(i.layers, l => l?.id === row.id);
    if (!owner(cache) || !owner(row) || cache.included !== true || row.assessedRevision !== undefined
      || row.relation !== undefined || row.assessedHash !== p.provenance?.cacheHash
      || row.deliveredHash !== cache.hash || row.drift !== (row.assessedHash !== row.deliveredHash)) fail();
  }
  if (delivery.layers.filter((e: any) => e?.domain === domain && e?.assessedRevision !== undefined).length !== 1) fail();
  const v=l.version, ar=p.provenance?.threadKnowledgeRevision, ah=p.provenance?.threadKnowledgeHash, r=e.deliveredRevision;
  if (!owner(l) || l.included !== true || l.segment !== "thread-knowledge" || l.definitionId !== id
    || !owner(v) || v?.domain !== domain || e.domain !== domain || !owner(e)
    || !Number.isSafeInteger(ar) || ar < 0 || !Number.isSafeInteger(r) || r < 0
    || e.assessedRevision !== ar || e.assessedHash !== ah || typeof ah !== "string"
    || typeof p.segments?.threadKnowledge !== "string" || typeof l.content !== "string"
    || e.deliveredHash !== l.hash || v.hash !== l.hash || v.revision !== r
    || e.drift !== (e.assessedHash !== e.deliveredHash)
    || (e.relation === "assessed" ? r !== ar || ah !== l.hash : e.relation === "advanced" ? r <= ar : true)) fail();
  const b = one(i.blocks, b => b?.source === id && b.kind === "thread-knowledge");
  if (b.text !== l.content || b.hash !== l.hash || b.id !== `thread-knowledge:${id}:${l.hash}`) fail();
  // Intended assembled block, not a matching quotation in the user message.
  const body = i.blocks.map((b: any) => b.text).join("\n\n");
  if (body !== i.executorContext) fail();
  return { domain, layerId:id, assessedRevision:ar, deliveredRevision:r, deliveredHash:l.hash, relation:e.relation, content:l.content };
}
