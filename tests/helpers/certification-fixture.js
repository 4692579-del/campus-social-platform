const assert = require('node:assert/strict');
const { createUserService } = require('../../cloudfunctions/userService/service');

// 合成材料只用于验证流程，绝不包含真实证件信息。
const proofBase64 = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32)]).toString('base64');
const application = (extra = {}) => ({ schoolName: '测试大学', realName: '测试同学', studentNumber: '00123456',
  proofBase64, requestId: 'test-request-00000001', ...extra });

function fixture(options = {}) {
  const tables = new Map(['users', 'certification_applications', 'certification_reviews'].map(name => [name, new Map()]));
  const uploads = [], proofRequests = [], queries = [];
  const hooks = { beforeTransaction: options.beforeTransaction };
  let tail = Promise.resolve();
  function collection(name, source, inTransaction = false) {
    assert.ok(source.has(name), '集合必须由部署者创建');
    const records = source.get(name);
    return {
      where(condition) {
        const ordering = [];
        let offset = 0, limit = Infinity;
        const query = {
          orderBy: (field, direction) => { ordering.push([field, direction]); return query; },
          skip: value => { offset = value; return query; },
          limit: value => { limit = value; return query; },
          get: async () => {
            queries.push({ name, condition, ordering, offset, limit });
            const rows = [...records.values()].filter(row => Object.entries(condition).every(([key, value]) => row[key] === value));
            rows.sort((a, b) => {
              for (const [field, direction] of ordering) {
                const difference = a[field] === b[field] ? 0 : a[field] < b[field] ? -1 : 1;
                if (difference) return direction === 'desc' ? -difference : difference;
              }
              return 0;
            });
            return { data: rows.slice(offset, offset + limit).map(row => ({ ...row })) };
          },
        };
        return query;
      },
      add: async ({ data }) => {
        if (records.has(data._id)) throw new Error('duplicate');
        records.set(data._id, { ...data });
      },
      doc: id => ({
        get: async () => ({ data: records.has(id) ? { ...records.get(id) } : null }),
        set: async ({ data }) => {
          if (inTransaction && options.failCollection === name) throw new Error('simulated write failure');
          records.set(id, { ...data, _id: id });
        },
        update: async ({ data }) => {
          if (inTransaction && (options.failCollection === name || (name === 'users' && options.failUserUpdate))) throw new Error('simulated write failure');
          assert.ok(records.has(id));
          records.set(id, { ...records.get(id), ...data });
        },
      }),
    };
  }
  const db = {
    collection: name => collection(name, tables),
    serverDate: () => '2026-11-14T10:00:00.000Z',
    async runTransaction(callback) {
      let release;
      const previous = tail;
      tail = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        if (hooks.beforeTransaction) hooks.beforeTransaction(tables);
        const snapshot = new Map([...tables].map(([name, rows]) => [name, new Map([...rows].map(([id, row]) => [id, { ...row }]))]));
        const result = await callback({ collection: name => collection(name, snapshot, true) });
        for (const [name, rows] of snapshot) {
          tables.get(name).clear();
          for (const [id, row] of rows) tables.get(name).set(id, row);
        }
        return { result, errMsg: 'runTransaction:ok' };
      } finally { release(); }
    },
  };
  const handle = createUserService(db, {
    proofStorageReady: options.ready !== false,
    uploadProof: async value => {
      uploads.push(value);
      if (options.failUpload) throw new Error('upload unavailable');
      return 'cloud://test.bucket/' + value.cloudPath;
    },
    getProofUrl: async file => { proofRequests.push(file); return options.proofUrl || 'https://example.com/short-lived-proof?test-only'; },
    verifyProof: async file => { proofRequests.push(file); return options.proofAvailable !== false; },
  });
  const alice = { openid: 'alice', env: 'test' }, bob = { openid: 'bob', env: 'test' }, admin = { openid: 'admin', env: 'test' };
  const f = { handle, alice, bob, admin, uploads, proofRequests, queries, hooks,
    users: tables.get('users'), applications: tables.get('certification_applications'), reviews: tables.get('certification_reviews'),
    async login(identity = alice) { return (await handle({ action: 'login' }, identity)).user; },
    async loginAdmin(identity = admin) { const account = await f.login(identity); f.users.get(account._id).role = 'admin'; return account; },
    submit(value = application(), identity = alice) { return handle({ action: 'submitCertification', application: value }, identity); },
  };
  return f;
}

module.exports = { fixture, application };
