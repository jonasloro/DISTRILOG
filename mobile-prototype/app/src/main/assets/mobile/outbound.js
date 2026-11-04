/* DISTRILOG Mobile — pedidos de Separação e handoff/conferência da Expedição.
 * Todas as transições são persistidas e autorizadas pelo backend FastAPI.
 * Não há timers locais como fonte de verdade, nem baixa automática de estoque.
 */
(function () {
'use strict';
const API=window.DM_API;
const state={kind:'separation',mode:'list',orders:[],alerts:[],shipments:[],selected:null,detail:null,items:[]};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
const n=v=>Number(v||0).toLocaleString('pt-BR');
const safe=(v)=>encodeURIComponent(String(v));
const get=(id)=>document.getElementById(id)?.value??'';
const positiveInt=(id,label,allowZero=false)=>{
  const value=get(id).trim();
  if(!/^\d+$/.test(value))throw Error('Informe '+label+' em número inteiro.');
  const qty=Number(value);
  if(!Number.isSafeInteger(qty)||qty>(2e6)||(allowZero?qty<0:qty<=0))
    throw Error('Quantidade inválida em '+label+'.');
  return qty;
};
const text=(id,label)=>{const value=get(id).trim();if(!value)throw Error('Informe '+label+'.');return value;};
const button=(caption,action,klass='button light',attrs='')=>'<button type="button" class="'+klass+'" data-action="outbound-'+action+'" '+attrs+'>'+esc(caption)+'</button>';
const input=(id,label,value='',type='text',extra='')=>'<label class="field"><span>'+esc(label)+'</span><input id="'+id+'" type="'+type+'" value="'+esc(value??'')+'" '+extra+'></label>';
const area=(id,label,value='')=>'<label class="field"><span>'+esc(label)+'</span><textarea id="'+id+'" maxlength="500">'+esc(value??'')+'</textarea></label>';
const selectYN=(id,label,value='')=>'<label class="field"><span>'+esc(label)+'</span><select id="'+id+'"><option value="">Selecione</option><option value="yes" '+(value==='yes'?'selected':'')+'>Sim</option><option value="no" '+(value==='no'?'selected':'')+'>Não</option></select></label>';
const num=(id,label,value='',zero=true)=>input(id,label,value,'number','min="'+(zero?'0':'1')+'" step="1" inputmode="numeric"');
const canSeparate=user=>['admin','supervisor','separacao'].includes(user?.role);
const canDispatch=user=>['admin','supervisor','estocagem','expedicao'].includes(user?.role);
const rowId=btn=>{const id=Number(btn?.dataset.id);if(!Number.isSafeInteger(id)||id<=0)throw Error('Pedido inválido.');return id;};
const fmt=s=>{const value=Math.max(0,Math.floor(Number(s)||0));return [Math.floor(value/3600),Math.floor(value/60)%60,value%60].map(x=>String(x).padStart(2,'0')).join(':');};
const seconds=(row,now)=>{
  if(!row.started_at)return 0;
  const start=Date.parse(row.started_at);
  const end=row.completed_at?Date.parse(row.completed_at):now;
  if(!Number.isFinite(start)||!Number.isFinite(end))return 0;
  const total=Math.max(0,Math.floor((end-start)/1000));
  const activePause=row.pause_started_at&&row.status==='PAUSADO'?Math.max(0,Math.floor((now-Date.parse(row.pause_started_at))/1000)):0;
  const pause=row.status==='CONCLUIDA'?
    Number(row.declared_pause_seconds||0):Number(row.accumulated_pause_seconds||0)+activePause;
  return Math.max(0,total-pause);
};
function tick(){
  if(state.kind!=='separation')return;
  for(const row of state.orders){
    const cell=document.getElementById('outbound-time-'+row.id);
    if(cell)cell.textContent=fmt(seconds(row,Date.now()));
  }
}
const order=(id)=>state.orders.find(o=>Number(o.id)===Number(id));
async function load(kind){
  state.kind=kind;state.mode='list';state.selected=null;
  if(kind==='separation'){
    const [orders,alerts]=await Promise.all([API.get('/api/separation/orders'),API.get('/api/separation/entry-alerts')]);
    state.orders=Array.isArray(orders)?orders:[];
    state.alerts=Array.isArray(alerts)?alerts:[];
    state.shipments=[];tick();
  }else if(kind==='shipping'){
    await window.DM_SHIPPING.load();
  }else throw Error('Setor de saída inválido.');
}
function sepList(user){
  const orders=state.orders;
  const pending=orders.filter(x=>x.status==='PENDENTE').length;
  const running=orders.filter(x=>x.status==='PAUSADO'||x.status==='EM_ANDAMENTO').length;
  const done=orders.filter(x=>x.status==='CONCLUIDA').length;
  return '<div class="eyebrow">PEDIDOS · CRONÔMETROS</div><h1 class="shell-title">Separação</h1>'+
    '<p class="shell-desc">Somente timers. Peças sem casulo e rua 001- já são excluídas no servidor. O fechamento envia o apontamento à Expedição.</p>'+
    '<div class="metric-row"><div class="stat"><span>Pendentes</span><strong>'+pending+'</strong></div><div class="stat"><span>Em execução</span><strong>'+running+'</strong></div><div class="stat"><span>Concluídas</span><strong>'+done+'</strong></div></div>'+
    button('↻ Atualizar pedidos','refresh')+
    (orders.map(o=>{
      const canAct=canSeparate(user)&&(!o.operator_id||Number(o.operator_id)===Number(user?.id)||['admin','supervisor'].includes(user?.role));
      return '<article class="queue-card"><span class="eyebrow">'+esc(o.destination)+'</span><h3>Pedido '+esc(o.document_no)+'</h3>'+
        '<p class="muted t-sm">'+esc(o.status)+' · '+n(o.expected_qty)+' peças elegíveis · '+n(o.excluded_street_qty)+' rua 001- · '+n(o.excluded_without_casulo_qty)+' sem casulo</p>'+
        '<div class="inline-stat"><span>Tempo líquido</span><b id="outbound-time-'+o.id+'">'+fmt(seconds(o,Date.now()))+'</b></div>'+
        '<div class="actions">'+
        (canAct&&o.status==='PENDENTE'?button('▶ Iniciar','start','button','data-id="'+o.id+'"'):'')+
        (canAct&&o.status==='EM_ANDAMENTO'?button('Pausar','pauseForm','button light','data-id="'+o.id+'"')+
          button('Concluir','finishForm','button','data-id="'+o.id+'"'):'')+
        (canAct&&o.status==='PAUSADO'?button('▶ Retomar','resume','button','data-id="'+o.id+'"'):'')+
        button('Ver referências','showItems','button light','data-id="'+o.id+'"')+'</div>'+
        (o.shipment_id?'<p class="muted t-sm">Enviado à Expedição · Romaneio #'+o.shipment_id+'</p>':'')+
        '</article>';
    }).join('')||'<div class="empty">Nenhum pedido foi importado no DISTRILOG Web.</div>')+
    '<section class="surface"><h3>Entradas ainda não vistas em pedidos</h3>'+
    (state.alerts.map(a=>'<div class="line-row"><b>'+esc(a.reference)+'</b><small>Entrada há '+n(a.days_since_entry)+' dia(s) · ainda não apareceu em pedido processado.</small></div>').join('')||
     '<p class="muted t-sm">Nenhuma referência aguardando reconhecimento em pedidos.</p>')+'</section>';
}
function sepPauseForm(){
  return '<div class="eyebrow">SEPARAÇÃO</div><h1 class="shell-title">Pausar cronômetro</h1>'+
    '<p class="shell-desc">O servidor contabiliza a duração. O motivo fica no histórico da pausa.</p>'+
    '<div class="surface">'+area('outPauseReason','Motivo da pausa *')+
    button('Confirmar pausa','pause','button full')+button('Voltar','back','button light full')+'</div>';
}
function sepFinishForm(){
  const o=order(state.selected);
  if(!o)return '<div class="empty">Pedido indisponível.</div>';
  const paused=Number(o.accumulated_pause_seconds||0)>0;
  return '<div class="eyebrow">CONCLUSÃO DA SEPARAÇÃO</div><h1 class="shell-title">Pedido '+esc(o.document_no)+'</h1>'+
    '<p class="shell-desc">Preencha todos os campos. A Expedição receberá uma linha-resumo, sem criar conferências fictícias de SKU.</p>'+
    '<div class="surface">'+
    num('outBags','Quantidade de bags *', '', true)+
    num('outBoxes','Quantidade de caixas *', '', true)+
    num('outPieces','Peças separadas *',o.expected_qty,false)+
    input('outWeight','Peso em kg *','','number','step="0.001" min="0.001" inputmode="decimal"')+
    selectYN('outZero','Teve 0 à esquerda? *')+
    selectYN('outPaused','Teve pausa? *',paused?'yes':'')+
    '<div id="outPauseDetails" '+(paused?'':'hidden')+'>'+
      area('outFinalReason','Motivo da pausa (obrigatório se houve pausa)')+
      input('outPauseDuration','Duração da pausa em hh:mm:ss',fmt(o.accumulated_pause_seconds||0),'text','placeholder="00:00:00" inputmode="numeric"')+
    '</div>'+
    button('Finalizar e enviar à Expedição','finish','button full')+
    button('Voltar','back','button light full')+'</div>';
}
function sepItems(){
  const o=order(state.selected);
  return '<h1 class="shell-title">Referências</h1><p class="shell-desc">'+esc(o?.document_no||'')+' · Consulta apenas.</p>'+
    state.items.map(i=>'<div class="line-row"><b>'+esc(i.reference)+'</b>'+
      '<small>'+esc(i.casulo)+' · '+n(i.quantity)+' peças · '+esc(i.variation)+'</small></div>').join('')+
    button('Voltar ao pedido','back','button light full');
}
function view(kind,user){
  if(kind!==state.kind)return '<div class="empty">Atualize a fila para carregar os pedidos.</div>';
  if(state.kind==='shipping')return window.DM_SHIPPING.view(user);
  if(state.mode==='pauseForm')return sepPauseForm();
  if(state.mode==='finishForm')return sepFinishForm();
  if(state.mode==='items')return sepItems();
  return sepList(user);
}
async function action(name,btn,user){
  if(state.kind==='shipping')return await window.DM_SHIPPING.action(name,btn,user);
  if(name==='back'){state.mode='list';state.selected=null;return;}
  if(name==='refresh'){await load(state.kind);return;}
  if(name==='start'){
    if(!canSeparate(user))throw Error('Perfil não autorizado.');
    await API.post('/api/separation/orders/'+rowId(btn)+'/start',{});
    await load('separation');return;
  }
  if(name==='pauseForm'||name==='finishForm'||name==='showItems'){
    state.selected=rowId(btn);
    if(!order(state.selected))throw Error('Pedido não encontrado.');
    if(name==='showItems'){
      state.items=await API.get('/api/separation/orders/'+state.selected+'/items');
      state.mode='items';return;
    }
    if(!canSeparate(user))throw Error('Perfil não autorizado.');
    state.mode=name;return;
  }
  if(name==='pause'){
    const reason=text('outPauseReason','o motivo da pausa');
    await API.post('/api/separation/orders/'+state.selected+'/pause',{reason});
    await load('separation');return;
  }
  if(name==='resume'){
    if(!canSeparate(user))throw Error('Perfil não autorizado.');
    await API.post('/api/separation/orders/'+rowId(btn)+'/resume',{});
    await load('separation');return;
  }
  if(name==='finish'){
    if(!canSeparate(user))throw Error('Perfil não autorizado.');
    const zero=get('outZero'),pause=get('outPaused');
    if(!['yes','no'].includes(zero)||!['yes','no'].includes(pause))
      throw Error('Responda Sim/Não sobre 0 à esquerda e pausa.');
    const body={
      bags:positiveInt('outBags','bags',true),
      boxes:positiveInt('outBoxes','caixas',true),
      separated_qty:positiveInt('outPieces','peças separadas'),
      weight_kg:text('outWeight','o peso em kg').replace(',','.'),
      zero_left:zero==='yes',had_pause:pause==='yes',
    };
    if(body.had_pause){
      body.pause_reason=text('outFinalReason','o motivo da pausa');
      body.pause_duration=text('outPauseDuration','o tempo da pausa em hh:mm:ss');
      if(!/^\d{1,4}:[0-5]\d:[0-5]\d$/.test(body.pause_duration))
        throw Error('Duração inválida. Use hh:mm:ss.');
    }
    await API.post('/api/separation/orders/'+state.selected+'/complete',body);
    await load('separation');return;
  }
  throw Error('Ação de saída desconhecida.');
}
window.DM_OUTBOUND={load,view,action,tick,state};
})();
