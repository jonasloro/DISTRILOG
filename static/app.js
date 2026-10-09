"use strict";

const DEMO_CARDS_KEY = "distrilog_demo_cards";
const DEMO_USER_KEY = "distrilog_demo_user";
let currentUser = JSON.parse(localStorage.getItem(DEMO_USER_KEY) || "null");
let currentView = "dashboard";
let toastTimer = null;

const $ = (id) => document.getElementById(id);
const MODULES = {
  dashboard: ["Central de Operações", "Resumo visual da operação"],
  receiving: ["Recebimento", "Cards aguardando recebimento"],
  "painel-recebimento": ["Painel de Recebimento", "Visão visual da fila de entrada"],
  quality: ["Qualidade", "Interface de inspeção"],
  processing: ["Processamento", "Interface de processamento"],
  labeling: ["Etiquetagem", "Interface de etiquetagem"],
  "storage-hub": ["Estocagem", "Visão geral de estocagem e capacidade"],
  shipping: ["Expedição", "Interface de expedição"],
  "returns-hub": ["Devoluções", "Interface de devoluções"],
  chat: ["Conversas", "Área visual de comunicação da equipe"],
  calendar: ["Calendário", "Planejamento visual da operação"],
  "goat-indicators": ["Indicadores (GOAT)", "Painel visual de indicadores"],
  production: ["Produção por Pessoa", "Acompanhamento visual de produção"],
  registrations: ["Cadastros", "Cadastro manual de cards e dados de demonstração"],
  test: ["Ferramentas de teste", "Área reservada para ferramentas de teste"],
  settings: ["Configurações", "Preferências da interface"]
};

