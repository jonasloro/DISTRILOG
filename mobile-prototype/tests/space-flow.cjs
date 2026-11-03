/* Regressão do fluxo 1 etapa por vez no APK.
 * No credentials, device or production server required.
 */
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");

const root=path.resolve(__dirname,"../app/src/main/assets/mobile");
const mobile=fs.readFileSync(path.join(root,"app.js"),"utf8");
const activity=fs.readFileSync(path.join(root,"activities.js"),"utf8");
const index=fs.readFileSync(path.join(root,"index.html"),"utf8");

test("APK includes the new self-contained activity module",()=>{
  assert.match(index,/activities\.js/);
  assert.match(mobile,/s\.screen==='activities'/);
  assert.match(mobile,/window\.DM_SPACE\.view\(s\.user\)/);
  assert.match(mobile,/window\.DM_SPACE\.act\(action\.slice\(6\),s\.user\)/);
  assert.match(mobile,/Atividades/);
});
test("Card no longer stacks every operation, product, location, history panel",()=>{
  assert.match(mobile,/function taskStages\(c\)/);
  assert.match(mobile,/function cardView\(\)/);
  assert.match(mobile,/cardPanel/);
  assert.match(mobile,/taskNext/);
  assert.match(mobile,/taskPrev/);
  assert.match(mobile,/mobile-task-footer/);
  assert.doesNotMatch(mobile,/return basics\+locations\(\)\+operation\+list\+timeline;/);
});
test("receiving flow has one step for physical check, sample, allocation, completion",()=>{
  assert.match(mobile,/Etapa 1 · Conferência física/);
  assert.match(mobile,/Etapa 2 · Tiragem obrigatória de 10%/);
  assert.match(mobile,/Etapa 3 · Endereçamento físico/);
  assert.match(mobile,/Etapa 4 · Concluir Recebimento/);
  assert.match(mobile,/saveSampleQty/);
  assert.match(mobile,/document\.getElementById\('sampleActual'\)/);
});
test("user-entered activity data is sent to real stock-space backend only",()=>{
  assert.match(activity,/\/api\/space-activities\/active/);
  assert.match(activity,/\/api\/space-activities\?limit=12/);
  assert.match(activity,/moved_quantity:Number\(raw\)/);
  assert.match(activity,/quantity_unit:unit/);
  assert.match(activity,/Os saldos WMS não serão alterados/);
  assert.doesNotMatch(activity,/\/api\/positions\/cards\/.*\/allocate/);
});
function env(){
  const fields=new Map();
  let current=null,history=[],calls=[];
  const api={
    get:async(url)=>{
      calls.push({url,method:"GET"});
      if(url==="/api/space-activities/active")return {activity:current};
      if(url.startsWith("/api/space-activities?"))return {activities:history};
      throw Error("Unexpected "+url);
    },
    post:async(url,data)=>{
      calls.push({url,method:"POST",data});
      if(url==="/api/space-activities"){
        current={id:10,kind:data.kind,street:data.street,brand:data.brand,status:"EM_ANDAMENTO",worked_seconds_live:0};
        history.unshift(current);
      }else if(url.endsWith("/pause"))current={...current,status:"PAUSADA"};
      else if(url.endsWith("/resume"))current={...current,status:"EM_ANDAMENTO"};
      else if(url.endsWith("/finish")){
        current={...current,status:"CONCLUIDA",moved_quantity:data.moved_quantity,quantity_unit:data.quantity_unit};
        history[0]=current;
      }else throw Error("Unexpected post "+url);
      return {ok:true,activity:current};
    }
  };
  const ctx={
    window:{DM_API:api,setInterval:()=>0,confirm:()=>true},
    document:{getElementById:(id)=>fields.get(id)||null},
    console,Date,Set,Number,Map,Math,
  };
  vm.createContext(ctx);vm.runInContext(activity,ctx);
  return {flow:ctx.window.DM_SPACE,fields,calls};
}
test("activity wizard requires street/brand before timer and count at finish",async()=>{
  const {flow,fields,calls}=env();
  await flow.load();
  assert.match(flow.view({role:"estocagem"}),/Qual atividade/);
  await flow.act("adjust",{role:"estocagem"});
  assert.match(flow.view({role:"estocagem"}),/spaceStreet/);
  assert.doesNotMatch(flow.view({role:"estocagem"}),/spaceQty/);
  await assert.rejects(()=>flow.act("start",{role:"estocagem"}),/rua e a marca/);
  fields.set("spaceStreet",{value:"RUA 11"});fields.set("spaceBrand",{value:"ALFA"});
  await flow.act("start",{role:"estocagem"});
  assert.match(flow.view({role:"estocagem"}),/dmSpaceClock/);
  await flow.act("pause",{role:"estocagem"});
  assert.match(flow.view({role:"estocagem"}),/PAUSADA/);
  await flow.act("resume",{role:"estocagem"});
  await flow.act("finishStep",{role:"estocagem"});
  assert.match(flow.view({role:"estocagem"}),/spaceQty/);
  fields.set("spaceQty",{value:"0"});
  fields.set("spaceUnit",{value:"PALETES"});
  await assert.rejects(()=>flow.act("finish",{role:"estocagem"}),/maior que zero/);
  fields.set("spaceQty",{value:"16"});
  await flow.act("finish",{role:"estocagem"});
  assert.match(flow.view({role:"estocagem"}),/Atividade registrada/);
  assert.equal(calls.filter(x=>x.method==="POST"&&x.url.endsWith("/finish")).length,1);
  assert.equal(calls.find(x=>x.method==="POST"&&x.url.endsWith("/finish")).data.moved_quantity,16);
});
