/* 达人资源匹配系统 - 数据持久化层
 * 存储后端：Supabase（优先）→ localStorage（离线降级）
 * 所有导出方法都是 async，返回 Promise
 *
 * 字段映射（camelCase ↔ Supabase snake_case）：
 *   influencers → influencers 表
 *   favoriteGroups → favorite_groups 表
 *   projects → projects 表
 *   settings → settings 表（key-value）
 */
(function (global) {
  'use strict';

  // 每次动态读取（不能在 IIFE 顶部缓存——因为 store.js 可能在 SupabaseAPI 加载前执行）
  const getSB = () => global.SupabaseAPI;
  const KEYS = {
    INFLUENCERS: 'inf_lib_influencers_v1',
    FAVORITES: 'inf_lib_favorites_v1',
    PROJECTS: 'inf_lib_projects_v1',
    SETTINGS: 'inf_lib_settings_v1',
    SEED_FLAG: 'inf_lib_seeded_v1'
  };

  // 探测是否走 Supabase（每次都重新 ping——避免初始化时序问题）
  let _useSupabase = false;

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

  // 去重键
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

  // camelCase 过滤空值
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

  // 给 localStorage 里的老数据补 pugongyingEnabled 字段
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
          // 把 tags(数据库存 text) 转回数组；时间戳转数字（和 localStorage 格式统一）
          return rows.map(r => {
            if (typeof r.tags === 'string') {
              try { r.tags = JSON.parse(r.tags); } catch (e) { r.tags = r.tags.split(/[,，、|/]+/).filter(Boolean); }
            } else if (!r.tags) {
              r.tags = [];
            }
            if (typeof r.createdAt === 'string') r.createdAt = new Date(r.createdAt).getTime();
            return r;
          });
        } catch (e) {
          console.warn('[Store] getInfluencers Supabase 失败，降级 localStorage:', e.message);
          _useSupabase = false;
        }
      }
      return migrateLS(readLS(KEYS.INFLUENCERS, []));
    },
    // 批量整体保存（用于 delete/batch 等场景）
    async saveInfluencers(list) {
      await ensureBackend();
      if (_useSupabase) {
        try {
          await this.clearInfluencers();
          if (list.length) {
            await getSB().upsert('influencers', list.map(r => {
              const row = Object.assign({}, r);
              if (Array.isArray(row.tags)) row.tags = JSON.stringify(row.tags);
              if (row.createdAt && typeof row.createdAt === 'number') {
                row.createdAt = new Date(row.createdAt).toISOString();
              }
              delete row.updatedAt; delete row.favorited;
              return row;
            }).filter(r => r.id || r.nickname || r.platform));
          }
        } catch (e) { _useSupabase = false; }
      }
      writeLS(KEYS.INFLUENCERS, list || []);
      return true;
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

      if (_useSupabase) {
        try {
          // Supabase upsert：列名和前端 key 完全一致（camelCase），只做必要的序列化
          const payload = result.map(r => {
            const row = Object.assign({}, r);
            if (Array.isArray(row.tags)) row.tags = JSON.stringify(row.tags);
            if (row.createdAt && typeof row.createdAt === 'number') {
              row.createdAt = new Date(row.createdAt).toISOString();
            }
            delete row.updatedAt;     // Supabase 自动维护
            delete row.favorited;     // 不在 influencers 表里
            return row;               // 不 stripNulls，保留所有字段让 Postgres 默认值生效
          }).filter(r => r.id || r.nickname || r.platform);  // 至少有一个有效字段
          if (payload.length) {
            await getSB().upsert('influencers', payload);
          }
        } catch (e) {
          console.warn('[Store] upsert Supabase 失败，降级 localStorage:', e.message);
          _useSupabase = false;
          writeLS(KEYS.INFLUENCERS, result);
        }
      } else {
        writeLS(KEYS.INFLUENCERS, result);
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
      if (_useSupabase) {
        try { await getSB().upsert('influencers', inf); }
        catch (e) { _useSupabase = false; writeLS(KEYS.INFLUENCERS, list); }
      } else {
        writeLS(KEYS.INFLUENCERS, list);
      }
      return inf;
    },

    async deleteInfluencer(id) {
      await ensureBackend();
      if (_useSupabase) {
        try {
          await getSB().remove('influencers', 'id', [id]);
        } catch (e) {
          console.warn('[Store] delete Supabase 失败，降级 localStorage:', e.message);
          _useSupabase = false;
        }
      }
      if (!_useSupabase) {
        const list = readLS(KEYS.INFLUENCERS, []).filter(i => i.id !== id);
        writeLS(KEYS.INFLUENCERS, list);
      }
      // 从收藏夹移除
      const favs = await this.getFavorites();
      favs.forEach(g => { g.infIds = (g.infIds || []).filter(x => x !== id); });
      await this.saveFavorites(favs);
    },

    async clearInfluencers() {
      await ensureBackend();
      if (_useSupabase) {
        try { await getSB().remove('influencers', 'id', (await this.getInfluencers()).map(i => i.id)); }
        catch (e) { _useSupabase = false; }
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
            id: r.id,
            name: r.name,
            infIds: typeof r.infIds === 'string' ? JSON.parse(r.infIds || '[]') : (r.infIds || []),
            createdAt: r.createdAt ? new Date(r.createdAt).getTime() : Date.now()
          }));
        } catch (e) { _useSupabase = false; }
      }
      return readLS(KEYS.FAVORITES, []);
    },
    async saveFavorites(favs) {
      await ensureBackend();
      if (_useSupabase) {
        try {
          await getSB().remove('favorite_groups', 'id', (await this.getFavorites()).map(g => g.id));
          if (favs.length) {
            await getSB().upsert('favorite_groups', favs.map(g => ({
              id: g.id, name: g.name, infIds: JSON.stringify(g.infIds || [])
            })));
          }
        } catch (e) { _useSupabase = false; }
      }
      writeLS(KEYS.FAVORITES, favs || []);
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
            id: r.id,
            name: r.name,
            req: typeof r.req === 'string' ? JSON.parse(r.req || '{}') : (r.req || {}),
            infIds: typeof r.infIds === 'string' ? JSON.parse(r.infIds || '[]') : (r.infIds || []),
            createdAt: r.createdAt ? new Date(r.createdAt).getTime() : Date.now()
          }));
        } catch (e) { _useSupabase = false; }
      }
      return readLS(KEYS.PROJECTS, []);
    },
    async saveProjects(p) {
      await ensureBackend();
      if (_useSupabase) {
        try {
          await getSB().remove('projects', 'id', (await this.getProjects()).map(x => x.id));
          if (p.length) {
            await getSB().upsert('projects', p.map(x => ({
              id: x.id, name: x.name,
              req: JSON.stringify(x.req || {}),
              infIds: JSON.stringify(x.infIds || [])
            })));
          }
        } catch (e) { _useSupabase = false; }
      }
      writeLS(KEYS.PROJECTS, p || []);
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
        } catch (e) { /* 单次请求失败不影响后端选择，ensureBackend 会重新 ping */ }
      }
      return readLS(KEYS.SETTINGS, { viewMode: 'list', lastView: 'library' });
    },
    async saveSettings(s) {
      await ensureBackend();
      const cur = await this.getSettings();
      const merged = Object.assign({}, cur, s);
      if (_useSupabase) {
        try { await getSB().setVal('settings', 'key', 'all', 'value', JSON.stringify(merged)); }
        catch (e) { _useSupabase = false; }
      }
      writeLS(KEYS.SETTINGS, merged);
      return merged;
    },

    /* ========== 种子标记 ========== */
    isSeeded() { return localStorage.getItem(KEYS.SEED_FLAG) === '1'; },
    markSeeded() { localStorage.setItem(KEYS.SEED_FLAG, '1'); }
  };

  global.Store = Store;
})(window);
