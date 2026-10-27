let currentUser = JSON.parse(localStorage.getItem("cl_recebimento_user") || "null");
let currentView = "dashboard";
let currentCardId = null;
let cardData = null;
let receivingPhotos = [];
let dispatchPhotos = [];
let qualityUsers = [];
let processingUsers = [];
let downstreamUsers = {ETIQUETAGEM:[],ESTOCAGEM:[]};
let selectedProductionCardId = null;
let unifiedCache = {sgo:[],tasks:[],shipments:[],returns:[]};

const $ = (id) => document.getElementById(id);

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Erro inesperado." }));
    throw new Error(error.detail || "Erro inesperado.");
  }
  return response.json();
}

async function apiWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await api(url, { signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("A consulta " + url + " ultrapassou " + Math.round(timeoutMs / 1000) + " segundos. Verifique a conexão do banco e tente novamente.");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}


function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function fmtDate(value) {
  if (!value) return "—";
  const parsed = new Date(value.length === 10 ? value + "T00:00:00" : value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString("pt-BR");
}

function fmtDateTime(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("pt-BR");
}

// Estado de módulos novos: declarado no topo porque o app já inicia (enterApp) antes do fim do arquivo.
let cleaningTick = null;
let processingFlowTick = null;
let processingExtraIndex = 0;
let cleaningDays = 30;
const PROCESSING_TABS = [["Visão geral", "processing-hub"], ["Fila operacional", "processing"], ["Cadastro", "processing-register"], ["Triagem", "processing-triage"], ["Entrada", "processing-entry"]];

function fmtSeconds(value) {
  let seconds = Math.max(0, Number(value || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((x) => String(x).padStart(2, "0")).join(":");
}

function statusClass(status) {
  if (["AGUARDANDO_QUALIDADE", "RETORNO_CONCLUIDO", "AGUARDANDO_INSPECAO", "AGUARDANDO_CONCLUSAO_QUALIDADE", "AGUARDANDO_PROCESSAMENTO", "AGUARDANDO_INICIO_PROCESSAMENTO", "AGUARDANDO_CONCLUSAO_PROCESSAMENTO", "AGUARDANDO_TRIAGEM", "AGUARDANDO_ETIQUETAS", "ETIQUETAS_DISPONIVEIS", "AGUARDANDO_ETIQUETAGEM", "AGUARDANDO_ESTOCAGEM", "AGUARDANDO_ENTRADA"].includes(status)) return "green";
  if (["RECEBIMENTO_FISICO_CONCLUIDO_10_PENDENTE", "SEPARACAO_10_CONCLUIDA_RECEBIMENTO_PENDENTE", "RETORNO_FISICO_CONCLUIDO_10_PENDENTE", "SEPARACAO_RETORNO_10_CONCLUIDA_FISICO_PENDENTE", "EM_TRANSITO", "ORIGEM_TRANSITO", "AGUARDANDO_DESPACHO_COSTURA", "INSPECAO_PAUSADA", "PROCESSAMENTO_PAUSADO"].includes(status)) return "orange";
  if (status === "DESPACHO_CD02") return "red";
  if (["EM_COSTURA_CD01", "EM_INSPECAO", "EM_PROCESSAMENTO"].includes(status)) return "purple";
  return "";
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.remove("hidden");
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => $("toast").classList.add("hidden"), 3500);
}

async function doLogin() {
  try {
    currentUser = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username: $("loginUsername").value, password: $("loginPassword").value }),
    });
    localStorage.setItem("cl_recebimento_user", JSON.stringify(currentUser));
    $("loginError").textContent = "";
    enterApp();
  } catch (error) {
    $("loginError").textContent = error.message;
  }
}

function enterApp() {
  $("loginScreen").classList.add("hidden");
  $("appShell").classList.remove("hidden");
  $("currentUser").innerHTML = `<strong>${esc(currentUser.name)}</strong><br>${esc(currentUser.role)}`;
  const testToolsNav = $("testToolsNav");
  if (testToolsNav) {
    const isAdmin = String(currentUser.role || "").toLowerCase() === "admin";
    testToolsNav.classList.toggle("hidden", !isAdmin);
  }
  goTo("dashboard");
}

function logout() {
  localStorage.removeItem("cl_recebimento_user");
  location.reload();
}

function setPage(title, subtitle) {
  $("pageTitle").textContent = title;
  $("pageSubtitle").textContent = subtitle;
}

function activeNav(view) {
  const parent = ({"processing-hub":"processing","processing-register":"processing","processing-triage":"processing","processing-entry":"processing",storage:"storage-hub",returns:"returns-hub","return-indicators":"returns-hub","return-history":"returns-hub",sgo:"settings",tasks:"settings",import:"settings",test:"settings"})[view] || view;
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === parent);
  });
}

function showLoading(label) {
  const rows = Array.from({length: 5}, () => '<div class="skeleton-row"></div>').join("");
  $("mainContent").innerHTML = `<div class="loading-panel"><div class="loading-head"><span class="loading-spinner"></span><b>Carregando ${esc(label || "")}…</b></div>${rows}</div>`;
}

async function goTo(view) {
  clearInterval(cleaningTick);
  clearInterval(processingFlowTick);
  const previousView = currentView;
  currentView = view;
  activeNav(view);
  if (previousView !== view || !$("mainContent").children.length) {
    const navButton = document.querySelector(`.nav-item[data-view="${view}"]`);
    showLoading(navButton ? navButton.textContent.trim() : "");
  }
  try {
    if (view === "dashboard") await renderDashboard();
    if (view === "receiving") await renderCards("receiving");
    if (view === "quality") await renderCards("quality");
    if (view === "processing") await renderCards("processing");
    if (view === "labeling") await renderCards("labeling");
    if (view === "storage") await renderCards("storage");
    if (view === "storage-hub") await renderStorageHub();
    if (view === "address-map") await renderAddressMap();
    if (view === "sgo") await renderSgo();
    if (view === "sgo-indicators") await renderSgoIndicators();
    if (view === "production") await renderProduction();
    if (view === "goat-indicators") await renderGoatIndicators();
    if (view === "tasks") await renderTasks();
    if (view === "shipping") await renderShipping();
    if (view === "returns") await renderReturnsV3();
    if (view === "returns-hub") await renderReturnsHub();
    if (view === "return-indicators") await renderReturnIndicators();
    if (view === "return-history") await renderReturnHistory();
    if (view === "registrations") await renderRegistrations();
    if (view === "settings") await renderSettings();
    if (view === "import") await renderImport();
    if (view === "test") await renderTestTools();
    if (view === "history") await renderGlobalHistory();
    if (view === "chat") await renderChat();
    if (view === "calendar") await renderCalendar();
    if (view === "cleaning") await renderCleaning();
    if (view === "processing-hub") await renderProcessingHub();
    if (view === "processing-register") await renderProcessingRegister();
    if (view === "processing-triage") await renderProcessingTriage();
    if (view === "processing-entry") await renderProcessingEntry();
  } catch (error) {
    console.error(error);
    $("mainContent").innerHTML = `<div class="state-panel error-state"><b>Não foi possível carregar esta visão.</b><span>${esc(error.message)}</span><button class="primary" onclick="refreshCurrentView()">Tentar novamente</button></div>`;
  }
}

async function refreshCurrentView() {
  if (currentCardId) return openCard(currentCardId);
  return goTo(currentView);
}

function globalSearchKey(event) {
  if (event.key !== "Enter") return;
  const term = event.target.value.trim();
  if (!term) return;
  goTo("receiving").then(() => {
    const input = document.querySelector(".queue-search input");
    if (input) { input.value = term; input.dispatchEvent(new Event("input")); }
  });
}

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault(); $("globalSearch")?.focus();
  }
});

function closeModal() {
  const modal = $("modal");
  if (!modal) return;
  modal.classList.add("hidden");
  if ($("modalBody")) $("modalBody").innerHTML = "";
  currentCardId = null;
  cardData = null;
  window.processingTriageCardId = null;
  window.allocCtx = null;
  window.positionMapRequestId = (window.positionMapRequestId || 0) + 1;
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("modal")?.classList.contains("hidden")) closeModal();
});

function showQuickHelp() {
  $("modalBody").innerHTML = `<div class="card-title"><div><h2>Ajuda rápida</h2><div class="card-subtitle">DistriLog — fluxo operacional</div></div></div><div class="help-grid"><button onclick="closeModal();goTo('receiving')"><b>Recebimento</b><span>Recebimento físico e tiragem de 10%.</span></button><button onclick="closeModal();goTo('quality')"><b>Qualidade</b><span>Inspeções, amostras e resultados.</span></button><button onclick="closeModal();goTo('storage-hub')"><b>Estocagem</b><span>Fila, mapa, consulta e capacidade.</span></button><button onclick="closeModal();goTo('returns-hub')"><b>Devoluções</b><span>Conferência, pendências e indicadores.</span></button></div>`;
  $("modal").classList.remove("hidden");
}

function metricCardsHtml(scope, totals) {
  if (scope === "receiving") {
    const qty = Number(totals.receiving_qty || 0);
    return `<div class="metric-row-2"><div class="kpi"><div class="kpi-label">Peças aguardando recebimento</div><div class="kpi-value">${qty.toLocaleString("pt-BR")}</div></div></div>`;
  }
  if (scope === "quality") {
    const qty = Number(totals.quality_qty || 0), total = Number(totals.quality || 0), active = Number(totals.quality_in_progress || 0);
    return `<div class="metric-row-2"><div class="kpi"><div class="kpi-label">Peças em Qualidade</div><div class="kpi-value">${qty.toLocaleString("pt-BR")}</div></div><div class="kpi"><div class="kpi-label">% em inspeção ativa</div><div class="kpi-value">${total?(active*100/total).toFixed(1):"0.0"}%</div></div></div>`;
  }
  if (scope === "processing") {
    const qty = Number(totals.processing_qty || 0), total = Number(totals.processing || 0), active = Number(totals.processing_in_progress || 0);
    return `<div class="metric-row-2"><div class="kpi"><div class="kpi-label">Peças em Processamento</div><div class="kpi-value">${qty.toLocaleString("pt-BR")}</div></div><div class="kpi"><div class="kpi-label">% em execução ativa</div><div class="kpi-value">${total?(active*100/total).toFixed(1):"0.0"}%</div></div></div>`;
  }
  return "";
}


let addressMapLoadId = 0;

async function renderAddressMap() {
  setPage("Mapa de endereçamento", "Visão geral dos endereços WMS, organizada por setor, zona, casulo e nível.");
  const requestId = ++addressMapLoadId;
  window.addressMapState = {
    sector: window.addressMapState?.sector || "RM",
    zone: window.addressMapState?.zone || "ALL",
    status: window.addressMapState?.status || "ALL",
    search: window.addressMapState?.search || "",
    bySector: {}
  };
  $("mainContent").innerHTML = '<section class="address-map-page"><div class="state-panel"><b>Carregando endereços...</b><span>Consultando a ocupação atual de RM, QA, PR, ET e EC.</span></div></section>';

  try {
    const sectors = ["RM", "QA", "PR", "ET", "EC"];
    const entries = await Promise.all(sectors.map(async (sector) => {
      const positions = await apiWithTimeout("/api/positions?setor=" + encodeURIComponent(sector));
      if (!Array.isArray(positions)) {
        throw new Error("O servidor retornou dados inválidos para o setor " + sector + ".");
      }
      if (!positions.length) {
        throw new Error("Nenhum endereço foi retornado para o setor " + sector + ". Verifique a conexão e o cadastro das posições WMS.");
      }
      return [sector, positions];
    }));
    if (requestId !== addressMapLoadId || currentView !== "address-map") return;
    window.addressMapState.bySector = Object.fromEntries(entries);
    if (!window.addressMapState.bySector[window.addressMapState.sector]) {
      window.addressMapState.sector = "RM";
    }
    renderAddressMapContent();
  } catch (error) {
    if (requestId !== addressMapLoadId || currentView !== "address-map") return;
    $("mainContent").innerHTML =
      '<section class="address-map-page"><div class="state-panel error-state"><b>Não foi possível carregar o mapa de endereçamento.</b><span>' +
      esc(error?.message || "Erro desconhecido ao consultar os endereços.") +
      '</span><button class="primary" onclick="renderAddressMap()">Tentar novamente</button></div></section>';
  }
}

function addressMapCurrentPositions() {
  const state = window.addressMapState;
  return state?.bySector?.[state.sector] || [];
}

function renderAddressMapContent() {
  const state = window.addressMapState;
  const allPositions = addressMapCurrentPositions();
  const zones = [...new Map(allPositions.map((p) => [
    String(p.zona),
    { value: String(p.zona), label: String(p.zona_label || ("Zona " + p.zona)) }
  ])).values()].sort((a, b) => a.value.localeCompare(b.value, "pt-BR", { numeric: true }));
  const sectors = [
    { value: "RM", label: "RM — Recebimento" },
    { value: "QA", label: "QA — Qualidade" },
    { value: "PR", label: "PR — Processamento" },
    { value: "ET", label: "ET — Etiquetagem" },
    { value: "EC", label: "EC — Estocagem" }
  ];
  const occupied = allPositions.filter((p) => Number(p.ocupado || 0) > 0).length;
  const free = allPositions.length - occupied;
  const allocated = allPositions.reduce((sum, p) => sum + Math.max(0, Number(p.ocupado || 0)), 0);
  $("mainContent").innerHTML =
    '<section class="address-map-page">' +
      '<div class="address-map-intro"><div><span class="address-map-eyebrow">WMS · CONSULTA</span><h2>Mapa físico de endereçamento</h2><p>Consulte a ocupação das posições sem precisar abrir um Card. Este painel é somente leitura.</p></div>' +
      '<button class="secondary" type="button" onclick="renderAddressMap()">Atualizar mapa</button></div>' +
      '<div class="address-map-stats">' +
        '<div class="address-map-stat"><span>Posições no setor</span><strong id="addressMapTotal">' + allPositions.length.toLocaleString("pt-BR") + '</strong></div>' +
        '<div class="address-map-stat"><span>Posições livres</span><strong id="addressMapFree">' + free.toLocaleString("pt-BR") + '</strong></div>' +
        '<div class="address-map-stat"><span>Posições ocupadas</span><strong id="addressMapOccupied">' + occupied.toLocaleString("pt-BR") + '</strong></div>' +
        '<div class="address-map-stat"><span>Unidades alocadas</span><strong id="addressMapAllocated">' + allocated.toLocaleString("pt-BR") + '</strong></div>' +
      '</div>' +
      '<div class="address-map-controls">' +
        '<div class="field"><label for="addressMapSector">Setor</label><select id="addressMapSector" onchange="changeAddressMapSector(this.value)">' +
          sectors.map((s) => '<option value="' + s.value + '"' + (s.value === state.sector ? ' selected' : '') + '>' + esc(s.label) + '</option>').join("") +
        '</select></div>' +
        '<div class="field"><label for="addressMapZone">Zona</label><select id="addressMapZone" onchange="filterAddressMap()"><option value="ALL">Todas as zonas</option>' +
          zones.map((z) => '<option value="' + esc(z.value) + '"' + (z.value === state.zone ? ' selected' : '') + '>' + esc(z.label) + '</option>').join("") +
        '</select></div>' +
        '<div class="field"><label for="addressMapStatus">Ocupação</label><select id="addressMapStatus" onchange="filterAddressMap()"><option value="ALL"' + (state.status === "ALL" ? " selected" : "") + '>Todas as posições</option><option value="FREE"' + (state.status === "FREE" ? " selected" : "") + '>Livres</option><option value="OCCUPIED"' + (state.status === "OCCUPIED" ? " selected" : "") + '>Ocupadas</option></select></div>' +
        '<div class="field"><label for="addressMapSearch">Buscar endereço</label><input id="addressMapSearch" type="search" value="' + esc(state.search) + '" placeholder="Ex.: 1RM06A" oninput="filterAddressMap()"></div>' +
      '</div>' +
      '<div class="address-map-legend"><span><i class="address-map-dot is-free"></i>Livre</span><span><i class="address-map-dot is-occupied"></i>Ocupada</span><small>Os números nas posições representam unidades atualmente alocadas.</small></div>' +
      '<div id="addressMapGrid" class="address-map-grid"></div>' +
    '</section>';
  renderAddressMapGrid();
}

async function changeAddressMapSector(sector) {
  const state = window.addressMapState;
  if (!state || !state.bySector?.[sector]) return;
  state.sector = sector;
  state.zone = "ALL";
  renderAddressMapContent();
}

function filterAddressMap() {
  const state = window.addressMapState;
  if (!state) return;
  state.zone = $("addressMapZone")?.value || "ALL";
  state.status = $("addressMapStatus")?.value || "ALL";
  state.search = $("addressMapSearch")?.value || "";
  renderAddressMapGrid();
}

function renderAddressMapGrid() {
  const state = window.addressMapState;
  const grid = $("addressMapGrid");
  if (!state || !grid) return;
  const normalizedTerm = normalizeSearch(state.search || "");
  const allPositions = addressMapCurrentPositions();
  const positions = allPositions.filter((p) => {
    const occupied = Math.max(0, Number(p.ocupado || 0));
    const zoneMatches = state.zone === "ALL" || String(p.zona) === state.zone;
    const statusMatches = state.status === "ALL" ||
      (state.status === "FREE" && occupied === 0) ||
      (state.status === "OCCUPIED" && occupied > 0);
    const searchMatches = !normalizedTerm ||
      normalizeSearch([p.address, p.setor, p.zona, p.zona_label, p.casulo, p.nivel].join(" ")).includes(normalizedTerm);
    return zoneMatches && statusMatches && searchMatches;
  });

  if (!positions.length) {
    grid.innerHTML = '<div class="position-empty large">Nenhuma posição encontrada com os filtros atuais.</div>';
    return;
  }

  const byZone = new Map();
  positions.forEach((p) => {
    const zoneKey = String(p.zona);
    if (!byZone.has(zoneKey)) byZone.set(zoneKey, new Map());
    const byCasulo = byZone.get(zoneKey);
    const casuloKey = String(p.casulo);
    if (!byCasulo.has(casuloKey)) byCasulo.set(casuloKey, []);
    byCasulo.get(casuloKey).push(p);
  });

  grid.innerHTML = [...byZone.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "pt-BR", { numeric: true }))
    .map(([zoneKey, casulos]) => {
      const zoneRows = allPositions.filter((p) => String(p.zona) === zoneKey);
      const visibleCount = [...casulos.values()].reduce((sum, rows) => sum + rows.length, 0);
      const zoneLabel = zoneRows[0]?.zona_label || ("Zona " + zoneKey);
      const casuloHtml = [...casulos.entries()]
        .sort((a, b) => a[0].localeCompare(b[0], "pt-BR", { numeric: true }))
        .map(([casulo, rows]) =>
          '<div class="position-casulo"><div class="position-casulo-head"><span>CASULO</span><b>' + esc(casulo) + '</b></div><div class="position-levels">' +
          rows.sort((a, b) => String(a.nivel).localeCompare(String(b.nivel))).map((p) => {
            const quantity = Math.max(0, Number(p.ocupado || 0));
            const statusClassName = quantity > 0 ? "is-occupied" : "is-free";
            const title = p.address + " • " + (quantity > 0 ? quantity.toLocaleString("pt-BR") + " unidade(s) alocada(s)" : "Livre");
            return '<div class="position-cell ' + statusClassName + '" title="' + esc(title) + '" aria-label="' + esc(title) + '">' +
              '<span class="position-level">' + esc(p.nivel) + '</span><strong>' + esc(p.address) + '</strong>' +
              '<small>' + (quantity > 0 ? quantity.toLocaleString("pt-BR") + ' alocado(s)' : 'Livre') + '</small></div>';
          }).join("") +
          '</div></div>'
        ).join("");
      return '<section class="position-zone"><div class="position-zone-head"><div><b>' + esc(zoneLabel) + '</b><span>' + casulos.size + ' casulo(s) visível(is)</span></div><small>' + visibleCount + ' posições</small></div><div class="position-casulo-grid address-map-casulos">' + casuloHtml + '</div></section>';
    }).join("");

  const occupied = allPositions.filter((p) => Number(p.ocupado || 0) > 0).length;
  const free = allPositions.length - occupied;
  const allocated = allPositions.reduce((sum, p) => sum + Math.max(0, Number(p.ocupado || 0)), 0);
  if ($("addressMapTotal")) $("addressMapTotal").textContent = allPositions.length.toLocaleString("pt-BR");
  if ($("addressMapFree")) $("addressMapFree").textContent = free.toLocaleString("pt-BR");
  if ($("addressMapOccupied")) $("addressMapOccupied").textContent = occupied.toLocaleString("pt-BR");
  if ($("addressMapAllocated")) $("addressMapAllocated").textContent = allocated.toLocaleString("pt-BR");
}

async function renderCards(scope) {
  const quality = scope === "quality";
  const processing = scope === "processing";
  const labeling = scope === "labeling", storage = scope === "storage";
  const title = quality ? "Qualidade" : processing ? "Processamento" : labeling ? "Etiquetagem" : storage ? "Estocagem" : "Recebimento";
  const subtitle = quality ? "Inspeção ágil e preenchimento guiado" : processing ? "Seleção compacta de materiais" : labeling ? "Grade por tamanho; Saldo por quantidade" : storage ? "Entrada em estoque por tamanho ou saldo geral" : "Controle geral da produção e posição real de cada item";
  setPage(title, subtitle);
  const [cards, dashboardData] = await Promise.all([
    api(`/api/cards?scope=${scope}`),
    ["receiving","quality","processing"].includes(scope) ? api("/api/dashboard") : Promise.resolve(null),
  ]);
  const metrics = dashboardData ? metricCardsHtml(scope, dashboardData.totals) : "";
  if (["receiving","quality","processing","labeling","storage"].includes(scope)) {
    const tabs = storage ? moduleTabs([["Visão geral","storage-hub"],["Fila operacional","storage"]],"storage") : processing ? processingTabs("processing") : "";
    $("mainContent").innerHTML = tabs + metrics + processingQueueHtml(cards, scope);
    filterProductionQueue();
    return;
  }
  $("mainContent").innerHTML = `
    <div class="toolbar">
      <input id="cardSearch" placeholder="Pesquisar compra, fornecedor, marca ou Casulo" onkeydown="if(event.key==='Enter') searchCards('${scope}')">
      <button class="primary" onclick="searchCards('${scope}')">Pesquisar</button>
    </div>
    <div class="panel"><div class="table-wrap"><table>
      <thead><tr><th>Compra</th><th>Fornecedor</th><th>Marca</th><th>Tipo</th><th>Itens</th><th>Qtd. esperada</th><th>Casulo</th><th>Status</th><th></th></tr></thead>
      <tbody id="cardsBody">${cardRows(cards, scope)}</tbody>
    </table></div></div>`;
}

function processingQueueHtml(cards, scope=currentView) {
  const tab = ["receiving","quality","processing","labeling","storage"].includes(scope) ? scope : "processing";
  const brands = [...new Set(cards.map((c)=>c.brand).filter(Boolean))].sort();
  return `<div class="work-queue">
    <div class="queue-toolbar">
      <div class="queue-search"><span>⌕</span><input id="productionMaterialSearch" placeholder="Compra, fornecedor, marca, produto ou Casulo" oninput="filterProductionQueue()"></div>
      <select id="productionTypeFilter" onchange="filterProductionQueue()"><option value="">Todos os tipos</option><option value="GRADE">Grade</option><option value="SALDO">Saldo</option></select>
      <select id="productionStatusFilter" onchange="filterProductionQueue()"><option value="">Todos os status</option><option value="AGUARDANDO">Aguardando</option><option value="ATIVO">Em produção</option><option value="PAUSADO">Pausados</option></select>
      <select id="productionBrandFilter" onchange="filterProductionQueue()"><option value="">Todas as marcas</option>${brands.map((b)=>`<option value="${esc(b)}">${esc(b)}</option>`).join("")}</select>
      <button class="ghost" onclick="clearProductionFilters()">Limpar</button>
    </div>
    <div class="queue-counter"><b id="productionVisibleCount">${cards.length}</b> materiais encontrados <span>• selecione uma linha para continuar</span></div>
    <div class="panel queue-panel"><div class="table-wrap queue-table-wrap"><table class="compact-table production-queue-table">
      <thead><tr><th class="select-col"></th><th>Material / compra</th><th>Fornecedor</th><th>Marca</th><th>Tipo</th><th>Itens</th><th>Qtd.</th><th>Casulo</th><th>Status</th><th></th></tr></thead>
      <tbody id="productionQueueBody">${cards.map((card)=>productionQueueRow(card,tab)).join("") || '<tr><td colspan="10">Nenhum material disponível.</td></tr>'}</tbody>
    </table></div></div>
    <div id="productionSelectionBar" class="selection-bar hidden"><div><span>Material selecionado</span><b id="productionSelectionLabel"></b></div><div class="actions"><button class="ghost" onclick="clearProductionSelection()">Cancelar</button><button class="primary" onclick="openSelectedProduction('${tab}')">Abrir controle →</button></div></div>
  </div>`;
}

function productionActivity(card, tab="processing") {
  const status=String(card.status||"");
  if (tab==="receiving") {
    if (card.receiving_activity==="PAUSADA") return "PAUSADO";
    if (card.receiving_activity==="EM_ANDAMENTO") return "ATIVO";
    return "AGUARDANDO";
  }
  if (tab==="quality") {
    if (status==="INSPECAO_PAUSADA") return "PAUSADO";
    if (["EM_INSPECAO","AGUARDANDO_CONCLUSAO_QUALIDADE"].includes(status)) return "ATIVO";
    return "AGUARDANDO";
  }
  if (tab==="processing") return status==="EM_PROCESSAMENTO" ? "ATIVO" : status==="PROCESSAMENTO_PAUSADO" ? "PAUSADO" : "AGUARDANDO";
  return "AGUARDANDO";
}

function productionQueueRow(card,tab="processing") {
  const searchable = [card.reference_list,card.purchase_id,card.supplier,card.brand,card.casulo_current,card.original_type,card.material_search].join(" ").toLowerCase();
  const activity = productionActivity(card,tab);
  const reference = String(card.reference_list || "").trim() || String(card.purchase_id || "");
  return `<tr class="production-material-row" tabindex="0" data-id="${card.id}" data-label="${esc(reference)} — ${esc(card.brand||card.supplier||'Sem marca')}" data-search="${esc(searchable)}" data-type="${esc(card.purchase_mode||'')}" data-status="${activity}" data-brand="${esc(card.brand||'')}" onclick="selectProductionMaterial(${card.id})" ondblclick="openCard(${card.id},'${tab}')" onkeydown="if(event.key==='Enter')openCard(${card.id},'${tab}')">
    <td class="select-col"><span class="row-selector"></span></td><td><b style="white-space:normal;word-break:break-word;">${esc(reference)}</b></td><td>${esc(card.supplier||"—")}</td><td>${esc(card.brand||"—")}</td><td><span class="type-pill">${card.purchase_mode === "GRADE" ? "Grade" : "Saldo"}</span></td><td>${card.item_count}</td><td><b>${card.expected_total}</b></td><td>${esc(card.casulo_current||"—")}</td><td><span class="badge ${statusClass(card.status)}">${esc(card.status_label)}</span></td><td>${tab === "receiving" && card.in_transit && currentUser?.role === "recebimento" ? `<button class="success small-btn" onclick="event.stopPropagation();markArrived(${card.id},true)">Marcar como recebido</button> ` : ""}<button class="row-open" onclick="event.stopPropagation();openCard(${card.id},'${tab}')" aria-label="Abrir material">›</button></td></tr>`;
}

function filterProductionQueue() {
  const search=normalizeSearch($("productionMaterialSearch")?.value||""),type=$("productionTypeFilter")?.value||"",status=$("productionStatusFilter")?.value||"",brand=$("productionBrandFilter")?.value||"";
  let visible=0;
  document.querySelectorAll(".production-material-row").forEach((row)=>{const show=(!search||normalizeSearch(row.dataset.search).includes(search))&&(!type||row.dataset.type===type)&&(!status||row.dataset.status===status)&&(!brand||row.dataset.brand===brand);row.classList.toggle("hidden",!show);if(show)visible++;});
  if (selectedProductionCardId && document.querySelector(`.production-material-row[data-id="${selectedProductionCardId}"]`)?.classList.contains("hidden")) clearProductionSelection();
  if ($("productionVisibleCount")) $("productionVisibleCount").textContent=visible;
}
function normalizeSearch(value){return String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();}
function clearProductionFilters(){["productionMaterialSearch","productionTypeFilter","productionStatusFilter","productionBrandFilter"].forEach((id)=>{if($(id))$(id).value=""});filterProductionQueue();}
function selectProductionMaterial(id){selectedProductionCardId=id;document.querySelectorAll(".production-material-row").forEach((row)=>row.classList.toggle("selected",Number(row.dataset.id)===id));const row=document.querySelector(`.production-material-row[data-id="${id}"]`);$("productionSelectionLabel").textContent=row?.dataset.label||"";$("productionSelectionBar").classList.remove("hidden");}
function clearProductionSelection(){selectedProductionCardId=null;document.querySelectorAll(".production-material-row").forEach((row)=>row.classList.remove("selected"));$("productionSelectionBar")?.classList.add("hidden");}
function openSelectedProduction(tab="processing"){if(selectedProductionCardId)openCard(selectedProductionCardId,tab);}

function cardRows(cards, scope="receiving") {
  const tab = scope === "quality" ? "quality" : scope === "processing" ? "processing" : scope === "labeling" ? "labeling" : scope === "storage" ? "storage" : "receiving";
  return cards.map((card) => `
    <tr><td><b>${esc(card.purchase_id)}</b></td><td>${esc(card.supplier||"—")}</td><td>${esc(card.brand||"—")}</td>
    <td>${esc(card.purchase_mode === "GRADE" ? "Grade" : card.purchase_mode === "SALDO" ? "Saldo" : card.original_type||"—")}</td><td>${card.item_count}</td><td>${card.expected_total}</td><td>${esc(card.casulo_current||"—")}</td>
    <td><span class="badge ${statusClass(card.status)}">${esc(card.status_label)}</span></td>
    <td><button class="primary small-btn" onclick="openCard(${card.id},'${tab}')">Abrir Card</button></td></tr>
  `).join("") || '<tr><td colspan="9">Nenhum Card nesta lista.</td></tr>';
}

async function searchCards(scope) {
  const cards = await api(`/api/cards?scope=${scope}&search=${encodeURIComponent($("cardSearch").value)}`);
  $("cardsBody").innerHTML = cardRows(cards, scope);
}

async function renderImport() {
  setPage("Importar Excel", "Leitura completa das compras operacionais");
  const imports = await api("/api/imports");
  const allowed = currentUser.role === "admin";
  $("mainContent").innerHTML = `
    <div class="panel"><div class="panel-header">Relatório de Compras</div><div class="panel-body">
      <div class="notice">O sistema lê compras em <b>Trânsito</b> ou <b>Operações</b>, identifica a posição real de cada item e mantém o Card no <b>Recebimento</b>. A coluna <b>Tipo</b> classifica: <b>Private Label = Grade</b> e <b>Saldo = Saldo</b>.</div>
      ${allowed ? `<div class="import-zone"><h3>Selecione o arquivo oficial</h3><p>Há um arquivo para teste na pasta <b>arquivo_teste</b>.</p><input id="excelFile" type="file" accept=".xlsx,.xlsm"><br><button class="primary" onclick="uploadExcel()">Importar</button><div id="importResult"></div></div>` : '<div class="notice warn">Somente o Administrador pode importar arquivos.</div>'}
    </div></div>
    <div class="panel" style="margin-top:14px"><div class="panel-header">Últimas importações</div><div class="table-wrap"><table>
      <thead><tr><th>Arquivo</th><th>Linhas</th><th>Operacionais</th><th>Cards criados</th><th>Atualizados</th><th>Itens criados</th><th>Data</th></tr></thead>
      <tbody>${imports.map((row) => `<tr><td>${esc(row.filename)}</td><td>${row.total_rows}</td><td>${row.matched_rows}</td><td>${row.cards_created}</td><td>${row.cards_updated}</td><td>${row.items_created}</td><td>${fmtDateTime(row.created_at)}</td></tr>`).join("") || '<tr><td colspan="7">Nenhuma importação.</td></tr>'}</tbody>
    </table></div></div>`;
}

async function uploadExcel() {
  const file = $("excelFile").files[0];
  if (!file) return toast("Selecione o arquivo Excel.");
  const form = new FormData();
  form.append("file", file);
  $("importResult").innerHTML = '<div class="notice">Importando e agrupando os Cards...</div>';
  try {
    const response = await fetch(`/api/import-excel?user_id=${currentUser.id}`, { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Erro na importação.");
    $("importResult").innerHTML = `<div class="notice success-box"><b>Importação concluída.</b><br>Linhas lidas: ${data.total_rows}<br>Linhas operacionais: ${data.matched_rows}<br>Cards criados: ${data.cards_created}<br>Cards atualizados: ${data.cards_updated}<br>Itens criados: ${data.items_created}<br>Itens atualizados: ${data.items_updated}<br>Cards CD02 removidos: ${data.cards_removed_cd02||0}<br>Erros: ${data.errors.length}</div>`;
    toast("Importação concluída.");
  } catch (error) {
    $("importResult").innerHTML = `<div class="notice error">${esc(error.message)}</div>`;
  }
}

async function renderTestTools() {
  setPage("Ferramentas de teste", "Retorno da Costura CD01 e acesso rápido ao Processamento");
  if (currentUser.role !== "admin") {
    $("mainContent").innerHTML = '<div class="notice warn">Somente o Administrador acessa as simulações.</div>';
    return;
  }
  const [receiving, quality, processing, outside] = await Promise.all([
    api("/api/cards?scope=receiving"), api("/api/cards?scope=quality"), api("/api/cards?scope=processing"), api("/api/cards?scope=outside")
  ]);
  const costuraCards = receiving.filter((card) => card.status === "EM_COSTURA_CD01");
  const allCards = [...receiving, ...quality, ...processing, ...outside];
  const processingCandidates = allCards.filter((card) => card.status !== "DESPACHO_CD02" && card.current_sector !== "PROCESSAMENTO");
  $("mainContent").innerHTML = `
    <div class="actions" style="justify-content:flex-end;margin-bottom:12px"><button class="primary" onclick="openGoatCardModal(true)">+ Criar Card de teste</button></div>
    <div class="notice">Crie um Card de teste diretamente no setor desejado ou use as ferramentas abaixo para simular movimentações. Esses recursos são exclusivos do Administrador.</div>
    <div class="panel"><div class="panel-header">Retorno da Costura CD01</div><div class="table-wrap"><table>
      <thead><tr><th>Compra</th><th>Fornecedor</th><th>Status</th><th>Destino</th><th>Ações</th></tr></thead>
      <tbody>${costuraCards.map((card) => `
        <tr><td><b>${esc(card.purchase_id)}</b></td><td>${esc(card.supplier||"—")}</td><td><span class="badge ${statusClass(card.status)}">${esc(card.status_label)}</span></td><td>${esc(card.quality_destination||"—")}</td>
        <td><button class="success small-btn" onclick="simulateReturn(${card.id})">Registrar retorno CD01</button></td></tr>
      `).join("") || '<tr><td colspan="5">Nenhum Card em Costura CD01.</td></tr>'}</tbody>
    </table></div></div>
    <div class="panel" style="margin-top:14px"><div class="panel-header">Enviar diretamente ao Processamento para teste</div><div class="table-wrap"><table>
      <thead><tr><th>Compra</th><th>Fornecedor</th><th>Tipo</th><th>Setor atual</th><th>Status</th><th>Ações</th></tr></thead>
      <tbody>${processingCandidates.map((card) => `
        <tr><td><b>${esc(card.purchase_id)}</b></td><td>${esc(card.supplier||"—")}</td><td>${esc(card.purchase_mode === "GRADE" ? "Grade" : card.purchase_mode === "SALDO" ? "Saldo" : "Não reconhecido")}</td><td>${esc(card.current_sector)}</td><td><span class="badge ${statusClass(card.status)}">${esc(card.status_label)}</span></td>
        <td><select id="testMode${card.id}" class="small-btn"><option value="GRADE">Grade</option><option value="SALDO">Saldo</option></select> <button class="primary small-btn" onclick="simulateSendProcessing(${card.id})">Enviar ao Processamento</button></td></tr>
      `).join("") || '<tr><td colspan="6">Nenhum Card disponível.</td></tr>'}</tbody>
    </table></div></div>`;
}

async function simulateReturn(cardId) {
  try {
    await api(`/api/test/cards/${cardId}/costura-return`, { method: "POST", body: JSON.stringify({ user_id: currentUser.id }) });
    toast("Retorno CD01 enviado ao Recebimento.");
    renderTestTools();
  } catch (error) { toast(error.message); }
}

async function simulateSendProcessing(cardId) {
  if (!confirm("Enviar este Card diretamente ao Processamento somente para teste?")) return;
  try {
    await api(`/api/test/cards/${cardId}/send-processing`, { method: "POST", body: JSON.stringify({ user_id: currentUser.id, purchase_mode: document.getElementById("testMode"+cardId)?.value }) });
    toast("Card enviado ao Processamento para teste.");
    renderTestTools();
  } catch (error) { toast(error.message); }
}

async function renderGlobalHistory() {
  setPage("Histórico", "Todas as movimentações do Card único");
  const rows = await api("/api/history?limit=500");
  $("mainContent").innerHTML = `<div class="panel"><div class="panel-header">Últimos eventos</div><div class="panel-body"><div class="timeline">
    ${rows.map((event) => `<div class="timeline-event"><b>Compra ${esc(event.purchase_id)} — ${esc(event.description)}</b><br><small>${fmtDateTime(event.created_at)} ${event.user_name ? "• "+esc(event.user_name) : ""}</small></div>`).join("") || '<div class="notice">Nenhum evento.</div>'}
  </div></div></div>`;
}
async function deleteCard(cardId){
  if(currentUser?.role!=="admin"){
    toast("Somente o Administrador pode excluir Cards.");
    return;
  }
  const id=Number(cardId);
  const label=cardData?.purchase_id || ("#" + id);
  if(!confirm("Excluir definitivamente o Card "+label+"?\n\nIsso removerá o card, seus itens, andamento e alocações físicas.")) return;
  try{
    const result=await api("/api/cards/"+id+"?user_id="+encodeURIComponent(currentUser.id),{method:"DELETE"});
    toast("Card "+(result.purchase_id||label)+" excluído.");
    $("modal")?.classList.add("hidden");
    currentCardId=null;
    cardData=null;
    await renderCards(currentView||"receiving");
  }catch(e){
    toast(e.message||"Não foi possível excluir o Card.");
  }
}
async function setCardPurchaseMode(mode) {
  if (!mode) return;
  try {
    const activeId = document.querySelector(".tabs button.active")?.id || "";
    const tabByBtn = { 
      tabQualityBtn: "quality", 
      tabProcessingBtn: "processing", 
      tabLabelingBtn: "labeling", 
      tabStorageBtn: "storage", 
      tabCasuloBtn: "casulo", 
      tabProductsBtn: "products", 
      tabHistoryBtn: "history" 
    };
    await api(`/api/cards/${currentCardId}/purchase-mode`, { 
      method: "POST", 
      body: JSON.stringify({ user_id: currentUser.id, purchase_mode: mode }) 
    });
    toast("Tipo da compra definido.");
    await openCard(currentCardId, tabByBtn[activeId] || "receiving");
  } catch (error) { 
    toast(error.message); 
  }
}

function cardLocationBannerHtml(rows, failed=false, loading=false, currentSector="") {
  if (loading) {
    return '<section class="card-location-banner" aria-label="Localização da mercadoria"><div class="card-location-heading"><span>LOCALIZAÇÃO DA MERCADORIA</span><small>Endereços físicos registrados</small></div><div class="card-location-empty"><span class="card-location-pulse"></span>Consultando endereços atuais…</div></section>';
  }
  if (failed) {
    return '<section class="card-location-banner" aria-label="Localização da mercadoria"><div class="card-location-heading"><span>LOCALIZAÇÃO DA MERCADORIA</span><small>Endereços físicos registrados</small></div><div class="card-location-empty">Não foi possível carregar a localização agora. Os demais dados do Card continuam disponíveis.</div></section>';
  }
  const sectorLabels = {RM:"Recebimento / Matéria-prima",QA:"Qualidade",PR:"Processamento",ET:"Etiquetagem",EC:"Estocagem",QUALIDADE:"Qualidade"};
  const locations = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    // A trilha inclui o histórico; este painel deve mostrar apenas alocações ainda ativas.
    const activeValue = row.active;
    const inactive = activeValue === false || activeValue === 0 ||
      (typeof activeValue === "string" && ["false", "0", "f"].includes(activeValue.trim().toLowerCase()));
    if (inactive) return;

    const sector = String(row.setor || "").trim().toUpperCase();
    const address = String(row.address || "").trim();
    const qty = Number(row.quantidade || 0);
    if (!sector || !address || !Number.isFinite(qty) || qty <= 0) return;
    const volumeOnly = row.item_id === null || row.item_id === undefined;
    const sampleLocation = row.allocation_purpose === "TEN_PERCENT_SAMPLE" || (sector === "QA" && volumeOnly);
    const label = address === "QUALIDADE (10%)"
      ? "Amostra reservada na Qualidade"
      : sampleLocation
        ? (sector === "QA" ? "Amostra dos 10% · Qualidade" : "Amostra dos 10% · junto ao saldo")
        : (sectorLabels[sector] || sector);
    const unit = volumeOnly ? "volume(s)" : "peça(s)";
    const key = [sector,address,label,unit].join("|");
    const location = locations.get(key) || {sector,address,label,unit,quantity:0};
    location.quantity += qty;
    locations.set(key,location);
  });
  const priority = {QA:0,QUALIDADE:0,RM:1,RECEBIMENTO:1,PR:2,PROCESSAMENTO:2,ET:3,ETIQUETAGEM:3,EC:4,ESTOCAGEM:4};
  const sectorMap = {RECEBIMENTO:"RM",QUALIDADE:"QA",PROCESSAMENTO:"PR",ETIQUETAGEM:"ET",ESTOCAGEM:"EC"};
  const preferred = sectorMap[String(currentSector || "").toUpperCase()] || String(currentSector || "").toUpperCase();
  const sorted = [...locations.values()].sort((a,b) => {
    const ap = a.sector === preferred ? -1 : (priority[a.sector] ?? 9);
    const bp = b.sector === preferred ? -1 : (priority[b.sector] ?? 9);
    return ap-bp || a.address.localeCompare(b.address, "pt-BR");
  });
  const body = sorted.length
    ? '<div class="card-location-addresses">' + sorted.map((location) =>
        '<div class="card-location-address"><div class="card-location-address-main"><strong>' +
          esc(location.address) + '</strong><span>' + esc(location.label) +
        '</span></div><div class="card-location-quantity"><b>' +
          Number(location.quantity).toLocaleString("pt-BR") + '</b><small>' + esc(location.unit) +
        '</small></div></div>'
      ).join("") + '</div>'
    : '<div class="card-location-empty"><b>Endereçamento ainda não registrado</b><span>As posições da mercadoria aparecerão aqui assim que forem alocadas.</span></div>';
  return '<section class="card-location-banner" aria-label="Localização da mercadoria"><div class="card-location-heading"><span>LOCALIZAÇÃO DA MERCADORIA</span><small>' +
    (sorted.length ? sorted.length + ' localização(ões) física(s)' : 'Nenhum endereço registrado') +
    '</small></div>' + body + '</section>';
}

