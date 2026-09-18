-- Migration 002: two corrections to the original schema.
-- Paste into the Supabase SQL editor. Assumes migration 001 and the original schema are applied.

-- 1. The store is INR (Intl.NumberFormat en-IN), not USD.
alter table price_history alter column currency set default 'INR';

-- 2. The `rung` enum no longer describes how extraction works. Per STORE.md the price is read
--    from the element carrying layout.classes.priceValue. Record what actually happened instead:
--    which layout window the scrape ran under, and where the value was read from.
alter table price_history
  add column if not exists layout_revision  int,
  add column if not exists layout_variant   int,
  add column if not exists extraction_source text;

alter table scrape_logs
  add column if not exists layout_revision  int,
  add column if not exists layout_variant   int,
  add column if not exists extraction_source text;

alter table price_history drop column if exists rung;
alter table scrape_logs   drop column if exists rung;

-- products.last_winning_rung becomes last_layout_revision (an int, not an enum).
alter table products drop column if exists last_winning_rung;
alter table products add column if not exists last_layout_revision int;

-- The enum is now unused.
drop type if exists rung;
