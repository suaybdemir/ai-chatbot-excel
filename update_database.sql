-- MEVCUT KISITLAMAYI KALDIR
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_satisfaction_response_check;

-- YENİ KISITLAMA EKLE (1 ile 5 arası)
ALTER TABLE users ADD CONSTRAINT users_satisfaction_response_check 
    CHECK (satisfaction_response >= 1 AND satisfaction_response <= 5);
