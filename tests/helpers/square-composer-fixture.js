const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { applyPageData } = require('./post-actions-fixture');

const user = { _id: 'alice', accountId: '12345678', nickname: '真实昵称', avatarFileID: 'cloud://test/avatar.png', role: 'user', certificationStatus: 'unverified' };
function composerFixture(options = {}) {
  let definition, current = options.guest ? null : { ...user }, version = 0, timerId = 0;
  const storage = options.storage || new Map(), events = [], calls = [], requests = [], toasts = [], timers = new Map(), delays = new Map();
  const users = {
    getCachedUser: () => current, getSessionVersion: () => version,
    restore: async () => { requests.push('restore'); return options.restore ? options.restore() : current; },
    login: async () => { current = { ...user }; version++; return current; },
    logout: () => { current = null; version++; },
  };
  const square = { cachedPost: () => options.cachedQuote || null, detail: async id => options.detail ? options.detail(id) : { _id: id, content: '真实被引用动态', images: [] }, optimizeContent: async (content, images = []) => { requests.push({ optimize: content, ...(images.length ? { images } : {}) }); return options.optimize ? options.optimize(content, images) : '优化后的内容'; }, publish: async (content, id, images = [], declaration = 'none', quotePostId = '', media) => {
    calls.push({ content, id, ...(images.length ? { images } : {}), ...(declaration !== 'none' ? { declaration } : {}), ...(quotePostId ? { quotePostId } : {}), ...(media ? { media } : {}) });
    return options.publish ? options.publish(content, id, images, declaration, quotePostId) : { _id: 'p_' + 'a'.repeat(40), content, images, declaration, ...(quotePostId ? { quotePostId } : {}) };
  } };
  const media = {
    chooseImages: async (count, mixed) => options.chooseImages ? options.chooseImages(count, mixed) : [],
    uploadImages: async (images, uploaded, progress) => {
      if (options.uploadImages) return options.uploadImages(images, uploaded, progress);
      return images.map((image, index) => {
        const fileID = image.fileID || `cloud://test.bucket/square-uploads/${current._id}/${image.key}.${image.type}`;
        uploaded(index, fileID); progress(index + 1, images.length); return fileID;
      });
    },
    previewImages: async (...args) => options.previewImages && options.previewImages(...args),
    discardUploads: async files => { requests.push({ discard: files }); },
  };
  const wx = {
    getWindowInfo: () => options.window || { windowHeight: 812, windowWidth: 375, statusBarHeight: 44 },
    getMenuButtonBoundingClientRect: () => options.capsule || { top: 52, height: 32 },
    getStorageSync: key => storage.get(key),
    setStorageSync(key, value) { if (options.failStorage) throw new Error('storage full'); storage.set(key, value); },
    removeStorageSync(key) { if (options.failRemoveStorage) throw new Error('storage unavailable'); storage.delete(key); }, hideKeyboard() { requests.push('hideKeyboard'); },
    showToast: args => toasts.push(args.title),
  };
  const gate = { module: { exports: {} }, require: () => users, wx };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/login-gate.js'), 'utf8'), gate);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/components/square-composer/index.js'), 'utf8'), {
    Component: value => { definition = value; }, wx,
    setTimeout(fn, delay) { if (delay > 2500 && !options.manualOptimizationDelay) { queueMicrotask(fn); return ++timerId; } const id = ++timerId; timers.set(id, fn); delays.set(id, delay); return id; }, clearTimeout(id) { timers.delete(id); delays.delete(id); },
    require: name => name.includes('services/user') ? users : name.includes('services/square') ? square :
      name.includes('services/post-images') ? media : name.includes('login-gate') ? gate.module.exports : name.includes('content-declaration') ? require('../../miniprogram/utils/content-declaration') : require('../../miniprogram/utils/post-view'),
  });
  const component = { ...definition.methods, data: { ...structuredClone(definition.data), initialQuote: options.initialQuote || null, quoteOwnerId: options.quoteOwnerId || 'alice' },
    setData(values) { applyPageData(this.data, values); }, triggerEvent(name, detail) { events.push({ name, detail }); } };
  return { component, page: component, calls, storage, events, toasts, requests, timers, delays,
    attach: () => definition.lifetimes.attached.call(component), detach: () => definition.lifetimes.detached.call(component),
    hide: () => definition.pageLifetimes.hide.call(component), show: () => definition.pageLifetimes.show.call(component),
    setUser(value) { current = value; version++; },
    flushClose() { for (const [id, fn] of timers) { timers.delete(id); delays.delete(id); fn(); } },
  };
}
module.exports = { composerFixture, user };
