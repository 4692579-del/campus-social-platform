const assert = require('node:assert/strict');
const { createUserService } = require('../../cloudfunctions/userService/service');

// 合成材料只用于验证流程，绝不包含真实证件信息。
const proofBase64 = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32)]).toString('base64');
const application = (extra = {}) => ({ schoolName: '测试大学', realName: '测试同学', studentNumber: '00123456',
  proofBase64, requestId: 'test-request-00000001', ...extra });

function fixture(options = {}) {
  const tables = new Map(['user_follows', 'users', 'account_ids', 'certification_applications', 'certification_reviews', 'square_posts', 'square_replies', 'square_interactions', 'square_reports', 'square_reply_children', 'square_comment_states', 'square_ai_jobs'].map(name => [name, new Map()]));
  const uploads = [], proofRequests = [], queries = [], docReads = [];
  const hooks = { beforeTransaction: options.beforeTransaction };
  let tail = Promise.resolve(), transactionReads = 0;
  function matches(row, condition) {
    return Object.entries(condition).every(([key, value]) => {
      if (!value || !value.operation) return row[key] === value;
      if (value.operation === 'regex') return typeof row[key] === 'string' && new RegExp(value.regexp, value.options).test(row[key]);
      if (value.operation === 'exists') return Object.hasOwn(row, key) === value.value;
      if (value.operation === 'lt') return row[key] < value.value;
      if (value.operation === 'gt') return row[key] > value.value;
      if (value.operation === 'in') return value.value.includes(row[key]);
      throw new Error('未实现的查询条件');
    });
  }
  function collection(name, source, inTransaction = false) {
    assert.ok(source.has(name), '集合必须由部署者创建');
    const records = source.get(name);
    return {
      aggregate() {
        let condition = {}, grouping;
        const pipeline = {
          match(value) { condition = value; return pipeline; },
          group(value) { grouping = value; return pipeline; },
          async end() {
            if (options.readError && options.readError.collection === name) throw new Error('aggregate read failed');
            queries.push({ name, condition, aggregate: true });
            const rows = [...records.values()].filter(row => matches(row, condition));
            const groups = new Map();
            for (const row of rows) {
              const id = typeof grouping._id === 'string' && grouping._id.startsWith('$') ? row[grouping._id.slice(1)] : grouping._id;
              if (!groups.has(id)) groups.set(id, []);
              groups.get(id).push(row);
            }
            return { list: [...groups].map(([id, members]) => {
              const total = { _id: id };
              for (const [key, value] of Object.entries(grouping)) if (key !== '_id') {
                assert.equal(value.operation, 'sum');
                total[key] = members.reduce((sum, row) => sum + (typeof row[value.field.slice(1)] === 'number' ? row[value.field.slice(1)] : 0), 0);
              }
              return total;
            }) };
          },
        };
        return pipeline;
      },
      where(condition) {
        const ordering = [];
        let offset = 0, limit = Infinity;
        const query = {
          count: async () => ({ total: [...records.values()].filter(row => matches(row, condition)).length }),
          orderBy: (field, direction) => { ordering.push([field, direction]); return query; },
          skip: value => { offset = value; return query; },
          limit: value => { limit = value; return query; },
          get: async () => {
            if (options.readError && options.readError.collection === name) throw Object.assign(new Error(options.readError.message || 'read failed'), { code: options.readError.code });
            queries.push({ name, condition, ordering, offset, limit });
            const rows = [...records.values()].filter(row => matches(row, condition));
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
        query.update = async ({ data }) => {
          if (options.beforeConditionalUpdate) options.beforeConditionalUpdate(records, condition);
          let updated = 0;
          for (const [id, row] of records) {
            if (!Object.entries(condition).every(([key, value]) => row[key] === value)) continue;
            records.set(id, { ...row, ...data });
            updated += 1;
          }
          return { stats: { updated } };
        };
        return query;
      },
      add: async ({ data }) => {
        if (records.has(data._id)) throw new Error('duplicate');
        records.set(data._id, { ...data });
      },
      doc: id => ({
        get: async () => {
          docReads.push({ name, id, inTransaction });
          if (inTransaction && hooks.serialTransactionReads) {
            if (transactionReads) throw Object.assign(new Error('Concurrent reads in one transaction'), { code: 'TRANSACTION_CONCURRENT_READ' });
            transactionReads++;
            try { await Promise.resolve(); } finally { transactionReads--; }
          }
          return { data: records.has(id) ? { ...records.get(id) } : null };
        },
        set: async ({ data }) => {
          if (options.rejectImmutableId && Object.prototype.hasOwnProperty.call(data, '_id')) throw Object.assign(new Error('Cannot update immutable _id'), { code: 'IMMUTABLE_ID' });
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
    RegExp: options => ({ operation: 'regex', ...options }),
    command: { exists: value => ({ operation: 'exists', value }), lt: value => ({ operation: 'lt', value }), gt: value => ({ operation: 'gt', value }), in: value => ({ operation: 'in', value }),
      aggregate: { sum: field => ({ operation: 'sum', field }) } },
    collection: name => collection(name, tables),
    serverDate: () => options.serverTime || '2026-11-14T10:00:00.000Z',
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
        return hooks.transactionResult === 'direct' ? result : { result, errMsg: 'runTransaction:ok' };
      } finally { release(); }
    },
  };
  const handle = createUserService(db, {
    generateAI: options.generateAI, resolveAIImages: options.resolveAIImages, resolveAICommentImages: options.resolveAICommentImages, resolveComposeImages: options.resolveComposeImages, optimizeAI: options.optimizeAI, aiNow: options.aiNow,
    checkText: options.checkText || (async () => true),
    processSquareImages: options.processSquareImages,
    randomAccountId: options.randomAccountId,
    proofStorageReady: options.ready !== false,
    uploadProof: async value => {
      uploads.push(value);
      if (options.failUpload) throw new Error('upload unavailable');
      return 'cloud://test.bucket/' + value.cloudPath;
    },
    getProofUrl: async file => {
      proofRequests.push(file);
      if (options.beforeProofUrl) await options.beforeProofUrl();
      return options.proofUrl || 'https://example.com/short-lived-proof?test-only';
    },
    verifyProof: async file => { proofRequests.push(file); return options.proofAvailable !== false; },
  });
  const alice = { openid: 'alice', env: 'test' }, bob = { openid: 'bob', env: 'test' }, admin = { openid: 'admin', env: 'test' };
  const f = { db, handle, alice, bob, admin, uploads, proofRequests, queries, docReads, hooks,
    follows: tables.get('user_follows'),
    accountIds: tables.get('account_ids'),
    users: tables.get('users'), applications: tables.get('certification_applications'), reviews: tables.get('certification_reviews'),
    squarePosts: tables.get('square_posts'), squareReplies: tables.get('square_replies'), squareInteractions: tables.get('square_interactions'), squareReports: tables.get('square_reports'),
    squareReplyChildren: tables.get('square_reply_children'), squareCommentStates: tables.get('square_comment_states'),
    aiJobs: tables.get('square_ai_jobs'),
    async login(identity = alice) { return (await handle({ action: 'login' }, identity)).user; },
    async loginAdmin(identity = admin) { const account = await f.login(identity); f.users.get(account._id).role = 'admin'; return account; },
    submit(value = application(), identity = alice) { return handle({ action: 'submitCertification', application: value }, identity); },
  };
  return f;
}

module.exports = { fixture, application };
