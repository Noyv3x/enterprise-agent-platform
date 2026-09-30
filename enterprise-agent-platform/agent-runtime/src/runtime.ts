import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { ServerResponse } from 'node:http';
import { createAgentSession, createExtensionRuntime, loadSkillsFromDir, SettingsManager, SessionManager, type AgentSession, type AgentSessionEvent, type ModelRuntime, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { createModelRuntime } from './credentials.js';
import { sessionPath } from './migration.js';
import { compactSession, compactStored, type CompactionOutcome } from './compact.js';
import { createTools } from './tools.js';
import { createExecutorTransport, createGatewayTransport } from './transport.js';
import { bindModelSession, resolveModel } from './models.js';
import { RunEvents } from './events.js';

export interface RunRequest {
  kind: 'agent' | 'chat';
  sandbox: {scope_key:string; workspace_id:string; sandbox_id:string; lifecycle_id:string; profile:'agent'|'chat'; cwd:string};
  model: {id:string; thinking:ThinkingLevel; contextWindow?:number; maxTokens?:number};
  prompt: {text:string; images?:{mime:string; data:string}[]};
  context_prefix?:string;
  resources: {system_prompt:string; agents_md?:{path:string;content:string}|null; skills:{name:string;description:string;path:string}[]};
  tools:string[];
}
export interface RuntimeConfig {
  home:string; platformUrl:string; platformToken:string; executorSocket:string; executorToken:string; skillsDirectory:string;
  // Injecting a model runtime permits exercising the real Pi session with a faux provider.
  modelRuntimeFactory?: (modelId:string) => Promise<ModelRuntime>;
}
type Event = {type:string;[key:string]:unknown};
type Run = {id:string; sid:string; events:RunEvents; done:boolean; cancelled:boolean; sideEffects:boolean; controller:AbortController; stopping?:Promise<void>; stopConfirmed:Promise<void>; confirmStop:()=>void; finished:Promise<void>; finish:()=>void; endedAt:number; usage:{input:number;output:number;cache_read:number;cache_write:number;total:number}; text:string; error?:string};
type Live = {session:AgentSession; manager:SessionManager; models:ModelRuntime; request:RunRequest; runId:string; lastUsed:number};
type Cancellation = {cancelled:boolean;run_id:string|null};
export function failure(status:number,message:string): Error & {status:number} { return Object.assign(new Error(message),{status}); }
const chatTools:Record<string,true> = {read:true,bash:true,edit:true,write:true,grep:true,find:true,ls:true,web_search:true,web_fetch:true};

function loader(request:RunRequest):ResourceLoader {
  const runtime = createExtensionRuntime();
  const resources = structuredClone(request.resources);
  return {
    getExtensions:()=>({extensions:[],errors:[],runtime}),
    getSkills:()=>({skills:request.kind==='chat'?[]:resources.skills.map(s=>({name:s.name,description:s.description,filePath:s.path,baseDir:dirname(s.path),sourceInfo:{path:s.path,source:'platform',scope:'project' as const,origin:'top-level' as const},disableModelInvocation:false})),diagnostics:[]}),
    getPrompts:()=>({prompts:[],diagnostics:[]}), getThemes:()=>({themes:[],diagnostics:[]}),
    getAgentsFiles:()=>({agentsFiles:request.kind==='chat'||!resources.agents_md?[]:[resources.agents_md]}),
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
    const existing=this.sessions.get(sid); if(existing)return existing;
    const fixed=structuredClone(request);
    const skills=new Map(this.bundled.map(s=>[s.name,s]));
    for(const skill of fixed.resources.skills)skills.set(skill.name,skill);
    fixed.resources.skills=fixed.kind==='chat'?[]:[...skills.values()];
    fixed.tools=fixed.tools.filter(name=>fixed.kind!=='chat'||chatTools[name]===true);
    if(!/^private:\d+$/.test(fixed.sandbox.scope_key))fixed.tools=fixed.tools.filter(name=>!['browser','schedule','mcp'].includes(name));
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
    const customTools=createTools(fixed.sandbox.cwd,{sandbox:fixed.sandbox,names:fixed.tools,executor:this.executor,gateway:this.gateway,skillsDirectory:this.config.skillsDirectory,context:()=>{guard();return {sid,scope_key:fixed.sandbox.scope_key,run_id:live.runId,...(/^private:(\d+)$/.test(fixed.sandbox.scope_key)?{owner_user_id:Number(fixed.sandbox.scope_key.split(':')[1])}:{}),...(/^channel:(\d+):/.test(fixed.sandbox.scope_key)?{channel_id:Number(fixed.sandbox.scope_key.split(':')[1])}:{})};}});
    const {session}=await createAgentSession({cwd:fixed.sandbox.cwd,agentDir:join(this.config.home,'empty-agent'),modelRuntime:models,model,thinkingLevel:fixed.model.thinking,settingsManager:SettingsManager.inMemory({cacheWarming:'off',enableAnalytics:false,enableInstallTelemetry:false}),sessionManager:manager,resourceLoader:loader(fixed),tools:fixed.tools,customTools});
    Object.assign(live,{session,manager,models,request:fixed,runId:'',lastUsed:Date.now()});
    this.sessions.set(sid,live);return live;
  }
  async start(sid:string,request:RunRequest):Promise<{run_id:string}> {
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
    const run:Run={id:randomUUID(),sid,events:new RunEvents(),done:false,cancelled:false,controller,stopConfirmed:stopped.promise,confirmStop:stopped.resolve,sideEffects:false,finished:finished.promise,finish:finished.resolve,endedAt:0,usage:{input:0,output:0,cache_read:0,cache_write:0,total:0},text:''};
    live.runId=run.id;this.runs.set(run.id,run);
    void this.execute(live,run,request);
    return {run_id:run.id};
  }
  private emit(run:Run,event:Event) {
    if(!run.done)run.events.emit(event);
  }
  private onEvent(run:Run,event:AgentSessionEvent) {
    if(event.type==='message_update'){
      const delta=event.assistantMessageEvent;
      if(delta.type==='text_delta'||delta.type==='thinking_delta')this.emit(run,{type:delta.type,delta:delta.delta});
    }else if(event.type==='tool_execution_start'){
      const args:unknown=event.args;
      const action=args&&typeof args==='object'&&'action' in args&&typeof args.action==='string'?args.action:undefined;
      if(['bash','write','edit','mcp'].includes(event.toolName)||event.toolName==='browser'&&!['list','snapshot','screenshot','vision','links','images','downloads','stats','extract','console'].includes(action??'')||event.toolName==='schedule'&&!['list','get','history'].includes(action??''))run.sideEffects=true;
      this.emit(run,{type:'tool_start',tool_call_id:event.toolCallId,name:event.toolName,args:event.args});
    }else if(event.type==='tool_execution_update')this.emit(run,{type:'tool_update',tool_call_id:event.toolCallId,partial:event.partialResult});
    else if(event.type==='tool_execution_end')this.emit(run,{type:'tool_end',tool_call_id:event.toolCallId,name:event.toolName,is_error:event.isError,content_preview:event.result.content,details:event.result.details});
    else if(event.type==='auto_retry_start'||event.type==='summarization_retry_scheduled')this.emit(run,{type:'retry',attempt:event.attempt,max:event.maxAttempts,delay_ms:event.delayMs,error:event.errorMessage});
    else if(event.type==='compaction_start'||event.type==='compaction_end'){
      this.emit(run,{type:'compaction',phase:event.type==='compaction_start'?'start':'end',reason:event.reason});
      const usage=event.type==='compaction_end'?event.result?.usage:undefined;
      if(usage){run.usage.input+=usage.input;run.usage.output+=usage.output;run.usage.cache_read+=usage.cacheRead;run.usage.cache_write+=usage.cacheWrite;run.usage.total+=usage.totalTokens;}
    }
    else if(event.type==='message_end'&&event.message.role==='assistant'){
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
      await live.session.waitForIdle();
    }catch(error){run.error=error instanceof Error?error.message:String(error);}
    finally {
      if(run.cancelled)await run.stopConfirmed;
      unsubscribe();live.lastUsed=Date.now();
      this.emit(run,{type:'run_end',status:run.cancelled?'cancelled':run.error?'failed':'completed',text:run.text,usage:run.usage,model:request.model.id,...(run.error?{error:run.error}:{}),side_effects:run.sideEffects});
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
