-- MEVCUT KISITLAMAYI KALDIR
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_satisfaction_response_check;

-- YENİ KISITLAMA EKLE (0: Mutsuz, 1: Mutlu, 2: Nötr)
ALTER TABLE users ADD CONSTRAINT users_satisfaction_response_check CHECK (satisfaction_response IN (0, 1, 2));
