/* Renata Mobile: contrato real de API, autorização, concorrência e duração. */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'../app/src/main/assets/mobile');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const moduleJs=fs.readFileSync(path.join(root,'cleaning.js'),'utf8');

function rig() {
  const fields=new Map(),calls=[];
  const user={id:77,role:'recebimento',name:'Operador 77'};
  let current=null;
  const completed=[];
  let nextId=3;
  const snapshot=()=>({
    areas:['PCP','RH','Logística'],
    active:[{id:22,area:'RH',user_id:88,user_name:'Colega',status:'EM_ANDAMENTO',worked_seconds:45,paused_seconds:0,
      started_at:'2026-11-04T08:20:00-03:00'},...(current?[{...current}]:[])],
    by_area:[{area:'PCP',tasks:2,avg_seconds:60},{area:'RH',tasks:1,avg_seconds:25},{area:'Logística',tasks:0,avg_seconds:0}],
    recent:completed.slice(),
    totals:{tasks:3,avg_seconds:40},
  });
  const api={
    async get(url) {
      calls.push({method:'GET',url});
      assert.match(url,/^\/api\/cleaning\/overview\?user_id=77&days=(?:7|30|90|0)$/);
      return snapshot();
    },
    async post(url,data){
      calls.push({method:'POST',url,data});
      assert.equal(data.user_id,77);
      if(url==='/api/cleaning/tasks'){
        if(current)throw Error('Limpeza já iniciada');
        if(data.area==='RH')throw Error('Área ocupada');
        current={id:nextId++,area:data.area,user_id:77,user_name:'Operador 77',
          status:'EM_ANDAMENTO',worked_seconds:0,paused_seconds:0,notes:data.notes,started_at:'2026-11-04T08:22:00-03:00'};
        return {ok:true,id:current.id};
      }
      if(!current||url!=='/api/cleaning/tasks/'+current.id+'/'+url.split('/').at(-1))throw Error('Rota inválida');
      const op=url.split('/').at(-1);
      if(op==='pause')current.status='PAUSADA';
      else if(op==='resume')current.status='EM_ANDAMENTO';
      else if(op==='finish'){
        completed.push({...current,status:'CONCLUIDA',finished_at:'2026-11-04T08:35:00-03:00'});
        current=null;
      }else throw Error('Ação desconhecida');
      return {ok:true};
    }
  };
  const ctx={
    window:{DM_API:api,confirm:()=>true},
    document:{
      getElementById:id=>fields.get(id)||null,
      querySelectorAll:()=>[]
    },
    Date,Math,Number,String,Promise,Set,Map,encodeURIComponent,
  };
  vm.createContext(ctx);
  vm.runInContext(moduleJs,ctx,{timeout:5000});
  return {flow:ctx.window.DM_CLEANING,user,fields,calls};
}
test('Renata is bundled and accessible independently of WMS card sectors',()=>{
  assert.match(html,/cleaning\.js/);
  assert.match(app,/id:'cleaning'/);
  assert.match(app,/window\.DM_CLEANING\.init/);
  assert.match(app,/window\.DM_CLEANING\.action/);
  assert.match(app,/window\.DM_CLEANING\.tick/);
});
test('reads real Supabase-backed API, renders blocked areas read-only',async()=>{
  const {flow,user}=rig();
  await flow.init(user);
  const html=flow.view(user);
  assert.match(html,/Renata/);
  assert.match(html,/PCP/);
  assert.match(html,/RH/);
  assert.match(html,/Colega/);
  assert.match(html,/clean-mobile-area occupied/);
  assert.match(html,/disabled aria-disabled="true"/);
  assert.match(html,/Limpeza por área/);
});
test('start pauses resumes and finishes using server endpoints, never offline timers',async()=>{
  const {flow,user,fields,calls}=rig();
  await flow.init(user);
  fields.set('cleanMobileNotes',{value:'Higienização'});
  await flow.action('start',{dataset:{area:'PCP'}},user);
  assert.ok(flow.view(user).includes('cleanMobileClock'));
  await assert.rejects(()=>flow.action('start',{dataset:{area:'Logística'}},user),/já possui/);
  await flow.action('pause',null,user);
  assert.match(flow.view(user),/Pausada/);
  await flow.action('resume',null,user);
  await flow.action('finish',null,user);
  assert.ok(flow.view(user).includes('Últimas conclusões'));
  const operations=calls.filter(c=>c.method==='POST');
  assert.deepEqual(operations.map(x=>x.url),[
    '/api/cleaning/tasks','/api/cleaning/tasks/3/pause',
    '/api/cleaning/tasks/3/resume','/api/cleaning/tasks/3/finish'
  ]);
  assert.equal(operations[0].data.notes,'Higienização');
});
test('rejects action on an occupied area and invalid period',async()=>{
  const {flow,user,calls}=rig();
  await flow.init(user);
  await assert.rejects(()=>flow.action('start',{dataset:{area:'RH'}},user),/em uso/);
  await assert.rejects(()=>flow.action('days',{dataset:{days:'999'}},user),/inválido/);
  assert.equal(calls.filter(c=>c.method==='POST').length,0);
});
