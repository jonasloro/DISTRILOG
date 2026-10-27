/* Exact history regression against the previously supplied
   QUADRO BACKLOG + PRODUZIDO.xlsx workbook. No external dependencies. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const staticFile = name =>
  fs.readFileSync(path.join(__dirname, '..', 'static', name), 'utf8');

const historyCode = staticFile('mission_history_2026.js');
const appCode = staticFile('mission.js');
const history = vm.runInNewContext(
  historyCode + ';JSON.parse(JSON.stringify(MISSAO_HISTORICO_2026))',
  {JSON}
);

test('29 distinct weeks May through October 2026 are included', () => {
  assert.equal(history.length, 29);
  assert.equal(new Set(history.map(r => r[0] + '-' + r[1])).size, 29);
  for (const [month, expected] of [[5,5],[6,5],[7,5],[8,5],[9,5],[10,4]]) {
    assert.equal(history.filter(r => r[0] === month).length, expected);
  }
  assert.equal(history.filter(r => r[2] === '28/09 a 02/10').length, 1);
});

test('historical numbers and missing values match the workbook', () => {
  const expected = [
    [5, 29953, 257598, 39],
    [6, 27815, 314698, 23],
    [7, 6951, 216102, 11],
    [8, 27872, 240484, 11],
    [9, 11792, 255452, 10],
    [10, 31254, 169462, 17],
  ];
  for (const [month, backlog, produced, missing] of expected) {
    const rows = history.filter(r => r[0] === month);
    assert.equal(rows.at(-1)[3].filter(x => x != null).reduce((s,n) => s+n, 0), backlog);
    assert.equal(rows.flatMap(r => r[4]).filter(x => x != null).reduce((s,n) => s+n, 0), produced);
    assert.equal(rows.flatMap(r => [...r[3], ...r[4]]).filter(x => x === null).length, missing);
    for (const row of rows) {
      assert.equal(row[3].length, 9);
      assert.equal(row[4].length, 9);
      assert.ok([...row[3],...row[4]].every(v => v === null || (Number.isInteger(v) && v >= 0)));
    }
  }
  const octoberLast = history.at(-1);
  assert.ok(octoberLast[4].every(v => v === null), 'October week 4 produced has not been reported');
});

test('monthly dashboard builds the complete backlog matrix, not just bars', () => {
  for (const month of [5, 9, 10]) {
    const elements = {
      missionBody: {innerHTML:''},
      missionHistoryTab: {className:'secondary'},
      missionLiveTab: {className:'primary'},
    };
    const esc = value => String(value == null ? '' : value)
      .replace(/[&<>"]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s]));
    const sandbox = {
      console, JSON, Number, Math,
      esc,
      $: id => elements[id] || null,
      setPage: () => {},
    };
    vm.runInNewContext(
      historyCode + '\n' + appCode +
      '\nmissionSelectedMonth=' + month + ';showMissionHistorical();',
      sandbox,
    );
    assert.match(elements.missionBody.innerHTML, /QUADRO DO BACKLOG/);
    assert.match(elements.missionBody.innerHTML, /RECEBIMENTO/);
    assert.match(elements.missionBody.innerHTML, /EXPEDIÇÃO PCP/);
    assert.match(elements.missionBody.innerHTML, /SEMANA 1/);
    assert.match(elements.missionBody.innerHTML, /MISS/i); // headline/mission metadata
    assert.match(elements.missionBody.innerHTML, /SOMA INFORMADA/);
    assert.equal(elements.missionHistoryTab.className, 'primary');
  }
});