async function openCard(cardId, tab = "receiving") {
  currentCardId = cardId;
  const locationRequestId = Number(window.cardLocationRequestId || 0) + 1;
  window.cardLocationRequestId = locationRequestId;
  window.qaSampleAllocationRequired = false;
  window.qaSampleAllocationComplete = true;
  const modalWasHidden = $("modal").classList.contains("hidden");
  if (modalWasHidden) {
    // Abre o Card na hora, com aviso de carregamento, enquanto os dados chegam do Supabase.
    $("modalBody").innerHTML = '<div class="loading-panel"><div class="loading-head"><span class="loading-spinner"></span><b>Carregando dados do card…</b></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>';
    $("modal").classList.remove("hidden");
  }
  try {
    cardData = await api(`/api/cards/${cardId}`);
  } catch (error) {
    if (modalWasHidden) $("modal").classList.add("hidden");
    throw error;
  }
  const currentReceiving = cardData.receiving || {};
  window.qaSampleAllocationRequired = Boolean(
    !cardData.source_snapshot_at &&
    cardData.current_sector === "QUALIDADE" &&
    currentReceiving.ten_percent_required &&
    currentReceiving.ten_percent_status === "CONCLUIDA" &&
    currentReceiving.receiving_type !== "COSTURA" &&
    currentReceiving.receiving_type !== "RETORNO"
  );
  window.qaSampleAllocationComplete = !window.qaSampleAllocationRequired;
  if (window.qaSampleAllocationRequired) {
    // Do not assume the QA sample is unallocated whenever the Card is reopened.
    // Re-read the physical allocation state; otherwise creating an inspection succeeds
    // but the next render incorrectly forces the operator back to the Receiving tab.
    try {
      const allocationStatus = await apiWithTimeout(
        `/api/positions/cards/${cardId}/status?setor=QA`
      );
      const totalVolumes = Number(currentReceiving.volumes ?? allocationStatus.volumes_total ?? 0);
      const requiredSampleVolumes = totalVolumes > 0 ? 1 : 0;
      const allocatedSampleVolumes = Number(allocationStatus.ten_percent_sample_allocated || 0);
      window.qaSampleAllocationComplete =
        requiredSampleVolumes > 0 && allocatedSampleVolumes >= requiredSampleVolumes;
    } catch (error) {
      window.qaSampleAllocationComplete = false;
      console.warn("Não foi possível verificar a alocação dos 10% na Qualidade:", error);
    }
  }
  receivingPhotos = cardData.receiving?.photo_paths || [];
  dispatchPhotos = cardData.dispatch?.photo_paths || [];
  const cardReference = String(
    cardData.manual_reference ||
    cardData.items?.find((item) => String(item.reference || "").trim())?.reference ||
    ""
  ).trim();
  const cardDisplayName = cardReference || cardData.purchase_id;
  const canSetPurchaseMode = (cardData.current_sector === "RECEBIMENTO" && ["recebimento", "supervisor", "admin"].includes(currentUser.role)) ||
    canOperateQuality();
  $("modalBody").innerHTML = `
    <div class="card-title"><div><h2>Card ${esc(cardDisplayName)}</h2><div class="card-subtitle">${esc(cardData.supplier||"—")} • ${esc(cardData.brand||"—")} • ${cardData.expected_total} peças</div></div><div class="card-title-actions"><span class="badge ${statusClass(cardData.status)}">${esc(cardData.status_label)}</span>${currentUser?.role==="admin"?`<button class="danger small-btn" onclick="deleteCard(${cardData.id})">Excluir Card</button>`:""}</div></div>
    <div id="cardLocationSlot">${cardLocationBannerHtml(null,false,true)}</div>
    <div class="summary-grid">
      <div class="summary-box"><span>Setor atual</span><strong>${esc(cardData.current_sector)}</strong></div>
      <div class="summary-box"><span>Tipo de entrada</span><strong>${cardData.receiving_type === "RETORNO" ? "Retorno da Costura" : "Mercadoria nova"}</strong></div>
      <div class="summary-box"><span>Tipo da compra</span>${["GRADE", "SALDO"].includes(cardData.purchase_mode)     ? `<strong>${cardData.purchase_mode === "GRADE" ? "Grade" : "Saldo"}</strong>`     : (canSetPurchaseMode         ? `<select id="cardPurchaseMode" onchange="setCardPurchaseMode(this.value)"><option value="">Não reconhecido — definir</option><option value="GRADE">Grade</option><option value="SALDO">Saldo</option></select>`         : "<strong>Não reconhecido</strong>")}</div>
      <div class="summary-box"><span>Itens</span><strong>${cardData.items.length}</strong></div>
      <div class="summary-box"><span>Quantidade esperada</span><strong>${cardData.expected_total}</strong></div>
      <div class="summary-box"><span>Volumes</span><strong>${cardData.receiving?.volumes ?? cardData.receiving?.volume_count ?? "Não informado"}</strong></div>
      <div class="summary-box"><span>Casulo atual</span><strong>${esc(cardData.casulo_current||"Não informado")}</strong></div>
    </div>
    <div class="tabs">
      <button id="tabReceivingBtn" onclick="renderReceivingTab()">Recebimento</button>
      <button id="tabQualityBtn" onclick="renderQualityTab()">Qualidade</button>
      <button id="tabProcessingBtn" onclick="renderProcessingTab()">Processamento</button>
      <button id="tabLabelingBtn" onclick="renderDownstreamTab('ETIQUETAGEM')">Etiquetagem</button>
      <button id="tabStorageBtn" onclick="renderDownstreamTab('ESTOCAGEM')">Estocagem</button>
      <button id="tabCasuloBtn" onclick="renderCasuloTab()">Casulo</button>
      <button id="tabProductsBtn" onclick="renderProductsTab()">Produtos</button>
      <button id="tabHistoryBtn" onclick="renderCardHistory()">Histórico</button>
    </div>
    <div id="cardTab"></div>`;
  $("modal").classList.remove("hidden");
  // Fetch physical locations without blocking the Card modal or its tabs.
  apiWithTimeout(`/api/positions/cards/${cardId}/trail`, 8000)
    .then((rows) => {
      if (window.cardLocationRequestId !== locationRequestId || Number(currentCardId) !== Number(cardId)) return;
      const slot = $("cardLocationSlot");
      if (slot) slot.innerHTML = cardLocationBannerHtml(rows, false, false, cardData?.current_sector || "");
    })
    .catch((error) => {
      if (window.cardLocationRequestId !== locationRequestId || Number(currentCardId) !== Number(cardId)) return;
      const slot = $("cardLocationSlot");
      if (slot) slot.innerHTML = cardLocationBannerHtml(null, true);
      console.warn("Não foi possível consultar os endereços do Card:", error);
    });
  if (tab === "casulo") renderCasuloTab();
  else if (tab === "quality") renderQualityTab();
  else if (tab === "processing") renderProcessingTab();
  else if (tab === "labeling") renderDownstreamTab("ETIQUETAGEM");
  else if (tab === "storage") renderDownstreamTab("ESTOCAGEM");
  else if (tab === "products") renderProductsTab();
  else if (tab === "history") renderCardHistory();
  else renderReceivingTab();
}

function activateTab(id) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
  $(id)?.classList.add("active");
}

function guardSampleAllocationNavigation() {
  if (!window.qaSampleAllocationRequired || window.qaSampleAllocationComplete) return false;
  toast("Antes de continuar, enderece obrigatoriamente os 10% em uma posição da Qualidade.");
  if (currentCardId && $("cardTab")) renderReceivingTab();
  return true;
}

function canOperateReceiving() {
  return currentUser.role === "recebimento" && cardData.current_sector === "RECEBIMENTO";
}

function qualityReadOnlyPreviewHtml() {
  const items = (cardData.items || []).slice(0, 8);
  const rows = items.map((item) => '<tr><td>' + esc(item.product || '—') + '</td><td>' + esc(item.reference || '—') + '</td><td>' + esc(item.color || '—') + '</td><td>' + esc(item.size || '—') + '</td><td>' + Number(item.expected_qty || 0).toLocaleString('pt-BR') + '</td></tr>').join('');
  return '<div class="panel-body">' +
    '<div class="notice warn"><b>Visualização somente leitura.</b><br>Setor responsável: <b>' + esc(cardData.current_sector || 'Não definido') + '</b>. Ações operacionais ficam disponíveis somente para o setor responsável.</div>' +
    '<div class="summary-grid">' +
      '<div class="summary-box"><span>Compra</span><strong>' + esc(cardData.purchase_id || '—') + '</strong></div>' +
      '<div class="summary-box"><span>Fornecedor</span><strong>' + esc(cardData.supplier || '—') + '</strong></div>' +
      '<div class="summary-box"><span>Marca</span><strong>' + esc(cardData.brand || '—') + '</strong></div>' +
      '<div class="summary-box"><span>Tipo da compra</span><strong>' + esc(cardData.purchase_mode === 'GRADE' ? 'Grade' : cardData.purchase_mode === 'SALDO' ? 'Saldo' : 'Não reconhecido') + '</strong></div>' +
      '<div class="summary-box"><span>Itens</span><strong>' + (cardData.items || []).length + '</strong></div>' +
      '<div class="summary-box"><span>Quantidade esperada</span><strong>' + Number(cardData.expected_total || 0).toLocaleString('pt-BR') + '</strong></div>' +
      '<div class="summary-box"><span>Status</span><strong>' + esc(cardData.status_label || cardData.status || '—') + '</strong></div>' +
    '</div>' +
    '<h3 class="section-heading">Resumo dos itens</h3>' +
    '<div class="table-wrap"><table><thead><tr><th>Produto</th><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Quantidade</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="5">Nenhum item disponível para consulta.</td></tr>') +
    '</tbody></table></div>' +
    ((cardData.items || []).length > 8 ? '<div class="notice">Exibindo os primeiros 8 itens. A aba Produtos contém a lista completa.</div>' : '') +
    '</div>';
}
function canOperateQuality() {
  if (!currentUser || !cardData) return false;
  if (!["qualidade", "supervisor", "admin"].includes(currentUser.role)) return false;
  if (cardData.current_sector === "QUALIDADE") return true;
  return Boolean(cardData.source_snapshot_at && (cardData.items || []).some((item) =>
    ["QUALIDADE", "QUALIDADE_RETRABALHO", "QUALIDADE_REJEITADO"].includes(item.source_stage) && Number(item.expected_qty || 0) > 0
  ));
}

function canDistributeQuality() {
  return ["supervisor", "admin"].includes(currentUser.role);
}

function canOperateProcessing() {
  return ["processamento", "supervisor", "admin"].includes(currentUser.role);
}

function canDistributeProcessing() {
  return ["supervisor", "admin"].includes(currentUser.role);
}

function transitHtml() {
  const operate = canOperateReceiving();
  const items = cardData.items || [];
  const nfs = [...new Set(items.map((i) => i.nf).filter(Boolean))].join(", ") || "—";
  const lots = [...new Set(items.map((i) => i.lot).filter(Boolean))].join(", ") || "—";
  return `<div class="panel-body">
    <div class="notice warn"><b>Mercadoria em trânsito</b><br>O Card fica no Recebimento até você confirmar que a mercadoria chegou ao CD. Depois disso ficam liberados o recebimento físico e a separação dos 10%.</div>
    <div class="form-grid">
      <div class="field"><label>Compra</label><input class="readonly" readonly value="${esc(cardData.purchase_id)}"></div>
      <div class="field"><label>Fornecedor</label><input class="readonly" readonly value="${esc(cardData.supplier || "—")}"></div>
      <div class="field"><label>Lote</label><input class="readonly" readonly value="${esc(lots)}"></div>
      <div class="field"><label>Nota fiscal</label><input class="readonly" readonly value="${esc(nfs)}"></div>
      <div class="field"><label>Quantidade esperada</label><input class="readonly" readonly value="${cardData.expected_total}"></div>
      <div class="field"><label>Status</label><input class="readonly" readonly value="${esc(cardData.status_label)}"></div>
    </div>
    <div class="actions">${operate
      ? `<button class="success" onclick="markArrived(${cardData.id})">Marcar como recebido</button>`
      : '<span class="badge gray">Somente o operador de Recebimento pode marcar a chegada</span>'}</div>
  </div>`;
}

async function markArrived(cardId, fromList = false) {
  if (!confirm("Confirmar que esta mercadoria chegou ao CD?")) return;
  try {
    await api(`/api/cards/${cardId}/mark-arrived`, { method:"POST", body:JSON.stringify({ user_id:currentUser.id }) });
    toast("Mercadoria marcada como recebida. Recebimento liberado.");
    if (fromList) await renderCards("receiving");
    else await openCard(cardId);
  } catch (error) { toast(error.message); }
}

function renderReceivingTab() {
  activateTab("tabReceivingBtn");
  if (cardData.in_transit) {
    window.sourceAllowedStages = null;
    $("cardTab").innerHTML = transitHtml();
    return;
  }
  if (cardData.source_snapshot_at && !cardData.receiving) {
    window.sourceAllowedStages=null;
    $("cardTab").innerHTML = sourceLocationHtml();
    return;
  }
  const canShowSampleAllocation = cardData.receiving?.ten_percent_status === "CONCLUIDA"
    && cardData.receiving?.ten_percent_required
    && cardData.receiving?.receiving_type !== "COSTURA"
    && cardData.receiving?.receiving_type !== "RETORNO";
  if (cardData.source_snapshot_at && cardData.current_sector !== "RECEBIMENTO" && !canShowSampleAllocation) {
    window.sourceAllowedStages=null;
    $("cardTab").innerHTML = `<div class="notice"><b>Andamento local preservado:</b> ${esc(cardData.current_sector)} — ${esc(cardData.status_label)}.</div>${sourceLocationHtml()}`;
    return;
  }
  if (cardData.current_sector !== "RECEBIMENTO" && !canShowSampleAllocation) {
    $("cardTab").innerHTML = outsideReceivingHtml();
    return;
  }
  if (cardData.status === "AGUARDANDO_DESPACHO_COSTURA") {
    $("cardTab").innerHTML = dispatchHtml();
    return;
  }
  if (cardData.status === "AGUARDANDO_RECEBIMENTO_RETORNO") {
    $("cardTab").innerHTML = receivingFormHtml(true);
    window.setTimeout(refreshTimerDisplay, 500);
    if (cardData.receiving?.receiving_type === "RETORNO") loadReturnAllocationStep(cardData.id);
    else if (cardData.receiving?.ten_percent_required && cardData.receiving?.ten_percent_status === "CONCLUIDA" && cardData.receiving?.receiving_type !== "COSTURA") loadReceivingAllocationStep(cardData.id);
    return;
  }
  if (cardData.status === "EM_COSTURA_CD01" || cardData.receiving?.receiving_type === "COSTURA") {
    $("cardTab").innerHTML = inCosturaHtml();
    return;
  }
  const isReturn = cardData.receiving?.receiving_type === "RETORNO" || cardData.receiving_type === "RETORNO";
  $("cardTab").innerHTML = receivingFormHtml(isReturn);
  window.setTimeout(refreshTimerDisplay, 500);
  if (isReturn) loadReturnAllocationStep(cardData.id);
  else if (cardData.receiving?.ten_percent_required && cardData.receiving?.ten_percent_status === "CONCLUIDA" && cardData.receiving?.receiving_type !== "COSTURA") loadReceivingAllocationStep(cardData.id);
}

function sourceLocationHtml() {
  const stages = {};
  cardData.items.forEach((i)=>stages[i.source_stage]=(stages[i.source_stage]||0)+1);
  return `<div class="panel-body"><div class="notice success-box"><b>Card mantido no Recebimento</b><br>Esta é a fotografia do último relatório importado. A posição é controlada por item/tamanho, inclusive quando uma mesma compra está dividida entre etapas.</div>
    <div class="stage-chips">${Object.entries(stages).map(([s,n])=>`<button class="stage-chip" onclick="filterSourceItems('${esc(s)}')"><b>${n}</b> ${esc(sourceStageLabel(s))}</button>`).join("")}<button class="stage-chip" onclick="filterSourceItems('')">Mostrar todos</button></div>
    <div class="queue-search source-search"><span>⌕</span><input id="sourceItemSearch" placeholder="Produto, referência, cor, tamanho ou costureiro" oninput="filterSourceItems()"></div>
    <div class="table-wrap source-items"><table class="compact-table"><thead><tr><th>Produto</th><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Qtd.</th><th>Posição</th><th>Costureiro</th></tr></thead><tbody>
    ${cardData.items.map((i)=>`<tr class="source-item-row" data-stage="${esc(i.source_stage)}" data-search="${esc([i.product,i.reference,i.sku,i.color,i.size,i.source_seamstress].join(' ').toLowerCase())}"><td><b>${esc(i.product||'—')}</b></td><td>${esc(i.reference||i.sku||'—')}</td><td>${esc(i.color||'—')}</td><td><b>${esc(i.size||'—')}</b></td><td>${i.expected_qty}</td><td><span class="type-pill">${esc(sourceStageLabel(i.source_stage))}</span><small>${esc(i.source_status_pcp||i.source_status_logistics||i.source_status_quality||'')}</small></td><td>${esc(i.source_seamstress||'—')}</td></tr>`).join("")}
    </tbody></table></div><div class="notice">Atualizado em ${fmtDateTime(cardData.source_snapshot_at)}. Uma nova importação atualiza a posição sem criar outro Card.</div></div>`;
}
function sourceStageLabel(s){return ({FORNECEDOR:"No fornecedor",TRANSITO:"Em trânsito",QUALIDADE:"Qualidade",QUALIDADE_RETRABALHO:"Retrabalho",QUALIDADE_REJEITADO:"Rejeitado",PCP_CONFIGURAR:"PCP — configurar",AGUARDANDO_COSTURA:"Vai para Costura",EM_COSTURA:"Na Costura",RETORNO_COSTURA:"Retornou da Costura",AGUARDANDO_PROCESSAMENTO:"Aguardando Processamento",PROCESSAMENTO:"Processamento",TRIAGEM:"Triagem",ETIQUETAGEM:"Etiquetagem",ESTOCAGEM:"Estocagem",CONCLUIDO:"Concluído"})[s]||s||"Não classificado";}
function filterSourceItems(stage="__KEEP__"){
  if(stage!=="__KEEP__") window.sourceStageFilter=stage;
  const term=normalizeSearch($("sourceItemSearch")?.value||"");
  document.querySelectorAll(".source-item-row").forEach((r)=>r.classList.toggle("hidden",!!((window.sourceAllowedStages&&!window.sourceAllowedStages.includes(r.dataset.stage))||(window.sourceStageFilter&&r.dataset.stage!==window.sourceStageFilter)||(term&&!normalizeSearch(r.dataset.search).includes(term)))));
}

function renderImportedSectorSnapshot(tabId,stages,title){
  activateTab(tabId); window.sourceAllowedStages=stages; window.sourceStageFilter="";
  $("cardTab").innerHTML=`<div class="notice success-box"><b>${esc(title)}</b><br>Este Card possui itens nesta etapa conforme o relatório importado.</div>${sourceLocationHtml()}`;
  filterSourceItems("");
}

function outsideReceivingHtml() {
  const d = cardData.dispatch;
  return `<div class="panel-body">
    <div class="notice">Este Card não está atualmente no Recebimento. Os dados permanecem disponíveis somente para consulta.</div>
    ${cardData.status === "EM_COSTURA_CD01" && d ? `<div class="form-grid"><div class="field"><label>Transportadora</label><input class="readonly" readonly value="${esc(d.carrier)}"></div><div class="field"><label>Costureiro</label><input class="readonly" readonly value="${esc(d.seamstress_name)}"></div><div class="field"><label>Previsão de retorno</label><input class="readonly" readonly value="${fmtDate(d.return_forecast)}"></div></div>` : ""}
    ${cardData.status === "DESPACHO_CD02" ? '<div class="notice error"><b>Despacho CD02:</b> a mercadoria saiu do fluxo operacional interno.</div>' : ""}
  </div>`;
}

function inCosturaHtml() {
  const d = cardData.dispatch;
  const r = cardData.receiving;
  const operate = canOperateReceiving();
  const productionDone = r?.ten_percent_status === "CONCLUIDA";
  return `<div class="panel-body">
    <div class="notice success-box"><b>Mercadoria em Costura — CD01</b><br>O Card permanece na aba Recebimento para acompanhamento até o retorno da mercadoria.</div>
    <div class="form-grid">
      <div class="field"><label>Status</label><input class="readonly" readonly value="${esc(cardData.status_label)}"></div>
      <div class="field"><label>Destino</label><input class="readonly" readonly value="${esc(cardData.quality_destination || "CD01")}"></div>
      <div class="field"><label>Transportadora</label><input class="readonly" readonly value="${esc(d?.carrier || "—")}"></div>
      <div class="field"><label>Costureiro</label><input class="readonly" readonly value="${esc(d?.seamstress_name || "—")}"></div>
      <div class="field"><label>Quantidade despachada</label><input class="readonly" readonly value="${d?.dispatched_qty ?? "—"}"></div>
      <div class="field"><label>Volumes</label><input class="readonly" readonly value="${d?.volumes ?? "—"}"></div>
      <div class="field"><label>Data do despacho</label><input class="readonly" readonly value="${fmtDateTime(d?.completed_at)}"></div>
      <div class="field"><label>Previsão de retorno</label><input class="readonly" readonly value="${fmtDate(d?.return_forecast)}"></div>
      <div class="field full"><label>Observações do despacho</label><textarea class="readonly" readonly>${esc(d?.notes || "")}</textarea></div>
    </div>
    ${r ? costuraProductionHtml(r, productionDone, operate) : '<div class="notice warn">O controle de produção da Costura será criado automaticamente na próxima atualização do relatório.</div>'}
    <div class="notice warn">Aguardando o retorno da Costura. Quando a mercadoria retornar, o Recebimento fará a conferência física e o endereçamento integral do saldo; depois o Card seguirá para a Inspeção 2 na Qualidade.</div>
    ${currentUser.role === "admin" ? `<div class="actions"><button class="success" onclick="simulateReturn(${cardData.id})">Registrar retorno CD01 — teste</button></div>` : ""}
  </div>`;
}

function samplePlanTable(r, title) {
  const rows = r.sample_plan || [];
  if (!rows.length) return "";
  return `<h3 class="section-heading">${esc(title)}</h3>
    <div class="notice"><b>Distribuição automática por cor e tamanho.</b><br>Cada cor e tamanho entrega a mesma proporção da sua quantidade (ex.: 40 peças → 4), e a soma fecha exatamente a meta de 10%.</div>
    <div class="table-wrap compact-picker"><table class="compact-table"><thead><tr><th>Produto</th><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Qtd. total</th><th>Retirar nos 10%</th></tr></thead><tbody>
      ${rows.map((item)=>`<tr><td><b>${esc(item.product||"—")}</b></td><td>${esc(item.reference||item.sku||"—")}</td><td>${esc(item.color||"Geral")}</td><td><span class="size-token">${esc(item.size||"Geral")}</span></td><td>${item.expected_qty}</td><td><b>${item.sample_qty}</b></td></tr>`).join("")}
    </tbody><tfoot><tr><td colspan="5"><b>Total previsto da tiragem</b></td><td><b>${rows.reduce((sum,item)=>sum+Number(item.sample_qty||0),0)}</b></td></tr></tfoot></table></div>`;
}

function costuraProductionHtml(r, productionDone, operate) {
  const timer = r.timer || {state:"NAO_INICIADA",business_seconds:0,paused_seconds:0,permanence_seconds:0};
  return `<h3 class="section-heading">Controle de produção — Costura</h3>
    <div class="timer-card">
      <div class="form-grid"><div class="field"><label>Quantidade prevista na Costura</label><input class="readonly" readonly value="${(r.operation_items||[]).reduce((sum,item)=>sum+Number(item.expected_qty||0),0)||cardData.expected_total}"></div><div class="field"><label>Quantidade produzida</label><input id="sampleActual" type="number" min="0" ${operate&&!productionDone?"":"readonly"} value="${r.ten_percent_actual??""}"></div></div>
      <div class="timer-grid" style="margin-top:11px"><div class="timer-value"><span>Status</span><strong>${esc(timer.state)}</strong></div><div class="timer-value"><span>Tempo útil</span><strong>${fmtSeconds(timer.business_seconds)}</strong></div><div class="timer-value"><span>Tempo parado</span><strong>${fmtSeconds(timer.paused_seconds)}</strong></div><div class="timer-value"><span>Permanência</span><strong>${fmtSeconds(timer.permanence_seconds)}</strong></div></div>
      <div class="actions">${operate&&!productionDone&&timer.state==="NAO_INICIADA"?'<button class="primary" onclick="sampleAction(\'start\')">Iniciar produção</button>':""}${operate&&!productionDone&&timer.state==="EM_ANDAMENTO"?'<button class="warning" onclick="sampleAction(\'pause\')">Pausar</button><button class="success" onclick="sampleAction(\'finish\')">Concluir produção</button>':""}${operate&&!productionDone&&timer.state==="PAUSADA"?'<button class="primary" onclick="sampleAction(\'resume\')">Retomar</button><button class="success" onclick="sampleAction(\'finish\')">Concluir produção</button>':""}${productionDone?'<span class="badge green">Produção concluída</span>':'<span class="badge orange">Produção em acompanhamento</span>'}</div>
    </div>`;
}

async function saveVolumesAfterSample() {
  const value = Number($("recVolumesAfter")?.value || 0);
  if (!Number.isInteger(value) || value <= 0) { toast("Informe a quantidade de volumes após a retirada dos 10%."); return; }
  try {
    await api(`/api/receivings/${cardData.receiving.id}/volumes-after-sample`, {
      method: "POST",
      body: JSON.stringify({ user_id: currentUser.id, volumes: value }),
    });
    toast("Volumes após a retirada dos 10% salvos.");
    await openCard(currentCardId, "receiving");
  } catch (error) {
    toast(error.message);
  }
}

function receivingFormHtml(isReturn) {
  const r = cardData.receiving;
  if (!r) return '<div class="notice error">Registro de Recebimento não encontrado.</div>';
  const operate = canOperateReceiving();
  const physicalDone = r.physical_status === "CONCLUIDO";
  const sampleDone = r.ten_percent_status === "CONCLUIDA";
  const readOnly = operate && !physicalDone ? "" : "readonly";
  const disabled = operate && !physicalDone ? "" : "disabled";
  const operationItems = r.operation_items || [];
  const dataSaved = Number(r.volumes || 0) > 0 && r.received_qty !== null && r.received_qty !== undefined && r.has_damage !== null && r.has_damage !== undefined;
  const volumesAfterSet = r.volumes_after_sample !== null && r.volumes_after_sample !== undefined;
  const canConclude = operate && !physicalDone && dataSaved && (isReturn || (sampleDone && volumesAfterSet));
  return `
    <div class="panel-body">
      <div class="notice ${isReturn ? "success-box" : ""}"><b>${isReturn ? "Recebimento do retorno CD01" : "Recebimento de mercadoria em trânsito"}</b><br>${isReturn ? "Faça a conferência física e informe volumes e quantidade retornada. Não existe tiragem de 10% no Recebimento da volta da Costura. Aloque todo o saldo retornado entre RM, QA e PR antes de concluir; depois o Card seguirá para a Inspeção 2 na Qualidade." : "Conclua a tiragem dos 10% antes de liberar a alocação dos volumes no RM. O Card só segue para a Qualidade quando o recebimento físico e a amostra terminarem."}</div>
      ${!operate && !physicalDone ? `<div class="notice warn"><b>Somente o operador de Recebimento pode operar este Card.</b><br>${cardData.current_sector !== "RECEBIMENTO" ? "Este Card não está no Recebimento." : "Entre com um usuário do perfil Recebimento para usar os botões de ação."}</div>` : ""}
      ${operationItems.length ? `<div class="notice"><b>${operationItems.length} item(ns) fazem parte deste controle</b><br>Somente estes itens serão movimentados. Os demais itens da compra permanecerão em suas etapas atuais.</div>` : ""}
      <h3 class="section-heading">Recebimento físico</h3>
      <div class="form-grid">
        <div class="field"><label>Volumes</label><input id="recVolumes" type="number" min="0" ${readOnly} value="${r.volumes ?? ""}"></div>
        <div class="field"><label>${isReturn ? "Quantidade retornada" : "Quantidade recebida"}</label><input id="recQty" type="number" min="0" ${readOnly} value="${r.received_qty ?? ""}"></div>
        <div class="field"><label>Danos ou avarias?</label><select id="recDamage" ${disabled}><option value="">Selecione</option><option value="0" ${r.has_damage===0?"selected":""}>Não</option><option value="1" ${r.has_damage===1?"selected":""}>Sim</option></select></div>
        <div class="field full"><label>Descrição dos danos</label><textarea id="recDamageDesc" ${readOnly}>${esc(r.damage_description||"")}</textarea></div>
        <div class="field full"><label>Observações</label><textarea id="recNotes" ${readOnly}>${esc(r.notes||"")}</textarea></div>
      </div>
      <div class="actions">
        ${operate && !physicalDone ? `<button class="secondary" onclick="saveReceiving()">Salvar dados</button><label class="primary small-btn" style="cursor:pointer">Adicionar fotos<input id="receivingFiles" type="file" multiple hidden onchange="uploadReceivingPhotos()"></label>` : ""}
        ${isReturn && physicalDone && operate && cardData.current_sector === "RECEBIMENTO" ? '<button class="success" onclick="completePhysical()">Concluir retorno e encaminhar à Qualidade</button>' : (physicalDone ? '<span class="badge green">Recebimento físico concluído</span>' : '<span class="badge gray">Recebimento físico pendente</span>')}
      </div>
      ${!dataSaved && !physicalDone
        ? `<div class="notice warn"><b>Salve os dados do recebimento para continuar.</b><br>Informe volumes, quantidade e avarias e clique em <b>Salvar dados</b>. ${isReturn ? "O endereçamento do retorno" : "O plano da tiragem de 10%"} aparece depois disso.</div>`
        : `${isReturn
        ? `<h3 class="section-heading">Endereçamento do retorno</h3><div id="posAllocBox" class="notice">${Number(r.volumes||0)>0 ? "Carregando mapa para alocar todo o saldo retornado…" : "Informe e salve os volumes retornados para liberar o endereçamento completo."}</div>`
        : `${samplePlanTable(r,"Plano exato da tiragem de 10%")}${sampleHtml(r, sampleDone, operate, false)}${sampleDone ? `<h3 class="section-heading">Volumes após a retirada dos 10%</h3>
        <div class="notice">Depois de retirar a amostra, conte quantos volumes ficaram e informe abaixo. Essa quantidade será usada no endereçamento e na conclusão.</div>
        <div class="form-grid"><div class="field"><label>Quantidade de volumes após a retirada dos 10%</label><input id="recVolumesAfter" type="number" min="1" ${operate && !physicalDone ? "" : "readonly"} value="${r.volumes_after_sample ?? ""}"></div></div>
        ${operate && !physicalDone ? '<div class="actions"><button class="secondary" onclick="saveVolumesAfterSample()">Salvar volumes</button></div>' : ""}
        ${volumesAfterSet || physicalDone ? `<h3 class="section-heading">Endereçamento obrigatório da amostra na Qualidade</h3><div id="posAllocBox" class="notice">Carregando etapa obrigatória de alocação…</div>` : `<div class="notice warn"><b>Informe e salve a quantidade de volumes após a retirada dos 10%</b> para liberar o endereçamento.</div>`}` : `<h3 class="section-heading">Endereçamento da amostra</h3><div class="notice warn">Conclua a tiragem dos 10% para liberar primeiro a alocação obrigatória na Qualidade.</div>`}`}`}
      <div class="photos">${receivingPhotos.map((p,i)=>`<a class="photo-link" target="_blank" href="${p}">Arquivo ${i+1}</a>`).join("")}</div>
      ${canConclude ? '<div class="actions"><button class="success" onclick="completePhysical()">Concluir recebimento físico</button></div>' : ""}
    </div>`;
}

function sampleHtml(r, sampleDone, operate, isReturn=false) {
  const timer = r.timer || { state:"NAO_INICIADA",business_seconds:0,paused_seconds:0,permanence_seconds:0 };
  const operationTotal = (r.operation_items||[]).reduce((sum,item)=>sum+Number(item.expected_qty||0),0);
  return `
    <h3 class="section-heading">${isReturn ? "Nova tiragem de 10% do retorno" : "Tiragem de 10%"}</h3>
    <div class="timer-card">
      <div class="form-grid">
        <div class="field"><label>${isReturn && operationTotal ? "Quantidade prevista do retorno" : "Quantidade esperada da compra"}</label><input class="readonly" readonly value="${isReturn && operationTotal ? operationTotal : cardData.expected_total}"></div>
        <div class="field"><label>Quantidade mínima (10%)</label><input class="readonly" readonly value="${r.ten_percent_min}"></div>
        <div class="field"><label>Quantidade efetivamente separada</label><input id="sampleActual" type="number" min="0" ${operate && !sampleDone ? "" : "readonly"} value="${r.ten_percent_actual ?? ""}"></div>
      </div>
      <div class="timer-grid" style="margin-top:11px">
        <div class="timer-value"><span>Status</span><strong>${esc(timer.state)}</strong></div>
        <div class="timer-value"><span>Tempo útil</span><strong id="timerUseful">${fmtSeconds(timer.business_seconds)}</strong></div>
        <div class="timer-value"><span>Tempo parado</span><strong id="timerPaused">${fmtSeconds(timer.paused_seconds)}</strong></div>
        <div class="timer-value"><span>Permanência</span><strong id="timerPermanence">${fmtSeconds(timer.permanence_seconds)}</strong></div>
      </div>
      <div class="actions">
        ${operate && !sampleDone && timer.state === "NAO_INICIADA" ? `<button class="primary" onclick="sampleAction('start')">Iniciar tiragem</button>` : ""}
        ${operate && !sampleDone && timer.state === "EM_ANDAMENTO" ? `<button class="warning" onclick="sampleAction('pause')">Pausar</button><button class="success" onclick="sampleAction('finish')">Concluir tiragem</button>` : ""}
        ${operate && !sampleDone && timer.state === "PAUSADA" ? `<button class="primary" onclick="sampleAction('resume')">Retomar</button><button class="success" onclick="sampleAction('finish')">${isReturn ? "Concluir tiragem" : "Concluir tiragem"}</button>` : ""}
        ${sampleDone ? `<span class="badge green">${isReturn ? "Nova amostra separada" : "Tiragem concluída"}</span>` : `<span class="badge orange">${isReturn ? "Nova amostra pendente" : "Tiragem pendente"}</span>`}
      </div>
    </div>`;
}

