-- =====================================================
-- 达人资源匹配系统 · Supabase 建表 SQL (v2 - camelCase 列名)
-- 必须跑完才能用！先 DROP 旧表再建新表
-- =====================================================

-- ========== 先删旧表（如果有） ==========
drop table if exists public.influencers cascade;
drop table if exists public.favorite_groups cascade;
drop table if exists public.projects cascade;
drop table if exists public.settings cascade;

-- ========== 1. 达人库主表（列名和前端 JS 完全一致，不做 snake_case 转换） ==========
create table public.influencers (
  id uuid primary key default gen_random_uuid(),
  nickname text,
  platform text,
  homepage text,
  wechat text,
  phone text,
  city text,
  followers numeric,
  tier text,
  track text,
  style text,
  tags text,                    -- JSON 数组存为 text
  "pricePublic" numeric,
  "pricePrivate" numeric,
  "coopMode" text,
  cases text,
  avoid boolean default false,
  "coopNote" text,
  "posts30d" integer,
  "totalViews" numeric,
  "interactions30d" integer,
  "engagementRate" numeric,
  gmv numeric,
  "pugongyingEnabled" boolean default false,
  "createdAt" timestamptz default now(),
  "updatedAt" timestamptz default now()
);

-- ========== 2. 收藏夹分组 ==========
create table public.favorite_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  "infIds" text,
  "createdAt" timestamptz default now()
);

-- ========== 3. 项目匹配清单 ==========
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  req text,
  "infIds" text,
  "createdAt" timestamptz default now()
);

-- ========== 4. 系统设置 ==========
create table public.settings (
  key text primary key,
  value text,
  "updatedAt" timestamptz default now()
);

-- ========== RLS：所有人可读可写 ==========
alter table public.influencers enable row level security;
alter table public.favorite_groups enable row level security;
alter table public.projects enable row level security;
alter table public.settings enable row level security;

-- influencers
drop policy if exists "inf_r" on public.influencers;
drop policy if exists "inf_i" on public.influencers;
drop policy if exists "inf_u" on public.influencers;
drop policy if exists "inf_d" on public.influencers;
create policy "inf_r" on public.influencers for select using (true);
create policy "inf_i" on public.influencers for insert with check (true);
create policy "inf_u" on public.influencers for update using (true);
create policy "inf_d" on public.influencers for delete using (true);

-- favorite_groups
drop policy if exists "fav_r" on public.favorite_groups;
drop policy if exists "fav_i" on public.favorite_groups;
drop policy if exists "fav_u" on public.favorite_groups;
drop policy if exists "fav_d" on public.favorite_groups;
create policy "fav_r" on public.favorite_groups for select using (true);
create policy "fav_i" on public.favorite_groups for insert with check (true);
create policy "fav_u" on public.favorite_groups for update using (true);
create policy "fav_d" on public.favorite_groups for delete using (true);

-- projects
drop policy if exists "prj_r" on public.projects;
drop policy if exists "prj_i" on public.projects;
drop policy if exists "prj_u" on public.projects;
drop policy if exists "prj_d" on public.projects;
create policy "prj_r" on public.projects for select using (true);
create policy "prj_i" on public.projects for insert with check (true);
create policy "prj_u" on public.projects for update using (true);
create policy "prj_d" on public.projects for delete using (true);

-- settings
drop policy if exists "set_r" on public.settings;
drop policy if exists "set_i" on public.settings;
drop policy if exists "set_u" on public.settings;
drop policy if exists "set_d" on public.settings;
create policy "set_r" on public.settings for select using (true);
create policy "set_i" on public.settings for insert with check (true);
create policy "set_u" on public.settings for update using (true);
create policy "set_d" on public.settings for delete using (true);

-- 自动更新 updatedAt
create or replace function public.set_updated_at() returns trigger as $$
begin
  new."updatedAt" = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_inf_upd on public.influencers;
create trigger trg_inf_upd before update on public.influencers
  for each row execute function public.set_updated_at();

drop trigger if exists trf_fav_upd on public.favorite_groups;
create trigger trf_fav_upd before update on public.favorite_groups
  for each row execute function public.set_updated_at();

drop trigger if exists trg_prj_upd on public.projects;
create trigger trg_prj_upd before update on public.projects
  for each row execute function public.set_updated_at();

drop trigger if exists trg_set_upd on public.settings;
create trigger trg_set_upd before update on public.settings
  for each row execute function public.set_updated_at();

-- 通知 PostgREST 刷新 schema cache
NOTIFY pgrst, 'reload schema';

-- =====================================================
-- ✅ 跑完后应该能看到 4 张表，所有列名和前端 JS 一致
-- ✅ curl https://.../rest/v1/influencers 应该返回 []（空数组，HTTP 200）
-- ✅ curl POST 一条数据进去，应该能成功
-- =====================================================
