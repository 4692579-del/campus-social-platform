const users = require('./user');
const { token } = require('../utils/post-view');
const MAX_IMAGES = 9, MAX_BYTES = 5 * 1024 * 1024;
const MAX_POST_MEDIA = 3;
const MiB = 1024 * 1024, VIDEO_COMPRESSION_TARGET = 20 * MiB, MAX_VIDEO_UPLOAD = 100 * MiB;
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', '3gp', '3g2', 'mkv', 'webm', 'avi', 'mpeg', 'mpg', 'ts', 'mts', 'm2ts', 'flv', 'wmv', 'asf', 'ogv'];
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
function isVideo(file) {
  if (file.fileType) return file.fileType === 'video';
  return file.duration > 0 || VIDEO_EXTENSIONS.includes(String(file.tempFilePath).split('.').pop().toLowerCase());
}
async function prepareVideo(file, owner) {
  let path = file.tempFilePath;
  let { size } = await native('getFileInfo', { filePath: path });
  if (!size) throw new Error('无法读取视频，请重新选择');
  if (size > VIDEO_COMPRESSION_TARGET && typeof wx.compressVideo === 'function') {
    for (const quality of ['medium', 'low']) {
      try {
        const compressed = await native('compressVideo', { src: file.tempFilePath, quality });
        if (compressed.tempFilePath) {
          const info = await native('getFileInfo', { filePath: compressed.tempFilePath });
          if (info.size > 0 && info.size < size) { path = compressed.tempFilePath; size = info.size; }
        }
      } catch (_) { /* 手机不能压缩的格式交给云端处理。 */ }
      unchanged(owner);
      if (size <= VIDEO_COMPRESSION_TARGET) break;
    }
  }
  if (size > MAX_VIDEO_UPLOAD) throw new Error('视频自动压缩后仍过大，请选择较短的视频');
  return path;
}
async function chooseImages(remaining, mixed = false) {
  if (remaining < 1) return [];
  const owner = account();
  const itemList = ['从相册选择', '拍照'];
  if (mixed && typeof wx.chooseMessageFile === 'function') itemList.push('从聊天文件选视频');
  const source = await native('showActionSheet', { itemList });
  const count = Math.min(mixed ? MAX_POST_MEDIA : MAX_IMAGES, remaining);
  const fromChat = itemList.length === 3 && source.tapIndex === 2;
  const result = fromChat ? await native('chooseMessageFile', { count, type: 'file', extension: VIDEO_EXTENSIONS }) :
    await native('chooseMedia', { count, mediaType: [mixed && source.tapIndex !== 1 ? 'mix' : 'image'],
      sourceType: [source.tapIndex === 1 ? 'camera' : 'album'], sizeType: ['compressed'] });
  unchanged(owner);
  const selected = [];
  for (const selectedFile of (result.tempFiles || []).slice(0, remaining)) {
    const file = fromChat ? { ...selectedFile, tempFilePath: selectedFile.path, fileType: 'video' } : selectedFile;
    if (mixed && isVideo(file)) {
      const path = await prepareVideo(file, owner);
      const key = token();
      let poster;
      if (file.thumbTempFilePath) {
        try {
          const info = await native('getImageInfo', { src: file.thumbTempFilePath });
          const type = String(info.type || '').toLowerCase().replace('jpeg', 'jpg');
          if (['jpg', 'png', 'webp'].includes(type)) {
            const { size: coverSize } = await native('getFileInfo', { filePath: file.thumbTempFilePath });
            if (coverSize > 0 && coverSize <= MAX_BYTES) poster = { key: `${key}-poster`, path: file.thumbTempFilePath, type };
          }
        } catch (_) { /* 没有有效封面时使用通用播放卡片。 */ }
      }
      unchanged(owner);
      selected.push({ key, path, fileID: '', type: 'mp4', ...(poster ? { poster } : {}) });
      continue;
    }
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
async function uploadImages(images, onUploaded = () => {}, onProgress = () => {}, allowVideo = false) {
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
        if (!image.path || !/^[A-Za-z0-9_-]+$/.test(image.key) || !(['jpg', 'png', 'webp'].includes(image.type) || allowVideo && image.type === 'mp4')) throw new Error('媒体已失效，请重新选择');
        // 草稿继续用 mp4 标记视频项，私有原件不承诺容器格式。
        const suffix = image.type === 'mp4' ? 'video' : image.type;
        const result = await wx.cloud.uploadFile({ cloudPath: `square-uploads/${user._id}/${image.key}.${suffix}`, filePath: image.path });
        unchanged(owner);
        if (!ownedSource(result.fileID, user)) throw new Error('媒体上传未确认，请重试');
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
async function resolveFiles(files) {
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
  if (resolved.some(file => !file)) throw new Error('媒体暂时无法查看，请稍后重试');
  return resolved;
}
async function previewImages(files, current) {
  const resolved = await resolveFiles(files);
  return native('previewImage', { urls: resolved, current: resolved[Math.max(0, files.indexOf(current))] });
}
async function resolveVideoPlayback(fileID) {
  const [url] = await resolveFiles([fileID]);
  return url;
}
async function previewMedia(items, index) {
  if (!items[index]) return;
  if (!items.some(item => item.type === 'video')) return previewImages(items.map(item => item.fileID), items[index].fileID);
  if (typeof wx.previewMedia !== 'function') throw new Error('请更新微信后预览视频');
  const files = [...new Set(items.flatMap(item => [item.fileID, ...(item.poster ? [item.poster] : [])]))];
  const urls = new Map(files.map((file, at) => [file, at]));
  const resolved = await resolveFiles(files);
  return native('previewMedia', { current: index, sources: items.map(item => ({
    url: resolved[urls.get(item.fileID)], type: item.type, ...(item.poster ? { poster: resolved[urls.get(item.poster)] } : {}),
  })) });
}
function discardUploads(files) {
  const user = users.getCachedUser();
  const owned = user ? [...new Set(files.filter(file => ownedSource(file, user)))] : [];
  if (owned.length) return wx.cloud.deleteFile({ fileList: owned }).catch(() => {});
  return Promise.resolve();
}
module.exports = { chooseImages, uploadImages, previewImages, previewMedia, resolveVideoPlayback, discardUploads, MAX_IMAGES, MAX_POST_MEDIA };
