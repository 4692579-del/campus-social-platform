// 在微信开发者工具的管理员账号调试窗口 Console 中执行本文件全文。
// 先创建私有 account_ids 集合并部署 userService。普通账号没有执行权限。
(async () => {
  let cursor = '';
  let scanned = 0;
  let assigned = 0;
  for (;;) {
    const response = await wx.cloud.callFunction({ name: 'userService', data: { action: 'backfillAccountIds', cursor } });
    const result = response.result;
    if (!result || !result.success) throw new Error((result && result.message) || '补齐失败，请检查云函数和集合配置');
    const progress = result.migration;
    if (!progress || (!progress.done && progress.nextCursor === cursor)) throw new Error('补齐进度异常，已停止');
    scanned += progress.scanned;
    assigned += progress.assigned;
    console.info(`已检查 ${scanned} 个账号，本次新增 ${assigned} 个ID账号`);
    if (progress.done) {
      console.info('已有账号ID补齐完成。重复执行不会更改已分配的ID账号。');
      return { scanned, assigned };
    }
    cursor = progress.nextCursor;
  }
})().catch(error => { console.error('ID账号补齐未完成：' + error.message); });
