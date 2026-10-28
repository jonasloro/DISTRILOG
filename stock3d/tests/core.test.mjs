import test from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {filterPositions,positionStats,parseBindings,validPosition,unitsForSector,isSketchup,requireOfflineConversion,mayPublishModel} from '../src/core.js';
const positions=[{address:'1RM06A',setor:'RM',ocupado:4},{address:'1ET04',setor:'ET',ocupado:0},{address:'2EC09',setor:'EC',ocupado:12}];
test('validar posições registradas sem inventar níveis para ET/EC',()=>{
  positions.forEach(p=>assert.equal(validPosition(p),true));
  assert.equal(validPosition({address:'2EC09A',setor:'EC',ocupado:1}),false); // ET/EC não têm níveis
  assert.equal(validPosition({address:'not-an-address',setor:'RM',ocupado:1}),false);
  assert.equal(unitsForSector('ET'),'caixas pretas');
});
test('filtrar setor e endereço',()=>{
  assert.deepEqual(filterPositions(positions,'RM','06').map(x=>x.address),['1RM06A']);
  assert.deepEqual(filterPositions(positions,'TODOS','').length,3);
  assert.deepEqual(filterPositions(positions,'TODOS','REF',{has:()=>false}).length,0);
});
test('contagem usa exclusivamente API real',()=>{
  assert.deepEqual(positionStats(positions,{'1RM06A':[1,2,3]}),{total:3,busy:2,mapped:1});
});
test('vínculos JSON são estritos e validados',()=>{
  let m=parseBindings({schema:'distrilog-stock3d-anchors-v1',model:'estoque.glb',anchors:{'1RM06A':[0,1.3,2]}});
  assert.equal(m.anchors['1RM06A'][1],1.3);
  assert.throws(()=>parseBindings({schema:'distrilog-stock3d-anchors-v1',model:'test',anchors:{'1RM06A':['nan',2,3]}}));
  assert.throws(()=>parseBindings({schema:'bad',model:'test',anchors:{}}));
});
test('backup SKB é aceito como arquivo SketchUp',()=>{
  assert.equal(isSketchup('1. COMPLETO.ATUAL.skb'),true);
  assert.equal(isSketchup('modelo.exe'),false);
});

test('arquivos SketchUp grandes são direcionados à conversão offline',()=>{
  assert.equal(requireOfflineConversion('estoque.skb',80*1024*1024),true);
  assert.equal(requireOfflineConversion('miniatura.skp',4*1024*1024),false);
  assert.equal(requireOfflineConversion('estoque.glb',30*1024*1024),false);
});

test('botão de publicar só habilita para administrador após concluir a importação',()=>{
  assert.equal(mayPublishModel({canManage:true,hasModel:true,loading:true,alreadyPublished:false}),false);
  assert.equal(mayPublishModel({canManage:true,hasModel:true,loading:false,alreadyPublished:false}),true);
  assert.equal(mayPublishModel({canManage:false,hasModel:true,loading:false,alreadyPublished:false}),false);
  assert.equal(mayPublishModel({canManage:true,hasModel:false,loading:false,alreadyPublished:false}),false);
  assert.equal(mayPublishModel({canManage:true,hasModel:true,loading:false,alreadyPublished:true}),false);
});
test('estado de importação reavalia o botão depois de liberar loading',()=>{
  const source=readFileSync(fileURLToPath(new URL('../src/main.js',import.meta.url)),'utf8');
  const importFunction=source.split('async function onModelFile(file)')[1].split('function saveBlob(')[0];
  assert.match(importFunction,/finally\s*\{[\s\S]*?loading\s*=\s*false;[\s\S]*?updateModelControls\(\);/);
});
