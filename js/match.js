/* 达人资源匹配系统 - 智能匹配算法
 * 输入项目需求，对每个达人评分(0-100)并给出匹配理由
 */
(function (global) {
  'use strict';

  // 项目类型 → 相关赛道关键词
  const TRACK_KEYWORDS = {
    '餐饮': ['美食', '探店', '餐饮', '吃喝', '吃播', '菜', '饮', '餐厅', '外卖'],
    '文旅': ['旅游', '旅行', '风景', '打卡', '民宿', '攻略', '文旅', '景区', '游', '出行'],
    '到店消费': ['探店', '美食', '生活', '到店', '打卡', '测评', '逛街', '消费', '本地'],
    '美妆': ['美妆', '护肤', '彩妆', '化妆', '护肤'],
    '服饰': ['穿搭', '服饰', '服装', '时尚', '潮流'],
    '通用': []
  };

  const TIER_RANK = { '素人': 1, '尾部': 2, '腰部': 3, '头部': 4, '顶流': 5 };

  // 城市同省份/同城圈兜底匹配
  const CITY_GROUP = {
    '上海': ['上海', '沪'],
    '杭州': ['杭州', '浙江', '浙'],
    '苏州': ['苏州', '江苏', '苏南'],
    '武汉': ['武汉', '湖北', '鄂'],
    '南京': ['南京', '江苏'],
    '宁波': ['宁波', '浙江']
  };

  function normalize(s) { return String(s || '').trim().toLowerCase(); }

  function containsAny(text, keywords) {
    const t = normalize(text);
    return keywords.some(k => t.indexOf(normalize(k)) >= 0);
  }

  const Matcher = {
    TRACK_KEYWORDS,
    TIER_RANK,

    // 为单个达人计算匹配
    scoreInfluencer(inf, req) {
      const reasons = [];
      let score = 0;
      let disqualified = false;
      const reqPlatforms = (req.platforms || []).map(normalize).filter(Boolean);
      const reqCities = (req.cities || []).filter(Boolean);
      const projectType = req.projectType || '通用';
      const trackKw = TRACK_KEYWORDS[projectType] || [];

      // 1. 避雷硬性排除（除非用户明确要求不排除）
      if (inf.avoid && req.excludeAvoid !== false) {
        disqualified = true;
        reasons.push({ type: 'warn', text: '该达人标记为避雷，建议谨慎' });
      }

      // 2. 平台匹配 (25分)
      if (reqPlatforms.length) {
        if (reqPlatforms.includes(normalize(inf.platform))) {
          score += 25;
          reasons.push({ type: 'good', text: `平台匹配（${inf.platform}）` });
        } else {
          reasons.push({ type: 'bad', text: `平台不符（需 ${reqPlatforms.join('/')}，现为 ${inf.platform || '未填'}）` });
        }
      } else {
        score += 12; // 未限定平台，给基准分
      }

      // 3. 城市匹配 (25分)
      if (reqCities.length) {
        const infCity = normalize(inf.city);
        const exact = reqCities.some(c => normalize(c) === infCity);
        if (exact) {
          score += 25;
          reasons.push({ type: 'good', text: `城市匹配（${inf.city}）` });
        } else {
          // 同城圈兜底
          const groupHit = reqCities.some(c => {
            const g = CITY_GROUP[normalize(c)];
            return g && g.some(k => infCity.indexOf(normalize(k)) >= 0);
          });
          if (groupHit) {
            score += 15;
            reasons.push({ type: 'ok', text: `同城圈覆盖（${inf.city}）` });
          } else {
            reasons.push({ type: 'bad', text: `城市不符（需 ${reqCities.join('/')}）` });
          }
        }
      } else {
        score += 12;
      }

      // 4. 赛道契合 (20分)
      if (trackKw.length) {
        const hay = (inf.track || '') + ' ' + (inf.style || '') + ' ' + ((inf.tags || []).join(' '));
        const hit = trackKw.filter(k => containsAny(hay, [k]));
        if (hit.length) {
          const s = Math.min(20, 8 + hit.length * 4);
          score += s;
          reasons.push({ type: 'good', text: `赛道契合（${[...new Set(hit)].slice(0, 3).join('、')}）` });
        } else {
          reasons.push({ type: 'bad', text: `赛道偏离（偏好 ${trackKw.slice(0, 3).join('、')}）` });
        }
      } else {
        score += 10;
      }

      // 5. 预算匹配 (15分)
      const price = inf.pricePrivate || inf.pricePublic || 0;
      if (req.budgetMin != null && req.budgetMax != null && req.budgetMax > 0) {
        // 单达人预算 ≈ 总预算 / 需要数量，但用区间宽松判断
        const perMax = req.budgetMax / Math.max(1, req.count || 1);
        const perMin = req.budgetMin / Math.max(1, req.count || 1);
        if (price > 0) {
          if (price <= perMax && price >= perMin) {
            score += 15;
            reasons.push({ type: 'good', text: `报价在预算内（${formatPrice(price)}）` });
          } else if (price <= perMax) {
            score += 10;
            reasons.push({ type: 'ok', text: `报价低于预算（${formatPrice(price)}）` });
          } else if (price <= perMax * 1.2) {
            score += 6;
            reasons.push({ type: 'ok', text: `报价略超预算（${formatPrice(price)}）` });
          } else {
            reasons.push({ type: 'bad', text: `报价超预算（${formatPrice(price)}）` });
          }
        }
      } else {
        score += 6;
      }

      // 6. 层级适配 (8分) - 根据预算规模推断期望层级
      if (req.budgetMax != null && req.count) {
        const perMax = req.budgetMax / req.count;
        let expectTier;
        if (perMax >= 50000) expectTier = ['头部', '顶流'];
        else if (perMax >= 15000) expectTier = ['腰部', '头部'];
        else if (perMax >= 5000) expectTier = ['尾部', '腰部'];
        else expectTier = ['素人', '尾部'];
        if (inf.tier && expectTier.includes(inf.tier)) {
          score += 8;
          reasons.push({ type: 'good', text: `层级适配（${inf.tier}）` });
        }
      } else {
        score += 4;
      }

      // 7. 效果数据加分 (7分)
      let effectScore = 0;
      if (inf.gmv && inf.gmv > 100000) { effectScore += 3; reasons.push({ type: 'ok', text: 'GMV表现稳定' }); }
      if (inf.engagementRate && inf.engagementRate >= 5) { effectScore += 2; reasons.push({ type: 'ok', text: `互动率优秀（${inf.engagementRate}%）` }); }
      if (inf.tags && inf.tags.includes('GMV稳定')) { effectScore += 2; reasons.push({ type: 'ok', text: '标签：GMV稳定' }); }
      score += Math.min(7, effectScore);

      // 8. 特殊属性加分
      if (inf.tags && inf.tags.length) {
        const bonusTags = ['可议价', '榜单达人', '会说沪语', '配合度高'];
        const hitTags = inf.tags.filter(t => bonusTags.includes(t));
        if (hitTags.length) {
          score += Math.min(5, hitTags.length * 2);
          reasons.push({ type: 'ok', text: `加分属性（${hitTags.join('、')}）` });
        }
      }

      score = Math.max(0, Math.min(100, Math.round(score)));
      return {
        influencer: inf,
        matchScore: score,
        matchReason: reasons.map(r => r.text).join('；'),
        reasons,
        disqualified
      };
    },

    // 批量匹配，返回按分数降序
    matchAll(influencers, req) {
      const results = influencers
        .map(inf => this.scoreInfluencer(inf, req))
        .filter(r => !r.disqualified || req.includeAvoid)
        .sort((a, b) => b.matchScore - a.matchScore);
      return results;
    },

    // 生成匹配度等级标签
    scoreLevel(score) {
      if (score >= 80) return { label: '高度匹配', cls: 'level-high' };
      if (score >= 60) return { label: '较匹配', cls: 'level-mid' };
      if (score >= 40) return { label: '一般', cls: 'level-low' };
      return { label: '弱匹配', cls: 'level-weak' };
    }
  };

  function formatPrice(n) {
    if (n >= 10000) return (n / 10000).toFixed(1) + '万';
    return n + '元';
  }

  global.Matcher = Matcher;
})(window);
