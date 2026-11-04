/* Contrato da emissão de Rack nos dois aplicativos, sem impressora física. */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../app/src/main');
const java=fs.readFileSync(path.join(root,'java/com/distribox/distrilogmobile/prototype/RackPrinter.java'),'utf8');
const bridge=fs.readFileSync(path.join(root,'java/com/distribox/distrilogmobile/prototype/BackendBridge.java'),'utf8');
const script=fs.readFileSync(path.join(root,'assets/mobile/app.js'),'utf8');
const client=fs.readFileSync(path.join(root,'assets/mobile/native-client.js'),'utf8');

test('Racks are printed by official Android PrintManager from authenticated backend PDF',()=>{
  assert.match(java,/\/api\/racks\/cards\//);
  assert.match(java,/\.pdf\?copies=1/);
  assert.match(java,/PrintManager/);
  assert.match(java,/RackPdfAdapter/);
  assert.match(java,/PrintDocumentAdapter/);
  assert.match(java,/RACK_100X85/);
  assert.match(java,/\.header\("Cookie", cookies\)/);
  assert.match(java,/application\/pdf/);
  assert.match(java,/MAX_PDF_BYTES/);
  assert.match(java,/response\.isSuccessful\(\)/);
  assert.doesNotMatch(java,/https?:\/\//);
  assert.doesNotMatch(java,/getExternalStorageDirectory|getExternalFilesDir/);
});
test('webview can pass only numeric card ID, without arbitrary paths or print payloads',()=>{
  assert.match(bridge,/@JavascriptInterface public void printRack\(int cardId\)/);
  assert.match(bridge,/rackPrinter\.print\(cardId, endpoint\)/);
  assert.match(client,/printRack: function \(cardId\)/);
  assert.doesNotMatch(bridge,/printRack\(String/);
  assert.match(bridge,/rackPrinter\.close/);
});
test('print action appears in receiving queue and within card, while transit is blocked',()=>{
  assert.match(script,/Imprimir Rack/);
  assert.match(script,/!c\.in_transit/);
  assert.match(script,/data-action/);
  assert.match(script,/API\.printRack\(id\)/);
  assert.match(script,/DM_RACK_PRINT_EVENT/);
});
