-- Migration: Add WhiteBooks GSP API credential columns to businesses table
-- These columns are required by routes/whitebooks.js but were missing from the schema.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS wb_client_id        TEXT,
  ADD COLUMN IF NOT EXISTS wb_client_secret    TEXT,
  ADD COLUMN IF NOT EXISTS wb_gstin            VARCHAR(15),
  ADD COLUMN IF NOT EXISTS wb_gst_username     VARCHAR(100),
  ADD COLUMN IF NOT EXISTS wb_einv_client_id   TEXT,
  ADD COLUMN IF NOT EXISTS wb_einv_client_secret TEXT,
  ADD COLUMN IF NOT EXISTS wb_ewb_client_id    TEXT,
  ADD COLUMN IF NOT EXISTS wb_ewb_client_secret TEXT,
  ADD COLUMN IF NOT EXISTS wb_enabled          BOOLEAN DEFAULT FALSE;