function dispatchHtml() {
  const operate = canOperateReceiving();
  return `<div class="panel-body">
    <div class="notice warn"><b>Inspeção 1 concluída.</b> A Qualidade definiu o destino <b>${esc(cardData.quality_destination)}</b>. O Recebimento é responsável pelo despacho.
    </div>
    <div class="form-grid">
      <div class="field"><label>Destino definido pela Qualidade</label><input class="readonly" readonly value="${esc(cardData.quality_destination)}"></div>
      <div class="field"><label>Transportadora</label><input id="dispatchCarrier" ${operate?"":"readonly"}></div>
      <div class="field"><label>Nome do costureiro</label><input id="dispatchSeamstress" ${operate?"":"readonly"}></div>
      <div class="field"><label>Quantidade despachada</label><input id="dispatchQty" type="number" min="0" ${operate?"":"readonly"}></div>
      <div class="field"><label>Volumes</label><input id="dispatchVolumes" type="number" min="0" ${operate?"":"readonly"}></div>
      <div class="field full"><label>Observações</label><textarea id="dispatchNotes" ${operate?"":"readonly"}></textarea></div>
    </div>
    <div class="actions">${operate ? `<button class="success" onclick="completeDispatch()">Concluir despacho</button><label class="primary small-btn" style="cursor:pointer">Adicionar fotos<input id="dispatchFiles" type="file" multiple hidden onchange="uploadDispatchPhotos()"></label>` : '<span class="badge gray">Somente operador de Recebimento</span>'}</div>
    <div class="photos">${dispatchPhotos.map((p,i)=>`<a class="photo-link" target="_blank" href="${p}">Arquivo ${i+1}</a>`).join("")}</div>
  </div>`;
}

async function saveReceiving() {
  try {
    const r = cardData.receiving;
    await api(`/api/receivings/${r.id}`, { method:"PATCH", body:JSON.stringify({
      user_id: currentUser.id,
      volumes: $("recVolumes").value === "" ? null : Number($("recVolumes").value),
      received_qty: $("recQty").value === "" ? null : Number($("recQty").value),
      has_damage: $("recDamage").value === "" ? null : $("recDamage").value === "1",
      damage_description: $("recDamageDesc").value,
      notes: $("recNotes").value,
      photo_paths: receivingPhotos,
      ten_percent_actual: $("sampleActual") ? ($("sampleActual").value === "" ? null : Number($("sampleActual").value)) : r.ten_percent_actual,
    })});
    toast("Dados salvos.");
    await openCard(currentCardId);
  } catch (error) { toast(error.message); }
}

async function completePhysical() {
  try {
    await saveReceivingNoReload();
    await api(`/api/receivings/${cardData.receiving.id}/physical-complete`, { method:"POST", body:JSON.stringify({ user_id:currentUser.id }) });
    toast("Recebimento físico concluído.");
    await openCard(currentCardId);
  } catch (error) { toast(error.message); }
}

async function saveReceivingNoReload() {
  const r = cardData.receiving;
  await api(`/api/receivings/${r.id}`, { method:"PATCH", body:JSON.stringify({
    user_id: currentUser.id,
    volumes: $("recVolumes").value === "" ? null : Number($("recVolumes").value),
    received_qty: $("recQty").value === "" ? null : Number($("recQty").value),
    has_damage: $("recDamage").value === "" ? null : $("recDamage").value === "1",
    damage_description: $("recDamageDesc").value,
    notes: $("recNotes").value,
    photo_paths: receivingPhotos,
    ten_percent_actual: $("sampleActual") ? ($("sampleActual").value === "" ? null : Number($("sampleActual").value)) : r.ten_percent_actual,
  })});
}

async function sampleAction(action) {
  try {
    if ($("sampleActual")) {
      await api(`/api/receivings/${cardData.receiving.id}`, { method:"PATCH", body:JSON.stringify({
        user_id:currentUser.id,
        ten_percent_actual: $("sampleActual").value === "" ? null : Number($("sampleActual").value),
        volumes: $("recVolumes") ? ($("recVolumes").value === "" ? null : Number($("recVolumes").value)) : cardData.receiving?.volumes,
      })});
    }
    await api(`/api/receivings/${cardData.receiving.id}/timer/${action}`, { method:"POST", body:JSON.stringify({ user_id:currentUser.id }) });
    toast(cardData.receiving?.receiving_type === "COSTURA" ? "Controle de produção da Costura atualizado." : "Atividade dos 10% atualizada.");
    await openCard(currentCardId);
  } catch (error) { toast(error.message); }
}

async function uploadFiles(inputId) {
  const files = Array.from($(inputId).files || []);
  if (!files.length) return [];
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  const result = await api("/api/uploads", { method:"POST", body:form });
  return result.paths;
}

async function uploadReceivingPhotos() {
  try {
    receivingPhotos.push(...await uploadFiles("receivingFiles"));
    toast("Arquivos adicionados. Clique em Salvar dados para registrar.");
    renderReceivingTab();
  } catch (error) { toast(error.message); }
}

async function uploadDispatchPhotos() {
  try {
    dispatchPhotos.push(...await uploadFiles("dispatchFiles"));
    toast("Arquivos adicionados ao despacho.");
    renderReceivingTab();
  } catch (error) { toast(error.message); }
}

async function completeDispatch() {
  try {
    await api(`/api/cards/${currentCardId}/dispatch`, { method:"POST", body:JSON.stringify({
      user_id:currentUser.id,
      carrier:$("dispatchCarrier").value,
      seamstress_name:$("dispatchSeamstress").value,
      dispatched_qty:$("dispatchQty").value,
      volumes:$("dispatchVolumes").value,
      notes:$("dispatchNotes").value,
      photo_paths:dispatchPhotos,
    })});
    toast("Despacho concluído.");
    await openCard(currentCardId);
  } catch (error) { toast(error.message); }
}

function renderCasuloTab() {
  if (guardSampleAllocationNavigation()) return;
  activateTab("tabCasuloBtn");
  const canEdit = canOperateReceiving();
  $("cardTab").innerHTML = `<div class="panel-body">
    <div class="casulo-box"><h3 style="margin-top:0">Localização física da mercadoria</h3><div class="form-grid">
      <div class="field"><label>Casulo atual</label><input class="readonly" readonly value="${esc(cardData.casulo_current||"Não informado")}"></div>
      <div class="field"><label>Novo Casulo</label><input id="newCasulo" ${canEdit?"":"readonly"}></div>
      <div class="field"><label>Observação da movimentação</label><input id="casuloNote" ${canEdit?"":"readonly"}></div>
    </div><div class="actions">${canEdit?'<button class="primary" onclick="updateCasulo()">Atualizar Casulo</button>':'<span class="badge gray">Edição permitida somente ao operador de Recebimento enquanto o Card estiver no Recebimento</span>'}</div></div>
    <h3 class="section-heading">Histórico de Casulos</h3>
    <div class="timeline">${cardData.casulo_history.map((row)=>`<div class="timeline-event"><b>${esc(row.old_casulo||"Não informado")} → ${esc(row.new_casulo)}</b><br><small>${fmtDateTime(row.created_at)} • ${esc(row.user_name)} ${row.note?"• "+esc(row.note):""}</small></div>`).join("") || '<div class="notice">Nenhuma movimentação registrada.</div>'}</div>
  </div>`;
}

async function updateCasulo() {
  try {
    await api(`/api/cards/${currentCardId}/casulo`, { method:"POST", body:JSON.stringify({ user_id:currentUser.id,new_casulo:$("newCasulo").value,note:$("casuloNote").value }) });
    toast("Casulo atualizado.");
    await openCard(currentCardId, "casulo");
  } catch (error) { toast(error.message); }
}

