-- USERS Tablosunu Oluştur
CREATE TABLE IF NOT EXISTS public.users (
    id SERIAL PRIMARY KEY,
    name TEXT,
    surname TEXT,
    email TEXT,
    "not" TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
    satisfaction_sent BOOLEAN DEFAULT false,
    satisfaction_sent_at TIMESTAMP WITH TIME ZONE,
    satisfaction_response INTEGER,
    satisfaction_response_at TIMESTAMP WITH TIME ZONE
);

-- Memnuniyet Cevabı için Kısıtlama Ekle (0: Memnun Değil, 1: Memnun, 2: Kararsız)
-- Şimdilik 0 ve 1 aktif ama 2'yi de ekliyoruz ki ilerde güncelleme yaparsak hazır olsun.
ALTER TABLE public.users ADD CONSTRAINT users_satisfaction_response_check 
    CHECK (satisfaction_response IN (0, 1, 2));

-- Row Level Security (RLS) Aktif Et - Güvenlik İçin
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Anonim erişime (public) okuma/yazma izni ver (Basit kullanım için)
-- Prodüksiyonda burayı daha kısıtlı yapabilirsiniz.
CREATE POLICY "Enable all access for all users" ON public.users
    FOR ALL USING (true) WITH CHECK (true);
