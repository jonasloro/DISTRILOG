/* A única fonte da etiqueta Rack é a API autenticada do DISTRILOG.
 * A etiqueta 100x85 mm abre no visualizador do navegador, pronto para impressão.
 * Gerar a etiqueta não é confirmação física de impressão.
 */
function printRack(cardId, copies = 1) {
  const id = Number(cardId);
  if (!Number.isSafeInteger(id) || id < 1 || ![1, 2].includes(copies)) {
    toast("Card ou quantidade de etiquetas inválidos.");
    return;
  }
  const href = "/api/racks/cards/" + id + ".pdf?copies=" + copies;
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", "Abrir etiquetas Rack do Card " + id + " em PDF");
  document.body.appendChild(link);
  link.click();
  link.remove();
}
