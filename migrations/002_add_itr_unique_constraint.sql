ALTER TABLE itr_filings
  ADD CONSTRAINT itr_filings_business_fy_unique UNIQUE (business_id, financial_year);
