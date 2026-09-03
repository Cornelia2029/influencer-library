/* 达人资源匹配系统 - Excel 导入/导出模块
 * 依赖：SheetJS (XLSX)
 * 导入：两阶段 —— parseWorkbook + autoDetectMapping 供预览，buildInfluencers 生成数据
 *      智能表头识别（精确 + 包含匹配）、忽略无关列、w/万/亿/区间数值解析、
 *      主页链接清理、平台推断、层级按粉丝量自动推断
 * 导出：筛选结果 / 项目推荐清单 / 导入模板
 */
(function (global) {
  'use strict';

  if (!global.XLSX) {
    console.warn('[ExcelIO] XLSX 未加载，Excel 功能不可用');
  }

  // 字段元数据：key -> {label, aliases[]}
  const SCHEMA = [
    { key: 'nickname', label: '达人昵称', aliases: ['达人昵称', '昵称', '名称', '达人名称', '账号名称', '达人', '抖音昵称', '小红书昵称', '博主昵称', '账号昵称', '达人账号', '博主名称', '达人名', '账号名', '达人handle'] },
    { key: 'platform', label: '所属平台', aliases: ['所属平台', '平台', '发布平台', '渠道', '平台类型'] },
    { key: 'homepage', label: '主页链接', aliases: ['主页链接', '主页', '主页url', '链接', '主页地址', '个人主页链接', '个人主页', '账号链接', '抖音主页', '小红书主页', '主页连接', '地址'] },
    { key: 'wechat', label: '微信号', aliases: ['微信号', '微信', 'wechat', '微信號', '微信联系方式', '联系方式(微信)', 'wx'] },
    { key: 'phone', label: '手机号', aliases: ['手机号', '手机', '电话', '联系方式', '联系电话', '手机号码', '电话号码'] },
    { key: 'city', label: '常驻城市', aliases: ['常驻城市', '城市', '所在城市', '达人城市', '驻地', '所在地', '地域', '地区', '常驻地', 'ip属地'] },
    { key: 'followers', label: '粉丝量级', aliases: ['粉丝量级', '粉丝数', '粉丝量', '粉丝', '粉丝数量', '粉丝总量', '粉丝规模', '关注数', '粉丝数(万)'], type: 'number' },
    { key: 'tier', label: '达人层级', aliases: ['达人层级', '层级', '达人等级', '等级', '达人级别', '级别', '达人分类', '达人梯队'] },
    { key: 'track', label: '核心赛道', aliases: ['核心赛道', '赛道', '领域', '垂类', '内容赛道', '类目', '内容分类', '账号类型'] },
    { key: 'style', label: '内容风格', aliases: ['内容风格', '风格', '内容类型', '内容形式'] },
    { key: 'tags', label: '特殊属性', aliases: ['特殊属性', '标签', '属性', '特殊标签', '达人标签', '内容标签'], type: 'tags' },
    { key: 'pricePublic', label: '水上报价', aliases: ['水上报价', '水上', '公开报价', '官方报价', '报价(水上)', '刊例价', '报价', '视频报价', '图文报价', '直播报价'], type: 'number' },
    { key: 'pricePrivate', label: '水下报价', aliases: ['水下报价', '水下', '实际报价', '底价', '报价(水下)', '合作价', '成交价'], type: 'number' },
    { key: 'coopMode', label: '合作模式', aliases: ['合作模式', '合作方式', '合作类型', '合作形式'] },
    { key: 'cases', label: '过往合作案例', aliases: ['过往合作案例', '合作案例', '案例', '过往案例', '代表案例', '合作品牌'] },
    { key: 'avoid', label: '是否避雷', aliases: ['是否避雷', '避雷', '是否避雷达人', '避雷达人'], type: 'bool' },
    { key: 'coopNote', label: '合作备注', aliases: ['合作备注', '备注', '合作说明', '说明'] },
    { key: 'posts30d', label: '近30天投稿数', aliases: ['近30天投稿数', '30天投稿', '投稿数', '近30天投稿', '月投稿数', '近30天作品数', '作品数', '近30天发布笔记总数', '近30天发布笔记数', '笔记数', '发布笔记数', '笔记篇数'], type: 'number' },
    { key: 'totalViews', label: '总播放/阅读量', aliases: ['总播放量', '播放量', '总播放', '播放', '总播放/阅读量', '阅读量', '近30天播放量', '近30天总观看数', '近30天观看数', '观看量', '近30天阅读量', '总观看数'], type: 'number' },
    { key: 'interactions30d', label: '近30天总互动数', aliases: ['近30天总互动数', '近30天互动数', '总互动数', '互动总数', '近30天互动量', '30天互动总数', '近30天互动数据'], type: 'number' },
    { key: 'engagementRate', label: '互动率(%)', aliases: ['互动率', '互动率(%)', '互动率%'], type: 'number' },
    { key: 'gmv', label: '成交GMV', aliases: ['成交GMV', 'GMV', '成交gmv', '带货GMV', '带货金额', '销售额', '成交金额'], type: 'number' },
    { key: 'pugongyingEnabled', label: '是否开通蒲公英', aliases: ['是否已开通蒲公英', '是否开通蒲公英', '蒲公英', '开通蒲公英', '蒲公英开通', '蒲公英状态'], type: 'bool' }
  ];

  // 明确忽略的列（精确匹配，归一化后）
  const IGNORE_HEADERS = ['序号', '编号', 'no', 'no.', 'id号', '任务金', 'sku', '佣金比例'];
  // 含关键词即忽略（如各种截图列）
  const IGNORE_KEYWORDS = ['截图', '头像', '二维码'];

  function normHeader(s) {
    return String(s || '').trim().toLowerCase()
      .replace(/[\s_（）()【】\[\]·・]/g, '');
  }

  // 检测表头单位后缀，如 "粉丝数(万)"、"粉丝数(w)" → 返回 {name:'粉丝数', mult:10000}
  function splitUnit(header) {
    const raw = String(header || '').trim();
    const m = raw.match(/^(.*?)[（(]\s*(亿万|亿|万|w|k)\s*[）)]$/i);
    if (m) {
      return { name: m[1], mult: unitMult(m[2]) };
    }
    return { name: raw, mult: 1 };
  }

  function unitMult(u) {
    if (!u) return 1;
    const s = String(u).toLowerCase();
    if (s === '亿' || s === '亿万') return 1e8;
    if (s === '万' || s === 'w') return 1e4;
    if (s === 'k') return 1e3;
    return 1;
  }

  function buildAliasIndex() {
    const aliasMap = {};
    SCHEMA.forEach(f => {
      const add = a => { const k = normHeader(a); if (k && aliasMap[k] == null) aliasMap[k] = f.key; };
      f.aliases.forEach(add);
      add(f.label);
    });
    return aliasMap;
  }
  const ALIAS_INDEX = buildAliasIndex();

  // 自动识别列映射：{colMap:{colIndex:fieldKey}, platformHint:''}
  function autoDetectMapping(headers) {
    const colMap = {};
    const usedFields = new Set();
    let platformHint = '';
    const headersNorm = headers.map(h => {
      const { name, mult } = splitUnit(h);
      return { raw: String(h || ''), norm: normHeader(name), mult };
    });
    // 平台线索：表头含"抖音昵称"等
    const allText = headers.join(' ');
    if (/抖音|douyin/.test(allText)) platformHint = '抖音';
    else if (/小红书|xiaohongshu|红书/.test(allText)) platformHint = '小红书';
    else if (/快手/.test(allText)) platformHint = '快手';

    // 第一轮：精确匹配
    headersNorm.forEach((h, i) => {
      if (!h.norm) return;
      if (IGNORE_HEADERS.includes(h.norm) || IGNORE_KEYWORDS.some(k => h.raw.indexOf(k) >= 0)) return;
      const key = ALIAS_INDEX[h.norm];
      if (key && !usedFields.has(key)) {
        colMap[i] = key;
        usedFields.add(key);
      }
    });
    // 第二轮：包含匹配（表头包含别名 或 别名包含表头，匹配部分长度>=2）
    headersNorm.forEach((h, i) => {
      if (colMap[i] || !h.norm || h.norm.length < 2) return;
      if (IGNORE_HEADERS.includes(h.norm) || IGNORE_KEYWORDS.some(k => h.raw.indexOf(k) >= 0)) return;
      let best = null, bestLen = 0;
      for (const alias in ALIAS_INDEX) {
        if (alias.length < 2) continue;
        const field = ALIAS_INDEX[alias];
        if (usedFields.has(field)) continue;
        let hit = null;
        if (h.norm.indexOf(alias) >= 0) hit = alias;          // 表头包含别名
        else if (alias.indexOf(h.norm) >= 0) hit = h.norm;    // 别名包含表头
        if (hit && hit.length > bestLen) { best = field; bestLen = hit.length; }
      }
      if (best) {
        colMap[i] = best;
        usedFields.add(best);
      }
    });
    return { colMap, platformHint };
  }

  function parseTags(v) {
    if (Array.isArray(v)) return v;
    if (v == null || v === '') return [];
    return String(v).split(/[,，、|/；;\n\r]+/).map(s => s.trim()).filter(Boolean);
  }

  function parseBool(v) {
    if (typeof v === 'boolean') return v;
    if (v == null || v === '') return false;
    const s = String(v).trim().toLowerCase();
    return ['是', 'true', '1', 'yes', 'y', '✓', '避雷', '已开通', '开通', '开', '已入驻', '入驻', '已认证', '认证'].includes(s);
  }

  // 数值解析：支持 "87w" "1.5w" "1-10万" "1.2万+" "3亿" "1,234" "5k"
  function parseNumber(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isNaN(v) ? null : v;
    let s = String(v).trim().replace(/,/g, '');
    if (!s) return null;
    let mult = 1;
    // 区间 "1-10万" / "10~50w" → 取上限
    const range = s.match(/^([\d.]+)\s*[-~～至到]\s*([\d.]+)\s*(亿万|亿|万|[wk])?\s*\+?$/i);
    if (range) {
      s = range[2];
      mult = unitMult(range[3]);
    } else {
      const m = s.match(/^([\d.]+)\s*(亿万|亿|万|[wk])?\s*\+?$/i);
      if (m) {
        s = m[1];
        mult = unitMult(m[2]);
      } else {
        s = s.replace(/[^\d.\-]/g, '');
      }
    }
    if (s === '' || s === '-' || s === '.') return null;
    const n = parseFloat(s);
    return isNaN(n) ? null : Math.round(n * mult);
  }

  // 主页链接清理：截取第一个 http(s) 片段，去掉口令尾巴
  function cleanUrl(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    const m = s.match(/https?:\/\/\S+/i);
    if (m) return m[0].replace(/[，,。；;）)]+$/, '');
    return s.split(/\s+/)[0];
  }

  const STANDARD_TIERS = ['素人', '尾部', '腰部', '头部', '顶流'];
  // 按粉丝量推断层级
  function inferTierByFollowers(f) {
    if (!f || f <= 0) return '';
    if (f <= 10000) return '素人';
    if (f <= 100000) return '尾部';
    if (f <= 500000) return '腰部';
    if (f <= 1000000) return '头部';
    return '顶流';
  }
  // 层级解析：标准层级直接用；"Lv.5"/"5级" 等等级值返回空（由粉丝量推断）
  function parseTier(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    if (STANDARD_TIERS.includes(s)) return s;
    const aliasMap = { '初级': '素人', '初级达人': '素人', 'koc': '素人', '中腰部': '腰部', '中级': '腰部', '大v': '头部', '知名达人': '头部', '明星': '顶流', '超头': '顶流', '超级头部': '顶流' };
    if (aliasMap[s.toLowerCase()]) return aliasMap[s.toLowerCase()];
    return '';
  }

  // 行级平台推断
  function inferPlatform(rowPlatform, homepage, platformHint) {
    if (rowPlatform) return rowPlatform;
    const hp = String(homepage || '').toLowerCase();
    if (/douyin|v\.douyin/.test(hp)) return '抖音';
    if (/xiaohongshu|xhslink/.test(hp)) return '小红书';
    if (/kuaishou/.test(hp)) return '快手';
    if (/weibo/.test(hp)) return '微博';
    if (/bilibili|b23/.test(hp)) return 'B站';
    return platformHint || '';
  }

  const fieldByKey = {};
  SCHEMA.forEach(f => fieldByKey[f.key] = f);

  const ExcelIO = {
    SCHEMA,
    autoDetectMapping,
    inferTierByFollowers,

    // 阶段1：解析文件 → {headers, rows, sheetNames}
    async parseWorkbook(file) {
      if (!global.XLSX) throw new Error('Excel 解析库未加载');
      const buf = await file.arrayBuffer();
      const wb = global.XLSX.read(buf, { type: 'array' });
      const firstSheet = wb.SheetNames[0];
      if (!firstSheet) throw new Error('文件中没有工作表');
      const ws = wb.Sheets[firstSheet];
      const rows = global.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
      if (!rows.length) throw new Error('文件为空');
      return { headers: rows[0], rows: rows.slice(1), sheetNames: wb.SheetNames };
    },

    // 阶段2：按映射生成达人数据（不做持久化）；headers 可选，用于检测 "粉丝数(万)" 类列单位
    buildInfluencers(rows, colMap, platformHint, headers) {
      const data = [];
      let skipped = 0;
      // 预计算列单位（表头带 (万)/(w) 后缀的数值列）
      const colMults = {};
      if (headers) {
        Object.keys(colMap).forEach(ci => {
          const { mult } = splitUnit(headers[ci]);
          colMults[ci] = mult;
        });
      }
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if (!row || row.every(c => c === '' || c == null)) { skipped++; continue; }
        const inf = {};
        Object.keys(colMap).forEach(ci => {
          const key = colMap[ci];
          const field = fieldByKey[key];
          if (!field) return;
          let val = row[ci];
          if (field.type === 'number') {
            val = parseNumber(val);
            if (val != null && colMults[ci] > 1) val = val * colMults[ci];
          }
          else if (field.type === 'tags') val = parseTags(val);
          else if (field.type === 'bool') val = parseBool(val);
          else if (key === 'homepage') val = cleanUrl(val);
          else val = val == null ? '' : String(val).trim();
          inf[key] = val;
        });
        // 无昵称且无联系方式 → 跳过
        if (!inf.nickname && !inf.phone && !inf.wechat && !inf.homepage) { skipped++; continue; }
        // 子表头行过滤：昵称恰好是表头词（如"小红书昵称"）且其余字段全空 → 跳过
        const HEADER_LIKE = ['昵称', '抖音昵称', '小红书昵称', '达人昵称', '账号名称', '博主昵称', '粉丝数', '达人等级', '个人主页链接'];
        if (HEADER_LIKE.includes(inf.nickname) && !inf.followers && !inf.homepage && !inf.phone && !inf.wechat) { skipped++; continue; }
        // 平台推断
        inf.platform = inferPlatform(inf.platform, inf.homepage, platformHint);
        // 层级：标准层级 > 粉丝量推断（"Lv.5"/"5级"等非标准值走粉丝推断）
        const rawTier = inf.tier || '';
        inf.tier = parseTier(rawTier) || inferTierByFollowers(inf.followers);
        // 层级原始等级（如 Lv.5）附加到标签，保留信息不丢失
        if (rawTier && !STANDARD_TIERS.includes(rawTier) && inf.tags && inf.tags.indexOf(rawTier) < 0) {
          inf.tags.push(rawTier);
        }
        data.push(inf);
      }
      return { data, skipped };
    },

    // 兼容旧接口：一步导入
    async importFile(file) {
      const { headers, rows } = await this.parseWorkbook(file);
      const { colMap, platformHint } = autoDetectMapping(headers);
      if (!Object.keys(colMap).length) throw new Error('未识别到任何字段表头，请检查首行字段名');
      const { data, skipped } = this.buildInfluencers(rows, colMap, platformHint);
      const stats = Store.upsertInfluencers(data);
      return { data, stats: Object.assign({}, stats, { skipped }) };
    },

    // 导出为 Excel
    exportToExcel(rows, filename) {
      if (!global.XLSX) throw new Error('Excel 库未加载');
      const cols = SCHEMA;
      const header = cols.map(c => c.label);
      const aoa = [header];
      rows.forEach(inf => {
        aoa.push(cols.map(c => {
          let v = inf[c.key];
          if (c.type === 'tags') v = Array.isArray(v) ? v.join('、') : (v || '');
          else if (c.type === 'bool') v = v ? '是' : '否';
          else if (c.type === 'number') v = (v == null || v === '') ? '' : v;
          else v = v == null ? '' : v;
          return v;
        }));
      });
      const ws = global.XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = cols.map(c => ({ wch: Math.max(10, c.label.length * 2 + 4) }));
      const wb = global.XLSX.utils.book_new();
      global.XLSX.utils.book_append_sheet(wb, ws, '达人库');
      const fn = filename || ('达人导出_' + formatDate() + '.xlsx');
      global.XLSX.writeFile(wb, fn);
    },

    // 导出项目推荐清单（含匹配度、匹配理由）
    exportProjectList(rows, projectName) {
      if (!global.XLSX) throw new Error('Excel 库未加载');
      const header = ['达人昵称', '所属平台', '常驻城市', '达人层级', '核心赛道', '粉丝量级', '水上报价', '水下报价', '互动率(%)', '成交GMV', '匹配度', '匹配理由'];
      const aoa = [header];
      rows.forEach(r => {
        aoa.push([
          r.nickname || '', r.platform || '', r.city || '', r.tier || '', r.track || '',
          r.followers || '', r.pricePublic || '', r.pricePrivate || '', r.engagementRate || '', r.gmv || '',
          (r.matchScore != null ? r.matchScore + '分' : ''), r.matchReason || ''
        ]);
      });
      const ws = global.XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = header.map(h => ({ wch: Math.max(12, h.length * 2 + 4) }));
      ws['!cols'][header.length - 1].wch = 50;
      const wb = global.XLSX.utils.book_new();
      global.XLSX.utils.book_append_sheet(wb, ws, '推荐清单');
      const fn = (projectName || '达人推荐清单') + '_' + formatDate() + '.xlsx';
      global.XLSX.writeFile(wb, fn);
    },

    // 下载导入模板
    downloadTemplate() {
      if (!global.XLSX) throw new Error('Excel 库未加载');
      const sample = [
        ['达人昵称', '所属平台', '主页链接', '微信号', '手机号', '常驻城市', '粉丝量级', '达人层级', '核心赛道', '内容风格', '特殊属性', '水上报价', '水下报价', '合作模式', '过往合作案例', '是否避雷', '合作备注', '近30天投稿数', '总播放量', '互动率(%)', '成交GMV'],
        ['上海吃货老王', '抖音', 'https://www.douyin.com/user/xxx', 'wx_laowang', '13800000001', '上海', 520000, '腰部', '美食', '探店测评', '会说沪语、可议价', 12000, 8000, '图文+视频', '某连锁餐饮品牌探店', '否', '配合度高，出片快', 12, 2800000, 6.8, 350000]
      ];
      const ws = global.XLSX.utils.aoa_to_sheet(sample);
      ws['!cols'] = sample[0].map(h => ({ wch: 16 }));
      const wb = global.XLSX.utils.book_new();
      global.XLSX.utils.book_append_sheet(wb, ws, '导入模板');
      global.XLSX.writeFile(wb, '达人库导入模板.xlsx');
    }
  };

  function formatDate() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  global.ExcelIO = ExcelIO;
})(window);
