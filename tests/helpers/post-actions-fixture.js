const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPostActions(users, square, wx = {}) {
  const context = { module: { exports: {} }, wx,
    require: name => name.includes('services/user') ? users : name.includes('services/square') ? square : require('../../miniprogram/utils/post-view') };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/post-actions.js'), 'utf8'), context);
  return context.module.exports;
}
function applyPageData(data, values) {
  for (const [key, value] of Object.entries(values)) {
    const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
    let target = data;
    for (const part of parts.slice(0, -1)) target = target[part];
    target[parts.at(-1)] = value;
  }
}
module.exports = { loadPostActions, applyPageData };
