/* DISTRILOG Mobile installer security and interactive update UI contracts. */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const base=path.resolve(__dirname,'..');
const java=fs.readFileSync(path.join(base,'app/src/main/java/com/distribox/distrilogmobile/prototype/NativeUpdater.java'),'utf8');
const bridge=fs.readFileSync(path.join(base,'app/src/main/java/com/distribox/distrilogmobile/prototype/BackendBridge.java'),'utf8');
const manifest=fs.readFileSync(path.join(base,'app/src/main/AndroidManifest.xml'),'utf8');
const xml=fs.readFileSync(path.join(base,'app/src/main/res/xml/updater_paths.xml'),'utf8');
const ui=fs.readFileSync(path.join(base,'app/src/main/assets/mobile/app.js'),'utf8');
const client=fs.readFileSync(path.join(base,'app/src/main/assets/mobile/native-client.js'),'utf8');
const workflow=fs.readFileSync(path.join(base,'../.github/workflows/mobile-prototype-apk.yml'),'utf8');

test('Update path is limited to the official DISTRILOG GitHub Releases repo',()=>{
  assert.match(java,/https:\/\/api\.github\.com\/repos\/jonasloro\/DISTRILOG\/releases/);
  assert.match(java,/https:\/\/github\.com\/jonasloro\/DISTRILOG\/releases\/download\//);
  assert.match(java,/Pattern\.compile\("\^mobile-prototipo-/);
  assert.match(java,/checksumAvailable/);
  assert.match(java,/expectedSha256/);
  assert.match(java,/SHA-256/);
  assert.match(java,/MAX_APK_BYTES/);
  assert.match(java,/checkTrustedDownloadUrl/);
  assert.doesNotMatch(bridge,/checkUpdates\(String/);
  assert.doesNotMatch(bridge,/downloadUpdate\(String/);
});
test('Check update, download, install are separate explicit actions',()=>{
  assert.match(java,/void check\(\)/);
  assert.match(java,/void download\(\)/);
  assert.match(java,/void install\(\)/);
  assert.match(bridge,/DISTRILOG/);
  assert.match(bridge,/@JavascriptInterface public void checkUpdates/);
  assert.match(client,/checkUpdates: function/);
  assert.match(client,/downloadUpdate: function/);
  assert.match(client,/installUpdate: function/);
  assert.match(ui,/function updatesView\(\)/);
  assert.match(ui,/s\.screen==='updates'/);
  assert.match(ui,/Verificar atualiza/);
  assert.match(ui,/Baixar atualização/);
  assert.match(ui,/Instalar atualização/);
});
test('Native APK update verifies identity, greater code and certificate before install',()=>{
  assert.match(java,/getPackageArchiveInfo/);
  assert.match(java,/activity\.getPackageName\(\)\.equals\(candidate\.packageName\)/);
  assert.match(java,/code\(candidate\) <= installedCode\(\)/);
  assert.match(java,/GET_SIGNING_CERTIFICATES/);
  assert.match(java,/Arrays\.equals\(trusted\[0\]\.toByteArray\(\), offered\[0\]\.toByteArray\(\)\)/);
  assert.match(java,/verifyArchive\(temp\)/);
  assert.match(java,/verifyArchive\(file\)/);
  assert.match(java,/ACTION_MANAGE_UNKNOWN_APP_SOURCES/);
  assert.match(java,/FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(java,/FileProvider\.getUriForFile/);
});
test('No silent installation or shared downloads directory',()=>{
  assert.match(manifest,/REQUEST_INSTALL_PACKAGES/);
  assert.match(manifest,/android:exported="false"/);
  assert.match(manifest,/android:name="androidx\.core\.content\.FileProvider"/);
  assert.match(xml,/<cache-path/);
  assert.doesNotMatch(java,/ACTION_REQUEST_INSTALL_PACKAGES|INSTALL_PACKAGES/);
  assert.doesNotMatch(java,/getExternalStorageDirectory|Environment\.DIRECTORY_DOWNLOADS/);
  assert.doesNotMatch(java,/PackageInstaller\.Session/);
});
test('Future official releases are protected by long-lived GitHub Secrets signing',()=>{
  assert.match(workflow,/secrets\.MOBILE_SIGNING_KEYSTORE_B64/);
  assert.match(workflow,/secrets\.MOBILE_SIGNING_STORE_PASSWORD/);
  assert.match(workflow,/SIGNED_RELEASE=true/);
  assert.match(workflow,/mobile-prototipo-1\.5\.0/);
  assert.match(workflow,/mobile-piloto-1\.5\.0/);
  assert.match(workflow,/sha256sum/);
  assert.match(workflow,/gh release upload/);
  assert.doesNotMatch(workflow,/BEGIN PRIVATE KEY/);
});
