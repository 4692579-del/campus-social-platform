const cloud = require('wx-server-sdk');
const { createUserService } = require('./service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const service = createUserService(cloud.database({ throwOnNotFound: false }), {
  proofStorageReady: process.env.CERTIFICATION_UPLOAD_ENABLED === 'true',
  uploadProof: async options => (await cloud.uploadFile(options)).fileID,
  getProofUrl: async fileID => {
    const result = await cloud.getTempFileURL({ fileList: [{ fileID, maxAge: 120 }] });
    const file = result.fileList && result.fileList[0];
    return file && file.status === 0 ? file.tempFileURL : '';
  },
  verifyProof: async fileID => {
    try {
      const result = await cloud.downloadFile({ fileID });
      return Buffer.isBuffer(result.fileContent) && result.fileContent.length >= 16 && result.fileContent.length <= 1024 * 1024;
    } catch (error) { return false; }
  },
});

// 客户端传来的 openid、角色或用户 ID 都不作为身份依据。
exports.main = async (event) => {
  const context = cloud.getWXContext();
  return service(event, { openid: context.OPENID, env: context.ENV });
};
