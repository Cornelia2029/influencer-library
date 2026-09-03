// =====================================================
// Supabase 配置文件
// 如果以后换项目，改这里两个值就行
// =====================================================
window.SUPABASE_CONFIG = {
  url: 'https://ptqgknnyuwmlniwocsck.supabase.co',
  key: 'sb_publishable_OKvvdKE6w-xfUzkLJ21K8A_3VByP1aC',
  // 表名常量（和 supabase-setup.sql 一致）
  tables: {
    influencers:     'influencers',
    favoriteGroups:  'favorite_groups',
    projects:        'projects',
    settings:        'settings'
  }
};
