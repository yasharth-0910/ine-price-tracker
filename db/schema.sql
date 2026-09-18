-- INE price tracker schema. Run in the Supabase SQL editor.

create extension if not exists "pgcrypto";

create type scrape_status as enum ('success', 'retried', 'failed', 'skipped_recent');
create type stock_status  as enum ('in_stock', 'low_stock', 'out_of_stock');
create type run_trigger   as enum ('cron', 'manual', 'headed');
create type rung          as enum ('json_api', 'embedded_json', 'dom', 'regex');

create table products (
  id                    uuid primary key default gen_random_uuid(),
  source_product_id     text        not null unique,
  name                  text        not null,
  url                   text        not null,
  image_url             text,
  category              text,
  tracking_enabled      boolean     not null default true,
  scrape_interval_mins  integer     not null default 120,
  last_attempt_at       timestamptz,
  last_success_at       timestamptz,
  consecutive_failures  integer     not null default 0,
  last_winning_rung     rung,
  layout_alert          boolean     not null default false,
  created_at            timestamptz not null default now()
);

create table scrape_runs (
  id             uuid primary key default gen_random_uuid(),
  trigger        run_trigger not null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  products_total integer not null default 0,
  succeeded      integer not null default 0,
  failed         integer not null default 0,
  skipped        integer not null default 0,
  notes          text
);

-- Successful, validated scrapes only. Never write here on failure.
create table price_history (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references products(id) on delete cascade,
  run_id       uuid references scrape_runs(id) on delete set null,
  price        numeric(12,2) not null check (price > 0 and price < 1000000),
  currency     text not null default 'USD',
  stock        stock_status not null,
  stock_qty    integer,
  rung         rung not null,
  raw_price    text not null,
  anomalous    boolean not null default false,
  scraped_at   timestamptz not null default now()
);

-- One row per attempt. Failures included, on purpose.
create table scrape_logs (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references products(id) on delete cascade,
  run_id        uuid references scrape_runs(id) on delete set null,
  attempt_no    integer not null,
  status        scrape_status not null,
  fetcher       text not null,
  rung          rung,
  http_status   integer,
  duration_ms   integer not null,
  error_code    text,
  error_message text,
  created_at    timestamptz not null default now()
);

create table alerts (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references products(id) on delete cascade,
  kind         text not null,          -- price_drop | back_in_stock | layout_change
  old_value    text,
  new_value    text,
  seen         boolean not null default false,
  created_at   timestamptz not null default now()
);

create index price_history_product_time on price_history (product_id, scraped_at desc);
create index scrape_logs_product_time   on scrape_logs   (product_id, created_at desc);
create index scrape_logs_run            on scrape_logs   (run_id);
create index products_enabled           on products      (tracking_enabled) where tracking_enabled;

-- Latest snapshot per product, for the dashboard.
create view product_latest as
select distinct on (p.id)
  p.id, p.name, p.url, p.image_url, p.tracking_enabled,
  p.consecutive_failures, p.layout_alert, p.last_attempt_at, p.last_success_at,
  h.price, h.stock, h.scraped_at, h.anomalous
from products p
left join price_history h on h.product_id = p.id
order by p.id, h.scraped_at desc nulls last;
