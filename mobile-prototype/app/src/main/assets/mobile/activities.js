/* DISTRILOG Mobile - abertura de espaço e devolução de porta-paletes.
   UI embarcada no APK, HTTP somente via ponte nativa; nenhum dado inventado.
   Etapas visíveis: tipo > rua/marca > cronômetro > quantidade obrigatória.
*/
(function(){
"use strict";
const api=window.DM_API;
const LABEL={
  AJUSTE_ESTOQUE:"Abertura de espaço",
  DEVOLUCAO_PORTA_PALETES:"Devolução ao porta-paletes"
};
const UNITS={CAIXAS:"Caixas",VOLUMES:"Volumes",PALETES:"Paletes",PECAS:"Peças"};
const OP_ROLES=new Set(["recebimento","qualidade","processamento","etiquetagem","estocagem","devolucoes","expedicao","admin","supervisor"]);
const flow={active:null,history:[],kind:null,finish:false,last:null,receivedAt:Date.now(),ready:false};
const esc=(x)=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const val=(id)=>document.getElementById(id)?.value??"";
const action=(key,label,cls="button")=>'<button data-action="space-'+key+'" class="'+cls+'">'+label+'</button>';
function seconds(value){
  let n=Math.max(0,Math.floor(Number(value||0)));
  const h=Math.floor(n/3600),m=Math.floor(n%3600/60),s=n%60;
  return [h,m,s].map(x=>String(x).padStart(2,"0")).join(":");
}
function elapsed(){
  const x=flow.active;
  if(!x)return "00:00:00";
  const delta=x.status==="EM_ANDAMENTO"?Math.max(0,Math.floor((Date.now()-flow.receivedAt)/1000)):0;
  return seconds(Number(x.worked_seconds_live||0)+delta);
}
function human(n){return Number(n||0).toLocaleString("pt-BR")}
function summary(x){
  return '<div class="line-row"><b>'+esc(LABEL[x.kind]||x.kind)+'</b>'+
   '<small>'+esc(x.street)+' · '+esc(x.brand)+' · '+esc(x.status)+'</small>'+
   '<div class="inline"><small>'+esc(x.operator_name||"")+'</small>'+
   '<b>'+((x.moved_quantity==null)?"Em execução":human(x.moved_quantity)+" "+esc(UNITS[x.quantity_unit]||x.quantity_unit))+
   '</b></div><small>Tempo: '+seconds(x.worked_seconds_live||x.worked_seconds)+'</small></div>';
}
async function load(){
  const results=await Promise.all([api.get("/api/space-activities/active"),api.get("/api/space-activities?limit=12")]);
  flow.active=results[0]?.activity||null;
  flow.history=results[1]?.activities||[];
  flow.receivedAt=Date.now();
  flow.ready=true;
  if(flow.active)flow.last=null;
}
function view(user){
  if(!flow.ready){
    return '<div class="eyebrow">OPERAÇÕES</div><h1 class="shell-title">Organização de espaço</h1>'+
      '<p class="shell-desc">Conectando ao registro de atividades...</p><span class="spinner"></span>';
  }
  const can=OP_ROLES.has(String(user?.role||""));
  const has=!!flow.active;
  const stage=has?(flow.finish?4:3):(flow.last?4:(flow.kind?2:1));
  const stepLabels=["Tipo","Rua / marca","Cronômetro","Quantidade"];
  const steps='<div class="mobile-step-track">'+stepLabels.map((name,i)=>
    '<span class="'+(i+1===stage?'on':'')+'">'+(i+1)+'. '+name+'</span>').join("")+'</div>';
  let content="",buttons="";
  if(has){
    const x=flow.active;
    content='<div class="mobile-work-clock"><span class="eyebrow">'+esc(x.status==="PAUSADA"?"⏸ PAUSADA":"● EM ANDAMENTO")+'</span>'+
      '<h2>'+esc(LABEL[x.kind])+'</h2><div class="chips"><span class="chip">Rua: '+esc(x.street)+'</span>'+
      '<span class="chip">Marca: '+esc(x.brand)+'</span></div>'+
      '<div id="dmSpaceClock">'+elapsed()+'</div>'+
      '<p class="muted t-sm">O cronômetro continua no servidor mesmo se você sair da tela.</p></div>';
    if(flow.finish){
      content+='<section class="surface"><h3>Concluir a atividade</h3>'+
        '<p class="muted t-sm">Informe quantos itens foram movimentados. A quantidade é obrigatória.</p>'+
        '<label class="field"><span>Quantidade movimentada</span><input id="spaceQty" type="number" inputmode="numeric" min="1" max="1000000" placeholder="Ex.: 12"></label>'+
        '<label class="field"><span>Unidade</span><select id="spaceUnit">'+Object.entries(UNITS).map(([key,label])=>
          '<option value="'+key+'"'+(key===(x.kind==="DEVOLUCAO_PORTA_PALETES"?"PALETES":"CAIXAS")?' selected':'')+'>'+label+'</option>').join("")+
        '</select></label><label class="field"><span>Observações (opcional)</span>'+
        '<textarea id="spaceNotes" maxlength="800" placeholder="Observação relevante..."></textarea></label>'+
        '<div class="status-box warn">O registro mede o trabalho; para alterar endereços ou saldos, utilize a transferência oficial no WMS.</div></section>';
      buttons=action("back","← Voltar","button light")+action("finish","✓ Salvar conclusão","button");
    }else{
      buttons=action(x.status==="PAUSADA"?"resume":"pause",x.status==="PAUSADA"?"▶ Retomar":"⏸ Pausar","button light")+
        action("finishStep","Finalizar →","button");
    }
  }else if(flow.last){
    const x=flow.last;
    content='<div class="mobile-work-success"><span>✓</span><h2>Atividade registrada!</h2>'+
      '<p>'+esc(LABEL[x.kind])+'</p><strong>'+human(x.moved_quantity)+' '+esc(UNITS[x.quantity_unit]||x.quantity_unit)+'</strong>'+
      '<small>'+esc(x.street)+' · '+esc(x.brand)+' · '+seconds(x.worked_seconds_live||x.worked_seconds)+'</small></div>';
    buttons=action("new","Registrar outra atividade","button");
  }else if(!flow.kind){
    content='<h2 class="shell-title" style="font-size:21px">Qual atividade vai realizar?</h2>'+
      '<div class="mobile-choice">'+
      '<button data-action="space-adjust" '+(can?'':'disabled')+'><span>▦</span><b>Abertura de espaço</b>'+
      '<small>Organização física da rua para liberação de espaço no estoque.</small><strong>Selecionar →</strong></button>'+
      '<button data-action="space-return" '+(can?'':'disabled')+'><span>↩</span><b>Devolução ao porta-paletes</b>'+
      '<small>Devolução física, com tempo e quantidade movimentada.</small><strong>Selecionar →</strong></button></div>'+
      (!can?'<div class="status-box warn">Seu perfil só pode consultar o histórico desta operação.</div>':'');
  }else{
    content='<h2 style="font-size:22px">'+esc(LABEL[flow.kind])+'</h2>'+
      '<p class="muted t-sm">Etapa 2 de 4. Informe a rua e a marca antes de iniciar.</p>'+
      '<section class="surface">'+
      '<label class="field"><span>Rua onde está abrindo espaço / devolvendo</span>'+
      '<input id="spaceStreet" type="text" maxlength="80" autocomplete="off" placeholder="Ex.: RUA 05"></label>'+
      '<label class="field"><span>Marca da mercadoria</span>'+
      '<input id="spaceBrand" type="text" maxlength="100" autocomplete="off" placeholder="Ex.: MARCA X"></label></section>';
    buttons=action("new","← Alterar atividade","button light")+action("start","▶ Iniciar cronômetro","button");
  }
  const history=flow.history.length?flow.history.slice(0,12).map(summary).join(""):
    '<div class="empty">Nenhum registro anterior.</div>';
  const sectorTitle=LABEL[flow.active?.kind||flow.kind]||'Atividades de Estocagem';
  return '<div class="mobile-flow"><div class="eyebrow">ESTOCAGEM · OPERAÇÃO FÍSICA</div>'+
    '<h1 class="shell-title">'+esc(sectorTitle)+'</h1>'+
    '<p class="shell-desc">Uma etapa por vez. Todas as informações e tempos são compartilhados com o DISTRILOG Web.</p>'+
    steps+content+(buttons?'<div class="mobile-flow-actions">'+buttons+'</div>':'')+
    '<details class="mobile-flow-history"><summary>Histórico de atividades ('+flow.history.length+')</summary>'+history+'</details></div>';
}
async function act(command,user){
  if(command==="adjust"||command==="return"){
    if(flow.active)return;
    flow.kind=command==="adjust"?"AJUSTE_ESTOQUE":"DEVOLUCAO_PORTA_PALETES";
    flow.last=null;flow.finish=false;return;
  }
  if(command==="new"){
    if(flow.active)throw Error("Conclua a atividade em andamento.");
    flow.kind=null;flow.finish=false;flow.last=null;return;
  }
  if(command==="back"){flow.finish=false;return;}
  if(command==="finishStep"){if(!flow.active)throw Error("Nenhuma atividade ativa.");flow.finish=true;return;}
  if(command==="start"){
    const street=String(val("spaceStreet")).trim(),brand=String(val("spaceBrand")).trim();
    if(!street||!brand)throw Error("Informe a rua e a marca antes de iniciar.");
    const result=await api.post("/api/space-activities",{kind:flow.kind,street,brand});
    if(!result?.ok||!result.activity)throw Error("O servidor não confirmou o início.");
    flow.active=result.activity;flow.kind=null;flow.finish=false;flow.receivedAt=Date.now();
    await load();return;
  }
  const x=flow.active;
  if(!x)throw Error("Atividade não encontrada. Atualize.");
  if(command==="pause"||command==="resume"){
    const result=await api.post("/api/space-activities/"+x.id+"/"+command,{});
    if(!result?.ok||!result.activity)throw Error("O servidor não confirmou o cronômetro.");
    flow.active=result.activity;flow.receivedAt=Date.now();return;
  }
  if(command==="finish"){
    const raw=String(val("spaceQty")).trim(),unit=val("spaceUnit");
    if(!/^[1-9]\d*$/.test(raw)||Number(raw)>1000000)throw Error("Informe a quantidade movimentada maior que zero.");
    if(!UNITS[unit])throw Error("Selecione a unidade movimentada.");
    const notes=String(val("spaceNotes")).trim();
    if(!window.confirm("Confirmar "+raw+" "+UNITS[unit]+" nesta atividade? Os saldos WMS não serão alterados."))return;
    const result=await api.post("/api/space-activities/"+x.id+"/finish",{
      moved_quantity:Number(raw),quantity_unit:unit,notes
    });
    if(!result?.ok||!result.activity)throw Error("O servidor não confirmou a conclusão.");
    flow.last=result.activity;flow.active=null;flow.finish=false;flow.kind=null;
    const history=await api.get("/api/space-activities?limit=12").catch(()=>({activities:[]}));
    flow.history=history.activities||[];
    return;
  }
  throw Error("Comando de atividade desconhecido.");
}
window.DM_SPACE={load,view,act,elapsed,flow};
window.setInterval(()=>{
  const node=document.getElementById("dmSpaceClock");
  if(node&&flow.active)node.textContent=elapsed();
},1000);
})();
