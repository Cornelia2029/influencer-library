/* 达人资源匹配系统 - 数据持久化层
 * 存储后端：Supabase（优先）→ localStorage（离线降级）
 * 所有导出方法都是 async，返回 Promise
 *
 * 后端选择：只有 ensureBackend() 能决定 _useSupabase
 *          单次请求失败只打日志 + 降级 localStorage，不影响后端选择
 */
(function (global) {
  'use strict';

  const getSB = () => global.SupabaseAPI;
  const KEYS = {
    INFLUENCERS: 'inf_lib_influencers_v1',
    FAVORITES: 'inf_lib_favorites_v1',
    PROJECTS: 'inf_lib_projects_v1',
    SETTINGS: 'inf_lib_settings_v1',
    SEED_FLAG: 'inf_lib_seeded_v1'
  };

  // 后端标识（只有 ensureBackend 能改）
  let _useSupabase = false;

  // 每次重新 ping —— 避免初始化时序问题
  async function ensureBackend() {
    const SB = getSB();
    if (!SB) { _useSupabase = false; return false; }
    try {
      const r = await SB.ping();
      _useSupabase = !!r.ok;
    } catch (e) {
      _useSupabase = false;
    }
    return _useSupabase;
  }

  // localStorage 后备工具
  function readLS(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function writeLS(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }
  function genId() {
    return 'inf_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function dedupKey(inf) {
    const platform = (inf.platform || '').trim();
    const nickname = (inf.nickname || '').trim().toLowerCase().replace(/\s+/g, '');
    const phone = (inf.phone || '').trim();
    const wechat = (inf.wechat || '').trim();
    if (nickname) return (platform || 'NA') + '::' + nickname;
    if (phone) return 'phone::' + phone;
    if (wechat) return 'wx::' + wechat;
    return null;
  }

  function stripNulls(obj) {
    const out = {};
    Object.keys(obj).forEach(k => {
      const v = obj[k];
      if (v !== undefined && v !== null && v !== '') out[k] = v;
    });
    return out;
  }

  function defaultInfluencer() {
    return {
      id: null, nickname: '', platform: '', homepage: '', wechat: '', phone: '', city: '',
      followers: null, tier: '', track: '', style: '', tags: [],
      pricePublic: null, pricePrivate: null, coopMode: '', cases: '', avoid: false, coopNote: '',
      posts30d: null, totalViews: null, interactions30d: null, engagementRate: null, gmv: null,
      pugongyingEnabled: false,
      favorited: false, createdAt: null
    };
  }

  function migrateLS(list) {
    if (!Array.isArray(list)) return list;
    let migrated = false;
    list.forEach(i => {
      if (!('pugongyingEnabled' in i)) { i.pugongyingEnabled = false; migrated = true; }
      if (!('interactions30d' in i)) { i.interactions30d = null; migrated = true; }
    });
    if (migrated) writeLS(KEYS.INFLUENCERS, list);
    return list;
  }

  /* Supabase 行序列化/反序列化 */
  function rowToStore(r) {
    if (!r) return r;
    if (typeof r.tags === 'string') {
      try { r.tags = JSON.parse(r.tags); } catch (e) { r.tags = r.tags.split(/[,，、|/]+/).filter(Boolean); }
    } else if (!r.tags) {
      r.tags = [];
    }
    if (typeof r.createdAt === 'string') r.createdAt = new Date(r.createdAt).getTime();
    if (typeof r.updatedAt === 'string') r.updatedAt = new Date(r.updatedAt).getTime();
    return r;
  }
  function storeToRow(r) {
    const row = Object.assign({}, r);
    if (Array.isArray(row.tags)) row.tags = JSON.stringify(row.tags);
    if (row.createdAt && typeof row.createdAt === 'number') {
      row.createdAt = new Date(row.createdAt).toISOString();
    }
    delete row.updatedAt;
    delete row.favorited;
    return row;
  }

  async function safeUpsert(table, payload) {
    try {
      await getSB().upsert(table, payload);
      return true;
    } catch (e) {
      console.warn('[Store] Supabase upsert ' + table + ' 失败:', e.message);
      return false;
    }
  }
  async function safeRemove(table, column, values) {
    try {
      await getSB().remove(table, column, values);
      return true;
    } catch (e) {
      console.warn('[Store] Supabase remove ' + table + ' 失败:', e.message);
      return false;
    }
  }

  const Store = {
    KEYS,
    genId,
    dedupKey,
    defaultInfluencer,
    get useSupabase() { return _useSupabase; },

    /* ========== 达人库 ========== */
    async getInfluencers() {
      await ensureBackend();
      if (_useSupabase) {
        try {
          const rows = await getSB().list('influencers', '*');
          return rows.map(rowToStore);
        } catch (e) {
          console.warn('[Store] getInfluencers Supabase 失败，降级 localStorage');
        }
      }
      return migrateLS(readLS(KEYS.INFLUENCERS, []));
    },

    async upsertInfluencers(incoming) {
      await ensureBackend();
      const existing = await this.getInfluencers();
      const map = new Map();
      existing.forEach(i => { const k = dedupKey(i); if (k) map.set(k, i); });
      let added = 0, updated = 0;
      const toInsert = [];

      incoming.forEach(item => {
        const k = dedupKey(item);
        if (k && map.has(k)) {
          const old = map.get(k);
          const merged = Object.assign({}, old, stripNulls(item), {
            id: old.id,
            createdAt: old.createdAt,
            favorited: old.favorited || item.favorited || false
          });
          map.set(k, merged);
          updated++;
        } else {
          const fresh = Object.assign({}, defaultInfluencer(), item, {
            id: item.id || genId(),
            createdAt: item.createdAt || Date.now()
          });
          if (k) map.set(k, fresh);
          else toInsert.push(fresh);
          added++;
        }
      });

      const result = Array.from(map.values()).concat(toInsert);

      // 不管后端成功与否，永远写 localStorage（双写，保证离线可用）
      writeLS(KEYS.INFLUENCERS, result);

      if (_useSupabase && result.length) {
        const payload = result.map(storeToRow).filter(r => r.id || r.nickname || r.platform);
        await safeUpsert('influencers', payload);
      }

      return { added, updated, total: result.length };
    },

    async upsertSingle(inf) {
      const list = await this.getInfluencers();
      const idx = list.findIndex(x => x.id === inf.id);
      if (idx >= 0) list[idx] = Object.assign({}, list[idx], inf);
      else {
        inf.id = inf.id || genId();
        inf.createdAt = inf.createdAt || Date.now();
        list.push(inf);
      }
      writeLS(KEYS.INFLUENCERS, list);
      await ensureBackend();
      if (_useSupabase) {
        await safeUpsert('influencers', storeToRow(inf));
      }
      return inf;
    },

    async deleteInfluencer(id) {
      await ensureBackend();
      if (_useSupabase) {
        await safeRemove('influencers', 'id', [id]);
      }
      // 双写：localStorage 也删
      const list = readLS(KEYS.INFLUENCERS, []).filter(i => i.id !== id);
      writeLS(KEYS.INFLUENCERS, list);
      // 从收藏夹移除
      const favs = await this.getFavorites();
      favs.forEach(g => { g.infIds = (g.infIds || []).filter(x => x !== id); });
      await this.saveFavorites(favs);
    },

    async clearInfluencers() {
      await ensureBackend();
      if (_useSupabase) {
        const cur = await this.getInfluencers();
        await safeRemove('influencers', 'id', cur.map(i => i.id));
      }
      writeLS(KEYS.INFLUENCERS, []);
      return true;
    },

    /* ========== 收藏夹 ========== */
    async getFavorites() {
      await ensureBackend();
      if (_useSupabase) {
        try {
          const rows = await getSB().list('favorite_groups');
          return rows.map(r => ({
            id: r.id, name: r.name,
            infIds: typeof r.infIds === 'string' ? JSON.parse(r.infIds || '[]') : (r.infIds || []),
            createdAt: r.createdAt ? new Date(r.createdAt).getTime() : Date.now()
          }));
        } catch (e) { console.warn('[Store] getFavorites Supabase 失败'); }
      }
      return readLS(KEYS.FAVORITES, []);
    },
    async saveFavorites(favs) {
      await ensureBackend();
      writeLS(KEYS.FAVORITES, favs || []);
      if (_useSupabase) {
        const cur = await this.getFavorites();
        await safeRemove('favorite_groups', 'id', cur.map(g => g.id));
        if (favs.length) {
          await safeUpsert('favorite_groups', favs.map(g => ({
            id: g.id, name: g.name, infIds: JSON.stringify(g.infIds || [])
          })));
        }
      }
    },
    async addFavoriteGroup(name) {
      const favs = await this.getFavorites();
      const g = { id: 'grp_' + genId(), name: name || '未命名分组', infIds: [], createdAt: Date.now() };
      favs.push(g);
      await this.saveFavorites(favs);
      return g;
    },
    async renameFavoriteGroup(id, name) {
      const favs = await this.getFavorites();
      const g = favs.find(x => x.id === id);
      if (g) { g.name = name; await this.saveFavorites(favs); }
      return g;
    },
    async deleteFavoriteGroup(id) {
      const favs = (await this.getFavorites()).filter(x => x.id !== id);
      await this.saveFavorites(favs);
    },
    async toggleFavorite(groupId, infId) {
      const favs = await this.getFavorites();
      const g = favs.find(x => x.id === groupId);
      if (!g) return;
      g.infIds = g.infIds || [];
      const i = g.infIds.indexOf(infId);
      if (i >= 0) g.infIds.splice(i, 1); else g.infIds.push(infId);
      await this.saveFavorites(favs);
    },
    async isFavorited(groupId, infId) {
      const g = (await this.getFavorites()).find(x => x.id === groupId);
      return !!(g && (g.infIds || []).includes(infId));
    },

    /* ========== 项目 ========== */
    async getProjects() {
      await ensureBackend();
      if (_useSupabase) {
        try {
          const rows = await getSB().list('projects');
          return rows.map(r => ({
            id: r.id, name: r.name,
            req: typeof r.req === 'string' ? JSON.parse(r.req || '{}') : (r.req || {}),
            infIds: typeof r.infIds === 'string' ? JSON.parse(r.infIds || '[]') : (r.infIds || []),
            createdAt: r.createdAt ? new Date(r.createdAt).getTime() : Date.now()
          }));
        } catch (e) { console.warn('[Store] getProjects Supabase 失败'); }
      }
      return readLS(KEYS.PROJECTS, []);
    },
    async saveProjects(p) {
      await ensureBackend();
      writeLS(KEYS.PROJECTS, p || []);
      if (_useSupabase) {
        const cur = await this.getProjects();
        await safeRemove('projects', 'id', cur.map(x => x.id));
        if (p.length) {
          await safeUpsert('projects', p.map(x => ({
            id: x.id, name: x.name,
            req: JSON.stringify(x.req || {}),
            infIds: JSON.stringify(x.infIds || [])
          })));
        }
      }
    },
    async saveProject(project) {
      const list = await this.getProjects();
      const idx = list.findIndex(x => x.id === project.id);
      if (idx >= 0) list[idx] = project; else list.push(project);
      await this.saveProjects(list);
      return project;
    },
    async deleteProject(id) {
      await this.saveProjects((await this.getProjects()).filter(x => x.id !== id));
    },

    /* ========== 设置 ========== */
    async getSettings() {
      await ensureBackend();
      if (_useSupabase) {
        try {
          const v = await getSB().getVal('settings', 'key', 'all', 'value');
          if (v != null) {
            try { return JSON.parse(v); } catch (e) { /* fallthrough */ }
          }
        } catch (e) { /* 单次请求失败不影响后端选择 */ }
      }
      return readLS(KEYS.SETTINGS, { viewMode: 'list', lastView: 'library' });
    },
    async saveSettings(s) {
      await ensureBackend();
      const cur = await this.getSettings();
      const merged = Object.assign({}, cur, s);
      writeLS(KEYS.SETTINGS, merged);
      if (_useSupabase) {
        try { await getSB().setVal('settings', 'key', 'all', 'value', JSON.stringify(merged)); }
        catch (e) { /* 单次请求失败不影响后端选择 */ }
      }
      return merged;
    },

    /* ========== 种子标记 ========== */
    isSeeded() { return localStorage.getItem(KEYS.SEED_FLAG) === '1'; },
    markSeeded() { localStorage.setItem(KEYS.SEED_FLAG, '1'); }
  };

  global.Store = Store;
})(window);
