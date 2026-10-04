import crypto from "crypto";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020";
import type { Request, Response } from "express";
import { upstream, boundedBody, requestScope } from "./gateway";
import { resolveModel, type ReasoningEffort } from "./models";

export function prepareChat(body: any) {
  if (!body || !Array.isArray(body.messages) || !body.messages.length) throw new Error("messages is required");
  if (body.n !== undefined && body.n !== 1) throw new Error("Only n=1 is supported");
  if (body.functions || body.function_call || body.response_format) throw new Error("Unsupported legacy functions or response_format");
  const input: any[] = []; const instructions: string[] = []; const pending = new Set<string>(); const seen = new Set<string>();
  const tools = (body.tools ?? []).map((tool: any) => {
    if (tool.type !== "function" || !tool.function?.name) throw new Error("Only function tools supported");
    return { type:"function", ...tool.function, strict: tool.function.strict ?? false };
  });
  const validators = new Map<string, ReturnType<Ajv["compile"]>>();
  const ajv = new Ajv({strict:false,validateFormats:false});
  const ajv2020 = new Ajv2020({strict:false,validateFormats:false});
  for(const tool of tools) {
    if(validators.has(tool.name)) throw new Error("Duplicate tool name");
    const schema=tool.parameters ?? {type:"object"};
    const compiler=schema.$schema === "https://json-schema.org/draft/2020-12/schema" ? ajv2020 : ajv;
    validators.set(tool.name,compiler.compile(schema));
  }
  for (const message of body.messages) {
    if (["system","developer"].includes(message.role)) {
      if(typeof message.content !== "string") throw new Error("Instructions must be text"); instructions.push(message.content); continue;
    }
    if(message.role === "tool") {
      if(!pending.delete(message.tool_call_id)) throw new Error("Tool result without matching call");
      if(typeof message.content !== "string") throw new Error("Tool output must be text");
      input.push({type:"function_call_output",call_id:message.tool_call_id,output:message.content});continue;
    }
    if(pending.size) throw new Error("Missing tool results");
    if(!["user","assistant"].includes(message.role)) throw new Error("Unsupported message role");
    for(const item of message.reasoning_details ?? []) {
      if(message.role !== "assistant" || item.type !== "reasoning" || typeof item.encrypted_content !== "string") throw new Error("Invalid reasoning context");
      input.push(item);
    }
    if(message.content) {
      const content = typeof message.content === "string" ? [{type:message.role === "assistant" ? "output_text" : "input_text",text:message.content}] : message.content.map((part: any) => {
        if(part.type === "text") return {type:"input_text",text:part.text};
        if(part.type === "image_url" && message.role === "user") return {type:"input_image",image_url:part.image_url.url,detail:part.image_url.detail ?? "auto"};
        throw new Error("Unsupported content part");
      });
      input.push({role:message.role,content});
    }
    for(const call of message.tool_calls ?? []) {
      if(message.role !== "assistant" || !call.id || seen.has(call.id) || !validators.has(call.function?.name)) throw new Error("Invalid historical tool call");
      const args=JSON.parse(call.function.arguments);
      if(!validators.get(call.function.name)!(args)) throw new Error("Invalid historical arguments");
      seen.add(call.id);pending.add(call.id);
      input.push({type:"function_call",call_id:call.id,name:call.function.name,arguments:call.function.arguments});
    }
  }
  if(pending.size) throw new Error("Missing tool results");
  const requested = body.model ?? process.env.DEFAULT_MODEL ?? "gpt-6.1-sol";
  const instructionText=instructions.join("\n\n") || "You are a helpful assistant.";
  const cacheKey=body.prompt_cache_key ?? crypto.createHash("sha256").update(JSON.stringify([instructionText,tools])).digest("hex");
  let choice=body.tool_choice;
  if(choice?.type === "function") choice={type:"function",name:choice.function.name};
  return { requested, validators, native: {
    model:resolveModel(requested),instructions:instructionText,input,stream:true,store:false,
    reasoning:{effort:body.reasoning_effort ?? process.env.REASONING_EFFORT ?? "high" as ReasoningEffort},
    ...(tools.length ? {tools,tool_choice:choice ?? "auto",parallel_tool_calls:body.parallel_tool_calls ?? true} : {}),
    prompt_cache_key:cacheKey,include:["reasoning.encrypted_content"],
    ...(body.prompt_cache_options ? {prompt_cache_options:body.prompt_cache_options} : {}),
    ...(body.prompt_cache_retention ? {prompt_cache_retention:body.prompt_cache_retention} : {}),
  }};
}

