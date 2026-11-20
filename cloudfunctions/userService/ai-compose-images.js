const { aiError } = require('./ai-errors');
const { imageType } = require('./square-images');

// 发布编辑器专用：仅解析当前真实账号的私有上传，绝不复制到公开成品目录。
function createComposeImageResolver(cloud, options = {}) {
  return async (files, user, identity) => {
    let timer, stopped = false;
    try {
      if (!Array.isArray(files) || !files.length || files.length > 9 || new Set(files).size !== files.length ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(user && user._id || '') || !/^[A-Za-z0-9_-]+$/.test(identity && identity.env || '')) throw new Error();
      const prefix = `square-uploads/${user._id}/`;
      for (const file of files) {
        if (typeof file !== 'string' || file.length > 512 || !file.startsWith(`cloud://${identity.env}.`)) throw new Error();
        const filePath = file.slice(file.indexOf('/', 8) + 1);
        if (!filePath.startsWith(prefix) || !/^[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(filePath.slice(prefix.length))) throw new Error();
      }
      const resolve = async () => {
        let next = 0;
        // 按文件签名和5MB上限校验原件，同时最多读取两张，避免九图并发占满内存。
        await Promise.all(Array.from({ length: Math.min(2, files.length) }, async () => {
          while (!stopped && next < files.length) {
            const bytes = (await cloud.downloadFile({ fileID: files[next++] })).fileContent;
            if (stopped) return;
            if (!imageType(bytes)) throw new Error();
          }
        }));
        if (stopped) throw new Error();
        const result = await cloud.getTempFileURL({ fileList: files.map(fileID => ({ fileID, maxAge: 120 })) });
        const byId = new Map((result.fileList || []).map(file => [file.fileID, file]));
        return files.map(fileID => {
          const file = byId.get(fileID);
          if (!file || file.status !== 0 || typeof file.tempFileURL !== 'string' || file.tempFileURL.length > 8192) throw new Error();
          const url = new URL(file.tempFileURL);
          if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' ||
            !/(?:\.tcb\.qcloud\.la|\.myqcloud\.com|\.tcloudbaseapp\.com|\.tcloudbase\.com)$/.test(url.hostname)) throw new Error();
          return url.href;
        });
      };
      return await Promise.race([resolve(), new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(aiError('AI_IMAGES_UNAVAILABLE')), options.timeoutMs || 8000);
      })]);
    } catch (error) { throw aiError('AI_IMAGES_UNAVAILABLE'); }
    finally { stopped = true; clearTimeout(timer); }
  };
}
module.exports = { createComposeImageResolver };
