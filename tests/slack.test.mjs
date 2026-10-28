import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({entryPoints:['src/slack.ts'],bundle:true,platform:'node',format:'esm',write:false});
const mod=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const {sendSlack,getReplies,SlackFailure}=mod;
const env={SLACK_BOT_TOKEN:'xoxb-test-only'};
const identity={ok:true,team_id:'T067X1VPECV',bot_id:'BTEST',user_id:'UBOT',url:'https://example.slack.com/'};
function fixture(overrides={}) {
 const calls=[];
 const call=async(url,options)=>{const u=new URL(url);const method=u.pathname.split('/').pop();const data=options.method==='GET'?Object.fromEntries(u.searchParams):JSON.parse(options.body);calls.push({method,data});
 const entry=overrides[method]; if(entry instanceof Error) throw entry;
 if(entry instanceof Response) return entry;
 const standard={'auth.test':identity,'conversations.open':{ok:true,channel:{id:'DTEST',is_im:true,user:'U07B419C2QG'}},'conversations.history':{ok:true,messages:[]},'chat.postMessage':{ok:true,channel:'DTEST',ts:'1793180000.000001'},'chat.getPermalink':{ok:true,permalink:'https://example.slack.com/archives/DTEST/p1793180000000001'}};
 return Response.json(entry??standard[method]??{ok:false,error:'unexpected_method'});
 }; return {call,calls};
}
test('send is fixed to owner DM and successful same key does not post twice',async()=>{const f=fixture(),key=crypto.randomUUID();const a=await sendSlack(env,'test',key,f.call);const b=await sendSlack(env,'test',key,f.call);assert.equal(a.channel,'DTEST');assert.equal(b.duplicate,true);assert.equal(f.calls.filter(x=>x.method==='chat.postMessage').length,1);assert.deepEqual(f.calls.find(x=>x.method==='conversations.open').data.users,'U07B419C2QG');});
test('unknown delivery is never automatically retried',async()=>{const f=fixture({'chat.postMessage':new Error('network')}),key=crypto.randomUUID();await assert.rejects(sendSlack(env,'test',key,f.call),e=>e.uncertain===true);await assert.rejects(sendSlack(env,'test',key,f.call),/previous_attempt/);assert.equal(f.calls.filter(x=>x.method==='chat.postMessage').length,1);});
test('429 respected without retry',async()=>{const f=fixture({'chat.postMessage':new Response('',{status:429,headers:{'retry-after':'120'}})});await assert.rejects(sendSlack(env,'test',crypto.randomUUID(),f.call),e=>e.code==='ratelimited'&&e.retryAfter===120);assert.equal(f.calls.filter(x=>x.method==='chat.postMessage').length,1);});
test('invalid bot token and wrong workspace reject before posting',async()=>{let f=fixture({'auth.test':{ok:false,error:'invalid_auth'}});await assert.rejects(sendSlack(env,'test',crypto.randomUUID(),f.call),/invalid_auth/);assert(!f.calls.some(x=>x.method==='chat.postMessage'));f=fixture({'auth.test':{...identity,team_id:'OTHER'}});await assert.rejects(sendSlack(env,'test',crypto.randomUUID(),f.call),/wrong_bot_workspace/);});
test('unexpected DM is rejected',async()=>{const f=fixture({'conversations.open':{ok:true,channel:{id:'COTHER',is_im:false,user:'UOTHER'}}});await assert.rejects(sendSlack(env,'test',crypto.randomUUID(),f.call),/unexpected_dm/);assert(!f.calls.some(x=>x.method==='chat.postMessage'));});
test('history filters bot, other user, system events and bounds result',async()=>{const now=1793180100;const f=fixture({'conversations.history':{ok:true,messages:[{type:'message',ts:'1793180000.000001',user:'U07B419C2QG',text:'owner'},{type:'message',ts:'1793180001.000001',user:'UBOT',bot_id:'BTEST',text:'bot'},{type:'message',ts:'1793180002.000001',user:'UOTHER',text:'other'},{type:'message',ts:'1793180003.000001',user:'U07B419C2QG',subtype:'channel_join',text:'system'}]}});const r=await getReplies(env,{},f.call,now);assert.deepEqual(r.messages.map(x=>x.text),['owner']);assert.equal(r.content_trust,'untrusted_external_data');});
test('thread replies call replies in fixed DM and exclude parent',async()=>{const now=1793180100,parent='1793180000.000001';const f=fixture({'conversations.replies':{ok:true,messages:[{type:'message',ts:parent,user:'U07B419C2QG',text:'parent'},{type:'message',ts:'1793180001.000001',thread_ts:parent,user:'U07B419C2QG',text:'reply'}]}});const r=await getReplies(env,{thread_ts:parent},f.call,now);assert.deepEqual(r.messages.map(x=>x.text),['reply']);assert.equal(f.calls.find(x=>x.method==='conversations.replies').data.channel,'DTEST');});
test('old or future query rejected before Slack access',async()=>{const f=fixture();await assert.rejects(getReplies(env,{after_ts:'1.000000'},f.call,1793180100),/within_last_7_days/);assert.equal(f.calls.length,0);});
