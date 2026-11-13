const cloud = require('wx-server-sdk');
const { createUserService } = require('./service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const service = createUserService(cloud.database());

// 客户端传来的 openid、角色或用户 ID 都不作为身份依据。
exports.main = async (event) => {
  const context = cloud.getWXContext();
  return service(event, { openid: context.OPENID, env: context.ENV });
};
