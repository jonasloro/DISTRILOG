/* Contratos e teste das ações reais da Separação/Expedição no APK. */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.resolve(__dirname,'../app/src/main/assets/mobile');
const shippingScript=fs.readFileSync(path.join(root,'shipping.js'),'utf8');
const script=fs.readFileSync(path.join(root,'outbound.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');

function harness(){
  const fields=new Map();
  const calls=[];
  let rows=[{id:7,document_no:'123',destination:'Loja Centro',
    status:'PENDENTE',expected_qty:3,excluded_street_qty:2,
    excluded_without_casulo_qty:1,operator_id:null,accumulated_pause_seconds:0}];
  const orders=()=>rows.map(o=>({...o}));
  const api={
    async get(p){
      calls.push(['GET',p]);
      if(p==='/api/separation/orders')return orders();
      if(p==='/api/separation/entry-alerts')return [{reference:'REF-X',days_since_entry:4}];
      if(p==='/api/separation/orders/7/items')return [{reference:'REF-A',casulo:'010-01',quantity:3}];
      if(p==='/api/shipping/queue')return [{id:9,stage:'CONFERENCIA',document_no:'123',total_qty:3,volume_count:0}];
      if(p==='/api/shipping/9')return {id:9,stage:'CONFERENCIA',document_no:'123',destination:'',total_qty:3,volume_count:0,events:[]};
      throw Error('Rota inesperada '+p);
    },
    async post(p,body){
      calls.push(['POST',p,body]);
      if(p.endsWith('/start')){rows[0].status='EM_ANDAMENTO';rows[0].started_at=new Date().toISOString();}
      if(p.endsWith('/complete'))rows[0].status='CONCLUIDA';
      return {ok:true};
    },
    async patch(p,body){calls.push(['PATCH',p,body]);return {ok:true};}
  };
  const ctx={window:{DM_API:api,confirm:()=>true},document:{getElementById:id=>fields.get(id)||null},Date,Math,Number,String,Promise,Set,Map};
  vm.createContext(ctx);vm.runInContext(shippingScript,ctx);vm.runInContext(script,ctx);
  return {flow:ctx.window.DM_OUTBOUND,fields,calls,rows};
}
test('Separação e Expedição estão disponíveis no APK, fora do módulo Recebimento',()=>{
  assert.match(html,/outbound\.js/);
  assert.match(ui,/id:'separation'/);
  assert.match(ui,/id:'shipping'/);
  assert.match(ui,/window\.DM_OUTBOUND\.view/);
  assert.match(ui,/window\.DM_OUTBOUND\.action/);
});
test('timer separação é iniciado no servidor; 001- não é somado no mobile',async()=>{
  const {flow,calls}=harness();
  await flow.load('separation');
  const view=flow.view('separation',{id:1,role:'separacao'});
  assert.match(view,/3 peças elegíveis/);
  assert.match(view,/2 rua 001-/);
  assert.match(view,/REF-X/);
  await flow.action('start',{dataset:{id:'7'}},{id:1,role:'separacao'});
  assert.equal(calls.filter(c=>c[1]==='/api/separation/orders/7/start').length,1);
});
test('fechamento exige todos os campos e envia apenas o apontamento ao servidor',async()=>{
  const {flow,fields,calls}=harness();
  await flow.load('separation');await flow.action('start',{dataset:{id:'7'}},{id:1,role:'separacao'});
  await flow.action('finishForm',{dataset:{id:'7'}},{id:1,role:'separacao'});
  const values={outBags:'2',outBoxes:'1',outPieces:'3',outWeight:'4.123',outZero:'no',outPaused:'yes',
    outFinalReason:'Reposição',outPauseDuration:'00:02:00'};
  for(const [name,value] of Object.entries(values))fields.set(name,{value});
  await flow.action('finish',{}, {id:1,role:'separacao'});
  const call=calls.find(c=>c[1]==='/api/separation/orders/7/complete');
  assert.ok(call);
  assert.equal(call[2].bags,2);
  assert.equal(call[2].boxes,1);
  assert.equal(call[2].separated_qty,3);
  assert.equal(call[2].pause_duration,'00:02:00');
  assert.equal(call[2].pause_reason,'Reposição');
  assert.equal(call[2].zero_left,false);
});
test('expedição recebe seus próprios romaneios, sem permitir ação a outro setor',async()=>{
  const {flow,calls}=harness();
  await flow.load('shipping');
  assert.match(flow.view('shipping',{id:1,role:'expedicao'}),/Expedição/);
  await flow.action('shipOpen',{dataset:{id:'9'}},{id:1,role:'expedicao'});
  assert.match(flow.view('shipping',{id:1,role:'expedicao'}),/Conferência de lacres/);
  await assert.rejects(()=>flow.action('shipClaim',{}, {id:1,role:'recebimento'}),/não permitida/);
  assert.equal(calls.some(c=>c[0]==='PATCH'),false);
});
