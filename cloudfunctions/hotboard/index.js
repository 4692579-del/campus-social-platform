const cloud = require('wx-server-sdk');
const { createHotboardService } = require('./service');
const { createUapiClient } = require('./uapi');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
// API Key 仅从云函数环境变量读取；不接收客户端密钥、URL 或缓存绕过参数。
exports.main = createHotboardService(cloud.database({ throwOnNotFound: false }), createUapiClient());
