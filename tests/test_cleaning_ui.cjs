/* Testes da tela Renata: estado real e identidade preservada. */
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const vm=require('node:vm');
const script=fs.readFileSync(require('node:path').resolve(__dirname,'../static/cleaning_ui.js'),'utf8');

function harness(myTask=null){
  const box={innerHTML:''},calls=[];
  const active=[
    {id:19,area:'RH',user_id:900,user_name:'Pessoa RH',status:'PAUSADA',worked_seconds:111,paused_seconds:25,started_at:'2026-11-04T09:00:00-03:00'},
    ...(myTask?[myTask]:[])
  ];
  const reply={
    areas:['PCP','RH','Logística'],active,
    by_area:[{area:'PCP',tasks:4,avg_seconds:91,total_seconds:364},{area:'RH',tasks:2,avg_seconds:32,total_seconds:64}],
    recent:[{id:3,area:'Logística',user_name:'Operadora',finished_at:'2026-11-04T09:02:00-03:00',
      worked_seconds:120,paused_seconds:0,notes:'Limpeza realizada'}],
    totals:{tasks:6,total_seconds:428,avg_seconds:71}
  };
  const ctx={
    currentUser:{id:77,role:'recebimento',name:'Operador'},
    cleaningDays:30,cleaningTick:null,
    api:async url=>{calls.push(url);return reply},
    setPage:()=>{},clearInterval:()=>{},
    setInterval:()=>123,
    $:()=>box,document:{querySelectorAll:()=>[]},
    esc:s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),
    fmtDurationShort:s=>String(Math.floor(s||0))+'s',
    fmtSeconds:s=>String(s),
    cleaningTimerHtml:(row,at)=>'<span data-clean-timer data-base="'+row.worked_seconds+'" data-running="'+(row.status==='EM_ANDAMENTO'?1:0)+'" data-fetched="'+at+'">'+row.worked_seconds+'</span>',
    cleaningActionButtons:()=>'<button>Concluir limpeza</button>',
    DISTRILOG_I18N:{getLanguage:()=> 'pt-BR'},
    Date,Math,Number,Map,Array,
  };
  vm.createContext(ctx);
  vm.runInContext(script,ctx);
  return {ctx,box,calls};
}
test('painel responde a todas as áreas, não permite assumir área ocupada',async()=>{
  const {ctx,box,calls}=harness();
  await vm.runInContext('renderCleaningPro()',ctx);
  assert.match(box.innerHTML,/ROTINA OPERACIONAL/);
  assert.match(box.innerHTML,/PCP/);
  assert.match(box.innerHTML,/Pessoa RH/);
  assert.match(box.innerHTML,/ren-area-busy/);
  assert.match(box.innerHTML,/disabled aria-disabled="true"/);
  assert.match(box.innerHTML,/Limpeza realizada/);
  assert.equal(calls[0],'/api/cleaning/overview?user_id=77&days=30');
});
test('limpeza própria recebe destaque e relógio atualizado, sem duplicar botão de iniciar',async()=>{
  const own={id:20,area:'Logística',user_id:77,user_name:'Operador',status:'EM_ANDAMENTO',
    worked_seconds:60,paused_seconds:12,started_at:'2026-11-04T09:01:00-03:00',
    notes:'Verificação do escritório'};
  const {ctx,box}=harness(own);
  await vm.runInContext('renderCleaningPro()',ctx);
  assert.match(box.innerHTML,/MINHA ATIVIDADE/);
  assert.match(box.innerHTML,/Verificação do escritório/);
  assert.match(box.innerHTML,/data-clean-timer/);
  assert.doesNotMatch(box.innerHTML,/id="cleaningNotes"/);
});
