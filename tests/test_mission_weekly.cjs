/* Snapshot board regression: no spreadsheet dependency, no premature zero. */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const weeklyJS=fs.readFileSync(
  path.join(__dirname,'..','static','mission_weekly.js'),'utf8'
);

const cut=(state,captured=null)=>({status:state,captured_at:captured,scheduled_for:'2026-11-02T08:10:00-03:00'});
function weekRecord(snapshots,backlog,produced,sourceSupported=true){
  const closed=snapshots.FRI.status==='captured';
  const preview=snapshots.WED.status==='captured';
  const phase=closed?'FRI':preview?'WED':null;
  return {
    week_start:'2026-11-02',week_end:'2026-11-06',
    slots:snapshots,
    rows:[
      {sector:'RECEBIMENTO',backlog,wednesday:preview?produced:null,
        friday:closed?produced:null,produced:phase?produced:null,
        produced_source:phase,source_supported:true},
      {sector:'AJUSTES',backlog:0,wednesday:null,friday:null,
        produced:null,produced_source:phase,source_supported:sourceSupported},
    ],
  };
}
async function render(data){
  const els={
    missionBody:{innerHTML:''},
    missionWeeklyTab:{classList:{contains:v=>v==='primary'}},
  };
  const ctx=vm.createContext({
    api:async()=>data,
    $:id=>els[id]||null,
    esc:value=>String(value==null?'':value)
       .replace(/[&<>"]/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s])),
    setMissionMode:()=>{},
    console,
  });
  vm.runInContext(weeklyJS+'\nmissionWeeklyMonth="2026-11";',ctx);
  await vm.runInContext('showMissionWeekly()',ctx);
  return els.missionBody.innerHTML;
}
const wrapping=week=>({
  month:'2026-11',sectors:['RECEBIMENTO','AJUSTES'],weeks:[week],
});
test('the week is blank before scheduled captures; never fabricates a zero',async()=>{
  const html=await render(wrapping(weekRecord({
    BACKLOG:cut('scheduled'),WED:cut('scheduled'),FRI:cut('scheduled'),
  },null,null)));
  assert.match(html,/BACKLOG/);
  assert.match(html,/Agendado/);
  assert.match(html,/mission-nodata/);
  assert.doesNotMatch(html,/Histórico consolidado/);
});
test('Wednesday preview is shown, and Friday keeps an independent final',async()=>{
  const preview=await render(wrapping(weekRecord({
    BACKLOG:cut('captured'),WED:cut('captured'),FRI:cut('scheduled'),
  },1200,1500,false)));
  assert.match(preview,/1\.200/);
  assert.match(preview,/1\.500/);
  assert.match(preview,/Prévia · quarta/);
  assert.match(preview,/s\/ fonte/);

  const final=await render(wrapping(weekRecord({
    BACKLOG:cut('captured'),WED:cut('captured'),FRI:cut('captured'),
  },1200,1900,false)));
  assert.match(final,/1\.900/);
  assert.match(final,/Final · sexta/);
  assert.match(final,/Registrado/);
});
test('operational board uses only weekly API, never legacy spreadsheet globals',()=>{
  assert.match(weeklyJS,/\/api\/mission\/weekly/);
  assert.doesNotMatch(weeklyJS,/MISSAO_HISTORICO_2026|MISSAO_SEMANAS|MISSAO_MESES_2026/);
});
