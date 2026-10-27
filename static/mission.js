/* Visão da Missão — quadro histórico fiel à planilha enviada.
   A base inclui maio a outubro de 2026; nunca somar backlog de várias
   semanas para fingir total mensal: backlog é fotografia, não fluxo. */
const MISSAO_SETORES=["RECEBIMENTO","EXPEDIÇÃO PCP","QUALIDADE 1","QUALIDADE 2","PROCESSAMENTO","ETIQUETAGEM","ESTOCAGEM","AJUSTES","EXPEDIÇÃO"];
const missaoFmt=n=>n==null?'—':Number(n).toLocaleString("pt-BR");
let missionSelectedMonth=10;
let missionBoardMetric="ambos";
const missionSumValues=values=>{
  const valid=values.filter(v=>typeof v==="number" && Number.isFinite(v));
  return {value:valid.length?valid.reduce((s,n)=>s+n,0):null,reported:valid.length,total:values.length};
};
const missionRowsOfMonth=month=>MISSAO_HISTORICO_2026.filter(row=>row[0]===Number(month));
const missionMonthName=month=>MISSAO_MESES_2026.find(m=>m.numero===Number(month))?.nome||"";
function renderMissao(){
  setPage("Visão da Missão","Quadro de backlog · histórico de maio a outubro de 2026");
  $("mainContent").innerHTML =
    '<div class="missao-header"><div><span class="mission-kicker">CONTROLE DE PRODUÇÃO · 2026</span>'+
    '<h2>Visão da Missão</h2><p>Quadro completo de backlog e produção por setor</p></div>'+
    '<div class="actions"><button id="missionHistoryTab" class="primary" type="button" onclick="showMissionHistorical()">Quadro histórico</button>'+
    '<button id="missionLiveTab" class="secondary" type="button" onclick="showMissionLive()">Operação agora</button></div></div>'+
    '<div id="missionBody"></div>';
  showMissionHistorical();
}
function setMissionMode(mode){
  const historical=mode==="historical";
  if($("missionHistoryTab"))$("missionHistoryTab").className=historical?"primary":"secondary";
  if($("missionLiveTab"))$("missionLiveTab").className=historical?"secondary":"primary";
}
function selectMissionMonth(month){
  if(!MISSAO_MESES_2026.some(m=>m.numero===Number(month)))return;
  missionSelectedMonth=Number(month);
  showMissionHistorical();
}
function selectMissionMetric(value){
  if(!["ambos","backlog","produzido"].includes(value))return;
  missionBoardMetric=value;
  showMissionHistorical();
}
function missionCell(value,metric){
  if(value==null)return '<span class="mission-nodata" title="Sem dado informado na planilha">—</span>';
  if(value===0)return '<span class="mission-zero" title="Valor informado como zero">0</span>';
  return '<strong class="mission-cell-value '+(metric==="backlog"?"is-backlog":"is-produced")+'">'+missaoFmt(value)+'</strong>';
}
function showMissionHistorical(){
  setMissionMode("historical");
  const body=$("missionBody");
  if(!body)return;
  if(typeof MISSAO_HISTORICO_2026==="undefined"){
    body.innerHTML='<div class="notice error">O histórico da planilha não carregou. Atualize a página.</div>';
    return;
  }
  const weeks=missionRowsOfMonth(missionSelectedMonth);
  const last=weeks[weeks.length-1];
  const backlogLast=last?missionSumValues(last[3]):{value:null,reported:0,total:9};
  const producedMonthly=missionSumValues(weeks.flatMap(w=>w[4]));
  const lastKnownProduced=[...weeks].reverse().find(w=>w[4].some(v=>v!==null));
  const missingCount=weeks.flatMap(w=>[...w[3],...w[4]]).filter(x=>x===null).length;
  const monthLabel=missionMonthName(missionSelectedMonth);
  const range=last?.[2]?last[2]:"Semana "+last?.[1];
  const opts=[["ambos","Backlog + produzido"],["backlog","Somente backlog"],["produzido","Somente produzido"]]
    .map(([val,label])=>'<option value="'+val+'" '+(missionBoardMetric===val?'selected':'')+'>'+label+'</option>').join("");
  const metrics=missionBoardMetric==="ambos"?["backlog","produzido"]:[missionBoardMetric];
  const colSpan=metrics.length;
  const metricLabel={backlog:"Backlog",produzido:"Produzido"};
  const monthTabs=MISSAO_MESES_2026.map(m=>'<button type="button" class="mission-month '+(m.numero===missionSelectedMonth?'selected':'')+
    '" onclick="selectMissionMonth('+m.numero+')" aria-pressed="'+(m.numero===missionSelectedMonth?'true':'false')+'">'+esc(m.nome)+'</button>').join("");
  const h1=weeks.map(w=>'<th colspan="'+colSpan+'" scope="colgroup"><b>SEMANA '+w[1]+'</b>'+
    (w[2]?'<small>'+esc(w[2])+'</small>':'')+'</th>').join("");
  const h2=weeks.map(w=>metrics.map(m=>'<th class="mission-th-metric '+(m==="backlog"?"is-backlog":"is-produced")+'">'+metricLabel[m]+'</th>').join("")).join("");
  const bodyRows=MISSAO_SETORES.map((sector,index)=>{
    const cells=weeks.map(w=>metrics.map(m=>{
      const number=w[m==="backlog"?3:4][index];
      return '<td class="mission-val '+(m==="backlog"?"backlog":"produzido")+'">'+missionCell(number,m)+'</td>';
    }).join("")).join("");
    return '<tr><th scope="row">'+esc(sector)+'</th>'+cells+'</tr>';
  }).join("");
  const totalCells=weeks.map(w=>metrics.map(m=>{
    const stat=missionSumValues(w[m==="backlog"?3:4]);
    return '<td class="mission-val mission-total '+(m==="backlog"?"backlog":"produzido")+'">'+
      missionCell(stat.value,m)+'<small>'+stat.reported+'/9 informados</small></td>';
  }).join("")).join("");
  const board='<div class="mission-board-wrap" tabindex="0" aria-label="Quadro mensal de backlog e produzido: role horizontalmente para ver todos os setores">'+
    '<table class="mission-board"><thead><tr><th rowspan="2" scope="col">SETOR</th>'+h1+'</tr><tr>'+h2+'</tr></thead>'+
    '<tbody>'+bodyRows+'</tbody><tfoot><tr><th scope="row">SOMA INFORMADA <small>Não são peças únicas</small></th>'+totalCells+'</tr></tfoot></table></div>';
  const weeklyStats=weeks.map(w=>({...{week:w[1],label:w[2]},backlog:missionSumValues(w[3]),produced:missionSumValues(w[4])}));
  const maxBacklog=Math.max(1,...weeklyStats.map(w=>Number(w.backlog.value||0)));
  const trend=weeklyStats.map(w=>
    '<div class="mission-week-trend"><div class="mission-trend-title"><b>SEM '+w.week+'</b><small>'+esc(w.label||"")+'</small></div>'+
    '<div class="mission-trend-track"><i style="width:'+(w.backlog.value===null?0:100*w.backlog.value/maxBacklog)+'%"></i></div>'+
    '<strong>'+missaoFmt(w.backlog.value)+'</strong><small>'+w.backlog.reported+'/9 áreas</small></div>'
  ).join("");
  const summaryRows=MISSAO_SETORES.map((s,index)=>{
    const latest=last?.[3][index]??null;
    const produced=missionSumValues(weeks.map(w=>w[4][index]));
    const backlogPrev=weeks.length>1?weeks[weeks.length-2][3][index]:null;
    const delta=(latest!==null&&backlogPrev!==null)?latest-backlogPrev:null;
    return '<tr><td>'+esc(s)+'</td><td class="mission-num">'+missaoFmt(latest)+'</td>'+
      '<td class="mission-num">'+missaoFmt(produced.value)+'</td>'+
      '<td class="mission-num '+(delta===null?"":delta>0?"mission-worse":delta<0?"mission-better":"")+'">'+
      (delta===null?'—':(delta>0?'+':'')+missaoFmt(delta))+'</td></tr>';
  }).join("");
  body.innerHTML='<div class="mission-period-tabs" aria-label="Meses de 2026">'+monthTabs+'</div>'+
    '<div class="mission-month-heading"><div><span class="mission-kicker">HISTÓRICO CONSOLIDADO · 2026</span>'+
    '<h3>'+esc(monthLabel)+' <small>'+weeks.length+' semanas registradas</small></h3></div>'+
    '<label>Exibir <select onchange="selectMissionMetric(this.value)">'+opts+'</select></label></div>'+
    '<div class="missao-kpis">'+
      '<div class="missao-kpi"><span>Backlog na semana final</span><strong>'+missaoFmt(backlogLast.value)+'</strong>'+
      '<small>'+esc(range)+' · '+backlogLast.reported+'/9 setores</small></div>'+
      '<div class="missao-kpi"><span>Produção apontada no mês</span><strong>'+missaoFmt(producedMonthly.value)+'</strong>'+
      '<small>Soma dos registros por setor/semana</small></div>'+
      '<div class="missao-kpi"><span>Última semana com produção</span><strong>'+
      (lastKnownProduced?'Sem '+lastKnownProduced[1]:'—')+'</strong><small>'+
      (lastKnownProduced?.[2]?esc(lastKnownProduced[2]):"Produção não informada significa ausência de dados")+'</small></div>'+
      '<div class="missao-kpi"><span>Campos sem informação</span><strong>'+missingCount+'</strong>'+
      '<small>Não foram convertidos em zero</small></div></div>'+
    '<section class="panel mission-board-panel"><div class="panel-header"><div><strong>QUADRO DO BACKLOG · '+esc(monthLabel.toUpperCase())+'</strong>'+
    '<small>Todos os setores, semana a semana, conforme a planilha original</small></div>'+
    '<span class="mission-board-hint">↔ Deslize para ver todas as semanas</span></div>'+
    board+'</section>'+
    '<div class="missao-grid mission-support-grid"><section class="panel"><div class="panel-header">Evolução do backlog informado</div>'+
    '<div class="panel-body"><div class="mission-trend-chart">'+trend+'</div>'+
    '<small class="mission-footnote">Backlog é uma fotografia semanal; somá-lo entre semanas não gera backlog mensal.</small></div></section>'+
    '<section class="panel"><div class="panel-header">Fechamento por setor</div>'+
    '<div class="panel-body" style="overflow:auto"><table class="missao-table mission-sector-table">'+
    '<thead><tr><th>Setor</th><th>Último backlog</th><th>Produzido no mês</th><th>Δ backlog semanal</th></tr></thead>'+
    '<tbody>'+summaryRows+'</tbody></table></div></section></div>'+
    '<p class="missao-note"><b>Fonte:</b> QUADRO BACKLOG + PRODUZIDO.xlsx. Maio a setembro: aba BASE_DADOS_QUADRO; outubro: aba QUADRO. '+
    'A semana de 28/09 a 02/10 aparece uma única vez, em setembro. '+
    'Campos vazios, N.A, traços e ??? aparecem como —; zero registrado permanece zero. '+
    'Backlog e produção agregados por setor não representam peças únicas; semanas sem todas as áreas informadas geram somas parciais.</p>';
}
let missionLiveRequest=0;
async function showMissionLive(){
  setMissionMode('live');
  const body=$('missionBody');
  if(!body)return;
  const id=++missionLiveRequest;
  body.innerHTML='<div class="state-panel">Consultando a operação no Supabase…</div>';
  try{
    const snapshot=await api('/api/mission/live');
    if(id!==missionLiveRequest || !$('missionLiveTab')?.classList.contains('primary'))return;
    const rows=snapshot.rows||[];
    const total=rows.reduce((s,r)=>s+Number(r.pieces||0),0);
    const max=Math.max(1,...rows.map(r=>Number(r.pieces||0)));
    body.innerHTML='<div class="missao-header"><div><h3>Fotografia da operação</h3>'+
      '<p>Última consulta: '+esc(new Date(snapshot.captured_at).toLocaleString('pt-BR'))+'</p></div>'+
      '<button class="secondary" type="button" onclick="showMissionLive()">Atualizar dados ↻</button></div>'+
      '<div class="missao-kpis">'+
      '<div class="missao-kpi"><span>Peças em etapas</span><strong>'+total.toLocaleString('pt-BR')+'</strong><small>Soma dos estágios operacionais</small></div>'+
      '<div class="missao-kpi"><span>Etapas com itens</span><strong>'+rows.length+'</strong><small>Conforme registro de estágio dos itens</small></div>'+
      '<div class="missao-kpi"><span>Produzido semanal</span><strong>—</strong><small>Apontamento por setor ainda não estruturado</small></div>'+
      '</div><div class="missao-grid"><section class="panel"><div class="panel-header">Peças por estágio</div><div class="panel-body">'+
      (rows.length?rows.map(r=>'<div class="missao-bar"><div><span>'+esc(r.stage||'Sem etapa')+'</span><b>'+Number(r.pieces||0).toLocaleString('pt-BR')+'</b></div>'+
        '<i><em style="width:'+(100*Number(r.pieces||0)/max)+'%"></em></i></div>').join(''):'Nenhum item operacional encontrado no banco.')+
      '</div></section><section class="panel"><div class="panel-header">Etapas e referências</div>'+
      '<div class="panel-body" style="overflow:auto"><table class="missao-table"><thead><tr><th>Etapa</th><th>Cards</th><th>Referências</th><th>Peças</th></tr></thead><tbody>'+
      (rows.length?rows.map(r=>'<tr><td>'+esc(r.stage)+'</td><td>'+Number(r.cards||0)+'</td><td>'+Number(r.references_count||0)+'</td>'+
        '<td>'+Number(r.pieces||0).toLocaleString('pt-BR')+'</td></tr>').join(''):'<tr><td colspan="4">Nenhum Card disponível.</td></tr>')+
      '</tbody></table></div></section></div>'+
      '<p class="missao-note">'+esc(snapshot.note||'')+' A soma dos estágios é agregada; não representa necessariamente peças únicas em uma cadeia com retrabalho.</p>';
  }catch(error){if(id===missionLiveRequest)$('missionBody').innerHTML='<div class="notice error">'+esc(error.message)+'</div>';}
}
