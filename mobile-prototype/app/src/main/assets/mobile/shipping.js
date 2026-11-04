/* Expedição mobile: mesmo contrato atômico utilizado no Web. */
(function(){
'use strict';
const api=window.DM_API;
const state={rows:[],detail:null,working:false,lastHeartbeat:0};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const btn=(label,action,style='button',attrs='')=>'<button class="'+style+'" data-action="outbound-'+action+'" '+attrs+'>'+esc(label)+'</button>';
const field=(id,label,value='',type='text',extra='')=>'<label class="field"><span>'+esc(label)+'</span><input id="'+id+'" type="'+type+'" value="'+esc(value??'')+'" '+extra+'></label>';
const text=(id,label,value='')=>'<label class="field"><span>'+esc(label)+'</span><textarea id="'+id+'" maxlength="500">'+esc(value??'')+'</textarea></label>';
const get=id=>document.getElementById(id)?.value?.trim()||'';
const allowed=user=>["admin","supervisor","expedicao"].includes(user?.role);
const my=(row,user)=>Number(row?.owner_user_id||0)===Number(user?.id||-1);
const number=n=>Number(n||0).toLocaleString('pt-BR');
const title=stage=>({CONFERENCIA:"Conferência de lacres",FATURAMENTO:"Faturamento",
  EXPEDIR:"Pronto para expedir",EXPEDIDO:"Expedido",DIVERGENCIA:"Divergência de lacres"})[stage]||stage;
function elapsed(row){
  if(!row)return 0;
  const base=Number((row.stage==="FATURAMENTO"?row.billing_seconds:row.conference_seconds)||0);
  if(!row.owner_started_at||!row.owner_user_id)return base;
  const offset=Math.floor((Date.now()-Date.parse(row.owner_started_at))/1000);
  return Math.max(0,base+offset);
}
function fmt(s){
  const n=Math.max(0,Math.floor(Number(s)||0));
  return [Math.floor(n/3600),Math.floor(n/60)%60,n%60].map(v=>String(v).padStart(2,'0')).join(':');
}
async function load(){
  const result=await api.get("/api/shipping/queue");
  state.rows=Array.isArray(result)?result:[];
  state.detail=null;
  state.lastHeartbeat=0;
}
async function open(id){
  const raw=Number(id);
  if(!Number.isSafeInteger(raw)||raw<1)throw Error('Romaneio inválido.');
  state.detail=await api.get("/api/shipping/"+raw);
  state.lastHeartbeat=0;
}
function list(user){
  const rows=state.rows, count=k=>rows.filter(r=>r.stage===k).length;
  return '<div class="eyebrow">EXPEDIÇÃO · CONTROLE DE SAÍDA</div>'+
    '<h1 class="shell-title">Expedição</h1><p class="shell-desc">Conferência rápida de lacres, faturamento e expedição. Sem contagem de peças por SKU.</p>'+
    '<div class="metric-row"><div class="stat"><span>Conferir</span><strong>'+count('CONFERENCIA')+'</strong></div>'+
      '<div class="stat"><span>Faturar</span><strong>'+count('FATURAMENTO')+'</strong></div>'+
      '<div class="stat"><span>Expedir</span><strong>'+count('EXPEDIR')+'</strong></div></div>'+
    btn('↻ Atualizar fila','refresh','button light full')+
    (rows.map(row=>'<article class="queue-card"><span class="eyebrow">'+esc(title(row.stage))+'</span>'+
      '<h3>Romaneio '+esc(row.document_no)+'</h3>'+
      '<p class="muted t-sm">'+esc(row.destination||'Destino pendente')+' · '+number(row.total_qty)+' peças informadas · '+number(row.volume_count)+' volumes</p>'+
      (row.owner_user_id?'<p class="mobile-ship-locked">🔒 Em execução por '+esc(row.owner_name||'operador')+'</p>':'')+
      btn(allowed(user)?'Abrir etapa →':'Consultar →','shipOpen','button full','data-id="'+Number(row.id)+'"')+
      '</article>').join('')||'<div class="empty">Nenhum romaneio disponível.</div>');
}
function detail(user){
  const row=state.detail;
  if(!row)return '<div class="empty">Romaneio indisponível.</div>';
  const owned=my(row,user),busy=row.owner_user_id&&!owned,step=row.stage,authorized=allowed(user);
  let action='';
  if(busy)action='<div class="status-box warn">🔒 Outro operador está executando esta etapa. Aguarde a liberação.</div>';
  else if(authorized&&['CONFERENCIA','FATURAMENTO'].includes(step)&&!owned)
    action=btn('▶ Assumir etapa e iniciar cronômetro','shipClaim','button full');
  else if(authorized&&owned&&step==='CONFERENCIA')
    action='<div class="surface">'+field('shipSealCount','Quantidade de lacres conferidos *','','number','min="1" step="1" inputmode="numeric"')+
      '<label class="field"><span>Lacres corretos? *</span><select id="shipSealOk"><option value="">Selecione</option><option value="yes">Sim</option><option value="no">Não (divergência)</option></select></label>'+
      text('shipSealNotes','Observação ou divergência')+
      btn('Concluir conferência de lacres','shipComplete','button full')+
      btn('Liberar etapa para outro operador','shipRelease','button light full')+'</div>';
  else if(authorized&&owned&&step==='FATURAMENTO')
    action='<div class="surface">'+field('shipInvoiceNumber','Número da NF emitida *',row.invoice_number||'')+
      text('shipInvoiceNotes','Observações',row.invoice_notes||'')+
      '<p class="muted t-sm">Confirme a NF no sistema fiscal. Este timer não emite nota fiscal.</p>'+
      btn('Concluir faturamento','shipComplete','button full')+
      btn('Liberar etapa para outro operador','shipRelease','button light full')+'</div>';
  else if(authorized&&step==='EXPEDIR')
    action='<div class="status-box">Lacres e faturamento concluídos. A saída física só será registrada ao confirmar.</div>'+
      btn('↗ Confirmar EXPEDIR','shipDispatch','button full');
  else if(step==='DIVERGENCIA'&&['admin','supervisor'].includes(user?.role))
    action='<div class="status-box warn">Divergência aberta; faturamento bloqueado.</div>'+
      text('shipResolveReason','Justificativa de reabertura *')+
      btn('Reabrir conferência','shipResolve','button full');
  else if(step==='DIVERGENCIA')action='<div class="status-box warn">Aguardando revisão da gestão.</div>';
  else if(step==='EXPEDIDO')action='<div class="status-box">✓ Saída confirmada e registrada.</div>';
  return '<div class="eyebrow">'+esc(title(step))+'</div><h1 class="shell-title">Pedido '+esc(row.document_no)+'</h1>'+
    '<p class="shell-desc">'+esc(row.destination||'Destino pendente')+'</p>'+
    '<div class="surface"><div class="inline-stat"><span>Peças informadas</span><b>'+number(row.total_qty)+'</b></div>'+
    '<div class="inline-stat"><span>Volumes</span><b>'+number(row.volume_count)+'</b></div>'+
    '<div class="inline-stat"><span>Lacres conferidos</span><b>'+esc(row.seals_checked??'—')+'</b></div>'+
    '<div class="inline-stat"><span>NF</span><b>'+esc(row.invoice_number||'—')+'</b></div>'+
    '<div class="mobile-shipping-clock"><span>Tempo da etapa</span><strong id="mobileShippingClock">'+fmt(elapsed(row))+'</strong></div></div>'+
    action+
    '<section class="surface"><h3>Histórico de execução</h3>'+
      (row.events||[]).slice(0,12).map(e=>'<div class="line-row"><b>'+esc(e.actor||'Operador')+' · '+esc(e.event)+'</b><small>'+esc(e.details||'')+'</small></div>').join('')+
      '</section>'+btn('← Voltar aos romaneios','shipBack','button light full');
}
function view(user){return state.detail?detail(user):list(user)}
function tick(){
  const target=document.getElementById('mobileShippingClock');
  if(target&&state.detail)target.textContent=fmt(elapsed(state.detail));
}
async function keepAlive(user){
  const row=state.detail;
  if(!row||!my(row,user)||!['CONFERENCIA','FATURAMENTO'].includes(row.stage))return;
  if(state.working)return;
  if(Date.now()-state.lastHeartbeat<25000)return;
  state.lastHeartbeat=Date.now();
  try { await api.post('/api/shipping/'+row.id+'/heartbeat',{}); }
  catch(e) {
    state.lastHeartbeat=0;
    state.detail=null;
    throw Error('Reserva não renovada: '+e.message+'. Atualize a fila.');
  }
}
async function action(name,button,user){
  if(state.working)return;
  state.working=true;
  try {
    if(name==='back'||name==='shipBack'){state.detail=null;return;}
    if(name==='refresh'){await load();return;}
    if(name==='shipOpen'){await open(button?.dataset?.id);return;}
    const row=state.detail;
    if(!row||!authorized(user))throw Error('Operação não permitida.');
    const path='/api/shipping/'+Number(row.id)+'/';
    if(name==='shipClaim')await api.post(path+'claim',{});
    else if(name==='shipRelease')await api.post(path+'release',{});
    else if(name==='shipComplete'){
      let data={};
      if(row.stage==='CONFERENCIA'){
        const count=get('shipSealCount'),isOk=get('shipSealOk');
        if(!/^\d+$/.test(count)||Number(count)<1)throw Error('Informe a quantidade de lacres conferidos.');
        if(!['yes','no'].includes(isOk))throw Error('Informe se os lacres estão corretos.');
        data={seals_checked:Number(count),seals_ok:isOk==='yes',notes:get('shipSealNotes')};
        if(isOk==='no'&&!data.notes)throw Error('Descreva a divergência dos lacres.');
      }else if(row.stage==='FATURAMENTO'){
        const invoice=get('shipInvoiceNumber');
        if(!invoice)throw Error('Informe o número da NF emitida.');
        data={invoice_number:invoice,notes:get('shipInvoiceNotes')};
      }else throw Error('Etapa não permite conclusão.');
      await api.post(path+'complete',data);
    }
    else if(name==='shipDispatch'){
      if(!window.confirm('Confirmar saída física do romaneio?'))return;
      await api.post(path+'dispatch',{});
    }else if(name==='shipResolve'){
      const reason=get('shipResolveReason');
      if(reason.length<5)throw Error('Justifique a reabertura.');
      await api.post(path+'resolve',{reason});
    }else throw Error('Ação inválida.');
    await open(row.id);
  }finally{state.working=false;}
}
const authorized=allowed;
window.DM_SHIPPING={load,view,action,tick,keepAlive,state};
})();