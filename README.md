# 校园社交生活平台

项目使用微信原生小程序与微信云开发。当前第一阶段已实现校园首页、我的页面、微信身份建档、昵称与头像编辑；保留 QuickStart 页面便于排查基础云能力。

首次运行需创建 `users` 集合、配置仅管理员读写权限，并部署 `cloudfunctions/userService`。详细操作、数据字段与验收用例见 [第一阶段部署与验收](docs/第一阶段部署与验收.md)。尚未部署时首页仍可浏览，但不能登录或保存资料。

本地测试：`node --test tests/user-service.test.js tests/user-client.test.js`。测试不会连接真实云环境。

## 保留的云开发 quickstart 说明

这是云开发的快速启动指引，其中演示了如何上手使用云开发的三大基础能力：

- 数据库：一个既可在小程序前端操作，也能在云函数中读写的 JSON 文档型数据库
- 文件存储：在小程序前端直接上传/下载云端文件，在云开发控制台可视化管理
- 云函数：在云端运行的代码，微信私有协议天然鉴权，开发者只需编写业务逻辑代码

## 参考文档

- [云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)

