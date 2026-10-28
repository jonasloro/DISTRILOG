/* DISTRILOG Mobile: mobile-first UI based on the user's sector prototype.
 * No demo fixtures. Data is read exclusively from the real DISTRILOG API.
 * Every write is confirmed by the backend; no offline queues or fake success.
 */
(function () {
'use strict';
const API=window.DM_API;
const KEY='distrilog_mobile_real_account_v1';
const SECTORS=[
  {id:'receiving',pt:'Recebimento',es:'Recepción',icon:'▣',role:'recebimento'},
  {id:'quality',pt:'Qualidade',es:'Calidad',icon:'◇',role:'qualidade'},
  {id:'processing',pt:'Processamento',es:'Procesamiento',icon:'⚙',role:'processamento'},
  {id:'labeling',pt:'Etiquetagem',es:'Etiquetado',icon:'♢',role:'etiquetagem'},
  {id:'storage',pt:'Estocagem',es:'Almacenamiento',icon:'⌂',role:'estocagem'},
  {id:'costura',pt:'Costura / Despacho',es:'Costura / Despacho',icon:'✂',role:'recebimento'},
  {id:'entry',pt:'Entrada',es:'Entrada',icon:'⇥',role:'processamento'},
  {id:'cadastro',pt:'Cadastro',es:'Registro',icon:'▤',role:'processamento'}
];
const ALLOC_SECTORS=['RM','QA','PR','ET','EC'];
const s={screen:'setup',user:null,sector:'receiving',cards:[],selected:null,card:null,trail:[],triage:null,entry:null,cadastro:null,positions:[],
  selectedArea:'RM',address:null,inventory:null,history:[],dashboard:null,search:'',scanValue:'',busy:false,toast:null,toastTimer:null,restore:false,firstPassword:null};
const app=document.getElementById('app');
const tr=(pt,es)=>s.user&&s.user.language==='es'?(es||pt):pt;
const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=(v)=>Number(v||0).toLocaleString(s.user?.language==='es'?'es-ES':'pt-BR');
const q=(v)=>encodeURIComponent(String(v??''));
const role=()=>String(s.user?.role||'').toLowerCase();
const roleCan=(name)=>role()===name || ['admin','supervisor'].includes(role());
const currentName=(id)=>{const row=SECTORS.find(x=>x.id===id);return row?(s.user?.language==='es'?row.es:row.pt):id;};
const val=(id)=>document.getElementById(id)?.value??'';
const checked=(id)=>Boolean(document.getElementById(id)?.checked);
const intField=(id,allowZero=false)=>{const t=String(val(id)).trim();if(!/^\d+$/.test(t))throw Error('Informe um número inteiro válido para '+id+'.');const n=Number(t);if(!Number.isSafeInteger(n)||n<(allowZero?0:1))throw Error('Quantidade inválida.');return n;};
const nullableInt=(id)=>String(val(id)).trim()===''?null:intField(id,true);
const required=(id,label)=>{const t=String(val(id)).trim();if(!t)throw Error('Informe '+label+'.');return t;};
const input=(id,label,value,type='text',extra='')=>'<label class="field"><span>'+esc(label)+'</span><input id="'+id+'" type="'+type+'" value="'+esc(value??'')+'" '+extra+'></label>';
const textarea=(id,label,value)=>'<label class="field"><span>'+esc(label)+'</span><textarea id="'+id+'">'+esc(value??'')+'</textarea></label>';
const button=(label,action,cls='button',attrs='')=>'<button class="'+cls+'" data-action="'+action+'" data-fixed-disabled="'+(/\bdisabled\b/.test(attrs)?'1':'0')+'" '+attrs+' '+(s.busy?'disabled':'')+'>'+label+'</button>';
const pill=(label,cls='ghost')=>'<span class="chip '+cls+'">'+esc(label)+'</span>';
const section=(label)=>'<div class="section-label">'+esc(label)+'</div>';
const note=(text,kind='')=>'<div class="status-box '+esc(kind)+'">'+esc(text)+'</div>';
const safeTitle=(item)=>String(item?.reference||item?.product||item?.sku||item?.purchase_id||'Sem referência');
const sectorScope=(id)=>({receiving:'receiving',quality:'quality',processing:'processing',labeling:'labeling',storage:'storage',costura:'receiving',entry:'entry',cadastro:'cadastro'})[id]||'receiving';
const userBody=(extra)=>Object.assign({user_id:Number(s.user.id)},extra||{});

function flash(message,error=false){
  const old=document.getElementById('appToast'); if(old)old.remove();
  const n=document.createElement('div'); n.id='appToast';if(error)n.classList.add('error');n.textContent=message;
  document.body.appendChild(n);clearTimeout(s.toastTimer);s.toastTimer=setTimeout(()=>n.remove(),5500);
}
function setBusy(b){s.busy=b;document.querySelectorAll('button').forEach(x=>{if(x.dataset.action && x.dataset.action!=='configure')x.disabled=b||x.dataset.fixedDisabled==='1';});}
function publicError(error){return error instanceof Error ? error.message : String(error||'Falha inesperada.');}
async function run(task,successMessage){
  if(s.busy)return;setBusy(true);
  try{
    const result=await task();
    if(result&&result.ok===false){flash(result.detail||'O servidor solicitou revisão desta operação.',true);return result;}
    if(successMessage)flash(successMessage);
    return result;
  }catch(error){flash(publicError(error),true);return null}
  finally{setBusy(false);}
}
function setScreen(screen){s.screen=screen;render();window.scrollTo(0,0)}
function header(){
  return '<header class="top-band"><div class="brand-mark">D</div><div class="brand-word">DISTRI<span>LOG</span><small>MOBILE · OPERAÇÃO REAL</small></div>'+
   '<span style="margin-left:auto;font-size:10px;color:#abc3af;font-weight:850">'+esc(s.busy?'SINCRONIZANDO':'● WMS ONLINE')+'</span></header>';
}
function navbar(){
  const tabs=[['queue','▤',tr('Fila','Cola')],['scan','▣','Rack'],['address','▦',tr('Estoque','Inventario')],['history','◷',tr('Histórico','Historial')],['settings','⚙',tr('Ajustes','Ajustes')]];
  return '<nav class="bottom-nav" aria-label="Navegação">'+tabs.map(x=>'<button data-action="nav" data-to="'+x[0]+'" class="'+(s.screen===x[0]||s.screen==='card'&&x[0]==='queue'?'on':'')+'"><span>'+x[1]+'</span>'+esc(x[2])+'</button>').join('')+'</nav>';
}
function roleBar(){
  return '<div class="role-row"><div class="role-user"><b>'+esc(s.user?.name||s.user?.username)+'</b><span>'+esc(role())+' • '+esc(API.endpoint().replace('https://',''))+'</span></div>'+
  button('↻ '+tr('Atualizar','Actualizar'),'refresh','button light small')+'</div>';
}
function render(){
  if(s.screen==='setup'){app.innerHTML=setupView();return}
  if(s.screen==='login'||s.screen==='change-password'){app.innerHTML=loginView();return}
  if(!s.user){s.screen='login';app.innerHTML=loginView();return}
  let view='';
  if(s.screen==='queue')view=queueView();
  else if(s.screen==='card')view=cardView();
  else if(s.screen==='scan')view=scanView();
  else if(s.screen==='address')view=addressView();
  else if(s.screen==='history')view=historyView();
  else if(s.screen==='settings')view=settingsView();
  else view=queueView();
  app.innerHTML=header()+roleBar()+'<section class="viewport">'+view+'</section>'+navbar();
}
function setupView(){
  return header()+'<section class="viewport"><div class="login-wrap"><div class="brand-mark">D</div><h1>Seu DISTRILOG.<br>Na sua mão.</h1>'+
   '<p>Interface móvel do protótipo conectada ao mesmo backend e banco de dados do DISTRILOG Web.</p>'+
   '<section class="surface"><span class="eyebrow">CONEXÃO SEGURA</span>'+
   input('server','Endereço HTTPS do DISTRILOG no Render',API.endpoint()||'','url','inputmode="url" autocapitalize="none"')+
   note('Informe a URL principal do sistema, por exemplo: https://seu-servico.onrender.com. O acesso usa HTTPS e seu login habitual.')+
   button('Conectar ao sistema →','configure','button full')+'</section></div></section>';
}
function loginView(){
  const change=s.screen==='change-password';
  return header()+'<section class="viewport"><div class="login-wrap"><div class="brand-mark">D</div><h1>'+esc(change?'Definir nova senha':'Entrar no DISTRILOG')+'</h1>'+
   '<p>'+esc(change?'Sua conta exige troca da senha temporária.':'Mesmos usuários, permissões e dados do DISTRILOG Web.')+'</p>'+
   '<section class="surface"><span class="eyebrow">'+esc(API.endpoint())+'</span>'+
   (change?'':input('username','Usuário','','text','autocomplete="username" autocapitalize="none"'))+
   (change?'':input('password','Senha','','password','autocomplete="current-password"'))+
   (change?input('newPassword','Nova senha (mínimo 12 caracteres)','','password','autocomplete="new-password"')+input('confirmPassword','Confirmar nova senha','','password','autocomplete="new-password"'):'')+
   (change?button('Atualizar senha','changePassword','button full'):button('Entrar','login','button full'))+
   '<div class="actions">'+button(change?'Cancelar':'Trocar servidor','resetConnection','button outline small')+'</div></section>'+
   note('Todas as movimentações são confirmadas pelo backend. O aplicativo não inventa nem armazena cards fictícios.')+
   '</div></section>';
}
function queueView(){
  const cards=s.cards||[];
  const ready=cards.filter(x=>String(x.status||'').includes('AGUARDANDO')).length;
  const total=cards.reduce((v,c)=>v+Number(c.expected_total||0),0);
  const intro='<div class="eyebrow">'+esc(tr('CENTRAL OPERACIONAL','CENTRAL OPERATIVA'))+'</div>'+
    '<h1 class="shell-title">'+esc(tr('Fila de execução','Cola de ejecución'))+'</h1>'+
    '<p class="shell-desc">Dados reais sincronizados com o DISTRILOG Web. Selecione o setor e consulte seus cards.</p>'+
    '<div class="metric-row"><div class="stat"><span>Cards</span><strong>'+number(cards.length)+'</strong></div><div class="stat"><span>Aguardando</span><strong>'+number(ready)+'</strong></div><div class="stat"><span>Peças previstas</span><strong>'+number(total)+'</strong></div></div>';
  const selector='<div class="selector" id="sectorTabs">'+SECTORS.map(x=>'<button class="'+(s.sector===x.id?'on':'')+'" data-action="sector" data-to="'+x.id+'">'+x.icon+' '+esc(currentName(x.id))+'</button>').join('')+'</div>';
  const search='<label class="search-bar"><span>⌕</span><input id="queueSearch" type="search" placeholder="'+esc(tr('Buscar referência, card ou compra','Buscar referencia, tarjeta o compra'))+'" value="'+esc(s.search)+'"></label>';
  const list=cards.length?cards.map(c=>{
    const ref=c.reference_list||c.reference||c.purchase_id||('Card #'+c.id);
    const status=c.status_label||c.status||'PENDENTE';
    const access=roleCan(SECTORS.find(x=>x.id===s.sector)?.role||'');
    const searchable=[c.purchase_id,c.reference_list,c.reference,c.brand,c.supplier,c.status,c.id].join(' ').toLowerCase();
    return '<article class="queue-card" data-search="'+esc(searchable)+'"><div class="flexline"><span class="card-id">CARD #'+esc(c.id)+'</span>'+
      pill(status,'tone-ready')+'</div><h3 class="break">'+esc(ref)+'</h3><p class="sub">'+esc(c.brand||c.supplier||'—')+' · '+esc(c.purchase_id||'')+'</p>'+
      '<div class="chips">'+pill(c.current_sector||currentName(s.sector))+
      (access?pill('Setor autorizado','tone-ready'):pill('Consulta','warm'))+'</div>'+
      '<div class="tile-footer"><span>'+number(c.item_count||0)+' '+tr('itens','artículos')+' · '+number(c.expected_total||0)+' '+tr('peças','piezas')+'</span>'+
      button(tr('Abrir Card','Abrir tarjeta')+' →','card','button small','data-id="'+esc(c.card_id||c.id)+'"')+'</div></article>';
  }).join(''):'<div class="empty">Nenhum card encontrado neste setor. Atualize para verificar novas movimentações.</div>';
  const extra=s.sector==='entry'?note('Entrada: a conferência final usa as quantidades já registradas após Estocagem.'):'';
  return intro+selector+search+extra+'<div class="section-head"><h2>'+esc(currentName(s.sector))+'</h2><span class="mini" id="queueCount">'+cards.length+'</span></div>'+
    '<div id="queueItems">'+list+'</div>';
}
function scanView(){
  return '<div class="eyebrow">IDENTIFICAÇÃO FÍSICA</div><h1 class="shell-title">Leitor de Rack</h1>'+
  '<p class="shell-desc">Leia um QR Code ou código de barras da etiqueta. A leitura identifica o material; nenhuma movimentação é executada automaticamente.</p>'+
  '<div class="scanner-panel"><div class="hero">▣</div><h2>Leitura pela câmera</h2><p class="muted">Use o leitor nativo Android.</p>'+
  button('📷 Iniciar leitura','scanNative','button full')+'</div>'+
  '<section class="surface">'+input('scanManual','Código, referência ou ID do Card',s.scanValue,'text','autocapitalize="characters"')+
  button('Pesquisar no WMS →','resolveScan','button full')+'</section>';
}
function settingsView(){
  return '<div class="eyebrow">CONTA E CONEXÃO</div><h1 class="shell-title">Configurações</h1>'+
  '<div class="surface"><div class="inline-stat"><span>Servidor</span><b class="break">'+esc(API.endpoint())+'</b></div>'+
  '<div class="inline-stat"><span>Usuário</span><b>'+esc(s.user?.username)+'</b></div>'+
  '<div class="inline-stat"><span>Perfil</span><b>'+esc(role())+'</b></div>'+
  '<div class="inline-stat"><span>Tipo de aplicativo</span><b>Interface própria · API real</b></div>'+
  '<label class="field"><span>Idioma da conta</span><select id="language"><option value="pt-BR" '+(s.user?.language!=='es'?'selected':'')+'>Português</option><option value="es" '+(s.user?.language==='es'?'selected':'')+'>Español</option></select></label>'+
  button('Salvar idioma','language','button full')+
  '<div class="actions">'+button('Alterar servidor','resetConnection','button light')+button('Sair','logout','button danger')+'</div></div>'+
  note('Operações reais: sempre exigem confirmação no servidor e respeitam permissões por setor. Não há sincronização offline de movimentações.')+
  section('Sobre')+'<p class="muted t-sm">Visual criado a partir do protótipo HTML enviado. Este APK contém uma interface móvel independente; ele não incorpora o site do DISTRILOG em uma WebView.</p>';
}
function historyView(){
  const events=s.history||[];
  return '<div class="eyebrow">AUDITORIA</div><h1 class="shell-title">Histórico operacional</h1>'+
  '<p class="shell-desc">Últimos acontecimentos registrados pelo WMS, compartilhados com o aplicativo web.</p>'+
  (events.length?events.slice(0,100).map(x=>'<div class="line-row"><b>'+esc(x.description||x.event_type||x.action||'Movimentação')+'</b>'+
    '<small>'+esc(x.user_name||'')+' · '+esc(x.created_at||'')+'</small>'+esc(x.purchase_id||'')+'</div>').join(''):
    '<div class="empty">Nenhum evento disponível. Atualize para consultar o histórico.</div>');
}
function addressView(){
  const sectors=ALLOC_SECTORS;
  const positions=s.positions||[];
  return '<div class="eyebrow">WMS • LOCALIZAÇÃO</div><h1 class="shell-title">Mapa de endereçamento</h1>'+
  '<p class="shell-desc">Posições reais registradas no banco. RM/QA/PR usam volumes; ET/EC usam caixas pretas.</p>'+
  '<div class="selector">'+sectors.map(z=>'<button class="'+(s.selectedArea===z?'on':'')+'" data-action="area" data-to="'+z+'">'+z+'</button>').join('')+'</div>'+
  '<label class="search-bar"><span>⌕</span><input id="addressSearch" placeholder="Buscar endereço" value=""></label>'+
  '<div class="section-head"><h2>Posições '+esc(s.selectedArea)+'</h2><span class="mini">'+positions.length+'</span></div>'+
  '<div id="addressRows">'+(positions.length?positions.slice(0,160).map(p=>'<div class="line-row" data-address="'+esc(p.address)+'"><div class="inline"><div><b>'+esc(p.address)+'</b><small>'+esc(p.zona_label||p.zona||p.setor||'')+'</small></div>'+
  button('Consultar →','inventory','button light small','data-address="'+esc(p.address)+'"')+'</div></div>').join(''):'<div class="empty">Nenhuma posição retornada para o setor selecionado.</div>')+'</div>'+
  (s.inventory?inventoryView():'');
}
function inventoryView(){
  const data=s.inventory,rows=data.items||[];
  return '<div class="surface"><div class="page-header"><h1>'+esc(data.location?.address||s.address)+'</h1>'+button('×','closeInventory','button light small')+'</div>'+
  note(number(data.occupied)+' '+(data.unit==='CAIXA_PRETA'?'caixas pretas':'volumes')+' neste endereço. Consulta em tempo real.')+
  (data.inconsistent?note('O WMS identificou um vínculo inconsistente. Revise na interface web antes de movimentar.','warn'):'')+
  (rows.length?rows.map(i=>'<div class="line-row"><b>'+esc(i.reference||i.sku||i.product||'Item não identificado')+'</b>'+
    '<small>'+esc(i.color||'')+' '+esc(i.size||'')+' • Card #'+esc(i.card_id||'—')+'</small>'+
    '<div class="inline"><b>'+number(data.unit==='CAIXA_PRETA'?i.box_count:i.quantidade)+' '+(data.unit==='CAIXA_PRETA'?'caixas':'volumes')+'</b>'+
    button('Abrir','card','button outline small','data-id="'+esc(i.card_id||0)+'"')+'</div></div>').join(''):'<div class="empty">Endereço vazio.</div>')+'</div>';
}
function infoRow(label,value){return '<div class="inline-stat"><span>'+esc(label)+'</span><b class="break">'+esc(value??'—')+'</b></div>';}
function tab(title,description,content){
  return '<section class="surface">'+section(title)+(description?'<p class="muted t-sm">'+esc(description)+'</p>':'')+content+'</section>';
}
function grade(items,hideQty=false){
  return (items||[]).length?items.map(i=>'<div class="line-row"><div class="inline"><div><b>'+esc(safeTitle(i))+'</b>'+
    '<small>'+esc(i.color||'')+' · '+esc(i.size||'')+(i.sku?' · '+esc(i.sku):'')+'</small></div>'+
    (hideQty?'':pill(number(i.real_qty??i.expected_qty??i.quantidade??0)+' pç','tone-ready'))+'</div></div>').join(''):
    '<p class="muted t-sm">Sem linhas de grade disponíveis.</p>';
}
function locations(){
  const active=(s.trail||[]).filter(x=>x.active===true||x.active===1);
  const by=new Map();
  active.forEach(x=>{const addr=String(x.address||'');if(addr)by.set(addr,(by.get(addr)||0)+Number(x.quantidade||0))});
  return tab('Localização física',by.size+' endereço(s) ativos no WMS',
    by.size?[...by.entries()].map(([a,n])=>'<div class="line-row"><div class="inline"><div><b>'+esc(a)+'</b><small>'+number(n)+' unidades alocadas</small></div>'+
      button('Ver','openAddress','button light small','data-address="'+esc(a)+'"')+'</div></div>').join(''):
      note('Ainda não há endereçamento ativo registrado para este Card.','warn'));
}
function cardView(){
  const c=s.card;if(!c)return '<div class="empty">Selecione um card na fila.</div>';
  const name=c.manual_reference||c.items?.find(x=>x.reference)?.reference||c.purchase_id||('Card #'+c.id);
  const authorized=roleCan(String(c.current_sector||'').toLowerCase());
  const basics='<div class="page-header">'+button('‹','backQueue','button light small')+'<h1>Card '+esc(name)+'</h1></div>'+
    '<div class="flexline"><span class="card-id">#'+esc(c.id)+'</span>'+pill(c.status_label||c.status,'tone-ready')+'</div>'+
    '<div class="chips">'+pill(c.current_sector||'—')+pill(c.purchase_mode||'—')+'</div>'+
    '<div class="surface">'+infoRow('Compra',c.purchase_id)+infoRow('Marca / fornecedor',c.brand||c.supplier)+
    infoRow('Itens',c.items?.length||0)+infoRow('Quantidade prevista',number(c.expected_total))+
    infoRow('Volumes recebidos',c.receiving?.volumes??'Não informado')+'</div>';
  let operation='';
  if(s.sector==='cadastro')operation=cadastroPanel(c);
  else if(c.current_sector==='RECEBIMENTO')operation=receivingPanel(c);
  if(c.current_sector==='QUALIDADE')operation=qualityPanel(c);
  if(c.current_sector==='PROCESSAMENTO')operation=processingPanel(c);
  if(c.current_sector==='ETIQUETAGEM'||c.current_sector==='ESTOCAGEM')operation=downstreamPanel(c);
  if(c.current_sector==='FINALIZADO')operation=note('Card finalizado. Histórico disponível para consulta.');
  if(c.current_sector==='FORA_FLUXO')operation=note('Mercadoria fora do fluxo interno. Confira o histórico.');
  const list=tab('Produtos e grade',c.current_sector==='ESTOCAGEM'||c.current_sector==='PROCESSAMENTO'?'Conferência cega: quantidades previstas omitidas nesta etapa.':null,grade(c.items, c.current_sector==='ESTOCAGEM'||c.current_sector==='PROCESSAMENTO'));
  const timeline=tab('Últimos acontecimentos',null,(c.history||[]).slice().reverse().slice(0,15).map(h=>'<div class="line-row"><b>'+esc(h.description||h.event_type||'Movimentação')+'</b><small>'+esc(h.created_at||'')+' · '+esc(h.user_name||'')+'</small></div>').join('')||'<p class="muted">Sem histórico.</p>');
  return basics+locations()+operation+list+timeline;
}

function allowOperation(sector){
  if(!roleCan(sector))return false;
  return !!s.user&&!s.busy;
}
function operationUnavailable(expectedSector){
  return note('Este card pertence a outro setor ou seu perfil é de consulta. As ações operacionais permanecem bloqueadas pelo servidor.','warn');
}
function receivingPanel(c){
  const rec=c.receiving;
  if(role()!=='recebimento')return operationUnavailable('recebimento');
  if(c.in_transit)return tab('Chegada da mercadoria','Card ainda em trânsito',
    note('Confirme a chegada física ao CD. A partir dessa confirmação, o Recebimento é liberado.','warn')+
    (role()==='recebimento'?button('Confirmar chegada física','markArrived','button full'):''));
  if(c.status==='AGUARDANDO_DESPACHO_COSTURA'){
    return tab('Despacho à Costura','Procedimento real no Recebimento',
      input('carrier','Transportadora','')+input('seamstress','Costureiro(a)','')+
      '<div class="grid-two">'+input('dispatchQty','Peças despachadas','','number','min="1"')+
      input('dispatchVolumes','Volumes','','number','min="1"')+'</div>'+textarea('dispatchNotes','Observações','')+
      (role()==='recebimento'?button('Confirmar despacho','dispatch','button full'):''));
  }
  if(!rec)return tab('Recebimento',null,note('O backend ainda não disponibilizou o registro de Recebimento deste Card. Atualize ou confirme a chegada da mercadoria.','warn'));
  const isReturn=String(rec.receiving_type||c.receiving_type||'').toUpperCase()==='RETORNO';
  const done=rec.physical_status==='CONCLUIDO',editable=role()==='recebimento'&&!done;
  const timerState=String(rec.ten_percent_status||'NAO_INICIADA');
  const timerButtons=(timerState==='NAO_INICIADA'?button('▶ Iniciar tiragem','sample-start','button small'):'')+
    (timerState==='EM_ANDAMENTO'?button('⏸ Pausar','sample-pause','button light small')+button('✓ Concluir tiragem','sample-finish','button small'):'')+
    (timerState==='PAUSADA'?button('▶ Retomar','sample-resume','button small')+button('✓ Concluir tiragem','sample-finish','button small'):'');
  const readOnly=!editable?note('Recebimento físico concluído ou perfil sem permissão. Os dados abaixo são somente leitura.','warn'):'';
  let content=readOnly+
    '<div class="grid-two">'+input('volumes','Volumes (caixas ou bags)',rec.volumes,'number','min="1" '+(editable?'':'readonly'))+
    input('receivedQty','Peças recebidas',rec.received_qty,'number','min="0" '+(editable?'':'readonly'))+'</div>'+
    '<label class="field"><span>Há danos ou avarias?</span><select id="hasDamage" '+(editable?'':'disabled')+'>'+
    '<option value="" '+(rec.has_damage===null?'selected':'')+'>Selecione</option>'+
    '<option value="no" '+(rec.has_damage===0||rec.has_damage===false?'selected':'')+'>Não</option>'+
    '<option value="yes" '+(rec.has_damage===1||rec.has_damage===true?'selected':'')+'>Sim</option></select></label>'+
    textarea('damageDescription','Descrição das avarias',rec.damage_description||'')+
    textarea('receivingNotes','Observações',rec.notes||'');
  if(!isReturn){
    content+=section('Tiragem dos 10%')+note('O sistema exige exatamente a quantidade prevista para a amostra. A retirada não reduz automaticamente o número de volumes recebidos.')+
      input('sampleActual','Peças efetivamente separadas',rec.ten_percent_actual,'number','min="0" '+(editable?'':'readonly'))+
      infoRow('Amostra prevista pelo WMS',number(rec.ten_percent_min||0)+' peças')+
      infoRow('Status da amostra',timerState);
  }else{
    content+=note('Retorno da Costura: não existe nova tiragem de 10% no Recebimento. O Card segue para a Inspeção 2.', 'warn');
  }
  if(editable)content+=button('Salvar conferência física','saveReceiving','button full');
  if(editable&&!isReturn&&timerState!=='CONCLUIDA')content+='<div class="actions">'+timerButtons+'</div>';
  if(editable&&!isReturn&&timerState==='CONCLUIDA'){
    content+=input('afterVolumes','Volumes após tiragem',rec.volumes_after_sample??rec.volumes,'number','min="1"')+
      button('Salvar volumes após tiragem','saveAfterVolumes','button light full');
  }
  content+=allocationPanel(c);
  if(editable)content+=section('Avançar Recebimento')+
     note('Antes de concluir, é necessário salvar volumes, registrar 10%, endereçar a bag na QA e endereçar todo o saldo físico. O WMS conferirá cada regra.')+
     button('Concluir recebimento físico','completePhysical','button full');
  return tab('Recebimento físico','Dados sincronizados com o servidor',content);
}
function allocationPanel(c){
  const sector=String(c.current_sector||'');
  let allowed=sector==='RECEBIMENTO'?['RM','QA','PR']:sector==='PROCESSAMENTO'?['ET']:sector==='ETIQUETAGEM'?['EC']:[];
  if(!allowed.length)return '';
  if(!roleCan(sector.toLowerCase()))return '';
  if(sector==='RECEBIMENTO'&&role()!=='recebimento')return '';
  if(sector==='PROCESSAMENTO'&&role()!=='processamento')return '';
  if(sector==='ETIQUETAGEM'&&role()!=='etiquetagem')return '';
  const zone=s.allocZone&&allowed.includes(s.allocZone)?s.allocZone:allowed[0];
  const option=allowed.map(x=>'<option value="'+x+'" '+(x===zone?'selected':'')+'>'+x+'</option>').join('');
  const positions=s.allocPositions&&s.allocZone===zone?s.allocPositions:[];
  const options=positions.map(p=>'<option value="'+esc(p.address)+'">'+esc(p.address)+'</option>').join('');
  const isGlobal=allowed.includes('RM');
  const isQA=zone==='QA' && isGlobal && String(c.receiving?.receiving_type||'')==='NOVA';
  const kindSelect=isQA?'<label class="field"><span>Tipo de alocação</span><select id="allocPurpose"><option value="STOCK">Saldo principal</option><option value="TEN_PERCENT_SAMPLE">Bag dos 10% (1 volume)</option></select></label>':'';
  const isRm=zone==='RM';
  const items=Array.isArray(c.items)?c.items:[];
  const itemOptions='<option value="">Selecione a referência / cor / tamanho</option>'+items.map(i=>
      '<option value="'+i.id+'">'+esc((i.reference||i.product||'Sem referência')+' • '+(i.color||'-')+' / '+(i.size||'-'))+'</option>').join('');
  const showItems=!isRm;
  const boxCount=zone==='ET'||zone==='EC';
  return section('Endereçamento WMS')+
    note('Os endereços e saldos são validados globalmente no backend. QA/PR/ET/EC exigem item; RM e a bag de 10% usam volumes sem seleção de grade.')+
    '<label class="field"><span>Área física</span><select id="allocZone">'+option+'</select></label>'+
    kindSelect+
    (positions.length?'<label class="field"><span>Posição cadastrada</span><select id="allocAddress">'+options+'</select></label>':
      button('Carregar posições de '+zone,'loadAlloc','button light full'))+
    (showItems?'<label class="field"><span>Referência / cor / tamanho (não se aplica à bag)</span><select id="allocItem">'+itemOptions+'</select></label>':'')+
    '<div class="grid-two">'+input('allocQuantity',boxCount?'Peças':'Volumes','','number','min="1"')+
    (boxCount?input('allocBoxes','Caixas pretas','','number','min="1"'):'')+'</div>'+
    button('✓ Registrar endereço no WMS','allocate','button full');
}
function qualityPanel(c){
  const quality=c.quality;
  const can=role()==='qualidade';
  if(!can)return operationUnavailable('qualidade');
  if(!quality||!quality.id){
    const type=String(c.receiving_type||'').toUpperCase()==='RETORNO'?2:1;
    const fields=section('Criar inspeção '+type)+
      '<p class="muted t-sm">A conferência usa a amostra, a etapa e as validações reais do backend.</p>'+
      (type===1?'<label class="field"><span>Destino da Inspeção 1</span><select id="qaDestination"><option value="">Selecionar</option><option value="CD01">CD01</option><option value="CD02">CD02</option></select></label>'+
      '<label class="field"><span>Vai para a Costura?</span><select id="qaSewing"><option value="">Obrigatório</option><option value="yes">Sim</option><option value="no">Não</option></select></label>':'')+
      '<label class="field"><span>Separar peças para Desenvolvimento?</span><select id="qaDevelopment"><option value="">Obrigatório</option><option value="yes">Sim</option><option value="no">Não</option></select></label>'+
      '<label class="field"><span>Peças de Desenvolvimento já separadas?</span><select id="qaSeparated"><option value="">Selecione</option><option value="yes">Sim</option><option value="no">Não</option></select></label>'+
      '<div class="actions">'+button('Criar inspeção','qualityCreate','button')+
      (type===2?button('Transferir Inspeção 2 ao Processamento','qualityTransfer','button light'):'')+'</div>';
    return tab('Qualidade','A operação será validada pelo servidor',fields);
  }
  let body=infoRow('Inspeção',quality.inspection_type)+infoRow('Status',quality.status)+
    infoRow('Amostra',number(quality.totals?.sample_target||0))+
    infoRow('Atribuída',number(quality.totals?.assigned||0))+
    infoRow('Inspecionada',number(quality.totals?.inspected||0));
  const samples=quality.sample_items||[];
  if(quality.status==='ABERTA'&&samples.some(x=>Number(x.available_qty||0)>0)){
    body+=section('Assumir amostra')+note('Preencha a quantidade desejada de cada linha. O servidor impede atribuir acima do saldo disponível.')+
      samples.filter(x=>Number(x.available_qty||0)>0).map(row=>
        '<div class="line-row"><div class="inline"><div><b>'+esc(row.reference||row.product||'Amostra')+'</b><small>'+esc(row.color||'')+' '+esc(row.size||'')+' · Disponível '+number(row.available_qty)+'</small></div>'+
        '<input id="qaAssign'+row.id+'" type="number" min="0" max="'+Number(row.available_qty)+'" value="0"></div></div>').join('')+
      button('Assumir seleção','qualityAssign','button full');
  }
  const workers=(quality.workers||[]).filter(w=>Number(w.inspector_id)===Number(s.user.id));
  for(const worker of workers){
    body+=section('Minhas atribuições · '+(worker.inspector_name||'Qualidade'))+
      infoRow('Cronômetro',worker.timer?.state||worker.status);
    const ts=worker.timer?.state;
    if(quality.status==='ABERTA'){
      body+='<div class="actions">'+
        (ts==='NAO_INICIADA'?button('Iniciar','qualityTimer-start','button small'):'')+
        (ts==='EM_ANDAMENTO'?button('Pausar','qualityTimer-pause','button light small')+button('Finalizar','qualityTimer-finish','button small'):'')+
        (ts==='PAUSADA'?button('Retomar','qualityTimer-resume','button small')+button('Finalizar','qualityTimer-finish','button light small'):'')+'</div>';
    }
    if(worker.assignments?.length){
      body+=worker.assignments.map(a=>'<div class="line-row"><b>'+esc(a.reference||a.product||'Item')+'</b>'+
        '<small>'+esc(a.color||'')+' '+esc(a.size||'')+' · Atribuído: '+number(a.assigned_qty||0)+'</small>'+
        '<div class="grid-two">'+input('qaInspected'+a.id,'Inspecionada',a.inspected_qty||0,'number','min="0"')+
        input('qaRejected'+a.id,'Rejeitada',a.rejected_qty||0,'number','min="0"')+
        input('qaRework'+a.id,'Retrabalho',a.rework_qty||0,'number','min="0"')+'</div>'+
        input('qaRejectNote'+a.id,'Motivo rejeição',a.reject_reason||'')+
        input('qaReworkNote'+a.id,'Motivo retrabalho',a.rework_reason||'')+'</div>').join('')+
        (quality.status==='ABERTA'?button('Salvar resultados de inspeção','qualityResults','button full'):'');
    }
  }
  if(quality.status==='ABERTA'){
    const validation=(quality.validation_errors||[]).slice(0,6);
    if(validation.length)body+=note('Aguardando requisitos: '+validation.join(' · '),'warn');
    body+=button('Concluir inspeção','qualityComplete','button full',quality.completion_ready?'':'disabled');
  }
  return tab('Qualidade · Inspeção '+quality.inspection_type,'Operações somente do setor responsável',body);
}
function processingPanel(c){
  if(role()!=='processamento')return operationUnavailable('processamento');
  const tri=s.triage;
  let body='';
  if(c.status==='AGUARDANDO_ENTRADA'){
    return tab('Entrada do Processamento',null,entryPanel());
  }
  if(!tri){
    body+=note('Este Card está no Processamento. A triagem é o primeiro procedimento e define a necessidade de etiquetagem.')+
      button('Iniciar Triagem','triageStart','button full');
    return tab('Triagem',null,body);
  }
  const detail=tri.details||tri;
  const items=detail.items?.length?detail.items:(c.items||[]).map(i=>({item_id:i.id,reference:i.reference,color:i.color,size:i.size}));
  body+=infoRow('Status',tri.status||detail.status)+infoRow('Operador',tri.user_name||'—')+
     note('Conferência cega: as quantidades previstas não aparecem na triagem. O resultado é enviado ao WMS para comparar.')+
     section('Contar por cor e tamanho')+
     items.map(i=>'<div class="line-row"><div class="inline"><div><b>'+esc(i.reference||'Item')+'</b><small>'+esc(i.color||'')+' · '+esc(i.size||'')+'</small></div>'+
       '<input type="number" id="triCount'+i.item_id+'" min="0" placeholder="Contado" inputmode="numeric"></div></div>').join('');
  if(tri.status!=='CONCLUIDA'){
    body+='<label class="field"><span>Precisa etiquetar?</span><select id="needsLabeling"><option value="">Selecione</option><option value="yes">Sim, enviar para Etiquetagem</option><option value="no">Não, enviar para Estocagem</option></select></label>';
    body+='<div class="actions">'+
      (tri.status==='EM_ANDAMENTO'?button('Pausar','triage-pause','button light small'):'')+
      (tri.status==='PAUSADA'?button('Retomar','triage-resume','button small'):'')+
      button('Concluir triagem','triage-finish','button')+'</div>';
    body+=allocationPanel(c);
  }else{
    body+=note('Triagem concluída. O Card foi encaminhado automaticamente pelo servidor.');
  }
  return tab('Processamento • Triagem','Cronômetro e contagem reais do WMS',body);
}

function cadastroPanel(c){
  const tasks=Array.isArray(s.cadastro)?s.cadastro:[];
  const canOperate=role()==='processamento';
  const head=note('Cadastro por referência, liberado após a Triagem. Cada ação é registrada no DISTRILOG Web e no Supabase.');
  if(!tasks.length)return tab('Cadastro de referências',null,head+
    note('Este Card ainda não possui tarefas de Cadastro disponíveis. A Triagem precisa estar concluída.','warn'));
  let body=head;
  for(const t of tasks){
    const stat=String(t.status||'PENDENTE');
    const taskId=Number(t.id);
    const myTask=!t.user_id||Number(t.user_id)===Number(s.user.id);
    body+='<div class="line-row"><b>'+esc(t.reference||c.purchase_id)+'</b>'+
      '<small>'+esc(stat)+' • '+number(t.reference_qty||0)+' peças • '+esc(t.user_name||'Não atribuído')+'</small>'+
      '<div class="actions">'+(canOperate&&myTask?(
        (stat==='PENDENTE'?button('▶ Iniciar','cadastro-start','button small','data-task="'+taskId+'"'):'')+
        (stat==='EM_ANDAMENTO'?button('⏸ Pausar','cadastro-pause','button light small','data-task="'+taskId+'"'):'')+
        (stat==='PAUSADA'?button('▶ Retomar','cadastro-resume','button small','data-task="'+taskId+'"'):'')+
        (['EM_ANDAMENTO','PAUSADA'].includes(stat)?button('✓ Concluir','cadastro-finish','button small','data-task="'+taskId+'"'):'')+
        (stat==='CONCLUIDO'&&c.current_sector==='ETIQUETAGEM'&&!t.labels_ready?button('Liberar etiquetas','cadastro-labels','button light small','data-task="'+taskId+'"'):'')
      ):'')+'</div></div>';
  }
  return tab('Cadastro de referências','Tarefas sincronizadas com o servidor',body);
}
function entryPanel(){
  const e=s.entry;
  if(!e)return note('Aguardando dados da Entrada do Processamento. Atualize a fila de Entrada.', 'warn');
  const items=e.items||[];
  return section('Entrada após Estocagem')+infoRow('Status',e.status)+
    items.map(i=>'<div class="line-row"><b>'+esc(i.reference||'Referência')+'</b><small>'+esc(i.color||'')+' · '+esc(i.size||'')+' · '+number(i.stored_qty)+' peças na Entrada</small></div>').join('')+
    textarea('entryNotes','Observações','')+
    '<label class="checkbox-row"><input type="checkbox" id="confirmEntry">Conferi todas as linhas e concordo com os saldos registrados.</label>'+
    (role()==='processamento'&&e.status==='PENDENTE'?button('Confirmar Entrada','entryConfirm','button full'):'');
}
function downstreamPanel(c){
  const isLabel=c.current_sector==='ETIQUETAGEM';
  const op=isLabel?c.labeling:c.storage;
  const permission=role()===(isLabel?'etiquetagem':'estocagem');
  if(!permission)return operationUnavailable(isLabel?'etiquetagem':'estocagem');
  if(!op||!op.id){
    const needsType=isLabel?'<label class="field"><span>Tipo de etiquetagem</span><select id="labelType">'+
      '<option value="">Selecione</option><option value="APENAS_BRANCA">Apenas branca</option>'+
      '<option value="APENAS_VERMELHA">Apenas vermelha</option><option value="TAG_BRANCA">Tag branca</option>'+
      '<option value="BRANCA_VERMELHA">Branca e vermelha</option></select></label>':'';
    return tab(isLabel?'Etiquetagem':'Estocagem','Criar controle do setor',needsType+
      button('Iniciar controle','downstreamCreate','button full'));
  }
  let body=infoRow('Status',op.status)+infoRow('Operador',s.user.name);
  const mine=(op.assignments||[]).filter(x=>Number(x.worker_user_id)===Number(s.user.id)&&!['LIBERADA','CONCLUIDA'].includes(x.status));
  if(op.status==='ABERTO'&&op.has_unassigned_pending)
    body+=button('Assumir Card completo','downstreamClaim','button full');
  if(mine.length){
    body+=section('Minha execução')+
      mine.map(a=>'<div class="line-row"><b>'+esc(a.reference||a.product||'Grade do Card')+'</b>'+
        '<small>'+esc(a.color||'')+' '+esc(a.size||'')+' • '+esc(a.timer_state||'')+'</small>'+
        input('downstreamDone'+a.id,'Quantidade executada',a.completed_qty??'', 'number','min="0"')+'</div>').join('')+
      button('Salvar quantidades executadas','downstreamResults','button full');
    if(op.status==='ABERTO'){
      const states=new Set(mine.map(a=>a.timer_state));
      body+='<div class="actions">'+(states.has('EM_ANDAMENTO')?button('Pausar','downstream-pause','button light small'):'')+
         (states.has('PAUSADA')?button('Retomar','downstream-resume','button small'):'')+'</div>';
    }
  }
  if(op.status==='ABERTO'){
    body+=section(isLabel?'Conferência de Etiquetagem':'Conferência cega da Estocagem')+
      note('Informe a contagem física de todas as linhas. O backend verifica divergências e pode exigir recontagem.')+
      (c.items||[]).map(i=>'<div class="line-row"><div class="inline"><div><b>'+esc(i.reference||i.product||'Item')+'</b>'+
      '<small>'+esc(i.color||'')+' '+esc(i.size||'')+'</small></div>'+
      '<input type="number" id="checkQty'+i.id+'" placeholder="Contado" min="0"></div></div>').join('')+
      button(isLabel?'Conferir Etiquetagem':'Conferir Estocagem','downstreamCheck','button full');
    if(isLabel)body+=allocationPanel(c);
    body+=section('Finalização')+button('Concluir setor','downstreamComplete','button full');
  }
  return tab(isLabel?'Etiquetagem':'Estocagem','Execução sincronizada com o WMS',body);
}

async function loadQueue(){
  s.cards=[];s.selected=null;s.entry=null;s.cadastro=null;
  const sector=s.sector;
  if(sector==='entry'){
    const response=await API.get('/api/processing/entry/queue?user_id='+q(s.user.id));
    s.cards=(response.pending||[]).map(entry=>({
      id:entry.card_id,card_id:entry.card_id,purchase_id:entry.purchase_id,reference_list:entry.purchase_id,
      supplier:entry.supplier,brand:entry.brand,status:'AGUARDANDO_ENTRADA',status_label:'Entrada pendente',
      current_sector:'PROCESSAMENTO',item_count:(entry.items||[]).length,expected_total:0
    }));
  }else if(sector==='cadastro'){
    const response=await API.get('/api/processing/cadastro/queue?user_id='+q(s.user.id));
    s.cards=(response||[]).map(x=>({
      id:x.card_id,card_id:x.card_id,purchase_id:x.purchase_id,
      reference_list:x.reference,supplier:x.supplier,brand:'',
      status:x.status,status_label:'Cadastro: '+x.status,
      current_sector:x.card_current_sector,item_count:0,expected_total:x.reference_qty,
      cadastroTaskId:x.id
    }));
  }else if(sector==='costura'){
    const [receiving,outside]=await Promise.all([API.get('/api/cards?scope=receiving'),API.get('/api/cards?scope=outside')]);
    const seen=new Set();
    s.cards=[...(receiving||[]),...(outside||[])].filter(c=>{
      const valid=c.status==='AGUARDANDO_DESPACHO_COSTURA'||c.status==='EM_COSTURA_CD01'||c.status==='DESPACHO_CD02';
      if(!valid||seen.has(c.id))return false;seen.add(c.id);return true;
    });
  }else if(sector==='processing'){
    const cards=await API.get('/api/cards?scope=processing');
    s.cards=Array.isArray(cards)?cards:[];
  }else{
    const cards=await API.get('/api/cards?scope='+q(sectorScope(sector)));
    s.cards=Array.isArray(cards)?cards:[];
  }
  s.screen='queue';render();window.scrollTo(0,0);
}
async function loadCard(id){
  if(!Number.isSafeInteger(Number(id))||Number(id)<=0)throw Error('Card inválido.');
  s.selected=Number(id);s.card=null;s.trail=[];s.triage=null;s.entry=null;s.cadastro=null;
  s.allocZone=null;s.allocPositions=[];
  const [data,trail]=await Promise.all([
    API.get('/api/cards/'+q(id)),
    API.get('/api/positions/cards/'+q(id)+'/trail').catch(()=>[])
  ]);
  s.card=data;s.trail=Array.isArray(trail)?trail:[];
  if(data.current_sector==='PROCESSAMENTO'&&data.status!=='AGUARDANDO_ENTRADA'){
    try{
      const queue=await API.get('/api/processing/triage/queue?user_id='+q(s.user.id));
      const found=(queue||[]).find(x=>Number(x.id)===Number(id));
      if(found?.triage?.id){
        s.triage=found.triage;
        s.triage.details=await API.get('/api/processing/triage/'+q(found.triage.id)+'/details?user_id='+q(s.user.id));
      }
    }catch(e){console.warn('Triagem indisponível:',e.message);}
  }
  if(data.status==='AGUARDANDO_ENTRADA'){
    try{
      const list=await API.get('/api/processing/entry/queue?user_id='+q(s.user.id));
      s.entry=(list.pending||[]).find(x=>Number(x.card_id)===Number(id))||null;
    }catch(e){console.warn('Entrada indisponível:',e.message)}
  }
  if(s.sector==='cadastro'){
    try{
      const tasks=await API.get('/api/processing/cadastro/queue?user_id='+q(s.user.id));
      s.cadastro=(tasks||[]).filter(x=>Number(x.card_id)===Number(id));
    }catch(e){console.warn('Cadastro indisponível:',e.message)}
  }
  s.screen='card';render();window.scrollTo(0,0);
}
async function refresh(){
  if(s.screen==='card'&&s.selected)return loadCard(s.selected);
  if(s.screen==='address')return loadAddresses(s.selectedArea);
  if(s.screen==='history'){s.history=await API.get('/api/history?limit=100');render();return;}
  if(s.screen==='queue')return loadQueue();
  if(s.screen==='scan'){render();return;}
  s.dashboard=await API.get('/api/dashboard');render();
}
async function loadAddresses(area){
  if(!ALLOC_SECTORS.includes(area))throw Error('Setor inválido.');
  const data=await API.get('/api/positions?setor='+q(area));
  if(!Array.isArray(data))throw Error('O WMS não retornou uma lista de posições válida.');
  s.positions=data;s.selectedArea=area;s.inventory=null;s.screen='address';render();
}
async function loadInventory(address){
  s.address=String(address||'').trim().toUpperCase();
  if(!/^\d+(RM|QA|PR)\d{2}[A-Z]$|^\d+(ET|EC)\d{2}$/.test(s.address))throw Error('Endereço inválido.');
  s.inventory=await API.get('/api/positions/'+q(s.address)+'/inventory');
  s.screen='address';render();
}
async function loadAlloc(zone){
  if(!ALLOC_SECTORS.includes(zone))throw Error('Zona inválida.');
  const response=await API.get('/api/positions?setor='+q(zone));
  if(!Array.isArray(response))throw Error('Não foi possível carregar os endereços cadastrados.');
  s.allocPositions=response;s.allocZone=zone;render();
}
async function loadHistory(){
  const events=await API.get('/api/history?limit=100');
  s.history=Array.isArray(events)?events:[];s.screen='history';render();
}
async function resolveCode(code){
  const codeValue=String(code||'').trim();
  if(!codeValue)throw Error('Leia ou informe o código da Rack.');
  if(codeValue.length>160)throw Error('Código maior que o esperado.');
  s.scanValue=codeValue;
  const matched=codeValue.match(/^(?:RACK[-\s]*|CARD[-\s#]*|#)?(\d{1,9})$/i);
  if(matched){
    await loadCard(Number(matched[1]));
    return;
  }
  // Real address QR: look up the precise WMS position, do not simulate a stock move.
  const address=codeValue.toUpperCase();
  if(/^\d+(RM|QA|PR)\d{2}[A-C]$|^\d+(ET|EC)\d{2}$/.test(address)){
    const area=address.match(/(RM|QA|PR|ET|EC)/)[0];
    await loadAddresses(area);
    await loadInventory(address);
    return;
  }
  // Reference / SKU: discover matching real cards across the operational sectors.
  const scopes=['receiving','quality','processing','labeling','storage'];
  const lists=await Promise.allSettled(scopes.map(scope=>API.get('/api/cards?scope='+q(scope)+'&search='+q(codeValue))));
  const all=new Map();const shown=new Set();
  lists.forEach((result,i)=>{
    if(result.status!=='fulfilled'||!Array.isArray(result.value))return;
    shown.add(scopes[i]);
    result.value.forEach(card=>all.set(card.id,card));
  });
  if(shown.size===0)throw Error('O WMS não respondeu à pesquisa. Verifique sua internet.');
  const matches=[...all.values()];
  if(matches.length===1){await loadCard(matches[0].id);return;}
  s.cards=matches;s.search='';s.sector=shown.values().next().value||'receiving';
  s.screen='queue';render();
  flash(matches.length?'Selecione o Card encontrado.':'Nenhuma referência encontrada no WMS.',!matches.length);
}
function requireSector(expected){
  if(!s.card)throw Error('Selecione um Card.');
  if(role()!==expected)throw Error('Seu perfil não pode executar essa operação.');
  if(String(s.card.current_sector||'').toLowerCase()!==expected)throw Error('O Card pertence a outro setor. Atualize.');
}
function confirmReal(label){
  return window.confirm(label+'\n\nA operação será registrada no DISTRILOG Web. Continuar?');
}
async function mutate(path,payload,method='POST'){
  if(!confirmReal('Confirmar operação real?'))return null;
  const out=method==='PATCH'?await API.patch(path,payload):await API.post(path,payload);
  if(out?.ok===false)throw Error(out.detail||'O backend solicitou revisão. Nenhuma conclusão foi confirmada.');
  await loadCard(s.selected);
  flash('Operação confirmada e sincronizada com o DISTRILOG Web.');
  return out;
}
async function runAction(action,buttonElement){
  if(s.busy)return;
  if(action==='configure'){
    const endpoint=required('server','o endereço HTTPS do Render');
    if(!API.configure(endpoint))throw Error('Informe um endereço HTTPS público válido, sem caminho e sem parâmetros.');
    localStorage.removeItem(KEY);s.user=null;s.screen='login';render();return;
  }
  if(action==='login'){
    const username=required('username','o usuário');
    const password=required('password','a senha');
    const user=await API.post('/api/login',{username,password});
    s.user=user;
    if(user.must_change_password){s.firstPassword={username,password};s.screen='change-password';render();return;}
    localStorage.setItem(KEY,JSON.stringify({id:user.id,name:user.name,role:user.role,username:user.username,language:user.language}));
    s.sector=SECTORS.find(x=>x.role===role())?.id||'receiving';s.search='';await loadQueue();return;
  }
  if(action==='changePassword'){
    if(!s.firstPassword)throw Error('Entre novamente para atualizar sua senha.');
    const next=required('newPassword','a nova senha');
    if(next!==val('confirmPassword'))throw Error('As senhas informadas não coincidem.');
    await API.post('/api/auth/change-password',{
      username:s.firstPassword.username,current_password:s.firstPassword.password,new_password:next
    });
    s.firstPassword=null;s.user=null;s.screen='login';render();flash('Senha atualizada. Entre novamente.');return;
  }
  if(action==='resetConnection'){
    if(!confirmReal('Alterar a conexão? Você precisará entrar novamente.'))return;
    localStorage.removeItem(KEY);s.firstPassword=null;s.user=null;s.screen='setup';render();return;
  }
  if(action==='logout'){
    if(!confirmReal('Deseja sair da sua conta?'))return;
    try{await API.post('/api/auth/logout',{});}finally{
      s.user=null;localStorage.removeItem(KEY);s.card=null;s.screen='login';render();
    }
    return;
  }
  if(action==='language'){
    const lang=val('language');
    if(!['es','pt-BR'].includes(lang))throw Error('Idioma inválido.');
    const response=await API.patch('/api/account/language',{language:lang});
    s.user.language=response.language;localStorage.setItem(KEY,JSON.stringify(s.user));render();
    flash('Idioma salvo no seu perfil do DISTRILOG.');return;
  }
  if(action==='nav'){
    const dest=buttonElement.dataset.to;
    if(dest==='queue')await loadQueue();
    else if(dest==='address')await loadAddresses(s.selectedArea);
    else if(dest==='history')await loadHistory();
    else if(dest==='scan'){s.screen='scan';render();}
    else if(dest==='settings'){s.screen='settings';render();}
    return;
  }
  if(action==='sector'){
    s.sector=buttonElement.dataset.to;s.search='';await loadQueue();return;
  }
  if(action==='refresh'){await refresh();flash('Dados atualizados no WMS.');return;}
  if(action==='card'){await loadCard(Number(buttonElement.dataset.id));return;}
  if(action==='backQueue'){await loadQueue();return;}
  if(action==='scanNative'){API.scan();return;}
  if(action==='resolveScan'){await resolveCode(val('scanManual'));return;}
  if(action==='area'){await loadAddresses(buttonElement.dataset.to);return;}
  if(action==='inventory'){await loadInventory(buttonElement.dataset.address);return;}
  if(action==='openAddress'){s.screen='address';await loadAddresses(String(buttonElement.dataset.address).match(/(RM|QA|PR|ET|EC)/)?.[0]||'RM');await loadInventory(buttonElement.dataset.address);return;}
  if(action==='closeInventory'){s.inventory=null;render();return;}
  if(action==='loadAlloc'){await loadAlloc(val('allocZone'));return;}
  const c=s.card;
  if(!c)throw Error('Nenhum Card selecionado.');
  const id=Number(c.id);
  if(action==='markArrived'){
    requireSector('recebimento');
    await mutate('/api/cards/'+id+'/mark-arrived',userBody());return;
  }
  if(action==='saveReceiving'){
    requireSector('recebimento');
    if(!c.receiving?.id)throw Error('O Card não possui recebimento aberto.');
    const damage=val('hasDamage');
    if(!['yes','no'].includes(damage))throw Error('Indique se há avarias.');
    const payload=userBody({
      volumes:intField('volumes'),received_qty:intField('receivedQty',true),
      has_damage:damage==='yes',damage_description:val('damageDescription').trim(),
      notes:val('receivingNotes').trim()
    });
    if(damage==='yes'&&!payload.damage_description)throw Error('Descreva as avarias.');
    if(String(c.receiving?.receiving_type).toUpperCase()!=='RETORNO'){
      payload.ten_percent_actual=nullableInt('sampleActual');
    }
    await mutate('/api/receivings/'+c.receiving.id,payload,'PATCH');return;
  }
  if(action.startsWith('sample-')){
    requireSector('recebimento');
    const op=action.slice(7);
    if(!['start','pause','resume','finish'].includes(op))throw Error('Ação de tiragem desconhecida.');
    await mutate('/api/receivings/'+c.receiving.id+'/timer/'+op,userBody());return;
  }
  if(action==='saveAfterVolumes'){
    requireSector('recebimento');
    await mutate('/api/receivings/'+c.receiving.id+'/volumes-after-sample',userBody({volumes:intField('afterVolumes')}));return;
  }
  if(action==='completePhysical'){
    requireSector('recebimento');
    await mutate('/api/receivings/'+c.receiving.id+'/physical-complete',userBody());return;
  }
  if(action==='dispatch'){
    requireSector('recebimento');
    await mutate('/api/cards/'+id+'/dispatch',userBody({
      carrier:required('carrier','a transportadora'),seamstress_name:required('seamstress','o costureiro(a)'),
      dispatched_qty:intField('dispatchQty'),volumes:intField('dispatchVolumes'),
      notes:val('dispatchNotes').trim()
    }));return;
  }
  if(action==='allocate'){
    if(!['recebimento','processamento','etiquetagem'].includes(role()))throw Error('Setor sem permissão para alocar.');
    requireSector(role());
    const zone=val('allocZone');
    if(!ALLOC_SECTORS.includes(zone))throw Error('Setor WMS inválido.');
    const address=required('allocAddress','um endereço físico cadastrado');
    if(!s.allocPositions?.some(p=>p.address===address))throw Error('Carregue e selecione uma posição real.');
    const quantity=intField('allocQuantity');
    const purpose=val('allocPurpose')==='TEN_PERCENT_SAMPLE'?'TEN_PERCENT_SAMPLE':'STOCK';
    const sample=zone==='QA' && purpose==='TEN_PERCENT_SAMPLE';
    const itemId=(zone==='RM'||sample)?null:Number(val('allocItem'));
    if(itemId!==null&&(!Number.isSafeInteger(itemId)||!c.items.some(i=>Number(i.id)===itemId)))
      throw Error('Selecione uma linha de referência válida antes de alocar.');
    const allocation={address,quantidade:quantity};
    if(itemId!==null)allocation.item_id=itemId;
    if(zone==='ET'||zone==='EC')allocation.box_count=intField('allocBoxes');
    const payload=userBody({setor:zone,allocations:[allocation],allocation_purpose:sample?'TEN_PERCENT_SAMPLE':'STOCK'});
    if(c.receiving?.id&&role()==='recebimento')payload.receiving_id=c.receiving.id;
    await mutate('/api/positions/cards/'+id+'/allocate',payload);return;
  }
  if(action==='qualityCreate'){
    requireSector('qualidade');
    const type=String(c.receiving_type||'').toUpperCase()==='RETORNO'?2:1;
    const dev=val('qaDevelopment');
    if(!['yes','no'].includes(dev))throw Error('Responda se haverá separação para Desenvolvimento.');
    if(dev==='yes'&&!['yes','no'].includes(val('qaSeparated')))throw Error('Informe se Desenvolvimento já foi separado.');
    const payload=userBody({inspection_type:type,development_required:dev==='yes',
      development_separated:dev==='yes'?val('qaSeparated')==='yes':null});
    if(type===1){
      payload.destination=required('qaDestination','o destino CD01/CD02');
      const sewing=val('qaSewing');
      if(!['yes','no'].includes(sewing))throw Error('Responda se vai para a Costura.');
      payload.send_to_costura=sewing==='yes';
    }
    await mutate('/api/cards/'+id+'/quality/inspections',payload);return;
  }
  if(action==='qualityTransfer'){
    requireSector('qualidade');
    if(String(c.receiving_type).toUpperCase()!=='RETORNO')throw Error('Transferência permitida somente após retorno da Costura.');
    await mutate('/api/cards/'+id+'/quality/transfer-processing',userBody());return;
  }
  if(action==='qualityAssign'){
    requireSector('qualidade');
    const assignment=(c.quality?.sample_items||[]).filter(x=>Number(x.available_qty||0)>0).map(x=>({
      sample_item_id:Number(x.id),assigned_qty:Number(val('qaAssign'+x.id)||0)
    })).filter(x=>x.assigned_qty>0);
    if(!assignment.length)throw Error('Informe quantidades para assumir.');
    for(const x of assignment){const orig=c.quality.sample_items.find(i=>Number(i.id)===x.sample_item_id);
      if(!Number.isSafeInteger(x.assigned_qty)||x.assigned_qty>Number(orig.available_qty))throw Error('Quantidade atribuída excede o disponível.');
    }
    await mutate('/api/quality/inspections/'+c.quality.id+'/assignments/batch',
      userBody({inspector_id:Number(s.user.id),assignments:assignment}));return;
  }
  if(action.startsWith('qualityTimer-')){
    requireSector('qualidade');
    const work=(c.quality?.workers||[]).find(w=>Number(w.inspector_id)===Number(s.user.id));
    if(!work)throw Error('Você não possui atribuição nesta inspeção.');
    await mutate('/api/quality/workers/'+work.id+'/timer/'+action.split('-')[1],userBody());return;
  }
  if(action==='qualityResults'){
    requireSector('qualidade');
    const work=(c.quality?.workers||[]).find(w=>Number(w.inspector_id)===Number(s.user.id));
    if(!work)throw Error('Você não possui atribuição nesta inspeção.');
    const results=(work.assignments||[]).map(a=>{
      const entry={assignment_id:Number(a.id),inspected_qty:intField('qaInspected'+a.id,true),
        rejected_qty:intField('qaRejected'+a.id,true),rework_qty:intField('qaRework'+a.id,true),
        reject_reason:val('qaRejectNote'+a.id).trim(),rework_reason:val('qaReworkNote'+a.id).trim()};
      if(entry.inspected_qty>Number(a.assigned_qty)||entry.rejected_qty+entry.rework_qty>entry.inspected_qty)
        throw Error('Quantidades inválidas na linha '+String(a.reference||a.id));
      if(entry.rejected_qty>0&&!entry.reject_reason)throw Error('Informe o motivo da rejeição.');
      if(entry.rework_qty>0&&!entry.rework_reason)throw Error('Informe o motivo do retrabalho.');
      return entry;
    });
    await mutate('/api/quality/workers/'+work.id+'/results/batch',userBody({results}),'PATCH');return;
  }
  if(action==='qualityComplete'){
    requireSector('qualidade');
    if(!c.quality?.completion_ready)throw Error('A inspeção ainda possui validações pendentes.');
    await mutate('/api/quality/inspections/'+c.quality.id+'/complete',
      userBody({confirm_development_pending:!!c.quality.development_warning}));return;
  }
  if(action==='triageStart'){
    requireSector('processamento');
    await mutate('/api/processing/triage/cards/'+id+'/start',userBody());return;
  }
  if(action.startsWith('triage-')){
    requireSector('processamento');
    if(!s.triage?.id)throw Error('Triagem não encontrada; atualize.');
    const op=action.split('-')[1];
    if(op==='pause'||op==='resume'){
      await mutate('/api/processing/triage/'+s.triage.id+'/'+op,userBody());return;
    }
    if(op==='finish'){
      const answer=val('needsLabeling');
      if(!['yes','no'].includes(answer))throw Error('Informe obrigatoriamente se precisa de Etiquetagem.');
      const items=s.triage.details?.items||[];
      if(!items.length)throw Error('A grade da Triagem não foi carregada. Atualize.');
      const counts=items.map(i=>({item_id:Number(i.item_id),counted_qty:intField('triCount'+i.item_id,true)}));
      await mutate('/api/processing/triage/'+s.triage.id+'/finish',
        userBody({counts,needs_labeling:answer==='yes'}));return;
    }
  }
  if(action==='downstreamCreate'){
    const sector=String(c.current_sector||'').toLowerCase();
    if(!['etiquetagem','estocagem'].includes(sector))throw Error('Setor inválido.');
    requireSector(sector);
    const payload=userBody();
    if(sector==='etiquetagem')payload.labeling_type=required('labelType','o tipo de etiquetagem');
    await mutate('/api/cards/'+id+'/downstream/'+c.current_sector,payload);return;
  }
  if(action==='downstreamClaim'){
    requireSector(String(c.current_sector||'').toLowerCase());
    const op=c.current_sector==='ETIQUETAGEM'?c.labeling:c.storage;
    await mutate('/api/downstream/'+op.id+'/claim-all',userBody({worker_user_id:Number(s.user.id)}));return;
  }
  if(action.startsWith('downstream-')){
    requireSector(String(c.current_sector||'').toLowerCase());
    const op=c.current_sector==='ETIQUETAGEM'?c.labeling:c.storage;
    await mutate('/api/downstream/'+op.id+'/session/'+action.split('-')[1],userBody());return;
  }
  if(action==='downstreamResults'){
    requireSector(String(c.current_sector||'').toLowerCase());
    const op=c.current_sector==='ETIQUETAGEM'?c.labeling:c.storage;
    const mine=(op.assignments||[]).filter(x=>Number(x.worker_user_id)===Number(s.user.id)&&!['LIBERADA','CONCLUIDA'].includes(x.status));
    if(!mine.length)throw Error('Você não possui atribuições em execução.');
    if(!confirmReal('Salvar suas quantidades executadas no WMS?'))return;
    // Each assignment is independently persisted; do not report full success
    // until all responses are acknowledged by the server.
    for(const a of mine)await API.patch('/api/downstream/assignments/'+a.id,
      userBody({completed_qty:intField('downstreamDone'+a.id,true)}));
    await loadCard(id);flash('Apontamentos de execução confirmados no backend.');return;
  }
  if(action==='downstreamCheck'){
    const sector=String(c.current_sector||'').toLowerCase();requireSector(sector);
    const op=sector==='etiquetagem'?c.labeling:c.storage;
    const items=(c.items||[]).map(i=>({item_id:Number(i.id),counted_qty:intField('checkQty'+i.id,true)}));
    if(!items.length)throw Error('Nenhuma linha de conferência encontrada.');
    const endpoint=sector==='etiquetagem'?'labeling-check':'storage-check';
    await mutate('/api/downstream/'+op.id+'/'+endpoint,userBody({items}));return;
  }
  if(action==='downstreamComplete'){
    const sector=String(c.current_sector||'').toLowerCase();requireSector(sector);
    const op=sector==='etiquetagem'?c.labeling:c.storage;
    await mutate('/api/downstream/'+op.id+'/complete',userBody());return;
  }
  if(action.startsWith('cadastro-')){
    if(role()!=='processamento')throw Error('Somente o Processamento executa o Cadastro.');
    const taskId=Number(buttonElement?.dataset.task||0);
    const task=(s.cadastro||[]).find(x=>Number(x.id)===taskId);
    if(!task)throw Error('Tarefa não encontrada no Cadastro deste Card.');
    const cmd=action.slice('cadastro-'.length);
    if(!['start','pause','resume','finish','labels'].includes(cmd))throw Error('Comando de Cadastro inválido.');
    const path=cmd==='labels'
      ? '/api/processing/cadastro/'+taskId+'/labels-ready'
      : '/api/processing/cadastro/'+taskId+'/'+cmd;
    await mutate(path,userBody());return;
  }
  if(action==='entryConfirm'){
    if(role()!=='processamento')throw Error('Confirmação de Entrada reservada ao Processamento.');
    const e=s.entry;
    if(!e||e.status!=='PENDENTE')throw Error('A Entrada não está pendente.');
    if(!checked('confirmEntry'))throw Error('Marque que conferiu fisicamente todas as linhas antes de confirmar.');
    const items=(e.items||[]).map(i=>({id:Number(i.id),stored_qty:Number(i.stored_qty)}));
    await mutate('/api/processing/entry/'+e.id+'/confirm',userBody({items,notes:val('entryNotes').trim()}));return;
  }
  throw Error('Ação indisponível nesta versão do aplicativo.');
}
window.DM_SCAN_RETURN=async function(value){
  const text=String(value||'').trim();
  if(!text){flash('Leitura cancelada.');return;}
  s.scanValue=text;
  if(s.screen==='scan')render();
  await run(()=>resolveCode(text));
};
window.DM_UNAUTHORIZED=function(){
  localStorage.removeItem(KEY);s.user=null;s.card=null;s.firstPassword=null;s.screen='login';render();
  flash('Sessão expirada ou revogada. Entre novamente.',true);
};
window.DM_BACK=function(){
  if(s.screen==='card'){s.screen='queue';render();}
  else if(s.screen==='address'&&s.inventory){s.inventory=null;render();}
  else if(s.screen!=='queue'&&s.user){s.screen='queue';render();}
};
document.addEventListener('click',function(e){
  const btn=e.target.closest('[data-action]');
  if(!btn||btn.disabled)return;
  const action=btn.dataset.action;
  run(()=>runAction(action,btn)).catch(err=>flash(publicError(err),true));
});
document.addEventListener('change',function(e){
  if(e.target?.id==='allocZone'){
    const zone=e.target.value;
    if(ALLOC_SECTORS.includes(zone))run(()=>loadAlloc(zone));
  }
});
document.addEventListener('input',function(e){
  if(e.target.id==='queueSearch'){
    s.search=e.target.value;
    const term=s.search.toLocaleLowerCase();
    let shown=0;
    document.querySelectorAll('#queueItems .queue-card').forEach(node=>{
      const show=(node.dataset.search||'').includes(term);
      node.hidden=!show;if(show)shown++;
    });
    const count=document.getElementById('queueCount');if(count)count.textContent=shown;
  }
  if(e.target.id==='addressSearch'){
    const term=e.target.value.trim().toLowerCase();
    document.querySelectorAll('#addressRows .line-row').forEach(node=>node.hidden=!String(node.dataset.address||'').toLowerCase().includes(term));
  }
});
document.addEventListener('keydown',function(e){
  if(e.key==='Enter'&&e.target.id==='scanManual'){
    e.preventDefault();run(()=>resolveCode(val('scanManual')));
  }
  if(e.key==='Enter'&&e.target.id==='password'){
    e.preventDefault();run(()=>runAction('login',null));
  }
});
async function boot(){
  if(!API.endpoint()){s.screen='setup';render();return;}
  let cached;
  try{cached=JSON.parse(localStorage.getItem(KEY)||'null');}catch{cached=null;}
  if(cached&&cached.id&&cached.role&&cached.username){
    s.user=cached;s.screen='queue';render();
    try{
      await API.get('/api/dashboard');
      s.sector=SECTORS.find(x=>x.role===role())?.id||'receiving';
      await loadQueue();
    }catch(err){
      if(s.user){s.user=null;localStorage.removeItem(KEY);s.screen='login';render();flash('Conexão não validada. Entre novamente.',true);}
    }
  }else{s.screen='login';render();}
}
boot().catch(err=>{s.screen='login';render();flash(publicError(err),true);});
})();
