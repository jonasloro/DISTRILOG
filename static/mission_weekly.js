/* Quadro semanal do DISTRILOG.
 * Fonte exclusiva: fotografias consolidadas no PostgreSQL por pg_cron.
 * Não usa os números do histórico XLSX de maio a outubro de 2026.
 */
const MISSION_PHASES = {
  BACKLOG: {label:"Backlog · segunda 08h10", short:"Backlog"},
  WED: {label:"Prévia · quarta 12h", short:"Prévia"},
  FRI: {label:"Fechamento · sexta 16h", short:"Final"},
};
const MISSION_PHASE_STATE = {
  captured:"Registrado",
  scheduled:"Agendado",
  not_captured:"Não capturado",
};
let missionWeeklyMonth = null;
let missionWeeklyRequestId = 0;

function missionCurrentMonth() {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit"
  }).formatToParts(new Date());
  const year = parts.find(p=>p.type==="year").value;
  const month = parts.find(p=>p.type==="month").value;
  return year+"-"+month;
}
function missionMoveMonth(change) {
  if (!missionWeeklyMonth) missionWeeklyMonth=missionCurrentMonth();
  const [y,m] = missionWeeklyMonth.split("-").map(Number);
  const d=new Date(Date.UTC(y,m-1+change,1));
  missionWeeklyMonth=d.getUTCFullYear()+"-"+String(d.getUTCMonth()+1).padStart(2,"0");
  void showMissionWeekly();
}
function missionValue(value, qualifier="") {
  if (value===null || value===undefined) return '<span class="mission-nodata">—</span>';
  return '<strong class="mission-cell-value '+qualifier+'">'+Number(value).toLocaleString("pt-BR")+'</strong>';
}
function missionMetricTotal(rows, key) {
  const valid = rows.map(r=>r[key]).filter(n=>Number.isFinite(n));
  return valid.length ? valid.reduce((a,b)=>a+b,0) : null;
}
function missionPhaseBadge(phase,status) {
  const detail=MISSION_PHASES[phase];
  return '<span class="mission-phase-status state-'+esc(status)+'">'+esc(detail.short)+': '+
    esc(MISSION_PHASE_STATE[status]||status)+'</span>';
}
function missionSlotValue(row,kind) {
  if(kind==="BACKLOG") return row.backlog;
  return row.produced;
}
function missionShowError(error) {
  if($("missionBody"))$("missionBody").innerHTML=
    '<div class="notice error">Não foi possível consultar as fotografias da Missão: '+
    esc(error?.message||"Falha na conexão")+
    '</div><button class="secondary" onclick="showMissionWeekly()">Tentar novamente</button>';
}
async function showMissionWeekly(){
  setMissionMode("weekly");
  const body=$("missionBody");
  if(!body)return;
  if(!missionWeeklyMonth)missionWeeklyMonth=missionCurrentMonth();
  const sequence=++missionWeeklyRequestId;
  const selectedMonth=missionWeeklyMonth;
  body.innerHTML='<div class="state-panel">Carregando quadro do DISTRILOG…</div>';
  let data;
  try{
    data=await api("/api/mission/weekly?month="+encodeURIComponent(selectedMonth));
  }catch(error){
    if(sequence===missionWeeklyRequestId && $("missionWeeklyTab")?.classList.contains("primary"))missionShowError(error);
    return;
  }
  if(sequence!==missionWeeklyRequestId || !$("missionWeeklyTab")?.classList.contains("primary") || !$("missionBody"))return;
  const sectors=data.sectors||[];
  const weeks=data.weeks||[];
  const currentNowDate=new Intl.DateTimeFormat("en-CA", {
    timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"
  }).format(new Date());
  const active=weeks.find(w=>w.week_start<=currentNowDate && currentNowDate<=w.week_end) ||
    [...weeks].reverse().find(w=>w.week_start<=currentNowDate);
  const first=active?.rows||[];
  const totalBacklog=active?.slots.BACKLOG.status==="captured"?missionMetricTotal(first,"backlog"):null;
  const totalProduced=active?.slots.WED.status==="captured"||active?.slots.FRI.status==="captured"?
    missionMetricTotal(first,"produced"):null;
  const percent=totalBacklog>0 && totalProduced!==null?Math.round(totalProduced/totalBacklog*1000)/10:null;
  const monthStart=selectedMonth+"-01";
  const [yy,mm]=selectedMonth.split("-").map(Number);
  const monthLabel=new Date(Date.UTC(yy,mm-1,15)).toLocaleDateString("pt-BR",{month:"long",year:"numeric",timeZone:"UTC"});

  const tableHeader='<tr><th class="mission-week-head">SEMANA</th><th class="mission-indicator-head">INDICADOR</th>'+
    sectors.map(s=>'<th class="mission-sector-head">'+esc(s)+'</th>').join("")+
    '<th class="mission-total-head">SOMA SETORES</th></tr>';
  const bodyRows=weeks.map(week=>{
    const phase=week.slots;
    const byName=Object.fromEntries(week.rows.map(r=>[r.sector,r]));
    const state=phase.FRI.status==="captured"?"FRI":phase.WED.status==="captured"?"WED":null;
    const common='<th class="mission-week-cell" scope="rowgroup" rowspan="2"><b>'+
      esc(week.week_start.slice(8,10)+"/"+week.week_start.slice(5,7))+
      '</b><small>até '+esc(week.week_end.slice(8,10)+"/"+week.week_end.slice(5,7))+'</small>'+
      missionPhaseBadge("BACKLOG",phase.BACKLOG.status)+
      missionPhaseBadge("WED",phase.WED.status)+
      missionPhaseBadge("FRI",phase.FRI.status)+'</th>';
    const backVals=sectors.map(s=>byName[s]?.backlog??null);
    const producedVals=sectors.map(s=>byName[s]?.produced??null);
    const backlog=phase.BACKLOG.status==="captured"?missionMetricTotal(week.rows,"backlog"):null;
    const produced=state?missionMetricTotal(week.rows,"produced"):null;
    const td=(values,type)=>values.map((v,i)=>{
      const row=byName[sectors[i]];
      const unsupported=type==="produced" && state && row?.source_supported===false;
      return '<td class="mission-val">'+(unsupported?'<span class="mission-nodata" title="Não há apontamento de peças concluídas confiável">s/ fonte</span>':
        missionValue(v,type==="backlog"?"is-backlog":"is-produced"))+'</td>';
    }).join("");
    return '<tr class="mission-matrix-row is-backlog">'+common+
      '<th class="mission-metric-cell">BACKLOG<br><small>Fixo · 08h10</small></th>'+
      td(backVals,"backlog")+'<td class="mission-val mission-total">'+missionValue(backlog,"is-backlog")+'</td></tr>'+
      '<tr class="mission-matrix-row is-produced">'+
      '<th class="mission-metric-cell">PRODUZIDO<br><small>'+
      (state==="FRI"?"Final · sexta":state==="WED"?"Prévia · quarta":"Aguardando corte")+'</small></th>'+
      td(producedVals,"produced")+'<td class="mission-val mission-total">'+missionValue(produced,"is-produced")+'</td></tr>';
  }).join("");
  const statusSummary=weeks.length?weeks.map(w=>{
    const captured=Object.values(w.slots).filter(s=>s.status==="captured").length;
    return '<div class="mission-week-progress"><b>Semana '+esc(w.week_start.slice(8,10)+"/"+w.week_start.slice(5,7))+
      '</b><span>'+captured+'/3 cortes registrados</span>'+
      '<small>'+missionPhaseBadge("BACKLOG",w.slots.BACKLOG.status)+' '+
      missionPhaseBadge("WED",w.slots.WED.status)+' '+
      missionPhaseBadge("FRI",w.slots.FRI.status)+'</small></div>';
  }).join(""):"";
  body.innerHTML='<div class="mission-month-heading"><div><span class="mission-kicker">FONTE: SISTEMA · HORÁRIO DE BRASÍLIA</span>'+
    '<h3>'+esc(monthLabel.charAt(0).toUpperCase()+monthLabel.slice(1))+
    ' <small>Quadro automático</small></h3></div>'+
    '<div class="actions"><button type="button" class="secondary" onclick="missionMoveMonth(-1)">‹ Mês anterior</button>'+
    '<button type="button" class="secondary" onclick="missionWeeklyMonth=missionCurrentMonth();showMissionWeekly()">Mês atual</button>'+
    '<button type="button" class="secondary" onclick="missionMoveMonth(1)">Próximo mês ›</button>'+
    '<button type="button" class="secondary" onclick="showMissionWeekly()">Atualizar ↻</button></div></div>'+
    '<div class="missao-kpis">'+
    '<div class="missao-kpi"><span>Backlog inicial da semana</span><strong>'+missionValue(totalBacklog)+'</strong><small>Congelado na segunda, 08h10</small></div>'+
    '<div class="missao-kpi"><span>Produzido registrado</span><strong>'+missionValue(totalProduced)+'</strong>'+
      '<small>'+(active?.slots.FRI.status==="captured"?"Fechado na sexta, 16h":
        active?.slots.WED.status==="captured"?"Prévia de quarta, 12h":"Aguardando o primeiro corte")+'</small></div>'+
    '<div class="missao-kpi"><span>Entrega sobre backlog</span><strong>'+(percent===null?'—':percent.toLocaleString("pt-BR")+"%")+'</strong>'+
       '<small>Pode superar 100% · não é limite</small></div>'+
    '<div class="missao-kpi"><span>Horários oficiais</span><strong class="mission-cutoff-clock">08h10 · 12h · 16h</strong>'+
       '<small>Segunda · quarta · sexta</small></div></div>'+
    '<section class="panel mission-board-panel"><div class="panel-header"><div>'+
    '<strong>QUADRO DE BACKLOG E PRODUZIDO · '+esc(monthLabel.toUpperCase())+'</strong>'+
    '<small>Semana a semana, com números congelados; sem edição ou cálculo retroativo</small></div>'+
    '<span class="mission-board-hint">↔ Deslize para consultar todos os setores</span></div>'+
    '<div class="mission-board-wrap" tabindex="0" aria-label="Quadro mensal com backlog fixo e produção de quarta e sexta">'+
    '<table class="mission-board mission-board-horizontal"><thead>'+tableHeader+'</thead><tbody>'+bodyRows+'</tbody></table></div></section>'+
    '<section class="panel mission-schedule-panel"><div class="panel-header">Situação das capturas do mês</div>'+
    '<div class="panel-body mission-schedule-list">'+statusSummary+'</div></section>'+
    '<p class="missao-note"><b>Regras:</b> backlog de segunda-feira às 08h10 permanece fixo; produzido só é atualizado na prévia de quarta às 12h e no fechamento de sexta às 16h. '+
    'Atividades posteriores ao fechamento não alteram a semana. A produção pode superar o backlog inicial. '+
    'Um travessão antes do horário indica dado ainda não capturado; após o horário indica captura ausente, não zero. '+
    'AJUSTES aparece sem produção enquanto não existir fonte operacional de peças concluídas. '+
    '<b>Histórico anterior:</b> o arquivo de planilha permanece separado na aba Histórico legado.</p>';
}
