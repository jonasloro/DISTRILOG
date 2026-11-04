/* Renata Mobile: mesma API e dados do painel Web; sem estado operacional local. */
(function () {
'use strict';
const api = window.DM_API;
const state = {data:null,days:30,fetchedAt:0};
const escape = value => String(value ?? '').replace(/[&<>"']/g,
  ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fmt = value => {
  const s=Math.max(0,Math.floor(Number(value)||0));
  return [Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(v=>String(v).padStart(2,'0')).join(':');
};
const button = (label,action,cls='button full',props='') =>
  '<button type="button" class="'+cls+'" data-action="clean-'+action+'" '+props+'>'+escape(label)+'</button>';
const status = t => t.status==='PAUSADA' ? 'Pausada' : 'Em andamento';
const date = value => {
  if(!value)return '—';
  const t=Date.parse(value);
  return Number.isFinite(t)?new Date(t).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
};
const isOwn = (t,user) => Number(t.user_id) === Number(user.id);

async function load(user){
  if(!Number.isSafeInteger(Number(user?.id)) || Number(user?.id)<=0)
    throw Error('Entre novamente para consultar as limpezas.');
  const data = await api.get('/api/cleaning/overview?user_id='+encodeURIComponent(user.id)+'&days='+state.days);
  if(!data || !Array.isArray(data.areas) || !Array.isArray(data.active) ||
     !Array.isArray(data.by_area) || !Array.isArray(data.recent))
    throw Error('Resposta inválida do controle de limpezas.');
  state.data=data;
  state.fetchedAt=Date.now();
}
function activityClock(t,id) {
  return '<strong class="clean-mobile-clock" id="'+id+'">'+fmt(t.worked_seconds)+'</strong>';
}
function view(user){
  if(!state.data)return '<div class="empty">Abra Renata e atualize para carregar as atividades.</div>';
  const data=state.data,active=data.active,me=active.find(t=>isOwn(t,user));
  const used=new Map(active.map(t=>[t.area,t]));
  const free=data.areas.filter(area=>!used.has(area)).length;
  const running=active.filter(t=>t.status==='EM_ANDAMENTO').length;
  const paused=active.filter(t=>t.status==='PAUSADA').length;
  const period=[7,30,90,0].map(days=>button(days===0?'Tudo':days+' dias','days','clean-mobile-chip '+(state.days===days?'on':''),'data-days="'+days+'"')).join('');

  let focus='';
  if(me){
    focus='<section class="clean-mobile-focus"><div class="clean-mobile-top">'+
      '<span class="eyebrow">MINHA LIMPEZA</span><span class="clean-mobile-tag '+(me.status==='PAUSADA'?'paused':'')+'">'+status(me)+'</span></div>'+
      '<h2>'+escape(me.area)+'</h2><p>Iniciada em '+date(me.started_at)+'</p>'+
      '<small class="clean-mobile-time-label">TEMPO TRABALHADO</small>'+activityClock(me,'cleanMobileClock')+
      '<div class="clean-mobile-pause">Pausas: '+fmt(me.paused_seconds)+'</div>'+
      (me.notes?'<p class="clean-mobile-note">'+escape(me.notes)+'</p>':'')+
      '<div class="clean-mobile-actions">'+
      (me.status==='PAUSADA'?button('▶ Retomar limpeza','resume'):button('Ⅱ Pausar cronômetro','pause','button light full'))+
      button('✓ Concluir limpeza','finish','button full')+'</div>'+
      '<small class="clean-mobile-foot">A tarefa continua salva no servidor mesmo ao fechar o aplicativo.</small></section>';
  }else{
    const areas=data.areas.map(area=>{
      const t=used.get(area),occupied=Boolean(t);
      return '<button type="button" class="clean-mobile-area '+(occupied?'occupied':'available')+
        '" data-area="'+escape(area)+'" data-action="clean-start" '+(occupied?'disabled aria-disabled="true"':'')+'>'+
        '<span class="clean-mobile-area-head"><b>'+escape(area)+'</b><span>'+(occupied?'🔒':'↗')+'</span></span>'+
        '<small>'+(occupied?escape(t.user_name)+' · '+status(t):'● Disponível — iniciar')+'</small></button>';
    }).join('');
    focus='<section class="clean-mobile-start"><div class="section-head"><h2>Escolha uma área</h2><span class="mini">'+free+' livre'+(free===1?'':'s')+'</span></div>'+
      '<p class="muted t-sm">Só é possível assumir uma limpeza por vez. Áreas ocupadas ficam bloqueadas.</p>'+
      '<label class="field"><span>Observação (opcional)</span><input id="cleanMobileNotes" maxlength="120" placeholder="Ex.: limpeza geral ou vidros"></label>'+
      '<div class="clean-mobile-areas">'+areas+'</div></section>';
  }

  const others=active.filter(t=>!isOwn(t,user)).map(t=>
    '<div class="clean-mobile-row"><div><b>'+escape(t.area)+'</b><small>'+escape(t.user_name)+' · '+status(t)+'</small></div>'+
    '<strong class="clean-mobile-live" data-clean-base="'+Number(t.worked_seconds||0)+'" data-clean-running="'+(t.status==='EM_ANDAMENTO'?'1':'0')+'">'+fmt(t.worked_seconds)+'</strong></div>'
  ).join('');
  const stats=data.by_area.slice().sort((a,b)=>Number(b.tasks||0)-Number(a.tasks||0)).map(t=>
    '<div class="clean-mobile-row"><div><b>'+escape(t.area)+'</b><small>'+Number(t.tasks||0)+' limpeza(s) concluída(s)</small></div>'+
    '<span class="clean-mobile-stat">'+(Number(t.tasks||0)?fmt(t.avg_seconds):'—')+'</span></div>'
  ).join('');
  const history=data.recent.slice(0,8).map(t=>
    '<div class="clean-mobile-history"><div><b>'+escape(t.area)+'</b><small>'+escape(t.user_name)+' · '+date(t.finished_at)+'</small></div>'+
    '<strong>'+fmt(t.worked_seconds)+'</strong></div>').join('');

  return '<div class="eyebrow">ROTINA OPERACIONAL · RENATA</div><h1 class="shell-title">Renata</h1>'+
    '<p class="shell-desc">Limpeza por área com cronômetro, histórico e acompanhamento em tempo real.</p>'+
    '<div class="clean-mobile-metrics"><div><strong>'+free+'</strong><small>Disponíveis</small></div>'+
    '<div><strong>'+running+'</strong><small>Em limpeza</small></div>'+
    '<div><strong>'+paused+'</strong><small>Pausadas</small></div></div>'+
    button('↻ Atualizar atividades','refresh','button light full')+
    focus+
    '<section class="clean-mobile-block"><div class="section-head"><h2>Equipe em atividade</h2><span class="mini">'+(active.length-(me?1:0))+'</span></div>'+
      (others||'<div class="empty">Nenhuma outra limpeza em andamento.</div>')+'</section>'+
    '<section class="clean-mobile-block"><div class="section-head"><h2>Indicadores por área</h2></div>'+
      '<div class="clean-mobile-periods">'+period+'</div>'+
      '<p class="muted t-xs">Tempo médio das atividades concluídas.</p>'+stats+'</section>'+
    '<section class="clean-mobile-block"><div class="section-head"><h2>Últimas conclusões</h2></div>'+
      (history||'<div class="empty">Nenhum registro concluído.</div>')+'</section>';
}
function tick(){
  if(!state.data)return;
  const delta=Math.max(0,Math.floor((Date.now()-state.fetchedAt)/1000));
  const me=state.data.active.find(t=>Number(t.user_id)===Number(state.viewerId));
  const clock=document.getElementById('cleanMobileClock');
  if(clock&&me)clock.textContent=fmt(Number(me.worked_seconds||0)+(me.status==='EM_ANDAMENTO'?delta:0));
  document.querySelectorAll('[data-clean-base]').forEach(el=>{
    el.textContent=fmt(Number(el.dataset.cleanBase||0)+(el.dataset.cleanRunning==='1'?delta:0));
  });
}
async function action(name,btn,user){
  if(name==='refresh')return load(user);
  if(name==='days'){
    const days=Number(btn?.dataset?.days);
    if(![0,7,30,90].includes(days))throw Error('Período inválido.');
    state.days=days;
    return load(user);
  }
  const data=state.data;
  if(!data)throw Error('Atualize a fila antes de executar a limpeza.');
  const mine=data.active.find(t=>isOwn(t,user));
  if(name==='start'){
    if(mine)throw Error('Você já possui uma limpeza aberta.');
    const area=String(btn?.dataset?.area||'');
    if(!data.areas.includes(area))throw Error('Área inválida.');
    if(data.active.some(t=>t.area===area))throw Error('Área em uso. Atualize antes de tentar novamente.');
    const notes=String(document.getElementById('cleanMobileNotes')?.value||'').trim();
    if(notes.length>120)throw Error('Observação acima de 120 caracteres.');
    await api.post('/api/cleaning/tasks',{user_id:Number(user.id),area,notes});
  }else if(['pause','resume','finish'].includes(name)){
    if(!mine)throw Error('Você não tem uma limpeza aberta.');
    if(name==='pause'&&mine.status!=='EM_ANDAMENTO')throw Error('Esta limpeza não está em andamento.');
    if(name==='resume'&&mine.status!=='PAUSADA')throw Error('Esta limpeza não está pausada.');
    if(name==='finish'&&!window.confirm('Concluir a limpeza da área '+mine.area+'? O tempo será registrado no DISTRILOG.'))return;
    await api.post('/api/cleaning/tasks/'+Number(mine.id)+'/'+name,{user_id:Number(user.id)});
  }else throw Error('Ação de limpeza inválida.');
  await load(user);
}
async function init(user){state.viewerId=Number(user?.id);return load(user)}
window.DM_CLEANING={init,load,view,action,tick,state};
})();