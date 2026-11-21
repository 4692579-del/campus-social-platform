const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync('miniprogram/components/square-post/action-count.wxs', 'utf8'), context);
const format = context.module.exports.format;
test('互动计数保留真实小整数，万和亿仅缩写展示，不向上夸大数量', () => {
  for (const [value, text] of [[0,'0'],[261,'261'],[423,'423'],[9999,'9999'],[10000,'1万'],[18000,'1.8万'],[19999,'1.9万'],[100000000,'1亿'],[125000000,'1.2亿']]) assert.equal(format(value), text);
});
test('缺失、非数字或无效计数不显示NaN、Infinity或负数', () => {
  for (const value of [undefined,null,'18000',false,NaN,Infinity,-Infinity,-1]) assert.equal(format(value),'0');
});
