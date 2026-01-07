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

-- Memnuniyet Cevabı için Kısıtlama Ekle (1 ile 5 arası)
ALTER TABLE public.users ADD CONSTRAINT users_satisfaction_response_check 
    CHECK (satisfaction_response >= 1 AND satisfaction_response <= 5);

-- Row Level Security (RLS) Aktif Et - Güvenlik İçin
-- Eğer zaten varsa hata vermez, ama temiz kurulumda gereklidir.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Anonim erişime (public) okuma/yazma izni ver (Basit kullanım için)
-- Prodüksiyonda burayı daha kısıtlı yapabilirsiniz.
DROP POLICY IF EXISTS "Enable all access for all users" ON public.users;
CREATE POLICY "Enable all access for all users" ON public.users
    FOR ALL USING (true) WITH CHECK (true);
