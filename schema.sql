-- Schema for Multimodal RAG metadata storage
-- Run: wrangler d1 execute rag-metadata --file=schema.sql (local)
-- Run: wrangler d1 execute rag-metadata --remote --file=schema.sql (production)

CREATE TABLE IF NOT EXISTS pages (
  id          TEXT PRIMARY KEY,
  file_name   TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  total_pages INTEGER NOT NULL,
  description TEXT,
  r2_key      TEXT NOT NULL,
  file_type   TEXT DEFAULT 'pdf',
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pages_file_name ON pages(file_name);
CREATE INDEX IF NOT EXISTS idx_pages_created_at ON pages(created_at);