function esc(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function fmt(value) { return Number(value || 0).toLocaleString("pt-BR"); }
function readCards() {
  try {
    const value = JSON.parse(localStorage.getItem(DEMO_CARDS_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch (_) { return []; }
}
function saveCards(cards) { localStorage.setItem(DEMO_CARDS_KEY, JSON.stringify(cards)); }
function toast(message) {
  const node = $("toast");
  if (!node) { window.alert(message); return; }
  node.textContent = message;
  node.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add("hidden"), 3500);
}
function setPage(title, subtitle) {
  $("pageTitle").textContent = title;
  $("pageSubtitle").textContent = subtitle || "";
}
function doLogin() {
  const typedName = ($("loginUsername").value || "").trim();
  currentUser = { id: "demo-local", name: typedName || "Operador Demo", username: typedName || "operador", role: "admin" };
  localStorage.setItem(DEMO_USER_KEY, JSON.stringify(currentUser));
  $("loginError").textContent = "";
  enterApp();
}
function enterApp() {
  $("loginScreen").classList.add("hidden");
  $("appShell").classList.remove("hidden");
  $("currentUser").innerHTML = "<strong>" + esc(currentUser.name) + "</strong><br>Modo demonstração";
  goTo(currentView || "dashboard");
}
function logout() {
  localStorage.removeItem(DEMO_USER_KEY);
  location.reload();
}
function closeModal() { $("modal").classList.add("hidden"); }
function refreshCurrentView() { goTo(currentView); }
function showQuickHelp() {
  $("modalBody").innerHTML = "<h2>Como testar</h2><p>Abra <b>Cadastros</b>, clique em <b>Criar Card</b>, preencha a referência e o fornecedor, monte a grade e confirme.</p><p>Os cards ficam salvos apenas neste navegador. Nenhum backend ou banco de dados está conectado nesta etapa.</p>";
  $("modal").classList.remove("hidden");
}
function globalSearchKey(event) {
  if (event.key === "Enter") {
    const query = ($("globalSearch").value || "").trim();
    goTo("receiving");
    setTimeout(() => {
      const input = $("cardSearch");
      if (input) { input.value = query; renderCards("receiving", query); }
    }, 0);
  }
}
function dashboardPanel(icon, title, value, body) {
  return '<section class="panel dash-panel"><header class="panel-header"><span style="font-size:18px;margin-right:7px">' + icon + '</span><strong>' + title + '</strong><span style="margin-left:auto">' + value + '</span></header><div class="panel-body">' + body + '</div></section>';
}
function heroCard(title, value, caption, target, icon) {
  return '<button class="hero-card" onclick="goTo(\'' + target + '\')"><div><span>' + title + '</span><strong>' + value + '</strong><small>' + caption + '</small><em>Ver detalhes ›</em></div><div class="capacity-ring" style="--pct:0"><b>' + icon + '</b></div></button>';
}
function renderDashboard() {
  const cards = readCards();
  const totalPieces = cards.reduce((sum, card) => sum + Number(card.expected_total || 0), 0);
  const latest = cards.slice(0, 5);
  setPage(MODULES.dashboard[0], "Interface em modo local • os cards são salvos neste navegador");
  const recentHtml = latest.length ? latest.map(card =>
    '<tr><td><button class="link-button" onclick="openCardDetail(' + Number(card.id) + ')">' + esc(card.manual_reference || card.reference || card.purchase_id) + '</button></td><td>' + esc(card.supplier || "—") + '</td><td>' + fmt(card.expected_total) + '</td><td><span class="badge badge-blue">Aguardando recebimento</span></td></tr>'
  ).join("") : '<tr><td colspan="4" class="empty-cell">Nenhum card criado ainda. Acesse Cadastros para gerar o primeiro.</td></tr>';
  $("mainContent").innerHTML =
    '<div class="hero-kpis">' +
      heroCard("Aguardando recebimento", fmt(cards.length), "Cards criados", "receiving", "▣") +
      heroCard("Peças cadastradas", fmt(totalPieces), "Total das grades", "receiving", "▦") +
      heroCard("Qualidade", "—", "Módulo visual", "quality", "◇") +
      heroCard("Capacidade do CD", "—", "Backend não conectado", "storage-hub", "⌂") +
    '</div><div class="dash-row dash-row-main">' +
      dashboardPanel("▣", "Cards recentes", '<span class="panel-count">' + cards.length + '</span>', '<div class="table-wrap"><table class="compact-table"><thead><tr><th>Referência</th><th>Fornecedor</th><th>Peças</th><th>Status</th></tr></thead><tbody>' + recentHtml + '</tbody></table></div>') +
      dashboardPanel("＋", "Primeiro passo", "", '<p>Gere um card manual com uma referência, fornecedor e grade de cores/tamanhos.</p><button class="primary" onclick="goTo(\'registrations\')">Abrir Cadastros</button>') +
      dashboardPanel("ℹ", "Modo de demonstração", "", '<p>Interface sem integração com banco de dados. Os cards persistem no armazenamento local deste navegador.</p><p>As demais áreas mantêm a navegação visual e serão conectadas por setor.</p>') +
    '</div>';
}
function cardRow(card) {
  const ref = card.manual_reference || card.reference || card.purchase_id || "Card";
  return '<tr><td><button class="link-button" onclick="openCardDetail(' + Number(card.id) + ')">' + esc(ref) + '</button><small>' + esc(card.purchase_id || "") + '</small></td><td>' + esc(card.supplier || "—") + '</td><td>' + esc(card.nf || "—") + '</td><td>' + esc(card.lot || "—") + '</td><td>' + fmt(card.expected_total) + '</td><td>' + (card.items || []).length + '</td><td><span class="badge badge-blue">Aguardando recebimento</span></td><td><button class="secondary small-btn" onclick="openCardDetail(' + Number(card.id) + ')">Abrir</button></td></tr>';
}
function renderCards(scope, queryOverride) {
  const allCards = readCards();
  const query = (queryOverride != null ? queryOverride : (($("cardSearch") && $("cardSearch").value) || "")).trim().toLocaleLowerCase("pt-BR");
  const cards = allCards.filter(card => {
    const haystack = [card.manual_reference, card.reference, card.purchase_id, card.supplier, card.nf, card.lot].join(" ").toLocaleLowerCase("pt-BR");
    return !query || haystack.includes(query);
  });
  const title = scope === "quality" ? "Qualidade" : scope === "processing" ? "Processamento" : scope === "labeling" ? "Etiquetagem" : scope === "storage" ? "Estocagem" : "Recebimento";
  setPage(title, scope === "receiving" ? "Cards criados localmente e aguardando recebimento" : "Somente interface visual nesta etapa");
  const toolbar = '<div class="toolbar" style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap"><input id="cardSearch" style="min-width:240px;flex:1" placeholder="Buscar referência, fornecedor, NF ou lote" value="' + esc(query) + '" onkeydown="if(event.key===\'Enter\')renderCards(\'' + scope + '\', this.value)"><button class="primary" onclick="renderCards(\'' + scope + '\', document.getElementById(\'cardSearch\').value)">Pesquisar</button><button class="primary" onclick="openGoatCardModal()">+ Criar Card</button></div>';
  let body;
  if (scope !== "receiving") {
    body = '<div class="panel"><div class="panel-body"><h3>' + title + '</h3><p>Esta tela é somente visual por enquanto. A lógica operacional será adicionada quando trabalharmos neste setor.</p></div></div>';
  } else {
    body = '<div class="panel"><div class="table-wrap"><table class="compact-table"><thead><tr><th>Referência / Compra</th><th>Fornecedor</th><th>NF</th><th>Lote</th><th>Peças</th><th>Itens na grade</th><th>Status</th><th></th></tr></thead><tbody>' +
      (cards.length ? cards.map(cardRow).join("") : '<tr><td colspan="8" class="empty-cell">Nenhum card encontrado. Use “Criar Card” para cadastrar a primeira referência.</td></tr>') +
      '</tbody></table></div></div>';
  }
  $("mainContent").innerHTML = toolbar + body;
}
function renderRegistrations() {
  const cards = readCards();
  const total = cards.reduce((sum, card) => sum + Number(card.expected_total || 0), 0);
  setPage(MODULES.registrations[0], MODULES.registrations[1]);
  const recent = cards.length ? cards.slice(0, 8).map(cardRow).join("") : '<tr><td colspan="8" class="empty-cell">Nenhum card cadastrado. Clique em “Criar Card” para começar.</td></tr>';
  $("mainContent").innerHTML =
    '<div class="actions" style="margin-bottom:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="primary" onclick="openGoatCardModal()">+ Criar Card</button><span class="notice" style="margin:0">1 card = 1 referência • criação manual • modo local</span></div>' +
    '<div class="hero-kpis">' +
      heroCard("Cards cadastrados", fmt(cards.length), "Referências criadas", "receiving", "▣") +
      heroCard("Peças nas grades", fmt(total), "Soma das quantidades", "receiving", "▦") +
      heroCard("Persistência", "Local", "Neste navegador", "registrations", "✓") +
      heroCard("Backend", "Desligado", "Sem banco de dados", "registrations", "○") +
    '</div><section class="panel"><header class="panel-header"><strong>Cards criados</strong><span class="panel-count">' + cards.length + '</span></header><div class="table-wrap"><table class="compact-table"><thead><tr><th>Referência / Compra</th><th>Fornecedor</th><th>NF</th><th>Lote</th><th>Peças</th><th>Itens na grade</th><th>Status</th><th></th></tr></thead><tbody>' + recent + '</tbody></table></div></section>';
}
function openCardDetail(id) {
  const card = readCards().find(item => Number(item.id) === Number(id));
  if (!card) { toast("Este card não foi encontrado."); return; }
  const gradeRows = (card.grade || []).map(row => '<tr><td>' + esc(row.color) + '</td><td>' + esc(row.size) + '</td><td>' + fmt(row.quantity) + '</td></tr>').join("");
  $("modalBody").innerHTML =
    '<div class="card-title"><div><h2>' + esc(card.manual_reference || card.reference) + '</h2><div class="card-subtitle">' + esc(card.supplier) + ' • ' + fmt(card.expected_total) + ' peças</div></div><div class="card-title-actions"><span class="badge badge-blue">Aguardando recebimento</span></div></div>' +
    '<div class="summary-grid"><div class="summary-box"><span>Referência</span><strong>' + esc(card.manual_reference || card.reference) + '</strong></div><div class="summary-box"><span>Fornecedor</span><strong>' + esc(card.supplier) + '</strong></div><div class="summary-box"><span>NF</span><strong>' + esc(card.nf || "—") + '</strong></div><div class="summary-box"><span>Lote</span><strong>' + esc(card.lot || "—") + '</strong></div><div class="summary-box"><span>Peças</span><strong>' + fmt(card.expected_total) + '</strong></div><div class="summary-box"><span>Modo</span><strong>Grade</strong></div></div>' +
    '<h3>Grade de tamanhos e cores</h3><div class="table-wrap"><table class="compact-table"><thead><tr><th>Cor</th><th>Tamanho</th><th>Quantidade</th></tr></thead><tbody>' + gradeRows + '</tbody></table></div>' +
    '<div class="actions" style="justify-content:flex-end;margin-top:16px"><button class="danger" onclick="deleteCard(' + Number(card.id) + ')">Excluir card de demonstração</button><button class="secondary" onclick="closeModal()">Fechar</button></div>';
  $("modal").classList.remove("hidden");
}
function deleteCard(id) {
  saveCards(readCards().filter(card => Number(card.id) !== Number(id)));
  closeModal();
  toast("Card removido deste navegador.");
  goTo(currentView);
}
function renderModule(view) {
  const info = MODULES[view] || ["Módulo", "Interface visual"];
  const cards = readCards();
  setPage(info[0], info[1]);
  $("mainContent").innerHTML =
    '<div class="dash-row dash-row-main">' +
      dashboardPanel("◈", info[0], "", '<p>Esta tela mantém a navegação e a identidade visual da aplicação de referência.</p><p>A lógica específica deste setor será construída em uma próxima etapa, sem backend por enquanto.</p>') +
      dashboardPanel("▣", "Cards no navegador", '<span class="panel-count">' + cards.length + '</span>', '<p>Existem ' + cards.length + ' cards de demonstração salvos neste navegador.</p><button class="primary" onclick="goTo(\'receiving\')">Ver Recebimento</button>') +
    '</div>';
}
function goTo(view) {
  currentView = view;
  document.querySelectorAll(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  if (MODULES[view]) setPage(MODULES[view][0], MODULES[view][1]);
  if (view === "dashboard") renderDashboard();
  else if (view === "receiving") renderCards("receiving");
  else if (view === "registrations") renderRegistrations();
  else if (view === "quality" || view === "processing" || view === "labeling") renderCards(view);
  else renderModule(view);
}
function refreshCurrentView() { goTo(currentView); }
document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("globalSearch").focus();
  }
  if (event.key === "Escape") {
    closeModal();
    if (typeof closeGoatModal === "function") closeGoatModal();
  }
});
window.addEventListener("storage", event => {
  if (event.key === DEMO_CARDS_KEY) goTo(currentView);
});
if (currentUser) enterApp();
else {
  $("appShell").classList.add("hidden");
  $("loginScreen").classList.remove("hidden");
}
