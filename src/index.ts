import express from "express";
import cors from "cors";
import "dotenv/config";
import { AUTH_FILE } from "./auth";
import { requestScope, upstream, boundedBody } from "./gateway";
import { chatCompletion } from "./openai";
import { anthropicAuth, anthropicMessages, anthropicModels, anthropicError } from "./anthropic";

export const app = express();
app.use(cors());
app.use(express.json({limit:"32mb"}));
function auth(req: express.Request,res: express.Response,next: express.NextFunction) {
  const key=process.env.API_KEY;
  if(!key) {res.status(503).json({error:{message:"Proxy API key not configured",type:"configuration_error"}});return;}
  if(req.headers.authorization !== `Bearer ${key}`) {res.status(401).json({error:{message:"Invalid API key",type:"auth_error"}});return;}
  next();
}
app.get("/health",(_req,res)=>res.json({status:"ok"}));
app.get("/openai/v1/models",auth,async(req,res)=>{
  const scope=requestScope(res);
  try {
    const query=new URLSearchParams(req.query as Record<string,string>);
    if(!query.has("client_version"))query.set("client_version",process.env.CODEX_CLIENT_VERSION || "0.157.1");
    const response=await upstream("/codex/models?"+query,undefined,req,scope.signal);
    const buffer=await boundedBody(response);
    if(!response.ok){res.status(response.status).type("application/json").send(buffer);return;}
    const payload=JSON.parse(buffer.toString());
    if(!Array.isArray(payload.models))throw new Error("Invalid model catalog");
    res.json({object:"list",data:payload.models.map((m:any)=>({id:m.slug,object:"model",owned_by:"openai",context_length:m.context_window,name:m.display_name}))});
  }catch{scope.abort();if(!res.destroyed)res.status(502).json({error:{message:"Model discovery failed",type:"upstream_error"}});}
  finally{scope.dispose();}
});
app.post("/openai/v1/chat/completions",auth,chatCompletion);
app.post("/anthropic/v1/messages",anthropicAuth,anthropicMessages);
app.get("/anthropic/v1/models",anthropicAuth,anthropicModels);



app.use(((err: any,_req: express.Request,res: express.Response,_next: express.NextFunction)=>{
  if(_req.path.startsWith("/anthropic/")){anthropicError(res,err.type === "entity.too.large" ? 413 : 400,"invalid_request_error","Invalid or oversized request body");return;}
  res.status(err.type === "entity.too.large" ? 413 : 400).json({error:{type:"invalid_request_error",message:"Invalid or oversized request body"}});
}) as express.ErrorRequestHandler);
if(require.main === module) {
  app.listen(process.env.PORT || 3033,()=>{
    console.log(`codex-proxy listening on :${process.env.PORT || 3033}`);
    console.log(`auth: ${AUTH_FILE}`);
  });
}
