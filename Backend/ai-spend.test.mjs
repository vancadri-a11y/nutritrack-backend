import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeteredFetch } from './ai-spend.mjs';
const json = data => new Response(JSON.stringify(data));
const options = { body:JSON.stringify({model:'gpt-4o-mini',input:'plato',instructions:'nutrition',max_output_tokens:7000,text:{format:{type:'json_schema'}}}) };
const identity={id:'a'};
test('Token count precedes spend allocation and records actual cached usage',async()=>{
  const order=[];let paidBody;
  const quota={reserveSpend:async(...args)=>{order.push('reserve');assert.deepEqual(args.slice(2,5),['gpt-4o-mini',250,800]);return {allowed:true,spend_id:'spend'};},
    finishSpend:async(...args)=>{order.push('settle');assert.deepEqual(args.slice(1),['spend',250,50,100,'resp_1']);}};
  const metered=createMeteredFetch({identity,reservation:'r',quota,maxOutputTokens:800,fetchImpl:async(url,opts)=>{
    if(url.endsWith('/input_tokens')) {order.push('count');assert.ok(JSON.parse(opts.body).text);return json({input_tokens:250});}
    order.push('generate');paidBody=JSON.parse(opts.body);
    return json({id:'resp_1',usage:{input_tokens:250,output_tokens:50,input_tokens_details:{cached_tokens:100}}});
  }});
  assert.equal((await metered('https://api.openai.com/v1/responses',options)).status,200);
  assert.deepEqual(order,['count','reserve','generate','settle']);assert.equal(paidBody.max_output_tokens,800);assert.equal(paidBody.service_tier,'default');
});
test('Exhausted budget and excessive input prevent any paid call',async()=>{
  for(const tooLarge of [false,true]) {
    let calls=0,allocations=0;
    const metered=createMeteredFetch({identity,reservation:'r',maxInputTokens:500,quota:{reserveSpend:async()=>{allocations++;return {allowed:false,reason:'budget_exhausted'};}},fetchImpl:async url=>{
      if(url.endsWith('/input_tokens'))return json({input_tokens:tooLarge?501:100});calls++;throw new Error();
    }});
    await assert.rejects(metered('https://api.openai.com/v1/responses',options),e=>e.code===(tooLarge?'input_token_limit':'budget_exhausted'));
    assert.equal(calls,0);assert.equal(allocations,tooLarge?0:1);
  }
});
test('Missing usage, transport errors and failed settlement keep allocations charged',async()=>{
  for(const mode of ['missing','network','settlement']) {
    let reserves=0,settles=0;
    const metered=createMeteredFetch({identity,reservation:'r',quota:{reserveSpend:async()=>{reserves++;return {allowed:true,spend_id:'s'};},finishSpend:async()=>{settles++;throw new Error('db');}},fetchImpl:async url=>{
      if(url.endsWith('/input_tokens'))return json({input_tokens:100});
      if(mode==='network')throw new Error('timeout');
      return json(mode==='missing'?{status:'incomplete'}:{usage:{input_tokens:100,output_tokens:20}});
    }});
    if(mode==='missing')await metered('https://api.openai.com/v1/responses',options);
    else await assert.rejects(metered('https://api.openai.com/v1/responses',options));
    assert.equal(reserves,1);assert.equal(settles,mode==='settlement'?1:0);
  }
});
test('Failed token count blocks spend and generation',async()=>{
  let calls=0;
  const metered=createMeteredFetch({identity,quota:{reserveSpend:async()=>{throw new Error('must not happen');}},fetchImpl:async()=>{calls++;return new Response('{}',{status:503});}});
  await assert.rejects(metered('https://api.openai.com/v1/responses',options),e=>e.code==='token_count_unavailable');assert.equal(calls,1);
});
