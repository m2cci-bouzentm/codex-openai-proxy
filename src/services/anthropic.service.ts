import crypto from "crypto";
import { once } from "events";
import type { Request, Response, NextFunction } from "express";
import { upstream, boundedBody } from "../lib/codex-client";
import { requestScope } from "../utils/abort";
import { prepareChat } from "./openai.service";
import { messagesRequestSchema } from "../schemas/anthropic.schema";
import {
  codexStreamEventSchema,
  type ProviderResponse,
  type UpstreamOutputItem,
} from "../schemas/provider.schema";
import { ProxyError, providerMessage, upstreamRejection } from "../errors/proxy-error";

type Block = {type:string; [key:string]:any};
type CodexStreamEvent = {
  type: string;
  response?: ProviderResponse;
  item?: UpstreamOutputItem;
  part?: { type: string; [key: string]: unknown };
  item_id?: string;
  content_index?: number;
  delta?: string;
};
const LIMIT = 32 * 1024 * 1024;
export function anthropicError(res:Response,status:number,type:string,message:string) {
  res.status(status).json({type:"error",error:{type,message}});
}
function anthropicErrorType(error:ProxyError):string {
  if(error.status===413)return "request_too_large";
  return error.type==="upstream_error"?"api_error":error.type;
}
export function anthropicAuth(req:Request,res:Response,next:NextFunction) {
  const key=process.env.API_KEY;
  if(!key){anthropicError(res,503,"api_error","Proxy API key not configured");return;}
  if(req.get("x-api-key")!==key && req.get("authorization")!==`Bearer ${key}`){anthropicError(res,401,"authentication_error","Invalid API key");return;}
  next();
}
function textBlocks(value:any):string {
  if(typeof value==="string")return value;
  if(!Array.isArray(value))throw new Error("Expected text blocks");
  return value.map((b:Block)=>{if(b.type!=="text"||typeof b.text!=="string")throw new Error("Expected text block");return b.text;}).join("\n");
}
function imageBlock(block:Block) {
  const source=block.source;
  if(source?.type==="base64" && typeof source.data==="string" && ["image/png","image/jpeg","image/gif","image/webp"].includes(source.media_type))
    return {type:"image_url",image_url:{url:`data:${source.media_type};base64,${source.data}`}};
  if(source?.type==="url" && typeof source.url==="string" && /^https?:\/\//.test(source.url))return {type:"image_url",image_url:{url:source.url}};
  throw new Error("Unsupported image source");
}
export function prepareAnthropic(body:any,sessionHeader?:string) {
  const parsed = messagesRequestSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ProxyError(`Invalid Messages request: ${msg}`, 400);
  }
  if(!body || typeof body.model!=="string" || !body.model || !Number.isInteger(body.max_tokens) || body.max_tokens<=0 || !Array.isArray(body.messages) || !body.messages.length)throw new Error("Invalid Messages request");
  if(body.stream!==undefined && typeof body.stream!=="boolean")throw new Error("Invalid stream option");
  if(body.thinking && body.thinking.type!=="disabled")throw new Error("Anthropic thinking is not supported by Codex; disable it");
  if(body.stop_sequences?.length || body.output_config?.format || body.container || body.mcp_servers?.length)throw new Error("Unsupported Messages option");
  const messages:any[]=[];
  const system=body.system===undefined?"":textBlocks(body.system);
  if(system)messages.push({role:"system",content:system});
  for(const message of body.messages) {
    if(!["user","assistant"].includes(message.role))throw new Error("Invalid message role");
    const blocks:Block[]=typeof message.content==="string"?[{type:"text",text:message.content}]:message.content;
    if(!Array.isArray(blocks))throw new Error("Invalid message content");
    const content:any[]=[];const calls:any[]=[];
    for(const block of blocks) {
      if(block.type==="text" && typeof block.text==="string")content.push({type:"text",text:block.text});
      else if(block.type==="image" && message.role==="user")content.push(imageBlock(block));
      else if(block.type==="tool_use" && message.role==="assistant" && typeof block.id==="string" && typeof block.name==="string" && block.input && typeof block.input==="object")
        calls.push({id:block.id,type:"function",function:{name:block.name,arguments:JSON.stringify(block.input)}});
      else if(block.type==="tool_result" && message.role==="user" && typeof block.tool_use_id==="string") {
        const output=block.content===undefined?"":textBlocks(block.content);
        messages.push({role:"tool",tool_call_id:block.tool_use_id,content:block.is_error===true?`[tool_error]\n${output}`:output});
      } else throw new Error("Unsupported content block");
    }
    if(content.length || calls.length)messages.push({role:message.role,content:message.role==="assistant"?content.map(p=>p.text).join("\n"):content,...(calls.length?{tool_calls:calls}:{})});
  }
  const tools=(body.tools??[]).map((tool:any)=>{
    if(typeof tool.name!=="string" || !tool.input_schema || (tool.type && tool.type!=="custom"))throw new Error("Only custom function tools supported");
    return {type:"function",function:{name:tool.name,description:tool.description,parameters:tool.input_schema}};
  });
  let choice:any;
  if(body.tool_choice) {
    const c=body.tool_choice;
    if(c.type==="auto")choice="auto";
    else if(c.type==="any")choice="required";
    else if(c.type==="none")choice="none";
    else if(c.type==="tool" && tools.some((t:any)=>t.function.name===c.name))choice={type:"function",function:{name:c.name}};
    else throw new Error("Invalid tool choice");
  }
  const identity=sessionHeader || body.metadata?.user_id || "anonymous";
  const cache=crypto.createHash("sha256").update(JSON.stringify([identity,system,tools])).digest("hex");
  const prepared=prepareChat({model:body.model,messages,tools,tool_choice:choice,prompt_cache_key:cache,reasoning_effort:process.env.ANTHROPIC_REASONING_EFFORT || "low"});
  if(body.tool_choice?.disable_parallel_tool_use===true)prepared.native.parallel_tool_calls=false;
  return prepared;
}
function usage(response:ProviderResponse) {
  const u=response.usage;const cached=u?.input_tokens_details?.cached_tokens;
  const cachedTokens=typeof cached==="number"?cached:0;
  return {input_tokens:Math.max(0,(u?.input_tokens || 0)-cachedTokens),output_tokens:u?.output_tokens || 0,cache_creation_input_tokens:0,cache_read_input_tokens:cachedTokens};
}
function validateCall(item:UpstreamOutputItem,prepared:ReturnType<typeof prepareAnthropic>,ids:Set<string>) {
  if(!item.arguments || !item.name || !item.call_id)throw new Error("Invalid upstream tool call");
  const input=JSON.parse(item.arguments) as unknown;const validate=prepared.validators.get(item.name);
  if(ids.has(item.call_id) || !validate || !validate(input))throw new Error("Invalid upstream tool call");
  ids.add(item.call_id);return input;
}
function result(response:ProviderResponse,prepared:ReturnType<typeof prepareAnthropic>,items:UpstreamOutputItem[]) {
  const output=response.output?.length?response.output:items;const content:Block[]=[];const ids=new Set<string>();let refused=false;
  const stopped=response.status==="incomplete" && response.incomplete_details?.reason==="max_output_tokens";
  for(const item of output) {
    if(item.type==="message")for(const part of item.content || []) {
      if(part.type==="output_text")content.push({type:"text",text:part.text});
      if(part.type==="refusal"){content.push({type:"text",text:part.refusal});refused=true;}
    }
    if(item.type==="function_call" && !stopped) {
      const input=validateCall(item,prepared,ids);
      content.push({type:"tool_use",id:item.call_id,name:item.name,input});
    }
  }
  if(!stopped && response.status!=="completed")throw new Error("Upstream response failed");
  return {id:response.id,type:"message",role:"assistant",model:prepared.requested,content,stop_reason:stopped?"max_tokens":refused?"refusal":ids.size?"tool_use":"end_turn",stop_sequence:null,usage:usage(response)};
}
async function* events(response:globalThis.Response,reset:()=>void): AsyncGenerator<CodexStreamEvent> {
  if(!response.body)throw new Error("Missing upstream body");
  const decoder=new TextDecoder();let pending="";let total=0;
  for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    reset();total+=chunk.length;if(total>LIMIT)throw new Error("Upstream response limit exceeded");
    pending+=decoder.decode(chunk,{stream:true});
    for(;;) {
      const match=/\r?\n\r?\n/.exec(pending);if(!match)break;
      const frame=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);
      const data=frame.split(/\r?\n/).filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trimStart()).join("\n");
      if(data && data!=="[DONE]") {
        const parsedEvent = codexStreamEventSchema.parse(JSON.parse(data) as unknown);
        yield parsedEvent as CodexStreamEvent;
      }
    }
  }
  pending+=decoder.decode();if(pending.trim())throw new Error("Truncated upstream event");
}
export async function anthropicMessages(req:Request,res:Response) {
  let prepared:ReturnType<typeof prepareAnthropic>;
  try{prepared=prepareAnthropic(req.body,req.get("session_id"));}catch(e){anthropicError(res,400,"invalid_request_error",e instanceof Error?e.message:"Invalid request");return;}
  const scope=requestScope(res);const states=new Map<string,{index:number;kind:string;raw:string;closed:boolean}>();const items:UpstreamOutputItem[]=[];
  let started=false;let completed=false;
  const emit=async(type:string,data:Record<string,unknown>)=>{
    if(res.destroyed)throw new Error("Client disconnected");
    if(!res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`))await once(res,"drain",{signal:scope.signal});
  };
  const start=async(response:ProviderResponse)=>{
    if(started)return;started=true;
    res.setHeader("Content-Type","text/event-stream");res.setHeader("Cache-Control","no-cache");res.setHeader("X-Accel-Buffering","no");
    await emit("message_start",{message:{id:response.id,type:"message",role:"assistant",model:prepared.requested,content:[],stop_reason:null,stop_sequence:null,usage:usage(response)}});
  };
  const block=async(key:string,kind:string,item?:UpstreamOutputItem)=>{
    let s=states.get(key);if(s)return s;
    s={index:states.size,kind,raw:"",closed:false};states.set(key,s);
    if(kind==="tool" && (!item?.call_id || !item.name))throw new Error("Invalid tool item");
    await emit("content_block_start",{index:s.index,content_block:kind==="tool"?{type:"tool_use",id:item!.call_id,name:item!.name,input:{}}:{type:"text",text:""}});return s;
  };
  const delta=async(s:{index:number;kind:string;raw:string;closed:boolean},text:string)=>{
    if(!text)return;if(s.closed)throw new Error("Delta after block close");s.raw+=text;
    await emit("content_block_delta",{index:s.index,delta:s.kind==="tool"?{type:"input_json_delta",partial_json:text}:{type:"text_delta",text}});
  };
  const close=async(s:{index:number;closed:boolean})=>{if(!s.closed){s.closed=true;await emit("content_block_stop",{index:s.index});}};
  const validatedItems=new Set<string>();const streamedCallIds=new Set<string>();
  const finishItem=async(item:any,incomplete=false)=>{
    if(item.type==="function_call") {
      if(!incomplete && !validatedItems.has(item.id)) {
        try{validateCall(item,prepared,streamedCallIds);validatedItems.add(item.id);}
        catch{return;} // Wait for final status: token-limited partial calls are not executable.
      }
      const s=await block(item.id,"tool",item);if(!item.arguments.startsWith(s.raw))throw new Error("Inconsistent tool stream");await delta(s,item.arguments.slice(s.raw.length));await close(s);
    }
    if(item.type==="message")for(const [i,p] of (item.content || []).entries()) {
      if(!["output_text","refusal"].includes(p.type))continue;
      const text=p.type==="refusal"?p.refusal:p.text;const s=await block(`${item.id}:${i}`,"text");
      if(!text.startsWith(s.raw))throw new Error("Inconsistent text stream");await delta(s,text.slice(s.raw.length));await close(s);
    }
  };
  try {
    const response=await upstream("/codex/responses",prepared.native,req,scope.signal,prepared.native.prompt_cache_key);
    if(!response.ok){
      const rejection=upstreamRejection("Codex",response.status,providerMessage((await boundedBody(response)).toString("utf8")),response.headers.get("retry-after"));
      if(rejection.retryAfter)res.setHeader("retry-after",rejection.retryAfter);
      anthropicError(res,rejection.status,anthropicErrorType(rejection),rejection.message);
      return;
    }
    if(response.headers.get("content-type")?.includes("application/json")) {
      const data=JSON.parse((await boundedBody(response)).toString());const message=result(data,prepared,[]);
      if(!req.body.stream){res.json(message);return;}
      await start(data);for(const item of data.output || [])await finishItem(item);
      await emit("message_delta",{delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:message.usage});await emit("message_stop",{});res.end();return;
    }
    for await(const event of events(response, () => scope.reset?.())) {
      if(completed)continue;
      if(["error","response.failed","response.cancelled"].includes(event.type))throw new Error("Upstream failed");
      if(req.body.stream && event.type==="response.created" && event.response)await start(event.response);
      if(req.body.stream && !started && event.response)await start(event.response);
      if(event.type==="response.output_item.done" && event.item)items.push(event.item);
      if(req.body.stream && started) {
        if(event.type==="response.output_item.added" && event.item?.type==="function_call" && event.item.id)await block(event.item.id,"tool",event.item);
        if(event.type==="response.content_part.added" && event.part && event.item_id && event.content_index!==undefined && ["output_text","refusal"].includes(event.part.type))await block(`${event.item_id}:${event.content_index}`,"text");
        if((event.type==="response.output_text.delta" || event.type==="response.refusal.delta") && event.item_id && event.content_index!==undefined && event.delta!==undefined)await delta(await block(`${event.item_id}:${event.content_index}`,"text"),event.delta);
        if(event.type==="response.function_call_arguments.delta") {
          if(!event.item_id || event.delta===undefined)throw new Error("Invalid tool delta");
          const s=states.get(event.item_id);if(!s)throw new Error("Tool delta without call");await delta(s,event.delta);
        }
        if(event.type==="response.output_item.done" && event.item)await finishItem(event.item);
      }
      if(["response.completed","response.incomplete"].includes(event.type)) {
        if(!event.response)throw new Error("Invalid final response");
        const message=result(event.response,prepared,items);
        if(!req.body.stream){res.json(message);completed=true;break;}
        await start(event.response);
        for(const item of event.response.output.length?event.response.output:items)await finishItem(item,message.stop_reason==="max_tokens");
        for(const s of states.values())await close(s);
        await emit("message_delta",{delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:message.usage});await emit("message_stop",{});res.end();completed=true;break;
      }
    }
    if(!completed)throw new Error("Missing final response");
  }catch {
    const timedOut=scope.signal.aborted;scope.abort();
    if(!res.destroyed && !res.writableEnded) {
      if(res.headersSent)res.end('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Codex upstream stream interrupted"}}\n\n');
      else anthropicError(res,timedOut?504:502,"api_error","Codex upstream response unavailable");
    }
  }finally{scope.dispose();}
}
