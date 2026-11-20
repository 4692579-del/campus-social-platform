const { aiError } = require('./ai-errors');

// 只读取已发布记录中的服务端公开成品；不接收客户端图片地址或私有原件。
function createAIImageResolver(cloud, options = {}) {
  return async (post, identity) => {
    let timer;
    try {
      const files = post.images;
      const comment = options.comment === true;
      if (!Array.isArray(files) || !files.length || files.length > (comment ? 3 : 9) || new Set(files).size !== files.length ||
        !identity || !/^[A-Za-z0-9_-]+$/.test(identity.env || '') ||
        !(comment ? /^[rc]_[a-f0-9]{40}$/ : /^p_[a-f0-9]{40}$/).test(post._id || '') || !/^[A-Za-z0-9_-]{1,80}$/.test(post.authorId || '')) throw new Error();
      const prefix = `square-media/${post.authorId}/${post._id}/`;
      for (const file of files) {
        if (typeof file !== 'string' || file.length > 512 || !file.startsWith(`cloud://${identity.env}.`)) throw new Error();
        const path = file.slice(file.indexOf('/', 8) + 1);
        const filename = comment ? /^[0-2]-[a-f0-9]{24}\.(?:jpg|jpeg|png|webp)$/ : /^[0-8](?:-[a-f0-9]{24})?\.(?:jpg|jpeg|png|webp)$/;
        if (!path.startsWith(prefix) || !filename.test(path.slice(prefix.length))) throw new Error();
      }
      const result = await Promise.race([
        cloud.getTempFileURL({ fileList: files.map(fileID => ({ fileID, maxAge: 120 })) }),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(aiError('AI_IMAGES_UNAVAILABLE')), options.timeoutMs || 8000); }),
      ]);
      const byId = new Map((result.fileList || []).map(file => [file.fileID, file]));
      return files.map(fileID => {
        const file = byId.get(fileID);
        if (!file || file.status !== 0 || typeof file.tempFileURL !== 'string' || file.tempFileURL.length > 8192) throw new Error();
        const url = new URL(file.tempFileURL);
        if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' ||
          !/(?:\.tcb\.qcloud\.la|\.myqcloud\.com|\.tcloudbaseapp\.com|\.tcloudbase\.com)$/.test(url.hostname)) throw new Error();
        return url.href;
      });
    } catch (failure) {
      // SDK错误可能带文件ID、临时签名或地址，只抛出固定安全错误。
      throw aiError('AI_IMAGES_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  };
}

const createAICommentImageResolver = (cloud, options = {}) => createAIImageResolver(cloud, { ...options, comment: true });
module.exports = { createAIImageResolver, createAICommentImageResolver };
