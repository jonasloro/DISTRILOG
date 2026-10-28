const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname,'../app/src/main/assets/mobile');
const main = fs.readFileSync(path.join(root,'app.js'),'utf8');
const client = fs.readFileSync(path.join(root,'native-client.js'),'utf8');
const html = fs.readFileSync(path.join(root,'index.html'),'utf8');
const native = fs.readFileSync(path.resolve(__dirname,'../app/src/main/java/com/distribox/distrilogmobile/prototype/BackendBridge.java'),'utf8');
test('APK bundles the mobile prototype design rather than the website',()=>{
  assert.match(html,/prototype\.css/);
  assert.match(html,/mobile\.css/);
  assert.match(html,/app\.js/);
  assert.doesNotMatch(html,/https:\/\/.*onrender\.com/);
  assert.match(main,/mobile-first UI based on the user's sector prototype/);
  assert.doesNotMatch(main,/function fixtures\(/);
  assert.doesNotMatch(main,/distrilog_mobile_lab_v5/);
});
test('real backend routes used by the phone',()=>{
  for(const segment of [
   '/api/login','/api/cards?scope=','/api/cards/','/api/receivings/',
   '/api/positions','/api/quality/','/api/processing/triage/',
   '/api/downstream/','/api/processing/entry/','/api/history'
  ])assert.ok(main.includes(segment),segment);
});
test('backend session and role rules remain the single authority',()=>{
  assert.match(native,/CookieManager\.getInstance\(\)/);
  assert.match(native,/\.header\("Cookie", cookies\)/);
  assert.match(native,/validApiPath/);
  assert.match(native,/https/);
  assert.match(main,/requireSector\(expected\)/);
  assert.match(main,/confirmReal\(/);
  assert.match(main,/DISTRILOG Web/);
});
test('no offline writes, false success or demo cards in production app',()=>{
  assert.doesNotMatch(main,/fakeData|offlineQueue|mockCard|fixtures\(/i);
  assert.match(client,/pending\[result\.id\]/);
  assert.match(main,/Operação confirmada e sincronizada/);
});
test('camera scan identifies without automatically changing warehouse stock',()=>{
  assert.match(main,/window\.DM_SCAN_RETURN/);
  assert.match(main,/nenhuma movimentação é executada automaticamente/);
  assert.match(native,/com\.journeyapps\.zxing/);
});
