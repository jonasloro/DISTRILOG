import './style.css';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {SECTORS,positionKey,validPosition,unitsForSector,filterPositions,parseBindings,positionStats,isSketchup,isGLB,requireOfflineConversion,mayPublishModel} from './core.js';

const $ = (id) => document.getElementById(id);
const canvas = $('threeCanvas');
const viewport = $('viewport');
const state = {positions:[],selected:null,sector:'TODOS',query:'',searchMatches:null,anchors:{},modelName:null,modelHash:null,published:null,canManage:false,modelStatusError:null,focusAddresses:null,loadedModel:null,glbBytes:null,bind:false,lastRefresh:null,loaded:false};
let inventoryAbort=null, searchAbort=null, modelWorker=null, loading=false, toastTimeout=0, lastPointer=null;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#14241c');
scene.fog = new THREE.FogExp2('#14241c', 0.003);
const camera = new THREE.PerspectiveCamera(45,1,0.01,50000);
camera.position.set(28,34,38);
const renderer = new THREE.WebGLRenderer({canvas, antialias:true,alpha:false,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.5));
renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure=1.6;
const controls=new OrbitControls(camera,renderer.domElement);
controls.enableDamping=true;controls.dampingFactor=.09;
controls.maxPolarAngle=Math.PI*.94;
controls.minDistance=.2;controls.maxDistance=40000;
scene.add(new THREE.HemisphereLight('#f5fff0','#304538',3.2));
const sun=new THREE.DirectionalLight('#ffe9c7',2.5);sun.position.set(40,80,20);scene.add(sun);
const grid=new THREE.GridHelper(200,50,'#355743','#244334');grid.position.y=-.03;scene.add(grid);
const markers=new THREE.Group();markers.name='WMS_MARKERS';scene.add(markers);
let modelRoot=null;
const raycaster=new THREE.Raycaster();
const pointer=new THREE.Vector2();
let rendererRunning=true;
function resize(){const w=viewport.clientWidth,h=viewport.clientHeight;if(w&&h){camera.aspect=w/h;camera.updateProjectionMatrix();renderer.setSize(w,h,false)}}
const ro=new ResizeObserver(resize);ro.observe(viewport);resize();
function animate(){if(!rendererRunning)return;requestAnimationFrame(animate);controls.update();renderer.render(scene,camera)}animate();
function toast(message,error=false){let n=document.querySelector('.toast');if(!n){n=document.createElement('div');n.className='toast';document.body.append(n)}n.className='toast'+(error?' error':'');n.textContent=message;n.classList.remove('hidden');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>n.classList.add('hidden'),5500)}
function progress(txt){$('viewStatus').textContent=txt;$('modelSubtitle').textContent=txt}
function apiUrl(path){return path;}
async function getJson(path,signal){const r=await fetch(apiUrl(path),{credentials:'same-origin',headers:{'Accept':'application/json'},signal,cache:'no-store'});if(r.status===401){throw new Error('Sessão expirada. Faça login no DISTRILOG e reabra o Stock 3D.')}if(!r.ok){let message=`Falha ${r.status}`;try{const data=await r.json();if(data.detail)message=typeof data.detail==='string'?data.detail:message}catch{}throw new Error(message)}return await r.json()}
function localKey(){return 'distrilog.stock3d.anchors.'+(state.modelName||'unloaded')}
function saveAnchorsLocal(){if(!state.modelName)return;try{localStorage.setItem(localKey(),JSON.stringify({schema:'distrilog-stock3d-anchors-v1',model:state.modelName,anchors:state.anchors}))}catch{toast('Não foi possível salvar localmente. Exporte o mapa de vínculos.',true)}}
function isSharedModel(){return Boolean(state.published?.available&&state.modelHash===state.published.sha256)}
async function loadAnchors(){
  if(isSharedModel()){
    try{
      const result=await getJson('/api/stock3d/anchors');
      if(result.model_sha256!==state.modelHash)throw new Error('O modelo foi atualizado. Atualize a página.');
      state.anchors=parseBindings({schema:'distrilog-stock3d-anchors-v1',model:state.modelName,anchors:result.anchors||{}}).anchors;
    }catch(e){state.anchors={};toast('Falha ao consultar os vínculos do CD: '+e.message,true)}
  }else{
    try{const data=JSON.parse(localStorage.getItem(localKey())||'null');state.anchors=data&&data.model===state.modelName?parseBindings(data).anchors:{}}catch{state.anchors={}}
  }
  syncMarkers();
}
async function saveSharedAnchor(address, point, remove=false){
  if(!isSharedModel()){saveAnchorsLocal();return}
  if(!state.canManage)throw new Error('Apenas administradores podem calibrar endereços do Stock 3D.');
  const path='/api/stock3d/anchors/'+encodeURIComponent(address);
  const opts=remove
    ? {method:'DELETE',credentials:'same-origin'}
    : {method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({model_sha256:state.modelHash,point})};
  const url=remove?path+'?model_sha256='+encodeURIComponent(state.modelHash):path;
  const response=await fetch(url,opts);
  if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.detail||'Não foi possível salvar o vínculo 3D.')}
}
function updateModelControls(){
  const button=$('publishModelButton'), label=$('publishedInfo');
  button.classList.toggle('hidden',!state.canManage);
  button.disabled=!mayPublishModel({
    canManage:state.canManage, hasModel:Boolean(state.glbBytes),
    loading, alreadyPublished:isSharedModel()
  });
  if(state.modelStatusError){
    label.textContent='Não foi possível confirmar o status do modelo no servidor: '+state.modelStatusError;
  }else if(state.published?.available){
    label.textContent='Modelo compartilhado: '+state.published.filename+' · salvo no Supabase. '+(isSharedModel()?'Este é o modelo oficial.':'O modelo local ainda não é o oficial.');
  }else if(!state.canManage){
    label.textContent='Somente administradores podem publicar o modelo do CD. Entre com um perfil administrador.';
  }else if(loading){
    label.textContent='Carregando o arquivo 3D. A publicação será habilitada ao concluir a importação.';
  }else if(state.glbBytes){
    label.textContent='Modelo importado. Clique em "Salvar modelo no Supabase" para disponibilizá-lo a toda a equipe.';
  }else{
    label.textContent='Nenhum modelo oficial publicado. Importe um arquivo GLB para habilitar o salvamento.';
  }
}
async function loadPublishedModel(){
  try{
    const meta=await getJson('/api/stock3d/model');
    state.modelStatusError=null;
    state.published=meta;
    state.canManage=Boolean(meta.can_manage);
    updateModelControls();
    if(!meta.available){progress('Modelo oficial ainda não publicado. A gestão pode enviá-lo uma única vez.');return}
    progress('Carregando modelo oficial do Supabase...');
    const response=await fetch('/api/stock3d/model/glb?v='+encodeURIComponent(meta.sha256),{credentials:'same-origin'});
    if(!response.ok)throw new Error('Falha ao baixar modelo oficial (HTTP '+response.status+').');
    const buffer=await response.arrayBuffer();
    await displayGLB(buffer,meta.filename,meta.sha256);
    toast('Modelo oficial carregado automaticamente.');
  }catch(e){state.modelStatusError=e.message;progress('Não foi possível carregar o modelo oficial.');toast(e.message,true)}
  finally{updateModelControls()}
}
async function publishModel(){
  if(!state.canManage||!state.glbBytes||loading)return;
  const button=$('publishModelButton');
  button.disabled=true;
  try{
    progress('Publicando modelo privado para a equipe...');
    const data=new FormData();
    const name=state.loadedModel.replace(/\.(?:skp|skb|glb)$/i,'')+'.glb';
    data.append('file',new Blob([state.glbBytes],{type:'model/gltf-binary'}),name);
    const response=await fetch('/api/stock3d/model',{method:'POST',body:data,credentials:'same-origin'});
    if(!response.ok){const err=await response.json().catch(()=>({}));throw new Error(err.detail||'O Supabase não confirmou o modelo.')}
    const meta=await getJson('/api/stock3d/model');
    state.published=meta;
    const existingAnchors={...state.anchors};
    if(Object.keys(existingAnchors).length){
      const migrated=await fetch('/api/stock3d/anchors/import',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({model_sha256:state.modelHash,anchors:existingAnchors})});
      if(!migrated.ok){const err=await migrated.json().catch(()=>({}));toast('O modelo foi salvo, mas a calibração não: '+(err.detail||'verifique os endereços'),true);}
    }
    await loadAnchors();
    toast('Modelo compartilhado salvo! A equipe já poderá abri-lo automaticamente.');
    progress('Modelo oficial disponível para a equipe.');
  }catch(e){toast('Não foi possível publicar: '+e.message,true);progress('Publicação não concluída.')}
  finally{updateModelControls()}
}
function updateMetrics(){const n=positionStats(state.positions,state.anchors);$('countAll').textContent=n.total||'—';$('countBusy').textContent=n.busy||'0';$('countMapped').textContent=n.mapped;$('lastUpdate').textContent=state.lastRefresh?state.lastRefresh.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}):'—';}
function escapeText(x){return String(x??'')}
function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=escapeText(text);return node}
function drawList(){const matches=filterPositions(state.positions,state.sector,state.query,state.searchMatches).filter(p=>!state.focusAddresses||state.focusAddresses.has(p.address));const host=$('positionList');host.replaceChildren();$('positionCount').textContent=`${matches.length} posições`;if(!matches.length){host.append(el('div','empty-list',state.loaded?'Nenhuma posição corresponde ao filtro.':'Sem dados. Entre no DISTRILOG e atualize.'));return}
  const max=140;
  for(const pos of matches.slice(0,max)){
    const row=el('button','position'+(state.selected===pos.address?' selected':''));row.type='button';
    const dot=el('span','p-dot '+(state.anchors[pos.address]?(Number(pos.ocupado)>0?'busy':'free'):'unmapped'));
    const body=el('div','position-main');body.append(el('div','position-name',pos.address));body.append(el('div','position-sub',`${pos.zona_label||pos.zona||pos.setor} · ${state.anchors[pos.address]?'mapeada no modelo':'não vinculada ao modelo'}`));
    const quantity=el('span','position-count',`${pos.ocupado} ${pos.setor==='ET'||pos.setor==='EC'?'cx':'vol.'}`);
    row.append(dot,body,quantity);row.addEventListener('click',()=>selectPosition(pos.address));host.append(row);
  }
  if(matches.length>max)host.append(el('div','empty-list',`Exibindo ${max} de ${matches.length}. Refine a pesquisa para encontrar outras posições.`));
}
async function refreshPositions(){ $('syncStatus').textContent='Atualizando WMS...'; const results=await Promise.allSettled(SECTORS.map(async setor=>{
  const data=await getJson(`/api/positions?setor=${encodeURIComponent(setor)}`);
  if(!Array.isArray(data))throw new Error(`Formato inválido do setor ${setor}`);
  return data.filter(validPosition);
}));
  const success=results.filter(r=>r.status==='fulfilled');
  if(!success.length){state.loaded=false;state.positions=[];$('syncStatus').textContent='WMS indisponível';$('positionCount').textContent='Sem conexão';drawList();updateMetrics();toast(results.find(r=>r.status==='rejected')?.reason?.message||'Não foi possível consultar o WMS.',true);return}
  state.positions=success.flatMap(r=>r.value).sort((a,b)=>a.address.localeCompare(b.address,'pt-BR',{numeric:true}));state.loaded=true;state.lastRefresh=new Date();
  $('syncStatus').textContent=success.length===SECTORS.length?'WMS sincronizado':`WMS parcial (${success.length}/${SECTORS.length})`;
  if(success.length!==SECTORS.length)toast('Alguns setores não responderam; os totais são parciais.',true);
  drawList();updateMetrics();syncMarkers();
  if(state.selected&&!state.positions.some(p=>p.address===state.selected))clearSelection();
}
function clearSelection(){state.selected=null;$('inspectTitle').textContent='Selecione um endereço';$('inspectCaption').textContent='Posições reais do WMS.';$('inspectBody').replaceChildren(el('div','empty-details','Selecione uma posição à esquerda.'));$('bindButton').disabled=true;$('removeBindButton').disabled=true;}
async function selectPosition(address){const pos=state.positions.find(p=>p.address===address);if(!pos)return;state.selected=address;state.bind=false;updateBindButtons();drawList();syncMarkers();$('inspectTitle').textContent=address;$('inspectCaption').textContent=`${pos.setor} · ${pos.ocupado} ${unitsForSector(pos.setor)} nesta posição`;
  const content=$('inspectBody');content.replaceChildren(el('div','empty-details','Consultando conteúdo físico no WMS...'));
  if(state.anchors[address])focusPoint(new THREE.Vector3(...state.anchors[address]));
  inventoryAbort?.abort();inventoryAbort=new AbortController();
  try{const inventory=await getJson(`/api/positions/${encodeURIComponent(address)}/inventory`,inventoryAbort.signal);if(state.selected===address)renderInventory(inventory)}catch(e){if(e.name!=='AbortError'&&state.selected===address){content.replaceChildren(el('div','empty-details',`Falha na consulta: ${e.message}`))}}
}
function renderInventory(info){const c=$('inspectBody');c.replaceChildren();const pos=state.positions.find(p=>p.address===state.selected);if(!pos)return;
  const head=el('div','detail-head');head.append(el('b','',`${info.occupied??pos.ocupado} ${unitsForSector(pos.setor)}`),el('small','',`SETOR ${pos.setor} · ${info.items?.length||0} registros WMS`));c.append(head);
  if(info.inconsistent)c.append(el('div','inventory-warning','⚠ Divergência de vínculo identificada. Confira o WMS antes de movimentar.'));
  c.append(el('div','row-title','REFERÊNCIAS NESTA POSIÇÃO'));
  if(!Array.isArray(info.items)||!info.items.length){c.append(el('div','empty-details','Endereço vazio. Nenhum saldo ativo registrado.'));return}
  for(const item of info.items.slice(0,120)){
    const row=el('div','detail-row');row.append(el('b','',item.reference||item.sku||item.product||'Referência não identificada'));
    const parts=[`Card #${item.card_id||'—'}`,item.color&&`Cor ${item.color}`,item.size&&`Tam. ${item.size}`,`${pos.setor==='ET'||pos.setor==='EC'?item.box_count:item.quantidade} ${unitsForSector(pos.setor)}`].filter(Boolean);
    row.append(el('span','',parts.join(' · ')));c.append(row);
  }
  if(info.items.length>120)c.append(el('div','empty-details','Mais resultados disponíveis no painel WMS.'));
}
function updateBindButtons(){const selected=!!state.selected;const editable=!isSharedModel()||state.canManage;$('bindButton').disabled=!selected||!modelRoot||!editable;$('removeBindButton').disabled=!selected||!state.anchors[state.selected]||!editable;$('bindButton').classList.toggle('active',state.bind);$('bindButton').textContent=state.bind?'Toque em um ponto do modelo...':'⌖ Vincular ao ponto 3D'}
const sphere=new THREE.SphereGeometry(.18,12,8);
function markerMaterial(occupied,selected){return new THREE.MeshBasicMaterial({color:selected?'#ffdb81':occupied?'#bbec78':'#75b8a0',depthTest:false})}
function syncMarkers(){while(markers.children.length){const m=markers.children[0];markers.remove(m);m.material.dispose()}
  if(!modelRoot){updateBindButtons();return}
  const scale=modelRoot.userData.boundsSize||20;
  for(const pos of state.positions){const pt=state.anchors[pos.address];if(!pt)continue;const m=new THREE.Mesh(sphere,markerMaterial(Number(pos.ocupado)>0,pos.address===state.selected));m.scale.setScalar(Math.max(.2,scale*.005));m.position.set(...pt);m.userData.address=pos.address;m.renderOrder=5;markers.add(m)}
  updateBindButtons();updateMetrics();}