export async function chatCompletion(req: Request, res: Response) {
  let prepared: ReturnType<typeof prepareChat>;
  try { prepared=prepareChat(req.body); } catch { res.status(400).json({error:{type:"invalid_request_error",message:"Invalid chat request, tool schema, or conversation"}});return; }
  const scope=requestScope(res);
  try {
    const response=await upstream("/codex/responses",prepared.native,req,scope.signal,prepared.native.prompt_cache_key);
    if(!response.ok) { res.status(response.status).type("application/json").send(await boundedBody(response));return; }
    const raw=(await boundedBody(response)).toString(); let completed: any; const streamedItems: any[] = [];
    if(response.headers.get("content-type")?.includes("application/json")) completed=JSON.parse(raw);
    else for(const line of raw.split(/\r?\n/)) if(line.startsWith("data:")) {
      const data=line.slice(5).trim(); if(!data || data==="[DONE]")continue;
      const event=JSON.parse(data);
      if(["response.failed","error"].includes(event.type)) throw new Error("Upstream failed");
      if(event.type==="response.output_item.done" && event.item) streamedItems.push(event.item);
      if(event.type==="response.completed") completed=event.response;
    }
    if(!completed || completed.status !== "completed") throw new Error("Missing completed response");
    const calls: any[]=[];let content="";let refusal="";const reasoning: any[]=[];const callIds=new Set<string>();
    const output = completed.output?.length ? completed.output : streamedItems;
    for(const item of output) {
      if(item.type==="reasoning" && item.encrypted_content) reasoning.push(item);
      if(item.type==="message") for(const part of item.content ?? []) {
        if(part.type==="output_text")content+=part.text;
        if(part.type==="refusal")refusal+=part.refusal;
      }
      if(item.type==="function_call") {
        const validate=prepared.validators.get(item.name);const args=JSON.parse(item.arguments);
        if(!item.call_id || callIds.has(item.call_id) || !validate || !validate(args))throw new Error("Invalid returned tool arguments");
        callIds.add(item.call_id);
        calls.push({id:item.call_id,type:"function",function:{name:item.name,arguments:item.arguments}});
      }
    }
    const u=completed.usage ?? {};
    const usage={prompt_tokens:u.input_tokens ?? 0,completion_tokens:u.output_tokens ?? 0,total_tokens:u.total_tokens ?? (u.input_tokens ?? 0)+(u.output_tokens ?? 0),prompt_tokens_details:u.input_tokens_details ?? {},completion_tokens_details:u.output_tokens_details ?? {}};
    if(refusal)calls.length=0;
    const message={role:"assistant",content:content || (calls.length ? null : ""),...(calls.length ? {tool_calls:calls} : {}),...(refusal ? {refusal} : {}),...(reasoning.length ? {reasoning_details:reasoning} : {})};
    const base={id:completed.id ?? `chatcmpl-${crypto.randomUUID()}`,created:Math.floor(Date.now()/1000),model:prepared.requested};
    const finish=calls.length ? "tool_calls" : "stop";
    if(!req.body.stream) {res.json({...base,object:"chat.completion",choices:[{index:0,message,finish_reason:finish}],usage});return;}
    res.setHeader("Content-Type","text/event-stream");res.setHeader("Cache-Control","no-cache");res.setHeader("X-Accel-Buffering","no");
    const emit=(delta: any,reason: string|null=null)=>res.write(`data: ${JSON.stringify({...base,object:"chat.completion.chunk",choices:[{index:0,delta,finish_reason:reason}]})}\n\n`);
    emit({role:"assistant",content:content || "",...(refusal ? {refusal} : {}),...(reasoning.length ? {reasoning_details:reasoning} : {})});calls.forEach((call,index)=>emit({tool_calls:[{index,...call}]}));emit({},finish);
    if(req.body.stream_options?.include_usage)res.write(`data: ${JSON.stringify({...base,object:"chat.completion.chunk",choices:[],usage})}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch { scope.abort();if(!res.destroyed&&!res.headersSent)res.status(502).json({error:{type:"upstream_error",message:"Upstream response invalid or unavailable"}}); }
  finally {scope.dispose();}
}
