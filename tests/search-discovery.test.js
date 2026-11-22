const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function motion(){
  const context={module:{exports:{}},getMath:()=>Math};vm.runInNewContext(fs.readFileSync('miniprogram/pages/search/discovery-motion.wxs','utf8'),context);
  const state={},nodes=new Map(),calls=[];
  const node=key=>{if(!nodes.has(key))nodes.set(key,{styles:{},setStyle(value){Object.assign(this.styles,value);}});return nodes.get(key);};
  const owner={getState:()=>state,selectComponent:node,callMethod:(method,value)=>calls.push({method,value})};
  const config={active:true,menu:false};context.module.exports.sync(config,null,owner);
  return {api:context.module.exports,state,nodes,calls,node,owner,config};
}
test('滚动不再回写标签栏位移，底栏只通知80%/100%目标且隐藏时不处理',()=>{
  const f=motion();f.api.begin({},f.owner);
  f.api.scroll({detail:{scrollTop:100}},f.owner);
  f.api.scroll({detail:{scrollTop:250}},f.owner);assert.equal(f.nodes.has('.search-board-tabs'),false);
  assert.equal(f.calls.filter(c=>c.method==='setSearchCompact').length,1);assert.equal(f.calls[0].value.compact,true);
  f.api.scroll({detail:{scrollTop:240}},f.owner);assert.equal(f.calls.at(-1).value.compact,false);
  const count=f.calls.length;f.api.sync({...f.config,active:false},f.config,f.owner);f.api.scroll({detail:{scrollTop:500}},f.owner);assert.equal(f.calls.length,count);
});
