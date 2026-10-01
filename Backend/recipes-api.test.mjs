import test from 'node:test';
import assert from 'node:assert/strict';
import {createAPIHandler} from './api-handler.mjs';
const input={recipe:{title:'Avena',minutes:10,allergens:'Leche',ingredients:[{name:'Avena',quantity:40,unit:'g'}],steps:['Cocina la avena.']},portions:1,instruction:'Mejora la textura'};
const proposal={title:'Avena cremosa',summary:'Remueve lentamente.',ingredients:[{name:'Avena',quantity:40,unit:'g'}],steps:[{title:'Cocina',instruction:'Cocina a fuego bajo.',minutes:5}],tips:['Remueve.'],nutritionNote:'Verifica los nutrientes.',allergyNote:'Revisa las etiquetas.'};
function req(body=input,key='recipe-v5-key-000001',user='a') {return new Request('https://example.test/v1/recipes/improve',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key,'X-User':user},body:JSON.stringify(body)});}
function make(options={}) {return createAPIHandler({apiKey:'test',authenticate:async r=>({id:r.headers.get('X-User')}),fetchImpl:async()=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(proposal)}]}]})),...options});}
test('asistente de recetas exige autenticación y proveedor',async()=>{
 assert.equal((await make({authenticate:async()=>null})(req())).status,401);
 assert.equal((await make({apiKey:undefined})(req())).status,503);
});
test('ruta de recetas valida cuerpo, usa caché y separa usuarios',async()=>{
 let calls=0;const h=make({fetchImpl:async()=>{calls++;return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(proposal)}]}]}));}});
 const first=await h(req());assert.equal(first.status,200);assert.equal((await first.json()).source,'ai');
 const second=await h(req());assert.equal(second.headers.get('X-Analysis-Cache'),'hit');assert.equal(calls,1);
 assert.equal((await h(req(input,'recipe-v5-key-000001','b'))).status,200);assert.equal(calls,2);
 assert.equal((await h(req({...input,instruction:'Cambia textura'}))).status,409);
 assert.equal((await h(req({...input,instruction:''},'recipe-v5-key-000002'))).status,400);
});
