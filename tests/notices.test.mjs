import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
const source=await readFile('src/index.ts','utf8');
const code="import {SlackClient,SlackFailure,TEAM} from './slack';\n"+source.slice(source.indexOf('// Notification destinations'),source.indexOf('function createServer'));
const b=await build({stdin:{contents:code,resolveDir:process.cwd()+'/src',loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
const {sendNotice}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
const env={SLACK_BOT_TOKEN:'xoxb-test'};
const input=()=>({channel_id:'C0CD27Q9XPX',text:'progress',idempotency_key:crypto.randomUUID()});
function fixture({wrongBot=false,unknown=false}={}){const calls=[];return {calls,call:async(url,options)=>{const method=new URL(url).pathname.split('/').pop();const data=JSON.parse(options.body);calls.push({method,data});if(method==='auth.test')return Response.json({ok:true,team_id:'T067X1VPECV',user_id:wrongBot?'OTHER':'U0CCMCB5T2R',bot_id:'BOT',url:'https://example.slack.com/'});if(unknown)throw new Error('timeout');return Response.json({ok:true,channel:data.channel,ts:'1793280500.000001'});}};}
test('root sends as exact bot to allowlisted channel with recovery marker',async()=>{const f=fixture(),i=input(),r=await sendNotice(env,i,f.call);assert.equal(r.thread_ts,r.ts);assert.equal(f.calls[1].data.thread_ts,undefined);assert(f.calls[1].data.text.includes(i.idempotency_key));assert.equal(f.calls[1].data.unfurl_links,false);});
test('thread append preserves root without broadcast',async()=>{const f=fixture(),i={...input(),thread_ts:'1793280400.000001'};const r=await sendNotice(env,i,f.call);assert.equal(r.thread_ts,i.thread_ts);assert.equal(f.calls[1].data.thread_ts,i.thread_ts);assert.equal(f.calls[1].data.reply_broadcast,false);});
test('destination, UUID, timestamp and empty body fail before network',async()=>{for(const change of [{channel_id:'COTHER'},{idempotency_key:'bad'},{thread_ts:'bad'},{text:''}]){const f=fixture();await assert.rejects(sendNotice(env,{...input(),...change},f.call));assert.equal(f.calls.length,0);}});
test('wrong bot cannot send',async()=>{const f=fixture({wrongBot:true});await assert.rejects(sendNotice(env,input(),f.call),/wrong_notice_bot/);assert.equal(f.calls.length,1);});
test('same key success cached; changed destination/thread conflicts',async()=>{const f=fixture(),i=input();await sendNotice(env,i,f.call);assert.equal((await sendNotice(env,i,f.call)).duplicate,true);await assert.rejects(sendNotice(env,{...i,channel_id:'C0CD19PN37D'},f.call),/conflict/);await assert.rejects(sendNotice(env,{...i,thread_ts:'1793280400.000001'},f.call),/conflict/);assert.equal(f.calls.length,2);});
test('unknown delivery blocks repeat in same isolate',async()=>{const f=fixture({unknown:true}),i=input();await assert.rejects(sendNotice(env,i,f.call),e=>e.uncertain===true);await assert.rejects(sendNotice(env,i,f.call),/previous_attempt/);assert.equal(f.calls.length,2);});

const rawConfig=JSON.parse(await readFile('config/slack-notice-channels.json','utf8'));
const configBundle=await build({entryPoints:['src/notice-config.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {buildNoticeConfig,NOTICE_CONFIG,NOTICE_CHANNELS,NOTICE_DESCRIPTION}=await import('data:text/javascript;base64,'+Buffer.from(configBundle.outputFiles[0].text).toString('base64'));
test('config IDs and descriptions are the only MCP and sender source',()=>{
 assert.deepEqual([...NOTICE_CHANNELS],rawConfig.channels.map(c=>c.id));
 assert.match(source,/channel_id:z.enum\(NOTICE_CHANNELS\)/);
 assert.match(source,/NOTICE_CHANNELS as readonly string\[\]\)\.includes\(input.channel_id\)/);
 assert.match(source,/description: NOTICE_DESCRIPTION/);
 for(const c of rawConfig.channels){assert(NOTICE_DESCRIPTION.includes(c.id));assert(NOTICE_DESCRIPTION.includes('#'+c.name));assert(NOTICE_DESCRIPTION.includes(c.description));}
 assert(Object.isFrozen(NOTICE_CHANNELS));assert(Object.isFrozen(NOTICE_CONFIG.channels));
});
test('all configured destinations send using mocks only',async()=>{
 for(const channel_id of NOTICE_CHANNELS){const f=fixture();await sendNotice(env,{...input(),channel_id},f.call);assert.equal(f.calls[1].data.channel,channel_id);}
});
test('invalid config fails closed',()=>{
 for(const mutate of [c=>{c.version=2},c=>{c.channels=[]},c=>{c.channels[0].id='D123456789'},c=>{c.channels[0].id='Cbad'},c=>{c.channels.push({...c.channels[0]})},c=>{delete c.channels[0].description},c=>{c.channels[0].lane='other'},c=>{c.channels[0].description=' '},c=>{c.unexpected=true}]){const c=structuredClone(rawConfig);mutate(c);assert.throws(()=>buildNoticeConfig(c));}
});
test('adding a destination requires config data only',()=>{
 const c=structuredClone(rawConfig);c.channels.push({id:'C0123456789',name:'future-lane',lane:'work',description:'Future notification'});
 const added=buildNoticeConfig(c);assert(added.ids.includes('C0123456789'));assert(added.description.includes('Future notification'));
});
