/* Conversa entre colaboradores + Calendário. Usa api(), esc(), toast(), $() e currentUser do app.js */
let chatState = { channel: "geral", lastId: 0, users: [], timer: null };
let calState = { y: new Date().getFullYear(), m: new Date().getMonth(), events: [], sel: null, users: [], editing: null };

const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const KIND_LABEL = { COMPROMISSO: "Compromisso", REUNIAO: "Reunião", PRAZO: "Prazo", LEMBRETE: "Lembrete" };

/* ------------------------------ CHAT ------------------------------ */
async function renderChat() {
  stopChatTimer();
  chatState.generation = (chatState.generation || 0) + 1;
  chatState.polling = false;
  try {
    chatState.users = (await api("/api/users")).filter(u => u.id !== currentUser.id);
  } catch (error) {
    $("mainContent").innerHTML = '<div class="notice error">Não foi possível carregar os participantes das conversas: ' +
      esc(error.message || "Falha de conexão") + '</div><button class="secondary" onclick="renderChat()">Tentar novamente</button>';
    return;
  }
  if (currentView !== "chat") return;
  $("mainContent").innerHTML = `<div class="collab-chat">
    <aside class="collab-side" id="chatSide" aria-label="Canais e conversas"></aside>
    <section class="collab-main"><header id="chatTitle" class="collab-title"></header>
      <div id="chatBox" class="collab-msgs" aria-live="polite"></div>
      <div id="chatLoadError" class="collab-load-error hidden" role="alert"></div>
      <div class="collab-input"><input id="chatInput" maxlength="2000" placeholder="Escreva uma mensagem e tecle Enter" onkeydown="if(event.key==='Enter' && !event.repeat){event.preventDefault();sendChat();}">
      <button id="chatSendButton" class="primary" onclick="sendChat()">Enviar</button></div>
    </section></div>`;
  await openChannel(chatState.channel);
  if (currentView !== "chat") return;
  chatState.timer = setInterval(() => {
    if (currentView !== "chat" || !$("chatBox")) return stopChatTimer();
    pollChat(false);
  }, 4000);
}
function stopChatTimer() {
  if (chatState.timer) clearInterval(chatState.timer);
  chatState.timer = null;
}
function chatChannelTitle(ch) {
  return ch === "geral" ? "Geral — toda a equipe" :
    (chatState.users.find(u => "dm:" + u.id === ch)?.name || "Conversa");
}
async function renderChatSide() {
  if (!$("chatSide")) return;
  let unread = {};
  try {
    unread = await api(`/api/chat/unread?user_id=${currentUser.id}`);
  } catch (error) {
    const warning = $("chatLoadError");
    if (warning && chatState.channel) {
      warning.textContent = "Não foi possível atualizar os avisos de novas mensagens.";
      warning.classList.remove("hidden");
    }
  }
  if (!$("chatSide") || currentView !== "chat") return;
  const dmCount = (uid) => {
    const a = Math.min(uid, currentUser.id), b = Math.max(uid, currentUser.id);
    return Number(unread[`dm:${a}:${b}`] || 0);
  };
  const item = (ch, label, n) =>
    `<button class="collab-contact ${chatState.channel===ch?"active":""}" onclick="openChannel('${ch}')">` +
      `<span>${esc(label)}</span>${n?`<b class="collab-badge">${n}</b>`:""}</button>`;
  $("chatSide").innerHTML = item("geral", "# Geral", Number(unread.geral||0)) +
    '<div class="collab-sep">Conversas diretas</div>' +
    chatState.users.map(u => item("dm:" + u.id, u.name, dmCount(u.id))).join("");
}
async function openChannel(ch) {
  const isGeneral = ch === "geral";
  const recipient = !isGeneral ? Number(String(ch).slice(3)) : null;
  if (!isGeneral && (!Number.isSafeInteger(recipient) || !chatState.users.some(u=>u.id===recipient))) {
    toast("Destinatário da conversa não encontrado.");
    return;
  }
  chatState.channel = ch;
  chatState.lastId = 0;
  chatState.polling = false;
  chatState.generation = (chatState.generation || 0) + 1;
  if (!$("chatBox")) return;
  $("chatTitle").textContent = chatChannelTitle(ch);
  $("chatBox").innerHTML = '<div class="collab-empty">Carregando mensagens…</div>';
  $("chatLoadError")?.classList.add("hidden");
  await pollChat(true);
  if (currentView === "chat" && chatState.channel === ch) {
    await renderChatSide();
    $("chatInput")?.focus();
  }
}
async function pollChat(initial=false) {
  if (!$("chatBox") || chatState.polling || currentView !== "chat") return;
  const channel = chatState.channel;
  const generation = chatState.generation;
  const afterId = chatState.lastId;
  chatState.polling = true;
  try {
    const msgs = await api(`/api/chat/messages?user_id=${currentUser.id}&channel=${encodeURIComponent(channel)}&after_id=${afterId}`);
    if (generation !== chatState.generation || channel !== chatState.channel || !$("chatBox")) return;
    if (!Array.isArray(msgs)) throw new Error("Resposta inválida ao consultar mensagens.");
    const unique = msgs.filter(m => Number(m.id) > chatState.lastId);
    const box = $("chatBox");
    if (unique.length) {
      const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
      box.querySelector(".collab-empty")?.remove();
      box.insertAdjacentHTML("beforeend", unique.map(m =>
        `<div class="collab-msg ${Number(m.sender_id)===Number(currentUser.id)?"mine":""}"><small>${esc(m.sender_name)} · ${fmtDateTime(m.created_at)}</small><div>${esc(m.body)}</div></div>`
      ).join(""));
      chatState.lastId = Math.max(chatState.lastId, ...unique.map(m=>Number(m.id)));
      if (atEnd || initial) box.scrollTop = box.scrollHeight;
      if (!initial) void renderChatSide();
    } else if (initial && !box.querySelector(".collab-msg")) {
      box.innerHTML = '<div class="collab-empty">Nenhuma mensagem ainda. Comece a conversa!</div>';
    }
    $("chatLoadError")?.classList.add("hidden");
  } catch (error) {
    if (generation !== chatState.generation || !$("chatBox")) return;
    const banner = $("chatLoadError");
    if (banner) {
      banner.textContent = "Mensagens indisponíveis: " +
        (error.message || "Falha de conexão") + ". A conversa será atualizada novamente.";
      banner.classList.remove("hidden");
    }
    if (initial) $("chatBox").innerHTML = '<div class="collab-empty">Não foi possível carregar a conversa. A atualização automática tentará novamente.</div>';
  } finally {
    if (generation === chatState.generation) chatState.polling = false;
  }
}
async function sendChat() {
  const input = $("chatInput"), button = $("chatSendButton");
  if (!input || chatState.sending || currentView !== "chat") return;
  const body = input.value.trim();
  if (!body) return;
  chatState.sending = true;
  if (button) button.disabled = true;
  const channel = chatState.channel;
  try {
    await api("/api/chat/messages", {
      method: "POST",
      body: JSON.stringify({user_id:currentUser.id, channel, body})
    });
    if (chatState.channel === channel && $("chatInput") === input) {
      input.value = "";
      $("chatBox")?.querySelector(".collab-empty")?.remove();
      // Se o polling atual estiver pendente, o próximo ciclo trará a mensagem.
      if (!chatState.polling) await pollChat(false);
    }
  } catch (error) {
    toast("Não foi possível enviar: " + (error.message || "Falha na conexão."));
  } finally {
    chatState.sending = false;
    if (button) button.disabled = false;
  }
}
async function refreshChatBadge() {
  if (!currentUser) return;
  try {
    const un = await api(`/api/chat/unread?user_id=${currentUser.id}`);
    const n = Object.values(un).reduce((a,b)=>a+Number(b||0),0);
    const el = $("chatNavBadge");
    if (el) {el.textContent = n;el.style.display=n?"inline-block":"none";}
  } catch (_) {
    // Falhas pontuais não alteram silenciosamente o contador anterior.
  }
}
setInterval(refreshChatBadge, 20000);
setTimeout(refreshChatBadge, 3000);

