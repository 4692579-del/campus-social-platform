const crypto = require('crypto');
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
function imageType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > MAX_IMAGE_BYTES) return '';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return '';
}
function createSquareImageProcessor(cloud) {
  return async (files, { userId, postId }) => {
    const result = new Array(files.length);
    let next = 0;
    // 同时最多处理三张，避免九张原图同时占用云函数内存。
    const tasks = await Promise.allSettled(Array.from({ length: Math.min(3, files.length) }, async () => {
      while (next < files.length) {
        const index = next++;
        let bytes;
        try { bytes = (await cloud.downloadFile({ fileID: files[index] })).fileContent; }
        catch (error) { throw Object.assign(new Error('图片读取失败，请重新选择后发布'), { code: 'INVALID_IMAGES' }); }
        const type = imageType(bytes);
        if (!type) throw Object.assign(new Error('图片格式无效或超过 5MB，请重新选择'), { code: 'INVALID_IMAGES' });
        const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24);
        // 公开成品由服务端写入，客户端不能在发布后替换图片。
        const cloudPath = `square-media/${userId}/${postId}/${index}-${digest}.${type}`;
        result[index] = (await cloud.uploadFile({ cloudPath, fileContent: bytes })).fileID;
      }
    }));
    const failed = tasks.find(task => task.status === 'rejected');
    if (failed) throw failed.reason;
    return result;
  };
}
module.exports = { createSquareImageProcessor, imageType, MAX_IMAGE_BYTES };
