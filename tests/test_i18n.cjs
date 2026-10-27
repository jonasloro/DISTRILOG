/* Contract checks for the DISTRILOG bilingual UI and safe catalog fallback. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const i18n = require("../static/i18n.js");

test("Portuguese is the default; Spanish is selected explicitly", () => {
  assert.equal(i18n.getLanguage(), "pt-BR");
  assert.equal(i18n.t("Recebimento"), "Recebimento");
  i18n.setLanguage("es");
  assert.equal(i18n.t("Recebimento"), "Recepción");
  assert.equal(i18n.t("Qualidade"), "Calidad");
  assert.equal(i18n.t("Estocagem"), "Almacenamiento");
  i18n.setLanguage("pt-BR");
  assert.equal(i18n.t("Recebimento"), "Recebimento");
});

test("Dynamic volume counts localize without changing their quantities", () => {
  assert.equal(i18n.t("2 volumes", "es"), "2 volúmenes");
  assert.equal(i18n.t("1 caixas pretas", "es"), "1 cajas negras");
  assert.equal(i18n.t("Inspeção 1", "es"), "Inspección 1");
});

test("WMS addresses, item references, internal status codes and user values are never rewritten", () => {
  for (const code of ["1RM06A", "349.B", "AGUARDANDO_INSPECAO", "SKU-90233", "CD01", "ET01"]) {
    assert.equal(i18n.t(code, "es"), code);
  }
  assert.equal(i18n.t("Marta recebeu sua mensagem", "es"), "Marta recebeu sua mensagem");
});

test("Confirmation dialogs preserve identifiers and translate the operational instruction", () => {
  const movement = i18n.t("Confirmar a movimentação física de 1RM06A para 2QA01B?", "es");
  assert.match(movement, /^¿Confirmar el movimiento físico/);
  assert.match(movement, /1RM06A/);
  assert.match(movement, /2QA01B/);
  const deletion = i18n.t("Excluir definitivamente o Card 349.B?\n\nIsso removerá o card, seus itens, andamento e alocações físicas.", "es");
  assert.match(deletion, /¿Eliminar definitivamente la tarjeta 349\.B\?/);
  assert.match(deletion, /Esto eliminará/);
  assert.match(i18n.t("Concluir definitivamente esta inspeção e movimentar o Card?", "es"), /¿Finalizar/);
});

test("Unrecognized locales fail closed to default Portuguese", () => {
  assert.equal(i18n.normalizeLanguage("fr"), "pt-BR");
  assert.equal(i18n.t("Recebimento", "fr"), "Recebimento");
  i18n.setLanguage("pt-BR");
});

test("Catalog has substantial coverage across operational screens", () => {
  assert.ok(Object.keys(i18n.catalog).length >= 750);
  const expected = ["Criar inspeção", "Concluir Estocagem", "Assumir Card e iniciar",
    "Entrada confirmada.", "Confirme sua senha de administrador", "Idioma preferido"];
  for (const label of expected) assert.notEqual(i18n.t(label, "es"), label, label);
});