/* ---------------------------- CALENDÁRIO --------------------------- */
async function renderCalendar() {
  stopChatTimer();
  if (!calState.users.length) calState.users = await api("/api/users");
  const first = new Date(calState.y, calState.m, 1), start = new Date(first); start.setDate(1 - first.getDay());
  const end = new Date(start); end.setDate(start.getDate() + 42);
  calState.events = await api(`/api/calendar/events?user_id=${currentUser.id}&start=${ymd(start)}T00:00&end=${ymd(end)}T00:00`);
  const todayStr = ymd(new Date()), monthName = first.toLocaleDateString(DISTRILOG_I18N.getLanguage(), { month: "long", year: "numeric" });
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i); const ds = ymd(d);
    const evs = calState.events.filter((e) => e.start_at.slice(0, 10) <= ds && e.end_at.slice(0, 10) >= ds);
    cells.push(`<button class="collab-day ${d.getMonth() !== calState.m ? "other" : ""} ${ds === todayStr ? "today" : ""} ${calState.sel === ds ? "sel" : ""}" onclick="selectCalDay('${ds}')"><span>${d.getDate()}</span>${evs.slice(0, 3).map((e) => `<i class="collab-chip k-${e.kind}">${e.all_day ? "" : e.start_at.slice(11, 16) + " "}${esc(e.title)}</i>`).join("")}${evs.length > 3 ? `<em>+${evs.length - 3}</em>` : ""}</button>`);
  }
  $("mainContent").innerHTML = `<div class="collab-cal"><header class="collab-calhead"><button onclick="calNav(-1)">‹</button><h2>${esc(monthName)}</h2><button onclick="calNav(1)">›</button><button onclick="calNav(0)">Hoje</button><button class="primary" onclick="calForm(null,'${calState.sel || todayStr}')">+ Novo compromisso</button></header>
    <div class="collab-grid">${["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"].map((w) => `<div class="collab-wd">${w}</div>`).join("")}${cells.join("")}</div>
    <div id="calPanel" class="collab-panel"></div></div>`;
  if (calState.sel) renderCalDay();
}
function calNav(dir) {
  if (dir === 0) { const t = new Date(); calState.y = t.getFullYear(); calState.m = t.getMonth(); calState.sel = ymd(t); }
  else { calState.m += dir; if (calState.m < 0) { calState.m = 11; calState.y--; } if (calState.m > 11) { calState.m = 0; calState.y++; } }
  renderCalendar();
}
function selectCalDay(ds) { calState.sel = ds; calState.editing = null; renderCalendar(); }
function renderCalDay() {
  const ds = calState.sel, evs = calState.events.filter((e) => e.start_at.slice(0, 10) <= ds && e.end_at.slice(0, 10) >= ds);
  const label = new Date(ds + "T12:00").toLocaleDateString(DISTRILOG_I18N.getLanguage(), { weekday: "long", day: "numeric", month: "long" });
  const who = (e) => (e.attendee_ids.length ? e.attendee_ids.map((id) => calState.users.find((u) => u.id === id)?.name || "?").join(", ") : "Toda a equipe");
  $("calPanel").innerHTML = `<h3>${esc(label)}</h3>` + (evs.length ? evs.map((e) => `<div class="collab-event k-${e.kind}"><div><b>${esc(e.title)}</b> <small>${KIND_LABEL[e.kind]} · ${e.all_day ? "dia inteiro" : e.start_at.slice(11, 16) + "–" + e.end_at.slice(11, 16)}</small><br><small>Criado por ${esc(e.created_by_name)} · Participantes: ${esc(who(e))}</small>${e.description ? `<p>${esc(e.description)}</p>` : ""}</div>${e.created_by === currentUser.id || currentUser.role === "admin" ? `<div class="actions"><button onclick="calForm(${e.id},'${ds}')">Editar</button><button onclick="calDelete(${e.id})">Excluir</button></div>` : ""}</div>`).join("") : '<div class="collab-empty">Nada marcado para este dia.</div>') + '<div id="calFormBox"></div>';
}
function calForm(id, ds) {
  if (!calState.sel) { calState.sel = ds; }
  const e = id ? calState.events.find((x) => x.id === id) : null;
  const doForm = () => {
    if (!$("calFormBox")) { renderCalendar().then(doForm); return; }
    const att = e ? e.attendee_ids : [];
    $("calFormBox").innerHTML = `<div class="collab-form"><h4>${e ? "Editar" : "Novo"} compromisso</h4>
      <div class="form-grid"><div class="field"><label>Título</label><input id="evTitle" maxlength="120" value="${esc(e?.title || "")}"></div>
      <div class="field"><label>Tipo</label><select id="evKind">${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}" ${e?.kind === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      <div class="field"><label>Início</label><input id="evStart" type="datetime-local" value="${e ? e.start_at.slice(0, 16) : ds + "T09:00"}"></div>
      <div class="field"><label>Fim</label><input id="evEnd" type="datetime-local" value="${e ? e.end_at.slice(0, 16) : ds + "T10:00"}"></div>
      <div class="field"><label>Participantes (vazio = toda a equipe)</label><select id="evAtt" multiple size="5">${calState.users.filter((u) => u.id !== currentUser.id).map((u) => `<option value="${u.id}" ${att.includes(u.id) ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></div>
      <div class="field"><label>Descrição</label><textarea id="evDesc" rows="4" maxlength="1000">${esc(e?.description || "")}</textarea></div></div>
      <label class="collab-check"><input id="evAll" type="checkbox" ${e?.all_day ? "checked" : ""}> Dia inteiro</label>
      <div class="actions"><button class="primary" onclick="calSave(${id || "null"})">Salvar</button><button onclick="renderCalDay()">Cancelar</button></div></div>`;
  };
  doForm();
}
async function calSave(id) {
  const all = $("evAll").checked, day = (v) => v.slice(0, 10);
  const body = { user_id: currentUser.id, user_name: currentUser.name, title: $("evTitle").value, kind: $("evKind").value, description: $("evDesc").value, all_day: all,
    start_at: all ? day($("evStart").value) + "T00:00" : $("evStart").value, end_at: all ? day($("evEnd").value || $("evStart").value) + "T23:59" : $("evEnd").value,
    attendee_ids: [...$("evAtt").selectedOptions].map((o) => Number(o.value)) };
  try {
    await api(id ? `/api/calendar/events/${id}` : "/api/calendar/events", { method: id ? "PATCH" : "POST", body: JSON.stringify(body) });
    toast("Compromisso salvo."); calState.sel = body.start_at.slice(0, 10); renderCalendar();
  } catch (e) { toast(e.message); }
}
async function calDelete(id) {
  if (!DISTRILOG_I18N.confirm("Excluir este compromisso?")) return;
  try { await api(`/api/calendar/events/${id}?user_id=${currentUser.id}`, { method: "DELETE" }); toast("Compromisso excluído."); renderCalendar(); } catch (e) { toast(e.message); }
}
