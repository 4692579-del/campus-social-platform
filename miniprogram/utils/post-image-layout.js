// 仅缓存公开动态图片的已解码尺寸，不保存图片、临时URL或账号状态。
const sizes = new Map(), MAX_ENTRIES = 256;
const round = value => Math.round(value * 100) / 100;
function rememberSize(file, width, height) {
  if (typeof file !== 'string' || !file || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 1000000 || height > 1000000) return false;
  const previous = sizes.get(file);
  if (previous && previous.width === width && previous.height === height) return false;
  sizes.delete(file); sizes.set(file, { width, height });
  if (sizes.size > MAX_ENTRIES) sizes.delete(sizes.keys().next().value);
  return true;
}
function imageLayout(files = [], detail = false) {
  const available = detail ? 718 : 628;
  const size = sizes.get(files[0]), ratio = size ? size.width / size.height : 4 / 3;
  if (files.length <= 1) {
    const width = Math.min(available, 840 * ratio);
    return { galleryWidth: Math.max(.1, round(width / available * 100)), galleryHeight: Math.max(1, round(width / ratio)) };
  }
  // 44rpx露出下一项，每项右侧12rpx留白；整组高度只由首图确定，滑动不改高。
  const frameWidth = available - 44 - 12;
  return { galleryWidth: 100, galleryHeight: round(Math.max(360, Math.min(640, frameWidth / ratio))) };
}
module.exports = { rememberSize, imageLayout };
