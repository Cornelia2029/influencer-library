// =====================================================
// Supabase REST API 封装层
// 纯 fetch + PostgREST，不需要 SDK
// 所有字段名和前端 JS 完全一致（数据库列名 = 前端 camelCase key）
// 所有方法返回 Promise
// =====================================================
(function(global) {
  const cfg = global.SUPABASE_CONFIG;
  const API = cfg.url + '/rest/v1';

  function headers(extra = {}) {
    return {
      'apikey': cfg.key,
      'Authorization': 'Bearer ' + cfg.key,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...extra
    };
  }

  async function request(method, path, body, query) {
    let url = API + path;
    if (query) {
      const params = new URLSearchParams();
      for (const k in query) params.set(k, query[k]);
      url += '?' + params.toString();
    }
    const opts = { method, headers: headers() };
    if (body != null) opts.body = JSON.stringify(body);

    let resp;
    try { resp = await fetch(url, opts); }
    catch (e) {
      console.error('[Supabase] 网络错误:', e);
      throw new Error('网络连接失败，请检查是否连上外网');
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error('[Supabase]', method, path, resp.status, txt);
      throw new Error('Supabase 请求失败: ' + resp.status + ' ' + txt.slice(0, 300));
    }
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      return resp.json();
    }
    return null;
  }

  // ---------- 通用 CRUD ----------
  async function list(table, select = '*') {
    return request('GET', '/' + table, null, { select }) || [];
  }

  async function upsert(table, rows) {
    const arr = Array.isArray(rows) ? rows : [rows];
    return request('POST', '/' + table, arr, { on_conflict: 'id' }) || [];
  }

  async function remove(table, column, values) {
    if (!values || !values.length) return 0;
    const escaped = values.map(v => '"' + String(v).replace(/"/g, '\\"') + '"').join(',');
    await request('DELETE', '/' + table, null, { [column]: 'in.(' + escaped + ')' });
    return values.length;
  }

  async function setVal(table, keyCol, keyVal, valCol, val) {
    await request('POST', '/' + table, { [keyCol]: keyVal, [valCol]: val }, { on_conflict: keyCol });
  }

  async function getVal(table, keyCol, keyVal, valCol) {
    const rows = await request('GET', '/' + table, null, { select: valCol, [keyCol]: 'eq.' + keyVal });
    if (rows && rows.length) return rows[0][valCol];
    return null;
  }

  // ---------- 可达性探测 ----------
  async function ping() {
    try {
      const rows = await request('GET', '/' + cfg.tables.influencers, null, { select: 'id', limit: 1 });
      return { ok: true, count: rows ? rows.length : 0 };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------- 简易实时：每 15s 查最新 updatedAt ----------
  function subscribeChanges(callback) {
    let lastTs = Date.now();
    setInterval(async () => {
      try {
        const rows = await request('GET', '/' + cfg.tables.influencers, null, {
          select: '"updatedAt"',
          order: '"updatedAt".desc',
          limit: 1
        });
        if (rows && rows.length) {
          const ts = new Date(rows[0].updatedAt).getTime();
          if (ts > lastTs) { lastTs = ts; callback && callback(); }
        }
      } catch (e) { /* 静默 */ }
    }, 15000);
  }

  global.SupabaseAPI = { list, upsert, remove, setVal, getVal, ping, subscribeChanges };

})(window);
