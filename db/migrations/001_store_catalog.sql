-- Migration 001: local mirror of the store catalogue.
-- The store has no search endpoint and /api/catalog randomises order + caps pageSize at 60,
-- so we crawl /api/product/{id} for ids 1..1000 and search this table with ILIKE.
-- Safe to run once against an existing DB (idempotent create-if-not-exists).

create extension if not exists pg_trgm;

create table if not exists store_catalog (
  id            int primary key,          -- the store's own product id (1..1000)
  slug          text,
  name          text        not null,
  brand         text,
  category      text,
  sku           text,
  description   text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  missing       boolean     not null default false
);

-- Trigram GIN index so `name ILIKE '%q%'` (leading wildcard) can use an index.
create index if not exists store_catalog_name_trgm on store_catalog using gin (name gin_trgm_ops);
