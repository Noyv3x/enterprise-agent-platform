import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { ServerResponse } from 'node:http';
import { createAgentSession, createExtensionRuntime, loadSkillsFromDir, SettingsManager, SessionManager, type AgentSession, type AgentSessionEvent, type ModelRuntime, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { createModelRuntime } from './credentials.js';
import { sessionPath } from './session-path.js';
import { compactSession, compactStored, type CompactionOutcome } from './compact.js';
import { createTools } from './tools.js';
import { createExecutorTransport, createGatewayTransport } from './transport.js';
import { bindModelSession, resolveModel } from './models.js';
import { RunEvents } from './events.js';
import type { AssistantMessageEvent, UserMessage } from '@earendil-works/pi-ai';
import { LiveBuffer } from './live-events.js';

export interface RunRequest {
  kind: 'agent' | 'chat' | 'subagent';
  sandbox: {scope_key:string; workspace_id:string; sandbox_id:string; lifecycle_id:string; profile:'agent'|'chat'; cwd:string};
  model: {id:string; thinking:ThinkingLevel; contextWindow?:number; maxTokens?:number};
  prompt: {text:string; images?:{mime:string; data:string}[]};
  context_prefix?:string;
  resources: {system_prompt:string; agents_md?:{path:string;content:string}|null; skills:{name:string;description:string;path:string}[]};
  tools:string[];
}
export interface SteerRequest {
  input_id:string;
  prompt:Required<RunRequest['prompt']>;
  context_prefix:string;
}
export interface RuntimeConfig {
  home:string; platformUrl:string; platformToken:string; executorSocket:string; executorToken:string; skillsDirectory:string;
  // Injecting a model runtime permits exercising the real Pi session with a faux provider.
  modelRuntimeFactory?: (modelId:string) => Promise<ModelRuntime>;
  // Foreground time before personal bash promotes a command to the background; tests shorten the 60 s default.
  promoteAfterMs?: number;
}
type Event = {type:string;[key:string]:unknown};
type PendingInput = {message:UserMessage;text:string};
type Run = {id:string; sid:string; events:RunEvents; done:boolean; cancelled:boolean; acceptingInput:boolean; initialInputPending:boolean; acceptedInputs:Set<string>; pendingInputs:Map<string,PendingInput>; sideEffects:boolean; controller:AbortController; stopping?:Promise<void>; stopConfirmed:Promise<void>; confirmStop:()=>void; finished:Promise<void>; finish:()=>void; endedAt:number; usage:{input:number;output:number;cache_read:number;cache_write:number;total:number}; text:string; error?:string};
// `key` identifies the Platform-supplied inputs the Pi session object was built from.
type Live = {session:AgentSession; manager:SessionManager; models:ModelRuntime; request:RunRequest; key:string; runId:string; lastUsed:number; watchers:Set<()=>void>};
type Cancellation = {cancelled:boolean;run_id:string|null};
interface RunStreams {inputs:Map<number,LiveBuffer>; outputs:Map<string,LiveBuffer>}
const runStreams=new WeakMap<Run,RunStreams>();
const INPUT_INTERVAL_MS=100;
const OUTPUT_INTERVAL_MS=125;
const OUTPUT_LIMIT_BYTES=512*1024;
const MAX_PENDING_INPUTS=32;
export function failure(status:number,message:string): Error & {status:number} { return Object.assign(new Error(message),{status}); }
const chatTools:Record<string,true> = {read:true,bash:true,edit:true,write:true,grep:true,find:true,ls:true,web_search:true,web_fetch:true};
const subagentTools=['read','bash','edit','write','grep','find','ls','web_search','web_fetch'];
// A subagent only exists as a delegate scope of one personal user, on that user's own child session ID.
function validateSubagent(sid:string,request:RunRequest):void {
  const match=/^private:(\d+)\/delegate\/bg-(\d+)$/.exec(request.sandbox.scope_key);
  if(!match||sid!==`agent-private-${match[1]}-bg-${match[2]}`)throw failure(400,'Subagent runs need a private delegate scope and matching session ID');
  if(request.sandbox.profile!=='agent')throw failure(400,'Subagent runs need the agent profile');
  if(!request.tools.every(name=>subagentTools.includes(name)))throw failure(400,'Invalid subagent tools');
}

function loader(request:RunRequest):ResourceLoader {
  const runtime = createExtensionRuntime();
  const resources = structuredClone(request.resources);
  return {
    getExtensions:()=>({extensions:[],errors:[],runtime}),
    getSkills:()=>({skills:request.kind==='chat'?[]:resources.skills.map(s=>({name:s.name,description:s.description,filePath:s.path,baseDir:dirname(s.path),sourceInfo:{path:s.path,source:'platform',scope:'project' as const,origin:'top-level' as const},disableModelInvocation:false})),diagnostics:[]}),
    getPrompts:()=>({prompts:[],diagnostics:[]}), getThemes:()=>({themes:[],diagnostics:[]}),
    getAgentsFiles:()=>({agentsFiles:request.kind!=='agent'||!resources.agents_md?[]:[resources.agents_md]}),
    getSystemPrompt:()=>resources.system_prompt, getSystemPromptSource:()=>undefined,
    getAppendSystemPrompt:()=>[], getAppendSystemPromptSources:()=>[], extendResources(){}, async reload(){},
  };
}

export class Runtime {
  private sessions = new Map<string,Live>();
  private busy = new Set<string>();
  private runs = new Map<string,Run>();
  private admissions = new Map<string,Promise<Live>>();
  private admissionControllers = new Map<string,AbortController>();
  private cancellations = new Map<string,Promise<Cancellation>>();
  private compactions = new Map<string,{controller:AbortController;settled:Promise<void>}>();
  private executor;
  private gateway;
  private timer;
  private bundled:RunRequest['resources']['skills'];
  constructor(private config:RuntimeConfig) {
    this.bundled=loadSkillsFromDir({dir:config.skillsDirectory,source:'platform'}).skills.map(s=>({name:s.name,description:s.description,path:'/platform-skills/'+relative(config.skillsDirectory,s.filePath)}));
    this.executor=createExecutorTransport({socketPath:config.executorSocket,token:config.executorToken});
    this.gateway=createGatewayTransport({baseUrl:config.platformUrl,token:config.platformToken});
    mkdirSync(join(config.home,'sessions-v3'),{recursive:true});
    mkdirSync(join(config.home,'empty-agent'),{recursive:true});
    this.timer=setInterval(()=>this.evict(),60_000); this.timer.unref();
  }
  private evict() {
    const now=Date.now();
    for(const [sid,live] of this.sessions) if(!this.busy.has(sid)&&now-live.lastUsed>15*60_000){live.session.dispose();this.sessions.delete(sid);}
    for(const [id,run] of this.runs) if(run.done&&now-run.endedAt>10*60_000){run.events.dispose();this.runs.delete(id);}
  }
  private async open(sid:string,request:RunRequest,signal:AbortSignal):Promise<Live> {
    const key=JSON.stringify([request.kind,request.sandbox,request.resources,request.tools]);
    const existing=this.sessions.get(sid);
    if(existing?.key===key)return existing;
    // Changed inputs (e.g. an edited AGENTS.md): a new Pi object on the same transcript lets Pi append the difference.
    if(existing){existing.session.dispose();this.sessions.delete(sid);}
    const fixed=structuredClone(request);
    const skills=new Map(this.bundled.map(s=>[s.name,s]));
    for(const skill of fixed.resources.skills)skills.set(skill.name,skill);
    fixed.resources.skills=fixed.kind==='chat'?[]:[...skills.values()];
    fixed.tools=fixed.tools.filter(name=>fixed.kind!=='chat'||chatTools[name]===true);
    // Background tools and the extended bash belong to the root personal agent only; subagents never get them.
    const personal=fixed.kind==='agent'&&/^private:\d+$/.test(fixed.sandbox.scope_key);
    if(!personal)fixed.tools=fixed.tools.filter(name=>!['browser','schedule','mcp','task','job','wait'].includes(name));
    fixed.sandbox.profile=fixed.kind==='chat'?'chat':'agent';
    const models=await (this.config.modelRuntimeFactory?.(fixed.model.id)??createModelRuntime(this.config.platformUrl,this.config.platformToken,()=>fixed.model.id));
    const model=await resolveModel(models,fixed.model,signal);
    const file=sessionPath(this.config.home,sid);
    // Persist a stable identity even if the first request fails before an assistant reply.
    if(!existsSync(file))writeFileSync(file,JSON.stringify({type:'session',version:3,id:sid,timestamp:new Date().toISOString(),cwd:fixed.sandbox.cwd})+'\n',{flag:'wx',mode:0o600});
    const manager=SessionManager.open(file,dirname(file),fixed.sandbox.cwd);
    const live={} as Live;
    const guard=()=>{this.compactions.get(sid)?.controller.signal.throwIfAborted();const run=this.runs.get(live.runId);if(run?.cancelled&&!run.done)throw new DOMException('Run cancelled','AbortError');};
    bindModelSession(models,sid,guard);
    const watchers=new Set<()=>void>();
    const inputs=(listener:()=>void)=>{watchers.add(listener);const run=this.runs.get(live.runId);if(run&&run.pendingInputs.size>0)listener();return ()=>{watchers.delete(listener);};};
    const customTools=createTools(fixed.sandbox.cwd,{sandbox:fixed.sandbox,names:fixed.tools,executor:this.executor,gateway:this.gateway,skillsDirectory:this.config.skillsDirectory,inputs,...(this.config.promoteAfterMs===undefined?{}:{promoteAfterMs:this.config.promoteAfterMs}),output:(id,text)=>this.liveOutput(live.runId,id,text),context:()=>{guard();return {sid,scope_key:fixed.sandbox.scope_key,run_id:live.runId,...(/^private:(\d+)$/.test(fixed.sandbox.scope_key)?{owner_user_id:Number(fixed.sandbox.scope_key.split(':')[1])}:{}),...(/^channel:(\d+):/.test(fixed.sandbox.scope_key)?{channel_id:Number(fixed.sandbox.scope_key.split(':')[1])}:{})};}});
    const {session}=await createAgentSession({cwd:fixed.sandbox.cwd,agentDir:join(this.config.home,'empty-agent'),modelRuntime:models,model,thinkingLevel:fixed.model.thinking,settingsManager:SettingsManager.inMemory({cacheWarming:'off',enableAnalytics:false,enableInstallTelemetry:false}),sessionManager:manager,resourceLoader:loader(fixed),tools:fixed.tools,customTools});
    session.agent.steeringMode='all';
    Object.assign(live,{session,manager,models,request:fixed,key,runId:'',lastUsed:Date.now(),watchers});
    this.sessions.set(sid,live);return live;
  }
  async start(sid:string,request:RunRequest):Promise<{run_id:string}> {
    if(request.kind==='subagent')validateSubagent(sid,request);
    if(this.busy.has(sid)||this.cancellations.has(sid))throw failure(409,'Session is busy');
    this.busy.add(sid);
    let live:Live;
    const controller=new AbortController();
    this.admissionControllers.set(sid,controller);
    const admission=this.open(sid,request,controller.signal);
    this.admissions.set(sid,admission);
    try { live=await admission; }
    catch(error){this.busy.delete(sid);if(controller.signal.aborted)throw failure(409,'Session admission cancelled');throw error;}
    finally{this.admissions.delete(sid);this.admissionControllers.delete(sid);}
    live.request.model=structuredClone(request.model);
    const finished=Promise.withResolvers<void>();
    const stopped=Promise.withResolvers<void>();
    const run:Run={id:randomUUID(),sid,events:new RunEvents(),done:false,cancelled:false,acceptingInput:true,initialInputPending:true,acceptedInputs:new Set(),pendingInputs:new Map(),controller,stopConfirmed:stopped.promise,confirmStop:stopped.resolve,sideEffects:false,finished:finished.promise,finish:finished.resolve,endedAt:0,usage:{input:0,output:0,cache_read:0,cache_write:0,total:0},text:''};
    live.runId=run.id;this.runs.set(run.id,run);
    void this.execute(live,run,request);
    return {run_id:run.id};
  }
  steer(id:string,input:SteerRequest):void {
    const run=this.runs.get(id);if(!run)throw failure(404,'Run not found');
    if(run.acceptedInputs.has(input.input_id))return;
    if(run.done||run.cancelled||!run.acceptingInput)throw failure(409,'Run is not accepting input');
    if(run.pendingInputs.size>=MAX_PENDING_INPUTS)throw failure(409,'Run has too many pending inputs');
    const text=[input.context_prefix,input.prompt.text].filter(Boolean).join('\n');
    const message:UserMessage={role:'user',content:[{type:'text',text},...input.prompt.images.map(image=>({type:'image' as const,mimeType:image.mime,data:image.data}))],timestamp:Date.now()};
    run.acceptedInputs.add(input.input_id);
    run.pendingInputs.set(input.input_id,{message,text});
    const live=this.sessions.get(run.sid)!;
    live.session.agent.steer(message);
    // A running personal bash call promotes its command to the background to hand control back.
    for(const watcher of [...live.watchers])watcher();
  }
  private emit(run:Run,event:Event) {
    if(!run.done)run.events.emit(event);
  }
  private streams(run:Run):RunStreams {
    let streams=runStreams.get(run);
    if(!streams){streams={inputs:new Map(),outputs:new Map()};runStreams.set(run,streams);}
    return streams;
  }
  // Argument generation is forwarded verbatim; `tool_start` stays the authoritative full arguments.
  private onToolInput(run:Run,delta:Extract<AssistantMessageEvent,{type:'toolcall_start'|'toolcall_delta'|'toolcall_end'}>) {
    const {inputs}=this.streams(run);
    let input=inputs.get(delta.contentIndex);
    if(!input){
      if(delta.type==='toolcall_end')return;
      const block=delta.partial.content[delta.contentIndex];
      if(block?.type!=='toolCall')return;
      const id=block.id;
      this.emit(run,{type:'tool_input_start',tool_call_id:id,name:block.name});
      input=new LiveBuffer({intervalMs:INPUT_INTERVAL_MS,send:text=>this.emit(run,{type:'tool_input_delta',tool_call_id:id,delta:text})});
      inputs.set(delta.contentIndex,input);
    }
    if(delta.type==='toolcall_delta')input.push(delta.delta);
    else if(delta.type==='toolcall_end'){input.close();inputs.delete(delta.contentIndex);}
  }
  private closeInputs(run:Run) {
    const {inputs}=this.streams(run);
    for(const input of inputs.values())input.close();
    inputs.clear();
  }
  private closeStreams(run:Run) {
    this.closeInputs(run);
    for(const output of this.streams(run).outputs.values())output.close();
    this.streams(run).outputs.clear();
  }
  // Live bash output from the Manager executor; `tool_end` carries the authoritative result.
  private liveOutput(runId:string,id:string,text:string) {
    const run=this.runs.get(runId);
    if(!run||run.done)return;
    const {outputs}=this.streams(run);
    let output=outputs.get(id);
    if(!output){
      output=new LiveBuffer({intervalMs:OUTPUT_INTERVAL_MS,limitBytes:OUTPUT_LIMIT_BYTES,
        send:delta=>this.emit(run,{type:'tool_output',tool_call_id:id,delta}),
        onLimit:()=>this.emit(run,{type:'tool_output',tool_call_id:id,delta:'',truncated:true})});
      outputs.set(id,output);
    }
    output.push(text);
  }
  private onInput(run:Run,message:UserMessage) {
    let inputId:string|undefined;
    for(const [id,input] of run.pendingInputs)if(input.message===message){inputId=id;break;}
    // The run's own prompt can have the same text as a queued input.
    if(inputId===undefined&&run.initialInputPending){run.initialInputPending=false;return;}
    if(inputId===undefined){
      const text=typeof message.content==='string'?message.content:message.content.filter(c=>c.type==='text').map(c=>c.text).join('');
      for(const [id,input] of run.pendingInputs)if(input.text===text){inputId=id;break;}
    }
    if(inputId!==undefined){
      run.pendingInputs.delete(inputId);
      this.emit(run,{type:'input_delivered',input_id:inputId});
    }
  }
  private onEvent(run:Run,event:AgentSessionEvent) {
    if(event.type==='message_start'&&event.message.role==='user')this.onInput(run,event.message);
    else if(event.type==='message_update'){
      const delta=event.assistantMessageEvent;
      if(delta.type==='text_delta'||delta.type==='thinking_delta')this.emit(run,{type:delta.type,delta:delta.delta});
      else if(delta.type==='thinking_start'||delta.type==='thinking_end')this.emit(run,{type:delta.type});
      else if(delta.type==='toolcall_start'||delta.type==='toolcall_delta'||delta.type==='toolcall_end')this.onToolInput(run,delta);
    }else if(event.type==='tool_execution_start'){
      const args:unknown=event.args;
      const action=args&&typeof args==='object'&&'action' in args&&typeof args.action==='string'?args.action:undefined;
      if(['bash','write','edit','mcp','task'].includes(event.toolName)||event.toolName==='job'&&['input','stop'].includes(action??'')||event.toolName==='browser'&&!['list','snapshot','screenshot','vision','links','images','downloads','stats','extract','console'].includes(action??'')||event.toolName==='schedule'&&!['list','get','history'].includes(action??''))run.sideEffects=true;
      this.closeInputs(run);
      this.emit(run,{type:'tool_start',tool_call_id:event.toolCallId,name:event.toolName,args:event.args});
    }else if(event.type==='tool_execution_update')this.emit(run,{type:'tool_update',tool_call_id:event.toolCallId,partial:event.partialResult});
    else if(event.type==='tool_execution_end'){
      const output=this.streams(run).outputs.get(event.toolCallId);
      if(output){output.close();this.streams(run).outputs.delete(event.toolCallId);}
      this.emit(run,{type:'tool_end',tool_call_id:event.toolCallId,name:event.toolName,is_error:event.isError,content_preview:event.result.content,details:event.result.details});
    }
    else if(event.type==='auto_retry_start'||event.type==='summarization_retry_scheduled')this.emit(run,{type:'retry',attempt:event.attempt,max:event.maxAttempts,delay_ms:event.delayMs,error:event.errorMessage});
    else if(event.type==='compaction_start'||event.type==='compaction_end'){
      this.emit(run,{type:'compaction',phase:event.type==='compaction_start'?'start':'end',reason:event.reason});
      const usage=event.type==='compaction_end'?event.result?.usage:undefined;
      if(usage){run.usage.input+=usage.input;run.usage.output+=usage.output;run.usage.cache_read+=usage.cacheRead;run.usage.cache_write+=usage.cacheWrite;run.usage.total+=usage.totalTokens;}
    }
    else if(event.type==='message_end'&&event.message.role==='assistant'){
      this.closeInputs(run);
      const message=event.message;
      run.text=message.content.filter(c=>c.type==='text').map(c=>c.text).join('');
      run.usage.input+=message.usage.input;run.usage.output+=message.usage.output;
      run.usage.cache_read+=message.usage.cacheRead;run.usage.cache_write+=message.usage.cacheWrite;run.usage.total+=message.usage.totalTokens;
      if(message.stopReason==='error')run.error=message.errorMessage??'Model request failed';
      else delete run.error;
    }
  }
  private async execute(live:Live,run:Run,request:RunRequest) {
    const unsubscribe=live.session.subscribe(event=>this.onEvent(run,event));
    try {
      const model=await resolveModel(live.models,request.model,run.controller.signal);
      if(live.session.model?.id!==model.id)await live.session.setModel(model);
      live.session.setThinkingLevel(request.model.thinking);
      if(run.cancelled)return;
      await live.session.prompt([request.context_prefix,request.prompt.text].filter(Boolean).join('\n'),{expandPromptTemplates:false,images:request.prompt.images?.map(i=>({type:'image' as const,mimeType:i.mime,data:i.data}))??[]});
      run.acceptingInput=false;
      live.session.clearQueue();
      await live.session.waitForIdle();
    }catch(error){run.error=error instanceof Error?error.message:String(error);}
    finally {
      if(run.acceptingInput){run.acceptingInput=false;live.session.clearQueue();}
      if(run.cancelled)await run.stopConfirmed;
      unsubscribe();live.lastUsed=Date.now();this.closeStreams(run);
      this.emit(run,{type:'run_end',status:run.cancelled?'cancelled':run.error?'failed':'completed',text:run.text,usage:run.usage,model:request.model.id,...(run.error?{error:run.error}:{}),side_effects:run.sideEffects,undelivered_inputs:[...run.pendingInputs.keys()]});
      run.pendingInputs.clear();
      run.done=true;run.endedAt=Date.now();this.busy.delete(run.sid);
      run.events.close();
      run.finish();
    }
  }
  events(id:string,after:number,response:ServerResponse):void {
    const run=this.runs.get(id);if(!run)throw failure(404,'Run not found');
    run.events.subscribe(after,response);
  }
  async cancel(id:string):Promise<void> {
    const run=this.runs.get(id);if(!run)throw failure(404,'Run not found');
    if(run.done)return;run.cancelled=true;run.controller.abort();
    const live=this.sessions.get(run.sid);
    if(live&&!run.stopping){
      const attempt=Promise.all([live.session.abort(),this.executor.cancelRun(live.request.sandbox,run.id)]).then(([,confirmed])=>{
        if(!confirmed)throw failure(502,'Sandbox cancellation was not confirmed');
        run.confirmStop();
      });
      run.stopping=attempt;
      void attempt.finally(()=>{delete run.stopping;}).catch(()=>{});
    }
    await run.stopping;
    await run.finished;
  }
  async cancelSession(sid:string):Promise<Cancellation> {
    let operation=this.cancellations.get(sid);
    if(!operation){
      operation=(async()=>{
        const compaction=this.compactions.get(sid);
        if(compaction){compaction.controller.abort();await compaction.settled;return {cancelled:true,run_id:null};}
        const admission=this.admissions.get(sid);
        this.admissionControllers.get(sid)?.abort();
        if(admission)try{await admission;}catch{return {cancelled:false,run_id:null};}
        const id=this.sessions.get(sid)?.runId;
        const run=id?this.runs.get(id):undefined;
        if(!run||run.done)return {cancelled:false,run_id:null};
        await this.cancel(run.id);
        return {cancelled:true,run_id:run.id};
      })();
      this.cancellations.set(sid,operation);
      void operation.finally(()=>this.cancellations.delete(sid)).catch(()=>{});
    }
    const deadline=Promise.withResolvers<Cancellation>();
    const timer=setTimeout(()=>deadline.reject(failure(504,'Session cancellation timed out')),30_000);
    try{return await Promise.race([operation,deadline.promise]);}finally{clearTimeout(timer);}
  }
  async compact(sid:string,selected:RunRequest['model']):Promise<CompactionOutcome> {
    if(this.busy.has(sid)||this.cancellations.has(sid))throw failure(409,'Session is busy');
    const live=this.sessions.get(sid);
    this.busy.add(sid);
    const controller=new AbortController();
    const settled=Promise.withResolvers<void>();
    this.compactions.set(sid,{controller,settled:settled.promise});
    try {
      if(live){
        live.request.model=structuredClone(selected);
        const model=await resolveModel(live.models,selected,controller.signal);
        await live.session.setModel(model);
        live.session.setThinkingLevel(selected.thinking);
        return await compactSession(live.session,controller.signal);
      }else return await compactStored(this.config.home,sid,this.config.platformUrl,this.config.platformToken,selected,this.config.modelRuntimeFactory,controller.signal);
    }catch(error){
      if(controller.signal.aborted)throw failure(409,'Session compaction cancelled');
      throw error;
    }finally{
      this.busy.delete(sid);this.compactions.delete(sid);settled.resolve();
      if(live)live.lastUsed=Date.now();
    }
  }
  async delete(sid:string):Promise<void> {
    if(this.busy.has(sid)||this.cancellations.has(sid))throw failure(409,'Session is busy');
    this.busy.add(sid);
    try {
      this.sessions.get(sid)?.session.dispose();this.sessions.delete(sid);
      await rm(sessionPath(this.config.home,sid),{force:true});
    }finally{this.busy.delete(sid);}
  }
  history(sid:string,before?:string,limit=100):unknown {
    const file=sessionPath(this.config.home,sid);
    const manager=this.sessions.get(sid)?.manager??(existsSync(file)?SessionManager.open(file):undefined);
    if(!manager)throw failure(404,'Session not found');
    const messages=manager.buildSessionProjection().entries.flatMap(entry=>entry.messages.map(message=>({entry_id:entry.sourceEntry.id,message})));
    const end=before?messages.findIndex(m=>m.entry_id===before):messages.length;
    if(end<0)throw failure(400,'Unknown history cursor');
    return {messages:messages.slice(Math.max(0,end-limit),end),next_before: end>limit?messages[end-limit]?.entry_id:null};
  }
  async close():Promise<void> {
    clearInterval(this.timer);
    const active=new Set([...this.admissions.keys(),...this.compactions.keys(),...[...this.runs.values()].filter(r=>!r.done).map(r=>r.sid)]);
    await Promise.all([...active].map(sid=>this.cancelSession(sid)));
    for(const live of this.sessions.values())live.session.dispose();this.sessions.clear();
  }
}
