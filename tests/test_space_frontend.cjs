/* Contract and guided UI tests: no browser or external server. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const base = path.join(__dirname, "..");
const ui = fs.readFileSync(path.join(base,"static/space_activities.js"),"utf8");
const web = fs.readFileSync(path.join(base,"static/app.js"),"utf8");
const html = fs.readFileSync(path.join(base,"templates/index.html"),"utf8");

test("stock-opening and pallet-return are sub-tabs of Estocagem, not global sidebar",()=>{
  assert.doesNotMatch(html,/data-view="space-activities"/);
  assert.match(html,/data-view="storage-hub"/);
  assert.match(html,/\/static\/space_activities\.js/);
  assert.match(web,/\["Abertura de espaço","storage-space"\]/);
  assert.match(web,/\["Devolução ao porta-paletes","storage-pallets"\]/);
  assert.match(web,/"storage-space":"storage-hub"/);
  assert.match(ui,/storageTabs\(currentView\)/);
});

test("Card embeds Stock 3D only after explicit request (no WMS mutation)",()=>{
  assert.match(web,/cardStock3DActiveAddresses/);
  assert.match(web,/cardStock3DInline/);
  assert.match(web,/embedded=1/);
  assert.match(web,/toggleCardStock3DInline/);
  assert.doesNotMatch(ui,/\/api\/positions\/cards\/.*\/allocate/);
  assert.doesNotMatch(ui,/\/api\/positions\/.*\/transfer/);
});

function fakePage(){
  const fields = new Map();
  let lastRendered = "";
  const handlers = [];
  let current = null;
  const calls = [];
  const context = {
    currentView:"storage-space",
    currentUser:{id:900,name:"Operador QA",role:"qualidade"},
    Date,Math,Map,Set,Number,Array,String,Object,
    setInterval:()=>1,
    clearInterval:()=>{},
    confirm:()=>true,
    toast:()=>{},
    fmtSeconds:(s)=>String(Math.floor(s)).padStart(6,"0"),
    fmtDateTime:()=>"-",
    setPage:()=>{},
    storageTabs:()=>'<div class="module-tabs">Estocagem</div>',
    esc:(x)=>String(x).replaceAll("&","&amp;").replaceAll("<","&lt;"),
    $:(id)=>fields.get(id)||null,
    document:{
      addEventListener:(name,fn)=>handlers.push({name,fn}),
      querySelectorAll:()=>[],
      getElementById:(id)=>fields.get(id)||null,
    },
    api:async(url,options={})=>{
      calls.push({url,options});
      if(url==="/api/space-activities/active")return {activity:current};
      if(url.startsWith("/api/space-activities?"))return {activities:current?[current]:[]};
      if(url==="/api/space-activities"&&options.method==="POST"){
        current={id:7,kind:JSON.parse(options.body).kind,street:"RUA 03",brand:"MARCA",status:"EM_ANDAMENTO",worked_seconds_live:0};
        return {ok:true,activity:current};
      }
      if(url.endsWith("/pause")){
        current={...current,status:"PAUSADA"};
        return {ok:true,activity:current};
      }
      if(url.endsWith("/resume")){
        current={...current,status:"EM_ANDAMENTO"};
        return {ok:true,activity:current};
      }
      if(url.endsWith("/finish")){
        current={...current,status:"CONCLUIDA",moved_quantity:8,quantity_unit:"CAIXAS"};
        return {ok:true,activity:current};
      }
      throw Error("Unexpected "+url);
    },
  };
  fields.set("mainContent",{set innerHTML(value){lastRendered=value},get innerHTML(){return lastRendered}});
  vm.createContext(context);
  vm.runInContext(ui,context);
  return {ctx:context,fields,calls,rendered:()=>lastRendered};
}

test("workflow shows exactly the current step and persists through real endpoints",async()=>{
  const {ctx,fields,calls,rendered}=fakePage();
  await ctx.renderSpaceActivities();
  assert.match(rendered(),/Abertura de espaço/);
  assert.match(rendered(),/spaceStreet/);
  assert.doesNotMatch(rendered(),/Qual atividade/);
  assert.doesNotMatch(rendered(),/spaceQuantity/);
  fields.set("spaceStreet",{value:"RUA 03"});
  fields.set("spaceBrand",{value:"MARCA"});
  await ctx.spaceAction("start");
  assert.match(rendered(),/spaceTimer/);
  assert.doesNotMatch(rendered(),/spaceStreet/);
  assert.equal(calls.some(x=>x.url==="/api/space-activities"&&x.options.method==="POST"),true);
  await ctx.spaceAction("pause");
  assert.match(rendered(),/PAUSADA/);
  await ctx.spaceAction("resume");
  await ctx.spaceAction("finishStep");
  assert.match(rendered(),/spaceQuantity/);
  assert.doesNotMatch(rendered(),/spaceStreet/);
  fields.set("spaceQuantity",{value:"8"});
  fields.set("spaceUnit",{value:"CAIXAS"});
  fields.set("spaceNotes",{value:""});
  await ctx.spaceAction("finish");
  assert.match(rendered(),/Atividade concluída e salva/);
  assert.equal(calls.some(x=>x.url==="/api/space-activities/7/finish"&&x.options.method==="POST"),true);
});

test("pallet return is directly selectable within its own Estocagem tab",async()=>{
  const {ctx,rendered}=fakePage();
  ctx.currentView="storage-pallets";
  await ctx.renderSpaceActivities();
  assert.match(rendered(),/Devolução ao porta-paletes/);
  assert.match(rendered(),/spaceStreet/);
  assert.equal(ctx.spaceRouteKind(),"DEVOLUCAO_PORTA_PALETES");
});

test("web feature palette follows original dark theme without changing global colors",()=>{
  const css=fs.readFileSync(path.join(base,"static/style.css"),"utf8");
  assert.match(css,/:root\{--nav:#1c1e22;.*--yellow:#ff8a3d;.*--blue:#62a9ff/);
  const section=css.slice(css.indexOf("/* Organização física da Estocagem:"));
  assert.match(section,/space-stage\{background:linear-gradient\(145deg,#262a31,#1e2126\)/);
  assert.match(section,/space-button\.primary\{background:var\(--blue\)/);
  assert.match(section,/card-stock3d-location\{border:1px solid var\(--border\)/);
  assert.doesNotMatch(section,/space-stage\{background:#fff/);
});

test("web highlights only addresses with active allocations",()=>{
  const start=web.indexOf("function cardStock3DActiveAddresses(rows) {");
  const end=web.indexOf("function renderCardStock3DInline()",start);
  assert.ok(start>0&&end>start);
  const context={};
  vm.createContext(context);
  vm.runInContext(web.slice(start,end),context);
  const addresses=context.cardStock3DActiveAddresses([
    {active:true,address:"1RM06A"},
    {active:false,address:"1EC03"},
    {active:1,address:"1EC01"},
    {active:"f",address:"1QA03A"},
    {active:true,address:"INVALID"},
  ]);
  assert.deepEqual(Array.from(addresses),["1EC01","1RM06A"]);
});
