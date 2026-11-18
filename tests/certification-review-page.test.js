const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const view = require('../miniprogram/utils/certification-view');

const detail = (extra = {}) => ({ _id: 'cert_u_' + 'a'.repeat(32), revision: 1, realName: '测试同学', schoolName: '测试大学',
  studentNumber: '001234', status: 'pending', hasProof: true, submittedAt: '2026-11-14T10:00:00Z', ...extra });
const denied = () => Object.assign(new Error('仅管理员可以审核'), { code: 'FORBIDDEN' });

function fixture(kind = 'admin-certification-detail', options = {}) {
  let definition;
  const reviews = [], confirmations = [], listing = [], navigation = [];
  const service = {
    restore: async () => ({ role: 'admin' }),
    getCertificationDetail: async () => detail(),
    getCertificationProof: async () => ({ url: 'https://example.com/proof', revision: 1 }),
    reviewCertification: async (id, revision, review) => {
      reviews.push({ id, revision, review });
      return detail({ status: review.decision, approvedSchoolName: review.schoolName || '', rejectionReason: review.rejectionReason || '' });
    },
    listCertifications: async (status, offset) => {
      listing.push({ status, offset });
      return { items: [detail()], hasMore: false, nextOffset: 1 };
    },
    ...options.service,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../miniprogram/pages/${kind}/index.js`), 'utf8'), {
    Page: value => { definition = value; }, require: name => name.includes('services/user') ? service : view,
    wx: {
      showModal: value => { confirmations.push(value); value.success({ confirm: options.confirm !== false }); },
      stopPullDownRefresh() {}, previewImage() {}, navigateBack() {}, switchTab() {}, redirectTo() {},
      navigateTo: value => navigation.push(value.url),
    },
  });
  const page = { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
  if (page.onLoad) page.onLoad({ id: detail()._id });
  return { page, reviews, confirmations, listing, service, navigation };
}

async function inspectProof(f) {
  await f.page.loadDetail(); await f.page.loadProof();
  f.page.onProofLoaded({ currentTarget: { dataset: { url: f.page.data.proofUrl } } });
}
const approval = () => ({ detail: { value: { schoolName: ' 核准测试大学 ' } } });
const rejection = reason => ({ detail: { value: { rejectionReason: reason } } });

test('详情鉴权失败时清除旧详情和材料，不保留伪造管理员缓存', async () => {
  const f = fixture(undefined, { service: { getCertificationDetail: async () => { throw denied(); } } });
  f.page.data.detail = detail(); f.page.data.proofUrl = 'https://example.com/old';
  await f.page.loadDetail();
  assert.equal(f.page.data.detail, null); assert.equal(f.page.data.proofUrl, '');
  assert.match(f.page.data.error, /仅管理员/);
});

test('通过前需要成功加载材料，使用表单学校名称，确认后只提交一次', async () => {
  const f = fixture(); await f.page.loadDetail();
  await f.page.approve(approval()); assert.equal(f.reviews.length, 0); assert.match(f.page.data.error, /材料/);
  await f.page.loadProof();
  assert.equal(f.page.data.proofLoaded, false);
  f.page.onProofLoaded({ currentTarget: { dataset: { url: 'https://example.com/old' } } });
  assert.equal(f.page.data.proofLoaded, false);
  f.page.onProofLoaded({ currentTarget: { dataset: { url: f.page.data.proofUrl } } });
  await f.page.approve(approval());
  assert.equal(f.reviews.length, 1); assert.equal(f.reviews[0].revision, 1);
  assert.equal(f.reviews[0].review.schoolName, '核准测试大学');
  assert.match(f.confirmations[0].content, /核准测试大学/);
  assert.equal(f.page.data.detail.status, 'approved'); assert.equal(f.page.data.proofUrl, '');
  await f.page.approve(approval()); assert.equal(f.reviews.length, 1);
});

test('取消审核确认不发送请求，驳回需填写具体原因而不要求材料加载成功', async () => {
  const cancel = fixture(undefined, { confirm: false }); await inspectProof(cancel); await cancel.page.approve(approval());
  assert.equal(cancel.reviews.length, 0); assert.equal(cancel.page.data.confirming, false);
  const f = fixture(); await f.page.loadDetail();
  await f.page.reject(rejection(' ')); assert.equal(f.reviews.length, 0);
  await f.page.reject(rejection(' 材料不清晰，请重新提交 '));
  assert.equal(f.reviews[0].review.rejectionReason, '材料不清晰，请重新提交');
  assert.equal(f.page.data.detail.status, 'rejected');
});

test('材料接口撤权立即清空详情；图片加载失败不能通过', async () => {
  const f = fixture(); await inspectProof(f);
  f.page.onProofError({ currentTarget: { dataset: { url: f.page.data.proofUrl } } });
  await f.page.approve(approval()); assert.equal(f.reviews.length, 0);
  f.service.getCertificationProof = async () => { throw denied(); };
  await f.page.loadProof();
  assert.equal(f.page.data.detail, null); assert.equal(f.page.data.proofUrl, '');
});

test('审核超时后读取最新结果，不自动重发审核，也不继续显示可点击的旧材料', async () => {
  const f = fixture(); await inspectProof(f);
  let attempts = 0;
  f.service.reviewCertification = async () => { attempts++; throw new Error('连接超时'); };
  f.service.getCertificationDetail = async () => detail({ status: 'approved', approvedSchoolName: '核准测试大学' });
  await f.page.approve(approval());
  assert.equal(attempts, 1); assert.equal(f.page.data.detail.status, 'approved');
  assert.equal(f.page.data.proofUrl, ''); assert.match(f.page.data.notice, /最新审核结果/);
});

test('重复审核或旧版本错误后重新读取，必须重新核对新版本材料', async () => {
  const f = fixture(); await inspectProof(f);
  f.service.reviewCertification = async () => { throw Object.assign(new Error('申请已变化'), { code: 'STALE_APPLICATION' }); };
  f.service.getCertificationDetail = async () => detail({ revision: 2 });
  await f.page.approve(approval());
  assert.equal(f.page.data.detail.revision, 2); assert.equal(f.page.data.proofLoaded, false);
  assert.match(f.page.data.notice, /重新核对/);
});

test('审核和确认查询都失败时暂停按钮；确认查询被拒绝时清空私人信息', async () => {
  for (const error of [new Error('连接失败'), denied()]) {
    const f = fixture(); await inspectProof(f);
    f.service.reviewCertification = async () => { throw new Error('超时'); };
    f.service.getCertificationDetail = async () => { throw error; };
    await f.page.approve(approval());
    assert.equal(f.page.data.reviewBlocked, true); assert.equal(f.page.data.proofUrl, '');
    if (error.code) assert.equal(f.page.data.detail, null);
    else assert.match(f.page.data.error, /超时/);
  }
});

test('页面隐藏后迟到的材料或详情响应不重新显示私人信息', async () => {
  const f = fixture(); await f.page.loadDetail();
  let resolve;
  f.service.getCertificationProof = () => new Promise(done => { resolve = done; });
  const pending = f.page.loadProof(); f.page.onHide();
  resolve({ url: 'https://example.com/late', revision: 1 }); await pending;
  assert.equal(f.page.data.detail, null); assert.equal(f.page.data.proofUrl, '');
  await f.page.loadDetail(); assert.equal(f.page.data.detail.revision, 1);
});

test('列表支持分页、筛选和详情跳转，切换筛选从第一页重读', async () => {
  const f = fixture('admin-certifications');
  f.service.listCertifications = async (status, offset) => {
    f.listing.push({ status, offset });
    return { items: [detail({ _id: 'item-' + offset, status })], hasMore: offset === 0, nextOffset: offset + 20 };
  };
  await f.page.refresh(); await f.page.loadMore();
  assert.equal(f.page.data.items.length, 2); assert.equal(f.listing[1].offset, 20);
  f.page.changeStatus({ currentTarget: { dataset: { status: 'rejected' } } });
  // changeStatus 触发异步刷新，等待当前 Promise 队列完成。
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.page.data.items.length, 1); assert.equal(f.listing[2].offset, 0);
  assert.equal(f.listing[2].status, 'rejected');
  f.page.openDetail({ currentTarget: { dataset: { id: detail()._id } } });
  assert.match(f.navigation[0], /admin-certification-detail/);
});

test('加载更多时账号退出或权限被撤销，旧列表立即清空', async () => {
  for (const logout of [false, true]) {
    const f = fixture('admin-certifications'); await f.page.refresh();
    f.page.data.hasMore = true;
    if (logout) f.service.restore = async () => null;
    else f.service.listCertifications = async () => { throw denied(); };
    await f.page.loadMore();
    assert.equal(f.page.data.items.length, 0); assert.equal(f.page.data.authorized, false);
  }
});

test('隐藏列表后忽略迟到的请求，重新显示时可以再次请求', async () => {
  const f = fixture('admin-certifications');
  let resolve;
  f.service.listCertifications = () => new Promise(done => { resolve = done; });
  const pending = f.page.refresh(); await new Promise(done => setImmediate(done));
  f.page.onHide(); resolve({ items: [detail()], hasMore: false, nextOffset: 1 }); await pending;
  assert.equal(f.page.data.items.length, 0);
  f.service.listCertifications = async () => ({ items: [], hasMore: false, nextOffset: 0 });
  await f.page.refresh(); assert.equal(f.page.data.authorized, true);
});

test('申请撤回后，材料读取和审核失败都清空已打开详情，刷新列表移除原条目', async () => {
  const removed = () => Object.assign(new Error('申请已撤回或不存在，请刷新列表'), { code: 'APPLICATION_NOT_FOUND' });
  const proof = fixture(); await inspectProof(proof);
  proof.service.getCertificationProof = async () => { throw removed(); };
  await proof.page.loadProof();
  assert.equal(proof.page.data.detail, null); assert.equal(proof.page.data.proofUrl, '');
  const review = fixture(); await inspectProof(review);
  review.service.reviewCertification = async () => { throw removed(); };
  await review.page.approve(approval());
  assert.equal(review.page.data.detail, null); assert.equal(review.page.data.proofUrl, '');
  const listing = fixture('admin-certifications'); await listing.page.refresh();
  assert.equal(listing.page.data.items.length, 1);
  listing.service.listCertifications = async () => ({ items: [], hasMore: false, nextOffset: 0 });
  await listing.page.refresh(); assert.equal(listing.page.data.items.length, 0);
});
