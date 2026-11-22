const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), vm = require('node:vm');
const { createUapiClient, parseBoard } = require('../cloudfunctions/hotboard/uapi');
const { createHotboardService, TTL, MAX_STALE, LEASE } = require('../cloudfunctions/hotboard/service');
const source = (type='weibo', title='仅用于契约测试的词条') => ({ type, update_time:'2026-11-21T16:00:00.000Z', list:[{ index:7, title, hot_value:'100', url:'https://source.example/item' }] });
const board = (type='weibo', title) => parseBoard(source(type,title),type);
const flush = async () => { for(let n=0;n<16;n++) await Promise.resolve(); };
function database() {
  const rows=new Map();let tail=Promise.resolve();
  const collection=name=>{assert.equal(name,'hotboard_cache');return {doc:id=>({
    async get(){return {data:structuredClone(rows.get(id)||null)};},
    async set({data}){rows.set(id,structuredClone(data));},
    async update({data}){rows.set(id,{...rows.get(id),...structuredClone(data)});},
  })};};
  const db={collection,async runTransaction(fn){let release;const old=tail;tail=new Promise(resolve=>{release=resolve;});await old;try{return {result:await fn({collection})};}finally{release();}}};
  return {db,rows};
}
function transport(body,status=200) {
  const calls=[];
  return {calls,get(options,callback){calls.push(options);const request=new EventEmitter();request.destroy=()=>{};
    queueMicrotask(()=>{const response=new EventEmitter();response.statusCode=status;response.resume=()=>{};response.destroy=()=>{};callback(response);response.emit('data',Buffer.from(typeof body==='string'?body:JSON.stringify(body)));response.emit('end');});return request;
  }};
}

test('严格读取文档的type/update_time/list/index/title，保留来源排名，不以数组位置编造名次',()=>{
  const raw=source();raw.list.push({index:2,title:'第二个契约词条',extra:{private:'not-returned'}});
  const result=parseBoard(raw,'weibo');assert.deepEqual(result.list.map(row=>row.rank),[2,7]);
  assert.deepEqual(Object.keys(result.list[0]).sort(),['rank','title']);
  assert.throws(()=>parseBoard({...raw,type:'baidu'},'weibo'));
  assert.throws(()=>parseBoard({type:'weibo',updatetime:raw.update_time,data:raw.list},'weibo'));
  assert.throws(()=>parseBoard({...raw,list:[{title:'缺少真实排名'}]},'weibo'));
  assert.throws(()=>parseBoard({...raw,list:[raw.list[0],raw.list[0]]},'weibo'));
});

test('固定HTTPS端点和GET参数，Key仅放Bearer头，配置Key失效时不改用访客请求或跟随跳转',async()=>{
  const http=transport(source()),client=createUapiClient({transport:http,getKey:()=> 'server-only-test-key'});
  const result=await client('weibo');assert.equal(result.list[0].rank,7);
  assert.equal(http.calls[0].hostname,'uapis.cn');assert.equal(http.calls[0].path,'/api/v1/misc/hotboard?type=weibo');assert.equal(http.calls[0].method,'GET');
  assert.equal(http.calls[0].headers.Authorization,'Bearer server-only-test-key');assert.ok(!JSON.stringify(result).includes('server-only-test-key'));
  await assert.rejects(client('https://invalid.example'),{code:'HOTBOARD_INVALID_TYPE'});assert.equal(http.calls.length,1);
  for(const [status,code] of [[401,'HOTBOARD_AUTH_FAILED'],[402,'HOTBOARD_QUOTA_EXHAUSTED'],[429,'HOTBOARD_RATE_LIMITED'],[302,'HOTBOARD_UPSTREAM_ERROR']]){
    const failed=transport({message:'sensitive-upstream-body'},status);
    await assert.rejects(createUapiClient({transport:failed,getKey:()=> 'server-only-test-key'})('weibo'),error=>error.code===code&&!error.message.includes('sensitive'));
    assert.equal(failed.calls.length,1);
  }
  const guest=transport(source());await createUapiClient({transport:guest,getKey:()=>''})('weibo');assert.equal(guest.calls[0].headers.Authorization,undefined);
  const toutiao=transport(source('toutiao'));
  assert.equal((await createUapiClient({transport:toutiao,getKey:()=>''})('toutiao')).list[0].rank,7);
  assert.equal(toutiao.calls[0].path,'/api/v1/misc/hotboard?type=toutiao');
  await assert.rejects(createUapiClient({transport:transport('<html>bad</html>'),getKey:()=>''})('weibo'),{code:'HOTBOARD_INVALID_RESPONSE'});
});

