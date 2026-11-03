/* Pedidos de Separação: cronômetro operacional, independente do WMS. */
let separationClock = null;
let separationOrders = [];

function separationMayOperate() {
  return ["admin", "supervisor", "separacao"].includes(currentUser?.role);
}
function separationMayImport() {
  return ["admin", "supervisor", "separacao", "expedicao"].includes(currentUser?.role);
}
function separationStopClock() {
  if (separationClock !== null) window.clearInterval(separationClock);
  separationClock = null;
}
function separationElapsed(row) {
  const start = Date.parse(row.started_at || "");
  const end = Date.parse(row.completed_at || "") || Date.now();
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((row.completed_at ? end : Date.now() - 0 - 0 - 0 - 0) / 1000 - start / 1000));
}
function separationRenderClock() {
  if (currentView !== "separation") { separationStopClock(); return; }
  for (const order of separationOrders) {
    const target = document.getElementById("sepClock" + order.id);
    if (!target) continue;
    const live = ["EM_ANDAMENTO", "PAUSADO"].includes(order.status);
    const gross = live || order.status === "CONCLUIDA" ? separationElapsed(order) : 0;
    const actualPause = Number(order.accumulated_pause_seconds || 0);
    const runningPause = order.status === "PAUSADO" && order.pause_started_at
      ? Math.max(0, Math.floor((Date.now() - Date.parse(order.pause_started_at)) / 1000)) : 0;
    const pause = order.status === "CONCLUIDA" ? Number(order.declared_pause_seconds || 0)
      : actualPause + runningPause;
    target.textContent = fmtSeconds(Math.max(0, gross - pause));
  }
}
function separationFormatStatus(status) {
  return ({
    PENDENTE: "Aguardando início", EM_ANDAMENTO: "Em separação",
    PAUSADO: "Pausado", CONCLUIDA: "Enviado à Expedição",
    SEM_SEPARACAO: "Sem peças elegíveis",
  })[status] || status;
}
async function renderSeparation() {
  separationStopClock();
  setPage("Separação", "Romaneios e cronômetros de pedidos — sem conferência de peças por item");
  const [orders, alerts] = await Promise.all([
    api("/api/separation/orders"), api("/api/separation/entry-alerts"),
  ]);
  if (currentView !== "separation") return;
  separationOrders = orders;
  const pending = orders.filter(o => o.status === "PENDENTE").length;
  const active = orders.filter(o => ["EM_ANDAMENTO", "PAUSADO"].includes(o.status)).length;
  const shipped = orders.filter(o => o.status === "CONCLUIDA").length;
  const total = orders.reduce((sum, o) => sum + Number(o.expected_qty || 0), 0);
  const importHtml = separationMayImport()
    ? `<div class="actions"><input id="separationCsvFile" type="file" accept=".csv,text/csv" class="hidden" onchange="separationImport(this)">
         <button class="primary small-btn" type="button" onclick="document.getElementById('separationCsvFile').click()">Importar relatório CSV</button>
       </div>` : "";
  const alertsHtml = alerts.length
    ? alerts.map(item => `<div class="separation-entry-item">
         <strong>${esc(item.reference)}</strong>
         <span>Entrada realizada há <b>${Math.max(0, Number(item.days_since_entry || 0))} dia(s)</b> · ainda não apareceu em um pedido importado.</span>
       </div>`).join("")
    : '<div class="empty-visual">Nenhuma referência com entrada concluída e sem pedido identificado.</div>';
  $("mainContent").innerHTML = `
    <div class="kpi-grid compact-kpis">
      <div class="kpi"><div class="kpi-label">Aguardando</div><div class="kpi-value">${pending}</div><div class="kpi-hint">Timers pendentes</div></div>
      <div class="kpi"><div class="kpi-label">Em execução</div><div class="kpi-value">${active}</div><div class="kpi-hint">Inclui pausados</div></div>
      <div class="kpi"><div class="kpi-label">Na Expedição</div><div class="kpi-value">${shipped}</div><div class="kpi-hint">Separações concluídas</div></div>
      <div class="kpi"><div class="kpi-label">Peças elegíveis</div><div class="kpi-value">${total.toLocaleString(DISTRILOG_I18N.getLanguage())}</div><div class="kpi-hint">Exclui rua 001- e sem casulo</div></div>
    </div>
    <section class="panel" style="margin-top:16px">
      <div class="panel-header"><span>Pedidos para separação</span>${importHtml}</div>
      <div class="panel-body"><p class="muted">O relatório filtra automaticamente peças sem casulo e da rua 001-. O operador apenas inicia, pausa e finaliza o cronômetro. A Expedição recebe os totais declarados.</p>
        <div class="separation-queue">
        ${orders.map(row => {
          const editable = separationMayOperate() &&
            (!row.operator_id || Number(row.operator_id) === Number(currentUser.id) ||
             ["admin","supervisor"].includes(currentUser.role));
          const showTimer = !["PENDENTE","SEM_SEPARACAO"].includes(row.status);
          return `<article class="separation-order">
            <div class="separation-order-head"><div><small>${esc(row.destination)}</small><h3>Pedido ${esc(row.document_no)}</h3>
              <div class="muted">Emissão: ${esc(row.issue_date || "—")} · ${Number(row.line_count || 0)} posição(ões) de separação</div>
            </div><span class="badge ${row.status==="CONCLUIDA"?"green":row.status==="PAUSADO"?"orange":""}">${separationFormatStatus(row.status)}</span></div>
            <div class="separation-order-metrics">
              <div><small>Peças previstas</small><b>${Number(row.expected_qty || 0).toLocaleString(DISTRILOG_I18N.getLanguage())}</b></div>
              <div><small>Excluídas da rua 001-</small><b>${Number(row.excluded_street_qty || 0)}</b></div>
              <div><small>Sem casulo</small><b>${Number(row.excluded_without_casulo_qty || 0)}</b></div>
              <div><small>Tempo líquido</small><b id="sepClock${row.id}">${showTimer?fmtSeconds(row.elapsed_seconds):"00:00:00"}</b></div>
            </div>
            <div class="actions">
              ${editable&&row.status==="PENDENTE"?`<button class="primary small-btn" onclick="separationStart(${row.id})">▶ Iniciar</button>`:""}
              ${editable&&row.status==="EM_ANDAMENTO"?`<button class="secondary small-btn" onclick="separationPauseForm(${row.id})">Pausar</button>
                <button class="success small-btn" onclick="separationFinishForm(${row.id})">Concluir separação</button>`:""}
              ${editable&&row.status==="PAUSADO"?`<button class="primary small-btn" onclick="separationResume(${row.id})">Retomar</button>`:""}
              <button class="ghost small-btn" onclick="separationShowItems(${row.id})">Ver referências / endereços</button>
              ${row.status==="CONCLUIDA"?`<span class="muted">Bags: ${row.bags} · Caixas: ${row.boxes} · Peças: ${row.separated_qty} · Peso: ${row.weight_kg} kg</span>`:""}
            </div>
            ${row.operator_name?`<small class="muted">Operador: ${esc(row.operator_name)}</small>`:""}
          </article>`;
        }).join("") || '<div class="empty-visual">Nenhum pedido importado.</div>'}
        </div>
      </div>
    </section>
    <section class="panel" style="margin-top:16px">
      <div class="panel-header"><span>Entradas recentes aguardando aparecer em pedido</span><span class="panel-count">${alerts.length}</span></div>
      <div class="panel-body"><p class="muted">Referências com recebimento físico concluído e ainda não encontradas nos relatórios importados. O alerta desaparece quando a referência entra em um novo pedido, mesmo que suas peças estejam na rua 001- ou sem casulo.</p>
        <div class="separation-entry-list">${alertsHtml}</div>
      </div>
    </section>`;
  separationRenderClock();
  separationClock = window.setInterval(separationRenderClock, 1000);
}
async function separationImport(input) {
  const file = input.files?.[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  input.value = "";
  try {
    const result = await api("/api/separation/import-csv", {method:"POST", body:form});
    toast(`${result.imported} pedido(s) importado(s), ${result.existing} já existente(s); ${result.valid_qty} peça(s) elegíveis.`);
    await renderSeparation();
  } catch (error) { toast(error.message); }
}
async function separationStart(id) {
  try {
    await api(`/api/separation/orders/${id}/start`, {method:"POST"});
    await renderSeparation();
  } catch (error) { toast(error.message); }
}
function separationPauseForm(id) {
  $("modalBody").innerHTML = `
    <h2>Pausar separação</h2>
    <p class="muted">Informe o motivo. O tempo é contado automaticamente até retomar.</p>
    <div class="field"><label>Motivo da pausa *</label><textarea id="sepPauseReason" rows="3" maxlength="500"></textarea></div>
    <div class="actions"><button class="primary" onclick="separationPause(${id})">Confirmar pausa</button>
      <button class="ghost" onclick="closeModal()">Cancelar</button></div>`;
  $("modal").classList.remove("hidden");
}
async function separationPause(id) {
  const reason = $("sepPauseReason")?.value.trim();
  if (!reason) { toast("Informe o motivo da pausa."); return; }
  try {
    await api(`/api/separation/orders/${id}/pause`, {method:"POST", body:JSON.stringify({reason})});
    closeModal();
    await renderSeparation();
  } catch (error) { toast(error.message); }
}
async function separationResume(id) {
  try {
    await api(`/api/separation/orders/${id}/resume`, {method:"POST"});
    await renderSeparation();
  } catch (error) { toast(error.message); }
}
function separationTogglePause() {
  const panel = $("sepPausedFields");
  if (panel) panel.classList.toggle("hidden", $("sepHadPause")?.value !== "yes");
}
function separationFinishForm(id) {
  const row = separationOrders.find(item => item.id === id);
  if (!row) return;
  const measured = Number(row.accumulated_pause_seconds || 0);
  $("modalBody").innerHTML = `
    <h2>Concluir separação · Pedido ${esc(row.document_no)}</h2>
    <p class="muted">Todos os dados abaixo são obrigatórios. Após salvar, o pedido é encaminhado para Expedição.</p>
    <div class="shipping-form-grid">
      <div class="field"><label>Quantidade de bags *</label><input id="sepBags" type="number" min="0" step="1"></div>
      <div class="field"><label>Quantidade de caixas *</label><input id="sepBoxes" type="number" min="0" step="1"></div>
      <div class="field"><label>Quantidade de peças separadas *</label><input id="sepPieces" type="number" min="1" step="1" value="${Number(row.expected_qty || 0)}"></div>
      <div class="field"><label>Peso (kg) *</label><input id="sepWeight" type="number" min="0.001" step="0.001"></div>
      <div class="field"><label>Teve 0 à esquerda? *</label><select id="sepZeroLeft"><option value="">Selecione</option><option value="yes">Sim</option><option value="no">Não</option></select></div>
      <div class="field"><label>Teve pausa? *</label><select id="sepHadPause" onchange="separationTogglePause()">
        <option value="">Selecione</option><option value="yes" ${measured>0?"selected":""}>Sim</option>
        <option value="no">Não</option></select></div>
    </div>
    <div id="sepPausedFields" class="${measured>0?"":"hidden"}">
      <div class="shipping-form-grid">
        <div class="field"><label>Tempo de pausa (hh:mm:ss) *</label><input id="sepPauseDuration" placeholder="00:00:00" pattern="[0-9]+:[0-5][0-9]:[0-5][0-9]" value="${fmtSeconds(measured)}"></div>
        <div class="field"><label>Motivo da pausa *</label><textarea id="sepFinalPauseReason" maxlength="500" rows="2"></textarea></div>
      </div>
    </div>
    <div class="actions"><button class="primary" onclick="separationFinish(${id})">Finalizar e enviar à Expedição</button>
      <button class="ghost" onclick="closeModal()">Cancelar</button></div>`;
  $("modal").classList.remove("hidden");
}
async function separationFinish(id) {
  const zero = $("sepZeroLeft")?.value;
  const pause = $("sepHadPause")?.value;
  if (!zero || !pause) { toast("Responda os campos 0 à esquerda e pausa."); return; }
  const payload = {
    bags: $("sepBags")?.value,
    boxes: $("sepBoxes")?.value,
    separated_qty: $("sepPieces")?.value,
    weight_kg: $("sepWeight")?.value,
    zero_left: zero === "yes",
    had_pause: pause === "yes",
    pause_duration: $("sepPauseDuration")?.value,
    pause_reason: $("sepFinalPauseReason")?.value,
  };
  try {
    const data = await api(`/api/separation/orders/${id}/complete`, {
      method: "POST", body: JSON.stringify(payload),
    });
    closeModal();
    toast(`Separação concluída. Romaneio enviado à Expedição (#${data.shipment_id}).`);
    await renderSeparation();
  } catch (error) { toast(error.message); }
}
async function separationShowItems(id) {
  try {
    const items = await api(`/api/separation/orders/${id}/items`);
    $("modalBody").innerHTML = `<h2>Referências e casulos</h2>
      <p class="muted">Consulta operacional. Não é necessário marcar itens para o cronômetro.</p>
      <div class="table-wrap"><table class="compact-table"><thead><tr><th>Casulo</th><th>Referência</th><th>Descrição</th><th>Variação</th><th>Peças</th></tr></thead>
      <tbody>${items.map(i => `<tr><td>${esc(i.casulo)}</td><td>${esc(i.reference)}</td><td>${esc(i.description)}</td><td>${esc(i.variation)}</td><td>${Number(i.quantity)}</td></tr>`).join("")}</tbody></table></div>`;
    $("modal").classList.remove("hidden");
  } catch (error) { toast(error.message); }
}