function pointerCoordinates(event){const rect=canvas.getBoundingClientRect();pointer.x=(event.clientX-rect.left)/rect.width*2-1;pointer.y=-(event.clientY-rect.top)/rect.height*2+1;raycaster.setFromCamera(pointer,camera)}
canvas.addEventListener('pointerdown',e=>{lastPointer=[e.clientX,e.clientY]});
canvas.addEventListener('pointerup',async e=>{
  if(!lastPointer||Math.hypot(lastPointer[0]-e.clientX,lastPointer[1]-e.clientY)>6)return;
  pointerCoordinates(e);
  if(state.bind&&state.selected&&modelRoot){const found=raycaster.intersectObject(modelRoot,true);if(found.length){const address=state.selected, point=found[0].point.toArray().map(x=>Number(x.toFixed(4)));try{await saveSharedAnchor(address,point);state.anchors[address]=point;if(!isSharedModel())saveAnchorsLocal();state.bind=false;syncMarkers();drawList();toast(address+' vinculado ao mapa 3D.');}catch(err){toast(err.message,true)}}else toast('Clique sobre uma superfície do modelo.',true);return}
  const selected=raycaster.intersectObjects(markers.children,false);if(selected.length)await selectPosition(selected[0].object.userData.address);
});
function focusPoint(p){const delta=p.clone().sub(controls.target);camera.position.add(delta);controls.target.copy(p);controls.update();}
function fitModel(){if(!modelRoot)return;const box=new THREE.Box3().setFromObject(modelRoot);if(box.isEmpty())return;const center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());const radius=Math.max(size.x,size.y,size.z,1);
  camera.near=Math.max(.001,radius/100000);camera.far=Math.max(1000,radius*45);camera.updateProjectionMatrix();
  camera.position.copy(center).add(new THREE.Vector3(radius*.9,radius*.74,radius*1.15));controls.target.copy(center);controls.minDistance=Math.max(.05,radius*.001);controls.maxDistance=radius*20;controls.update();modelRoot.userData.boundsSize=radius;
  grid.visible=false;scene.fog=null;
}
function disposeModel(){if(!modelRoot)return;scene.remove(modelRoot);modelRoot.traverse(o=>{if(o.isMesh){o.geometry?.dispose();if(Array.isArray(o.material))o.material.forEach(m=>m.dispose());else o.material?.dispose()}});modelRoot=null}
async function displayGLB(buffer,filename,knownHash=null){if(!buffer||buffer.byteLength<20)throw new Error('GLB vazio ou inválido.');
  if(new DataView(buffer).getUint32(0,true)!==0x46546c67)throw new Error('Arquivo GLB não reconhecido.');
  const loader=new GLTFLoader();const result=await new Promise((resolve,reject)=>loader.parse(buffer,'',resolve,reject));
  disposeModel();modelRoot=result.scene;modelRoot.name='SKETCHUP_CENTRO_DISTRIBUICAO';scene.add(modelRoot);
  state.modelName=filename.replace(/\.(skp|skb|glb)$/i,'').toLowerCase();state.glbBytes=buffer;state.loadedModel=filename;state.modelHash=knownHash||Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))).map(x=>x.toString(16).padStart(2,'0')).join('');
  await loadAnchors();fitModel();syncMarkers();drawList();updateMetrics();$('startPanel').classList.add('hidden');$('downloadGLB').disabled=false;updateModelControls();
  progress(`${filename} · modelo 3D carregado`);toast('Modelo 3D carregado. Agora você pode vincular os endereços WMS.');
}
async function onModelFile(file){if(!file||loading)return;if(!isSketchup(file.name)&&!isGLB(file.name)){toast('Formato não aceito. Use SKP, SKB ou GLB.',true);return}
  if(file.size>300*1024*1024){toast('Arquivo acima de 300 MB. Exporte uma versão GLB otimizada no SketchUp.',true);return}
  if(requireOfflineConversion(file.name,file.size)){toast('Arquivo SketchUp grande demais para converter com segurança no navegador. Importe o GLB convertido do Stock 3D.',true);progress('Use o GLB convertido para proteger a memória do dispositivo.');return}
  loading=true;progress('Lendo arquivo local...');$('openModel').disabled=true;$('chooseFileButton').disabled=true;
  try{
    const buffer=await file.arrayBuffer();if(isGLB(file.name)){await displayGLB(buffer,file.name);return}
    progress('Preparando conversão SketchUp → GLB. O arquivo permanece neste dispositivo.');
    const worker=new Worker(new URL('./skp-worker.js',import.meta.url),{type:'module'});modelWorker=worker;
    const bytes=await new Promise((resolve,reject)=>{
      worker.onmessage=({data})=>{
        if(data.type==='progress')progress(data.message);
        if(data.type==='done')resolve(data.buffer);
        if(data.type==='error')reject(new Error(data.message));
      };worker.onerror=(e)=>reject(new Error(e.message||'Falha do conversor SketchUp.'));
      worker.postMessage({type:'convert',buffer},[buffer]);
    });worker.terminate();modelWorker=null;
    await displayGLB(bytes,file.name);
  }catch(e){console.error('Stock 3D import',e);toast(`Não foi possível importar: ${e.message}. Tente exportar um GLB pelo SketchUp.`,true);progress('Importação não concluída.');}
  finally{
    loading=false;
    $('openModel').disabled=false;
    $('chooseFileButton').disabled=false;
    $('fileInput').value='';
    // Reevaluate after loading=false; the successful GLB preview ran while
    // the import flag was still true, and left the publish button disabled.
    updateModelControls();
  }
}
function saveBlob(filename,bytes,type){const blob=new Blob([bytes],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000)}
function selectedSearch(){const q=state.query.trim();if(q.length<3||/^\d+(RM|QA|PR|ET|EC)/i.test(q)){state.searchMatches=null;drawList();return}
  if(searchAbort)searchAbort.abort();searchAbort=new AbortController();
  getJson(`/api/stock3d/search?reference=${encodeURIComponent(q)}`,searchAbort.signal).then(data=>{if(state.query.trim()!==q)return;state.searchMatches=new Set(data.addresses||[]);drawList()}).catch(e=>{if(e.name==='AbortError')return;state.searchMatches=null;drawList();if(e.message.includes('404'))toast('Pesquisa por referência disponível somente com a API Stock 3D integrada.',true)});
}
$('sectorFilters').addEventListener('click',e=>{const btn=e.target.closest('button[data-sector]');if(!btn)return;state.sector=btn.dataset.sector;for(const b of $('sectorFilters').querySelectorAll('button'))b.classList.toggle('active',b===btn);drawList();});
let searchTimer;
$('searchInput').addEventListener('input',e=>{state.focusAddresses=null;$('clearFocusButton').classList.add('hidden');state.query=e.target.value;state.searchMatches=null;drawList();clearTimeout(searchTimer);searchTimer=setTimeout(selectedSearch,350)});
$('refreshButton').addEventListener('click',refreshPositions);
$('openModel').addEventListener('click',()=>$('fileInput').click());
$('chooseFileButton').addEventListener('click',()=>$('fileInput').click());
$('fileInput').addEventListener('change',e=>onModelFile(e.target.files[0]));
$('bindButton').addEventListener('click',()=>{if(!state.selected||!modelRoot)return;state.bind=!state.bind;updateBindButtons();if(state.bind)toast(`Clique na estrutura física correspondente a ${state.selected}.`)});
$('removeBindButton').addEventListener('click',async()=>{if(!state.selected)return;const address=state.selected;try{await saveSharedAnchor(address,null,true);delete state.anchors[address];if(!isSharedModel())saveAnchorsLocal();syncMarkers();drawList();toast('Vínculo 3D removido. Nenhum saldo WMS foi alterado.')}catch(err){toast(err.message,true)}});
$('homeCamera').addEventListener('click',fitModel);
$('topCamera').addEventListener('click',()=>{if(!modelRoot)return;const box=new THREE.Box3().setFromObject(modelRoot);const ctr=box.getCenter(new THREE.Vector3()),rad=Math.max(...box.getSize(new THREE.Vector3()).toArray());controls.target.copy(ctr);camera.position.set(ctr.x,ctr.y+rad*1.5,ctr.z+.001);controls.update()});
$('perspectiveCamera').addEventListener('click',fitModel);
$('downloadGLB').addEventListener('click',()=>{if(state.glbBytes)saveBlob((state.modelName||'DISTRILOG-Stock3D')+'.glb',state.glbBytes,'model/gltf-binary')});
$('exportBindings').addEventListener('click',()=>{if(!state.modelName){toast('Importe o modelo antes de exportar os vínculos.',true);return}saveBlob('DISTRILOG-Stock3D-vinculos.json',JSON.stringify({schema:'distrilog-stock3d-anchors-v1',model:state.modelName,anchors:state.anchors},null,2),'application/json')});
$('importBindings').addEventListener('click',()=>$('bindingsInput').click());
$('bindingsInput').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{
  if(file.size>100000)throw new Error('Mapa de vínculos excessivamente grande.');
  const parsed=parseBindings(JSON.parse(await file.text()));
  if(!state.modelName)throw new Error('Importe primeiro o modelo 3D correspondente.');
  if(parsed.model!==state.modelName)throw new Error('Este mapa pertence ao modelo '+parsed.model+', não a '+state.modelName+'.');
  if(isSharedModel()){
    if(!state.canManage)throw new Error('Somente administradores podem publicar os vínculos compartilhados.');
    if(Object.keys(parsed.anchors).length){
      const response=await fetch('/api/stock3d/anchors/import',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({model_sha256:state.modelHash,anchors:parsed.anchors})});
      if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.detail||'Importação não confirmada.')}
    }
    await loadAnchors();
  }else{state.anchors=parsed.anchors;saveAnchorsLocal();}
  syncMarkers();drawList();toast('Vínculos importados e salvos com sucesso.');
}catch(err){toast(err.message,true)}finally{$('bindingsInput').value=''}});
$('publishModelButton').addEventListener('click',publishModel);
$('clearFocusButton').addEventListener('click',()=>{state.focusAddresses=null;state.query='';state.searchMatches=null;$('searchInput').value='';$('clearFocusButton').classList.add('hidden');drawList()});
async function applyDeepLink(){
  const params=new URLSearchParams(window.location.search);
  const cardValue=params.get('card');
  const address=positionKey(params.get('address'));
  const reference=(params.get('reference')||'').trim().slice(0,64);
  if(cardValue&&/^\d+$/.test(cardValue)){
    try{
      const id=Number(cardValue);
      const qs=reference?'?reference='+encodeURIComponent(reference):'';
      const result=await getJson('/api/stock3d/cards/'+id+'/locations'+qs);
      const locations=result.locations||[];
      if(!locations.length){toast('Este card ainda não possui mercadoria alocada no WMS'+(reference?' para essa referência':'')+'.',true);return}
      state.focusAddresses=new Set(locations.map(x=>x.address));
      $('clearFocusButton').classList.remove('hidden');
      drawList();
      progress('Card #'+id+' · '+locations.length+' endereço(s) ativo(s) no WMS');
      await selectPosition(locations[0].address);
      if(!state.anchors[locations[0].address])toast('Endereço localizado no WMS; posição 3D ainda não calibrada.');
    }catch(e){toast('Não foi possível localizar o card: '+e.message,true)}
  }else if(address){
    const pos=state.positions.find(x=>x.address===address);
    if(pos){state.focusAddresses=new Set([address]);$('clearFocusButton').classList.remove('hidden');drawList();await selectPosition(address)}
    else toast('Endereço não encontrado no WMS.',true);
  }else if(reference){
    state.query=reference;$('searchInput').value=reference;drawList();selectedSearch();
  }
}
window.addEventListener('pagehide',()=>{rendererRunning=false;modelWorker?.terminate();ro.disconnect();renderer.dispose()});
(async()=>{await Promise.allSettled([refreshPositions(),loadPublishedModel()]);await applyDeepLink()})();
