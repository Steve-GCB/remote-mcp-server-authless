import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const ORIGIN='https://gcb-mcp-test.satoshi-yamashita.workers.dev',RESOURCE=ORIGIN+'/mcp';
const source=(await readFile('src/index.ts','utf8')).replace("{ allowedOriginHostnames:","{ allowedHostnames:[new URL(ORIGIN).hostname,'127.0.0.1'], allowedOriginHostnames:");
const clockSource=source.replace('export default new OAuthProvider<Env>(', 'const provider=new OAuthProvider<Env>(')+'\nlet offset=0;const originalNow=Date.now.bind(Date);Date.now=()=>originalNow()+offset;export default {fetch(req,env,ctx){if(new URL(req.url).pathname==="/__test/expire"){offset=7200000;return new Response("ok")}return provider.fetch(req,env,ctx)}};';
const bundle=await build({stdin:{contents:clockSource,resolveDir:process.cwd()+'/src',sourcefile:'index.ts',loader:'ts'},bundle:true,platform:'browser',format:'esm',external:['cloudflare:workers','node:*'],conditions:['workerd','worker','browser'],write:false});
let owner=true;
const mf=new Miniflare({workers:[{config:{name:'gcb-test',compatibilityDate:'2026-07-02',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],manifest:{mainModule:'index.js',modulesRoot:process.cwd(),modules:{'index.js':{type:'esm',contents:bundle.outputFiles[0].text}}},env:{OAUTH_KV:{type:'kv',id:'local-oauth'},GITHUB_CLIENT_ID:{type:'json',value:'test'},GITHUB_CLIENT_SECRET:{type:'json',value:'test-secret'}}},dev:{outboundService:{type:'fetcher',handler:async(req)=>{const url=new URL(req.url);if(url.hostname==='github.com'&&url.pathname==='/login/oauth/access_token')return Response.json({access_token:'test-upstream'});if(url.hostname==='api.github.com'&&url.pathname==='/user')return Response.json({id:owner?349220116:123,type:'User',login:owner?'Steve-GCB':'Other'});throw new Error('Unexpected test outbound: '+url.hostname);}}}}]});
const worker=await mf.getWorker('gcb-test');
const cookies=new Map();
async function request(path,init={}) {const headers=new Headers(init.headers);if(cookies.size)headers.set('Cookie',[...cookies].map(([k,v])=>k+'='+v).join('; '));const r=await mf.dispatchFetch(new URL(path,ORIGIN).href,{...init,headers:Object.fromEntries(headers),redirect:'manual'});for(const c of r.headers.getSetCookie()){const[k,v]=c.split(';')[0].split('=');if(v)cookies.set(k,v);else cookies.delete(k);}return r;}
const passed=[];
try {
 let r=await request('/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,401);assert.match(r.headers.get('www-authenticate'),/resource_metadata/);passed.push('unauthenticated 401');
 r=await request('/mcp',{headers:{Authorization:'Bearer invalid'}});assert.equal(r.status,401);passed.push('invalid token 401');
 const metadata=await(await request('/.well-known/oauth-authorization-server')).json();assert(metadata.code_challenge_methods_supported.includes('S256'));assert(metadata.grant_types_supported.includes('refresh_token'));passed.push('OAuth metadata PKCE and refresh');
 const resource=await(await request('/.well-known/oauth-protected-resource/mcp')).json();assert.equal(resource.resource,RESOURCE);passed.push('resource metadata');
 const registration=await(await request('/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'GCB integration test',redirect_uris:['http://127.0.0.1:9876/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})})).json();assert(registration.client_id);passed.push('DCR');
 const verifier='v'.repeat(64);const challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
 async function startConsent(extra={}) {
  cookies.clear();
  const q=new URLSearchParams({response_type:'code',client_id:registration.client_id,redirect_uri:'http://127.0.0.1:9876/callback',scope:'mcp:use offline_access',state:'test-state',resource:RESOURCE,code_challenge:challenge,code_challenge_method:'S256',...extra});
  const r=await request('/authorize?'+q);assert.equal(r.status,200);
  assert.equal(r.headers.get('cache-control'),'no-store');
  const csp=r.headers.get('content-security-policy');
  assert.equal(csp,"default-src 'none'; form-action 'self' https://github.com http://127.0.0.1:9876; base-uri 'none'; frame-ancestors 'none'");
  for(const cookie of r.headers.getSetCookie()) {
   for(const flag of ['Path=/','Secure','HttpOnly','SameSite=Lax','Max-Age=600']) assert(cookie.includes(flag));
   assert(!/;\s*Domain=/i.test(cookie));
  }
  const html=await r.text();assert(!/http-equiv=["']Content-Security-Policy/i.test(html));assert(html.includes('<form method="post">'));
  return html.match(/name="handle" value="([^"]+)"/)[1];
 }
 async function postConsent(handle,decision='approve',origin=ORIGIN,extra={}) {
  return request('/authorize',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:origin},body:new URLSearchParams({handle,decision,...extra})});
 }
 let handle=await startConsent({return_to:'https://untrusted.example'});
 const binding=[...cookies];cookies.clear();r=await postConsent(handle);assert.equal(r.status,400);assert.match(await r.text(),/browser_cookie_missing/);
 for(const [k,v] of binding) cookies.set(k,v);
 r=await postConsent(handle,'approve','https://untrusted.example');assert.equal(r.status,403);
 r=await postConsent(handle,'approve',ORIGIN,{redirect_uri:'https://untrusted.example'});assert.equal(r.status,302);
 const upstreamURL=new URL(r.headers.get('location'));assert.equal(upstreamURL.origin,'https://github.com');assert.equal(upstreamURL.pathname,'/login/oauth/authorize');assert.equal(upstreamURL.searchParams.get('redirect_uri'),ORIGIN+'/github/callback');assert.equal(upstreamURL.searchParams.get('code_challenge_method'),'S256');
 assert(r.headers.getSetCookie().some(c=>c.includes('Max-Age=0')));assert(r.headers.getSetCookie().some(c=>c.includes('Max-Age=600')));
 r=await postConsent(handle);assert.equal(r.status,400);assert.match(await r.text(),/browser_cookie_missing/);
 passed.push('validated redirect origin in CSP; secure host-only cookies; CSRF and consumed-cookie replay rejected');
 r=await request('/github/callback?'+new URLSearchParams({state:upstreamURL.searchParams.get('state'),error:'access_denied'}));assert.equal(r.status,302);assert.equal(new URL(r.headers.get('location')).searchParams.get('error'),'access_denied');
 r=await request('/github/callback?'+new URLSearchParams({state:upstreamURL.searchParams.get('state'),code:'test-code'}));assert.equal(r.status,400);
 handle=await startConsent();r=await postConsent(handle,'deny',ORIGIN,{redirect_uri:'https://untrusted.example'});assert.equal(r.status,302);assert.equal(new URL(r.headers.get('location')).origin,'http://127.0.0.1:9876');
 passed.push('GitHub denial and callback replay; consent denial uses stored validated redirect');
 const chatClient=await(await request('/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'ChatGPT redirect fixture',redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})})).json();assert(chatClient.client_id);
 const chatQuery=new URLSearchParams({response_type:'code',client_id:chatClient.client_id,redirect_uri:'https://chatgpt.com/connector_platform_oauth_redirect',scope:'mcp:use',state:'chat-fixture',resource:RESOURCE,code_challenge:challenge,code_challenge_method:'S256'});
 cookies.clear();r=await request('/authorize?'+chatQuery);assert.equal(r.status,200);assert.equal(r.headers.get('content-security-policy'),"default-src 'none'; form-action 'self' https://github.com https://chatgpt.com; base-uri 'none'; frame-ancestors 'none'");
 handle=(await r.text()).match(/name="handle" value="([^"]+)"/)[1];r=await postConsent(handle,'deny');assert.equal(r.status,302);assert.equal(new URL(r.headers.get('location')).origin,'https://chatgpt.com');
 chatQuery.set('redirect_uri','https://untrusted.example/callback');r=await request('/authorize?'+chatQuery);assert(r.status>=400);passed.push('ChatGPT return origin allowed; unregistered redirect rejected (local fixture)');
 async function authorize(allowed=true){owner=allowed;const handle=await startConsent();let r=await postConsent(handle);assert.equal(r.status,302,await r.clone().text());const upstream=new URL(r.headers.get('location'));r=await request('/github/callback?'+new URLSearchParams({state:upstream.searchParams.get('state'),code:'test-code'}));assert.equal(r.status,302);return new URL(r.headers.get('location'));}
 const denied=await authorize(false);assert.equal(denied.searchParams.get('error'),'access_denied');passed.push('third-party GitHub ID denied');
 const approved=await authorize(true);assert.equal(approved.searchParams.get('state'),'test-state');assert.equal(approved.searchParams.get('iss'),ORIGIN);
 async function token(data){return request('/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data)});}
 r=await token({grant_type:'authorization_code',client_id:registration.client_id,code:approved.searchParams.get('code'),redirect_uri:'http://127.0.0.1:9876/callback',code_verifier:'wrong',resource:RESOURCE});assert.equal(r.status,400);passed.push('wrong PKCE rejected');
 const approved2=await authorize(true);
 r=await token({grant_type:'authorization_code',client_id:registration.client_id,code:approved2.searchParams.get('code'),redirect_uri:'http://127.0.0.1:9876/callback',code_verifier:verifier,resource:RESOURCE});assert.equal(r.status,200);const tokens=await r.json();assert(tokens.access_token&&tokens.refresh_token);passed.push('authorized token issuance');
 const transport=new StreamableHTTPClientTransport(new URL(RESOURCE),{fetch:async(url,options={})=>{const headers=new Headers(options.headers);headers.set('Host',new URL(ORIGIN).hostname);headers.set('Authorization','Bearer '+tokens.access_token);return worker.fetch(String(url),{...options,headers:Object.fromEntries(headers)});}});const client=new Client({name:'gcb-test',version:'1'});await client.connect(transport);assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['hello','send_slack','get_slack_replies','send_slack_notice']);assert.equal((await client.callTool({name:'hello',arguments:{name:'GCB'}})).content[0].text,'Hello, GCB!');const tools=(await client.listTools()).tools;const notice=tools.find(t=>t.name==='send_slack_notice');const channels=JSON.parse(await readFile('config/slack-notice-channels.json','utf8')).channels;assert.deepEqual(notice.inputSchema.properties.channel_id.enum,channels.map(c=>c.id));for(const c of channels){assert(notice.description.includes(c.id));assert(notice.description.includes(c.description));}assert.deepEqual(tools.find(t=>t.name==='hello').inputSchema.properties.name,{type:'string',maxLength:100});assert.equal(tools.find(t=>t.name==='send_slack').inputSchema.properties.text.maxLength,3000);assert.equal(tools.find(t=>t.name==='get_slack_replies').inputSchema.properties.limit.maximum,10);passed.push('MCP SDK initialize/list/hello and config-derived enum/description, legacy schemas');
 const invalid=await client.callTool({name:'send_slack',arguments:{text:'NO SEND',idempotency_key:crypto.randomUUID(),user_id:'UOTHER'}});assert(invalid.isError);const invalidRead=await client.callTool({name:'get_slack_replies',arguments:{channel:'COTHER'}});assert(invalidRead.isError);passed.push('unknown recipient/channel inputs rejected');await client.close();
 r=await token({grant_type:'refresh_token',client_id:registration.client_id,refresh_token:tokens.refresh_token,resource:'https://other.example/mcp'});assert.equal(r.status,400);passed.push('wrong refresh audience rejected');
 r=await token({grant_type:'refresh_token',client_id:registration.client_id,refresh_token:tokens.refresh_token,resource:RESOURCE,scope:'offline_access'});assert.equal(r.status,200);const narrowed=await r.json();r=await request('/mcp',{method:'POST',headers:{Authorization:'Bearer '+narrowed.access_token,'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,403);passed.push('scope insufficiency 403, refresh works');
 const recovery=await authorize(true);r=await token({grant_type:'authorization_code',client_id:registration.client_id,code:recovery.searchParams.get('code'),redirect_uri:'http://127.0.0.1:9876/callback',code_verifier:verifier,resource:RESOURCE});assert.equal(r.status,200);const recoveryTokens=await r.json();
 await request('/__test/expire');r=await request('/mcp',{headers:{Authorization:'Bearer '+tokens.access_token}});assert.equal(r.status,401);passed.push('expired access token 401 (test clock only)');
 r=await token({grant_type:'refresh_token',client_id:registration.client_id,refresh_token:recoveryTokens.refresh_token,resource:RESOURCE});assert.equal(r.status,200);const renewed=await r.json();assert(renewed.access_token&&renewed.refresh_token);assert.notEqual(renewed.refresh_token,recoveryTokens.refresh_token);
 const renewedClient=new Client({name:'gcb-refresh-test',version:'1'});await renewedClient.connect(new StreamableHTTPClientTransport(new URL(RESOURCE),{fetch:async(url,options={})=>{const headers=new Headers(options.headers);headers.set('Host',new URL(ORIGIN).hostname);headers.set('Authorization','Bearer '+renewed.access_token);return worker.fetch(String(url),{...options,headers:Object.fromEntries(headers)});}}));assert.equal((await renewedClient.callTool({name:'hello',arguments:{name:'GCB'}})).content[0].text,'Hello, GCB!');await renewedClient.close();passed.push('expired access recovered by rotated refresh token and MCP hello');
 console.log(JSON.stringify({passed},null,2));
}finally {await mf.dispose();}
