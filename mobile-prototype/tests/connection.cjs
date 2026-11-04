const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const script=fs.readFileSync(path.resolve(__dirname,'../app/src/main/assets/mobile/app.js'),'utf8');

function page(validator=url=>url==='https://distrilog.example.com'){
  let configured=null;
  const listeners={};
  const app={innerHTML:''},input={value:'https://distrilog.example.com'};
  const button={dataset:{action:'configure'},disabled:false};
  const toasts=[];
  const context={
    window:{DM_API:{endpoint:()=>'',configure(url){configured=url;return validator(url)},get(){return Promise.resolve([])}},scrollTo(){}},
    localStorage:{removeItem(){},getItem(){return null},setItem(){}},
    document:{
      getElementById(id){return id==='app'?app:id==='server'?input:null},
      querySelectorAll(){return [button]},
      addEventListener(event,callback){listeners[event]=callback},
      createElement(){return {classList:{add(){}},textContent:'',remove(){}}},
      body:{appendChild(node){toasts.push(node)}}
    },
    clearTimeout(){},setTimeout(){return 0},console,URLSearchParams,Number,String,Math,Promise,Map,Set,Date
  };
  vm.createContext(context);
  vm.runInContext(script,context,{timeout:5000});
  async function click(){
    listeners.click({target:{closest(){return button}}});
    await new Promise(setImmediate);
    await new Promise(setImmediate);
  }
  return {app,input,button,toasts,click,get configured(){return configured}};
}
test('clicar em Conectar navega ao login usando endereço válido',async()=>{
  const p=page();
  assert.match(p.app.innerHTML,/Conectar ao sistema/);
  await p.click();
  assert.equal(p.configured,'https://distrilog.example.com');
  assert.match(p.app.innerHTML,/Entrar no DISTRILOG/);
  assert.equal(p.button.disabled,false);
});
test('URL rejeitada apresenta mensagem e permite correção',async()=>{
  const p=page(()=>false);await p.click();
  assert.match(p.app.innerHTML,/Conectar ao sistema/);
  assert.ok(p.toasts.some(node=>/HTTPS público válido/.test(node.textContent)));
});
test('URL em branco apresenta aviso sem configurar conexão',async()=>{
  const p=page();p.input.value='';await p.click();
  assert.equal(p.configured,null);
  assert.ok(p.toasts.some(node=>/Informe o endereço HTTPS/.test(node.textContent)));
});
