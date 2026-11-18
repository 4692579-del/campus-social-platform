# ID账号部署与补齐

每个账号拥有固定的 8 位随机数字 ID，范围 10000000—99999999，由云端 crypto.randomInt 生成。users.accountId 保存为字符串，不接受客户端修改；用户主键仍由可信 OpenID 派生，不修改已有主键和业务关联。

account_ids 使用 8 位 ID 作为文档主键，保存 userId 与创建时间。号码占用及用户 ID 写入在同一个事务内完成；撞号重新生成。并发或重试不会给同一账号换号。保留停用账号的号码，不回收分配。事务依据：[CloudBase 事务操作](https://docs.cloudbase.net/database/transaction)。

新账号在建档事务中同时分配 ID；已有账号在登录或访问用户服务时自动补齐。也提供管理员批量操作，可为尚未再次登录的全部旧账号（含停用账号）补齐，每次最多 20 个账号，支持分页及重复执行。分配 ID 不改动昵称、认证、创建时间、改名次数或最后改名时间。

## 部署顺序

1. 打开当前云环境 campus-social-dev-d3dmcsfefdcae4 的数据库，新建 **account_ids** 集合。权限设为仅管理端可读写，或自定义规则使用同目录 account-ids.rules.json（read、write 均为 false）。users 继续保持私有，禁止客户端直接写。规则依据：[CloudBase 安全规则](https://docs.cloudbase.net/rule/rule-example)。
2. 先完成集合创建，再右键 cloudfunctions/userService **整个文件夹**，选择“上传并部署：云端安装依赖（不上传 node_modules）”。不需要新增二级索引，使用默认主键索引。
3. 部署成功后重新编译。在“关于你的账号”的信息列表第一项可见“ID账号”，点击复制并提示“已复制ID账号”。

## 一次性补齐全部旧账号

1. 在微信开发者工具切换到已经建档且数据库角色为 admin 的真实微信账号调试窗口，并在小程序中登录。普通学生账号无权限执行；不要通过客户端伪造 role。
2. 打开底部 **调试器 → Console**，复制并执行 [scripts/backfill-account-ids.devtools.js](../scripts/backfill-account-ids.devtools.js) 的全部内容。
3. 等待输出“已有账号ID补齐完成”。输出只包含统计数量，不打印 OpenID 和个人资料。
4. 如中断，修复报错后重新执行即可；已分配 ID 不变。可在数据库 users 确认所有账号都有 accountId，在 account_ids 确认号码对应原 userId。

这是需要在部署后实际执行的云端写入。仅修改或编译本地代码不会补齐远端数据。登录自动补齐只覆盖已经再次登录的账号，不能替代批量补齐全部旧账号。

## 搜索接口

已预留 findUserByAccountId 云函数动作及客户端同名方法。要求调用者已登录，只返回匹配账号的 ID、内部用户主键、昵称、头像及认证标记，不返回 OpenID、姓名学号、证件、生日等资料。未找到、已停用或绑定不一致时返回 null；无效号码返回 INVALID_ACCOUNT_ID。该接口供后续好友搜索使用，本次不包含好友申请页面及好友关系业务。

## 验收

- 不同微信首次登录取得不同的 8 位号码；重复登录、重新编译、退出重登和修改资料均不改变号码。
- 完成批量补齐后，不必让每位旧用户再次登录，就能在 users 看到其 ID。
- 普通账号无法执行 backfillAccountIds，修改资料接口拒绝 accountId 字段。
- “关于你的账号”中 ID账号排在学校之前；复制成功后才显示“已复制ID账号”，失败则提示重试。
