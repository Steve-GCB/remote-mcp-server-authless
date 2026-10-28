import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
test('SlackClient calls native Workers fetch with the correct receiver',async()=>{
 const b=await build({stdin:{contents:`import {SlackClient,safeSlackError} from './slack'; export default {async fetch(){try{return Response.json(await new SlackClient({SLACK_BOT_TOKEN:'xoxb-local-test-only'}).api('auth.test'))}catch(e){return Response.json(safeSlackError(e),{status:500})}}}`,resolveDir:process.cwd()+'/src',loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false});
 let outbound=0;
 const mf=new Miniflare({workers:[{config:{name:'slack-native-fetch-test',compatibilityDate:'2026-07-02',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],manifest:{mainModule:'index.js',modulesRoot:process.cwd(),modules:{'index.js':{type:'esm',contents:b.outputFiles[0].text}}}},dev:{outboundService:{type:'fetcher',handler:async()=>{outbound++;return Response.json({ok:true,team_id:'TTEST'})}}}}]});
 try {const r=await mf.dispatchFetch('https://example.test');assert.equal(r.status,200);assert.equal((await r.json()).ok,true);assert.equal(outbound,1);}finally{await mf.dispose()}
});
