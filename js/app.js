/* 达人资源匹配系统 - 主应用 (Vue 3)
 * 依赖：vue.global.prod.js, store.js, excel.js, match.js
 */
(function (global) {
  'use strict';

  const { createApp, reactive, computed, ref, watch, nextTick } = global.Vue;

  // ---------- 格式化辅助 ----------
  function fmtNum(n) {
    if (n == null || n === '' || isNaN(n)) return '-';
    n = Number(n);
    if (n >= 100000000) return (n / 100000000).toFixed(2) + '亿';
    if (n >= 10000) return (n / 10000).toFixed(1) + '万';
    return String(n);
  }
  function fmtPrice(n) {
    if (n == null || n === '' || isNaN(n)) return '-';
    n = Number(n);
    if (n >= 10000) return '¥' + (n / 10000).toFixed(1) + '万';
    return '¥' + n.toLocaleString();
  }
  function fmtPct(n) {
    if (n == null || n === '' || isNaN(n)) return '-';
    return Number(n).toFixed(1) + '%';
  }

  const app = createApp({
    setup() {
      // ---------- 状态（先空着，initApp 异步填充） ----------
      const state = reactive({
        view: 'library',
        viewMode: 'list',
        influencers: [],
        detailId: null,
        detailOpen: false,
        compareIds: [],
        listIds: [],
        selectedIds: [],
        search: '',
        filters: {
          platforms: [], cities: [], tracks: [], tiers: [], style: '',
          priceMin: null, priceMax: null, excludeAvoid: true
        },
        sortKey: 'matchScore',
        sortDir: 'desc',
        favoriteGroups: [],
        activeFavGroup: null,
        savedProjects: [],
        projectReq: { name: '', projectType: '餐饮', cities: [], platforms: [], budgetMin: null, budgetMax: null, count: 5, excludeAvoid: true },
        matchResults: [],
        matchRun: false,
        importPreview: { open: false, fileName: '', rowCount: 0, rows: [], cols: [] },
        toast: { show: false, text: '', type: 'info' }
      });

      // 初始化：异步加载所有数据
      async function initApp() {
        try {
          // 1. 读取设置（决定 view/viewMode）
          const settings = await Store.getSettings();
          state.view = settings.lastView || 'library';
          let vm = settings.viewMode || 'list';
          if (vm === 'card') { await Store.saveSettings({ viewMode: 'list' }); vm = 'list'; }
          state.viewMode = vm;

          // 2. 加载达人库（探测 Supabase vs localStorage）
          const infs = await Store.getInfluencers();
          // 首次运行注入种子数据
          if ((!Store.isSeeded() || infs.length === 0) && infs.length === 0) {
            const seed = buildSeedData();
            await Store.upsertInfluencers(seed);
            await Store.markSeeded();
            await Store.addFavoriteGroup('意向客户');
            await Store.addFavoriteGroup('备选池');
            state.influencers = await Store.getInfluencers();
          } else {
            state.influencers = infs;
          }

          // 3. 加载收藏夹
          state.favoriteGroups = await Store.getFavorites();

          // 4. 加载项目
          state.savedProjects = await Store.getProjects();

          // 5. 启动简易实时订阅（每 15s 检查 Supabase 是否有新数据）
          if (Store.useSupabase && window.SupabaseAPI) {
            window.SupabaseAPI.subscribeChanges(async () => {
              const fresh = await Store.getInfluencers();
              // 用 diff 方式浅更新，避免覆盖本地编辑中的状态
              if (fresh.length !== state.influencers.length ||
                  fresh.some((f, i) => state.influencers[i] && f.id !== state.influencers[i].id)) {
                state.influencers = fresh;
              }
            });
          }

          console.log('[App] 初始化完成，influencers=' + state.influencers.length +
            ', backend=' + (Store.useSupabase ? 'Supabase' : 'localStorage'));
        } catch (e) {
          console.error('[App] 初始化失败:', e);
          toast('数据加载失败，请刷新重试', 'warn');
        }
      }
      // 立即异步启动，Vue 会等数据回来再渲染
      initApp();

      // 导入映射的可选字段列表
      const fieldOptions = ExcelIO.SCHEMA.map(f => ({ key: f.key, label: f.label }));

      // ---------- 城市输入 ----------
      const newCity = ref('');
      const newTrack = ref('');

      // ---------- 选项 (派生自数据) ----------
      const platformOptions = computed(() => {
        const s = new Set(['抖音', '小红书']);
        state.influencers.forEach(i => { if (i.platform) s.add(i.platform); });
        return [...s];
      });
      const cityOptions = computed(() => {
        const s = new Set(['上海', '杭州', '苏州', '武汉', '南京', '宁波']);
        state.influencers.forEach(i => { if (i.city) s.add(i.city); });
        return [...s];
      });
      const trackOptions = computed(() => {
        const s = new Set();
        state.influencers.forEach(i => { if (i.track) i.track.split(/[,，、/|]+/).forEach(t => t.trim() && s.add(t.trim())); });
        return [...s].sort();
      });
      const tierOptions = ['素人', '尾部', '腰部', '头部', '顶流'];
      const projectTypeOptions = ['餐饮', '文旅', '到店消费', '美妆', '服饰', '通用'];

      // ---------- 统计 ----------
      const stats = computed(() => {
        const list = state.influencers;
        return {
          total: list.length,
          douyin: list.filter(i => i.platform === '抖音').length,
          xhs: list.filter(i => i.platform === '小红书').length,
          avoid: list.filter(i => i.avoid).length,
          head: list.filter(i => ['头部', '顶流'].includes(i.tier)).length
        };
      });

      // 达人库当前视图是否已全选（用于全选复选框状态）
      const isAllSelected = computed(() => {
        const list = state.view === 'library' ? libraryInfluencers.value : filteredInfluencers.value;
        if (!list.length) return false;
        const set = new Set(state.selectedIds);
        return list.every(i => set.has(i.id));
      });

      // ---------- 筛选 + 搜索 + 排序 ----------
      const filteredInfluencers = computed(() => {
        let list = state.influencers.slice();
        const f = state.filters;
        if (f.platforms.length) list = list.filter(i => f.platforms.includes(i.platform));
        if (f.cities.length) list = list.filter(i => f.cities.includes(i.city));
        if (f.tracks.length) {
          list = list.filter(i => {
            const hay = (i.track || '') + ' ' + (i.style || '') + ' ' + (i.tags || []).join(' ');
            return f.tracks.some(t => hay.toLowerCase().indexOf(t.toLowerCase()) >= 0);
          });
        }
        if (f.tiers.length) list = list.filter(i => f.tiers.includes(i.tier));
        if (f.style.trim()) {
          const kw = f.style.trim().toLowerCase();
          list = list.filter(i => (i.style || '').toLowerCase().indexOf(kw) >= 0);
        }
        if (f.priceMin != null && f.priceMin !== '') {
          list = list.filter(i => (i.pricePrivate || i.pricePublic || 0) >= Number(f.priceMin));
        }
        if (f.priceMax != null && f.priceMax !== '') {
          list = list.filter(i => (i.pricePrivate || i.pricePublic || 0) <= Number(f.priceMax));
        }
        if (f.excludeAvoid) list = list.filter(i => !i.avoid);
        if (state.search.trim()) {
          const kw = state.search.trim().toLowerCase();
          list = list.filter(i => {
            return [i.nickname, i.city, i.track, i.style, i.coopMode, i.cases, i.coopNote, (i.tags || []).join(' ')]
              .some(v => (v || '').toLowerCase().indexOf(kw) >= 0);
          });
        }
        // 排序
        const key = state.sortKey;
        const dir = state.sortDir === 'asc' ? 1 : -1;
        if (key) {
          list.sort((a, b) => {
            let va = a[key], vb = b[key];
            if (key === 'matchScore') { va = a.matchScore || 0; vb = b.matchScore || 0; }
            if (key === 'price') { va = a.pricePrivate || a.pricePublic || 0; vb = b.pricePrivate || b.pricePublic || 0; }
            if (typeof va === 'number' || typeof vb === 'number') {
              va = Number(va) || 0; vb = Number(vb) || 0;
              return (va - vb) * dir;
            }
            return String(va || '').localeCompare(String(vb || '')) * dir;
          });
        }
        return list;
      });

      // 达人库视图专用：仅搜索 + 排序，**不应用**智能筛选面板条件
      const libraryInfluencers = computed(() => {
        let list = state.influencers.slice();
        if (state.search.trim()) {
          const kw = state.search.trim().toLowerCase();
          list = list.filter(i => {
            return [i.nickname, i.city, i.track, i.style, i.coopMode, i.cases, i.coopNote, (i.tags || []).join(' ')]
              .some(v => (v || '').toLowerCase().indexOf(kw) >= 0);
          });
        }
        const key = state.sortKey;
        const dir = state.sortDir === 'asc' ? 1 : -1;
        if (key) {
          list.sort((a, b) => {
            let va = a[key], vb = b[key];
            if (key === 'matchScore') { va = a.matchScore || 0; vb = b.matchScore || 0; }
            if (key === 'price') { va = a.pricePrivate || a.pricePublic || 0; vb = b.pricePrivate || b.pricePublic || 0; }
            if (typeof va === 'number' || typeof vb === 'number') {
              va = Number(va) || 0; vb = Number(vb) || 0;
              return (va - vb) * dir;
            }
            return String(va || '').localeCompare(String(vb || '')) * dir;
          });
        }
        return list;
      });

      const detailInfluencer = computed(() => state.influencers.find(i => i.id === state.detailId) || null);

      const compareList = computed(() => state.compareIds.map(id => state.influencers.find(i => i.id === id)).filter(Boolean));

      // ---------- 视图切换 ----------
      function switchView(v) {
        state.view = v;
        Store.saveSettings({ lastView: v });
      }
      function setViewMode(m) {
        state.viewMode = m;
        Store.saveSettings({ viewMode: m });
      }

      // ---------- 详情 ----------
      function openDetail(id) { state.detailId = id; state.detailOpen = true; }
      function closeDetail() { state.detailOpen = false; }

      // ---------- 对比 ----------
      function toggleCompare(id) {
        const i = state.compareIds.indexOf(id);
        if (i >= 0) state.compareIds.splice(i, 1);
        else {
          if (state.compareIds.length >= 4) { toast('最多对比4位达人', 'warn'); return; }
          state.compareIds.push(id);
        }
      }
      function removeFromCompare(id) { state.compareIds = state.compareIds.filter(x => x !== id); }
      function clearCompare() { state.compareIds = []; }
      function exportCompare() {
        if (!compareList.value.length) { toast('对比列表为空', 'warn'); return; }
        ExcelIO.exportToExcel(compareList.value.map(i => Object.assign({}, i)), '达人对比表');
        toast('已导出对比表', 'success');
      }

      // ---------- 项目清单选中 ----------
      function toggleListSelect(id) {
        const i = state.listIds.indexOf(id);
        if (i >= 0) state.listIds.splice(i, 1);
        else state.listIds.push(id);
      }

      // ---------- 收藏 ----------
      async function addFavoriteGroup() {
        const name = window.prompt('请输入收藏分组名称：', '项目' + (state.favoriteGroups.length + 1));
        if (!name) return;
        const g = await Store.addFavoriteGroup(name);
        state.favoriteGroups = await Store.getFavorites();
        state.activeFavGroup = g.id;
        toast('已创建分组「' + name + '」', 'success');
      }
      async function deleteFavGroup(id) {
        if (!window.confirm('删除该分组？（不会删除达人数据）')) return;
        await Store.deleteFavoriteGroup(id);
        state.favoriteGroups = await Store.getFavorites();
        if (state.activeFavGroup === id) state.activeFavGroup = null;
        toast('已删除分组', 'info');
      }
      async function toggleFav(groupId, infId) {
        await Store.toggleFavorite(groupId, infId);
        state.favoriteGroups = await Store.getFavorites();
      }
      async function isFav(infId) {
        if (!state.activeFavGroup) return false;
        return await Store.isFavorited(state.activeFavGroup, infId);
      }
      async function isFavChecked(groupId, infId) {
        return await Store.isFavorited(groupId, infId);
      }
      function exportFavGroup() {
        const list = favGroupInfluencers.value;
        if (!list.length) { toast('该分组无达人', 'warn'); return; }
        const g = state.favoriteGroups.find(x => x.id === state.activeFavGroup);
        ExcelIO.exportToExcel(list.map(i => Object.assign({}, i)), '收藏_' + (g ? g.name : '分组'));
        toast('已导出该分组 ' + list.length + ' 位达人', 'success');
      }

      // ---------- 样式辅助 ----------
      function platformClass(p) {
        if (!p) return '';
        const s = String(p).toLowerCase();
        if (s.indexOf('抖音') >= 0 || s.indexOf('douyin') >= 0) return 'plat-douyin';
        if (s.indexOf('小红书') >= 0 || s.indexOf('xhs') >= 0 || s.indexOf('redbook') >= 0) return 'plat-xhs';
        return 'plat-other';
      }
      function tierClass(t) {
        return ({ '素人': 'tier-0', '尾部': 'tier-1', '腰部': 'tier-2', '头部': 'tier-3', '顶流': 'tier-4' })[t] || '';
      }

      // ---------- 排序 ----------
      function setSort(key) {
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortKey = key;
          state.sortDir = 'desc';
        }
      }
      const favGroupInfluencers = computed(() => {
        if (!state.activeFavGroup) return [];
        const g = state.favoriteGroups.find(x => x.id === state.activeFavGroup);
        if (!g) return [];
        const ids = g.infIds || [];
        return ids.map(id => state.influencers.find(i => i.id === id)).filter(Boolean);
      });

      // ---------- 筛选辅助 ----------
      function toggleArr(arr, val) {
        const i = arr.indexOf(val);
        if (i >= 0) arr.splice(i, 1); else arr.push(val);
      }
      function resetFilters() {
        state.filters = { platforms: [], cities: [], tracks: [], tiers: [], style: '', priceMin: null, priceMax: null, excludeAvoid: true };
        state.search = '';
      }
      function excludeAvoidOneShot() {
        state.filters.excludeAvoid = true;
        toast('已一键排除避雷达人', 'info');
      }

      // ---------- Excel 导入/导出 ----------
      function triggerImport(ev) {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        importFile(file);
        ev.target.value = '';
      }
      async function importFile(file) {
        try {
          // 阶段1：解析 + 自动识别映射 → 打开预览对话框
          const parsed = await ExcelIO.parseWorkbook(file);
          const { colMap, platformHint } = ExcelIO.autoDetectMapping(parsed.headers);
          // 每列取第一条非空值作为样例
          const sampleOf = ci => {
            for (const r of parsed.rows) {
              const v = r[ci];
              if (v !== '' && v != null) return String(v).slice(0, 60);
            }
            return '';
          };
          state.importPreview = {
            open: true,
            fileName: file.name,
            rowCount: parsed.rows.length,
            rows: parsed.rows,
            headers: parsed.headers,
            platformHint,
            cols: parsed.headers.map((h, i) => ({
              index: i,
              header: String(h || '').trim() || ('第' + (i + 1) + '列'),
              sample: sampleOf(i),
              field: colMap[i] || ''
            }))
          };
          if (!Object.keys(colMap).length) {
            toast('未能自动识别表头，请在预览中手动指定字段映射', 'warn');
          }
        } catch (e) {
          toast('解析失败：' + e.message, 'error');
        }
      }
      // 阶段2：用户确认映射后真正导入
      async function confirmImport() {
        const p = state.importPreview;
        const colMap = {};
        p.cols.forEach(c => { if (c.field) colMap[c.index] = c.field; });
        if (!Object.keys(colMap).length) { toast('请至少为一列指定字段映射', 'warn'); return; }
        const { data, skipped } = ExcelIO.buildInfluencers(p.rows, colMap, p.platformHint, p.headers);
        if (!data.length) { toast('没有有效数据行（需有昵称、联系方式或主页链接）', 'warn'); return; }
        const stats = await Store.upsertInfluencers(data);
        state.influencers = await Store.getInfluencers();
        state.favoriteGroups = await Store.getFavorites();
        state.importPreview = { open: false, fileName: '', rowCount: 0, rows: [], cols: [] };
        toast(`导入完成：新增 ${stats.added} 条，更新 ${stats.updated} 条，跳过 ${skipped} 行，库内共 ${stats.total} 条`, 'success');
      }
      function exportCurrent() {
        const list = (state.view === 'library' ? libraryInfluencers.value : filteredInfluencers.value);
        if (!list.length) { toast('当前结果为空', 'warn'); return; }
        ExcelIO.exportToExcel(list.map(i => Object.assign({}, i)));
        toast('已导出 ' + list.length + ' 条', 'success');
      }
      function downloadTemplate() {
        ExcelIO.downloadTemplate();
        toast('模板已下载', 'success');
      }

      // ---------- 项目匹配 ----------
      function runMatch() {
        const req = Object.assign({}, state.projectReq);
        if (!req.projectType && !req.cities.length && !req.platforms.length) {
          toast('请至少填写一项项目需求', 'warn'); return;
        }
        const results = Matcher.matchAll(state.influencers, req);
        // 将 matchScore/reason 写回便于筛选视图排序
        state.influencers.forEach(inf => {
          const r = results.find(x => x.influencer.id === inf.id);
          if (r) { inf.matchScore = r.matchScore; inf.matchReason = r.matchReason; }
          else { inf.matchScore = 0; inf.matchReason = ''; }
        });
        state.matchResults = results;
        state.matchRun = true;
        // 清空已选中清单
        state.listIds = [];
        toast(`匹配完成，共 ${results.length} 位可对接达人，已按匹配度排序`, 'success');
      }

      function selectTopN(n) {
        const top = state.matchResults.slice(0, n).map(r => r.influencer.id);
        state.listIds = top;
        toast(`已选中匹配度前 ${n} 位`, 'success');
      }

      async function saveProjectList() {
        if (!state.listIds.length) { toast('请先选中达人', 'warn'); return; }
        if (!state.projectReq.name.trim()) { toast('请填写项目名称', 'warn'); return; }
        const project = {
          id: 'proj_' + Date.now().toString(36),
          name: state.projectReq.name.trim(),
          req: JSON.parse(JSON.stringify(state.projectReq)),
          infIds: state.listIds.slice(),
          createdAt: Date.now()
        };
        await Store.saveProject(project);
        state.savedProjects = await Store.getProjects();
        toast('已保存推荐清单「' + project.name + '」（' + project.infIds.length + ' 位达人）', 'success');
      }
      function exportProjectList() {
        if (!state.listIds.length) { toast('请先选中达人', 'warn'); return; }
        const rows = state.listIds.map(id => state.influencers.find(i => i.id === id)).filter(Boolean);
        ExcelIO.exportProjectList(rows, state.projectReq.name || '达人推荐清单');
        toast('推荐清单已导出', 'success');
      }
      function loadProject(p) {
        state.projectReq = Object.assign({}, state.projectReq, p.req);
        state.listIds = p.infIds.slice();
        switchView('match');
        toast('已载入项目「' + p.name + '」', 'info');
      }
      async function deleteProject(id) {
        if (!window.confirm('删除该项目清单？')) return;
        await Store.deleteProject(id);
        state.savedProjects = await Store.getProjects();
      }

      // ---------- CRUD ----------
      async function deleteInfluencer(id) {
        const inf = state.influencers.find(i => i.id === id);
        if (!inf) return;
        if (!window.confirm('确认删除达人「' + (inf.nickname || '未命名') + '」？')) return;
        await Store.deleteInfluencer(id);
        state.influencers = await Store.getInfluencers();
        state.compareIds = state.compareIds.filter(x => x !== id);
        state.listIds = state.listIds.filter(x => x !== id);
        state.selectedIds = state.selectedIds.filter(x => x !== id);
        state.detailOpen = false;
        toast('已删除', 'info');
      }

      // ---------- 批量选择/删除 ----------
      function toggleSelect(id) {
        const i = state.selectedIds.indexOf(id);
        if (i >= 0) state.selectedIds.splice(i, 1);
        else state.selectedIds.push(id);
      }
      function toggleSelectAll() {
        const list = (state.view === 'library' ? libraryInfluencers.value : filteredInfluencers.value);
        if (isAllSelected.value) {
          const set = new Set(list.map(i => i.id));
          state.selectedIds = state.selectedIds.filter(id => !set.has(id));
        } else {
          const set = new Set(state.selectedIds);
          list.forEach(i => { if (!set.has(i.id)) { state.selectedIds.push(i.id); set.add(i.id); } });
        }
      }
      function clearSelection() { state.selectedIds = []; }
      function batchDelete() {
        if (!state.selectedIds.length) return;
        const selectedCount = state.selectedIds.length;
        // 第一轮：确认当前选中
        if (!window.confirm('确认删除选中的 ' + selectedCount + ' 位达人？此操作不可撤销。')) return;

        // 第二轮：提示"被筛选条件排除在外的条目"，询问是否一并删除
        const currentList = (state.view === 'library' ? libraryInfluencers.value : filteredInfluencers.value);
        const outsideIds = new Set(currentList.map(i => i.id));
        const outsideAll = state.influencers.filter(i => !outsideIds.has(i.id)).map(i => i.id);
        const outsideCount = outsideAll.length;

        let idsToDelete = new Set(state.selectedIds);
        if (outsideCount > 0) {
          const merge = window.confirm('⚠ 注意：当前筛选条件排除了 ' + outsideCount + ' 位达人（如避雷达人、其他筛选外条目），它们未被选中。\n\n点"确定"= 连同筛选外的 ' + outsideCount + ' 位一并删除（共删 ' + (selectedCount + outsideCount) + ' 位）\n点"取消"= 仅删除已选中的 ' + selectedCount + ' 位');
          if (merge) {
            outsideIds.forEach(id => idsToDelete.add(id));
          }
        }

        const ids = idsToDelete;
        if (!ids.size) return;
        const remaining = (await Store.getInfluencers()).filter(i => !ids.has(i.id));
        await Store.saveInfluencers(remaining);
        const favs = await Store.getFavorites();
        favs.forEach(g => { g.infIds = (g.infIds || []).filter(x => !ids.has(x)); });
        await Store.saveFavorites(favs);
        state.influencers = await Store.getInfluencers();
        state.favoriteGroups = await Store.getFavorites();
        state.compareIds = state.compareIds.filter(x => !ids.has(x));
        state.listIds = state.listIds.filter(x => !ids.has(x));
        state.selectedIds = [];
        toast('已删除 ' + ids.size + ' 位达人', 'success');
      }

      // 清空达人库（强确认，绕过所有筛选）
      async function clearAllInfluencers() {
        const total = state.influencers.length;
        if (!total) { toast('库内已无达人', 'info'); return; }
        if (!window.confirm('⚠ 确认清空全部 ' + total + ' 位达人？\n此操作将：\n• 清空达人库所有数据\n• 清空所有收藏分组内的达人引用\n• 已保存的项目清单将失去关联达人\n\n此操作不可撤销！')) return;
        if (!window.confirm('⚠ 再次确认：真的要删除全部 ' + total + ' 位达人吗？\n\n输入 "确定" 点击后将永久清空。')) return;
        await Store.clearInfluencers();
        const favs = await Store.getFavorites();
        favs.forEach(g => { g.infIds = []; });
        await Store.saveFavorites(favs);
        state.influencers = [];
        state.favoriteGroups = await Store.getFavorites();
        state.compareIds = [];
        state.listIds = [];
        state.selectedIds = [];
        toast('已清空达人库（共 ' + total + ' 位）', 'success');
      }

      // 恢复种子数据（清空库后若想快速恢复示例）
      async function reseedInfluencers() {
        if (state.influencers.length && !window.confirm('当前库内已有达人，追加示例数据可能产生重复。确定继续？')) return;
        // 强制重新注入：先移除种子标记，再注入
        localStorage.removeItem(Store.KEYS.SEED_FLAG);
        // 复用 ensureSeed 逻辑
        if (Store.isSeeded() || (await Store.getInfluencers()).length > 0) return;
        const seed = buildSeedData();
        await Store.upsertInfluencers(seed);
        Store.markSeeded();
        await Store.addFavoriteGroup('意向客户');
        await Store.addFavoriteGroup('备选池');
        state.influencers = await Store.getInfluencers();
        state.favoriteGroups = await Store.getFavorites();
        toast('已追加示例达人 ' + seed.length + ' 位', 'success');
      }

      // ---------- 项目需求多选辅助 ----------
      function addProjectCity() {
        const c = (newCity.value || '').trim();
        if (c && !state.projectReq.cities.includes(c)) state.projectReq.cities.push(c);
        newCity.value = '';
      }
      function addProjectTrack() {
        const t = (newTrack.value || '').trim();
        // tracks 也可作为偏好赛道（暂不使用，预留）
        newTrack.value = '';
      }

      // ---------- Toast ----------
      let toastTimer = null;
      function toast(text, type) {
        state.toast = { show: true, text, type: type || 'info' };
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { state.toast.show = false; }, 3200);
      }

      // ---------- 种子数据（仅操作 Store，不触碰 state，因 state 此时尚未初始化）----------
      function ensureSeed() {
        if (Store.isSeeded() || Store.getInfluencers().length > 0) return;
        const seed = buildSeedData();
        Store.upsertInfluencers(seed);
        Store.markSeeded();
        Store.addFavoriteGroup('意向客户');
        Store.addFavoriteGroup('备选池');
      }

      // 持久化监听：达人变动时写回（编辑/添加，当前未开放编辑表单，预留）
      function persistInfluencers() {
        Store.saveInfluencers(state.influencers);
      }

      // ---------- 暴露给模板 ----------
      return {
        state, newCity, newTrack, fieldOptions,
        platformOptions, cityOptions, trackOptions, tierOptions, projectTypeOptions,
        stats, filteredInfluencers, libraryInfluencers, detailInfluencer, compareList, favGroupInfluencers, isAllSelected,
        switchView, setViewMode, openDetail, closeDetail,
        toggleCompare, removeFromCompare, clearCompare, exportCompare,
        toggleListSelect, addFavoriteGroup, deleteFavGroup, toggleFav, isFav, isFavChecked, exportFavGroup,
        toggleArr, resetFilters, excludeAvoidOneShot,
        triggerImport, importFile, confirmImport, exportCurrent, downloadTemplate,
        runMatch, selectTopN, saveProjectList, exportProjectList, loadProject, deleteProject,
        deleteInfluencer, toggleSelect, toggleSelectAll, clearSelection, batchDelete, clearAllInfluencers, reseedInfluencers, addProjectCity,
        platformClass, tierClass, setSort,
        toast: (t, ty) => toast(t, ty),
        fmtNum, fmtPrice, fmtPct,
        scoreLevel: (s) => Matcher.scoreLevel(s)
      };
    }
  });

  // ---------- 种子数据 ----------
  function buildSeedData() {
    const base = [
      // 抖音-上海
      ['上海吃货老王', '抖音', 'https://www.douyin.com/user/laowang', 'wx_laowang', '13800000001', '上海', 520000, '腰部', '美食', '探店测评', ['会说沪语', '可议价'], 12000, 8000, '图文+视频', '某连锁餐饮品牌探店×8', false, '配合度高，出片快', 12, 2800000, 6.8, 350000],
      ['沪上探店阿May', '抖音', 'https://www.douyin.com/user/amay', 'wx_amay', '13800000002', '上海', 880000, '头部', '美食', '精致探店', ['榜单达人', 'GMV稳定'], 35000, 28000, '视频为主', '多个餐饮品牌月度合作', false, '需提前2周预约', 6, 5200000, 5.2, 1200000],
      ['魔都生活指南小林', '抖音', 'https://www.douyin.com/user/xiaolin', 'wx_xiaolin', '13800000003', '上海', 95000, '尾部', '生活', '本地生活攻略', ['可议价'], 6000, 3500, '图文+视频', '本地到店消费种草', false, '档期灵活', 18, 680000, 7.5, 80000],
      // 抖音-杭州
      ['杭州潮玩日记', '抖音', 'https://www.douyin.com/user/cw', 'wx_chaowan', '13800000004', '杭州', 1200000, '头部', '探店', '潮玩打卡', ['榜单达人'], 42000, 30000, '视频', '文旅景区打卡推广', false, '适合文旅项目', 8, 6800000, 4.8, 560000],
      ['杭城吃货阿杰', '抖音', 'https://www.douyin.com/user/ajie', 'wx_ajie', '13800000005', '杭州', 210000, '腰部', '美食', '接地气探店', ['可议价', '会说沪语'], 8000, 5000, '图文+视频', '连锁餐饮区域推广', false, '性价比高', 15, 1100000, 6.2, 180000],
      // 小红书-上海
      ['上海小资姐姐', '小红书', 'https://www.xiaohongshu.com/user/jj', 'wx_xjj', '13800000006', '上海', 360000, '腰部', '探店', '精致生活方式', ['榜单达人', 'GMV稳定'], 18000, 12000, '图文+视频', '高端餐饮种草', false, '调性匹配度高', 10, 920000, 8.1, 240000],
      ['魔都穿搭日记', '小红书', 'https://www.xiaohongshu.com/user/cd', 'wx_cd', '13800000007', '上海', 145000, '尾部', '穿搭', '时尚种草', ['可议价'], 5000, 3000, '图文为主', '服饰品牌种草', false, '', 9, 320000, 9.2, 45000],
      // 小红书-杭州
      ['杭州文艺生活家', '小红书', 'https://www.xiaohongshu.com/user/wy', 'wx_wy', '13800000008', '杭州', 280000, '腰部', '生活', '文艺打卡', ['榜单达人'], 16000, 10000, '图文+视频', '民宿文旅种草', false, '适合文旅调性', 7, 760000, 7.8, 130000],
      // 抖音-苏州
      ['苏州美食探子', '抖音', 'https://www.douyin.com/user/tz', 'wx_tz', '13800000009', '苏州', 180000, '腰部', '美食', '探店测评', ['可议价'], 7000, 4500, '视频', '苏州本地餐饮推广', false, '', 14, 880000, 6.0, 95000],
      ['江南文旅打卡', '抖音', 'https://www.douyin.com/user/jn', 'wx_jn', '13800000010', '苏州', 620000, '头部', '旅游', '风景打卡', ['GMV稳定'], 30000, 22000, '视频', '苏州景区文旅推广', false, '适合景区项目', 5, 3200000, 5.5, 420000],
      // 小红书-武汉
      ['武汉吃喝玩乐', '小红书', 'https://www.xiaohongshu.com/user/wh', 'wx_wh', '13800000011', '武汉', 420000, '腰部', '探店', '本地生活攻略', ['可议价', '榜单达人'], 15000, 9000, '图文+视频', '武汉到店消费种草', false, '', 11, 1100000, 7.2, 160000],
      ['江城潮流日记', '小红书', 'https://www.xiaohongshu.com/user/jc', 'wx_jc', '13800000012', '武汉', 88000, '尾部', '穿搭', '潮流种草', [], 4500, 2800, '图文', '服饰品牌种草', false, '', 8, 240000, 8.5, 30000],
      // 避雷达人
      ['某争议达人', '抖音', 'https://www.douyin.com/user/zz', 'wx_zz', '13800000013', '上海', 700000, '头部', '美食', '探店', [], 40000, 32000, '视频', '-', true, '近期有舆情，建议避雷', 3, 1800000, 3.1, 50000],
      // 素人
      ['上海新人小张', '小红书', 'https://www.xiaohongshu.com/user/xz', 'wx_xz', '13800000014', '上海', 8000, '素人', '生活', '日常分享', ['可议价'], 800, 500, '图文', '-', false, '成长期达人，价格低', 20, 45000, 12.0, 5000],
      // 顶流
      ['顶流生活家大V', '抖音', 'https://www.douyin.com/user/dv', 'wx_dv', '13800000015', '杭州', 3500000, '顶流', '生活', '综合', ['GMV稳定', '榜单达人'], 180000, 150000, '视频', '多个国民品牌合作', false, '需品牌方对接', 4, 25000000, 4.5, 8000000]
    ];
    const keys = ['nickname','platform','homepage','wechat','phone','city','followers','tier','track','style','tags','pricePublic','pricePrivate','coopMode','cases','avoid','coopNote','posts30d','totalViews','engagementRate','gmv'];
    return base.map(row => {
      const o = {};
      keys.forEach((k, i) => { o[k] = row[i]; });
      o.id = Store.genId();
      o.createdAt = Date.now();
      return o;
    });
  }

  global.App = app;
  // 挂载：若 DOM 已就绪则立即挂载，否则等待 DOMContentLoaded
  function mount() { app.mount('#app'); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})(window);
