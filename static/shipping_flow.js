/* Expedição: interface operacional por etapas. PostgreSQL é a única fonte de verdade. */
let shippingFlowRows = [];
let shippingFlowCurrent = null;
let shippingFlowTicker = null;
let shippingFlowHeartbeat = null;
let shippingFlowBusy = false;
const shippingFlowStages = {
  CONFERENCIA: "Conferência de lacres",
  FATURAMENTO: "Faturamento",
  EXPEDIR: "Aguardando expedição",
  EXPEDIDO: "Expedido",
  DIVERGENCIA: "Divergência de lacres"
};
function shippingFlowStop() {
  if (shippingFlowTicker) clearInterval(shippingFlowTicker);
  if (shippingFlowHeartbeat) clearInterval(shippingFlowHeartbeat);
  shippingFlowTicker = shippingFlowHeartbeat = null;
}
function shippingFlowTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds || 0)));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map(x => String(x).padStart(2, "0")).join(":");
}
function shippingFlowDuration(s) {
  if (!s) return "00:00:00";
  const field = s.stage === "FATURAMENTO" ? "billing_seconds" : "conference_seconds";
  const committed = Number(s[field] || 0);
  if (!s.owner_user_id || !s.owner_started_at) return shippingFlowTime(committed);
  const diff = Math.max(0, Math.floor((Date.now() - Date.parse(s.owner_started_at)) / 1000));
  return shippingFlowTime(committed + diff);
}
function shippingFlowTick() {
  if (!shippingFlowCurrent) return;
  const el = document.getElementById("shipFlowClock");
  if (el) el.textContent = shippingFlowDuration(shippingFlowCurrent);
}
function shippingFlowCanEdit() {
  return ["expedicao", "admin", "supervisor"].includes(currentUser?.role);
}
function shippingFlowMyClaim(row) {
  return Number(row.owner_user_id || 0) === Number(currentUser?.id || -1);
}
function shippingFlowBadge(stage) {
  return '<span class="shipping-step-badge shipping-step-' + esc(stage) + '">' +
    esc(shippingFlowStages[stage] || stage) + '</span>';
}
function shippingFlowDashboard(rows) {
  const pending = rows.filter(r => r.stage === "CONFERENCIA").length;
  const billing = rows.filter(r => r.stage === "FATURAMENTO").length;
  const ready = rows.filter(r => r.stage === "EXPEDIR").length;
  const cards = rows.filter(r => r.stage !== "EXPEDIDO").slice(0, 5).map(r =>
    '<button class="shipping-quick-order" onclick="goTo(\'shipping\')"><b>' +
    esc(r.document_no) + '</b><span>' + esc(r.destination || "Destino não informado") +
    '</span>' + shippingFlowBadge(r.stage) + '</button>').join("");
  return '<div class="shipping-central-pulse">' +
    '<div><strong>' + pending + '</strong><small>Conferir lacres</small></div>' +
    '<div><strong>' + billing + '</strong><small>Faturar</small></div>' +
    '<div><strong>' + ready + '</strong><small>Expedir</small></div></div>' +
    (cards || '<div class="empty-visual">Expedição sem pendências.</div>') +
    '<button class="panel-action" onclick="goTo(\'shipping\')">Abrir Expedição →</button>';
}
async function renderShippingWorkflow() {
  shippingFlowStop();
  setPage("Expedição", "Lacres → Faturamento → Saída; tarefas com responsável exclusivo");
  const rows = await api("/api/shipping/queue");
  shippingFlowRows = Array.isArray(rows) ? rows : [];
  const count = stage => shippingFlowRows.filter(r => r.stage === stage).length;
  $("mainContent").innerHTML = `
    <div class="shipping-flow-metrics">
      <div><b>${count("CONFERENCIA")}</b><small>Para conferir lacres</small></div>
      <div><b>${count("FATURAMENTO")}</b><small>Para faturar</small></div>
      <div><b>${count("EXPEDIR")}</b><small>Aguardando expedição</small></div>
      <div><b>${count("DIVERGENCIA")}</b><small>Divergências</small></div>
    </div>
    <div class="panel shipping-flow-panel"><div class="panel-header">
      <span>Fila de execução</span>
      <button class="secondary small-btn" onclick="renderShippingWorkflow()">↻ Atualizar</button>
    </div>
    <div class="panel-body">
      <p class="muted">A Conferência verifica lacres, não peças. O faturamento registra o número da NF emitida. O pedido só sai da fila depois que alguém confirma <b>Expedir</b>.</p>
      <div class="shipping-flow-queue">
      ${shippingFlowRows.map(row => `<article class="shipping-flow-card">
        <div class="shipping-flow-card-head">
          <div><small>${esc(row.destination || "Destino não informado")}</small>
            <h3>Romaneio ${esc(row.document_no)}</h3>
            <p>${Number(row.total_qty||0).toLocaleString(DISTRILOG_I18N.getLanguage())} peças informadas pela Separação • ${Number(row.volume_count||0)} volumes</p>
          </div>${shippingFlowBadge(row.stage)}
        </div>
        <div class="shipping-flow-card-foot">
          <span>${row.owner_user_id ? "🔒 Em execução por " + esc(row.owner_name || "outro operador") : row.stage==="EXPEDIDO" ? "✓ Saída confirmada" : "○ Disponível"}</span>
          <button class="primary small-btn" onclick="shippingFlowOpen(${Number(row.id)})">Ver / Operar →</button>
        </div>
      </article>`).join("") || '<div class="empty-visual">Nenhum romaneio cadastrado.</div>'}
      </div>
    </div></div>`;
}
async function shippingFlowOpen(id) {
  try {
    shippingFlowStop();
    shippingFlowCurrent = await api("/api/shipping/" + Number(id));
    shippingFlowDraw();
  } catch (e) { toast(e.message); }
}
function shippingFlowDraw() {
  const row = shippingFlowCurrent;
  if (!row) return;
  const mine = shippingFlowMyClaim(row);
  const canEdit = shippingFlowCanEdit();
  const locked = row.owner_user_id && !mine;
  const step = row.stage;
  const notes = row.seal_notes || "";
  let operations = "";
  if (locked) {
    operations = '<div class="notice warn">🔒 Em execução por ' + esc(row.owner_name || "outro operador") + '. Este pedido não pode ser assumido simultaneamente.</div>';
  } else if (canEdit && ["CONFERENCIA", "FATURAMENTO"].includes(step) && !mine) {
    operations = '<button class="primary" onclick="shippingFlowAction(\'claim\')">▶ Assumir e iniciar cronômetro</button>';
  } else if (canEdit && mine && step === "CONFERENCIA") {
    operations = `<div class="shipping-flow-fields">
      <div class="field"><label>Lacres conferidos *</label><input id="shipSealCount" type="number" min="1" step="1" value="${row.seals_checked||""}"></div>
      <div class="field"><label>Os lacres estão corretos? *</label><select id="shipSealOk"><option value="">Selecione</option><option value="yes">Sim</option><option value="no">Não: registrar divergência</option></select></div>
      <div class="field"><label>Observações / motivo da divergência</label><textarea id="shipSealNotes" maxlength="500">${esc(notes)}</textarea></div>
      <div class="actions"><button class="success" onclick="shippingFlowAction('complete')">Concluir conferência de lacres</button>
        <button class="secondary" onclick="shippingFlowAction('release')">Liberar para outro operador</button></div>
    </div>`;
  } else if (canEdit && mine && step === "FATURAMENTO") {
    operations = `<div class="shipping-flow-fields">
      <div class="field"><label>Número da nota fiscal emitida *</label><input id="shipInvoiceNumber" maxlength="80" value="${esc(row.invoice_number||"")}"></div>
      <div class="field"><label>Observações</label><textarea id="shipInvoiceNotes" maxlength="500">${esc(row.invoice_notes||"")}</textarea></div>
      <p class="muted">O registro não emite NF-e automaticamente. Confirme o faturamento no sistema fiscal antes de concluir.</p>
      <div class="actions"><button class="success" onclick="shippingFlowAction('complete')">Concluir faturamento</button>
        <button class="secondary" onclick="shippingFlowAction('release')">Liberar para outro operador</button></div>
    </div>`;
  } else if (canEdit && step === "EXPEDIR") {
    operations = '<div class="notice success-box">Lacres conferidos e faturamento registrado. A saída física ainda não foi confirmada.</div><button class="success" onclick="shippingFlowAction(\'dispatch\')">↗ Confirmar EXPEDIR</button>';
  } else if (canEdit && step === "DIVERGENCIA" && ["admin", "supervisor"].includes(currentUser.role)) {
    operations = '<div class="notice warn">Divergência bloqueada para o faturamento. Apenas gestão pode autorizar nova conferência.</div><div class="field"><label>Justificativa para reabrir *</label><textarea id="shipResolution" maxlength="500"></textarea></div><button class="secondary" onclick="shippingFlowAction(\'resolve\')">Reabrir conferência</button>';
  } else if (step === "EXPEDIDO") {
    operations = '<div class="notice success-box">✓ Pedido expedido. Saída física registrada.</div>';
  } else if (step === "DIVERGENCIA") {
    operations = '<div class="notice warn">Divergência nos lacres. Aguardando revisão da gestão.</div>';
  }
  $("modalBody").innerHTML = `<section class="shipping-flow-detail">
    <div class="shipping-flow-card-head"><div><small>${esc(row.destination||"Destino não informado")}</small><h2>Romaneio ${esc(row.document_no)}</h2></div>${shippingFlowBadge(step)}</div>
    <div class="shipping-flow-steps"><span class="${["CONFERENCIA","DIVERGENCIA"].includes(step)?"on":""}">1. Lacres</span><span class="${step==="FATURAMENTO"?"on":""}">2. Faturamento</span><span class="${["EXPEDIR","EXPEDIDO"].includes(step)?"on":""}">3. Expedir</span></div>
    <div class="shipping-flow-clock"><small>Tempo acumulado nesta etapa</small>
      <strong id="shipFlowClock">${shippingFlowDuration(row)}</strong></div>
    <div class="shipping-flow-facts">
      <span><b>${Number(row.total_qty||0)}</b> peças informadas</span>
      <span><b>${Number(row.volume_count||0)}</b> volumes</span>
      <span><b>${row.seals_checked==null?"—":Number(row.seals_checked)}</b> lacres registrados</span>
      <span><b>${esc(row.invoice_number||"—")}</b> nota fiscal</span>
    </div>
    ${operations}
    <div class="shipping-flow-history"><h3>Histórico auditável</h3>
    ${(row.events||[]).map(ev=>`<p><b>${esc(ev.actor||"Operador")}</b> · ${esc(ev.event)} · ${esc(ev.details||"")}</p>`).join("")||'<p>Nenhuma operação registrada.</p>'}</div>
  </section>`;
  $("modal").classList.remove("hidden");
  shippingFlowStop();
  shippingFlowTicker = setInterval(shippingFlowTick, 1000);
  if (mine) shippingFlowHeartbeat = setInterval(async () => {
    try { await api("/api/shipping/"+row.id+"/heartbeat", {method:"POST",body:"{}"}); }
    catch(e) { shippingFlowStop(); toast("A reserva da tarefa não pôde ser renovada. Atualize a Expedição."); }
  }, 30000);
}
async function shippingFlowAction(action) {
  if (shippingFlowBusy || !shippingFlowCurrent) return;
  const row = shippingFlowCurrent;
  let data = {};
  if (action === "complete" && row.stage === "CONFERENCIA") {
    const value = $("shipSealCount")?.value?.trim() || "";
    if (!/^\d+$/.test(value) || Number(value) < 1) { toast("Informe quantos lacres foram conferidos."); return; }
    const ok = $("shipSealOk")?.value;
    if (!["yes","no"].includes(ok)) { toast("Informe se os lacres estão corretos."); return; }
    data = {seals_checked:Number(value),seals_ok:ok==="yes",notes:$("shipSealNotes")?.value?.trim()||""};
  } else if (action === "complete" && row.stage === "FATURAMENTO") {
    data={invoice_number:$("shipInvoiceNumber")?.value?.trim()||"",notes:$("shipInvoiceNotes")?.value?.trim()||""};
    if (!data.invoice_number) { toast("Informe o número da NF emitida."); return; }
  } else if (action === "resolve") {
    data={reason:$("shipResolution")?.value?.trim()||""};
    if (data.reason.length < 5) { toast("Justifique a reabertura."); return; }
  } else if (action === "dispatch") {
    if (!DISTRILOG_I18N.confirm("Confirmar a saída física deste romaneio? Esta ação não pode ser desfeita pela interface.")) return;
  }
  shippingFlowBusy = true;
  try {
    await api("/api/shipping/"+Number(row.id)+"/"+action,{method:"POST",body:JSON.stringify(data)});
    shippingFlowStop();
    shippingFlowCurrent = await api("/api/shipping/"+Number(row.id));
    await renderShippingWorkflow();
    shippingFlowDraw();
    toast(action==="dispatch"?"Saída física confirmada.":"Etapa atualizada.");
  } catch (e) { toast(e.message); }
  finally { shippingFlowBusy = false; }
}
