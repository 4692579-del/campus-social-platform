const users = require('./user');
const { token } = require('../utils/post-view');
const MAX_IMAGES = 9, MAX_BYTES = 5 * 1024 * 1024;
const urls = new Map();
let urlOwner;
const native = (name, options) => new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }));
function account() { const user = users.getCachedUser(); return `${user ? user._id : 'guest'}:${users.getSessionVersion()}`; }
function unchanged(key) {
  if (key !== account()) throw Object.assign(new Error('登录状态已变更，请重新操作'), { code: 'SESSION_CHANGED' });
}
function ownedSource(fileID, user) {
  return typeof fileID === 'string' && fileID.startsWith('cloud://') &&
    fileID.slice(fileID.indexOf('/', 8) + 1).startsWith(`square-uploads/${user._id}/`);
}
async function chooseImages(remaining) {
  if (remaining < 1) return [];
  const owner = account();
  const source = await native('showActionSheet', { itemList: ['从相册选择', '拍照'] });
  const result = await native('chooseMedia', { count: Math.min(MAX_IMAGES, remaining), mediaType: ['image'],
    sourceType: [source.tapIndex === 1 ? 'camera' : 'album'], sizeType: ['compressed'] });
  unchanged(owner);
  const selected = [];
  for (const file of (result.tempFiles || []).slice(0, remaining)) {
    let path = file.tempFilePath, info = await native('getImageInfo', { src: path });
    if (file.size > MAX_BYTES || Math.max(info.width, info.height) > 2048) {
      const scale = Math.min(1, 2048 / Math.max(info.width, info.height));
      path = (await native('compressImage', { src: path, quality: 75, compressedWidth: Math.max(1, Math.round(info.width * scale)) })).tempFilePath;
      info = await native('getImageInfo', { src: path });
    }
    const size = (await native('getFileInfo', { filePath: path })).size;
    const type = String(info.type || '').toLowerCase().replace('jpeg', 'jpg');
    if (!['jpg', 'png', 'webp'].includes(type) || !size || size > MAX_BYTES) throw new Error('请选择 JPG、PNG 或 WebP 图片，压缩后每张不超过 5MB');
    unchanged(owner);
    selected.push({ key: token(), path, fileID: '', type, width: info.width, height: info.height });
  }
  return selected;
}
async function uploadImages(images, onUploaded = () => {}, onProgress = () => {}) {
  const user = users.getCachedUser(), owner = account();
  if (!user) throw new Error('请先登录后上传图片');
  if (images.length > MAX_IMAGES) throw new Error('一次最多发布 9 张图片');
  const files = images.map(image => ({ ...image }));
  let next = 0, completed = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(2, files.length) }, async () => {
    while (next < files.length) {
      const index = next++, image = files[index];
      unchanged(owner);
      if (!ownedSource(image.fileID, user)) {
        if (!image.path || !/^[A-Za-z0-9_-]+$/.test(image.key) || !['jpg', 'png', 'webp'].includes(image.type)) throw new Error('图片已失效，请重新选择');
        const result = await wx.cloud.uploadFile({ cloudPath: `square-uploads/${user._id}/${image.key}.${image.type}`, filePath: image.path });
        unchanged(owner);
        if (!ownedSource(result.fileID, user)) throw new Error('图片上传未确认，请重试');
        image.fileID = result.fileID;
        onUploaded(index, result.fileID);
      }
      onProgress(++completed, files.length);
    }
  }));
  unchanged(owner);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return files.map(image => image.fileID);
}
async function previewImages(files, current) {
  const owner = account();
  if (urlOwner !== owner) { urls.clear(); urlOwner = owner; }
  const missing = [...new Set(files.filter(file => file.startsWith('cloud://') && (!urls.has(file) || urls.get(file).until < Date.now())))];
  for (let start = 0; start < missing.length; start += 50) {
    const result = await wx.cloud.getTempFileURL({ fileList: missing.slice(start, start + 50) });
    unchanged(owner);
    for (const file of result.fileList || []) if (file.status === 0 && file.tempFileURL) urls.set(file.fileID, { url: file.tempFileURL, until: Date.now() + 5 * 60000 });
  }
  unchanged(owner);
  const resolved = files.map(file => file.startsWith('cloud://') ? urls.get(file) && urls.get(file).url : file);
  if (resolved.some(file => !file)) throw new Error('图片暂时无法查看，请稍后重试');
  return native('previewImage', { urls: resolved, current: resolved[Math.max(0, files.indexOf(current))] });
}
function discardUploads(files) {
  const user = users.getCachedUser();
  const owned = user ? [...new Set(files.filter(file => ownedSource(file, user)))] : [];
  if (owned.length) return wx.cloud.deleteFile({ fileList: owned }).catch(() => {});
  return Promise.resolve();
}
module.exports = { chooseImages, uploadImages, previewImages, discardUploads, MAX_IMAGES };
