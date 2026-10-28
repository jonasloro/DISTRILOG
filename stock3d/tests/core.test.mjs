import test from 'node:test';
import assert from 'node:assert/strict';
import {filterPositions,positionStats,parseBindings,validPosition,unitsForSector,isSketchup} from '../src/core.js';
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
