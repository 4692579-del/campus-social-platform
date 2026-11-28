const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPostActions(users, square, wx = {}, getCurrentPages = () => []) {
  const context = { module: { exports: {} }, wx, getCurrentPages, setTimeout, clearTimeout,
    require: name => name.includes('services/user') ? users : name.includes('services/square') ? square : require(path.join('../../miniprogram/utils', name)) };
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
const postMenuAnchor = { left: 340, top: 160, width: 24, bottom: 184 };
function choosePostMenu(page, action, kind = 'post') {
  page.onPostPopoverSelect({ currentTarget: { dataset: { kind, action } } });
  return new Promise(resolve => setTimeout(resolve, 220));
}
module.exports = { loadPostActions, applyPageData, postMenuAnchor, choosePostMenu };
