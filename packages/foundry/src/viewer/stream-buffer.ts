import { sameNativeOwner, type NativeEvidence } from '@inixiative/foundry-core';

export interface LiveActivity { id:string; kind:'text'|'tool'; text?:string; phase?:string; toolName?:string; state?:'running'|'completed'|'failed'; admissionId:string; itemId?:string; callId?:string }
export interface StreamBufferSnapshot {
  readonly messageId:string; readonly threadId:string; readonly projectId?:string;
  readonly content:string; readonly startedAt:number;
  readonly completedAt?:number; readonly error?:string; readonly status:'accepted'|'running'|'completed'|'failed';
  readonly activity:readonly LiveActivity[]; readonly truncated:boolean; readonly nativeDetail:'available'|'unavailable';
  readonly terminal?:Record<string,unknown>;
  readonly native?: { outcome:'unknown'|'completed'|'failed'; rpc:'unknown'|'pending'|'resolved'|'failed' };
  readonly notificationFailed?:boolean;
}
/** What changed in one turn: text appended to its content, one activity row, or anything else (send the whole turn). */
export type TurnChange={kind:'delta';text:string}|{kind:'activity';row:LiveActivity}|{kind:'turn'};
/** Thread data-stream appends produced by live turns. */
export type TurnAppend={kind:'turn';turn:StreamBufferSnapshot}|{kind:'delta';turnId:string;text:string}|{kind:'activity';turnId:string;row:LiveActivity};
export interface TurnSink { active(threadId:string):boolean; publish(threadId:string,payload:TurnAppend):void }
/** Bounded live projection, separate from the original journal. No native capacity decisions. */
export class StreamBuffer {
  readonly startedAt=Date.now(); private _content=''; private _completedAt?:number; private _error?:string;
  private _status:StreamBufferSnapshot['status']='accepted';
  private _activity:LiveActivity[]=[]; private _truncated=false; private _terminal?:Record<string,unknown>;
  private _admissions=new Map<string,NativeEvidence>();
  private _native=new Map<string,NativeEvidence>();
  private _notificationFailed=false;
  notificationFailed(){this._notificationFailed=true;}
  constructor(readonly messageId:string,readonly threadId:string,readonly projectId?:string,private changed:(change:TurnChange)=>void=()=>{}){}
  private touch(){this.changed({kind:'turn'});}
  private bound(text:string,limit=32768){if(text.length>limit)this._truncated=true;return text.slice(-limit);}
  private terminal(value?:Record<string,unknown>){if(!value)return undefined;
    const m=value.meta as Record<string,unknown>|undefined;
    // Inspector loads full immutable detail from its existing journal route. The watch
    // projection carries status/identity only, never provider inputs or phase/private data.
    const meta=m?Object.fromEntries(['turnStatus','persistence','executionOutcome','nativeOutcome','attemptOutcome','notification','inputEvidence','deliveryAcknowledgment']
      .filter(k=>typeof m[k]==='string').map(k=>[k,m[k]])):undefined;
    return {id:this.messageId,traceId:typeof value.traceId==='string'?value.traceId:undefined,meta};
  }
  append(text:string){if(this.done||this._admissions.size)return;const truncated=this._truncated;this._content=this.bound(this._content+text);this._status='running';
    // Viewers keep the same 32 KiB tail (applyTurnFrame); the turn that first drops the head says so.
    this.changed(this._truncated&&!truncated?{kind:'turn'}:{kind:'delta',text});}
  register(e:NativeEvidence){if(this.done||!e.admissionId||e.owner?.threadId!==this.threadId||e.owner.projectId!==this.projectId||e.owner.messageId!==this.messageId||e.owner.providerSessionKey!==this.threadId)return;
    if(this._admissions.has(e.admissionId))return;
    if(this._admissions.size>=64){this._truncated=true;return;}this._admissions.set(e.admissionId,e);this._native.set(e.admissionId,e);this._status='running';this.touch();}
  observe(e:NativeEvidence){const registered=e.admissionId&&this._admissions.get(e.admissionId);
    if(!registered||!sameNativeOwner(e.owner,registered.owner)||e.correlation==='unknown')return;
    if((['nativeSessionId','externalSessionId','threadId','turnId'] as const).some(k=>e[k]&&registered[k]&&e[k]!==registered[k]))return;
    const prior=this._native.get(e.admissionId!)!;
    // Late original terminal updates observed native state only. Frozen local completion,
    // answer, input and prior public activity never become a new message or admission.
    if(e.nativeOutcome!=='unknown'||e.rpcOutcome){const next={...prior,...e};
      if(prior.nativeOutcome!=='unknown'&&e.nativeOutcome==='unknown')next.nativeOutcome=prior.nativeOutcome;
      if(prior.rpcOutcome==='resolved'&&e.rpcOutcome==='pending')next.rpcOutcome='resolved';
      if(next.nativeOutcome!==prior.nativeOutcome||next.rpcOutcome!==prior.rpcOutcome){this._native.set(e.admissionId!,next);this.touch();}}
    if(this.done)return;
    if(!['text','text_delta','tool_use','tool_start','tool_result','tool_end'].includes(e.kind??''))return;
    const tool=e.kind!.startsWith('tool'), identity=e.callId??e.itemId;
    if(tool&&!identity)return; // No inferred tool join.
    const key=`${e.admissionId}:${tool?'tool':'text'}:${identity??'public'}`;
    const old=this._activity.find(a=>a.id===key);
    const row:LiveActivity=tool?{id:key,kind:'tool',admissionId:e.admissionId!,itemId:e.itemId,callId:e.callId,toolName:e.toolName??old?.toolName??'Tool',
      state:e.kind==='tool_result'||e.kind==='tool_end'?(e.toolError?'failed':'completed'):'running'}:
      {id:key,kind:'text',admissionId:e.admissionId!,itemId:e.itemId,phase:e.textPhase??'unavailable',text:this.bound(e.textKind==='delta'||e.kind==='text_delta'?(old?.text??'')+(e.text??''):e.text??'',4096)};
    if(tool&&old?.state!=='running'&&old?.state&&row.state==='running')return;
    if(JSON.stringify(old)===JSON.stringify(row))return;
    if(old)this._activity[this._activity.indexOf(old)]=row;else this._activity.push(row);
    if(this._activity.length>64){this._activity.shift();this._truncated=true;this.touch();return;}
    this.changed({kind:'activity',row});
  }
  complete(terminal?:Record<string,unknown>){if(this.done)return;this._terminal=this.terminal(terminal);this._content=typeof terminal?.content==='string'?this.bound(terminal.content):this._content;
    this._activity=this._activity.filter(a=>a.phase!=='final_answer'); // original preview remains in the native journal
    this._completedAt=Date.now();this._status='completed';this.touch();}
  fail(error:string,terminal?:Record<string,unknown>){if(this.done)return;this._error='Execution failed; see recorded outcome.';this._terminal=this.terminal(terminal);this._completedAt=Date.now();this._status='failed';this.touch();}
  get content(){return this._content;} get done(){return this._completedAt!==undefined;} get error(){return this._error;}
  get unresolved(){return !this.done||[...this._native.values()].some(e=>e.nativeOutcome==='unknown'||e.rpcOutcome==='pending');}
  snapshot():StreamBufferSnapshot{const originals=[...this._native.values()];
    const native:StreamBufferSnapshot['native']=originals.length?{outcome:originals.some(e=>e.nativeOutcome==='unknown')?'unknown':originals.some(e=>e.nativeOutcome==='failed')?'failed':'completed',
      rpc:originals.some(e=>e.rpcOutcome==='pending')?'pending':originals.every(e=>e.rpcOutcome==='resolved')?'resolved':originals.some(e=>e.rpcOutcome==='failed')?'failed':'unknown'}:undefined;
    return structuredClone({messageId:this.messageId,threadId:this.threadId,projectId:this.projectId,content:this._content,
    startedAt:this.startedAt,completedAt:this._completedAt,error:this._error,status:this._status,activity:this._activity,truncated:this._truncated,nativeDetail:this._admissions.size?'available':'unavailable',terminal:this._terminal,native,notificationFailed:this._notificationFailed});}
}
/** Live turns by id. Changes go to the owning thread's data stream only while it is open. */
export class StreamBufferRegistry {
  private _buffers=new Map<string,StreamBuffer>();
  constructor(private sink?:TurnSink){}
  private publish(b:StreamBuffer,change:TurnChange){
    if(!this.sink?.active(b.threadId))return;
    const payload:TurnAppend=change.kind==='turn'?{kind:'turn',turn:b.snapshot()}:change.kind==='delta'?{kind:'delta',turnId:b.messageId,text:change.text}:{kind:'activity',turnId:b.messageId,row:structuredClone(change.row)};
    try{this.sink.publish(b.threadId,payload);}catch{b.notificationFailed();}
  }
  canOpen(id:string){this.prune();return !this._buffers.has(id)&&[...this._buffers.values()].filter(b=>b.unresolved).length<128;}
  open(id:string,threadId:string,projectId?:string){if(!this.canOpen(id))throw Error('Live turn already exists or capacity exhausted');
    const b:StreamBuffer=new StreamBuffer(id,threadId,projectId,change=>this.publish(b,change));this._buffers.set(id,b);this.publish(b,{kind:'turn'});return b;}
  get(id:string){return this._buffers.get(id);}
  // Terminal grace bridges journal/snapshot races, not a second durable audit store.
  drop(_id:string){this.prune();}
  private prune(){const completed=[...this._buffers.values()].filter(b=>b.done&&!b.unresolved);let excess=completed.length-128;
    for(const b of completed)if(excess-->0||Date.now()-(b.snapshot().completedAt??0)>300000)this._buffers.delete(b.messageId);}
  forThread(threadId:string){this.prune();return [...this._buffers.values()].filter(b=>b.threadId===threadId).map(b=>b.snapshot());}
}
