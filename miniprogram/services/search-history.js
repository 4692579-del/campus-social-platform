const { normalize } = require('../utils/search-query');

const HISTORY_LIMIT = 20;
const storageKey = owner => `campus.search-entry-history.v1:${owner}`;

function read(owner) {
  const stored = wx.getStorageSync(storageKey(owner));
  if (!Array.isArray(stored)) return [];
  const queries = new Map();
  for (const row of stored.slice(0, HISTORY_LIMIT)) {
    try {
      const query = normalize(row);
      const id = JSON.stringify(query);
      queries.set(id, { id, ...query });
    } catch (_) { /* 跳过本地无效记录。 */ }
  }
  return [...queries.values()];
}

function remember(owner, query) {
  const value = normalize(query), id = JSON.stringify(value);
  const rows = [{ id, ...value }, ...read(owner).filter(row => row.id !== id)].slice(0, HISTORY_LIMIT);
  write(owner, rows);
  return rows;
}

function remove(owner, id) {
  const rows = read(owner).filter(row => row.id !== id);
  write(owner, rows);
  return rows;
}

function write(owner, rows) {
  wx.setStorageSync(storageKey(owner), rows.map(({ keyword, accountId }) => ({ keyword, accountId })));
}

module.exports = { read, remember, remove };
