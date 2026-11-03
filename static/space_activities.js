/* Organização de espaço: procedimentos guiados, dados reais no Supabase. */
"use strict";
const SPACE_LABELS = {
  AJUSTE_ESTOQUE: "Abertura de espaço / ajuste físico",
  DEVOLUCAO_PORTA_PALETES: "Devolução ao porta-paletes"
};
const SPACE_UNITS = {CAIXAS:"Caixas",VOLUMES:"Volumes",PALETES:"Paletes",PECAS:"Peças"};
let spaceActivityTick = null;
const spaceFlow={active:null,history:[],type:null,finish:false,completed:null,at:Date.now(),busy:false};

function stopSpaceActivityTick(){if(spaceActivityTick){clearInterval(spaceActivityTick);spaceActivityTick=null;}}
function spaceElapsed(){
  const a=spaceFlow.active;if(!a)return "00:00:00";
  const extra=a.status==="EM_ANDAMENTO"?Math.max(0,Math.floor((Date.now()-spaceFlow.at)/1000)):0;
  return fmtSeconds(Number(a.worked_seconds_live||0)+extra);
}
function spaceBtn(label,action,variant){
  return '<button type="button" class="space-button '+(variant||"")+'" data-space-action="'+action+'"'+(spaceFlow.busy?' disabled':'')+'>'+label+'</button>';
}
function spaceOverview(record){
  const total=record.moved_quantity==null?"Em execução":Number(record.moved_quantity).toLocaleString("pt-BR")+
    " "+(SPACE_UNITS[record.quantity_unit]||record.quantity_unit);
  return '<article class="space-history-item"><div><b>'+esc(SPACE_LABELS[record.kind]||record.kind)+'</b>'+
    '<small>'+esc(record.street)+' · '+esc(record.brand)+' · '+esc(record.operator_name||"")+'</small>'+
    '<small>'+fmtDateTime(record.started_at)+'</small></div><div><strong>'+esc(total)+'</strong>'+
    '<small>'+fmtSeconds(record.worked_seconds_live||record.worked_seconds)+'</small></div></article>';
}
function spaceRouteKind(){
  return currentView === "storage-pallets" ? "DEVOLUCAO_PORTA_PALETES" : "AJUSTE_ESTOQUE";
}
function isStorageActivityView(){
  return currentView === "storage-space" || currentView === "storage-pallets";
}
function spaceDraw(){
  if(!isStorageActivityView())return;
  if(!spaceFlow.active && !spaceFlow.completed)spaceFlow.type=spaceRouteKind();
  const a=spaceFlow.active;
  const canWork=["recebimento","qualidade","processamento","etiquetagem","estocagem","expedicao","devolucoes","supervisor","admin"].includes(currentUser?.role);
  let body="",footer="",step=1;
  if(a){
    step=spaceFlow.finish?4:3;
    body='<div class="space-focus"><span class="space-state '+(a.status==="PAUSADA"?"paused":"")+'">'+
      (a.status==="PAUSADA"?"⏸ PAUSADA":"● EM EXECUÇÃO")+'</span><h2>'+esc(SPACE_LABELS[a.kind])+'</h2>'+
      '<div class="space-label-pair"><span>RUA <b>'+esc(a.street)+'</b></span><span>MARCA <b>'+esc(a.brand)+'</b></span></div>'+
      '<div class="space-timer" id="spaceTimer">'+spaceElapsed()+'</div>'+
      '<p>Tempo persistente no servidor, mesmo se você fechar o aplicativo.</p></div>';
    if(spaceFlow.finish){
      body+='<div class="space-form"><h3>Etapa final · informe o que movimentou</h3>'+
        '<label>Quantidade movimentada <input id="spaceQuantity" inputmode="numeric" type="number" min="1" max="1000000" placeholder="Ex.: 12" required></label>'+
        '<label>Unidade <select id="spaceUnit">'+Object.entries(SPACE_UNITS).map(([unit,name])=>
          '<option value="'+unit+'"'+(unit===(a.kind==="DEVOLUCAO_PORTA_PALETES"?"PALETES":"CAIXAS")?' selected':'')+'>'+name+'</option>').join("")+'</select></label>'+
        '<label>Observações (opcional) <textarea id="spaceNotes" maxlength="800"></textarea></label>'+
        '<p class="space-caution">Registrar esta atividade não transfere saldos do WMS. Se houve mudança de endereço, use a transferência oficial.</p></div>';
      footer=spaceBtn('← Voltar ao cronômetro','back','ghost')+spaceBtn('✓ Concluir e salvar quantidade','finish','primary');
    }else{
      footer=spaceBtn(a.status==="PAUSADA"?"▶ Retomar":"⏸ Pausar",a.status==="PAUSADA"?"resume":"pause","ghost")+
         spaceBtn('Finalizar atividade →','finishStep','primary');
    }
  }else if(spaceFlow.completed){
    step=4;
    const done=spaceFlow.completed;
    body='<div class="space-success"><span>✓</span><h2>Atividade concluída e salva</h2>'+
      '<p>'+esc(SPACE_LABELS[done.kind])+'</p><strong>'+Number(done.moved_quantity).toLocaleString("pt-BR")+
      ' '+esc(SPACE_UNITS[done.quantity_unit]||done.quantity_unit)+'</strong>'+
      '<small>'+esc(done.street)+' · '+esc(done.brand)+' · '+fmtSeconds(done.worked_seconds_live||done.worked_seconds)+'</small></div>';
    footer=spaceBtn('Iniciar outra atividade','restart','primary');
  }else if(!spaceFlow.type){
    body='<h2>Qual atividade está realizando?</h2><p>Um procedimento por vez, sem procurar ações no fim da tela.</p>'+
      '<div class="space-choice">'+
      '<button type="button" data-space-action="chooseAdjust"'+(canWork?'':' disabled')+'>'+
      '<span>▦</span><b>Abertura de espaço</b><small>Organizar ou abrir espaço para a mercadoria.</small><strong>Começar →</strong></button>'+
      '<button type="button" data-space-action="chooseReturn"'+(canWork?'':' disabled')+'>'+
      '<span>↩</span><b>Devolução ao porta-paletes</b><small>Controlar a devolução física e quantificar o material.</small><strong>Começar →</strong></button></div>'+
      (!canWork?'<p class="space-caution">Seu perfil está autorizado apenas a consultar.</p>':'');
  }else{
    step=2;
    body='<h2>'+esc(SPACE_LABELS[spaceFlow.type])+'</h2>'+
      '<p>Antes de iniciar o cronômetro, informe a rua e a marca.</p>'+
      '<div class="space-form"><label>Rua <input id="spaceStreet" maxlength="80" placeholder="Ex.: RUA 05" required></label>'+
      '<label>Marca <input id="spaceBrand" maxlength="100" placeholder="Ex.: Marca X" required></label></div>';
    footer=spaceBtn('← Alterar atividade','restart','ghost')+spaceBtn('▶ Iniciar cronômetro','start','primary');
  }
  const stepNames=["Tipo","Rua e marca","Cronômetro","Quantidade"];
  const steps=stepNames.map((n,i)=>'<span class="'+(i+1===step?'current':'')+'">'+(i+1)+' · '+n+'</span>').join("");
  const scopedHistory=spaceFlow.history.filter(item=>item.kind===spaceRouteKind());
  const history=scopedHistory.length?scopedHistory.slice(0,15).map(spaceOverview).join(""):
    '<p class="muted">Nenhuma atividade anterior registrada.</p>';
  $("mainContent").innerHTML=storageTabs(currentView)+'<section class="space-page"><header class="space-header"><div><small>ESTOCAGEM · OPERAÇÃO FÍSICA</small>'+
    '<h1>'+esc(SPACE_LABELS[spaceRouteKind()])+'</h1><p>Rua, marca, tempo e quantidade movimentada no mesmo WMS.</p></div>'+
    '<button type="button" class="secondary" data-space-action="refresh">↻ Atualizar</button></header>'+
    '<div class="space-steps">'+steps+'</div><div class="space-stage">'+body+'</div>'+
    (footer?'<div class="space-flow-footer">'+footer+'</div>':'')+
    '<section class="space-history"><h3>Histórico operacional</h3>'+history+'</section></section>';
  stopSpaceActivityTick();
  if(a&&a.status==="EM_ANDAMENTO"){
    spaceActivityTick=setInterval(()=>{
      if(!isStorageActivityView()){stopSpaceActivityTick();return}
      const clock=$("spaceTimer");if(clock)clock.textContent=spaceElapsed();
    },1000);
  }
}
async function renderSpaceActivities(){
  if(!currentUser)return;
  setPage("Estocagem · "+SPACE_LABELS[spaceRouteKind()],"Atividade da Estocagem · registro compartilhado no WMS");
  try{
    const result=await Promise.all([api("/api/space-activities/active"),api("/api/space-activities?limit=20")]);
    spaceFlow.active=result[0].activity||null;
    spaceFlow.history=result[1].activities||[];
    spaceFlow.at=Date.now();
    if(spaceFlow.active)spaceFlow.completed=null;
    if(spaceFlow.completed&&spaceFlow.completed.kind!==spaceRouteKind())spaceFlow.completed=null;
    if(!spaceFlow.active && !spaceFlow.completed)spaceFlow.type=spaceRouteKind();
    spaceDraw();
  }catch(e){
    if(isStorageActivityView())$("mainContent").innerHTML=storageTabs(currentView)+
      '<div class="notice error">Não foi possível consultar as atividades: '+esc(e.message)+
      ' <button type="button" class="secondary" data-space-action="refresh">Tentar novamente</button></div>';
  }
}
async function spaceOperation(fn){
  if(spaceFlow.busy)return;
  spaceFlow.busy=true;
  document.querySelectorAll(".space-flow-footer button").forEach(x=>x.disabled=true);
  try{await fn()}
  catch(e){toast(e.message)}
  finally{
    spaceFlow.busy=false;
    document.querySelectorAll(".space-flow-footer button").forEach(x=>x.disabled=false);
  }
}
async function spaceAction(action){
  if(action==="refresh"){await renderSpaceActivities();return}
  if(action==="chooseAdjust"||action==="chooseReturn"){
    if(spaceFlow.active||spaceFlow.busy)return;
    spaceFlow.type=action==="chooseAdjust"?"AJUSTE_ESTOQUE":"DEVOLUCAO_PORTA_PALETES";
    spaceDraw();return;
  }
  if(action==="restart"){
    if(spaceFlow.active||spaceFlow.busy)return;
    spaceFlow.type=spaceRouteKind();spaceFlow.completed=null;spaceFlow.finish=false;spaceDraw();return;
  }
  if(action==="back"){spaceFlow.finish=false;spaceDraw();return}
  if(action==="finishStep"){spaceFlow.finish=true;spaceDraw();return}
  if(action==="start"){
    const kind=spaceFlow.type,street=String($("spaceStreet")?.value||"").trim(),brand=String($("spaceBrand")?.value||"").trim();
    if(!kind||!street||!brand){toast("Preencha a rua e a marca para iniciar.");return}
    await spaceOperation(async()=>{
      const r=await api("/api/space-activities",{method:"POST",body:JSON.stringify({kind,street,brand})});
      if(!r.ok||!r.activity)throw Error("Início não confirmado pelo servidor.");
      spaceFlow.active=r.activity;spaceFlow.type=spaceRouteKind();spaceFlow.finish=false;spaceFlow.at=Date.now();
      await renderSpaceActivities();toast("Cronômetro registrado no DISTRILOG.");
    });
    return;
  }
  const a=spaceFlow.active;if(!a||spaceFlow.busy)return;
  if(action==="pause"||action==="resume"){
    await spaceOperation(async()=>{
      const r=await api("/api/space-activities/"+a.id+"/"+action,{method:"POST",body:"{}"});
      if(!r.ok||!r.activity)throw Error("O servidor não confirmou a operação.");
      spaceFlow.active=r.activity;spaceFlow.at=Date.now();spaceDraw();
    });return;
  }
  if(action==="finish"){
    const raw=String($("spaceQuantity")?.value||"").trim(),unit=$("spaceUnit")?.value;
    if(!/^[1-9]\d*$/.test(raw)||Number(raw)>1000000){toast("Informe a quantidade movimentada: inteiro maior que zero.");return}
    if(!SPACE_UNITS[unit]){toast("Selecione a unidade movimentada.");return}
    const notes=String($("spaceNotes")?.value||"").trim();
    if(!confirm("Concluir "+SPACE_LABELS[a.kind]+" com "+raw+" "+SPACE_UNITS[unit]+
      "?\nEste registro não modifica as alocações do WMS."))return;
    await spaceOperation(async()=>{
      const r=await api("/api/space-activities/"+a.id+"/finish",
        {method:"POST",body:JSON.stringify({moved_quantity:Number(raw),quantity_unit:unit,notes})});
      if(!r.ok||!r.activity)throw Error("O servidor não confirmou a conclusão.");
      spaceFlow.completed=r.activity;spaceFlow.active=null;spaceFlow.finish=false;spaceFlow.type=spaceRouteKind();
      spaceFlow.at=Date.now();
      const h=await api("/api/space-activities?limit=20").catch(()=>({activities:[]}));
      spaceFlow.history=h.activities||[];spaceDraw();toast("Quantidade e tempo salvos com sucesso.");
    });
  }
}
document.addEventListener("click",event=>{
  const b=event.target.closest("[data-space-action]");
  if(!b||b.disabled)return;
  spaceAction(b.dataset.spaceAction).catch(err=>toast(err.message));
});
document.addEventListener("visibilitychange",()=>{
  if(!document.hidden&&isStorageActivityView()&&!spaceFlow.busy)renderSpaceActivities();
});
