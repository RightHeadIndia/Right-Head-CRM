-- Right Head CRM PostgreSQL schema for Neon.
-- Safe to run repeatedly. This script never deletes or truncates data.
BEGIN;
CREATE TABLE IF NOT EXISTS public.records (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE TABLE IF NOT EXISTS public.meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON public.records (collection);
COMMIT;