test('云端按平台持久化缓存5分钟，同实例合并请求，不接受force参数绕过缓存',async()=>{
  const {db,rows}=database();let now=100000000,calls=0;
  const read=createHotboardService(db,async type=>{calls++;return board(type);},{now:()=>now});
  const results=await Promise.all([read({type:'weibo'}),read({type:'weibo'})]);assert.equal(calls,1);assert.ok(results.every(value=>value.success));
  await read({type:'weibo',force:true});assert.equal(calls,1);assert.equal(rows.get('weibo').leaseOwner,'');
  await read({type:'baidu'});assert.equal(calls,2);
  assert.equal((await read({type:'__proto__'})).success,false);assert.equal(calls,2);
  now+=TTL;await read({type:'weibo'});assert.equal(calls,3);
});

test('HTTPS总超时会中断请求，超大或非JSON响应不能进入热榜缓存',async()=>{
  let deadline,destroyed=false;const context={module:{exports:{}},require:()=>require('node:https'),Buffer,process,
    setTimeout(fn,delay){assert.equal(delay,8000);deadline=fn;return 1;},clearTimeout(){}};
  vm.runInNewContext(fs.readFileSync('cloudfunctions/hotboard/uapi.js','utf8'),context);
  const request=new EventEmitter();request.destroy=()=>{destroyed=true;};
  const load=context.module.exports.createUapiClient({getKey:()=>'',transport:{get:()=>request}});
  const pending=load('weibo');deadline();await assert.rejects(pending,error=>error.code==='HOTBOARD_TIMEOUT');assert.equal(destroyed,true);
  await assert.rejects(createUapiClient({getKey:()=>'',transport:transport('x'.repeat(1024*1024+1))})('weibo'),{code:'HOTBOARD_INVALID_RESPONSE'});
});

test('跨实例用事务租约合并冷启动，超时旧持有者不能覆盖新榜单',async()=>{
  const {db,rows}=database();let now=100000000,finish,calls=0;
  const old=createHotboardService(db,()=>new Promise(resolve=>{finish=resolve;calls++;}),{now:()=>now,token:()=> 'old'});
  const current=createHotboardService(db,async type=>{calls++;return board(type,'新响应');},{now:()=>now,token:()=> 'new'});
  const pending=old({type:'weibo'});await flush();assert.equal(calls,1);
  const locked=await current({type:'weibo'});assert.equal(locked.code,'HOTBOARD_BUSY');assert.equal(calls,1);
  now+=LEASE+1;assert.equal((await current({type:'weibo'})).board.list[0].title,'新响应');
  finish(board('weibo','过期响应'));assert.equal((await pending).board.list[0].title,'新响应');assert.equal(rows.get('weibo').list[0].title,'新响应');
});

test('上游失败保留真实旧榜并标记缓存，失败冷却防止重复消耗额度，无缓存时明确报错',async()=>{
  const {db}=database();let now=100000000,calls=0,failed=false;
  const read=createHotboardService(db,async type=>{calls++;if(failed)throw new Error('sensitive-api-body');return board(type);},{now:()=>now});
  const first=await read({type:'weibo'});now+=TTL;failed=true;
  const stale=await read({type:'weibo'});assert.equal(stale.success,true);assert.equal(stale.board.stale,true);assert.deepEqual(stale.board.list,first.board.list);assert.equal(stale.board.fetchedAt,first.board.fetchedAt);
  await read({type:'weibo'});assert.equal(calls,2);
  const empty=await read({type:'zhihu'});assert.equal(empty.success,false);assert.ok(!JSON.stringify(empty).includes('sensitive'));assert.equal(empty.board,undefined);
  await read({type:'zhihu'});assert.equal(calls,3);
  now+=MAX_STALE+1;const expired=await read({type:'weibo'});assert.equal(expired.success,false);assert.equal(expired.board,undefined);
});

test('缺少云端缓存集合返回部署错误，不以模拟热搜或空榜代替',async()=>{
  const db={collection(){throw Object.assign(new Error('collection not exist'),{errCode:-502005});}};
  const read=createHotboardService(db,async()=>assert.fail('不应请求上游'));
  const result=await read({type:'weibo'});assert.equal(result.success,false);assert.equal(result.code,'HOTBOARD_STORAGE_NOT_READY');
});
