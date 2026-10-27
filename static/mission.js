const MISSAO_SETORES=["RECEBIMENTO","EXPEDIÇÃO PCP","QUALIDADE 1","QUALIDADE 2","PROCESSAMENTO","ETIQUETAGEM","ESTOCAGEM","AJUSTES","EXPEDIÇÃO"];
const MISSAO_SEMANAS=[["28/09 a 02/10",[444,3164,1884,0,3150,3150,0,null,null],[2747,6505,1884,2859,2633,2633,1781,4605,8607]],["05/10 a 09/10",[21564,0,0,3745,3760,693,3092,null,null],[20201,0,6516,3745,3760,693,6637,2208,16418]],["12/10 a 16/10",[2570,2494,2808,0,2576,2576,672,null,859],[8106,4206,8673,0,6855,6855,6847,6512,1540]],["19/10 a 23/10",[8236,3250,12112,0,750,750,0,null,null],[11204,6949,18295,4222,7606,2407,6325,2682,null]],["26/10 a 30/10",[4648,2686,3514,1746,11857,5740,1063,null,null],[null,null,null,null,null,null,null,null,null]]];
const missaoFmt=n=>n==null?'—':n.toLocaleString('pt-BR');
function renderMissao(){
  setPage('Visão da Missão','Histórico do backlog e situação operacional atual');
  $('mainContent').innerHTML =
    '<div class="missao-header"><div><h2>Visão da Missão</h2><p>Indicadores históricos e visão atual do Supabase</p></div>'+
    '<div class="actions"><button id="missionHistoryTab" class="primary" onclick="showMissionHistorical()">Histórico semanal</button>'+
    '<button id="missionLiveTab" class="secondary" onclick="showMissionLive()">Operação agora</button></div></div>'+
    '<div id="missionBody"></div>';
  showMissionHistorical();
}
function setMissionMode(mode){
  const historical=mode==='historical';
  if($('missionHistoryTab'))$('missionHistoryTab').className=historical?'primary':'secondary';
  if($('missionLiveTab'))$('missionLiveTab').className=historical?'secondary':'primary';
}
function showMissionHistorical(){
  setMissionMode('historical');
  const body=$('missionBody');
  if(!body)return;
  body.innerHTML='<div class="missao-header"><div><h3>Backlog e produção da planilha</h3><p>Séries históricas informadas pela equipe</p></div>'+
    '<label>Semana <select id="missaoSemana"></select></label></div>'+
    '<div class="missao-kpis" id="missaoKpis"></div>'+
    '<div class="missao-grid"><section class="panel"><div class="panel-header">Backlog por setor</div>'+
    '<div class="panel-body" id="missaoBars"></div></section>'+
    '<section class="panel"><div class="panel-header">Backlog × produzido</div>'+
    '<div class="panel-body" style="overflow:auto"><table class="missao-table"><thead><tr><th>Setor</th><th>Backlog</th><th>Produzido</th></tr></thead>'+
    '<tbody id="missaoRows"></tbody></table></div></section></div>'+
    '<p class="missao-note">Fonte: planilha QUADRO BACKLOG + PRODUZIDO, aba QUADRO. Dados históricos, não atualizados automaticamente. Ausência de registro (—) não é zero. A soma entre setores não representa peças únicas.</p>';
  const sel=$('missaoSemana');
  MISSAO_SEMANAS.forEach((s,i)=>{const o=document.createElement('option');o.value=i;o.textContent=s[0];sel.append(o)});
  sel.value=MISSAO_SEMANAS.length-1;
  const update=()=>{
    if(!$('missaoKpis'))return;
    const [,back,prod]=MISSAO_SEMANAS[Number(sel.value)];
    const valid=back.map((n,i)=>({n,i})).filter(x=>x.n!=null);
    const pv=prod.filter(x=>x!=null);
    const sum=a=>a.reduce((x,y)=>x+y,0);
    const ranked=[...valid].sort((a,b)=>b.n-a.n);
    const top=ranked[0];
    const cards=[
      ['Backlog informado',missaoFmt(sum(valid.map(x=>x.n))),'Carga agregada dos setores'],
      ['Produção informada',pv.length?missaoFmt(sum(pv)):'—','Sem registro não é zero'],
      ['Maior backlog',top?missaoFmt(top.n):'—',top?MISSAO_SETORES[top.i]:'Sem dados'],
      ['Setores com dados',valid.length+' / '+pv.length,'Backlog / produzido']
    ];
    $('missaoKpis').innerHTML=cards.map(c=>'<div class="missao-kpi"><span>'+esc(c[0])+'</span><strong>'+esc(c[1])+'</strong><small>'+esc(c[2])+'</small></div>').join('');
    const max=Math.max(1,...valid.map(x=>x.n));
    $('missaoBars').innerHTML=ranked.map(x=>'<div class="missao-bar"><div><span>'+esc(MISSAO_SETORES[x.i])+'</span><b>'+missaoFmt(x.n)+'</b></div><i><em style="width:'+(100*x.n/max)+'%"></em></i></div>').join('')||'Sem dados';
    $('missaoRows').innerHTML=MISSAO_SETORES.map((s,i)=>'<tr><td>'+esc(s)+'</td><td>'+missaoFmt(back[i])+'</td><td>'+missaoFmt(prod[i])+'</td></tr>').join('');
  };
  sel.addEventListener('change',update);
  update();
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
