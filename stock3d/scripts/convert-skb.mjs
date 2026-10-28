/** Converte SKP/SKB em GLB por processamento local (sem upload). */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,basename,dirname,join} from 'node:path';
import {buildInstancedScene,toInstancedGLB} from 'openskp';

const src=process.argv[2];
if(!src||!/\.(skp|skb)$/i.test(src)){
 console.error('Uso: npm run convert -- "C:\\caminho\\estoque.skb"');process.exit(2);
}
const input=resolve(src);
const destination=process.argv[3]?resolve(process.argv[3]):join(dirname(input),basename(input).replace(/\.(skp|skb)$/i,'.glb'));
if(destination===input){console.error('Destino não pode ser igual à origem.');process.exit(2)}
try{
 console.log('Lendo arquivo SketchUp local:',input);
 const raw=await readFile(input);
 const buf=raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength);
 console.log('Extraindo geometria (preservando componentes repetidos)...');
 const scene=buildInstancedScene(buf);
 const output=toInstancedGLB(scene,{textures:false});
 if(output.length<100||output[0]!==0x67||output[1]!==0x6c||output[2]!==0x54||output[3]!==0x46)throw new Error('Saída GLB inválida.');
 await writeFile(destination,output);
 console.log('GLB criado:',destination, `(${(output.byteLength/1024/1024).toFixed(1)} MB)`);
 console.log('Modelo original permanece intacto.');
}catch(error){console.error('Falha na conversão:',error.message);process.exitCode=1}
