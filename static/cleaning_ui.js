/* Renata • painel de execução e gestão. Usa exclusivamente /api/cleaning. */
async function renderCleaningPro() {
  setPage("Renata Ingrata", "Rotina de limpeza · execução, disponibilidade e indicadores");
  clearInterval(cleaningTick);
  const data = await api("/api/cleaning/overview?user_id=" + currentUser.id + "&days=" + cleaningDays);
  const active = Array.isArray(data.active) ? data.active : [];
  const areas = Array.isArray(data.areas) ? data.areas : [];
  const stats = Array.isArray(data.by_area) ? data.by_area : [];
  const recent = Array.isArray(data.recent) ? data.recent : [];
  const mine = active.find(t => Number(t.user_id) === Number(currentUser.id));
  const occupied = new Map(active.map(t => [t.area, t]));
  const others = active.filter(t => Number(t.user_id) !== Number(currentUser.id));
  const canDelete = ["admin","supervisor"].includes(currentUser.role);
  const fetchedAt = Date.now();
  const maxAvg = Math.max(1, ...stats.map(t => Number(t.avg_seconds || 0)));
  const when = v => v ? new Date(v).toLocaleString(DISTRILOG_I18N.getLanguage(), {
    day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"
  }) : "—";
  const stateLabel = t => t.status === "PAUSADA" ? "Pausada" : "Em andamento";
  const stateClass = t => t.status === "PAUSADA" ? "paused" : "running";
  const free = Math.max(0,areas.length-occupied.size);
  const running = active.filter(t=>t.status==="EM_ANDAMENTO").length;
  const paused = active.filter(t=>t.status==="PAUSADA").length;
  const totals = data.totals || {};
  const average = Number(totals.avg_seconds || 0);
  const periodOptions = [[7,"7 dias"],[30,"30 dias"],[90,"90 dias"],[0,"Todo o histórico"]]
    .map(([days,label])=>'<option value="'+days+'"'+(Number(cleaningDays)===days?' selected':'')+'>'+label+'</option>').join("");

  const areaTiles = areas.map(area => {
    const task=occupied.get(area),busy=Boolean(task);
    const state=task?stateLabel(task):"Pronta para iniciar";
    const caption=task ? esc(task.user_name)+" · "+esc(state) : "● Disponível agora";
    return '<button class="ren-area '+(busy?'ren-area-busy':'ren-area-free')+'" type="button" '+
      (busy?'disabled aria-disabled="true"':'onclick="startCleaning(this.dataset.area)"')+
      ' data-area="'+esc(area)+'" aria-label="'+esc(area)+': '+caption+'">'+
      '<span class="ren-area-head"><strong>'+esc(area)+'</strong><i aria-hidden="true">'+(busy?'🔒':'↗')+'</i></span>'+
      '<small>'+caption+'</small>'+
      (busy?'<span class="ren-area-owner">Ocupada • não pode ser assumida</span>':
        '<span class="ren-area-cta">Iniciar atividade →</span>')+'</button>';
  }).join("");

  const selfPanel = mine
    ? '<section class="ren-focus" aria-label="Minha limpeza em execução">'+
        '<div class="ren-focus-meta"><span class="ren-label">MINHA ATIVIDADE</span>'+
        '<span class="ren-state '+stateClass(mine)+'">'+stateLabel(mine)+'</span></div>'+
        '<h2>'+esc(mine.area)+'</h2>'+
        '<p>Iniciada em '+when(mine.started_at)+' por '+esc(mine.user_name)+'</p>'+
        '<div class="ren-timer-caption">TEMPO TRABALHADO</div>'+
        '<div class="ren-clock">'+cleaningTimerHtml(mine,fetchedAt)+'</div>'+
        (Number(mine.paused_seconds||0)>0?'<small class="ren-pause-time">'+fmtDurationShort(mine.paused_seconds)+' de pausa registrada</small>':'')+
        (mine.notes?'<div class="ren-notes">Observação: '+esc(mine.notes)+'</div>':'')+
        '<div class="ren-focus-actions">'+cleaningActionButtons(mine)+'</div>'+
        '<p class="ren-hint">O cronômetro e o estado da atividade são registrados no servidor.</p></section>'
    : '<section class="ren-start"><div class="ren-subheading"><div><span class="ren-label">COMEÇAR LIMPEZA</span>'+
        '<h2>Qual área será atendida?</h2><p>Escolha uma das áreas livres. Uma área ocupada permanece bloqueada até a conclusão.</p>'+
        '</div><span class="ren-free-tag">'+free+' livre'+(free===1?'':'s')+'</span></div>'+
        '<label class="ren-note-field" for="cleaningNotes">Observação (opcional)'+
        '<input id="cleaningNotes" maxlength="120" placeholder="Ex.: limpeza geral, vidros, manutenção..."></label>'+
        '<div class="ren-area-grid">'+areaTiles+'</div></section>';

  const activityCards = others.length
    ? others.map(t=>'<article class="ren-current-card"><div class="ren-current-head">'+
        '<strong>'+esc(t.area)+'</strong><span class="ren-state '+stateClass(t)+'">'+stateLabel(t)+'</span></div>'+
        '<span class="ren-operator">'+esc(t.user_name)+'</span>'+
        '<div class="ren-current-time">'+cleaningTimerHtml(t,fetchedAt)+'</div>'+
        '<small>Iniciada em '+when(t.started_at)+'</small></article>').join("")
    : '<div class="ren-empty">Nenhuma outra área em execução.</div>';

  const bars = stats.map(t=>{
    const count=Number(t.tasks||0),avg=Number(t.avg_seconds||0);
    return '<div class="ren-bar-item"><div class="ren-bar-title"><strong>'+esc(t.area)+'</strong>'+
      '<small>'+count+' limpeza'+(count===1?'':'s')+'</small></div>'+
      '<div class="ren-bar-track" role="img" aria-label="'+esc(t.area)+': média '+esc(fmtDurationShort(avg))+'">'+
      '<i style="width:'+(count?Math.max(3,Math.round(100*avg/maxAvg)):0)+'%"></i></div>'+
      '<b>'+ (count?fmtDurationShort(avg):"Sem dados") +'</b></div>';
  }).join("");

  const rows = recent.map(t=>'<tr><td><b>'+esc(t.area)+'</b><small>'+when(t.finished_at)+'</small></td>'+
    '<td>'+esc(t.user_name)+'</td><td><b>'+fmtDurationShort(t.worked_seconds)+'</b></td>'+
    '<td>'+fmtDurationShort(t.paused_seconds)+'</td><td class="ren-history-note">'+esc(t.notes||"—")+'</td>'+
    (canDelete?'<td><button class="secondary small-btn" onclick="deleteCleaning('+Number(t.id)+')">Excluir</button></td>':'')+
    '</tr>').join("");

  $("mainContent").innerHTML =
    '<div class="ren-layout">'+
      '<div class="ren-hero"><div><span class="ren-label">ROTINA OPERACIONAL</span>'+
      '<h2>Limpeza organizada. Tempo registrado.</h2>'+
      '<p>Acompanhe a execução de cada área, sem sobreposição de responsáveis.</p></div>'+
      '<button class="ren-refresh" type="button" onclick="renderCleaning()">↻ Atualizar painel</button></div>'+
      '<div class="ren-stats" aria-label="Resumo da limpeza">'+
        '<div class="ren-stat"><small>Áreas disponíveis</small><strong>'+free+'</strong><span>Prontas para iniciar</span></div>'+
        '<div class="ren-stat"><small>Em execução</small><strong>'+running+'</strong><span>Com cronômetro ativo</span></div>'+
        '<div class="ren-stat"><small>Pausadas</small><strong>'+paused+'</strong><span>Aguardando retomada</span></div>'+
        '<div class="ren-stat"><small>Concluídas no período</small><strong>'+Number(totals.tasks||0)+'</strong>'+
          '<span>Média: '+(Number(totals.tasks||0)?fmtDurationShort(average):'—')+'</span></div>'+
      '</div>'+
      '<div class="ren-main-grid"><div>'+selfPanel+'</div>'+
        '<section class="ren-team"><div class="ren-subheading"><div><span class="ren-label">ACOMPANHAMENTO</span>'+
        '<h2>Outras atividades</h2></div><span class="ren-free-tag neutral">'+others.length+' ativa'+(others.length===1?'':'s')+'</span></div>'+
        '<div class="ren-team-items">'+activityCards+'</div></section></div>'+
      '<section class="ren-data-panel"><div class="ren-subheading"><div><span class="ren-label">INDICADORES</span>'+
        '<h2>Tempo médio por área</h2><p>Dados das limpezas concluídas.</p></div>'+
        '<label class="ren-period">Período <select aria-label="Período dos indicadores" onchange="setCleaningDays(this.value)">'+periodOptions+'</select></label></div>'+
        '<div class="ren-bars">'+bars+'</div></section>'+
      '<section class="ren-data-panel"><div class="ren-subheading"><div><span class="ren-label">HISTÓRICO</span>'+
        '<h2>Últimas limpezas</h2></div><span class="ren-free-tag neutral">'+recent.length+' registros</span></div>'+
        '<div class="table-wrap"><table class="compact-table ren-history"><thead><tr>'+
        '<th>Área / conclusão</th><th>Operador</th><th>Trabalho</th><th>Pausas</th><th>Observação</th>'+
        (canDelete?'<th></th>':'')+'</tr></thead><tbody>'+
        (rows||'<tr><td colspan="'+(canDelete?6:5)+'">Nenhuma limpeza concluída até o momento.</td></tr>')+
        '</tbody></table></div></section></div>';

  if (active.some(t=>t.status==="EM_ANDAMENTO")) {
    cleaningTick=setInterval(()=>{
      document.querySelectorAll("[data-clean-timer]").forEach(el=>{
        if(el.dataset.running!=="1")return;
        const now=Math.max(0,(Date.now()-Number(el.dataset.fetched||Date.now()))/1000);
        el.textContent=fmtSeconds(Number(el.dataset.base||0)+now);
      });
    },1000);
  }
}
