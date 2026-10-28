/* Conversão em Web Worker. Nenhum arquivo sai do navegador. */
self.onmessage = async ({data}) => {
  if (!data || data.type !== 'convert' || !(data.buffer instanceof ArrayBuffer)) return;
  try {
    const {buildInstancedScene, toInstancedGLB} = await import('openskp');
    self.postMessage({type: 'progress',message:'Lendo componentes e materiais do SketchUp...'});
    const scene = buildInstancedScene(data.buffer, {onProgress: (p) => {
      if (p && p.stage && p.total > 0) self.postMessage({type: 'progress', message: `SketchUp: ${p.stage} · ${Math.round(100 * p.current / p.total)}%`});
    }});
    self.postMessage({type:'progress',message:'Gerando geometria 3D com componentes reutilizáveis...'});
    const glb = toInstancedGLB(scene, {textures:false});
    const bytes = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
    self.postMessage({type:'done',buffer:bytes},[bytes]);
  } catch (err) {
    self.postMessage({type:'error',message:(err && err.message) || 'Falha desconhecida ao converter SketchUp.'});
  }
};