function renderProductsTab() {
  if (guardSampleAllocationNavigation()) return;
  activateTab("tabProductsBtn");
  $("cardTab").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Produto</th><th>Referência</th><th>SKU</th><th>Marca</th><th>Cor</th><th>Tamanho</th><th>Lote</th><th>NF</th><th>Qtd. esperada</th></tr></thead>
    <tbody>${cardData.items.map((i)=>`<tr><td>${esc(i.product||"—")}</td><td>${esc(i.reference||"—")}</td><td>${esc(i.sku||"—")}</td><td>${esc(i.brand||"—")}</td><td>${esc(i.color||"—")}</td><td>${esc(i.size||"—")}</td><td>${esc(i.lot||"—")}</td><td>${esc(i.nf||"—")}</td><td>${i.expected_qty}</td></tr>`).join("")}</tbody>
  </table></div>`;
}

function renderCardHistory() {
  if (guardSampleAllocationNavigation()) return;
  activateTab("tabHistoryBtn");
  $("cardTab").innerHTML = `<div class="panel-body"><div class="timeline">${cardData.history.map((event)=>`<div class="timeline-event"><b>${esc(event.description)}</b><br><small>${fmtDateTime(event.created_at)} ${event.user_name?"• "+esc(event.user_name):""}</small></div>`).join("") || '<div class="notice">Nenhum evento.</div>'}</div></div>`;
}

async function renderQualityTabBase() {
  activateTab("tabQualityBtn");
  if (!canOperateQuality()) {
    $("cardTab").innerHTML = qualityReadOnlyPreviewHtml();
    return;
  }
  const q = cardData.quality;
  const returnStatusAwaitingInspection2 = ["RETORNO_CONCLUIDO", "AGUARDANDO_INSPECAO"].includes(cardData.status);
  const isReturnAwaitingInspection2 = cardData.current_sector === "QUALIDADE" &&
    !cardData.source_snapshot_at &&
    returnStatusAwaitingInspection2 &&
    (
      cardData.receiving_type === "RETORNO" ||
      cardData.receiving?.receiving_type === "RETORNO" ||
      cardData.status === "RETORNO_CONCLUIDO" ||
      cardData.status === "AGUARDANDO_INSPECAO"
    );
  if (guardSampleAllocationNavigation()) return;
  try {
    if (!qualityUsers.length) qualityUsers = await api("/api/quality/users");
  } catch (error) {
    $("cardTab").innerHTML = `<div class="notice error">${esc(error.message)}</div>`;
    return;
  }
  const importedQualityItems = (cardData.items||[]).filter((item)=>["QUALIDADE","QUALIDADE_RETRABALHO","QUALIDADE_REJEITADO"].includes(item.source_stage));
  if (cardData.source_snapshot_at && (!q || q.status === "CONCLUIDA")) {
    if (importedQualityItems.length) {
      if (canOperateQuality()) {
        window.qualitySourceSubset = true;
        $("cardTab").innerHTML = qualitySetupHtml(null, true);
        toggleQualitySetupFields();
      } else {
        renderImportedSectorSnapshot("tabQualityBtn",["QUALIDADE","QUALIDADE_RETRABALHO","QUALIDADE_REJEITADO"],"Itens localizados na Qualidade");
        $("cardTab").insertAdjacentHTML("afterbegin",'<div class="notice warn">Entre com um perfil da Qualidade, Supervisor ou Administrador para assumir estes itens e iniciar a inspeção.</div>');
      }
      return;
    }
    if (cardData.current_sector !== "QUALIDADE") {
      renderImportedSectorSnapshot("tabQualityBtn",["QUALIDADE","QUALIDADE_RETRABALHO","QUALIDADE_REJEITADO"],"Itens localizados na Qualidade");
      return;
    }
  }
  window.qualitySourceSubset = false;
  const needsNewInspection = cardData.current_sector === "QUALIDADE" && (!q || q.status === "CONCLUIDA");
  if (needsNewInspection) {
    $("cardTab").innerHTML = qualitySetupHtml(q);
    toggleQualitySetupFields();
    return;
  }
  if (!q) {
    $("cardTab").innerHTML = '<div class="panel-body"><div class="notice">Este Card ainda não possui inspeção da Qualidade.</div></div>';
    return;
  }
  $("cardTab").innerHTML = qualityInspectionHtml(q);
}

async function renderQualityTab() { await renderQualityTabBase(); await renderQualityCadastroStatusBadge(); }

function qualitySetupHtml(previousInspection=null, sourceSubset=false) {
  const isCosturaReturn = cardData.receiving_type === "RETORNO" ||
    cardData.receiving?.receiving_type === "RETORNO" ||
    ["AGUARDANDO_RECEBIMENTO_RETORNO", "RETORNO_CONCLUIDO", "AGUARDANDO_INSPECAO"].includes(cardData.status);
  const defaultType = isCosturaReturn ? 2 : 1;
  const defaultMode = cardData.purchase_mode || previousInspection?.purchase_mode || "";
  const destinationField = defaultType === 1
    ? `<div class="field" id="qualityDestinationField"><label for="qualityDestination">Destino da Inspeção 1</label><select id="qualityDestination" required><option value="">Selecione CD01 ou CD02</option><option value="CD01">CD01 — retorna ao nosso CD</option><option value="CD02">CD02 — sai do fluxo interno</option></select><small>Defina o destino do fluxo da Inspeção 1.</small></div>`
    : "";
  const costuraField = sourceSubset
    ? ""
    : defaultType === 1
      ? `<div class="field full quality-costura-field"><span class="field-label" id="qualitySendToCosturaLabel">Vai para a Costura?</span><div class="quality-choice-options" role="radiogroup" aria-labelledby="qualitySendToCosturaLabel"><label class="quality-choice-card" id="qualityCosturaYesCard" for="qualitySendToCosturaYes"><input type="radio" id="qualitySendToCosturaYes" name="qualitySendToCostura" value="1" required onchange="setQualityCosturaChoice(this.value)"><span class="quality-choice-indicator" aria-hidden="true"></span><span class="quality-choice-copy"><strong>Sim</strong><small>Segue para a Costura</small></span></label><label class="quality-choice-card" id="qualityCosturaNoCard" for="qualitySendToCosturaNo"><input type="radio" id="qualitySendToCosturaNo" name="qualitySendToCostura" value="0" required onchange="setQualityCosturaChoice(this.value)"><span class="quality-choice-indicator" aria-hidden="true"></span><span class="quality-choice-copy"><strong>Não</strong><small>Segue direto para Processamento</small></span></label></div><small class="quality-choice-help">Selecione uma opção. Ao concluir a inspeção, a amostra dos 10% será reunida automaticamente ao saldo.</small></div>`
      : `<div class="field full"><label>Vai para a Costura?</label><input class="readonly" readonly value="Não — retorno da Costura segue para Processamento"></div>`;
  return `<div class="panel-body">
    ${sourceSubset ? `<div class="notice success-box"><b>Controle por referência</b><br>Selecione abaixo quais referências entrarão nesta inspeção. As referências não selecionadas não serão movimentadas.</div>${qualitySourceItemsHtml()}` : ""}
    ${previousInspection ? `<div class="notice success-box">A Inspeção ${previousInspection.inspection_type} anterior foi concluída em ${fmtDateTime(previousInspection.completed_at)}. O Card retornou à Qualidade para uma nova rodada.</div>` : ""}
    <div class="notice"><b>Configuração da inspeção</b><br>O tipo da compra vem automaticamente da coluna <b>Tipo</b> do Excel: Private Label = Grade e Saldo = Saldo.</div>
    ${isCosturaReturn
      ? '<div class="notice warn"><b>Retorno da Costura:</b> a Inspeção 2 é obrigatória e, ao concluir, seguirá para Processamento com a amostra reunida automaticamente ao saldo.</div>'
      : '<div class="notice success-box"><b>Primeira etapa após o Recebimento:</b> a Inspeção 1 é obrigatória. Se houver envio à Costura, o Card será encaminhado ao despacho; caso contrário, seguirá direto para Processamento.</div>'}
    <div class="form-grid">
      <div class="field"><label>Tipo de inspeção</label><select id="qualityType" onchange="toggleQualitySetupFields()" disabled><option value="1" ${defaultType===1?"selected":""}>Inspeção 1</option><option value="2" ${defaultType===2?"selected":""}>Inspeção 2</option></select></div>
      ${["GRADE", "SALDO"].includes(defaultMode) ? `<div class="field"><label>Tipo da compra</label><input id="qualityPurchaseMode" class="readonly" readonly value="${defaultMode === "GRADE" ? "Grade — controle por item" : "Saldo — quantidade geral"}"></div>` : `<div class="field"><label>Tipo da compra (não reconhecido — informe)</label><select id="qualityPurchaseMode"><option value="">Selecione</option><option value="GRADE">Grade — controle por item</option><option value="SALDO">Saldo — quantidade geral</option></select></div>`}
      ${destinationField}
      ${costuraField}
      <div class="field"><label>É necessário separar peças para Desenvolvimento?</label><select id="developmentRequired" onchange="toggleDevelopmentSetup()"><option value="">Selecione</option><option value="0">Não</option><option value="1">Sim</option></select></div>
      <div class="field" id="developmentSeparatedField" style="display:none"><label>As peças para Desenvolvimento já foram separadas?</label><select id="developmentSeparated"><option value="">Selecione</option><option value="0">Não</option><option value="1">Sim</option></select></div>
    </div>
    <div class="actions"><button class="primary" onclick="createQualityInspection()">Criar inspeção</button>${isCosturaReturn ? '<button onclick="transferInspectionToProcessing()">Transferir Inspeção 2 para o Processamento</button>' : ""}</div>
  </div>`;
}

async function transferInspectionToProcessing() {
  if (!confirm("Transferir a Inspeção 2 para o Processamento? O Card sairá da Qualidade sem criar a inspeção.")) return;
  try {
    await api(`/api/cards/${currentCardId}/quality/transfer-processing`, {
      method: "POST",
      body: JSON.stringify({ user_id: currentUser.id }),
    });
    toast("Card transferido para o Processamento.");
    await openCard(currentCardId, "processing");
  } catch (error) {
    toast(error.message);
  }
}

function setQualityCosturaChoice(value) {
  const choice = String(value);
  if (choice !== "1" && choice !== "0") return;
  const selected = document.querySelector(`input[name="qualitySendToCostura"]:checked`);
  if (!selected || selected.value !== choice) return;
  $("qualityCosturaYesCard")?.classList.toggle("is-selected", choice === "1");
  $("qualityCosturaNoCard")?.classList.toggle("is-selected", choice === "0");
}

function toggleQualitySetupFields() {
  const type = Number($("qualityType")?.value || 1);
  if ($("qualityDestinationField")) $("qualityDestinationField").style.display = type === 1 ? "block" : "none";
}

function toggleDevelopmentSetup() {
  const required = $("developmentRequired")?.value === "1";
  if ($("developmentSeparatedField")) $("developmentSeparatedField").style.display = required ? "block" : "none";
}

function qualitySourceItemsHtml() {
  const items = (cardData.items || []).filter((item) => ['QUALIDADE','QUALIDADE_RETRABALHO','QUALIDADE_REJEITADO'].includes(item.source_stage) && Number(item.expected_qty || 0) > 0);
  if (!items.length) return '<div class="notice warn">Nenhuma referência disponível na Qualidade para iniciar a inspeção.</div>';
  return '<h3 class="section-heading">Referências que entrarão nesta inspeção</h3>' +
    '<div class="notice success-box"><b>Selecione por referência.</b> Somente as referências marcadas serão movimentadas ao concluir esta inspeção. As demais permanecem nos setores atuais.</div>' +
    '<div class="queue-toolbar"><div class="queue-search"><span>⌕</span><input id="qualitySourceSearch" placeholder="Produto, referência, cor ou tamanho" oninput="filterQualitySourceItems()"></div><div class="actions compact-actions"><button class="secondary" onclick="toggleAllQualitySourceItems(true)">Selecionar todas</button><button class="ghost" onclick="toggleAllQualitySourceItems(false)">Limpar seleção</button></div></div>' +
    '<div class="table-wrap compact-picker"><table class="compact-table" id="qualitySourceItemsTable"><thead><tr><th class="check-col"><input id="qualitySourceAll" type="checkbox" checked onchange="toggleAllQualitySourceItems(this.checked)"></th><th>Produto</th><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Quantidade</th><th>Etapa atual</th></tr></thead><tbody>' +
    items.map((item) => '<tr class="quality-source-row" data-search="' + esc([item.product,item.reference,item.sku,item.color,item.size].join(' ').toLowerCase()) + '"><td><input class="quality-source-check" type="checkbox" value="' + item.id + '" checked onchange="updateQualitySourceSummary()"></td><td><b>' + esc(item.product || '—') + '</b></td><td>' + esc(item.reference || item.sku || '—') + '</td><td>' + esc(item.color || '—') + '</td><td><span class="size-token">' + esc(item.size || '—') + '</span></td><td><b>' + item.expected_qty + '</b></td><td><span class="type-pill">' + esc(sourceStageLabel(item.source_stage)) + '</span></td></tr>').join('') +
    '</tbody></table></div><div id="qualitySourceSummary" class="queue-counter"></div>';
}
function filterQualitySourceItems() {
  const term = normalizeSearch($("qualitySourceSearch")?.value || '');
  document.querySelectorAll('.quality-source-row').forEach((row) => row.classList.toggle('hidden', !!term && !normalizeSearch(row.dataset.search || '').includes(term)));
}
function toggleAllQualitySourceItems(checked) {
  document.querySelectorAll('.quality-source-check').forEach((input) => { input.checked = checked; });
  if ($('qualitySourceAll')) $('qualitySourceAll').checked = checked;
  updateQualitySourceSummary();
}
function updateQualitySourceSummary() {
  const selected = [...document.querySelectorAll('.quality-source-check:checked')];
  const ids = new Set(selected.map((input) => Number(input.value)));
  const qty = (cardData.items || []).filter((item) => ids.has(Number(item.id))).reduce((sum, item) => sum + Number(item.expected_qty || 0), 0);
  const total = document.querySelectorAll('.quality-source-check').length;
  if ($('qualitySourceSummary')) $('qualitySourceSummary').innerHTML = selected.length ? '<b>' + selected.length + '</b> referência(s) selecionada(s) • <b>' + qty + '</b> peça(s)' : 'Nenhuma referência selecionada.';
  if ($('qualitySourceAll')) $('qualitySourceAll').checked = selected.length === total;
}
function selectedQualitySourceItemIds() {
  return [...document.querySelectorAll('.quality-source-check:checked')].map((input) => Number(input.value)).filter((id) => id > 0);
}
function qualityItemRoutesHtml(q, isOpen, canOperate) {
  if (!q.source_subset || q.inspection_type !== 1) return '';
  const rows = q.item_routes || [];
  if (!rows.length) return '';
  const editable = isOpen && canOperate;
  return '<h3 class="section-heading">Destino por referência</h3><div class="notice"><b>Cada referência pode seguir por um caminho diferente.</b> A escolha abaixo não movimenta o Card inteiro.</div><div class="table-wrap compact-picker"><table class="compact-table"><thead><tr><th>Produto</th><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Qtd.</th><th>Destino</th></tr></thead><tbody>' +
    rows.map((row) => '<tr><td><b>' + esc(row.product || '—') + '</b></td><td>' + esc(row.reference || row.sku || '—') + '</td><td>' + esc(row.color || '—') + '</td><td><span class="size-token">' + esc(row.size || '—') + '</span></td><td>' + row.expected_qty + '</td><td>' +
      (editable ? '<select class="quality-route-select" data-item-id="' + row.item_id + '"><option value="">Selecione</option><option value="COSTURA" ' + (String(row.destination || '').toUpperCase() === 'COSTURA' ? 'selected' : '') + '>Costura</option><option value="PROCESSAMENTO" ' + (String(row.destination || '').toUpperCase() === 'PROCESSAMENTO' ? 'selected' : '') + '>Processamento</option></select>' : '<span class="badge ' + (String(row.destination || '').toUpperCase() === 'COSTURA' ? 'purple' : 'green') + '">' + esc(row.destination || 'Não definido') + '</span>') + '</td></tr>').join('') +
    '</tbody></table></div>' + (editable ? '<div class="actions"><button class="secondary" onclick="saveQualityItemRoutes()">Salvar destinos por referência</button></div>' : '');
}
async function saveQualityItemRoutes() {
  const q = cardData.quality;
  const routes = [...document.querySelectorAll('.quality-route-select')].map((select) => ({ item_id: Number(select.dataset.itemId), destination: select.value }));
  if (!routes.length || routes.some((row) => !row.destination)) { toast('Defina o destino de todas as referências.'); return; }
  try {
    await api('/api/quality/inspections/' + q.id + '/routes', { method:'PATCH', body:JSON.stringify({user_id:currentUser.id, routes}) });
    toast('Destinos por referência salvos.');
    await openCard(currentCardId, 'quality');
  } catch (error) { toast(error.message); }
}

async function createQualityInspection() {
  try {
    const requiredValue = $("developmentRequired").value;
    const separatedValue = $("developmentSeparated")?.value ?? "";
    const inspectionType = Number($("qualityType").value);
    const sendToCosturaValue = document.querySelector('input[name="qualitySendToCostura"]:checked')?.value ?? "";
    if (!window.qualitySourceSubset && inspectionType === 1 && sendToCosturaValue === "") {
      throw new Error("Responda obrigatoriamente: Vai para a Costura?");
    }
    await api(`/api/cards/${currentCardId}/quality/inspections`, {
      method: "POST",
      body: JSON.stringify({
        user_id: currentUser.id,
        inspection_type: inspectionType,
        send_to_costura: !window.qualitySourceSubset && inspectionType === 1 ? (sendToCosturaValue === "" ? null : sendToCosturaValue === "1") : null,
        destination: $("qualityDestination")?.value || null,
        development_required: requiredValue === "" ? null : requiredValue === "1",
        development_separated: requiredValue !== "1" ? null : (separatedValue === "" ? null : separatedValue === "1"),
        source_subset: Boolean(window.qualitySourceSubset),
        item_ids: window.qualitySourceSubset ? selectedQualitySourceItemIds() : [],
        purchase_mode: $("qualityPurchaseMode")?.tagName === "SELECT" ? $("qualityPurchaseMode").value : undefined,
      }),
    });
    toast("Inspeção criada.");
    await openCard(currentCardId, "quality");
  } catch (error) {
    toast(error.message);
    if (String(error.message || "").includes("Card foi devolvido ao Recebimento")) {
      await openCard(currentCardId, "receiving");
    }
  }
}

function qualityInspectionHtml(q) {
  const isOpen = q.status === "ABERTA";
  const canOperate = canOperateQuality();
  const typeLabel = `Inspeção ${q.inspection_type}`;
  const modeLabel = q.purchase_mode === "SALDO" ? "Saldo — controle por quantidade geral" : "Grade — controle por item";
  const sampleLabel = q.sample_source === "IMPORTACAO_QUALIDADE"
    ? `Referências disponíveis na Qualidade selecionadas para esta inspeção • ${modeLabel}`
    : q.sample_source === "RECEBIMENTO"
      ? `Amostra dos 10% separada pelo Recebimento • ${modeLabel}`
      : `Nova amostra obrigatória de 10% separada pelo Recebimento após o retorno da Costura • ${modeLabel}`;
  const goesToCostura = q.send_to_costura === 1 || (q.send_to_costura == null && q.destination === "CD01");
  const routeLabel = q.source_subset
    ? "Destino definido por referência"
    : q.inspection_type === 1
      ? (goesToCostura ? "Sim — vai para a Costura" : "Não — segue direto para Processamento")
      : "Retorno da Costura — segue para Processamento";
  const destinationLabel = q.destination === "CD01"
    ? "CD01 — retorna ao nosso CD"
    : q.destination === "CD02"
      ? "CD02 — sai do fluxo interno"
      : q.inspection_type === 2 ? "Processamento — retorno da Costura" : "Não definido";
  const enforcedMovementNotice = isOpen && !q.source_subset
    ? `<div class="notice warn"><b>Movimentação automática obrigatória</b><br>Ao concluir esta inspeção, o volume da amostra dos 10% será reunido ao saldo no endereço físico já utilizado pelo restante da mercadoria. Se o sistema não encontrar um endereço de saldo em RM ou PR, a conclusão será bloqueada até que o saldo seja endereçado.</div>`
    : "";
  return `<div class="panel-body">
    <div class="quality-header">
      <div class="notice ${q.inspection_type===2?"success-box":""}"><b>${typeLabel}</b><br><b>Destino:</b> ${esc(destinationLabel)}<br><b>Vai para a Costura?</b> ${esc(routeLabel)}<br>${sampleLabel}</div>
      ${enforcedMovementNotice}
      ${q.development_warning ? '<div class="notice warn"><b>Atenção:</b> a separação de peças para o setor Desenvolvimento ainda está pendente. Este aviso não bloqueia a conclusão.</div>' : ''}
    </div>
    <div class="summary-grid quality-summary">
      <div class="summary-box"><span>Meta da amostra</span><strong>${q.totals.sample_target}</strong></div>
      <div class="summary-box"><span>Amostra definida</span><strong>${q.totals.sample_defined}</strong></div>
      <div class="summary-box"><span>Atribuída</span><strong>${q.totals.assigned}</strong></div>
      <div class="summary-box"><span>Inspecionada</span><strong>${q.totals.inspected}</strong></div>
      <div class="summary-box"><span>Disponível</span><strong>${q.totals.available}</strong></div>
      <div class="summary-box"><span>Aprovada</span><strong>${q.totals.approved}</strong></div>
      <div class="summary-box"><span>Rejeitada</span><strong>${q.totals.rejected}</strong></div>
      <div class="summary-box"><span>Retrabalho</span><strong>${q.totals.rework}</strong></div>
    </div>
    ${developmentQualityHtml(q, canOperate)}
    ${qualityPreviousInspectionsHtml(q)}
    ${qualitySampleHtml(q, isOpen, canOperate)}
    ${qualityItemRoutesHtml(q, isOpen, canOperate)}
    ${qualityAssignmentAreaHtml(q, isOpen, canOperate)}
    ${qualityWorkersHtml(q, isOpen)}
    <h3 class="section-heading">Conclusão geral da inspeção</h3>
    ${q.validation_errors.length ? `<div class="notice warn"><b>Pendências para concluir:</b><br>${q.validation_errors.slice(0,10).map(esc).join("<br>")}${q.validation_errors.length>10?"<br>…":""}</div>` : '<div class="notice success-box"><b>Todos os itens e quantidades da amostra estão fechados.</b></div>'}
    <div class="actions">
      ${isOpen && canOperate ? `<button class="success" ${q.completion_ready?"":"disabled"} onclick="completeQualityInspection()">Concluir inspeção</button>` : ''}
      ${!isOpen ? '<span class="badge green">Inspeção concluída</span>' : ''}
    </div>
  </div>`;
}

function qualityPreviousInspectionsHtml(q) {
  const rows = q.previous_inspections || [];
  if (!rows.length) return "";
  const routeLabel = (row) => {
    const destination = row.destination === "CD01" ? "CD01 — nosso CD" : row.destination === "CD02" ? "CD02 — sai do fluxo" : "Destino não definido";
    const flow = row.source_subset
      ? "Destino por referência"
      : row.inspection_type === 1
        ? (row.send_to_costura === 1 || (row.send_to_costura == null && row.destination === "CD01") ? "Costura" : "Processamento")
        : "Processamento";
    return `${destination} · ${flow}`;
  };
  return `<h3 class="section-heading">Rodadas anteriores da Qualidade</h3><div class="table-wrap"><table>
    <thead><tr><th>Inspeção</th><th>Tipo</th><th>Destino</th><th>Amostra</th><th>Aprovada</th><th>Rejeitada</th><th>Retrabalho</th><th>Conclusão</th><th>Desenvolvimento</th></tr></thead>
    <tbody>${rows.map((row)=>`<tr><td>Inspeção ${row.inspection_type}</td><td>${row.purchase_mode==="SALDO"?"Saldo":"Grade"}</td><td>${esc(routeLabel(row))}</td><td>${row.sample_target_total}</td><td>${row.approved_total}</td><td>${row.rejected_total}</td><td>${row.rework_total}</td><td>${fmtDateTime(row.completed_at)}</td><td>${row.development_pending?'<span class="badge orange">Pendente</span>':'<span class="badge green">Regular</span>'}</td></tr>`).join("")}</tbody>
  </table></div>`;
}

function developmentQualityHtml(q, canOperate) {
  const requiredValue = q.development_required === null || q.development_required === undefined ? "" : String(q.development_required);
  const separatedValue = q.development_separated === null || q.development_separated === undefined ? "" : String(q.development_separated);
  if (!canOperate) {
    return `<h3 class="section-heading">Desenvolvimento</h3><div class="notice">Separação necessária: <b>${requiredValue==="1"?"Sim":requiredValue==="0"?"Não":"Não informado"}</b>${requiredValue==="1"?`<br>Peças separadas: <b>${separatedValue==="1"?"Sim":"Não"}</b>`:""}</div>`;
  }
  return `<h3 class="section-heading">Separação para Desenvolvimento</h3>
    <div class="form-grid">
      <div class="field"><label>É necessário separar peças?</label><select id="qualityDevRequired" onchange="toggleQualityDevelopmentEdit()"><option value="0" ${requiredValue==="0"?"selected":""}>Não</option><option value="1" ${requiredValue==="1"?"selected":""}>Sim</option></select></div>
      <div class="field" id="qualityDevSeparatedField" style="display:${requiredValue==="1"?"block":"none"}"><label>As peças já foram separadas?</label><select id="qualityDevSeparated"><option value="0" ${separatedValue!=="1"?"selected":""}>Não</option><option value="1" ${separatedValue==="1"?"selected":""}>Sim</option></select></div>
    </div><div class="actions"><button class="secondary" onclick="saveQualityDevelopment()">Atualizar Desenvolvimento</button></div>`;
}

function toggleQualityDevelopmentEdit() {
  if ($("qualityDevSeparatedField")) $("qualityDevSeparatedField").style.display = $("qualityDevRequired").value === "1" ? "block" : "none";
}

async function saveQualityDevelopment() {
  try {
    const required = $("qualityDevRequired").value === "1";
    await api(`/api/quality/inspections/${cardData.quality.id}/development`, {
      method: "PATCH",
      body: JSON.stringify({
        user_id: currentUser.id,
        development_required: required,
        development_separated: required ? $("qualityDevSeparated").value === "1" : null,
      }),
    });
    toast("Situação do Desenvolvimento atualizada.");
    await openCard(currentCardId, "quality");
  } catch (error) { toast(error.message); }
}

function qualitySampleHtml(q, isOpen, canOperate) {
  if (q.purchase_mode === "SALDO") {
    const row = q.sample_items[0];
    return `<h3 class="section-heading">Amostra automática — Saldo</h3>
      <div class="notice"><b>Quantidade geral:</b> não é necessário distribuir por produto, cor ou tamanho. A soma dos inspetores deve fechar ${q.totals.sample_target} peças.</div>
      <div class="summary-grid compact-summary">
        <div class="summary-box"><span>Amostra geral</span><strong>${row?.sample_qty ?? q.totals.sample_target}</strong></div>
        <div class="summary-box"><span>Atribuída</span><strong>${row?.assigned_total ?? 0}</strong></div>
        <div class="summary-box"><span>Disponível</span><strong>${row?.available_qty ?? q.totals.sample_target}</strong></div>
      </div>`;
  }
  const rows = [...q.sample_items].sort((a,b) =>
    String(a.product||"").localeCompare(String(b.product||""),"pt-BR") ||
    String(a.reference||a.sku||"").localeCompare(String(b.reference||b.sku||""),"pt-BR") ||
    String(a.color||"").localeCompare(String(b.color||""),"pt-BR") ||
    String(a.size||"").localeCompare(String(b.size||""),"pt-BR", {numeric:true})
  );
  const groupKey = (row) => [row.product||"",row.reference||row.sku||"",row.color||""].join("\\u0000");
  const groupedRows = rows.map((row,index) => {
    const key = groupKey(row);
    const previousKey = index > 0 ? groupKey(rows[index-1]) : null;
    const nextKey = index + 1 < rows.length ? groupKey(rows[index+1]) : null;
    const firstInGroup = key !== previousKey;
    const groupSize = firstInGroup ? rows.slice(index).findIndex((candidate) => groupKey(candidate) !== key) : 0;
    const rowSpan = firstInGroup ? (groupSize < 0 ? rows.length-index : groupSize) : 0;
    return `<tr>${firstInGroup ? `<td rowspan="${rowSpan}">${esc(row.product||"—")}</td><td rowspan="${rowSpan}">${esc(row.reference||row.sku||"—")}</td><td class="quality-color-group" rowspan="${rowSpan}">${esc(row.color||"—")}</td>` : ""}<td><span class="size-token">${esc(row.size||"—")}</span></td><td>${row.expected_qty}</td><td><b>${row.sample_qty}</b></td><td>${row.assigned_total}</td><td>${row.inspected_total}</td><td>${row.available_qty}</td></tr>`;
  }).join("");
  return `<h3 class="section-heading">Amostra automática — Grade</h3>
    <div class="notice">A amostra é organizada por produto e cor; cada tamanho continua em sua própria linha. Os totais mostram compra, amostra, peças atribuídas, inspecionadas e disponíveis.</div>
    <div class="table-wrap"><table class="quality-grade-table"><thead><tr><th>Produto</th><th>Referência/SKU</th><th>Cor</th><th>Tamanho</th><th>Qtd. compra</th><th>Amostra</th><th>Atribuída</th><th>Inspecionada</th><th>Disponível</th></tr></thead><tbody>
    ${groupedRows || '<tr><td colspan="9">A amostra ainda não foi definida.</td></tr>'}
    </tbody></table></div>`;
}

function qualityInspectorOptions(selectedId="") {
  return qualityUsers.map((u)=>`<option value="${u.id}" ${String(u.id)===String(selectedId)?"selected":""}>${esc(u.name)}</option>`).join("");
}

function qualityAssignmentAreaHtml(q, isOpen, canOperate) {
  if (!isOpen || !canOperate || !q.sample_items.length) return "";
  const availableRows = q.sample_items.filter((row)=>Number(row.available_qty)>0);
  if (!availableRows.length) return '<h3 class="section-heading">Atribuição rápida</h3><div class="notice success-box">Toda a amostra já foi atribuída.</div>';
  const supervisorMode = ["supervisor","admin"].includes(currentUser.role);
  return `<h3 class="section-heading">Atribuição rápida em lote</h3>
    <div class="notice"><b>Preencha várias linhas e confirme uma única vez.</b> O sistema reserva o item e a quantidade no mesmo salvamento.</div>
    <div class="bulk-toolbar">
      ${supervisorMode ? `<div class="field bulk-inspector"><label>Inspetor para todas as linhas</label><select id="qualityBatchInspector"><option value="">Selecione</option>${qualityInspectorOptions()}</select></div>` : `<div class="selected-inspector"><span>Inspetor</span><b>${esc(currentUser.name)}</b><input type="hidden" id="qualityBatchInspector" value="${currentUser.id}"></div>`}
      <div class="field bulk-search"><label>Pesquisar</label><input id="qualityAssignSearch" placeholder="Produto, SKU, cor ou tamanho" oninput="filterQualityAssignmentRows()"></div>
      <div class="actions compact-actions">
        <button class="success" onclick="assignAllQualityAvailable()">Atribuir todos os disponíveis</button>
        <button class="secondary" onclick="selectAllQualityAvailable()">Selecionar disponíveis</button>
        <button class="secondary" onclick="fillQualityBalances()">Assumir saldos selecionados</button>
        <button class="ghost" onclick="clearQualityBatch()">Limpar</button>
      </div>
    </div>
    <div class="table-wrap"><table id="qualityBatchTable"><thead><tr><th class="check-col"><input type="checkbox" id="qualityBatchAll" onchange="toggleQualityBatchAll(this.checked)"></th><th>Item</th><th>Amostra</th><th>Já atribuída</th><th>Disponível</th><th>Quantidade a assumir</th><th>Ação rápida</th></tr></thead><tbody>
      ${availableRows.map((row)=>{
        const itemLabel = row.sample_scope==="GERAL" ? "Quantidade geral — Saldo" : `${row.product||"—"} • ${row.reference||row.sku||"—"} • ${row.color||"—"} • ${row.size||"—"}`;
        return `<tr class="quality-batch-row" data-search="${esc(itemLabel.toLowerCase())}" data-sample-id="${row.id}" data-available="${row.available_qty}">
          <td><input class="quality-batch-check" type="checkbox" id="qualityBatchCheck_${row.id}" onchange="syncQualityBatchRow(${row.id})"></td>
          <td><b>${esc(row.product||"—")}</b>${row.sample_scope==="GERAL"?"":`<br><small>${esc(row.reference||row.sku||"—")} • ${esc(row.color||"—")} • ${esc(row.size||"—")}</small>`}</td>
          <td>${row.sample_qty}</td><td>${row.assigned_total}</td><td><b>${row.available_qty}</b></td>
          <td><input class="table-input quality-batch-qty" id="qualityBatchQty_${row.id}" type="number" min="1" max="${row.available_qty}" placeholder="0" oninput="syncQualityBatchQty(${row.id})" onkeydown="qualityBatchKeydown(event,${row.id})"></td>
          <td><button class="primary small-btn" onclick="quickClaimQuality(${row.id},${row.available_qty})">Assumir agora</button></td>
        </tr>`;
      }).join("")}
    </tbody></table></div>
    <div class="bulk-footer"><div id="qualityBatchSummary">Nenhuma linha selecionada.</div><button class="primary" onclick="saveQualityAssignmentsBatch()">Confirmar atribuições selecionadas</button></div>`;
}

function visibleQualityBatchRows() {
  return [...document.querySelectorAll(".quality-batch-row")].filter((row)=>row.style.display!=="none");
}

function filterQualityAssignmentRows() {
  const term = ($("qualityAssignSearch")?.value || "").trim().toLowerCase();
  document.querySelectorAll(".quality-batch-row").forEach((row)=>{
    row.style.display = !term || (row.dataset.search||"").includes(term) ? "" : "none";
  });
}

function toggleQualityBatchAll(checked) {
  visibleQualityBatchRows().forEach((row)=>{
    const id=row.dataset.sampleId;
    const box=$(`qualityBatchCheck_${id}`);
    if (box) box.checked=checked;
  });
  updateQualityBatchSummary();
}

function selectAllQualityAvailable() {
  toggleQualityBatchAll(true);
}

function useQualityBalance(id) {
  const row=document.querySelector(`.quality-batch-row[data-sample-id="${id}"]`);
  if (!row) return;
  $(`qualityBatchCheck_${id}`).checked=true;
  $(`qualityBatchQty_${id}`).value=row.dataset.available;
  updateQualityBatchSummary();
}

function fillQualityBalances() {
  visibleQualityBatchRows().forEach((row)=>{
    const id=row.dataset.sampleId;
    if ($(`qualityBatchCheck_${id}`)?.checked) $(`qualityBatchQty_${id}`).value=row.dataset.available;
  });
  updateQualityBatchSummary();
}

function clearQualityBatch() {
  document.querySelectorAll(".quality-batch-check").forEach((box)=>box.checked=false);
  document.querySelectorAll(".quality-batch-qty").forEach((input)=>input.value="");
  if ($("qualityBatchAll")) $("qualityBatchAll").checked=false;
  updateQualityBatchSummary();
}

function syncQualityBatchRow(id) {
  const checked=$(`qualityBatchCheck_${id}`)?.checked;
  const input=$(`qualityBatchQty_${id}`);
  const row=document.querySelector(`.quality-batch-row[data-sample-id="${id}"]`);
  if (checked && input && !input.value) input.value=row?.dataset.available||"";
  updateQualityBatchSummary();
}

function syncQualityBatchQty(id) {
  const input=$(`qualityBatchQty_${id}`);
  if (input && Number(input.value)>0) $(`qualityBatchCheck_${id}`).checked=true;
  updateQualityBatchSummary();
}

function qualityBatchKeydown(event,id) {
  if (event.key!=="Enter") return;
  event.preventDefault();
  const rows=visibleQualityBatchRows();
  const index=rows.findIndex((row)=>String(row.dataset.sampleId)===String(id));
  const next=rows[index+1];
  if (next) $(`qualityBatchQty_${next.dataset.sampleId}`)?.focus();
}

function updateQualityBatchSummary() {
  let lines=0,total=0;
  document.querySelectorAll(".quality-batch-row").forEach((row)=>{
    const id=row.dataset.sampleId;
    if ($(`qualityBatchCheck_${id}`)?.checked) {
      lines+=1;
      total+=Number($(`qualityBatchQty_${id}`)?.value||0);
    }
  });
  if ($("qualityBatchSummary")) $("qualityBatchSummary").innerHTML = lines ? `<b>${lines}</b> linha(s) • <b>${total}</b> peça(s)` : "Nenhuma linha selecionada.";
}

async function saveQualityAssignmentsBatch() {
  try {
    const inspectorId=Number($("qualityBatchInspector")?.value||0);
    if (!inspectorId) throw new Error("Selecione o inspetor.");
    const assignments=[];
    document.querySelectorAll(".quality-batch-row").forEach((row)=>{
      const id=Number(row.dataset.sampleId);
      if ($(`qualityBatchCheck_${id}`)?.checked) {
        const qty=Number($(`qualityBatchQty_${id}`)?.value||0);
        if (qty>0) assignments.push({sample_item_id:id,assigned_qty:qty});
      }
    });
    await api(`/api/quality/inspections/${cardData.quality.id}/assignments/batch`,{
      method:"POST",
      body:JSON.stringify({user_id:currentUser.id,inspector_id:inspectorId,assignments}),
    });
    toast(`${assignments.length} atribuição(ões) salva(s) de uma vez.`);
    await openCard(currentCardId,"quality");
  } catch (error) { toast(error.message); }
}

async function assignAllQualityAvailable() {
  try {
    const inspectorId = Number($("qualityBatchInspector")?.value || 0);
    if (!inspectorId) throw new Error("Selecione o inspetor.");
    const assignments = (cardData.quality?.sample_items || [])
      .filter((row) => Number(row.available_qty) > 0)
      .map((row) => ({ sample_item_id: Number(row.id), assigned_qty: Number(row.available_qty) }));
    if (!assignments.length) throw new Error("Não há quantidades disponíveis para atribuir.");
    await api(`/api/quality/inspections/${cardData.quality.id}/assignments/batch`, {
      method: "POST",
      body: JSON.stringify({ user_id: currentUser.id, inspector_id: inspectorId, assignments }),
    });
    toast(`${assignments.length} itens atribuídos de uma vez ao inspetor selecionado.`);
    await openCard(currentCardId, "quality");
  } catch (error) { toast(error.message); }
}

async function quickClaimQuality(sampleId,qty){
  try{
    const inspectorId=currentUser.role==="qualidade"?currentUser.id:Number($("qualityBatchInspector")?.value||0);
    if(!inspectorId)throw new Error("Selecione o inspetor.");
    await api(`/api/quality/inspections/${cardData.quality.id}/assignments/batch`,{method:"POST",body:JSON.stringify({user_id:currentUser.id,inspector_id:inspectorId,assignments:[{sample_item_id:sampleId,assigned_qty:qty}]})});
    toast("Item assumido. A próxima linha já está disponível."); await openCard(currentCardId,"quality");
  }catch(e){toast(e.message)}
}

function qualityWorkersHtml(q, isOpen) {
  if (!q.workers.length) return '<h3 class="section-heading">Inspetores</h3><div class="notice">Nenhum item foi atribuído.</div>';
  return '<h3 class="section-heading">Inspeção em lote</h3><div class="notice">Cada inspetor tem <b>um único cronômetro</b>, mesmo quando inspeciona dezenas de SKUs. Informe divergências por linha e salve os resultados de todos os itens de uma só vez.</div>' +
    q.workers.map((worker) => qualityWorkerHtml(worker, isOpen)).join("");
}

function qualityWorkerHtml(worker, isOpen) {
  const timer = worker.timer || {state:"NAO_INICIADA",business_seconds:0,paused_seconds:0,permanence_seconds:0};
  const canControlTimer = isOpen && (worker.inspector_id === currentUser.id || currentUser.role === "admin");
  const canEditResults = isOpen && (worker.inspector_id === currentUser.id || currentUser.role === "admin");
  const canManageAssignment = isOpen && (worker.inspector_id === currentUser.id || ["supervisor","admin"].includes(currentUser.role));
  return `<div class="quality-worker">
    <div class="quality-worker-head"><div><b>${esc(worker.inspector_name)}</b><br><span class="status-note">${worker.assignments.length} SKU/atribuição(ões)</span></div><span class="badge ${timer.state==="CONCLUIDA"?"green":timer.state==="PAUSADA"?"orange":timer.state==="EM_ANDAMENTO"?"purple":"gray"}">${esc(timer.state)}</span></div>
    <div class="timer-grid">
      <div class="timer-value"><span>Tempo útil</span><strong>${fmtSeconds(timer.business_seconds)}</strong></div>
      <div class="timer-value"><span>Tempo parado</span><strong>${fmtSeconds(timer.paused_seconds)}</strong></div>
      <div class="timer-value"><span>Permanência</span><strong>${fmtSeconds(timer.permanence_seconds)}</strong></div>
      <div class="timer-value"><span>Produção</span><strong>${worker.assignments.reduce((sum,item)=>sum+Number(item.inspected_qty||0),0)}</strong></div>
    </div>
    <div class="actions">
      ${canControlTimer && timer.state==="NAO_INICIADA"?`<button class="primary" onclick="qualityTimerAction(${worker.id},'start')">Iniciar cronômetro</button>`:""}
      ${canControlTimer && timer.state==="EM_ANDAMENTO"?`<button class="warning" onclick="qualityTimerAction(${worker.id},'pause')">Pausar</button><button class="success" onclick="qualityTimerAction(${worker.id},'finish')">Finalizar inspeção</button>`:""}
      ${canControlTimer && timer.state==="PAUSADA"?`<button class="primary" onclick="qualityTimerAction(${worker.id},'resume')">Retomar</button><button class="success" onclick="qualityTimerAction(${worker.id},'finish')">Finalizar inspeção</button>`:""}
      ${canEditResults && worker.assignments.length?`<button class="success" onclick="qualityApproveAllWorker(${worker.id})">Marcar todos como aprovados</button><button class="primary" onclick="saveQualityResultsBatch(${worker.id})">Salvar resultados em lote</button>`:""}
    </div>
    ${qualityAssignmentResultsTable(worker,canEditResults,canManageAssignment)}
  </div>`;
}

function qualityAssignmentResultsTable(worker, canEdit, canManage) {
  const rows = worker.assignments || [];
  if (!rows.length) return '<div class="notice">Nenhum SKU atribuído a este inspetor.</div>';
  return `<div class="table-wrap quality-results-wrap"><table class="compact-table quality-results-table">
    <thead><tr><th>Produto / SKU</th><th>Qtd. atribuída</th><th>Inspecionada</th><th>Rejeitada</th><th>Retrabalho</th><th>Aprovada</th><th>Motivo da rejeição</th><th>Motivo do retrabalho</th><th>Observação</th><th>Evidências / ações</th></tr></thead>
    <tbody>${rows.map((a) => {
      const photos = a.photo_paths || [];
      const itemDetails = [a.reference||a.sku, a.color, a.size].filter(Boolean).join(" • ") || "—";
      return `<tr class="quality-results-row" data-worker-id="${worker.id}" data-assignment-id="${a.id}" data-assigned-qty="${a.assigned_qty}">
        <td><b>${esc(a.product||"—")}</b><br><small>${esc(itemDetails)}</small></td>
        <td><b>${a.assigned_qty}</b></td>
        <td><input class="table-input quality-result-qty" id="qaInspected_${a.id}" type="number" min="0" max="${a.assigned_qty}" value="${a.inspected_qty}" ${canEdit?"":"readonly"} oninput="recalcQualityAssignment(${a.id})"></td>
        <td><input class="table-input quality-result-qty" id="qaRejected_${a.id}" type="number" min="0" max="${a.assigned_qty}" value="${a.rejected_qty}" ${canEdit?"":"readonly"} oninput="recalcQualityAssignment(${a.id})"></td>
        <td><input class="table-input quality-result-qty" id="qaRework_${a.id}" type="number" min="0" max="${a.assigned_qty}" value="${a.rework_qty}" ${canEdit?"":"readonly"} oninput="recalcQualityAssignment(${a.id})"></td>
        <td><input class="table-input quality-result-qty readonly" id="qaApproved_${a.id}" readonly value="${a.approved_qty}"></td>
        <td><input class="table-input quality-result-text" id="qaRejectReason_${a.id}" value="${esc(a.reject_reason||"")}" ${canEdit?"":"readonly"} placeholder="Obrigatório se rejeitar"></td>
        <td><input class="table-input quality-result-text" id="qaReworkReason_${a.id}" value="${esc(a.rework_reason||"")}" ${canEdit?"":"readonly"} placeholder="Obrigatório se retrabalhar"></td>
        <td><textarea class="table-input quality-result-observation" id="qaObservation_${a.id}" ${canEdit?"":"readonly"} placeholder="Observação em caso de divergência">${esc(a.observation||"")}</textarea></td>
        <td>
          <div class="quality-result-actions">
            ${photos.map((p,i)=>`<a class="photo-link" target="_blank" href="${p}">Evidência ${i+1}</a>`).join("")}
            ${canEdit?`<label class="secondary small-btn quality-evidence-upload">+ Foto<input id="qaFiles_${a.id}" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/bmp" multiple hidden onchange="uploadQualityAssignmentPhotos(${a.id})"></label>`:""}
            ${canManage && worker.status==="NAO_INICIADA"?`<button class="danger small-btn" onclick="releaseQualityAssignment(${a.id})">Devolver</button>`:""}
            ${canManage && Number(a.inspected_qty||0)===0?`<details class="quality-manage-details"><summary>Transferir</summary><select id="qaTransferTo_${a.id}"><option value="">Inspetor...</option>${qualityInspectorOptions()}</select><input id="qaTransferReason_${a.id}" placeholder="Motivo"><button class="warning small-btn" onclick="transferQualityAssignment(${a.id})">Transferir</button></details>`:""}
          </div>
        </td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

async function saveQualityResultsBatch(workerId) {
  try {
    const worker = cardData.quality?.workers?.find((item) => Number(item.id) === Number(workerId));
    if (!worker || !worker.assignments.length) throw new Error("Este inspetor não tem atribuições para salvar.");
    const results = worker.assignments.map((assignment) => {
      const payload = qualityAssignmentPayload(assignment.id);
      const {user_id, ...values} = payload;
      return {assignment_id: assignment.id, ...values};
    });
    await api(`/api/quality/workers/${workerId}/results/batch`, {
      method: "PATCH",
      body: JSON.stringify({user_id: currentUser.id, results}),
    });
    toast(`${results.length} resultado(s) salvo(s) em uma única operação.`);
    await openCard(currentCardId, "quality");
  } catch (error) { toast(error.message); }
}

async function qualityApproveAllWorker(workerId) {
  const worker = cardData.quality?.workers?.find((item) => Number(item.id) === Number(workerId));
  if (!worker || !worker.assignments.length) { toast("Este inspetor não tem itens atribuídos."); return; }
  if (!confirm(`Marcar os ${worker.assignments.length} itens deste inspetor como inspecionados e aprovados? Isso zera as quantidades de rejeição e retrabalho desta lista.`)) return;
  worker.assignments.forEach((assignment) => {
    const id = assignment.id;
    if ($(`qaInspected_${id}`)) $(`qaInspected_${id}`).value = assignment.assigned_qty;
    if ($(`qaRejected_${id}`)) $(`qaRejected_${id}`).value = 0;
    if ($(`qaRework_${id}`)) $(`qaRework_${id}`).value = 0;
    recalcQualityAssignment(id);
  });
  await saveQualityResultsBatch(workerId);
}

async function qualityAllApproved(id,qty){
  $(`qaInspected_${id}`).value=qty;$(`qaRejected_${id}`).value=0;$(`qaRework_${id}`).value=0;recalcQualityAssignment(id);
  await saveQualityResult(id);
}

function recalcQualityAssignment(id) {
  const inspected=Number($(`qaInspected_${id}`)?.value||0), rejected=Number($(`qaRejected_${id}`)?.value||0), rework=Number($(`qaRework_${id}`)?.value||0);
  if ($(`qaApproved_${id}`)) $(`qaApproved_${id}`).value = Math.max(0, inspected-rejected-rework);
}

function qualityAssignmentPayload(id, photosOverride=null) {
  const worker = cardData.quality.workers.find((w)=>w.assignments.some((a)=>a.id===id));
  const assignment = worker?.assignments.find((a)=>a.id===id);
  return {
    user_id: currentUser.id,
    inspected_qty: Number($(`qaInspected_${id}`).value||0),
    rejected_qty: Number($(`qaRejected_${id}`).value||0),
    rework_qty: Number($(`qaRework_${id}`).value||0),
    reject_reason: $(`qaRejectReason_${id}`).value,
    rework_reason: $(`qaReworkReason_${id}`).value,
    observation: $(`qaObservation_${id}`).value,
    photo_paths: photosOverride || assignment?.photo_paths || [],
  };
}

async function saveQualityResult(id, photosOverride=null) {
  try {
    await api(`/api/quality/assignments/${id}/result`, { method:"PATCH", body:JSON.stringify(qualityAssignmentPayload(id,photosOverride)) });
    toast("Resultado salvo.");
    await openCard(currentCardId,"quality");
  } catch (error) { toast(error.message); }
}

async function uploadQualityAssignmentPhotos(id) {
  try {
    const files = Array.from($(`qaFiles_${id}`).files||[]);
    if (!files.length) return;
    const form=new FormData(); files.forEach((f)=>form.append("files",f));
    form.append("user_id", String(currentUser.id));
    const uploaded=await api("/api/quality/uploads",{method:"POST",body:form});
    const worker=cardData.quality.workers.find((w)=>w.assignments.some((a)=>a.id===id));
    const assignment=worker.assignments.find((a)=>a.id===id);
    await saveQualityResult(id,[...(assignment.photo_paths||[]),...uploaded.paths]);
  } catch (error) { toast(error.message); }
}

async function qualityTimerAction(workerId, action) {
  try {
    await api(`/api/quality/workers/${workerId}/timer/${action}`, {method:"POST",body:JSON.stringify({user_id:currentUser.id})});
    toast("Tempo da inspeção atualizado.");
    await openCard(currentCardId,"quality");
  } catch (error) { toast(error.message); }
}

async function releaseQualityAssignment(id) {
  if (!confirm("Devolver este item e quantidade para a disponibilidade?")) return;
  try {
    await api(`/api/quality/assignments/${id}/release`,{method:"POST",body:JSON.stringify({user_id:currentUser.id})});
    toast("Atribuição devolvida.");
    await openCard(currentCardId,"quality");
  } catch (error) { toast(error.message); }
}

async function transferQualityAssignment(id) {
  try {
    await api(`/api/quality/assignments/${id}/transfer`,{method:"POST",body:JSON.stringify({user_id:currentUser.id,to_user_id:Number($(`qaTransferTo_${id}`).value||0),reason:$(`qaTransferReason_${id}`).value})});
    toast("Atribuição transferida.");
    await openCard(currentCardId,"quality");
  } catch (error) { toast(error.message); }
}

async function completeQualityInspection() {
  const q=cardData.quality;
  let confirmPending=false;
  if (q.development_warning) {
    confirmPending=confirm("Existem peças pendentes de separação para o setor Desenvolvimento. Deseja concluir a inspeção mesmo assim?");
    if (!confirmPending) return;
  } else if (!confirm("Concluir definitivamente esta inspeção e movimentar o Card?")) return;
  try {
    await api(`/api/quality/inspections/${q.id}/complete`,{method:"POST",body:JSON.stringify({user_id:currentUser.id,confirm_development_pending:confirmPending})});
    toast("Inspeção concluída e Card movimentado.");
    await openCard(currentCardId,"quality");
  } catch (error) { toast(error.message); }
}


function processingInspectionHandoffNotice() {
  const transferred = (cardData.history || []).some(
    (event) => event.event_type === "INSPECAO_2_TRANSFERIDA_PROCESSAMENTO"
  );
  if (!transferred) return "";
  return '<div class="notice success-box"><b>Responsabilidade pela Inspeção 2</b><br>Este Card foi encaminhado diretamente ao Processamento antes de qualquer atividade na Qualidade. A responsabilidade operacional agora é deste setor.</div>';
}

async function renderProcessingTab() {
  if (guardSampleAllocationNavigation()) return;
  activateTab("tabProcessingBtn");
  const p=cardData.processing;
  const sector=String(cardData.current_sector||"").toUpperCase();
  const history=cardData.history||[];
  const hasEvent=(...types)=>history.some(e=>types.includes(e.event_type));
  let cadastroTasks=[],downstreamDivergence={operation:null,pending:[],awaiting_recount:[]};
  try{cadastroTasks=await api("/api/processing/cadastro/card/"+cardData.id+"?user_id="+currentUser.id);}catch(_error){}
  if(["processamento","supervisor","admin"].includes(currentUser.role)){
    try{downstreamDivergence=await api("/api/processing/downstream-divergence/card/"+cardData.id+"?user_id="+currentUser.id);}catch(_error){}
  }
  const triageDone=hasEvent("TRIAGEM_CONCLUIDA") || ["ETIQUETAGEM","ESTOCAGEM","FINALIZADO"].includes(sector);
  const cadastroDone=cadastroTasks.length>0&&cadastroTasks.every(t=>t.status==="CONCLUIDO");
  const labelingDone=hasEvent("ETIQUETAGEM_CONCLUIDA","ETIQUETAGEM_CONFERENCIA_OK") || ["ESTOCAGEM","FINALIZADO"].includes(sector);
  const storageDone=hasEvent("ESTOCAGEM_CONCLUIDA","ESTOCAGEM_CONFERENCIA_OK") || sector==="FINALIZADO";
  const entryDone=hasEvent("ENTRADA_ESTOCAGEM_CONFIRMADA");
  const steps=[
    ["Triagem",triageDone,sector==="PROCESSAMENTO"],
    ["Cadastro",cadastroDone,!cadastroDone&&triageDone],
    ["Etiquetagem",labelingDone,sector==="ETIQUETAGEM"],
    ["Estocagem",storageDone,sector==="ESTOCAGEM"],
    ["Entrada",entryDone,storageDone&&!entryDone]
  ];
  const flow=steps.map(([label,done,current])=>'<div class="summary-box"><span>'+esc(label)+'</span><strong>'+(done?"✓ Concluído":current?"• Atual":"— Pendente")+'</strong></div>').join("");
  const qty=p?.totals||{};
  const responsible=[...history].reverse().find(e=>["TRIAGEM_INICIADA","CADASTRO_INICIADO","ETIQUETAGEM_INICIADA","ESTOCAGEM_INICIADA"].includes(e.event_type));
  const divergence=[...history].reverse().find(e=>String(e.event_type||"").includes("DIVERGENTE"));
  const correctionRows=(downstreamDivergence.pending||[]).map(row=>'<tr class="processing-divergence-row" data-item-id="'+Number(row.item_id)+'"><td><b>'+esc(row.reference||row.product||"—")+'</b></td><td>'+esc(row.color||"—")+'</td><td>'+esc(row.size||"—")+'</td><td>'+Number(row.counted_qty||0).toLocaleString("pt-BR")+'</td><td><input class="processing-corrected-qty" type="number" min="0" step="1" value="'+Number(row.current_qty||0)+'" required></td></tr>').join("");
  const correctionPanel=downstreamDivergence.operation&&((downstreamDivergence.pending||[]).length||(downstreamDivergence.awaiting_recount||[]).length)
    ? '<h3 class="section-heading">Divergência persistente · '+esc(downstreamDivergence.operation.sector||"")+'</h3>'+
      ((downstreamDivergence.pending||[]).length
        ? '<div class="notice warn"><b>Intervenção do Processamento necessária.</b><br>Essas linhas continuaram divergentes após a recontagem. Somente o Processamento pode confirmar a grade correta. Depois da correção, o setor deverá fazer uma nova conferência.</div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Última contagem</th><th>Grade correta</th></tr></thead><tbody>'+correctionRows+'</tbody></table></div><div class="field"><label>Motivo da correção</label><textarea id="processingCorrectionReason" rows="2" placeholder="Explique por que a grade está sendo alterada"></textarea></div><div class="actions"><button class="warning" onclick="submitProcessingDivergenceCorrection('+Number(downstreamDivergence.operation.id)+')">Confirmar grade corrigida</button></div>'
        : '')+
      ((downstreamDivergence.awaiting_recount||[]).length
        ? '<div class="notice success-box"><b>Grade corrigida pelo Processamento.</b><br>Aguardando nova conferência de '+esc(downstreamDivergence.operation.sector||"setor")+'.</div>'
        : '')
    : "";
  $("cardTab").innerHTML='<div class="panel-body"><div class="notice"><b>Visão geral do Processamento</b><br>Esta aba acompanha o caminho do Card. As operações são realizadas nas etapas correspondentes do fluxo.</div><div class="summary-grid processing-summary">'+flow+'</div><h3 class="section-heading">Situação do Card</h3><div class="form-grid"><div class="field"><label>Setor atual</label><input class="readonly" readonly value="'+esc(cardData.current_sector||"—")+'"></div><div class="field"><label>Status</label><input class="readonly" readonly value="'+esc(cardData.status||"—")+'"></div><div class="field"><label>Tipo da compra</label><input class="readonly" readonly value="'+esc(cardData.purchase_mode==="GRADE"?"Grade":"Saldo")+'"></div><div class="field"><label>Quantidade prevista</label><input class="readonly" readonly value="'+Number(qty.expected??cardData.expected_total??0).toLocaleString("pt-BR")+'"></div>'+(responsible?'<div class="field"><label>Último responsável operacional</label><input class="readonly" readonly value="'+esc(responsible.user_name||responsible.description||"Registrado no histórico")+'"></div>':"")+'</div>'+(divergence?'<div class="notice warn"><b>Última divergência registrada</b><br>'+esc(divergence.description||"Existe uma conferência divergente pendente de verificação.")+'</div>':"")+correctionPanel+'<div class="notice success-box"><b>Sem configuração paralela.</b><br>Triagem, Cadastro, Etiquetagem, Estocagem e Entrada mantêm suas próprias regras e responsáveis.</div></div>';
}
async function submitProcessingDivergenceCorrection(operationId){
  try{
    const rows=[...document.querySelectorAll(".processing-divergence-row")];
    const items=rows.map(row=>{
      const input=row.querySelector(".processing-corrected-qty"),quantity=Number(input?.value);
      if(!input||input.value===""||!Number.isSafeInteger(quantity)||quantity<0)throw new Error("Informe a grade correta de todas as linhas divergentes.");
      return {item_id:Number(row.dataset.itemId),quantity};
    });
    const reason=$("processingCorrectionReason")?.value.trim()||"";
    if(!reason)throw new Error("Informe o motivo da correção da grade.");
    await api("/api/processing/downstream-divergence/"+operationId+"/correct",{method:"POST",body:JSON.stringify({user_id:currentUser.id,items,reason})});
    toast("Grade corrigida. O setor deve fazer uma nova conferência.");
    await renderProcessingTab();
  }catch(error){toast(error.message);}
}

function processingSetupHtml(importedItems=[]) {
  const modeLabel = cardData.purchase_mode === "GRADE" ? "Grade — importado como Private Label" : cardData.purchase_mode === "SALDO" ? "Saldo" : "Tipo não reconhecido";
  const rmVolumes=cardData.rm_item_volumes||{};
  const volumeOnly=Boolean(cardData.rm_volume_only);
  if(!volumeOnly) importedItems=importedItems.filter(function(item){return Number(rmVolumes[String(item.id)]||0)>0;});
  const imported = importedItems.length > 0;
  const importedQty = volumeOnly ? Number(cardData.global_allocated_volume_total||0) : importedItems.reduce((sum,item)=>sum+Number(rmVolumes[String(item.id)]||0),0);
  const importedPicker = !imported ? "" : cardData.purchase_mode === "GRADE" ? (
    '<div class="notice success-box"><b>Selecione as referências que entrarão nesta produção.</b><br>'+(volumeOnly ? 'O RM guarda somente o saldo global de volumes, sem vínculo a produto, cor ou tamanho. A quantidade processada por referência será informada nesta etapa e validada contra o saldo global.' : 'Somente os volumes das referências posicionadas em Aguardando Processamento serão movimentados. A composição de grade será definida posteriormente na Triagem.')+'</div>' +
    '<div class="table-wrap compact-picker"><table class="compact-table"><thead><tr><th class="check-col"><input id="processingImportedAll" type="checkbox" checked onchange="toggleImportedProcessingItems(this.checked)"></th><th>Produto</th><th>Referência</th><th>Volumes</th></tr></thead><tbody>' +
      importedItems.map(function(item){
        return '<tr><td><input class="processing-import-item" type="checkbox" value="'+item.id+'" checked onchange="updateImportedProcessingSummary()"></td><td><b>'+esc(item.product||"—")+'</b></td><td><b>'+esc(item.reference||item.sku||"—")+'</b><small>'+Number(item.expected_qty||0).toLocaleString("pt-BR")+' peças</small></td><td><b>'+(volumeOnly?"—":Number(rmVolumes[String(item.id)]||0).toLocaleString("pt-BR"))+'</b></td></tr>';
      }).join("") +
    '</tbody></table></div><div id="processingImportedSummary" class="queue-counter"><b>'+importedItems.length+'</b> referência(s) • <b>'+importedQty+'</b> '+(volumeOnly?"volume(s) no saldo global":"volume(s) selecionado(s)")+'</div>'
  ) : (
    '<div class="notice success-box"><b>Volumes disponíveis para produção</b><br>'+importedItems.length+' referência(s), total de '+importedQty+' volume(s). O apontamento continuará por quantidade geral.</div>'
  );

  return '<div class="panel-body">' +
    '<div class="notice"><b>Configuração inicial do Processamento</b><br>O tipo da compra vem automaticamente do Excel e não pode ser alterado neste setor.'+
      (imported ? ' O Card-mãe continuará no Recebimento porque esta compra possui itens em etapas diferentes.' : '') +
    '</div>' +
    importedPicker +
    '<div class="form-grid">' +
      '<div class="field"><label>Tipo da compra</label><input class="readonly" readonly value="'+esc(modeLabel)+'"></div>' +
      '<div class="field"><label>Marca</label><input id="processingBrand" value="'+esc(cardData.brand||"")+'" placeholder="Informe a marca"></div>' +
      '<div class="field"><label>Perfil da compra</label><select id="processingProfile"><option value="">Selecione</option><option value="CADASTRO_ENTRADA">Cadastro + Entrada</option><option value="SOMENTE_ENTRADA">Somente Entrada</option></select></div>' +
      '<div class="field"><label>Necessita Etiquetagem?</label><select id="processingNeedsLabeling" onchange="toggleProcessingLabelField()"><option value="">Selecione</option><option value="1">Sim</option><option value="0">Não</option></select></div>' +
      '<div class="field" id="processingLabelTypeField" style="display:none"><label>Tipo de etiqueta</label><select id="processingLabelType"><option value="">Selecione</option><option value="BRANCA">Branca — descrição, EAN e valor</option><option value="VERMELHA">Vermelha — valor</option><option value="PERSONALIZADA">Personalizada</option></select></div>' +
      (cardData.purchase_mode === "GRADE" ? '<div class="field full"><label class="check-line"><input id="processingDeferQty" type="checkbox"> Os volumes finais serão confirmados somente na Estocagem</label></div>' : '') +
      '<div class="field full"><label>Observações</label><textarea id="processingNotes"></textarea></div>' +
    '</div>' +
    '<div class="actions"><button class="primary" onclick="createProcessing()">Configurar Processamento</button></div>' +
  '</div>';
}

function toggleProcessingLabelField() {
  const visible = $("processingNeedsLabeling")?.value === "1";
  if ($("processingLabelTypeField")) $("processingLabelTypeField").style.display = visible ? "block" : "none";
}

async function createProcessing() {
  try {
    const triage = "1";
    const labeling = $("processingNeedsLabeling").value;
    const importedChecks = [...document.querySelectorAll(".processing-import-item")];
    const itemIds = importedChecks.filter((input)=>input.checked).map((input)=>Number(input.value));
    if (importedChecks.length && !itemIds.length) throw new Error("Selecione pelo menos uma referência para produzir.");
    await api(`/api/cards/${currentCardId}/processing`, {
      method: "POST",
      body: JSON.stringify({
        user_id: currentUser.id,
        brand: $("processingBrand").value,
        operation_profile: $("processingProfile").value,
        needs_triage: triage === "" ? null : triage === "1",
        needs_labeling: labeling === "" ? null : labeling === "1",
        label_type: $("processingLabelType")?.value || null,
        quantity_deferred_to_storage: Boolean($("processingDeferQty")?.checked),
        notes: $("processingNotes").value,
        item_ids: itemIds,
      }),
    });
    toast("Processamento configurado.");
    await openCard(currentCardId, "processing");
  } catch (error) { toast(error.message); }
}

function toggleImportedProcessingItems(checked){document.querySelectorAll(".processing-import-item").forEach((input)=>input.checked=checked);updateImportedProcessingSummary();}
function updateImportedProcessingSummary(){
  const selected=[...document.querySelectorAll(".processing-import-item:checked")];
  const ids=new Set(selected.map((input)=>Number(input.value)));
  const items=(cardData.items||[]).filter((item)=>ids.has(Number(item.id)));
  const rmVolumes=cardData.rm_item_volumes||{};
  const qty=cardData.rm_volume_only ? Number(cardData.global_allocated_volume_total||0) : items.reduce((sum,item)=>sum+Number(rmVolumes[String(item.id)]||0),0);
  if($("processingImportedSummary"))$("processingImportedSummary").innerHTML=`<b>${items.length}</b> referência(s) • <b>${qty}</b> ${cardData.rm_volume_only?"volume(s) no saldo global":"volume(s) selecionado(s)"}`;
  if($("processingImportedAll"))$("processingImportedAll").checked=selected.length===document.querySelectorAll(".processing-import-item").length;
}

function processingDetailHtml(p) {
  const isOpen = p.status === "ABERTO";
  const canOperate = canOperateProcessing();
  const modeLabel = p.purchase_mode === "GRADE" ? "Grade" : "Saldo";
  const routeLabel = p.needs_triage ? "Triagem" : p.needs_labeling ? "Etiquetagem" : "Estocagem";
  return `<div class="panel-body">
    <div class="notice ${p.status === "CONCLUIDO" ? "success-box" : ""}"><b>Processamento ${p.status === "CONCLUIDO" ? "concluído" : "aberto"}</b><br>Tipo: <b>${modeLabel}</b> • Próximo destino configurado: <b>${routeLabel}</b></div>
    <div class="summary-grid processing-summary">
      <div class="summary-box"><span>Quantidade prevista</span><strong>${p.totals.expected}</strong></div>
      <div class="summary-box"><span>Quantidade processada</span><strong>${p.totals.processed}</strong></div>
      <div class="summary-box"><span>Quantidade estocada</span><strong>${p.totals.stored}</strong></div>
      <div class="summary-box"><span>Produção apontada</span><strong>${p.totals.worker_production}</strong></div>
      <div class="summary-box"><span>Tipo</span><strong>${modeLabel}</strong></div>
      <div class="summary-box"><span>Marca</span><strong>${esc(p.brand)}</strong></div>
    </div>
    ${processingConfigurationHtml(p, isOpen && canOperate)}
    ${processingWorkersHtml(p, isOpen)}
    ${processingQuantitiesHtml(p, isOpen && canOperate)}
    <h3 class="section-heading">Conclusão do Processamento</h3>
    ${p.validation_errors?.length ? `<div class="notice warn"><b>Pendências:</b><br>${p.validation_errors.map(esc).join("<br>")}</div>` : '<div class="notice success-box"><b>Processamento pronto para conclusão.</b></div>'}
    <div class="actions">
      ${isOpen && canOperate ? `<button class="success" ${p.validation_errors?.length ? "disabled" : ""} onclick="completeProcessing()">Concluir Processamento</button>` : ""}
      ${!isOpen ? '<span class="badge green">Processamento concluído</span>' : ""}
    </div>
  </div>`;
}

function processingConfigurationHtml(p, editable) {
  const profileLabel = p.operation_profile === "CADASTRO_ENTRADA" ? "Cadastro + Entrada" : "Somente Entrada";
  if (!editable) {
    return `<h3 class="section-heading">Configuração</h3><div class="form-grid">
      <div class="field"><label>Marca</label><input class="readonly" readonly value="${esc(p.brand)}"></div>
      <div class="field"><label>Perfil</label><input class="readonly" readonly value="${esc(profileLabel)}"></div>
      <div class="field"><label>Triagem</label><input class="readonly" readonly value="${p.needs_triage ? "Sim" : "Não"}"></div>
      <div class="field"><label>Etiquetagem</label><input class="readonly" readonly value="${p.needs_labeling ? "Sim" : "Não"}"></div>
      <div class="field"><label>Tipo de etiqueta</label><input class="readonly" readonly value="${esc(p.label_type||"Não se aplica")}"></div>
      <div class="field"><label>Volumes</label><input class="readonly" readonly value="${p.quantity_deferred_to_storage ? "Confirmar na Estocagem" : "Informada no Processamento"}"></div>
    </div>`;
  }
  return `<h3 class="section-heading">Configuração</h3><div class="form-grid">
    <div class="field"><label>Tipo da compra</label><input class="readonly" readonly value="${p.purchase_mode === "GRADE" ? "Grade" : "Saldo"}"></div>
    <div class="field"><label>Marca</label><input id="processingBrand" value="${esc(p.brand)}"></div>
    <div class="field"><label>Perfil da compra</label><select id="processingProfile"><option value="CADASTRO_ENTRADA" ${p.operation_profile === "CADASTRO_ENTRADA" ? "selected" : ""}>Cadastro + Entrada</option><option value="SOMENTE_ENTRADA" ${p.operation_profile === "SOMENTE_ENTRADA" ? "selected" : ""}>Somente Entrada</option></select></div>
    <div class="field"><label>Necessita Triagem?</label><select id="processingNeedsTriage"><option value="1" ${p.needs_triage ? "selected" : ""}>Sim</option><option value="0" ${!p.needs_triage ? "selected" : ""}>Não</option></select></div>
    <div class="field"><label>Necessita Etiquetagem?</label><select id="processingNeedsLabeling" onchange="toggleProcessingLabelField()"><option value="1" ${p.needs_labeling ? "selected" : ""}>Sim</option><option value="0" ${!p.needs_labeling ? "selected" : ""}>Não</option></select></div>
    <div class="field" id="processingLabelTypeField" style="display:${p.needs_labeling ? "block" : "none"}"><label>Tipo de etiqueta</label><select id="processingLabelType"><option value="BRANCA" ${p.label_type === "BRANCA" ? "selected" : ""}>Branca</option><option value="VERMELHA" ${p.label_type === "VERMELHA" ? "selected" : ""}>Vermelha</option><option value="PERSONALIZADA" ${p.label_type === "PERSONALIZADA" ? "selected" : ""}>Personalizada</option></select></div>
    ${p.purchase_mode === "GRADE" ? `<div class="field full"><label class="check-line"><input id="processingDeferQty" type="checkbox" ${p.quantity_deferred_to_storage ? "checked" : ""}> Os volumes finais serão confirmados somente na Estocagem</label></div>` : ""}
    <div class="field full"><label>Observações</label><textarea id="processingNotes">${esc(p.notes||"")}</textarea></div>
  </div><div class="actions"><button class="secondary" onclick="saveProcessingConfiguration()">Salvar configuração</button></div>`;
}

async function saveProcessingConfiguration() {
  try {
    const p = cardData.processing;
    await api(`/api/processing/${p.id}/configuration`, {
      method: "PATCH",
      body: JSON.stringify({
        user_id: currentUser.id,
        brand: $("processingBrand").value,
        operation_profile: $("processingProfile").value,
        needs_triage: $("processingNeedsTriage").value === "1",
        needs_labeling: $("processingNeedsLabeling").value === "1",
        label_type: $("processingLabelType")?.value || null,
        quantity_deferred_to_storage: Boolean($("processingDeferQty")?.checked),
        notes: $("processingNotes").value,
      }),
    });
    toast("Configuração atualizada.");
    await openCard(currentCardId, "processing");
  } catch (error) { toast(error.message); }
}

function processingUserOptions(selected="") {
  return processingUsers.map((u) => `<option value="${u.id}" ${String(u.id)===String(selected)?"selected":""}>${esc(u.name)}</option>`).join("");
}

function processingStagesHtml(p) {
  const fn = (w) => (w.function === "CADASTRO" ? "CADASTRO" : "TRIAGEM");
  const done = (st) => p.workers.some((w) => fn(w) === st && w.status === "CONCLUIDA");
  const started = (st) => p.workers.some((w) => fn(w) === st);
  const stages = [...(p.operation_profile === "CADASTRO_ENTRADA" ? ["CADASTRO"] : []), "TRIAGEM"];
  const label = (st) => (st === "CADASTRO" ? "Cadastro" : "Triagem");
  const chips = stages.map((st) => `<span class="badge ${done(st) ? "green" : started(st) ? "purple" : "gray"}">${done(st) ? "✓ " : ""}${label(st)}</span>`).join(" → ");
  return `<div class="notice">${chips} → <span class="badge gray">${p.needs_labeling ? "Etiquetagem" : "Estocagem"}</span><br><small>Ao concluir a última tarefa (com as quantidades por tamanho informadas), o card segue sozinho.</small></div>`;
}

function processingWorkersHtml(p, isOpen) {
  const currentAlready = p.workers.some((w) => w.user_id === currentUser.id);
  const addArea = isOpen && canOperateProcessing() ? `<div class="bulk-toolbar processing-worker-add">
    ${currentUser.role === "processamento" ? `<div class="selected-inspector"><span>Operador</span><b>${esc(currentUser.name)}</b></div><button class="primary" ${currentAlready ? "disabled" : ""} onclick="addProcessingWorker(${currentUser.id})">Assumir Card</button>` : `<div class="field"><label>Tarefa</label><select id="processingFunctionSelect">${p.operation_profile==="CADASTRO_ENTRADA"?'<option value="CADASTRO">Cadastro</option>':""}<option value="TRIAGEM">Triagem</option></select></div><div class="field"><label>Adicionar colaborador</label><select id="processingWorkerSelect"><option value="">Selecione</option>${processingUserOptions()}</select></div><button class="primary" onclick="addProcessingWorker(Number($(\"processingWorkerSelect\").value||0))">Adicionar</button>`}
  </div>` : "";
  return `<h3 class="section-heading">Tarefas do Processamento</h3>${processingStagesHtml(p)}${addArea}${p.workers.length ? p.workers.map((w)=>`<small>Tarefa: <b>${w.function === "CADASTRO" ? "Cadastro" : "Triagem"}</b></small>`+processingWorkerHtml(w,isOpen)).join("") : '<div class="notice">Nenhum colaborador assumiu o Card.</div>'}`;
}

function processingWorkerHtml(w, isOpen) {
  const timer = w.timer || {state:"NAO_INICIADA",business_seconds:0,paused_seconds:0,permanence_seconds:0};
  const canControl = isOpen && (w.user_id === currentUser.id || currentUser.role === "admin");
  const canEdit = isOpen && (w.user_id === currentUser.id || ["supervisor","admin"].includes(currentUser.role));
  return `<div class="processing-worker">
    <div class="quality-worker-head"><div><b>${esc(w.user_name)}</b><br><span class="status-note">Produção individual</span></div><span class="badge ${timer.state === "CONCLUIDA" ? "green" : timer.state === "PAUSADA" ? "orange" : timer.state === "EM_ANDAMENTO" ? "purple" : "gray"}">${esc(timer.state)}</span></div>
    <div class="timer-grid">
      <div class="timer-value"><span>Tempo útil</span><strong>${fmtSeconds(timer.business_seconds)}</strong></div>
      <div class="timer-value"><span>Tempo parado</span><strong>${fmtSeconds(timer.paused_seconds)}</strong></div>
      <div class="timer-value"><span>Permanência</span><strong>${fmtSeconds(timer.permanence_seconds)}</strong></div>
      <div class="timer-value"><span>Produção</span><strong>${w.produced_qty}</strong></div>
    </div>
    <div class="form-grid" style="margin-top:10px"><div class="field"><label>Volumes produzidos por este colaborador</label><input id="processingWorkerQty_${w.id}" type="number" min="0" value="${w.produced_qty}" ${canEdit ? "" : "readonly"}></div></div>
    <div class="actions">
      ${canEdit ? `<button class="secondary" onclick="saveProcessingWorkerProduction(${w.id})">Salvar produção</button>` : ""}
      ${canControl && timer.state === "NAO_INICIADA" ? `<button class="primary" onclick="processingTimerAction(${w.id},'start')">Iniciar</button>` : ""}
      ${canControl && timer.state === "EM_ANDAMENTO" ? `<button class="warning" onclick="processingTimerAction(${w.id},'pause')">Pausar</button><button class="success" onclick="processingTimerAction(${w.id},'finish')">Finalizar</button>` : ""}
      ${canControl && timer.state === "PAUSADA" ? `<button class="primary" onclick="processingTimerAction(${w.id},'resume')">Retomar</button><button class="success" onclick="processingTimerAction(${w.id},'finish')">Finalizar</button>` : ""}
    </div>
  </div>`;
}

async function addProcessingWorker(userId) {
  if (!userId) return toast("Selecione o colaborador.");
  try {
    await api(`/api/processing/${cardData.processing.id}/workers`, {method:"POST",body:JSON.stringify({user_id:currentUser.id,worker_user_id:userId,function:$("processingFunctionSelect")?.value||"PROCESSAMENTO"})});
    toast("Colaborador incluído.");
    await openCard(currentCardId,"processing");
  } catch (error) { toast(error.message); }
}

async function saveProcessingWorkerProduction(workerId) {
  try {
    await api(`/api/processing/workers/${workerId}/production`, {method:"PATCH",body:JSON.stringify({user_id:currentUser.id,produced_qty:Number($(`processingWorkerQty_${workerId}`).value||0)})});
    toast("Produção salva.");
    await openCard(currentCardId,"processing");
  } catch (error) { toast(error.message); }
}

async function processingTimerAction(workerId, action) {
  try {
    await api(`/api/processing/workers/${workerId}/timer/${action}`, {method:"POST",body:JSON.stringify({user_id:currentUser.id})});
    toast("Cronômetro atualizado.");
    await openCard(currentCardId,"processing");
  } catch (error) { toast(error.message); }
}


function processingQuantitiesHtml(p, editable) {
  const copyButton = '<button class="ghost" '+(p.totals.stored > 0 && editable ? "" : "disabled")+' onclick="copyStoredToProcessed()">Copiar Estocada → Processada</button>';

  if (p.purchase_mode === "SALDO") {
    return '<h3 class="section-heading">Volumes — Saldo</h3><div class="notice">Para compras Saldo, o controle é feito somente pelo volume geral.</div>' +
      '<div class="form-grid"><div class="field"><label>Volumes previstos</label><input class="readonly" readonly value="'+p.totals.expected+'"></div>' +
      '<div class="field"><label>Volumes processados</label><input id="processingGeneralQty" type="number" min="0" value="'+p.processed_qty_general+'" '+(editable ? "" : "readonly")+'></div>' +
      '<div class="field"><label>Volumes estocados</label><input class="readonly" readonly value="'+p.stored_qty_general+'"></div></div>' +
      '<div class="actions">'+(editable ? '<button class="primary" onclick="saveProcessingQuantities()">Salvar volumes</button>' : '')+copyButton+'</div>';
  }

  const volumeOnly = p.volume_allocation_mode === "VOLUMES";
  const deferredNotice = (volumeOnly
    ? '<div class="notice">O RM foi endereçado por volumes, sem vínculo individual por referência. Informe o processamento por referência nesta etapa; a soma será validada contra o saldo global de '+Number(p.global_allocated_volume_total||0).toLocaleString("pt-BR")+' volume(s).</div>'
    : '') + (p.quantity_deferred_to_storage
    ? '<div class="notice warn">Os volumes finais serão confirmados na Estocagem. É permitido concluir o Processamento sem preencher todas as referências.</div>'
    : volumeOnly ? '' : '<div class="notice">Informe os volumes processados por referência.</div>');

  return '<h3 class="section-heading">Volumes — Referências</h3>'+deferredNotice+
    '<div class="table-wrap"><table><thead><tr><th>Referência</th><th>'+(volumeOnly?"Volumes no RM":"Volumes previstos")+'</th><th>Volumes processados</th><th>Volumes estocados</th></tr></thead><tbody>'+
    p.items.map(function(item){
      return '<tr><td><b>'+esc(item.reference||item.sku||item.product||"—")+'</b><small>'+Number(item.expected_qty||0).toLocaleString("pt-BR")+' peças</small></td><td>'+(volumeOnly?"—":Number(item.volume_expected||0).toLocaleString("pt-BR"))+'</td><td><input class="table-input processing-item-qty" data-item-id="'+item.item_id+'" type="number" min="0" value="'+item.processed_qty+'" '+(editable ? "" : "readonly")+'></td><td>'+item.stored_qty+'</td></tr>';
    }).join("")+
    '</tbody></table></div><div class="actions">'+(editable ? '<button class="primary" onclick="saveProcessingQuantities()">Salvar volumes por referência</button>' : '')+copyButton+'</div>';
}

async function saveProcessingQuantities() {
  try {
    const p = cardData.processing;
    const payload = {user_id:currentUser.id};
    if (p.purchase_mode === "SALDO") payload.processed_qty_general = Number($("processingGeneralQty").value||0);
    else payload.items = [...document.querySelectorAll(".processing-item-qty")].map((input)=>({item_id:Number(input.dataset.itemId),processed_qty:Number(input.value||0)}));
    await api(`/api/processing/${p.id}/quantities`, {method:"PATCH",body:JSON.stringify(payload)});
    toast("Quantidades salvas.");
    await openCard(currentCardId,"processing");
  } catch (error) { toast(error.message); }
}

async function copyStoredToProcessed() {
  try {
    await api(`/api/processing/${cardData.processing.id}/copy-stored`, {method:"POST",body:JSON.stringify({user_id:currentUser.id})});
    toast("Quantidade estocada copiada para processada.");
    await openCard(currentCardId,"processing");
  } catch (error) { toast(error.message); }
}

async function completeProcessing() {
  if (!confirm("Concluir o Processamento e movimentar o Card para o próximo setor configurado?")) return;
  try {
    await api(`/api/processing/${cardData.processing.id}/complete`, {method:"POST",body:JSON.stringify({user_id:currentUser.id})});
    toast("Processamento concluído.");
    await openCard(currentCardId,"processing");
  } catch (error) { toast(error.message); }
}

async function renderDownstreamTab(sector) {
  if (guardSampleAllocationNavigation()) return;
  const key=sector==="ETIQUETAGEM"?"labeling":"storage",tabId=sector==="ETIQUETAGEM"?"tabLabelingBtn":"tabStorageBtn";
  const wmsSector=sector==="ETIQUETAGEM"?"ET":"EC",sectorLabel=sector==="ETIQUETAGEM"?"Etiquetagem (ET)":"Estocagem (EC)";
  activateTab(tabId);
  try{if(!downstreamUsers[sector].length)downstreamUsers[sector]=await api(`/api/downstream/users?sector=${sector}`);}
  catch(e){$("cardTab").innerHTML=`<div class="notice error">${esc(e.message)}</div>`;return;}
  const op=cardData[key],allowed=[sector.toLowerCase(),"supervisor","admin"].includes(currentUser.role);
  const importedItems=(cardData.items||[]).filter(item=>item.source_stage===sector);
  if(!op?.id){
    if(cardData.source_snapshot_at&&cardData.current_sector!==sector&&!importedItems.length){renderImportedSectorSnapshot(tabId,[sector],`Itens localizados em ${sector==="ETIQUETAGEM"?"Etiquetagem":"Estocagem"}`);return;}
    $("cardTab").innerHTML=`<div class="panel-body"><div class="notice"><b>${sector==="ETIQUETAGEM"?"Etiquetagem":"Estocagem"}</b><br>
      ${cardData.purchase_mode==="GRADE"?"Cada colaborador assume um tamanho completo por vez.":"Saldo é dividido por quantidade geral, sem separar tamanhos."}
      ${importedItems.length?`<br><b>${importedItems.length}</b> item(ns) disponível(is) nesta etapa; os demais itens da compra não serão alterados.`:""}</div>
      ${allowed?`<div class="actions">${sector==="ETIQUETAGEM"?'<div class="field"><label>Tipo de etiquetagem</label><select id="labelingType"><option value="">Selecione</option><option value="APENAS_BRANCA">Apenas branca</option><option value="APENAS_VERMELHA">Apenas vermelha</option><option value="TAG_BRANCA">Tag + branca</option><option value="BRANCA_VERMELHA">Branca + vermelha</option></select></div>':""}<button class="primary" onclick="startDownstream('${sector}')">Iniciar controle</button></div>`:'<div class="notice warn">Entre com um perfil deste setor, Supervisor ou Administrador para iniciar.</div>'}
      <div class="notice"><b>Endereçamento no fechamento</b><br>A posição física será escolhida somente ao concluir esta etapa.</div></div>`;
    return;
  }
  const grade=op.purchase_mode==="GRADE",open=op.status==="ABERTO";
  const active=(op.assignments||[]).filter(a=>!["LIBERADA","CONCLUIDA"].includes(a.status));
  const hasPending=(op.items||[]).some(i=>Number(i.completed_qty||0)<Number(i.expected_qty||0));
  const workerNames=[...new Set(active.map(a=>a.worker_name).filter(Boolean))];
  const paused=active.length>0&&active.every(a=>a.timer_state==="PAUSADA");
  const elapsed=active.length?Math.max(...active.map(a=>Number(a.elapsed_seconds||0))):0;
  const executionHtml=active.length
    ? `<div class="notice success-box"><b>Card em execução</b><br>Responsável: <b>${esc(workerNames.join(", ")||"—")}</b> • ${active.length} tamanho(s) em uma única execução.</div>
       <div class="summary-grid compact-summary"><div class="summary-box"><span>Tempo da execução</span><strong>${fmtSeconds(elapsed)}</strong></div><div class="summary-box"><span>Modo</span><strong>Conferência cega</strong></div></div>
       <div class="actions">${allowed?`${paused?`<button class="primary" onclick="downstreamSession(${op.id},'resume','${sector}')">Retomar Card</button>`:`<button class="warning" onclick="downstreamSession(${op.id},'pause','${sector}')">Pausar Card</button>`}<button class="secondary" onclick="openDownstreamPartialAll(${op.id},'${sector}')">Não terminei de executar tudo</button>${sector==="ESTOCAGEM"?`<button class="success" onclick="openStorageBlindCheck(${op.id})">Conferir e concluir Estocagem</button>`:`<button class="success" onclick="completeDownstream(${op.id},'ETIQUETAGEM')">Conferir e concluir Etiquetagem</button>`}`:""}</div>`
    : hasPending&&open
      ? `<div class="notice"><b>Card disponível para execução</b><br>O colaborador assume a grade inteira de uma vez. As quantidades permanecem ocultas até a conferência final.</div>${allowed?`<div class="downstream-picker">${downstreamWorkerSelect(sector)}<button class="primary" onclick="claimDownstreamCard(${op.id},'${sector}')">Assumir Card e iniciar</button></div>`:""}`
      : '<div class="notice success-box"><b>Execução concluída.</b><br>Aguardando somente as próximas validações do fluxo.</div>';
  $("cardTab").innerHTML=`<div class="panel-body downstream-panel">
    <div class="notice"><b>${sector==="ETIQUETAGEM"?"Etiquetagem":"Estocagem"} • ${grade?"Grade":"Saldo"}</b><br>Execução única por Card, sem assumir tamanho por tamanho.</div>
    <div class="notice"><b>Execução cega</b><br>Quantidade esperada, saldo e quantidade por grade ficam ocultos durante a atividade.</div>
    ${executionHtml}
    <div class="notice"><b>Endereçamento no fechamento</b><br>A posição física será escolhida somente depois da conferência final.</div></div>`;
}

function downstreamWorkerSelect(sector){
  if([sector.toLowerCase()].includes(currentUser.role)) return `<input type="hidden" id="downstreamWorker" value="${currentUser.id}"><div class="selected-inspector"><span>Colaborador</span><b>${esc(currentUser.name)}</b></div>`;
  return `<div class="field"><label>Colaborador</label><select id="downstreamWorker"><option value="">Selecione</option>${downstreamUsers[sector].map(u=>`<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select></div>`;
}
function downstreamGradePicker(op,sector){
  const activeIds=new Set((op.assignments||[]).filter(a=>a.status!=="LIBERADA").map(a=>Number(a.item_id)));
  const free=(op.items||[]).filter(i=>!activeIds.has(Number(i.item_id)) && Number(i.completed_qty||0)<Number(i.expected_qty||0));
  return `<h3 class="section-heading">Assumir próximo tamanho</h3><div class="downstream-picker">${downstreamWorkerSelect(sector)}<div class="queue-search"><span>⌕</span><input id="downstreamSizeSearch" placeholder="Produto, cor ou tamanho" oninput="filterDownstreamSizes()"></div></div>
    <div class="table-wrap compact-picker"><table class="compact-table"><thead><tr><th>Produto</th><th>Cor</th><th>Tamanho</th><th></th></tr></thead><tbody>${free.map(i=>`<tr class="downstream-size-row" data-search="${esc([i.product,i.reference,i.color,i.size].join(' ').toLowerCase())}"><td><b>${esc(i.product||'—')}</b><small>${esc(i.reference||i.sku||'—')}</small></td><td>${esc(i.color||'—')}</td><td><span class="size-token">${esc(i.size||'—')}</span></td><td><button class="primary small-btn" onclick="claimDownstream(${op.id},'${sector}',${i.item_id},1)">Assumir tamanho</button></td></tr>`).join("")||'<tr><td colspan="4">Nenhum tamanho disponível para assumir.</td></tr>'}</tbody></table></div>`;
}
function downstreamSaldoPicker(op,sector){return `<h3 class="section-heading">Assumir quantidade do Saldo</h3><div class="downstream-picker saldo-picker">${downstreamWorkerSelect(sector)}<div class="field"><label>Quantidade disponível: ${op.totals.available}</label><input id="downstreamSaldoQty" type="number" min="1" max="${op.totals.available}" placeholder="Quantidade"></div><button class="primary" onclick="claimDownstream(${op.id},'${sector}',null,Number($(\"downstreamSaldoQty\").value||0))">Assumir quantidade</button></div>`;}
function filterDownstreamSizes(){const t=normalizeSearch($("downstreamSizeSearch")?.value||"");document.querySelectorAll(".downstream-size-row").forEach(r=>r.classList.toggle("hidden",t&&!normalizeSearch(r.dataset.search).includes(t)));}
function downstreamAssignmentHtml(a,sector,allowed){
  const own=a.worker_user_id===currentUser.id||["supervisor","admin"].includes(currentUser.role);
  const released=a.status==="LIBERADA";
  return `<div class="assignment-strip"><div><b>${esc(a.product||"Saldo geral")}</b><small>${a.item_id?`${esc(a.color||'—')} • Tam. ${esc(a.size||'—')}`:"Controle por quantidade"}</small></div><div><span>Colaborador</span><b>${esc(a.worker_name)}</b></div><div><span>Status</span><b>${released?"Parcial encerrado":"Em execução"}</b></div><div><span>Tempo</span><b>${fmtSeconds(a.elapsed_seconds)}</b><small>${esc(a.timer_state)}</small></div><div class="actions">${allowed&&own&&!released?`${a.timer_state==="NAO_INICIADA"?`<button class="primary small-btn" onclick="downstreamTimer(${a.id},'start','${sector}')">Iniciar</button>`:""}${a.timer_state==="EM_ANDAMENTO"?`<button class="warning small-btn" onclick="downstreamTimer(${a.id},'pause','${sector}')">Pausar</button><button class="secondary small-btn" onclick="partialDownstreamAssignment(${a.id},'${sector}')">Não terminei de executar tudo</button><button class="success small-btn" onclick="downstreamTimer(${a.id},'finish','${sector}')">Finalizar</button>`:""}${a.timer_state==="PAUSADA"?`<button class="primary small-btn" onclick="downstreamTimer(${a.id},'resume','${sector}')">Retomar</button><button class="secondary small-btn" onclick="partialDownstreamAssignment(${a.id},'${sector}')">Não terminei de executar tudo</button><button class="success small-btn" onclick="downstreamTimer(${a.id},'finish','${sector}')">Finalizar</button>`:""}`:""}</div></div>`;
}
async function startDownstream(sector){try{const labelingType=sector==="ETIQUETAGEM"?($("labelingType")?.value||""):"";if(sector==="ETIQUETAGEM"&&!labelingType)throw new Error("Selecione o tipo de etiquetagem.");await api(`/api/cards/${currentCardId}/downstream/${sector}`,{method:"POST",body:JSON.stringify({user_id:currentUser.id,labeling_type:labelingType})});await openCard(currentCardId,sector==="ETIQUETAGEM"?"labeling":"storage");}catch(e){toast(e.message)}}
async function claimDownstream(opId,sector,itemId,qty){try{const worker=Number($("downstreamWorker")?.value||0);if(!worker)throw new Error("Selecione o colaborador.");await api(`/api/downstream/${opId}/claim`,{method:"POST",body:JSON.stringify({user_id:currentUser.id,worker_user_id:worker,item_id:itemId,qty})});toast("Material assumido.");await openCard(currentCardId,sector==="ETIQUETAGEM"?"labeling":"storage");}catch(e){toast(e.message)}}
async function saveDownstreamResult(id,sector){try{await api(`/api/downstream/assignments/${id}`,{method:"PATCH",body:JSON.stringify({user_id:currentUser.id,completed_qty:Number($(`downstreamDone_${id}`).value||0)})});toast("Quantidade salva.");await openCard(currentCardId,sector==="ETIQUETAGEM"?"labeling":"storage");}catch(e){toast(e.message)}}
async function partialDownstreamAssignment(id,sector){
  try{
    const raw=prompt("Quanto você conseguiu executar?");
    if(raw===null)return;
    const qty=Number(raw);
    if(!Number.isSafeInteger(qty)||qty<0)throw new Error("Informe uma quantidade inteira válida.");
    const result=await api("/api/downstream/assignments/"+id+"/partial",{method:"POST",body:JSON.stringify({user_id:currentUser.id,completed_qty:qty})});
    toast("Parcial registrado. "+Number(result.returned_qty||0)+" peça(s) voltaram para o saldo da grade.");
    await openCard(currentCardId,sector==="ETIQUETAGEM"?"labeling":"storage");
  }catch(e){toast(e.message);}
}
async function downstreamTimer(id,action,sector){try{await api(`/api/downstream/assignments/${id}/timer/${action}`,{method:"POST",body:JSON.stringify({user_id:currentUser.id})});await openCard(currentCardId,sector==="ETIQUETAGEM"?"labeling":"storage");}catch(e){toast(e.message)}}
function openStorageBlindCheck(opId){
  const op=cardData.storage;
  if(!op?.items?.length){toast("Não há itens para conferir.");return;}
  const rows=op.items.map(i=>'<tr data-storage-check-row data-item-id="'+i.item_id+'"><td><b>'+esc(i.reference||i.product||"—")+'</b></td><td>'+esc(i.color||"—")+'</td><td>'+esc(i.size||"—")+'</td><td><input class="storage-blind-count" type="number" min="0" step="1" placeholder="Quantidade estocada" required></td></tr>').join("");
  $("modalBody").innerHTML='<div class="card-title"><div><h2>Conferência cega da Estocagem</h2></div></div><div class="notice"><b>A quantidade esperada fica oculta.</b> Se houver divergência, reconte somente o item indicado.</div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Quantidade estocada</th></tr></thead><tbody>'+rows+'</tbody></table></div><div id="storageAllocationPhase"></div><div id="storageCheckActions" class="actions"><button class="success" onclick="submitStorageBlindCheck('+opId+')">Conferir</button></div>';
  $("modal").classList.remove("hidden");
}
async function submitStorageBlindCheck(opId){
  try{
    const op=cardData.storage,rows=[...document.querySelectorAll("[data-storage-check-row]")];
    const items=rows.map(row=>{const input=row.querySelector(".storage-blind-count");if(input.value===""||!Number.isSafeInteger(Number(input.value))||Number(input.value)<0)throw new Error("Preencha todas as quantidades.");return {item_id:Number(row.dataset.itemId),counted_qty:Number(input.value)};});
    const result=await api("/api/downstream/"+opId+"/storage-check",{method:"POST",body:JSON.stringify({user_id:currentUser.id,items})});
    if(result.requires_recount){
      const ids=new Set((result.divergences||[]).map(x=>Number(x.item_id)));
      rows.forEach(row=>{const wrong=ids.has(Number(row.dataset.itemId));row.classList.toggle("triage-recount-required",wrong);const input=row.querySelector(".storage-blind-count");if(wrong)input.value="";input.disabled=!wrong;});
      if($("storageAllocationPhase"))$("storageAllocationPhase").innerHTML="";
      toast(result.detail);return;
    }
    rows.forEach(row=>row.querySelector(".storage-blind-count").disabled=true);
    const byId=new Map((op.items||[]).map(i=>[Number(i.item_id),i]));
    const allocItems=items.map(x=>{const src=byId.get(Number(x.item_id))||{};return {id:Number(x.item_id),product:src.product||src.reference||"",reference:src.reference||"",sku:src.sku||"",color:src.color||"",size:src.size||"",expected_qty:Number(x.counted_qty),source_stage:"ESTOCAGEM"};});
    if($("storageCheckActions"))$("storageCheckActions").classList.add("hidden");
    const host=$("storageAllocationPhase");
    host.innerHTML='<h3 class="section-heading">Endereçamento final — EC</h3><div class="notice"><b>Contagem validada.</b> Confirme o endereço EC. Se o material já veio endereçado da Etiquetagem, basta conferir e concluir.</div><div id="posAllocBox" class="notice">Carregando posições EC...</div><div class="actions"><button class="success" onclick="finalizeStorageAfterAllocation('+opId+')">Concluir Estocagem</button></div>';
    await loadPositionAllocator(cardData.id,"EC",false,0,allocItems,true);
  }catch(e){toast(e.message);}
}
async function finalizeStorageAfterAllocation(opId){
  try{await api("/api/downstream/"+opId+"/complete",{method:"POST",body:JSON.stringify({user_id:currentUser.id})});toast("Estocagem conferida e concluída. Valores enviados para Entrada do Processamento.");closeModal();goTo("storage");}catch(e){toast(e.message);}
}
async function completeDownstream(id,sector){
  try{
    if(sector==="ETIQUETAGEM"){
      const op=cardData.labeling;
      if(!op?.items?.length)throw new Error("Não há grade para conferir.");
      const rows=op.items.map(i=>'<tr><td><b>'+esc(i.reference||i.product||"—")+'</b></td><td>'+esc(i.color||"—")+'</td><td>'+esc(i.size||"—")+'</td><td><input class="labeling-final-count" data-item-id="'+i.item_id+'" type="number" min="0" step="1" required></td></tr>').join("");
      $("modalBody").innerHTML='<div class="card-title"><div><h2>Encerrar Etiquetagem</h2><div class="card-subtitle">Informe quantas etiquetas foram feitas por cor e tamanho.</div></div></div><div class="notice"><b>Dica:</b> conte o rolo de etiqueta branca para ajudar a conferir a quantidade produzida.</div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Quantidade feita</th></tr></thead><tbody>'+rows+'</tbody></table></div><div id="labelingAllocationPhase"></div><div id="labelingCheckActions" class="actions"><button class="success" onclick="confirmLabelingComplete('+id+')">Conferir quantidades</button></div>';
      $("modal").classList.remove("hidden");return;
    }
    await api("/api/downstream/"+id+"/complete",{method:"POST",body:JSON.stringify({user_id:currentUser.id})});
    toast("Etapa concluída.");closeModal();goTo("storage");
  }catch(e){toast(e.message);}
}
async function confirmLabelingComplete(id){
  try{
    const op=cardData.labeling,rows=[...document.querySelectorAll(".labeling-final-count")];
    const items=rows.map(input=>{const qty=Number(input.value);if(input.value===""||!Number.isSafeInteger(qty)||qty<0)throw new Error("Informe todas as quantidades por cor e tamanho.");return {item_id:Number(input.dataset.itemId),counted_qty:qty};});
    const result=await api("/api/downstream/"+id+"/labeling-check",{method:"POST",body:JSON.stringify({user_id:currentUser.id,items})});
    if(result.requires_recount){
      const ids=new Set((result.divergences||[]).map(x=>Number(x.item_id)));
      rows.forEach(input=>{const wrong=ids.has(Number(input.dataset.itemId));input.closest("tr")?.classList.toggle("triage-recount-required",wrong);if(wrong)input.value="";input.disabled=!wrong;});
      if($("labelingAllocationPhase"))$("labelingAllocationPhase").innerHTML="";
      toast(result.detail);return;
    }
    rows.forEach(input=>input.disabled=true);
    const byId=new Map((op.items||[]).map(i=>[Number(i.item_id),i]));
    const allocItems=items.map(x=>{const src=byId.get(Number(x.item_id))||{};return {id:Number(x.item_id),product:src.product||src.reference||"",reference:src.reference||"",sku:src.sku||"",color:src.color||"",size:src.size||"",expected_qty:Number(x.counted_qty),source_stage:"ESTOCAGEM"};});
    if($("labelingCheckActions"))$("labelingCheckActions").classList.add("hidden");
    const host=$("labelingAllocationPhase");
    host.innerHTML='<h3 class="section-heading">Endereçamento obrigatório para Estocagem — EC</h3><div class="notice"><b>Contagem validada.</b> Agora enderece toda a mercadoria em EC. O destino é fixo.</div><div id="posAllocBox" class="notice">Carregando posições EC...</div><div class="actions"><button class="success" onclick="finalizeLabelingAfterAllocation('+id+')">Concluir Etiquetagem</button></div>';
    await loadPositionAllocator(cardData.id,"EC",false,0,allocItems,true);
  }catch(e){toast(e.message);}
}
async function finalizeLabelingAfterAllocation(id){
  try{await api("/api/downstream/"+id+"/complete",{method:"POST",body:JSON.stringify({user_id:currentUser.id})});toast("Etiquetagem conferida e encaminhada para Estocagem.");closeModal();goTo("labeling");}catch(e){toast(e.message);}
}
async function renderSgo(){setPage("SGO e Entradas","Previsão de compras e distribuição de serviço por setor");const rows=await api("/api/unified/sgo");unifiedCache.sgo=rows;const counts=Object.fromEntries(["EM_TRANSITO","QUALIDADE","PROCESSAMENTO","ESTOCAGEM","CONCLUIDO"].map(s=>[s,rows.filter(r=>r.status===s).length]));$("mainContent").innerHTML=`<div class="kpi-grid compact-kpis">${Object.entries(counts).map(([s,n])=>`<div class="kpi"><div class="kpi-label">${s.replaceAll('_',' ')}</div><div class="kpi-value">${n}</div></div>`).join("")}</div><div class="panel" style="margin-top:14px"><div class="panel-header">Relatório SGO <button class="primary small-btn" onclick="document.getElementById('sgoFile').click()">Importar Excel</button><input id="sgoFile" class="hidden" type="file" accept=".xlsx,.xlsm" onchange="importSgo(this)"></div><div class="panel-body"><div class="queue-search"><span>⌕</span><input id="sgoSearch" placeholder="Compra, grupo, descrição ou marca" oninput="filterSgoRows()"></div></div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Compra</th><th>Grupo / descrição</th><th>Marca</th><th>Quantidade</th><th>Previsão</th><th>Etapa</th><th>Ação</th></tr></thead><tbody>${rows.map(r=>`<tr class="sgo-row" data-search="${esc(normalizeSearch([r.purchase_id,r.group_name,r.description,r.brand].join(' ')))}"><td><b>${esc(r.purchase_id||'—')}</b><small>${esc(r.origin||'')}</small></td><td><b>${esc(r.group_name||'—')}</b><small>${esc(r.description||'')}</small></td><td>${esc(r.brand||'—')}</td><td><b>${r.quantity}</b></td><td>${esc(r.forecast_date||'—')}</td><td>${statusBadge(r.status)}</td><td><button class="secondary small-btn" onclick="createSgoTask(${r.id},'${r.status}')">Criar tarefa</button></td></tr>`).join("")||'<tr><td colspan="7">Importe um relatório SGO para iniciar.</td></tr>'}</tbody></table></div></div>`;}
function filterSgoRows(){const t=normalizeSearch($("sgoSearch")?.value||"");document.querySelectorAll(".sgo-row").forEach(r=>r.classList.toggle("hidden",t&&!r.dataset.search.includes(t)));}
async function importSgo(input){if(!input.files?.[0])return;const form=new FormData();form.append("file",input.files[0]);try{const d=await api(`/api/unified/sgo/import?user_id=${currentUser.id}`,{method:"POST",body:form});toast(`${d.rows} entradas SGO importadas.`);renderSgo();}catch(e){toast(e.message)}}
async function createSgoTask(id,status){const sector=prompt("Setor da tarefa:",status||"RECEBIMENTO");if(!sector)return;try{await api(`/api/unified/sgo/${id}/task`,{method:"POST",body:JSON.stringify({user_id:currentUser.id,sector})});toast("Tarefa criada.");}catch(e){toast(e.message)}}

async function renderTasks(){setPage("Tarefas Operacionais","Responsáveis, prioridades e andamento por setor");const rows=await api("/api/unified/tasks");unifiedCache.tasks=rows;const cols=["PENDENTE","EM_ANDAMENTO","CONCLUIDA"];$("mainContent").innerHTML=`<div class="tasks-toolbar"><button class="primary" onclick="showTaskForm()">+ Nova tarefa</button><select id="taskSectorFilter" onchange="filterTaskCards()"><option value="">Todos os setores</option>${[...new Set(rows.map(r=>r.sector))].map(s=>`<option>${esc(s)}</option>`).join("")}</select></div><div id="taskForm" class="panel hidden"></div><div class="task-board">${cols.map(status=>`<section><h3>${status.replaceAll('_',' ')} <span>${rows.filter(r=>r.status===status).length}</span></h3>${rows.filter(r=>r.status===status).map(t=>taskCard(t)).join("")||'<div class="empty-column">Nenhuma tarefa</div>'}</section>`).join("")}</div>`;}
function taskCard(t){return `<article class="task-card" data-sector="${esc(t.sector)}"><div><span class="priority ${String(t.priority).toLowerCase()}">${esc(t.priority)}</span><small>${esc(t.sector)}</small></div><h4>${esc(t.title)}</h4><p>${esc(t.description||'Sem descrição')}</p><footer><span>${esc(t.responsible_name||'Não atribuída')}</span>${t.status!=="CONCLUIDA"?`<button class="small-btn ${t.status==='PENDENTE'?'primary':'success'}" onclick="advanceTask(${t.id},'${t.status==='PENDENTE'?'EM_ANDAMENTO':'CONCLUIDA'}')">${t.status==='PENDENTE'?'Iniciar':'Concluir'}</button>`:''}</footer></article>`;}
function filterTaskCards(){const s=$("taskSectorFilter").value;document.querySelectorAll(".task-card").forEach(c=>c.classList.toggle("hidden",s&&c.dataset.sector!==s));}
function showTaskForm(){$("taskForm").classList.remove("hidden");$("taskForm").innerHTML=`<div class="panel-body inline-form"><div class="field"><label>Título</label><input id="taskTitle"></div><div class="field"><label>Setor</label><select id="taskSector">${["RECEBIMENTO","QUALIDADE","PROCESSAMENTO","ETIQUETAGEM","ESTOCAGEM","EXPEDICAO","DEVOLUCOES"].map(s=>`<option>${s}</option>`).join("")}</select></div><div class="field"><label>Prioridade</label><select id="taskPriority"><option>NORMAL</option><option>ALTA</option><option>URGENTE</option></select></div><div class="field grow"><label>Descrição</label><input id="taskDescription"></div><button class="primary" onclick="createTask()">Criar tarefa</button></div>`;}
async function createTask(){try{await api("/api/unified/tasks",{method:"POST",body:JSON.stringify({user_id:currentUser.id,title:$("taskTitle").value,sector:$("taskSector").value,priority:$("taskPriority").value,description:$("taskDescription").value})});toast("Tarefa criada.");renderTasks();}catch(e){toast(e.message)}}
async function advanceTask(id,status){try{await api(`/api/unified/tasks/${id}`,{method:"PATCH",body:JSON.stringify({user_id:currentUser.id,status})});renderTasks();}catch(e){toast(e.message)}}

async function renderShipping(){
  setPage("Expedição","Preenchimento, conferência e liberação da saída");
  const rows=await api("/api/unified/shipments");unifiedCache.shipments=rows;
  const allowed=["expedicao","estocagem","supervisor","admin"].includes(currentUser.role);
  const preparing=rows.filter(s=>s.status!=="EXPEDIDO"&&s.status!=="PRONTO").length;
  const ready=rows.filter(s=>s.status==="PRONTO").length;
  const shipped=rows.filter(s=>s.status==="EXPEDIDO").length;
  const checked=rows.reduce((a,s)=>a+Number(s.checked_qty||0),0),total=rows.reduce((a,s)=>a+Number(s.total_qty||0),0);
  $("mainContent").innerHTML=`
    <div class="kpi-grid compact-kpis shipping-kpis">
      <div class="kpi"><div class="kpi-label">Em preenchimento</div><div class="kpi-value">${preparing}</div><div class="kpi-hint">Romaneios</div></div>
      <div class="kpi"><div class="kpi-label">Prontos para saída</div><div class="kpi-value">${ready}</div><div class="kpi-hint">Conferidos</div></div>
      <div class="kpi"><div class="kpi-label">Expedidos</div><div class="kpi-value">${shipped}</div><div class="kpi-hint">Concluídos</div></div>
      <div class="kpi"><div class="kpi-label">Conferência geral</div><div class="kpi-value">${total?Math.round(checked*100/total):0}%</div><div class="kpi-hint">${checked.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')} peças</div></div>
    </div>
    <div class="panel shipping-panel">
      <div class="panel-header"><span>Controle de romaneios</span><div>${allowed?`<button class="ghost small-btn" onclick="document.getElementById('shipmentPdf').click()">Importar PDF</button> <button class="primary small-btn" onclick="showShipmentForm()">+ Novo romaneio</button><input id="shipmentPdf" class="hidden" type="file" accept=".pdf" onchange="importShipmentPdf(this)">`:''}</div></div>
      <div class="panel-body shipping-toolbar"><div class="queue-search"><span>⌕</span><input id="shipmentSearch" placeholder="Romaneio, destino, transportadora, placa ou motorista" oninput="filterShipmentRows()"></div><select id="shipmentStatus" onchange="filterShipmentRows()"><option value="">Todos os status</option><option>RASCUNHO</option><option>PREPARANDO</option><option>EM_CONFERENCIA</option><option>PRONTO</option><option>EXPEDIDO</option></select></div>
      <div id="shipmentForm" class="panel-body hidden"></div>
      <div class="table-wrap"><table class="compact-table"><thead><tr><th>Documento</th><th>Destino / transporte</th><th>Conferência</th><th>Volumes</th><th>Saída prevista</th><th>Status</th><th></th></tr></thead><tbody>
        ${rows.map(s=>{const pct=s.total_qty?Math.min(100,Math.round(Number(s.checked_qty||0)*100/s.total_qty)):0;return `<tr class="shipment-row" data-status="${esc(s.status)}" data-search="${esc(normalizeSearch([s.document_no,s.destination,s.carrier,s.vehicle_plate,s.driver_name].join(' ')))}"><td><button class="link-button" onclick="openShipment(${s.id})"><b>${esc(s.document_no)}</b></button><small>${s.item_count||0} item(ns)</small></td><td><b>${esc(s.destination||'Pendente')}</b><small>${esc(s.carrier||'Transportadora não informada')} ${s.vehicle_plate?`• ${esc(s.vehicle_plate)}`:''}</small></td><td><div class="shipping-progress"><i style="width:${pct}%"></i></div><small>${Number(s.checked_qty||0).toLocaleString('pt-BR')} / ${Number(s.total_qty||0).toLocaleString('pt-BR')} peças • ${pct}%</small></td><td>${Number(s.volume_count||0)||'—'}</td><td>${s.scheduled_at?fmtDateTime(s.scheduled_at):'—'}</td><td>${statusBadge(s.status)}</td><td><button class="secondary small-btn" onclick="openShipment(${s.id})">Preencher</button></td></tr>`}).join("")||'<tr><td colspan="7">Nenhum romaneio cadastrado.</td></tr>'}
      </tbody></table></div>
    </div>`;
}
function filterShipmentRows(){const term=normalizeSearch($("shipmentSearch")?.value||""),status=$("shipmentStatus")?.value||"";document.querySelectorAll(".shipment-row").forEach(row=>row.classList.toggle("hidden",(term&&!row.dataset.search.includes(term))||(status&&row.dataset.status!==status)));}
function showShipmentForm(){
  $("shipmentForm").classList.remove("hidden");
  $("shipmentForm").innerHTML=`<div class="shipping-form-title"><div><b>Novo romaneio</b><span>Preencha os dados conhecidos agora; o restante pode ser concluído depois.</span></div><button class="ghost small-btn" onclick="$('shipmentForm').classList.add('hidden')">Fechar</button></div>
    <div class="shipping-form-grid"><div class="field"><label>Número do romaneio *</label><input id="shipDoc"></div><div class="field"><label>Destino</label><input id="shipDest"></div><div class="field"><label>Transportadora</label><input id="shipCarrier"></div><div class="field"><label>Placa</label><input id="shipPlate" maxlength="10"></div><div class="field"><label>Motorista</label><input id="shipDriver"></div><div class="field"><label>Saída prevista</label><input id="shipScheduled" type="datetime-local"></div><div class="field"><label>Volumes</label><input id="shipVolumes" type="number" min="0"></div><div class="field grow"><label>Observações</label><input id="shipNotes"></div></div>
    <div class="shipping-items-head"><b>Itens do romaneio</b><button class="secondary small-btn" onclick="addShipmentItemRow()">+ Adicionar item</button></div><div id="shipmentNewItems"></div><div class="actions"><button class="primary" onclick="createShipment()">Salvar romaneio</button></div>`;
  addShipmentItemRow();
}
function addShipmentItemRow(barcode="",description="",quantity=""){$("shipmentNewItems").insertAdjacentHTML("beforeend",`<div class="shipment-new-item"><div class="field"><label>Código de barras</label><input data-field="barcode" value="${esc(barcode)}"></div><div class="field grow"><label>Descrição</label><input data-field="description" value="${esc(description)}"></div><div class="field"><label>Quantidade *</label><input data-field="quantity" type="number" min="1" value="${esc(quantity)}"></div><button class="danger small-btn" onclick="this.parentElement.remove()">Remover</button></div>`);}
async function createShipment(){try{const items=[...document.querySelectorAll(".shipment-new-item")].map(row=>({barcode:row.querySelector('[data-field=barcode]').value,description:row.querySelector('[data-field=description]').value,quantity:Number(row.querySelector('[data-field=quantity]').value||0)})).filter(i=>i.quantity>0);const d=await api("/api/unified/shipments",{method:"POST",body:JSON.stringify({user_id:currentUser.id,document_no:$("shipDoc").value,destination:$("shipDest").value,carrier:$("shipCarrier").value,vehicle_plate:$("shipPlate").value,driver_name:$("shipDriver").value,scheduled_at:$("shipScheduled").value,volume_count:Number($("shipVolumes").value||0),notes:$("shipNotes").value,items})});toast("Romaneio salvo. Continue a conferência.");await renderShipping();openShipment(d.shipment_id);}catch(e){toast(e.message)}}
async function importShipmentPdf(input){if(!input.files?.[0])return;const form=new FormData();form.append("file",input.files[0]);try{const d=await api(`/api/unified/shipments/import-pdf?user_id=${currentUser.id}`,{method:"POST",body:form});toast(`${d.document_no}: ${d.total_qty} peças reconhecidas.`);renderShipping();}catch(e){toast(e.message)}}
async function openShipment(id){try{const d=await api(`/api/unified/shipments/${id}`),s=d.shipment;const allowed=["expedicao","estocagem","supervisor","admin"].includes(currentUser.role)&&s.status!=="EXPEDIDO";const pct=s.total_qty?Math.min(100,Math.round(Number(s.checked_qty||0)*100/s.total_qty)):0;const missing=[["Destino",s.destination],["Transportadora",s.carrier],["Placa",s.vehicle_plate],["Motorista",s.driver_name],["Saída prevista",s.scheduled_at],["Volumes",s.volume_count]].filter(([,v])=>!v).map(([k])=>k);$("modalBody").innerHTML=`<div class="card-title"><div><h2>Romaneio ${esc(s.document_no)}</h2><div class="card-subtitle">Preenchimento e conferência da Expedição</div></div>${statusBadge(s.status)}</div><div class="shipping-completion"><div><span>Progresso da conferência</span><b>${pct}%</b></div><div class="shipping-progress large"><i style="width:${pct}%"></i></div><small>${Number(s.checked_qty||0).toLocaleString('pt-BR')} de ${Number(s.total_qty||0).toLocaleString('pt-BR')} peças conferidas</small></div>${missing.length?`<div class="notice warn"><b>Faltam dados obrigatórios:</b> ${missing.join(', ')}.</div>`:'<div class="notice success-box"><b>Dados do transporte completos.</b></div>'}<div class="shipping-form-grid"><div class="field"><label>Romaneio *</label><input id="shipEditDoc" value="${esc(s.document_no||'')}" ${allowed?'':'readonly'}></div><div class="field"><label>Destino *</label><input id="shipEditDest" value="${esc(s.destination||'')}" ${allowed?'':'readonly'}></div><div class="field"><label>Transportadora *</label><input id="shipEditCarrier" value="${esc(s.carrier||'')}" ${allowed?'':'readonly'}></div><div class="field"><label>Placa *</label><input id="shipEditPlate" value="${esc(s.vehicle_plate||'')}" ${allowed?'':'readonly'}></div><div class="field"><label>Motorista *</label><input id="shipEditDriver" value="${esc(s.driver_name||'')}" ${allowed?'':'readonly'}></div><div class="field"><label>Saída prevista *</label><input id="shipEditScheduled" type="datetime-local" value="${esc((s.scheduled_at||'').slice(0,16))}" ${allowed?'':'readonly'}></div><div class="field"><label>Volumes *</label><input id="shipEditVolumes" type="number" min="1" value="${Number(s.volume_count||0)||''}" ${allowed?'':'readonly'}></div><div class="field grow"><label>Observações</label><input id="shipEditNotes" value="${esc(s.notes||'')}" ${allowed?'':'readonly'}></div></div><h3 class="section-heading">Conferência por item</h3><div class="table-wrap shipping-items"><table class="compact-table"><thead><tr><th>Código</th><th>Descrição</th><th>Prevista</th><th>Conferida</th><th>Pendente</th><th>Observação</th></tr></thead><tbody>${d.items.map(i=>`<tr class="shipment-edit-item" data-id="${i.id}"><td>${esc(i.barcode||'—')}</td><td><b>${esc(i.description||'Item sem descrição')}</b></td><td>${i.quantity}</td><td><input class="table-input" data-field="checked" type="number" min="0" max="${i.quantity}" value="${i.checked_qty}" ${allowed?'':'readonly'}></td><td><b class="${i.quantity-i.checked_qty?'text-danger':'text-success'}">${i.quantity-i.checked_qty}</b></td><td><input data-field="notes" value="${esc(i.notes||'')}" ${allowed?'':'readonly'}></td></tr>`).join('')||'<tr><td colspan="6">Nenhum item informado.</td></tr>'}</tbody></table></div>${allowed?`<div class="actions"><button class="primary" onclick="saveShipmentFilling(${id})">Salvar preenchimento</button>${s.status==='PRONTO'?`<button class="success" onclick="finishShipment(${id})">Confirmar saída</button>`:''}</div>`:''}`;$("modal").classList.remove("hidden");}catch(e){toast(e.message)}}
async function saveShipmentFilling(id){try{const items=[...document.querySelectorAll('.shipment-edit-item')].map(row=>({id:Number(row.dataset.id),checked_qty:Number(row.querySelector('[data-field=checked]').value||0),notes:row.querySelector('[data-field=notes]').value}));const d=await api(`/api/unified/shipments/${id}/filling`,{method:'PATCH',body:JSON.stringify({user_id:currentUser.id,document_no:$("shipEditDoc").value,destination:$("shipEditDest").value,carrier:$("shipEditCarrier").value,vehicle_plate:$("shipEditPlate").value,driver_name:$("shipEditDriver").value,scheduled_at:$("shipEditScheduled").value,volume_count:Number($("shipEditVolumes").value||0),notes:$("shipEditNotes").value,items})});toast(d.status==='PRONTO'?'Conferência completa. Romaneio liberado para saída.':'Preenchimento salvo. Ainda existem pendências.');await renderShipping();openShipment(id);}catch(e){toast(e.message)}}
async function finishShipment(id){try{await api(`/api/unified/shipments/${id}`,{method:"PATCH",body:JSON.stringify({user_id:currentUser.id,status:"EXPEDIDO"})});closeModal();toast("Saída confirmada e romaneio concluído.");renderShipping();}catch(e){toast(e.message)}}

async function renderReturns(){setPage("Devoluções","Conferência Loja × CD × Anápolis, pendências e tratativas");const rows=await api("/api/unified/returns");unifiedCache.returns=rows;const open=rows.filter(r=>r.status!=="CONCLUIDA");$("mainContent").innerHTML=`<div class="kpi-grid compact-kpis"><div class="kpi"><div class="kpi-label">Registradas</div><div class="kpi-value">${rows.length}</div></div><div class="kpi"><div class="kpi-label">Abertas</div><div class="kpi-value">${open.length}</div></div><div class="kpi"><div class="kpi-label">Divergentes</div><div class="kpi-value">${rows.filter(r=>r.status==='DIVERGENTE').length}</div></div><div class="kpi"><div class="kpi-label">Peças em Anápolis</div><div class="kpi-value">${rows.reduce((a,r)=>a+Number(r.total_anapolis||0),0)}</div></div></div><div class="panel" style="margin-top:14px"><div class="panel-header"><span>Devoluções</span><div><button class="ghost small-btn" onclick="showReturnPdfForm()">Comparar PDFs</button> <button class="primary small-btn" onclick="showReturnForm()">+ Registrar devolução</button></div></div><div id="returnForm" class="panel-body hidden"></div><div class="table-wrap"><table><thead><tr><th>Documento</th><th>Loja / cliente</th><th>Loja</th><th>CD</th><th>Anápolis</th><th>Diferença</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td><button class="link-button" onclick="openReturn(${r.id})"><b>${esc(r.document_no)}</b></button></td><td>${esc(r.store||r.customer||'—')}</td><td>${r.total_store}</td><td>${r.total_cd}</td><td>${r.total_anapolis}</td><td><b class="${r.difference?'text-danger':''}">${r.difference}</b></td><td>${statusBadge(r.status)}</td><td>${r.status!=="CONCLUIDA"?`<button class="success small-btn" onclick="finishReturn(${r.id})">Concluir</button>`:''}</td></tr>`).join("")||'<tr><td colspan="8">Nenhuma devolução.</td></tr>'}</tbody></table></div></div>`;}
function showReturnForm(){$("returnForm").classList.remove("hidden");$("returnForm").innerHTML=`<div class="return-form-grid"><div class="field"><label>Documento</label><input id="returnDoc"></div><div class="field"><label>Loja</label><input id="returnStore"></div><div class="field"><label>Código de barras</label><input id="returnBarcode"></div><div class="field"><label>Descrição</label><input id="returnDescription"></div><div class="field"><label>Quantidade Loja</label><input id="returnStoreQty" type="number" min="0"></div><div class="field"><label>Quantidade CD</label><input id="returnCdQty" type="number" min="0"></div><div class="field"><label>Quantidade Anápolis</label><input id="returnAnaQty" type="number" min="0"></div><button class="primary" onclick="createReturn()">Conferir e registrar</button></div>`;}
function showReturnPdfForm(){$("returnForm").classList.remove("hidden");$("returnForm").innerHTML=`<div class="notice">Selecione os relatórios da mesma devolução. O sistema compara por código de barras usando a regra <b>Loja = CD + Anápolis</b>.</div><div class="return-form-grid"><div class="field"><label>Relatório da Loja</label><input id="returnPdfStore" type="file" accept=".pdf"></div><div class="field"><label>Conferência do CD</label><input id="returnPdfCd" type="file" accept=".pdf"></div><div class="field"><label>Itens em Anápolis (opcional)</label><input id="returnPdfAna" type="file" accept=".pdf"></div><button class="primary" onclick="compareReturnPdfs()">Comparar e registrar</button></div>`;}
async function createReturn(){try{await api("/api/unified/returns",{method:"POST",body:JSON.stringify({user_id:currentUser.id,document_no:$("returnDoc").value,store:$("returnStore").value,items:[{barcode:$("returnBarcode").value,description:$("returnDescription").value,qty_store:Number($("returnStoreQty").value||0),qty_cd:Number($("returnCdQty").value||0),qty_anapolis:Number($("returnAnaQty").value||0)}]})});toast("Devolução registrada.");renderReturns();}catch(e){toast(e.message)}}
async function compareReturnPdfs(){const loja=$("returnPdfStore").files?.[0],cd=$("returnPdfCd").files?.[0],ana=$("returnPdfAna").files?.[0];if(!loja||!cd)return toast("Selecione os PDFs da Loja e do CD.");const form=new FormData();form.append("file_store",loja);form.append("file_cd",cd);if(ana)form.append("file_anapolis",ana);try{const d=await api(`/api/unified/returns/compare-pdf?user_id=${currentUser.id}`,{method:"POST",body:form});toast(`${d.items} itens comparados. Status: ${d.status}.`);renderReturns();}catch(e){toast(e.message)}}
async function openReturn(id){try{const d=await api(`/api/unified/returns/${id}`);$("modalBody").innerHTML=`<div class="card-title"><div><h2>Devolução ${esc(d.return.document_no)}</h2><div class="card-subtitle">Conferência e destino de cada item</div></div>${statusBadge(d.return.status)}</div><div class="summary-grid compact-summary"><div class="summary-box"><span>Loja</span><strong>${d.return.total_store}</strong></div><div class="summary-box"><span>CD + Anápolis</span><strong>${Number(d.return.total_cd)+Number(d.return.total_anapolis)}</strong></div><div class="summary-box"><span>Diferença</span><strong>${d.return.difference}</strong></div></div><div class="table-wrap"><table><thead><tr><th>Código</th><th>Descrição</th><th>Loja</th><th>CD</th><th>Anápolis</th><th>Dif.</th><th>Condição</th><th>Destino</th><th></th></tr></thead><tbody>${d.items.map(i=>`<tr><td>${esc(i.barcode||'—')}</td><td>${esc(i.description||'—')}</td><td>${i.qty_store}</td><td>${i.qty_cd}</td><td>${i.qty_anapolis}</td><td>${i.difference}</td><td><select id="returnCondition_${i.id}"><option ${i.condition_status==='OK'?'selected':''}>OK</option><option ${i.condition_status==='DIVERGENTE'?'selected':''}>DIVERGENTE</option><option ${i.condition_status==='AVARIA'?'selected':''}>AVARIA</option><option ${i.condition_status==='TRATADO'?'selected':''}>TRATADO</option></select></td><td><select id="returnDestination_${i.id}"><option value="">Revisar</option>${['ESTOQUE','AVARIA','DESCARTE','FORNECEDOR'].map(v=>`<option ${i.destination===v?'selected':''}>${v}</option>`).join('')}</select></td><td><button class="secondary small-btn" onclick="treatReturnItem(${id},${i.id})">Salvar</button></td></tr>`).join('')}</tbody></table></div>`;$("modal").classList.remove("hidden");}catch(e){toast(e.message)}}
async function treatReturnItem(returnId,itemId){try{await api(`/api/unified/returns/${returnId}/items/${itemId}`,{method:"PATCH",body:JSON.stringify({user_id:currentUser.id,condition_status:$(`returnCondition_${itemId}`).value,destination:$(`returnDestination_${itemId}`).value})});toast("Tratativa salva.");openReturn(returnId);}catch(e){toast(e.message)}}
async function finishReturn(id){try{await api(`/api/unified/returns/${id}`,{method:"PATCH",body:JSON.stringify({user_id:currentUser.id,status:"CONCLUIDA",decision:"TRATADA"})});renderReturns();}catch(e){toast(e.message)}}

async function safeApi(url, fallback) { try { return await api(url); } catch (error) { console.warn(url,error); return fallback; } }
const shortStatus = value => String(value||"—").replaceAll("_"," ");
function statusBadge(value){
  const raw=String(value||"—");
  const label=shortStatus(raw);
  const normalized=raw.toUpperCase();
  const tone = normalized.includes("CONCL") || normalized.includes("FINAL") || normalized.includes("DISPONIVEL")
    ? "green"
    : normalized.includes("ERRO") || normalized.includes("DIVERG") || normalized.includes("REPROV")
      ? "red"
      : normalized.includes("AGUARD") || normalized.includes("PEND") || normalized.includes("PAUS")
        ? "warning"
        : "blue";
  return '<span class="badge '+tone+'">'+esc(label)+'</span>';
}
const progressFor = card => card.status?.includes("FINAL")||card.status?.includes("CONCL")?100:card.status?.includes("PROCESS")?68:card.status?.includes("ETIQU")?82:card.status?.includes("QUAL")||card.status?.includes("INSPE")?38:card.status?.includes("RECEB")?18:12;

function analyticsBarsBody(rows){const max=Math.max(1,...rows.map(r=>Number(r.value)||0));return `<div class="analytics-bars">${rows.slice(0,15).map(r=>`<div><span>${esc(r.label)}</span><i><b style="width:${Number(r.value)*100/max}%"></b></i><strong>${Number(r.value).toLocaleString('pt-BR')}</strong><small>${esc(r.hint||'')}</small></div>`).join('')||'<div class="empty-visual">Sem dados para exibir.</div>'}</div>`;}

async function renderDashboard() {
  setPage("Central de Operações", "");
  showLoading("Central de Operações");
  try {
    const results=await Promise.all([
      safeApi("/api/dashboard",null),
      safeApi("/api/cards?scope=quality",[]),
      safeApi("/api/cards?scope=processing",[]),
      safeApi("/api/unified/returns",[]),
      safeApi("/api/unified/stock-group-report/analytics",null)
    ]);
    const rawData=results[0], rawQuality=results[1], rawProcessing=results[2], rawReturns=results[3], rawStock=results[4];
    const data=(rawData&&typeof rawData==="object"&&!Array.isArray(rawData))?rawData:{};
    const totals=(data.totals&&typeof data.totals==="object")?data.totals:{};
    const recent=Array.isArray(data.recent)?data.recent:[];
    const quality=Array.isArray(rawQuality)?rawQuality:[];
    const processing=Array.isArray(rawProcessing)?rawProcessing:[];
    const returns=Array.isArray(rawReturns)?rawReturns:[];
    const stockReport=(rawStock&&typeof rawStock==="object"&&!Array.isArray(rawStock))?rawStock:{groups:[],latest_report:null};
    const active=[...processing,...recent.filter(c=>["QUALIDADE","PROCESSAMENTO","ETIQUETAGEM","ESTOCAGEM"].includes(String(c?.current_sector||"").toUpperCase()))]
      .filter((card,index,all)=>card&&card.id!=null&&all.findIndex(x=>x&&x.id===card.id)===index).slice(0,5);
    const groups=(Array.isArray(stockReport.groups)?stockReport.groups:[]).slice(0,6).map(g=>({label:g?.group_name||"Sem grupo",value:Number(g?.quantity||0),hint:g?.gender||""}));
    const dashboardData={totals:{
      receiving:Number(totals.receiving||0),quality:Number(totals.quality||0),
      processing:Number(totals.processing||0),storage:Number(totals.storage||0)
    },recent};
    $("mainContent").innerHTML=`<div class="reference-dashboard"><div class="hero-kpis">${heroKpi("Aguardando recebimento",dashboardData.totals.receiving,"Pedidos","▣","blue","receiving")}${heroKpi("Em qualidade",dashboardData.totals.quality,"Pedidos","◇","teal","quality")}${heroKpi("Em processamento",dashboardData.totals.processing,"Pedidos","⚙","blue","processing")}${heroKpi("Aguardando estocagem",dashboardData.totals.storage,"Cards","⌂","teal","storage")}</div>
    <div class="dash-row dash-row-main">${dashboardPanel("⌁","Produção ativa",`<span class="live-indicator">◷ ${new Date().toLocaleTimeString('pt-BR')}</span>`,compactProductionTable(active))}${dashboardPanel("⇩","Aguardando recebimento",`<span class="panel-count">${dashboardData.totals.receiving}</span>`,awaitingTable([],recent))}${dashboardPanel("▣","Estoque por grupo",`<span class="online-pill">${stockReport.latest_report?esc(stockReport.latest_report.filename||"Relatório"):"Sem relatório"}</span>`,analyticsBarsBody(groups))}</div>
    <div class="dash-row dash-row-secondary">${dashboardPanel("◇","Qualidade",`<span class="panel-count">${quality.length}</span>`,qualityTable(quality.slice(0,5)))}${dashboardPanel("⚙","Processamento",`<span class="panel-count">${processing.length}</span>`,processingTable(processing.slice(0,5)))}${dashboardPanel("↩","Devoluções",`<span class="panel-count red-count">${returns.filter(r=>r&&r.status!=="CONCLUIDA").length}</span>`,returnsTable(returns.slice(0,5)))}</div>
    <div class="flow-strip">${[["🛒","Compras","import"],["⇩","Recebimento","receiving"],["◇","Qualidade","quality"],["⚙","Processamento","processing"],["♢","Etiquetagem","labeling"],["⌂","Estocagem","storage-hub"],["▣","Expedição / Devolução","returns-hub"]].map(([icon,label,view],i)=>`${i?'<i>→</i>':''}<button onclick="goTo('${view}')"><b>${icon}</b><span>${label}</span>${i===1?'<small>+ 10%</small>':''}</button>`).join("")}</div></div>`;
  } catch(error) {
    console.error("Falha ao renderizar Central de Operações",error);
    $("mainContent").innerHTML='<div class="state-panel error-state"><b>Não foi possível carregar a Central de Operações.</b><span>'+esc(error?.message||"Erro inesperado ao montar o painel.")+'</span><button class="secondary" onclick="renderDashboard()">Tentar novamente</button></div>';
  }
}


function heroKpi(title,value,hint,icon,tone,view){return `<button class="hero-card" onclick="goTo('${view}')"><div><span>${title}</span><strong>${value||0}</strong><small>${hint}</small><em>Ver ${title.replace('Em ','').toLowerCase()} ›</em></div><b class="hero-icon ${tone}">${icon}</b></button>`;}
function dashboardPanel(icon,title,action,body){return `<section class="dash-panel"><header><b>${icon}</b><strong>${title}</strong>${action}</header><div class="dash-panel-body">${body}</div></section>`;}
function emptyRows(cols,text="Nenhum registro nesta visão."){return `<tr><td colspan="${cols}" class="empty-cell">${text}</td></tr>`;}
function refLabel(c){const r=String(c.reference_list||'').trim()||String(c.purchase_id||'—');return r.length>38?r.slice(0,37)+'…':r;}
function compactProductionTable(rows){return `<table class="dash-table"><thead><tr><th>Compra / SGO</th><th>Etapa atual</th><th>Progresso</th><th>Resp.</th></tr></thead><tbody>${rows.map(c=>`<tr onclick="openCard(${c.id})"><td>${esc(refLabel(c))}</td><td>${esc(c.current_sector||'—')}</td><td><div class="tiny-progress"><i style="width:${progressFor(c)}%"></i></div><small>${progressFor(c)}%</small></td><td><span class="avatar">${esc((c.brand||'OP').slice(0,2).toUpperCase())}</span></td></tr>`).join('')||emptyRows(4)}</tbody></table><button class="panel-link" onclick="goTo('processing')">Ver toda produção ›</button>`;}
function awaitingTable(rows,recent){const source=rows.length?rows:recent.filter(c=>c.current_sector==='RECEBIMENTO').map(c=>({purchase_id:refLabel(c),forecast_date:'—',origin:c.supplier,quantity:c.expected_total}));return `<table class="dash-table"><thead><tr><th>Compra / SGO</th><th>Prev. chegada</th><th>Fornecedor</th><th>Volumes</th></tr></thead><tbody>${source.slice(0,5).map(r=>`<tr><td>${esc(r.purchase_id||'—')}</td><td>${esc(r.forecast_date||'—')}</td><td>${esc(r.origin||r.brand||'—')}</td><td>${r.quantity||0}</td></tr>`).join('')||emptyRows(4)}</tbody></table><button class="panel-link" onclick="goTo('receiving')">Ver todos ›</button>`;}
function qualityTable(rows){return `<table class="dash-table"><thead><tr><th>Compra / SGO</th><th>Itens</th><th>Lotes</th><th>Status</th></tr></thead><tbody>${rows.map(c=>`<tr onclick="openCard(${c.id},'quality')"><td>${esc(refLabel(c))}</td><td>${c.expected_total}</td><td>${c.item_count}</td><td>${statusBadge(c.status_label)}</td></tr>`).join('')||emptyRows(4)}</tbody></table><button class="panel-link" onclick="goTo('quality')">Ver todos ›</button>`;}
function processingTable(rows){return `<table class="dash-table"><thead><tr><th>Compra / SGO</th><th>Tipo</th><th>Peças</th><th>Status</th></tr></thead><tbody>${rows.map(c=>`<tr onclick="openCard(${c.id},'processing')"><td>${esc(refLabel(c))}</td><td><span class="type-tag">${c.purchase_mode==='GRADE'?'Grade':'Saldo'}</span></td><td>${c.expected_total}</td><td>${statusBadge(c.status_label)}</td></tr>`).join('')||emptyRows(4)}</tbody></table><button class="panel-link" onclick="goTo('processing')">Ver todos ›</button>`;}
function returnsTable(rows){return `<table class="dash-table"><thead><tr><th>Devolução</th><th>Loja</th><th>Motivo</th><th>Status</th></tr></thead><tbody>${rows.map(r=>`<tr onclick="openReturn(${r.id})"><td>${esc(r.document_no)}</td><td>${esc(r.store||'—')}</td><td>${r.difference?'Divergência':'Conferência'}</td><td>${statusBadge(r.status)}</td></tr>`).join('')||emptyRows(4)}</tbody></table><button class="panel-link" onclick="goTo('returns-hub')">Ver todas ›</button>`;}

const PROD_SECTORS=["Triagem","Qualidade","Processamento","Etiquetagem","Estocagem","Expedição"];
const PROD_FIELDS={
  "Triagem":[["Grupo","select",["Calça","Blusa","Vestido","Bermuda","Sueter","Jaqueta","Acessório"]],["Gênero","select",["Feminino","Masculino"]],["Compra Por","select",["Grade","Saldo"]],["NF","text"]],
  "Qualidade":[["Grupo","text"],["Marca","text"],["Fornecedor","text"],["NF-e","text"],["Status do Lote","select",["Aprovado","Reprovado","Parcial"]]],
  "Processamento":[["Processo","select",["Entrada","Reprocesso"]],["Grupo","text"],["Gênero","select",["Feminino","Masculino"]],["Fornecedor","text"],["NF-e","text"]],
  "Etiquetagem":[["Grupo","text"],["Gênero","select",["Feminino","Masculino"]],["Tipo de Etiqueta","select",["Personalizada","Padrão"]]],
  "Estocagem":[["Marca","text"],["Grupo","text"],["Rua","text"],["Tamanho","text"],["Cor","text"]],
  "Expedição":[["Procedimento","select",["Envio de Material","Separação de Pedido"]],["Qtd. Volumes","number"],["Qtd. NF-e","number"],["Observação","text"]],
};
let prodSector="Triagem", prodTab="apontamento", prodRunning={};

async function renderGoatIndicators(){
  setPage("Indicadores (GOAT)","Compras, fornecedores, perdas e divergências — importado do relatório de operações do GOAT");
  const status=await safeApi('/api/goat/status',{last_import:null,sheets:[]});
  const summary=await safeApi('/api/goat/summary',{totals:{},top_rejeitados_fornecedor:[],top_perdas_responsavel:[],fornecedores_criticos:[]});
  const t=summary.totals||{};
  $("mainContent").innerHTML=`
    <div class="hero-kpis">
      ${heroKpi("Peças rejeitadas",(t.rejeitados_pecas||0).toLocaleString('pt-BR'),`R$ ${(t.rejeitados_valor||0).toLocaleString('pt-BR')}`,"⚠","blue","goat-indicators")}
      ${heroKpi("Peças em perda",(t.perdas_pecas||0).toLocaleString('pt-BR'),"Registradas pela equipe","▣","teal","goat-indicators")}
      ${heroKpi("Entregas atrasadas",t.entregas_atrasadas||0,"Compras em atraso","⏱","blue","goat-indicators")}
      ${heroKpi("Divergências",(t.divergencias_compra||0)+(t.divergencias_estoque||0),"Compra x recebido + estoque","≠","teal","goat-indicators")}
    </div>
    <div class="dash-row" style="grid-template-columns:1fr 1fr;gap:18px">
      ${analyticsBars("Rejeitados por fornecedor",summary.top_rejeitados_fornecedor.map(f=>({label:f.name,value:f.pecas,hint:`R$ ${f.valor.toLocaleString('pt-BR')}`})))}
      ${analyticsBars("Perdas por responsável",summary.top_perdas_responsavel.map(p=>({label:p.name,value:p.pecas})))}
    </div>
    <section class="dash-panel" style="margin-bottom:14px"><header><b>⚑</b><strong>Fornecedores críticos hoje</strong><span class="panel-count">${summary.fornecedores_criticos.length}</span></header>
      <div class="dash-panel-body"><table class="dash-table"><tbody>
        ${summary.fornecedores_criticos.map(f=>`<tr><td><b>${esc(f.name||'—')}</b></td><td>${f.atrasadas_hoje} atrasadas hoje</td><td>${f.acerto_pct}% de acerto no prazo</td></tr>`).join('')||emptyRows(3)}
      </tbody></table></div></section>
    <section class="dash-panel"><header><b>⇧</b><strong>Importar relatório do GOAT</strong><span class="panel-count">${status.last_import?fmtDateTime(status.last_import.imported_at):'nunca importado'}</span></header>
      <div class="dash-panel-body" style="padding:14px 16px">
        <p style="color:#9caec4;font-size:12px;margin:0 0 10px">Sobe o arquivo com todas as abas (Rejeitados, Perdas, Desempenho de fornecedores etc.) — cada importação substitui o snapshot anterior.</p>
        <label class="primary" style="display:inline-block;cursor:pointer">Escolher arquivo .xlsx
          <input type="file" accept=".xlsx,.xlsm" class="hidden" onchange="goatImport(this)"></label>
        <div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:8px">
          ${status.sheets.map(s=>`<span class="type-tag">${esc(s.label)} · ${s.rows}</span>`).join('')}
        </div>
      </div></section>`;
}
async function goatImport(input){
  if(!input.files?.[0])return;
  const form=new FormData();form.append('file',input.files[0]);
  try{
    const d=await api('/api/goat/import',{method:'POST',body:form});
    toast(`${d.rows} registros importados em ${d.sheets} abas.`);
    renderGoatIndicators();
  }catch(e){toast(e.message);}
}

async function renderProduction(){
  setPage("Controle de Produção","Apontamento, produção por pessoa e importação — por setor");
  $("mainContent").innerHTML=`
    <div class="module-tabs">${PROD_SECTORS.map(s=>`<button class="${s===prodSector?'active':''}" onclick="prodSetSector('${s}')">${esc(s)}</button>`).join('')}</div>
    <div class="tabs" id="prodSubTabs" style="margin:14px 0 18px">
      <button class="${prodTab==='apontamento'?'active':''}" onclick="prodSetTab('apontamento')">Apontamento</button>
      <button class="${prodTab==='pessoa'?'active':''}" onclick="prodSetTab('pessoa')">Produção por pessoa</button>
      <button class="${prodTab==='quadro'?'active':''}" onclick="prodSetTab('quadro')">Quadro de tarefas</button>
    </div>
    <div id="prodBody"></div>`;
  await renderProdBody();
}
function prodSetSector(s){prodSector=s;renderProduction();}
function prodSetTab(t){prodTab=t;renderProdBody();}

async function renderProdBody(){
  const body=$("prodBody");
  if(!body)return;
  if(prodTab==="apontamento") return prodRenderApontamento(body);
  if(prodTab==="pessoa") return prodRenderPessoa(body);
  return prodRenderQuadro(body);
}

async function prodRenderApontamento(body){
  const [entries,ranking]=await Promise.all([
    safeApi(`/api/production/entries?sector=${encodeURIComponent(prodSector)}&limit=6`,[]),
    safeApi(`/api/production/by-person?sector=${encodeURIComponent(prodSector)}`,{sectors:{},totals:{}}),
  ]);
  const running=entries.find(e=>e.status!=='CONCLUIDO');
  if(running) prodRunning[prodSector]=running; else delete prodRunning[prodSector];
  const top=(ranking.sectors[prodSector]||[]).slice(0,4);
  const fields=PROD_FIELDS[prodSector];
  const kpi=ranking.totals[prodSector]||{tasks:0,qty:0};
  body.innerHTML=`
    <div class="hero-kpis">
      ${heroKpi("Tarefas concluídas",kpi.tasks.toLocaleString('pt-BR'),prodSector,"☑","blue","production")}
      ${heroKpi("Peças processadas",kpi.qty.toLocaleString('pt-BR'),prodSector,"▣","teal","production")}
      ${heroKpi("Peças / tarefa (média)",kpi.tasks?Math.round(kpi.qty/kpi.tasks).toLocaleString('pt-BR'):'0',"Média do setor","⌁","blue","production")}
      ${heroKpi("Colaboradores",(ranking.sectors[prodSector]||[]).length,"No setor","☺","teal","production")}
    </div>
    <div class="dash-row" style="grid-template-columns:1.1fr 1.5fr;gap:18px">
      <section class="dash-panel"><header><b>✎</b><strong>${running?'Tarefa em andamento':'Novo registro'}</strong><span class="panel-count">${esc(prodSector)}</span></header>
        <div class="dash-panel-body">
          ${running?prodRunningCard(running):prodFormCard(fields)}
        </div>
      </section>
      <section class="dash-panel"><header><b>☰</b><strong>Últimos registros</strong><span class="panel-count">hoje</span></header>
        <div class="dash-panel-body">${analyticsBarsBody(top.map(p=>({label:p.name,value:p.qty,hint:`${p.tasks} tarefa${p.tasks===1?'':'s'}`})))}
        <label class="panel-link" style="display:inline-block;margin-top:12px;cursor:pointer">Importar planilha do setor
          <input type="file" accept=".xlsx,.xlsm" class="hidden" onchange="prodImport(this)"></label>
        </div>
      </section>
    </div>`;
}

function prodFormCard(fields){
  return `<div class="prod-form">
    <div class="field-row"><div class="field"><label>Responsável</label><input id="prodResp" placeholder="Nome do colaborador"></div>
    <div class="field"><label>Quantidade</label><input id="prodQty" type="number" placeholder="0"></div></div>
    <div class="field-row">${fields.map((f,i)=>`<div class="field"><label>${esc(f[0])}</label>${f[1]==='select'?`<select id="prodField${i}">${f[2].map(o=>`<option>${esc(o)}</option>`).join('')}</select>`:`<input id="prodField${i}" type="${f[1]}" placeholder="—">`}</div>`).join('')}</div>
    <button class="primary" style="margin-top:4px;width:100%" onclick="prodStart()">▶ Iniciar tarefa</button>
  </div>`;
}

function prodRunningCard(entry){
  const paused=entry.status==='PAUSADO';
  return `<div class="prod-form">
    <div class="field-row"><div class="summary-box"><span>Responsável</span><strong>${esc(entry.responsavel)}</strong></div>
    <div class="summary-box"><span>Início</span><strong>${new Date(entry.inicio).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</strong></div></div>
    <div class="field"><label>Quantidade concluída</label><input id="prodQtyFinal" type="number" value="${entry.quantidade||0}"></div>
    <div style="display:flex;gap:8px">
      ${paused?`<button class="primary" style="flex:1" onclick="prodResume(${entry.id})">▶ Retomar</button>`:`<button class="secondary" style="flex:1" onclick="prodPause(${entry.id})">⏸ Pausa</button>`}
      <button class="danger" style="flex:1" onclick="prodComplete(${entry.id})">■ Concluir</button>
    </div>
    <div class="empty-visual" style="padding:8px!important">${paused?'Tarefa pausada':'Cronômetro em andamento'}</div>
  </div>`;
}

async function prodStart(){
  const resp=$("prodResp")?.value?.trim();
  if(!resp){toast("Informe o responsável.");return;}
  const fields=PROD_FIELDS[prodSector];
  const campos={};
  fields.forEach((f,i)=>{const v=$(`prodField${i}`)?.value;if(v)campos[f[0]]=v;});
  try{
    await api('/api/production/entries',{method:'POST',body:JSON.stringify({sector:prodSector,responsavel:resp,quantidade:Number($("prodQty")?.value||0),campos}),headers:{'Content-Type':'application/json'}});
    renderProdBody();
  }catch(e){toast(e.message);}
}
async function prodPause(id){try{await api(`/api/production/entries/${id}/pause`,{method:'POST'});renderProdBody();}catch(e){toast(e.message);}}
async function prodResume(id){try{await api(`/api/production/entries/${id}/resume`,{method:'POST'});renderProdBody();}catch(e){toast(e.message);}}
async function prodComplete(id){
  const qty=Number($("prodQtyFinal")?.value||0);
  try{await api(`/api/production/entries/${id}/complete`,{method:'POST',body:JSON.stringify({quantidade:qty}),headers:{'Content-Type':'application/json'}});toast("Tarefa concluída.");showTaskFeedback(id);renderProdBody();}catch(e){toast(e.message);}
}
function showTaskFeedback(entryId){
  $("modalBody").innerHTML=`<div class="card-title"><div><h2>Como foi essa tarefa?</h2><div class="card-subtitle">Você encontrou dificuldades ao executar essa tarefa? Se sim, conta pra nós melhorarmos o processo.</div></div></div>
    <div class="actions" style="margin-top:14px">
      <button class="secondary" onclick="closeModal()">Não, correu tudo bem</button>
      <button class="primary" onclick="prodFeedbackDetail(${entryId})">Sim, tive dificuldade</button>
    </div>`;
  $("modal").classList.remove("hidden");
}
function prodFeedbackDetail(entryId){
  $("modalBody").innerHTML=`<div class="card-title"><div><h2>O que dificultou?</h2><div class="card-subtitle">Conta em poucas palavras — isso vai direto pra quem cuida do processo.</div></div></div>
    <div class="field full"><textarea id="prodFeedbackText" placeholder="Ex.: etiqueta errada, falta de espaço no casulo, sistema travando..."></textarea></div>
    <div class="actions" style="margin-top:10px"><button class="primary" onclick="prodFeedbackSend(${entryId})">Enviar</button></div>`;
}
async function prodFeedbackSend(entryId){
  try{
    await api(`/api/production/entries/${entryId}/feedback`,{method:'POST',body:JSON.stringify({teve_dificuldade:true,comentario:$("prodFeedbackText")?.value||""}),headers:{'Content-Type':'application/json'}});
    toast("Obrigado pelo retorno!");
    closeModal();
  }catch(e){toast(e.message);}
}
async function prodImport(input){
  if(!input.files?.[0])return;
  const form=new FormData();form.append('file',input.files[0]);
  try{
    const d=await api(`/api/production/import?sector=${encodeURIComponent(prodSector)}`,{method:'POST',body:form});
    toast(`${d.imported} registros importados (${d.skipped} ignorados).`);
    renderProdBody();
  }catch(e){toast(e.message);}
}

async function prodRenderPessoa(body){
  const data=await safeApi(`/api/production/by-person?sector=${encodeURIComponent(prodSector)}`,{sectors:{},totals:{}});
  const rows=data.sectors[prodSector]||[];
  const max=Math.max(1,...rows.map(r=>r.qty));
  body.innerHTML=`<section class="dash-panel"><header><b>▥</b><strong>Produção por pessoa</strong><span class="panel-count">${esc(prodSector)} · peças totais</span></header>
    <div class="dash-panel-body">
      ${rows.length?`<div class="analytics-bars">${rows.map(r=>`<div><span>${esc(r.name)}</span><i><b style="width:${r.qty*100/max}%"></b></i><strong>${r.qty.toLocaleString('pt-BR')}</strong><small>${r.tasks} tarefa${r.tasks===1?'':'s'}</small></div>`).join('')}</div>`
      :'<div class="empty-visual">Ainda sem tarefas concluídas neste setor.</div>'}
    </div></section>`;
}

async function prodRenderQuadro(body){
  const entries=await safeApi(`/api/production/entries?sector=${encodeURIComponent(prodSector)}&limit=30`,[]);
  const running=entries.filter(e=>e.status!=='CONCLUIDO');
  const done=entries.filter(e=>e.status==='CONCLUIDO').slice(0,10);
  const card=e=>`<div class="prod-task"><b>${esc(e.responsavel)}</b><small>${e.quantidade||0} pçs${e.status==='PAUSADO'?' · pausada':''}</small></div>`;
  body.innerHTML=`<div class="dash-row" style="grid-template-columns:1fr 1fr;gap:18px">
    <section class="dash-panel"><header><b>◷</b><strong>Em execução</strong><span class="panel-count">${running.length}</span></header>
      <div class="dash-panel-body prod-tasks">${running.map(card).join('')||'<div class="empty-visual">Nada em andamento agora.</div>'}</div></section>
    <section class="dash-panel"><header><b>✓</b><strong>Concluído recentemente</strong><span class="panel-count">${done.length}</span></header>
      <div class="dash-panel-body prod-tasks">${done.map(card).join('')||'<div class="empty-visual">Sem tarefas concluídas ainda.</div>'}</div></section>
  </div>`;
}

async function renderStorageHub() {
  setPage("Estocagem", "");
  const [cards,analytics]=await Promise.all([safeApi("/api/cards?scope=storage",[]),safeApi("/api/unified/stock-group-report/analytics",{groups:[],latest_report:null})]);
  $("mainContent").innerHTML=`${moduleTabs([["Visão geral","storage-hub"],["Fila operacional","storage"]],"storage-hub")}<div class="hero-kpis storage-kpis">${heroKpi("Aguardando estocagem",cards.length,"Cards","⌂","blue","storage")}</div>
    <section class="dash-panel stock-report-panel"><header><b>⇧</b><strong>Relatório de estoque por grupo</strong><button class="panel-action" onclick="document.getElementById('stockGroupPdf').click()">Importar PDF</button><input id="stockGroupPdf" class="hidden" type="file" accept=".pdf" onchange="importStockGroupReport(this)"></header><div class="dash-panel-body">${analytics.groups?.length?`<div class="group-summary">${['FEMININO','MASCULINO','OUTROS'].map(g=>`<div><span>${g}</span><strong>${analytics.groups.filter(x=>x.gender===g).reduce((a,x)=>a+Number(x.quantity),0).toLocaleString('pt-BR')}</strong></div>`).join('')}</div>`:'<div class="empty-visual">Importe o PDF “Resumo de Estoque do Grupo” para recuperar a visão por gênero e grupo.</div>'}</div></section>`;
}

function moduleTabs(items,current){return `<div class="module-tabs">${items.map(([label,view])=>`<button class="${view===current?'active':''}" onclick="goTo('${view}')">${label}</button>`).join('')}</div>`;}
function filterStockQuick(){const t=normalizeSearch($("stockQuickSearch")?.value||'');document.querySelectorAll('.stock-quick-row').forEach(r=>r.classList.toggle('hidden',t&&!r.dataset.search.includes(t)));}
async function importStockGroupReport(input){if(!input.files?.[0])return;const form=new FormData();form.append('file',input.files[0]);try{const d=await api(`/api/unified/stock-group-report/import?user_id=${currentUser.id}`,{method:'POST',body:form});toast(`${d.groups} grupos e ${d.total_qty} peças importados.`);renderStorageHub();}catch(e){toast(e.message)}}

async function renderRegistrations(){
  setPage("Cadastros","");
  const [users,analytics]=await Promise.all([
    safeApi("/api/users",[]),
    safeApi("/api/unified/stock-group-report/analytics",{groups:[],latest_report:null})
  ]);
  const usersMeta = `<span class="panel-count">${users.length}</span>`;
  const usersTable = `<table class="dash-table"><thead><tr><th>Nome</th><th>Usuário</th><th>Perfil</th></tr></thead><tbody>${users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${statusBadge(u.role)}</td></tr>`).join("")}</tbody></table>`;
  const reportTitle = analytics.latest_report ? esc(analytics.latest_report.filename) : "Sem relatório";
  const reportBody = analyticsBarsBody((analytics.groups||[]).map(g => ({label:g.group_name,value:g.quantity,hint:g.gender})));
  $("mainContent").innerHTML = `<div class="actions" style="margin-bottom:12px"><button class="primary" onclick="openGoatCardModal()">+ Criar Card</button></div><div class="dash-row registrations-grid">${dashboardPanel("♙","Usuários e perfis",usersMeta,usersTable)}${dashboardPanel("▣","Grupos do último relatório",reportTitle,reportBody)}</div>`;
}

async function renderSettings(){setPage("Configurações","");$("mainContent").innerHTML=`<div class="settings-grid"><button onclick="goTo('import')"><b>⇧</b><strong>Importar compras</strong><span>Atualizar Cards a partir do relatório Excel.</span></button><button onclick="goTo('tasks')"><b>☑</b><strong>Quadro de tarefas</strong><span>Responsáveis, prioridades e andamento.</span></button><button onclick="goTo('test')"><b>⚙</b><strong>Administração e testes</strong><span>Ferramentas controladas para validação.</span></button><button onclick="goTo('history')"><b>◷</b><strong>Histórico global</strong><span>Rastreabilidade das movimentações.</span></button></div><div class="state-panel"><b>DistriLog V3</b><span>Uma interface, um backend e uma base SQLite. As regras congeladas de Recebimento, Qualidade e Processamento permanecem no motor operacional.</span></div>`;}

setInterval(() => { if ($("clock")) $("clock").textContent = new Date().toLocaleString("pt-BR"); }, 1000);
if (currentUser) enterApp();

/* V10 — endereçamento por referência + mapa visual */
function allocationItemRows(){
  const ctx=window.allocCtx;
  if(!ctx) return [];
  if(Array.isArray(ctx.sourceItems)) return ctx.sourceItems.filter(function(i){return Number(i.expected_qty||0)>0;});
  if(!cardData) return [];
  const opIds=(cardData.receiving?.operation_items||[]).map(function(i){return Number(i.id);}).filter(Boolean);
  const source=opIds.length
    ? (cardData.items||[]).filter(function(i){return opIds.includes(Number(i.id));})
    : (cardData.items||[]);
  return source.filter(function(i){return Number(i.expected_qty||0)>0;});
}

function itemAllocationInfo(itemId){
  const rows=window.allocCtx?.status?.item_allocations||[];
  return rows.find(function(r){return Number(r.item_id)===Number(itemId);}) || null;
}

function itemAllocatedQty(itemId){
  return Number(itemAllocationInfo(itemId)?.total_alocado||0);
}

function globalItemAllocatedQty(itemId){
  const ctx=window.allocCtx;
  const rows=ctx&&["ET","EC"].includes(ctx.setor)
    ? (ctx.status?.item_allocations||[])
    : (ctx?.status?.global_item_allocations||[]);
  const row=rows.find(function(r){return Number(r.item_id)===Number(itemId);});
  return Number(row?.total_alocado||0);
}

function itemRemainingQty(item){
  return Math.max(0, Number(item.expected_qty||0) - globalItemAllocatedQty(item.id));
}

function selectedAllocationItem(){
  const rows=allocationItemRows();
  const id=Number(window.allocCtx?.selectedItemId||0);
  return rows.find(function(i){return Number(i.id)===id;}) || rows[0] || null;
}

function referenceLabel(item){
  return item?.reference || item?.product || item?.sku || ("Item " + item?.id);
}

function referenceDetailLabel(item){
  return referenceLabel(item);
}

function referenceSecondaryLabel(item){
  return [item?.sku || null, item?.color || null, item?.size || null].filter(Boolean).join(" • ");
}

function renderAllocationItemPicker(){
  const ctx=window.allocCtx;
  const unit=ctx&&["ET","EC"].includes(ctx.setor)?"peças":"volumes";
  const box=$("positionItemPicker");
  if(!ctx || !box) return;
  const items=allocationItemRows();

  if(!items.length){
    box.innerHTML='<div class="position-empty">Nenhuma referência disponível para este Recebimento.</div>';
    return;
  }

  box.innerHTML=items.map(function(item){
    const allocated=globalItemAllocatedQty(item.id);
    const selected=Number(ctx.selectedItemId)===Number(item.id);
    return '<button type="button" class="allocation-item-card ' + (selected?'is-selected ':'') +
      '" onclick="selectAllocationItem(' + Number(item.id) + ')">' +
        '<div class="allocation-item-main">' +
          '<span class="allocation-item-ref">' + esc(referenceLabel(item)) + '</span>' +
          '<small>'+esc(referenceSecondaryLabel(item) || "Sem detalhe")+'</small>' +
        '</div>' +
        '<div class="allocation-item-numbers">' +
          '<b>'+allocated.toLocaleString("pt-BR")+'</b><span>'+unit+' alocados</span>' +
          '<b>'+Number(item.expected_qty||0).toLocaleString("pt-BR")+'</b><span>peças da referência</span>' +
        '</div>' +
      '</button>';
  }).join("");
}

function positionCardQty(address){
  const rows=window.allocCtx?.status?.posicoes||[];
  const row=rows.find(function(p){return p.address===address;});
  return Number(row?.quantidade||0);
}

function positionItemQty(address,itemId){
  const info=itemAllocationInfo(itemId);
  const row=(info?.posicoes||[]).find(function(p){return p.address===address;});
  return Number(row?.quantidade||0);
}


function positionCellHtml(p,ctx){
  const occupied=Number(p.ocupado||0),unit=ctx&&["ET","EC"].includes(ctx.setor)?"peça(s)":"volume(s)";
  const cardQty=positionCardQty(p.address),itemQty=ctx.selectedItemId?positionItemQty(p.address,ctx.selectedItemId):0;
  const selected=ctx.selectedAddress===p.address;
  const classes=["position-cell",occupied>0?"is-occupied":"is-free",cardQty>0?"is-card":"",itemQty>0?"is-item":"",selected?"is-selected":""].filter(Boolean).join(" ");
  const title=(ctx.selectedItemId&&itemQty>0)
    ?p.address+" • "+itemQty+" "+unit+" desta referência • "+occupied+" "+unit+" no setor"
    :p.address+" • "+occupied+" "+unit+" no setor";
  return '<button type="button" class="'+classes+'" title="'+esc(title)+'" onclick="selectAllocationPosition(\''+esc(p.address)+'\')">' +
    '<span class="position-level">'+esc(p.nivel)+'</span>' +
    '<strong>'+esc(p.address)+'</strong>' +
    '<small>'+(occupied?occupied.toLocaleString("pt-BR"):"Livre")+(itemQty>0?" · Ref: "+itemQty.toLocaleString("pt-BR"):"")+'</small>' +
  '</button>';
}

function renderPositionMap(){
  const ctx=window.allocCtx;
  const map=$("positionMap");
  if(!ctx || !map) return;
  const term=normalizeSearch(ctx.search||"");
  const zone=ctx.zoneFilter||"ALL";
  const state=ctx.posFilter||"ALL";

  const visible=(ctx.positions||[]).filter(function(p){
    const zoneOk=zone==="ALL"||String(p.zona)===String(zone);
    const cardQty=positionCardQty(p.address);
    const stateOk=
      state==="ALL" ||
      (state==="FREE"&&Number(p.ocupado||0)===0) ||
      (state==="OCCUPIED"&&Number(p.ocupado||0)>0) ||
      (state==="CARD"&&cardQty>0);
    const searchOk=!term||normalizeSearch([p.address,p.casulo,p.nivel,p.zona,p.zona_label].join(" ")).includes(term);
    return zoneOk&&stateOk&&searchOk;
  });

  const grouped={};
  visible.forEach(function(p){
    const key=String(p.zona)+"|"+String(p.casulo);
    if(!grouped[key]) grouped[key]=[];
    grouped[key].push(p);
  });

  const zones={};
  Object.keys(grouped).forEach(function(key){
    const parts=key.split("|");
    const zona=parts[0];
    const casulo=parts[1];
    if(!zones[zona]) zones[zona]=[];
    zones[zona].push({casulo:casulo,rows:grouped[key]});
  });

  const zoneEntries=Object.entries(zones).sort(function(a,b){return String(a[0]).localeCompare(String(b[0]));});
  if(!zoneEntries.length){
    map.innerHTML='<div class="position-empty large">Nenhuma posição encontrada com os filtros atuais.</div>';
    return;
  }

  map.innerHTML=zoneEntries.map(function(entry){
    const zona=entry[0];
    const casulos=entry[1];
    const zoneRows=ctx.positions.filter(function(p){return String(p.zona)===String(zona);});
    return '<section class="position-zone">' +
      '<div class="position-zone-head"><div><b>'+esc(zoneRows[0]?.zona_label||("Zona "+zona))+'</b><span>'+
        casulos.length+' casulo(s) visível(is)</span></div><small>'+
        casulos.reduce(function(n,c){return n+c.rows.length;},0)+' posições</small></div>' +
      '<div class="position-casulo-grid">'+
        casulos.sort(function(a,b){return String(a.casulo).localeCompare(String(b.casulo));}).map(function(group){
          const rows=group.rows.sort(function(a,b){return String(a.nivel).localeCompare(String(b.nivel));});
          return '<div class="position-casulo">' +
            '<div class="position-casulo-head"><span>CASULO</span><b>'+esc(group.casulo)+'</b></div>' +
            '<div class="position-levels">'+rows.map(function(p){return positionCellHtml(p,ctx);}).join("")+'</div>' +
          '</div>';
        }).join("") +
      '</div>' +
    '</section>';
  }).join("");
}

function selectAllocationItem(itemId){
  const ctx=window.allocCtx;
  if(!ctx) return;
  const item=allocationItemRows().find(function(i){return Number(i.id)===Number(itemId);});
  if(!item) return;
  ctx.selectedItemId=Number(itemId);
  const info=itemAllocationInfo(itemId);
  ctx.selectedAddress=info?.posicoes?.[0]?.address || ctx.suggestion?.address || ctx.selectedAddress || "";
  if($("positionSelectedItemLabel")) $("positionSelectedItemLabel").textContent=referenceDetailLabel(item);
  if($("positionSelectedLabel")) $("positionSelectedLabel").textContent=ctx.selectedAddress||"Nenhuma";
  renderAllocationItemPicker();
  renderPositionMap();
  updateReferenceRemaining();
  updateAllocHint();
}

function selectAllocationPosition(address){
  const ctx=window.allocCtx;
  if(!ctx) return;
  ctx.selectedAddress=address;
  if($("positionSelectedLabel")) $("positionSelectedLabel").textContent=address||"Nenhuma";
  renderPositionMap();
  $("posQty")?.focus();
}

function filterPositionMap(){
  const ctx=window.allocCtx;
  if(!ctx) return;
  ctx.search=$("positionSearch")?.value||"";
  ctx.zoneFilter=$("positionZoneFilter")?.value||"ALL";
  ctx.posFilter=$("positionStateFilter")?.value||"ALL";
  renderPositionMap();
}

async function loadReturnAllocationStep(cardId) {
  window.qaSampleAllocationRequired = false;
  window.qaSampleAllocationComplete = true;
  const box = $("posAllocBox");
  if (!box) return;
  const receiving = cardData?.receiving || {};
  const volumes = Number(receiving.volumes || 0);
  if (!Number.isFinite(volumes) || volumes <= 0) {
    box.innerHTML = '<div class="notice warn">Informe e salve uma quantidade de volumes maior que zero para liberar o endereçamento completo do retorno.</div>';
    return;
  }
  await loadPositionAllocator(cardId, "RM");
}

async function loadReceivingAllocationStep(cardId) {
  window.qaSampleAllocationRequired = true;
  window.qaSampleAllocationComplete = false;
  const box=$("posAllocBox");
  if(!box) return;
  window.positionAllocatorRetry={cardId,setor,tenPercentSample,tenPercentTarget,sourceItemsOverride,fixedDestination};
  try {
    const status=await apiWithTimeout("/api/positions/cards/"+cardId+"/status?setor=QA");
    const receiving=cardData?.receiving||{};
    const totalVolumes=Number(receiving.volumes||status.volumes_total||0);
    const target=totalVolumes>0?1:0;
    const allocated=Number(status.ten_percent_sample_allocated||0);
    if(target<=0) {
      box.innerHTML='<div class="notice warn">Informe e salve a quantidade total de volumes recebidos para calcular os 10% e liberar o endereçamento.</div>';
      return;
    }
    if(allocated<target) {
      window.qaSampleAllocationComplete = false;
      await loadPositionAllocator(cardId,"QA",true,target);
      return;
    }
    window.qaSampleAllocationComplete = true;
    await loadPositionAllocator(cardId,"RM");
  } catch(error) {
    box.innerHTML='<div class="notice error">Não foi possível verificar a alocação obrigatória da amostra: '+esc(error.message||"Erro desconhecido")+'. <button class="secondary" onclick="loadReceivingAllocationStep('+Number(cardId)+')">Tentar novamente</button></div>';
  }
}

function scopedPieceAllocatedTotal(status,sourceItems){
  const ids=new Set((sourceItems||[]).map(item=>Number(item.id)).filter(Boolean));
  return (status?.item_allocations||[]).reduce((sum,row)=>ids.has(Number(row.item_id))?sum+Number(row.total_alocado||0):sum,0);
}
function retryPositionAllocator(){
  const r=window.positionAllocatorRetry;
  if(!r)return;
  loadPositionAllocator(r.cardId,r.setor,r.tenPercentSample,r.tenPercentTarget,r.sourceItemsOverride,r.fixedDestination);
}
async function loadPositionAllocator(cardId,setor,tenPercentSample=false,tenPercentTarget=0,sourceItemsOverride=null,fixedDestination=false) {
  const box=$("posAllocBox");
  if(!box) return;
  const requestId=(window.positionMapRequestId||0)+1;
  window.positionMapRequestId=requestId;
  box.innerHTML='<div class="position-loading"><span class="spinner-dot"></span> Montando mapa de posições…</div>';
  try {

    const results=await Promise.all([
      apiWithTimeout("/api/positions/cards/"+cardId+"/status?setor="+encodeURIComponent(setor)),
      apiWithTimeout("/api/positions?setor="+encodeURIComponent(setor))
    ]);
    if(requestId!==window.positionMapRequestId) return;
    const status=results[0], positions=results[1];
    if(!status || typeof status!=="object") throw new Error("O servidor retornou um status inválido para as alocações.");
    if(!Array.isArray(positions)) throw new Error("O servidor retornou um formato inválido para as posições.");
    if(!positions.length) throw new Error("Nenhum endereço foi carregado. Confira a conexão com o Supabase e a tabela sector_positions.");
    const suggestion=positions.reduce((best,p)=>!best || Number(p.ocupado||0)<Number(best.ocupado||0)?p:best,null);
  const rcv=cardData?.receiving||{};
  const baseItems=Array.isArray(sourceItemsOverride)?sourceItemsOverride:(cardData?.items||[]);
  const items=baseItems.filter(function(i){return Number(i.expected_qty||0)>0;});
  const opIds=(rcv.operation_items||[]).map(function(i){return Number(i.id);}).filter(Boolean);
  const isPieceSector=["ET","EC"].includes(setor);
  const isVolumeOnlyRM=setor==="RM";
  const isTenPercentSample=Boolean(tenPercentSample)&&setor==="QA";
  const isReturnVolumeAllocation=rcv.receiving_type==="RETORNO"&&!isTenPercentSample;
  const isVolumeOnly=isVolumeOnlyRM||isTenPercentSample;
  if(isTenPercentSample)tenPercentTarget=Number(tenPercentTarget)||(Number(rcv.volumes||0)>0?1:0);

  const sectorItems=sourceItemsOverride?items:items.filter(function(i){return i.source_stage===(setor==="ET"?"ETIQUETAGEM":"ESTOCAGEM");});

  const sourceItems=isPieceSector?(sectorItems.length?sectorItems:items):(opIds.length?items.filter(function(i){return opIds.includes(Number(i.id));}):items);

  const receivingVolumes=Number(rcv.volumes||0);
  const sourceTotal=isTenPercentSample?tenPercentTarget:(isPieceSector?sourceItems.reduce(function(sum,item){return sum+Number(item.expected_qty||0);},0):receivingVolumes);
  const firstAvailable=sourceItems[0] || null;
  const firstAllocated=status.item_allocations?.find(function(i){return Number(i.total_alocado||0)>0;}) || null;
  const sampleAllocated=Number(status.ten_percent_sample_allocated||0);

  const scopedAllocated=isPieceSector?scopedPieceAllocatedTotal(status,sourceItems):Number(status.global_total_alocado||0);
  window.allocCtx={
    cardId:cardId,setor:setor,sourceTotal:sourceTotal,tenPercentSample:isTenPercentSample,
    sourceItems:sourceItems,fixedDestination:Boolean(fixedDestination),
    remaining:isTenPercentSample?Math.max(0,sourceTotal-sampleAllocated):Math.max(0,sourceTotal-scopedAllocated),
    positions:positions,status:status,suggestion:suggestion,
    selectedItemId:isVolumeOnly?0:Number(firstAvailable?.id||firstAllocated?.item_id||0),
    selectedAddress:suggestion?.address||firstAllocated?.posicoes?.[0]?.address||"",
    posFilter:"ALL",zoneFilter:"ALL",search:""
  };

  const zones=[...new Set(positions.map(function(p){return p.zona;}))].sort();
  box.innerHTML=
    '<div class="position-allocator">' +
      '<div class="position-allocator-head">' +
        '<div><div class="position-kicker">ENDEREÇAMENTO FÍSICO</div>' +
          '<h3>'+(isTenPercentSample?"Alocar os 10% na Qualidade":({RM:"Alocar no Recebimento",QA:"Alocar na Qualidade",PR:"Alocar no Processamento",ET:"Alocar na Etiquetagem",EC:"Alocar na Estocagem"}[setor]||("Alocar no "+setor)))+'</h3>' +
          '<p>'+(isTenPercentSample?"Etapa obrigatória: enderece exatamente "+Number(tenPercentTarget).toLocaleString("pt-BR")+" volume(s) da amostra em endereços da QA antes de liberar o RM.":(isVolumeOnlyRM?"No RM, a alocação é exclusivamente por volumes, sem divisão por produto, cor ou tamanho.":("Escolha primeiro a referência, depois a posição. O controle é feito em "+(isPieceSector?"peças":"volumes")+" da referência.")))+'</p>' +
          (isTenPercentSample ? '<div class="position-dest"><b>Destino fixo: Qualidade (QA)</b><small>Os 10% são endereçados primeiro; o saldo global restante continua compartilhado entre RM, QA e PR.</small></div>' :
          fixedDestination ? '<div class="position-dest"><b>Destino fixo: '+esc(setor==="ET"?"Etiquetagem (ET)":"Estocagem (EC)")+'</b><small>Este fechamento não permite alterar o setor de destino.</small></div>' :
          '<div class="position-dest"><label for="positionDestSetor">Destino</label>' +
            '<select id="positionDestSetor" onchange="changeAllocDestination(this.value)">'+
              (isReturnVolumeAllocation ? [["RM","Recebimento (RM)"],["QA","Qualidade (QA)"],["PR","Processamento (PR)"]] : [["RM","Recebimento (RM)"],["QA","Qualidade (QA)"],["PR","Processamento (PR)"],["ET","Etiquetagem (ET)"],["EC","Estocagem (EC)"]]).map(function(o){
                return '<option value="'+o[0]+'"'+(o[0]===setor?' selected':'')+'>'+o[1]+'</option>';
              }).join("")+
            '</select><small>'+(isPieceSector?"Saldo em peças nesta área.":"Saldo em volumes compartilhado entre RM, QA e PR.")+'</small></div>') +
        '</div>' +
        '<div class="position-suggest">'+
          (suggestion?'<span>SUGESTÃO AUTOMÁTICA</span><b>'+esc(suggestion.address)+'</b><small>'+
            Number(suggestion.ocupado||0).toLocaleString("pt-BR")+' '+(isPieceSector?"peça(s)":"volume(s)")+' já ocupado(s)</small>':
            '<span>SEM SUGESTÃO DISPONÍVEL</span>')+
        '</div>' +
      '</div>' +

      (isVolumeOnly ?
        '<div class="position-reference-panel"><div class="notice">'+(isTenPercentSample?"A amostra deve ser alocada somente em volumes na QA, sem dividir por referência, cor ou tamanho. A alocação é obrigatória e fica limitada aos 10% definidos para este recebimento.":"O RM registra somente volumes por endereço; nenhuma alocação fica vinculada a produto, cor, tamanho ou referência.")+'</div></div>' :
        '<div class="position-reference-panel">' +
          '<div class="position-section-title"><b>Referência a alocar</b><span>Escolha uma por vez</span></div>' +
          '<div id="positionItemPicker" class="allocation-item-grid"></div>' +
        '</div>') +

      '<div class="position-stat-grid">' +
        '<div class="position-stat"><span>'+(isTenPercentSample?"10% endereçados na QA":"Total alocado")+'</span><strong id="positionAllocatedTotal">'+Number(isTenPercentSample?sampleAllocated:(isPieceSector?scopedAllocated:status.global_total_alocado||0)).toLocaleString("pt-BR")+
          '</strong><small>'+(isTenPercentSample?"de "+Number(tenPercentTarget).toLocaleString("pt-BR")+" volume(s) obrigatórios":(isPieceSector?"peças alocadas em "+setor:"volumes globais · RM "+Number(status.global_por_setor?.RM||0).toLocaleString("pt-BR")+
          ' · QA '+Number(status.global_por_setor?.QA||0).toLocaleString("pt-BR")+
          ' · PR '+Number(status.global_por_setor?.PR||0).toLocaleString("pt-BR")) )+'</small></div>' +
        '<div class="position-stat"><span>Posições usadas</span><strong id="positionUsedCount">'+(status.posicoes?.length||0)+
          '</strong><small>endereços</small></div>' +
        '<div class="position-stat"><span>'+(isTenPercentSample?"Restante dos 10%":(isVolumeOnlyRM?"Saldo global do Card":"Saldo da referência"))+'</span><strong id="positionReferenceRemainingStat">—</strong><small>'+(isPieceSector?"peças restantes":(isTenPercentSample?"volume(s) que ainda precisam de endereço":(isVolumeOnlyRM?"volumes restantes no Card":"volumes restantes")))+'</small></div>' +
      '</div>' +

      '<div class="position-controls">' +
        '<div class="position-search"><span>⌕</span><input id="positionSearch" placeholder="Buscar endereço, casulo ou nível" oninput="filterPositionMap()"></div>' +
        '<select id="positionZoneFilter" onchange="filterPositionMap()"><option value="ALL">Todas as zonas</option>'+
          zones.map(function(z){
            const label=positions.find(function(p){return String(p.zona)===String(z);})?.zona_label||("Zona "+z);
            return '<option value="'+esc(z)+'">'+esc(label)+'</option>';
          }).join("")+'</select>' +
        '<select id="positionStateFilter" onchange="filterPositionMap()"><option value="ALL">Todas as posições</option><option value="FREE">Livres</option><option value="OCCUPIED">Ocupadas</option><option value="CARD">Usadas neste Card</option></select>' +
      '</div>' +

      '<div class="position-legend"><span><i class="position-dot free"></i>Livre</span><span><i class="position-dot occupied"></i>Ocupada</span><span><i class="position-dot selected"></i>Selecionada</span>'+(isVolumeOnly?"":'<span><i class="position-dot item"></i>Usada pela referência</span>')+'</div>' +
      '<div id="positionMap" class="position-map"></div>' +

      '<div class="position-allocation-editor">' +
        (isVolumeOnly ?
          '<div class="position-selected"><span>ALOCAÇÃO POR VOLUMES</span><strong id="positionSelectedItemLabel">'+(isTenPercentSample?"Amostra de 10% — Qualidade":"Saldo global do Card")+'</strong><small id="positionReferenceRemainingLabel"></small><em id="positionSelectedLabel">'+esc(window.allocCtx.selectedAddress||"Nenhuma")+'</em></div>' :
          '<div class="position-selected"><span>REFERÊNCIA SELECIONADA</span><strong id="positionSelectedItemLabel">'+esc(firstAvailable?referenceDetailLabel(firstAvailable):"Nenhuma")+'</strong><small id="positionReferenceRemainingLabel"></small><em id="positionSelectedLabel">'+esc(window.allocCtx.selectedAddress||"Nenhuma")+'</em></div>') +
        '<div class="position-editor-fields">' +
          '<div class="field"><label>'+(isPieceSector?"Peças nesta posição":"Volumes nessa posição")+'</label><input id="posQty" type="number" min="1" max="'+(isTenPercentSample?window.allocCtx.remaining:"")+'" placeholder="Ex.: 30" oninput="updateAllocHint()"><small id="posHint" class="muted">'+(isTenPercentSample?("Restam "+window.allocCtx.remaining.toLocaleString("pt-BR")+" volumes dos 10%"):(isVolumeOnlyRM ? ("Saldo do Card: "+window.allocCtx.remaining.toLocaleString("pt-BR")+" volumes") : ("Saldo da referência: "+(firstAvailable?itemRemainingQty(firstAvailable).toLocaleString("pt-BR"):"—")+" "+(isPieceSector?"peças":"volumes"))))+'</small></div>' +
          '<div class="position-editor-action"><button class="primary" onclick="submitAllocation('+cardId+',\''+setor+'\')">+ '+(isVolumeOnly?"Alocar volumes":"Alocar referência")+'</button></div>' +
        '</div>' +
      '</div>' +

      '<div class="position-current-allocations">' +
        '<div class="position-section-title"><b>Alocações nesta área</b><span>'+(isVolumeOnlyRM?"por endereço":"separadas por referência")+'</span></div>' +
        '<div id="positionCurrentAllocations"></div>' +
      '</div>' +
    '</div>';

  renderAllocationItemPicker();
  renderCurrentItemAllocations();
  updateReferenceRemaining();
  renderPositionMap();
  } catch(error) {
    if(requestId!==window.positionMapRequestId) return;
    console.error("Falha ao gerar mapa de posições:",error);
    window.allocCtx=null;
    const activeBox=$("posAllocBox");
    if(!activeBox || !activeBox.isConnected) return;
    activeBox.innerHTML='<div class="position-empty large"><strong>Não foi possível gerar o mapa de posições.</strong><p>'+esc(error?.message||"Falha ao carregar ou montar os endereços.")+'</p><button type="button" class="secondary" onclick="retryPositionAllocator()">Tentar novamente</button></div>';
  }

}

function changeAllocDestination(setor){
  const ctx=window.allocCtx;
  if(!ctx||!setor||setor===ctx.setor) return;
  if(ctx.fixedDestination){toast("O destino desta etapa é fixo.");return;}
  loadPositionAllocator(ctx.cardId,setor);
}

function updateReferenceRemaining(){
  const ctx=window.allocCtx;
  if(!ctx)return;
  if(ctx.tenPercentSample){
    const allocated=Number(ctx.status?.ten_percent_sample_allocated||0);
    if($("positionReferenceRemainingStat"))$("positionReferenceRemainingStat").textContent=Number(ctx.remaining||0).toLocaleString("pt-BR");
    if($("positionReferenceRemainingLabel"))$("positionReferenceRemainingLabel").textContent=allocated.toLocaleString("pt-BR")+" de "+Number(ctx.sourceTotal||0).toLocaleString("pt-BR")+" volumes dos 10% alocados na QA";
    if($("positionSelectedItemLabel"))$("positionSelectedItemLabel").textContent="Amostra de 10% — Qualidade";
    return;
  }
  if(ctx.setor==="RM"){
    const allocated=Number(ctx.status?.global_total_alocado||0);
    if($("positionReferenceRemainingStat"))$("positionReferenceRemainingStat").textContent=Number(ctx.remaining||0).toLocaleString("pt-BR");
    if($("positionReferenceRemainingLabel"))$("positionReferenceRemainingLabel").textContent=allocated.toLocaleString("pt-BR")+" volumes alocados no saldo global";
    if($("positionSelectedItemLabel"))$("positionSelectedItemLabel").textContent="Saldo global do Card";
    return;
  }
  const item=selectedAllocationItem();
  if(!item)return;
  const allocated=globalItemAllocatedQty(item.id),remaining=itemRemainingQty(item);
  const unit=["ET","EC"].includes(ctx.setor)?"peças":"volumes";
  if($("positionReferenceRemainingStat"))$("positionReferenceRemainingStat").textContent=remaining.toLocaleString("pt-BR");
  if($("positionReferenceRemainingLabel"))$("positionReferenceRemainingLabel").textContent=allocated.toLocaleString("pt-BR")+" "+unit+(unit==="peças"?" alocadas neste setor":" alocados globalmente");
  if($("positionSelectedItemLabel"))$("positionSelectedItemLabel").textContent=referenceDetailLabel(item);
}

function renderCurrentItemAllocations(){
  const box=$("positionCurrentAllocations");
  const ctx=window.allocCtx;
  const unit=ctx&&["ET","EC"].includes(ctx.setor)?"peças":"volumes";
  if(!box||!ctx) return;
  if(ctx.setor==="RM"||ctx.tenPercentSample){
    const positions=ctx.status?.posicoes||[];
    if(!positions.length){
      box.innerHTML='<div class="position-empty">'+(ctx.tenPercentSample?"Ainda não há volumes da amostra alocados na QA.":"Nenhum volume alocado no RM para este Card.")+'</div>';
      return;
    }
    box.innerHTML=positions.map(function(p){
      return '<div class="reference-allocation-summary"><div><b>'+esc(p.address)+'</b><small>'+(ctx.tenPercentSample?"Endereço da amostra na QA":"Endereço no RM")+'</small></div><strong>'+Number(p.quantidade||0).toLocaleString("pt-BR")+' volumes</strong></div>';
    }).join("");
    return;
  }
  const rows=(ctx.status?.item_allocations||[]);
  if(!rows.length){
    box.innerHTML='<div class="position-empty">Nenhuma referência foi alocada neste Card ainda.</div>';
    return;
  }
  box.innerHTML=rows.map(function(row){
    return '<div class="reference-allocation-summary">' +
      '<div><b>'+esc(referenceDetailLabel(row))+'</b><small>'+(row.product?esc(row.product):"")+'</small></div>' +
      '<strong>'+Number(row.total_alocado||0).toLocaleString("pt-BR")+' '+unit+'</strong>' +
      '<div class="reference-allocation-addresses">'+(row.posicoes||[]).map(function(p){
        return '<button type="button" onclick="selectAllocationItem('+Number(row.item_id)+');selectAllocationPosition(\''+esc(p.address)+'\')">'+
          esc(p.address)+' · '+Number(p.quantidade||0).toLocaleString("pt-BR")+' '+unit+'</button>';
      }).join("")+'</div>' +
    '</div>';
  }).join("");
}

function updateAllocHint(){
  const el=$("posHint"),ctx=window.allocCtx;
  if(!el||!ctx)return;
  const raw=Number($("posQty")?.value||0),unit=["ET","EC"].includes(ctx.setor)?"peças":"volumes";
  if(ctx.setor==="RM"||ctx.tenPercentSample){
    el.textContent=(ctx.tenPercentSample?"Volumes restantes dos 10%: ":"Volumes restantes no Card: ")+Number(ctx.remaining||0).toLocaleString("pt-BR");
    if(raw>Number(ctx.remaining||0))el.textContent+=" — quantidade acima do saldo disponível.";
    updateReferenceRemaining();
    return;
  }
  const item=selectedAllocationItem();
  if(!item)return;
  el.textContent=(unit==="peças"?"Peças restantes nesta referência: ":"Volumes restantes no Card: ")+Number(ctx.remaining||0).toLocaleString("pt-BR");
  if(raw>Number(ctx.remaining||0))el.textContent+=" — quantidade acima do saldo disponível.";
  updateReferenceRemaining();
}

async function submitAllocation(cardId,setor){
  const ctx=window.allocCtx||{},isVolumeOnlyRM=setor==="RM",isTenPercentSample=Boolean(ctx.tenPercentSample),isVolumeOnly=isVolumeOnlyRM||isTenPercentSample;
  const item=isVolumeOnly?null:selectedAllocationItem(),address=ctx.selectedAddress||"",qty=Number($("posQty")?.value||0);
  const isPieceSector=["ET","EC"].includes(setor),unit=isPieceSector?"peça(s)":"volume(s)";
  if(!isVolumeOnly&&!item){toast("Selecione a referência que será alocada.");return;}
  if(!address){toast("Clique em uma posição no mapa.");return;}
  if(qty<=0){toast("Informe a quantidade para esta referência.");return;}
  if(ctx.remaining<=0){toast(isTenPercentSample?"Os 10% já foram totalmente endereçados na Qualidade.":(isPieceSector?"Não há mais peças disponíveis nesta referência.":"Não há mais volumes disponíveis para este Card."));return;}
  if(!isVolumeOnly){
    const itemRemaining=itemRemainingQty(item);
    if(isPieceSector&&qty>itemRemaining){toast("A referência possui apenas "+itemRemaining.toLocaleString("pt-BR")+" peça(s) disponíveis.");return;}
  }
  if(qty>ctx.remaining){toast("A quantidade ultrapassa o saldo de "+ctx.remaining.toLocaleString("pt-BR")+" "+unit+" disponíveis.");return;}
  try{
    const result=await api("/api/positions/cards/"+cardId+"/allocate",{
      method:"POST",body:JSON.stringify({
        setor:setor,responsavel:currentUser?.name,receiving_id:cardData?.receiving?.id||null,
        allocation_purpose:isTenPercentSample?"TEN_PERCENT_SAMPLE":null,
        allocations:[{item_id:isVolumeOnly?null:Number(item.id),address:address,quantidade:qty}]
      })
    });
    ctx.status=result;
    if(isTenPercentSample){
      ctx.remaining=Math.max(0,Number(ctx.sourceTotal||0)-Number(result.ten_percent_sample_allocated||0));
      $("posQty").value="";
      toast("Amostra alocada na Qualidade em "+address+" com "+qty.toLocaleString("pt-BR")+" volume(s).");
      if(ctx.remaining<=0){
        await openCard(currentCardId,"quality");
      }else{
        await loadPositionAllocator(cardId,"QA",true,ctx.sourceTotal);
      }
      return;
    }
    const scopedNow=isPieceSector?scopedPieceAllocatedTotal(result,ctx.sourceItems):Number(result.global_total_alocado||0);
    ctx.remaining=Math.max(0,Number(ctx.sourceTotal||0)-scopedNow);
    ctx.positions=await api("/api/positions?setor="+setor);
    $("posQty").value="";
    if($("positionAllocatedTotal"))$("positionAllocatedTotal").textContent=Number(isPieceSector?scopedNow:result.global_total_alocado||0).toLocaleString("pt-BR");
    if($("positionUsedCount"))$("positionUsedCount").textContent=String(result.posicoes?.length||0);
    toast((isVolumeOnlyRM?"Volumes":"Referência "+referenceLabel(item))+" alocados em "+address+" com "+qty.toLocaleString("pt-BR")+" "+unit+".");
    renderAllocationItemPicker();renderCurrentItemAllocations();updateReferenceRemaining();renderPositionMap();
  }catch(e){toast(e.message);}
}

// ---------- Renata Ingrata: controle de tempo das limpezas ----------

function fmtDurationShort(seconds) {
  const s = Math.max(0, Math.round(Number(seconds || 0)));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (s < 3600) return `${m} min ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)} h ${String(m % 60).padStart(2, "0")} min`;
}

function cleaningTimerHtml(task, fetchedAt) {
  const running = task.status === "EM_ANDAMENTO";
  return `<span class="clean-clock" data-clean-timer data-base="${Number(task.worked_seconds || 0)}" data-running="${running ? 1 : 0}" data-fetched="${fetchedAt}">${fmtSeconds(task.worked_seconds)}</span>`;
}

function cleaningActionButtons(task) {
  const id = Number(task.id);
  const pauseOrResume = task.status === "EM_ANDAMENTO"
    ? `<button class="secondary" onclick="cleaningAction(${id},'pause')">Pausar</button>`
    : `<button class="primary" onclick="cleaningAction(${id},'resume')">Retomar</button>`;
  return `${pauseOrResume}<button class="success" onclick="cleaningAction(${id},'finish')">Concluir limpeza</button>`;
}

async function renderCleaning() {
  setPage("Renata Ingrata", "Controle de tempo das limpezas por área");
  clearInterval(cleaningTick);
  const data = await api(`/api/cleaning/overview?user_id=${currentUser.id}&days=${cleaningDays}`);
  const fetchedAt = Date.now();
  const mine = data.active.find((t) => Number(t.user_id) === Number(currentUser.id));
  const others = data.active.filter((t) => t !== mine);
  const canDelete = ["admin", "supervisor"].includes(currentUser.role);
  const maxAvg = Math.max(1, ...data.by_area.map((a) => a.avg_seconds));
  const when = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
  const startPanel = mine
    ? `<div class="clean-active"><div><span class="clean-area-tag">${esc(mine.area)}</span><div class="muted">${mine.status === "PAUSADA" ? "Pausada" : "Em andamento"} · iniciada às ${when(mine.started_at)}</div></div>
         ${cleaningTimerHtml(mine, fetchedAt)}<div class="actions">${cleaningActionButtons(mine)}</div></div>`
    : `<div class="field"><label>Observação (opcional)</label><input id="cleaningNotes" maxlength="120" placeholder="Ex.: limpeza geral, vidros…"></div>
       <div class="clean-areas">${data.areas.map((a) => `<button class="clean-area-btn" data-area="${esc(a)}" onclick="startCleaning(this.dataset.area)">${esc(a)}<small>Iniciar limpeza</small></button>`).join("")}</div>`;
  const othersPanel = others.length
    ? `<section class="panel"><div class="panel-body"><h3 class="section-heading">Em andamento agora</h3>${others.map((t) => `<div class="clean-row"><b>${esc(t.area)}</b><span>${esc(t.user_name)}</span><span>${t.status === "PAUSADA" ? "Pausada" : "Em andamento"}</span>${cleaningTimerHtml(t, fetchedAt)}${canDelete || Number(t.user_id) === Number(currentUser.id) ? `<span class="actions">${cleaningActionButtons(t)}</span>` : ""}</div>`).join("")}</div></section>`
    : "";
  const bars = data.by_area.map((a) => `<div class="clean-bar-row"><div class="clean-bar-label"><b>${esc(a.area)}</b><span>${a.tasks ? `${a.tasks} limpeza(s)` : "sem registros"}</span></div>
      <div class="clean-bar-track"><div class="clean-bar-fill" style="width:${a.tasks ? Math.max(3, (a.avg_seconds / maxAvg) * 100) : 0}%"></div></div>
      <div class="clean-bar-value">${a.tasks ? fmtDurationShort(a.avg_seconds) : "—"}</div></div>`).join("");
  const areaRows = data.by_area.map((a) => `<tr><td><b>${esc(a.area)}</b></td><td>${a.tasks}</td><td>${a.tasks ? fmtDurationShort(a.avg_seconds) : "—"}</td><td>${a.tasks ? fmtDurationShort(a.min_seconds) : "—"}</td><td>${a.tasks ? fmtDurationShort(a.max_seconds) : "—"}</td><td>${a.tasks ? fmtDurationShort(a.total_seconds) : "—"}</td><td>${when(a.last_finished_at)}</td></tr>`).join("");
  const recentRows = data.recent.length
    ? data.recent.map((t) => `<tr><td>${when(t.finished_at)}</td><td><b>${esc(t.area)}</b></td><td>${esc(t.user_name)}</td><td><b>${fmtDurationShort(t.worked_seconds)}</b></td><td>${t.paused_seconds ? fmtDurationShort(t.paused_seconds) : "—"}</td><td>${esc(t.notes || "")}</td>${canDelete ? `<td><button class="secondary" onclick="deleteCleaning(${Number(t.id)})">Excluir</button></td>` : ""}</tr>`).join("")
    : `<tr><td colspan="${canDelete ? 7 : 6}" class="muted">Nenhuma limpeza concluída ainda.</td></tr>`;
  $("mainContent").innerHTML = `
    <section class="panel"><div class="panel-body"><h3 class="section-heading">${mine ? "Minha limpeza" : "Iniciar uma limpeza"}</h3>${startPanel}</div></section>
    ${othersPanel}
    <section class="panel"><div class="panel-body">
      <div class="clean-dash-head"><h3 class="section-heading">Média de tempo por área</h3>
        <select onchange="setCleaningDays(this.value)">${[[7, "Últimos 7 dias"], [30, "Últimos 30 dias"], [90, "Últimos 90 dias"], [0, "Todo o período"]].map(([v, l]) => `<option value="${v}" ${Number(cleaningDays) === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="clean-kpis"><div><span>Limpezas concluídas</span><b>${data.totals.tasks}</b></div><div><span>Tempo total</span><b>${fmtDurationShort(data.totals.total_seconds)}</b></div><div><span>Média geral</span><b>${data.totals.tasks ? fmtDurationShort(data.totals.avg_seconds) : "—"}</b></div></div>
      <div class="clean-bars">${bars}</div>
      <div class="table-wrap"><table class="compact-table"><thead><tr><th>Área</th><th>Limpezas</th><th>Média</th><th>Mais rápida</th><th>Mais demorada</th><th>Tempo total</th><th>Última</th></tr></thead><tbody>${areaRows}</tbody></table></div>
    </div></section>
    <section class="panel"><div class="panel-body"><h3 class="section-heading">Últimas limpezas</h3>
      <div class="table-wrap"><table class="compact-table"><thead><tr><th>Concluída</th><th>Área</th><th>Responsável</th><th>Tempo</th><th>Pausas</th><th>Observação</th>${canDelete ? "<th></th>" : ""}</tr></thead><tbody>${recentRows}</tbody></table></div></div></section>`;
  if (data.active.some((t) => t.status === "EM_ANDAMENTO")) {
    cleaningTick = setInterval(() => {
      document.querySelectorAll("[data-clean-timer]").forEach((el) => {
        if (el.dataset.running !== "1") return;
        el.textContent = fmtSeconds(Number(el.dataset.base) + (Date.now() - Number(el.dataset.fetched)) / 1000);
      });
    }, 1000);
  }
}

async function startCleaning(area) {
  try {
    await api("/api/cleaning/tasks", { method: "POST", body: JSON.stringify({ user_id: currentUser.id, area, notes: $("cleaningNotes")?.value || "" }) });
    toast(`Limpeza de ${area} iniciada.`);
    await renderCleaning();
  } catch (error) { toast(error.message); }
}

async function cleaningAction(id, action) {
  try {
    await api(`/api/cleaning/tasks/${id}/${action}`, { method: "POST", body: JSON.stringify({ user_id: currentUser.id }) });
    toast(action === "finish" ? "Limpeza concluída." : action === "pause" ? "Limpeza pausada." : "Limpeza retomada.");
    await renderCleaning();
  } catch (error) { toast(error.message); }
}

async function deleteCleaning(id) {
  if (!confirm("Excluir este registro de limpeza?")) return;
  try {
    await api(`/api/cleaning/tasks/${id}?user_id=${currentUser.id}`, { method: "DELETE" });
    await renderCleaning();
  } catch (error) { toast(error.message); }
}

async function setCleaningDays(value) {
  cleaningDays = Number(value);
  await renderCleaning();
}

// ---------- Processamento: Cadastro, Triagem e Entrada (Supabase) ----------
function processingTabs(current) { return moduleTabs(PROCESSING_TABS, current); }
function processingStatusLabel(status) {
  return ({PENDENTE:"Pendente",EM_ANDAMENTO:"Em andamento",PAUSADA:"Pausada",CONCLUIDO:"Concluído",CONCLUIDA:"Concluída",CONFIRMADA:"Confirmada"})[status] || status || "—";
}
function processingTimerHtml(record) {
  const n = Math.max(0,Number(record.worked_seconds || 0));
  return '<span class="clean-clock" data-flow-timer data-base="' + n + '" data-fetched="' + Date.now() + '" data-running="' + (record.status === "EM_ANDAMENTO" ? "1" : "0") + '">' + fmtSeconds(n) + '</span>';
}
function startProcessingFlowTicker() {
  clearInterval(processingFlowTick);
  const tick = () => document.querySelectorAll("[data-flow-timer]").forEach(el => {
    if (el.dataset.running === "1") el.textContent = fmtSeconds(Number(el.dataset.base || 0) + (Date.now() - Number(el.dataset.fetched || Date.now())) / 1000);
  });
  tick();
  if (document.querySelector('[data-flow-timer][data-running="1"]')) processingFlowTick = setInterval(tick,1000);
}
async function renderQualityCadastroStatusBadge() {
  const cardId = Number(currentCardId || 0), snapshot = cardData, host = $("cardTab");
  if (!cardId || !snapshot || !host || !(snapshot.receiving_type === "COSTURA" || ["AGUARDANDO_DESPACHO_COSTURA","EM_COSTURA_CD01"].includes(snapshot.status))) return;
  try {
    const tasks = await api("/api/processing/cadastro/card/" + cardId + "?user_id=" + currentUser.id);
    if (Number(currentCardId) !== cardId || !$("cardTab") || document.getElementById("qualityCadastroNotice")) return;
    const notice = document.createElement("div");
    notice.id = "qualityCadastroNotice"; notice.className = "notice";
    notice.innerHTML = tasks.length
      ? "<b>Cadastro para Costura</b><ul>" + tasks.map(t => "<li><b>" + esc(t.reference) + "</b>: " + esc(processingStatusLabel(t.status)) + (t.user_name ? " por " + esc(t.user_name) : "") + "</li>").join("") + "</ul><small>O Cadastro não altera o setor do Card, não duplica Cards e não bloqueia despacho.</small>"
      : "<b>Cadastro para Costura</b><br>Nenhuma tarefa foi registrada para este Card.";
    host.insertBefore(notice,host.firstChild);
  } catch(error) { console.warn("Falha ao consultar Cadastro para Costura:",error); }
}
async function renderProcessingHub() {
  clearInterval(processingFlowTick);
  setPage("Processamento","Os Cards liberados pela Qualidade entram direto na Triagem. Após concluir, escolha se precisam de Etiquetagem.");
  try {
    const [data,cards,cadastroTasks] = await Promise.all([
      api("/api/processing/overview?user_id=" + currentUser.id),
      api("/api/processing/triage/queue?user_id=" + currentUser.id),
      api("/api/processing/cadastro/queue?user_id=" + currentUser.id)
    ]);
    const c=data.counts||{},divergences=data.divergences||[];
    const divergenceRows=divergences.map(d=>'<tr><td><b>'+esc(d.purchase_id||("Card "+d.card_id))+'</b><small>'+esc(d.supplier||"")+'</small></td><td>'+esc(d.sector||"—")+'</td><td><span class="badge orange">'+Number(d.lines||0)+' linha(s)</span></td><td><button class="warning small-btn" onclick="openCard('+Number(d.card_id)+',\'processing\')">Corrigir no Card</button></td></tr>').join("");
    const costuraTasks=(cadastroTasks||[]).filter(t=>(t.card_status==="AGUARDANDO_DESPACHO_COSTURA"||t.card_status==="EM_COSTURA_CD01")&&t.status!=="CONCLUIDO");
    const pending=cards.filter(card=>!card.triage).map(card=>'<tr><td><b>'+esc(refLabel(card))+'</b><small>'+esc(card.supplier||"")+'</small></td><td><span class="badge">Aguardando triagem</span></td><td><button class="primary small-btn" onclick="startProcessingTriage('+card.id+')">Iniciar triagem</button></td></tr>').join("");
    $("mainContent").innerHTML=processingTabs("processing-hub")+
      '<div class="hero-kpis storage-kpis">'+
      heroKpi("Aguardando triagem",cards.filter(card=>!card.triage).length,"Próxima etapa automática","⇢","teal","processing-triage")+
      heroKpi("Triagens em andamento",c.triagens_em_andamento||0,(c.triagens_concluidas||0)+" concluídas","⇄","teal","processing-triage")+
      heroKpi("Cadastro para Costura",costuraTasks.length,"Fluxo independente","▤","teal","processing-register")+
      heroKpi("Entradas pendentes",c.entradas_pendentes||0,"Conferências de Estocagem","⇩","teal","processing-entry")+
      heroKpi("Divergências para corrigir",c.divergencias_persistentes||0,"Após segunda recontagem","!","teal","processing-hub")+
      '</div>'+
      (divergences.length?'<section class="panel processing-queue-panel"><div class="panel-body"><div class="section-heading-row"><div><h3 class="section-heading">Divergências aguardando Processamento</h3><p class="muted">Somente as linhas que continuaram erradas após a segunda contagem aparecem aqui.</p></div></div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Card</th><th>Origem</th><th>Linhas</th><th>Ação</th></tr></thead><tbody>'+divergenceRows+'</tbody></table></div></div></section>':'')+
      '<section class="panel processing-queue-panel"><div class="panel-body"><div class="section-heading-row"><div><h3 class="section-heading">Fila de triagem</h3><p class="muted">Os Cards aparecem aqui automaticamente ao chegar ao Processamento.</p></div><button class="secondary small-btn" onclick="goTo(\'processing-triage\')">Ver todas</button></div>'+
      '<div class="table-wrap"><table class="compact-table"><thead><tr><th>Referência</th><th>Etapa</th><th>Ação</th></tr></thead><tbody>'+(pending||emptyRows(3,"Nenhum Card aguardando início da triagem."))+'</tbody></table></div></div></section>'+
      '<div class="dash-row">'+
      dashboardPanel("▤","Cadastro",'<button class="panel-action" onclick="goTo(\'processing-register\')">Abrir</button>','<p>Cadastro normal após a Triagem e fluxo separado para Costura.</p>')+
      dashboardPanel("⇄","Triagem",'<button class="panel-action" onclick="goTo(\'processing-triage\')">Abrir</button>','<p>Contagem e definição da próxima etapa.</p>')+
      dashboardPanel("⇩","Estocagem",'<button class="panel-action" onclick="goTo(\'processing-entry\')">Abrir</button>','<p>Conferência do que foi efetivamente guardado.</p>')+'</div>';
  } catch(error) {
    $("mainContent").innerHTML=processingTabs("processing-hub")+'<div class="notice error">'+esc(error.message)+'</div>'; toast(error.message);
  }
}
async function setProcessingDestination(cardId,destination) {
  const labels={CADASTRO:"Cadastro",TRIAGEM:"Triagem",ETIQUETAGEM:"Etiquetagem"};
  if(!labels[destination]) { toast("Destinação inválida."); return; }
  try {
    await api("/api/processing/intake/cards/"+cardId+"/destination",{
      method:"POST",body:JSON.stringify({user_id:currentUser.id,destination})
    });
    toast("Card destinado a "+labels[destination]+".");
    await renderProcessingHub();
  } catch(error) { toast(error.message); }
}
async function renderProcessingRegister() {
  clearInterval(processingFlowTick);
  setPage("Cadastro","Inicie e acompanhe o Cadastro por referência. O fluxo normal só aparece após a conclusão da Triagem; o Cadastro para Costura continua independente.");
  try {
    const tasks = await api("/api/processing/cadastro/queue?user_id=" + currentUser.id);
    const costura = tasks.filter(t=>["AGUARDANDO_DESPACHO_COSTURA","EM_COSTURA_CD01"].includes(t.card_status));
    const normal = tasks.filter(t=>!["AGUARDANDO_DESPACHO_COSTURA","EM_COSTURA_CD01"].includes(t.card_status));
    const renderTask = t => {
      const manager = ["admin","supervisor"].includes(currentUser.role);
      const owner = !t.user_id || Number(t.user_id)===Number(currentUser.id) || manager;
      let actions="";
      if(t.status==="PENDENTE") actions='<button class="primary small-btn" onclick="processingCadastroAction('+t.id+',\'start\')">Iniciar cadastro</button>';
      else if(owner&&t.status==="EM_ANDAMENTO") actions='<button class="secondary small-btn" onclick="processingCadastroAction('+t.id+',\'pause\')">Pausar</button><button class="success small-btn" onclick="processingCadastroAction('+t.id+',\'finish\')">Concluir</button>';
      else if(owner&&t.status==="PAUSADA") actions='<button class="primary small-btn" onclick="processingCadastroAction('+t.id+',\'resume\')">Retomar</button><button class="success small-btn" onclick="processingCadastroAction('+t.id+',\'finish\')">Concluir</button>';
      else if(["EM_ANDAMENTO","PAUSADA"].includes(t.status)) actions='<small>Em andamento com '+esc(t.user_name||"outra pessoa")+'</small>';
      else if(t.status==="CONCLUIDO" && Number(t.labels_ready||0)!==1 && t.card_current_sector==="ETIQUETAGEM" && owner) actions='<button class="success small-btn" onclick="processingLabelsReady('+t.id+')">Etiquetas disponíveis para etiquetar</button>';
      else if(t.status==="CONCLUIDO" && Number(t.labels_ready||0)===1) actions='<span class="badge">Etiquetas disponíveis</span>';
      const status=processingStatusLabel(t.status);
      return '<article class="processing-cadastro-card"><div class="processing-cadastro-main"><div class="processing-cadastro-reference">'+esc(t.reference||"Referência não informada")+'</div><div class="processing-cadastro-meta">'+esc(t.supplier||"Fornecedor não informado")+' · '+Number(t.reference_qty||0).toLocaleString("pt-BR")+' peças</div></div><div class="processing-cadastro-state"><span class="badge">'+esc(status)+'</span><small>'+esc(t.card_sector_label||"")+'</small>'+((t.user_name&&t.status!=="PENDENTE")?'<small>Responsável: '+esc(t.user_name)+'</small>':'')+'</div><div class="processing-cadastro-timer">'+(["EM_ANDAMENTO","PAUSADA","CONCLUIDO"].includes(t.status)?processingTimerHtml(t):"")+'</div><div class="processing-cadastro-actions">'+actions+'</div></article>';
    };
    $("mainContent").innerHTML=processingTabs("processing-register")+
      '<section class="panel processing-cadastro-panel"><div class="panel-body"><div class="processing-cadastro-heading"><div><h3 class="section-heading">Cadastro normal</h3><p class="muted">Cada referência fica disponível aqui depois que a Triagem termina.</p></div><span class="processing-cadastro-count">'+normal.length+'</span></div>'+
      (normal.length?'<div class="processing-cadastro-list">'+normal.map(renderTask).join("")+'</div>':'<div class="processing-cadastro-empty"><strong>Nenhum cadastro pendente</strong><span>As referências aparecerão aqui automaticamente após a Triagem.</span></div>')+
      '</div></section>'+
      '<section class="panel processing-cadastro-panel"><div class="panel-body"><div class="processing-cadastro-heading"><div><h3 class="section-heading">Cadastro para Costura</h3><p class="muted">Fluxo separado, iniciado pela opção “Vai para a Costura?” na Qualidade.</p></div><span class="processing-cadastro-count">'+costura.length+'</span></div>'+
      (costura.length?'<div class="processing-cadastro-list">'+costura.map(renderTask).join("")+'</div>':'<div class="processing-cadastro-empty"><strong>Nenhuma tarefa de Costura pendente</strong><span>Quando a Qualidade marcar “Vai para a Costura?”, a tarefa aparecerá aqui.</span></div>')+
      '</div></section>';
    startProcessingFlowTicker();
  } catch(error) {
    $("mainContent").innerHTML=processingTabs("processing-register")+'<div class="notice error">'+esc(error.message)+'</div>';toast(error.message);
  }
}
async function processingCadastroAction(id,action) {
  try {
    await api("/api/processing/cadastro/" + id + "/" + action,{method:"POST",body:JSON.stringify({user_id:currentUser.id})});
    toast(action === "start" ? "Cadastro iniciado." : action === "pause" ? "Cadastro pausado." : action === "resume" ? "Cadastro retomado." : "Cadastro concluído.");
    await renderProcessingRegister();
  } catch(error) { toast(error.message); }
}
async function processingLabelsReady(id) {
  try {
    const result=await api("/api/processing/cadastro/"+id+"/labels-ready",{method:"POST",body:JSON.stringify({user_id:currentUser.id})});
    toast(result.card_ready?"Etiquetas liberadas. Card disponível para Etiquetagem.":"Etiquetas desta referência liberadas.");
    await renderProcessingRegister();
  } catch(error) { toast(error.message); }
}
async function renderProcessingTriage() {
  clearInterval(processingFlowTick); setPage("Processamento · Triagem","Contagem física sem alterar a quantidade original de auditoria.");
  try {
    const cards = await api("/api/processing/triage/queue?user_id=" + currentUser.id);
    const rows = cards.map(c => {
      const t = c.triage, manager = ["admin","supervisor"].includes(currentUser.role);
      let actions = "", status = "Não iniciada", timer = "—";
      if (!t) actions = '<button class="primary small-btn" onclick="startProcessingTriage(' + c.id + ')">Iniciar triagem</button>';
      else {
        status = processingStatusLabel(t.status); timer = processingTimerHtml(t);
        const owner = Number(t.user_id) === Number(currentUser.id) || manager;
        if (["EM_ANDAMENTO","PAUSADA"].includes(t.status) && owner) {
          actions = (t.status === "EM_ANDAMENTO" ? '<button class="secondary small-btn" onclick="processingTriageAction(' + t.id + ',\'pause\')">Pausar</button>' :
            '<button class="primary small-btn" onclick="processingTriageAction(' + t.id + ',\'resume\')">Retomar</button>') +
            '<button class="success small-btn" onclick="openTriageCountModal(' + t.id + ',' + c.id + ',false)">Contar e concluir</button>';
        } else if (["EM_ANDAMENTO","PAUSADA"].includes(t.status)) actions = '<small>Em posse de ' + esc(t.user_name || "outra operadora") + '</small>';
        else {
          actions = '<button class="secondary small-btn" onclick="openTriageCountModal(' + t.id + ',' + c.id + ',true)">Ver contagem</button>';
          if (Number(t.counted_total || 0) !== Number(t.expected_total || 0)) status += " · divergência";
        }
      }
      return '<tr><td><b>' + esc(refLabel(c)) + '</b><small>' + esc(c.purchase_id || ("Card " + c.id)) + '</small></td><td>' + esc(c.supplier || "—") + '</td><td>' +
        '<span class="muted">Conferência cega</span></td><td><span class="badge">' + esc(status) + '</span><small>' + (t ? "Responsável: " + esc(t.user_name) : "Aguardando início") +
        '</small></td><td>' + timer + '</td><td><div class="actions">' + actions + '</div></td></tr>';
    }).join("");
    $("mainContent").innerHTML = processingTabs("processing-triage") + '<section class="panel"><div class="panel-body"><h3 class="section-heading">Cards aguardando triagem</h3>' +
      '<div class="notice"><b>Conferência cega:</b> a quantidade prevista não é exibida durante a Triagem. Se alguma linha divergir, somente ela será indicada para recontagem antes da conclusão.</div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Compra / referência</th><th>Fornecedor</th><th>Conferência</th><th>Status</th><th>Tempo</th><th>Ações</th></tr></thead><tbody>' +
      (rows || emptyRows(6,"Nenhum Card no setor Processamento.")) + '</tbody></table></div></div></section>';
    startProcessingFlowTicker();
  } catch(error) { $("mainContent").innerHTML = processingTabs("processing-triage") + '<div class="notice error">' + esc(error.message) + '</div>'; toast(error.message); }
}
async function startProcessingTriage(id) {
  try { await api("/api/processing/triage/cards/" + id + "/start",{method:"POST",body:JSON.stringify({user_id:currentUser.id})}); toast("Triagem iniciada."); await renderProcessingTriage(); }
  catch(error) { toast(error.message); }
}
async function processingTriageAction(id,action) {
  try { await api("/api/processing/triage/" + id + "/" + action,{method:"POST",body:JSON.stringify({user_id:currentUser.id})}); toast(action==="pause"?"Triagem pausada.":"Triagem retomada."); await renderProcessingTriage(); }
  catch(error) { toast(error.message); }
}
async function openTriageCountModal(id,cardId,readOnly) {
  try {
    const t = await api("/api/processing/triage/" + id + "/details?user_id=" + currentUser.id);
    processingExtraIndex = 0; window.currentTriageItems=t.items||[];
    const saved = new Map((t.counts || []).filter(x=>x.item_id!=null).map(x=>[Number(x.item_id),x]));
    const rows = (t.items || []).map(item => {
      const val = saved.has(Number(item.item_id)) ? Number(saved.get(Number(item.item_id)).counted_qty) : "";
      return '<tr><td><b>' + esc(item.reference || "—") + '</b></td><td>' + esc(item.color || "—") + '</td><td>' + esc(item.size || "—") + '</td><td>' +
        '<span class="muted">Oculto</span></td><td><input class="triage-count-value" type="number" min="0" step="1" data-item-id="' + item.item_id + '" value="' + val + '" placeholder="Contado" ' + (readOnly?"disabled":"required") + '></td></tr>';
    }).join("");
    const extras = (t.counts || []).filter(x=>Number(x.is_extra)===1).map(x => '<tr><td>'+esc(x.reference)+'</td><td>'+esc(x.color)+'</td><td>'+esc(x.size)+'</td><td>'+Number(x.counted_qty||0)+'</td><td>Extra</td></tr>').join("");
    $("modalBody").innerHTML = '<div class="card-title"><div><h2>Contagem da Triagem</h2><div class="card-subtitle">' + esc(t.user_name || "") + ' · ' + fmtSeconds(t.worked_seconds || 0) + ' trabalhados</div></div></div>' +
      '<div class="notice">Zero é válido; campo vazio não.</div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Previsto</th><th>Contado</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (readOnly ? '<h3 class="section-heading">Combinações extras</h3><div class="table-wrap"><table class="compact-table"><tbody>' + extras + '</tbody></table></div>' :
       '<div class="notice">Se aparecer uma combinação que não pertence à grade, não inclua uma linha extra: a grade deve ser corrigida pelo Processamento antes da conclusão.</div><div class="field full"><label for="triageNeedsLabeling">Precisa etiquetar?</label><select id="triageNeedsLabeling" required><option value="">Selecione uma opção</option><option value="1">Sim — encaminhar para Etiquetagem</option><option value="0">Não — encaminhar diretamente para Estocagem</option></select></div><div id="triageAllocationPhase"></div><div class="actions"><button class="success" onclick="finishProcessingTriage(' + id + ')">Concluir triagem e encaminhar</button></div>');
    $("modal").classList.remove("hidden"); window.processingTriageCardId=cardId;
  } catch(error) { toast(error.message); }
}
function addTriageExtraRow() {
  const host=$("triageExtraRows"); if(!host)return; const id=++processingExtraIndex;
  host.insertAdjacentHTML("beforeend",'<tr class="triage-extra-row" data-extra-index="'+id+'"><td><input data-extra-reference placeholder="Referência" required></td><td><input data-extra-color placeholder="Cor" required></td><td><input data-extra-size placeholder="Tamanho" required></td><td><input data-extra-count type="number" min="0" step="1" placeholder="Qtd." required></td><td><button class="ghost small-btn" onclick="this.closest(\'tr\').remove()">Remover</button></td></tr>');
}
async function finishProcessingTriage(id) {
  try {
    const counts=[];
    document.querySelectorAll(".triage-count-value").forEach(input=>{
      if(input.value.trim()===""||!Number.isSafeInteger(Number(input.value))||Number(input.value)<0)throw new Error("Preencha todas as quantidades com inteiros >= 0.");
      counts.push({item_id:Number(input.dataset.itemId),counted_qty:Number(input.value)});
    });
    document.querySelectorAll(".triage-extra-row").forEach(row=>{
      const reference=row.querySelector("[data-extra-reference]").value.trim(),color=row.querySelector("[data-extra-color]").value.trim(),
        size=row.querySelector("[data-extra-size]").value.trim(),value=row.querySelector("[data-extra-count]").value;
      if(!reference||!color||!size||value===""||!Number.isSafeInteger(Number(value))||Number(value)<0)throw new Error("Preencha referência, cor, tamanho e quantidade de cada combinação extra.");
      counts.push({item_id:null,is_extra:1,reference,color,size,counted_qty:Number(value)});
    });
    const labelingValue=$("triageNeedsLabeling")?.value;
    if(labelingValue!=="0"&&labelingValue!=="1")throw new Error("Informe se o Card precisa de Etiquetagem.");
    const result=await api("/api/processing/triage/"+id+"/finish",{method:"POST",body:JSON.stringify({user_id:currentUser.id,counts,needs_labeling:labelingValue==="1"})});
    if(result.requires_recount){
      const divergentIds=new Set((result.divergences||[]).map(x=>Number(x.item_id)));
      document.querySelectorAll(".triage-count-value").forEach(input=>{
        const wrong=divergentIds.has(Number(input.dataset.itemId));
        input.closest("tr")?.classList.toggle("triage-recount-required",wrong);
        input.disabled=!wrong;
        if(wrong){input.value="";input.focus();}
      });
      if($("triageAllocationPhase"))$("triageAllocationPhase").innerHTML="";
      const labels=(result.divergences||[]).map(x=>[x.reference,x.color,x.size].filter(Boolean).join(" · ")).join("; ");
      toast("Recontagem obrigatória: "+(labels||"há divergências na conferência."));
      return;
    }
    if(result.requires_allocation){
      document.querySelectorAll(".triage-count-value").forEach(input=>input.disabled=true);
      document.querySelectorAll(".triage-extra-row input").forEach(input=>input.disabled=true);
      if($("triageNeedsLabeling"))$("triageNeedsLabeling").disabled=true;
      const byId=new Map((window.currentTriageItems||[]).map(i=>[Number(i.item_id),i]));
      const allocItems=counts.filter(x=>x.item_id!=null).map(x=>{
        const src=byId.get(Number(x.item_id))||{};
        return {id:Number(x.item_id),product:src.reference||"",reference:src.reference||"",sku:"",color:src.color||"",size:src.size||"",expected_qty:Number(x.counted_qty),source_stage:"ETIQUETAGEM"};
      });
      const host=$("triageAllocationPhase");
      if(!host)throw new Error("Não foi possível abrir o endereçamento da Triagem.");
      host.innerHTML='<h3 class="section-heading">Endereçamento obrigatório de saída — ET</h3><div class="notice"><b>Contagem validada.</b> Agora enderece toda a mercadoria em ET. O destino é fixo.</div><div id="posAllocBox" class="notice">Carregando posições ET...</div>';
      await loadPositionAllocator(window.processingTriageCardId,"ET",false,0,allocItems,true);
      toast(result.detail||"Contagem validada. Conclua o endereçamento em ET.");
      return;
    }
    closeModal();
    toast("Triagem concluída. Card encaminhado para "+(result.destination==="ETIQUETAGEM"?"Etiquetagem — aguardando etiquetas":"Estocagem")+".");
    await renderProcessingTriage();
  } catch(error) { toast(error.message); }
}
async function renderProcessingEntry() {
  clearInterval(processingFlowTick);setPage("Processamento · Entrada","Confirme o que foi guardado após a conclusão da Estocagem.");
  try {
    const data=await api("/api/processing/entry/queue?user_id="+currentUser.id);
    const pending=(data.pending||[]).map(e=>'<tr><td><b>'+esc(e.purchase_id||("Card "+e.card_id))+'</b></td><td>'+esc(e.supplier||"—")+'</td><td>'+e.items.length+'</td><td>'+fmtDateTime(e.created_at)+'</td><td><button class="primary small-btn" onclick="openEntryConfirmation('+e.id+')">Conferir Entrada</button></td></tr>').join("");
    const recent=(data.recent||[]).map(e=>'<tr><td><b>'+esc(e.purchase_id||("Card "+e.card_id))+'</b></td><td>'+esc(e.concluded_by_name||"—")+'</td><td>'+fmtDateTime(e.concluded_at)+'</td><td><span class="badge">'+esc(processingStatusLabel(e.status))+'</span></td><td>'+(e.has_divergence?'<span class="badge orange">Divergência</span>':"Sem divergência")+'</td><td>'+(e.grade_changed?"Sim":"Não")+'</td></tr>').join("");
    $("mainContent").innerHTML=processingTabs("processing-entry")+'<section class="panel"><div class="panel-body"><h3 class="section-heading">Entradas pendentes</h3><div class="notice">Aqui aparecem somente valores já conferidos e concluídos pela Estocagem. O operador do Processamento confirma a Entrada; o histórico mantém separadamente quem estocou e quem fez a Entrada.</div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Compra / Card</th><th>Fornecedor</th><th>Linhas</th><th>Criada</th><th>Ação</th></tr></thead><tbody>'+(pending||emptyRows(5,"Nenhuma Entrada pendente. A conferência nasce na conclusão da Estocagem."))+'</tbody></table></div></div></section>'+
      '<section class="panel"><div class="panel-body"><h3 class="section-heading">Histórico de Entradas</h3><div class="table-wrap"><table class="compact-table"><thead><tr><th>Compra / Card</th><th>Concluída por</th><th>Data</th><th>Status</th><th>Diferenças</th><th>Grade alterada</th></tr></thead><tbody>'+(recent||emptyRows(6,"Nenhuma Entrada confirmada."))+'</tbody></table></div></div></section>';
  } catch(error) { $("mainContent").innerHTML=processingTabs("processing-entry")+'<div class="notice error">'+esc(error.message)+'</div>';toast(error.message); }
}
async function openEntryConfirmation(id) {
  try {
    const data=await api("/api/processing/entry/queue?user_id="+currentUser.id),entry=(data.pending||[]).find(e=>Number(e.id)===Number(id));
    if(!entry)throw new Error("Entrada não encontrada ou já confirmada.");
    const rows=entry.items.map(item=>'<tr><td><b>'+esc(item.reference||"—")+'</b>'+(item.is_extra?'<small>Combinação extra</small>':"")+'</td><td>'+esc(item.color||"—")+'</td><td>'+esc(item.size||"—")+'</td><td><b>'+Number(item.stored_qty||0).toLocaleString("pt-BR")+'</b></td></tr>').join("");
    $("modalBody").innerHTML='<div class="card-title"><div><h2>Confirmar Entrada da Estocagem</h2><div class="card-subtitle">'+esc(entry.purchase_id||("Card "+entry.card_id))+' · '+esc(entry.supplier||"—")+'</div></div></div><div class="notice"><b>Somente confirmação.</b> As quantidades já foram conferidas na Estocagem. Alterações de grade não são feitas na Entrada.</div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Quantidade conferida</th></tr></thead><tbody>'+rows+'</tbody></table></div><div class="field"><label>Observação geral (opcional)</label><textarea id="entryNotes" rows="2"></textarea></div><div class="actions"><button class="success" onclick="confirmProcessingEntry('+entry.id+')">Dar Entrada e concluir</button></div>';
    $("modal").classList.remove("hidden");
  } catch(error) { toast(error.message); }
}
async function confirmProcessingEntry(id) {
  try {
    await api("/api/processing/entry/"+id+"/confirm",{method:"POST",body:JSON.stringify({user_id:currentUser.id,notes:$("entryNotes")?.value||""})});
    closeModal();toast("Entrada confirmada.");await renderProcessingEntry();
  } catch(error) { toast(error.message); }
}
