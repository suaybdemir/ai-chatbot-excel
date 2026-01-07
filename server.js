require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const xlsx = require('xlsx');
const Mailjet = require('node-mailjet');
const cors = require('cors');
const fs = require('fs');
// SDK'yı yeni sürüme uygun çağırıyoruz:
const { Mistral } = require('@mistralai/mistralai');

// Port ve Base URL ayarları (Railway ve Hugging Face Spaces için)
const port = process.env.PORT || 7860;
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.SPACE_HOST
        ? `https://${process.env.SPACE_HOST}`
        : `http://localhost:${port}`;

const app = express();

// SSE Clients (Bağlı kullanıcılar)
let sseClients = [];

// SSE Bildirim Fonksiyonu
const notifyClients = () => {
    sseClients.forEach(client => client.res.write(`data: update\n\n`));
};

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- AYARLAR ---

// 1. Mistral İstemcisi (GÜNCELLENDİ)
// Yeni versiyonda API key bu şekilde obje içinde veriliyor
const mistral = new Mistral({
    apiKey: process.env.MISTRAL_API_KEY
});

// 2. Supabase İstemcisi
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// Bağlantıyı test et
(async () => {
    const { data, error } = await supabase.from('users').select('count');
    if (error) {
        console.error('HATA: Supabase bağlanamadı!', error.message);
    } else {
        console.log('OK: Supabase bağlantısı başarılı.');
    }
})();

// 3. Mailjet Email Client
const mailjet = new Mailjet({
    apiKey: process.env.MAILJET_API_KEY,
    apiSecret: process.env.MAILJET_SECRET_KEY
});
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@example.com';
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'Bildirim Sistemi';

// Dosya yükleme ayarı
const upload = multer({ dest: 'uploads/' });


// --- ENDPOINTLER ---

// A) CHATBOT (Mistral Tiny - GÜNCELLENDİ)
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ reply: "Boş mesaj gönderilemez." });

    try {
        // Yeni SDK'da 'chat.complete' kullanılıyor
        const chatResponse = await mistral.chat.complete({
            model: 'mistral-tiny',
            messages: [
                {
                    role: 'system',
                    content: 'Sen Türkçe konuşan yardımcı bir asistansın. Her zaman Türkçe cevap ver. Kullanıcılara nazik ve profesyonel bir şekilde yardımcı ol. Kısa ve öz cevaplar ver.'
                },
                { role: 'user', content: message }
            ],
        });

        // Cevap yapısı da bazen değişebilir, burayı güvenli hale getirdik
        const botReply = chatResponse.choices[0].message.content;
        res.json({ reply: botReply });

    } catch (error) {
        console.error("Mistral API Hatası Detayı:", error);
        res.status(500).json({ reply: "Bir hata oluştu, lütfen API anahtarını kontrol et." });
    }
});

// B) EXCEL YÜKLE VE HEMEN MAİL GÖNDER (Tek Buton - Komple İşlem)
app.post('/api/upload-and-send-emails', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Dosya yüklenmedi.' });

    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        let uploadSuccessCount = 0;
        let uploadErrors = [];
        let emailSuccessCount = 0;
        let emailErrors = [];
        const addedUsers = [];

        console.log(`📊 Excel dosyası okundu. ${data.length} satır bulundu.`);

        // İlk aşama: Veritabanına kaydet veya mevcut kullanıcıyı al
        for (const row of data) {
            const ad = row['Ad'] || row['name'] || '';
            const soyad = row['Soyad'] || row['surname'] || '';
            const email = row['Email'] || row['email'];
            const not = row['Not'] || row['not'] || row['Puan'] || row['puan'] || row['Grade'] || row['grade'] || '';

            if (email) {
                try {
                    const { data: insertedData, error } = await supabase
                        .from('users')
                        .insert([{ name: ad, surname: soyad, email: email }])
                        .select();

                    if (error) {
                        // Duplicate key hatası - mevcut kullanıcıyı al
                        if (error.code === '23505' || error.message.includes('duplicate')) {
                            console.log(`ℹ️ Mevcut kullanıcı: ${email} - mail gönderilecek.`);

                            // Mevcut kullanıcıyı veritabanından al
                            const { data: existingUser, error: fetchError } = await supabase
                                .from('users')
                                .select('*')
                                .eq('email', email)
                                .single();

                            if (!fetchError && existingUser) {
                                addedUsers.push({
                                    id: existingUser.id,
                                    name: existingUser.name || ad,
                                    surname: existingUser.surname || soyad,
                                    email: email,
                                    not: not
                                });
                            }
                        } else {
                            throw error;
                        }
                    } else {
                        console.log(`✅ DB: ${ad} ${soyad} (${email}) - Not: ${not} kaydedildi.`);
                        uploadSuccessCount++;

                        // Eklenen kullanıcıyı kaydet
                        addedUsers.push({
                            id: insertedData[0].id,
                            name: ad,
                            surname: soyad,
                            email: email,
                            not: not
                        });
                    }
                } catch (error) {
                    console.error(`❌ DB Hatası (${email}):`, error.message);
                    uploadErrors.push(`${email}: ${error.message}`);
                }
            } else {
                console.log(`⚠️ Satır atlandı: Email adresi yok`);
            }
        }

        // Geçici dosyayı sil
        fs.unlinkSync(req.file.path);

        console.log(`\n📊 Veritabanı Özeti: ${uploadSuccessCount} kayıt eklendi, ${uploadErrors.length} hata\n`);

        // İkinci aşama: Eklenen kullanıcılara mail gönder
        if (addedUsers.length > 0) {
            console.log(`📧 ${addedUsers.length} kullanıcıya not bildirimi gönderiliyor...`);

            for (const user of addedUsers) {
                const { id, name, surname, email, not } = user;
                const fullName = `${name} ${surname}`.trim() || 'Değerli Kullanıcı';

                // Puanlama Linkleri (1-5) - Türkçe etiketlerle
                const ratingLabels = {
                    1: 'Çok Kötü',
                    2: 'Kötü',
                    3: 'Orta',
                    4: 'İyi',
                    5: 'Mükemmel'
                };
                const stars = [1, 2, 3, 4, 5];
                const starLinks = stars.map(score => {
                    return {
                        score,
                        label: ratingLabels[score],
                        url: `${BASE_URL}/api/satisfaction-response?userId=${user.id}&response=${score}`
                    };
                });

                // Not bölümü - eğer not varsa göster
                const notSection = not !== '' ? true : false;

                const htmlContent = `
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta charset="UTF-8">
                            <meta name="viewport" content="width=device-width, initial-scale=1.0">
                            <style>
                                body { 
                                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
                                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                                    color: #333333; 
                                    margin: 0; 
                                    padding: 20px; 
                                    line-height: 1.6; 
                                    min-height: 100vh;
                                }
                                .card {
                                    max-width: 560px; 
                                    margin: 0 auto; 
                                    padding: 40px;
                                    background: #ffffff;
                                    border-radius: 24px;
                                    box-shadow: 0 25px 50px rgba(0,0,0,0.15);
                                }
                                .header { 
                                    text-align: center;
                                    margin-bottom: 32px; 
                                    padding-bottom: 24px;
                                    border-bottom: 1px solid #e5e7eb;
                                }
                                .logo {
                                    width: 60px;
                                    height: 60px;
                                    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
                                    border-radius: 16px;
                                    margin: 0 auto 16px;
                                    display: flex;
                                    align-items: center;
                                    justify-content: center;
                                    font-size: 28px;
                                }
                                h1 { 
                                    font-size: 20px; 
                                    font-weight: 700; 
                                    margin: 0; 
                                    color: #111827;
                                    line-height: 1.4;
                                }
                                .greeting { 
                                    font-size: 16px; 
                                    color: #4b5563; 
                                    margin-bottom: 24px;
                                }
                                
                                /* Puan Kartı - Daha büyük mobil uyumlu */
                                .grade-card { 
                                    background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
                                    border: 3px solid #7dd3fc;
                                    border-radius: 24px;
                                    padding: 36px 32px;
                                    text-align: center;
                                    margin-bottom: 32px;
                                }
                                .grade-label {
                                    font-size: 16px;
                                    color: #0369a1;
                                    font-weight: 700;
                                    text-transform: uppercase;
                                    letter-spacing: 1.5px;
                                    margin-bottom: 12px;
                                }
                                .grade-value {
                                    font-size: 72px;
                                    font-weight: 800;
                                    color: #0284c7;
                                    line-height: 1.1;
                                    padding: 16px;
                                    background: rgba(255,255,255,0.7);
                                    border-radius: 16px;
                                    display: inline-block;
                                    min-width: 120px;
                                }
                                
                                .message { 
                                    font-size: 16px; 
                                    color: #4b5563; 
                                    margin-bottom: 32px;
                                    text-align: center;
                                }
                                
                                /* Puanlama Bölümü - Email uyumlu tablo tasarımı */
                                .rating-section {
                                    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
                                    border-radius: 24px;
                                    padding: 32px 16px;
                                    text-align: center;
                                }
                                .rating-title { 
                                    font-weight: 700; 
                                    font-size: 20px; 
                                    margin-bottom: 24px; 
                                    color: white;
                                }
                                .rating-table {
                                    width: 100%;
                                    border-collapse: separate;
                                    border-spacing: 8px;
                                }
                                .rating-cell {
                                    padding: 0;
                                }
                                .star-btn { 
                                    text-decoration: none; 
                                    display: block;
                                    padding: 16px 8px;
                                    text-align: center;
                                    border-radius: 16px; 
                                    color: white;
                                    box-shadow: 0 6px 20px rgba(0,0,0,0.2);
                                }
                                .star-label {
                                    font-weight: 700;
                                    font-size: 14px;
                                    display: block;
                                    margin-bottom: 4px;
                                }
                                .star-number {
                                    font-weight: 800;
                                    font-size: 28px;
                                    display: block;
                                }
                                .star-1 { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); }
                                .star-2 { background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); }
                                .star-3 { background: linear-gradient(135deg, #eab308 0%, #ca8a04 100%); }
                                .star-4 { background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); }
                                .star-5 { background: linear-gradient(135deg, #10b981 0%, #059669 100%); }
                                .rating-hint {
                                    font-size: 13px;
                                    color: rgba(255,255,255,0.8);
                                    margin-top: 16px;
                                }
                                
                                .footer { 
                                    margin-top: 32px; 
                                    font-size: 12px; 
                                    color: #9ca3af; 
                                    text-align: center;
                                    padding-top: 20px;
                                    border-top: 1px solid #e5e7eb;
                                }
                            </style>
                        </head>
                        <body>
                            <div class="card">
                                <div class="header">
                                    <div class="logo">🤖</div>
                                    <h1>Yüksek Trafikli Sistemlerde<br>AI Chatbot Geliştirme</h1>
                                </div>
                                
                                <p class="greeting">Sayın <strong>${fullName}</strong>,</p>
                                
                                ${notSection ? `
                                <div class="grade-card">
                                    <div class="grade-label">Ders Notunuz</div>
                                    <div class="grade-value">${not}</div>
                                </div>
                                ` : ''}
                                
                                <p class="message">Eğitimimize katılımınız için teşekkür ederiz. Kalitemizi artırmak için görüşleriniz bizim için çok değerli.</p>
                                
                                <div class="rating-section">
                                    <div class="rating-title">⭐ Eğitimi Puanlayın</div>
                                    <table class="rating-table" role="presentation" cellpadding="0" cellspacing="0">
                                        <tr>
                                            ${starLinks.map(s => `
                                            <td class="rating-cell" style="padding: 6px;">
                                                <a href="${s.url}" class="star-btn star-${s.score}" style="display: block; text-decoration: none; padding: 20px 10px; text-align: center; border-radius: 16px; color: white;">
                                                    <span class="star-label" style="font-weight: 700; font-size: 13px; display: block; margin-bottom: 6px;">${s.label}</span>
                                                    <span class="star-number" style="font-weight: 800; font-size: 32px; display: block;">${s.score}</span>
                                                </a>
                                            </td>
                                            `).join('')}
                                        </tr>
                                    </table>
                                    <div class="rating-hint">Değerlendirmeniz için teşekkürler!</div>
                                </div>
                                
                                <div class="footer">
                                    <p>© 2026 AI Chatbot Academy<br>Bu mesaj otomatik olarak gönderilmiştir.</p>
                                </div>
                            </div>
                        </body>
                        </html>
                    `;

                try {
                    // Mailjet ile email gönder
                    const result = await mailjet
                        .post("send", { 'version': 'v3.1' })
                        .request({
                            "Messages": [
                                {
                                    "From": {
                                        "Email": EMAIL_FROM,
                                        "Name": "AI Chatbot Academy"
                                    },
                                    "To": [
                                        {
                                            "Email": email,
                                            "Name": fullName
                                        }
                                    ],
                                    "Subject": `Ders Değerlendirmesi: Yüksek Trafikli Sistemlerde AI Chatbot`,
                                    "HTMLPart": htmlContent
                                }
                            ]
                        });

                    // Status check (Mailjet bazen success dönse de kuyrukta bekleyebilir)
                    // console.log(`📨 Mailjet Yanıtı (${email}):`, result.body.Messages[0].Status);

                    // Veritabanını güncelle
                    const { error } = await supabase
                        .from('users')
                        .update({
                            satisfaction_sent: true,
                            satisfaction_sent_at: new Date().toISOString()
                        })
                        .eq('id', id);

                    if (error) throw error;

                    console.log(`✅ E-posta gönderildi: ${fullName} (${email})`);
                    emailSuccessCount++;
                } catch (error) {
                    console.error(`❌ E-posta gönderilemedi (${email}):`, error.message);
                    emailErrors.push(`${email}: ${error.message}`);
                }
            }

            console.log(`\n📊 E-posta Özeti: ${emailSuccessCount} e-posta gönderildi, ${emailErrors.length} hata\n`);
        }

        // Sonuç mesajı
        let message = `✅ ${uploadSuccessCount} kullanıcı veritabanına eklendi.`;
        if (emailSuccessCount > 0) {
            message += ` ${emailSuccessCount} e-posta gönderildi.`;
        }
        if (uploadErrors.length > 0 || emailErrors.length > 0) {
            message += ` | ${uploadErrors.length + emailErrors.length} toplam hata oluştu.`;
        }

        res.json({
            message,
            uploadSuccess: uploadSuccessCount,
            uploadErrors: uploadErrors.length,
            emailSuccess: emailSuccessCount,
            emailErrors: emailErrors.length,
            totalErrors: [...uploadErrors, ...emailErrors]
        });

        // Veritabanı değiştiği için bildirim gönder
        if (uploadSuccessCount > 0) notifyClients();

    } catch (error) {
        console.error('❌ Sunucu hatası:', error);
        res.status(500).json({ message: 'Sunucu hatası oluştu: ' + error.message });
    }
});

// C) MEMNUNİYET CEVABI
app.get('/api/satisfaction-response', async (req, res) => {
    const { userId, response } = req.query;
    const score = parseInt(response);

    // 1-5 arası puan kontrolü
    if (!userId || isNaN(score) || score < 1 || score > 5) {
        return res.status(400).send('Geçersiz istek. Puan 1 ile 5 arasında olmalıdır.');
    }

    try {
        // Kullanıcının cevabını kaydet
        const { error } = await supabase
            .from('users')
            .update({
                satisfaction_response: score,
                satisfaction_response_at: new Date().toISOString()
            })
            .eq('id', parseInt(userId));

        if (error) throw error;

        console.log(`✅ Kullanıcı #${userId} puan verdi: ${score}/5`);

        // TÜM İSTEMCİLERE BİLDİR (REALTIME UPDATE)
        notifyClients();

        // Teşekkür sayfası
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Teşekkürler</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #f9fafb; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                    .card { background: white; padding: 40px; border-radius: 16px; text-align: center; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); max-width: 400px; width: 90%; }
                    .score { font-size: 64px; font-weight: 800; color: #3b82f6; margin: 20px 0; }
                    h1 { color: #111827; margin-bottom: 10px; font-size: 24px; }
                    p { color: #6b7280; margin-bottom: 0; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>Teşekkürler!</h1>
                    <div class="score">${score}</div>
                    <p>Puanınız (${score}/5) başarıyla kaydedildi.</p>
                    <p style="margin-top:20px; font-size:12px; color:#9ca3af;">AI Chatbot Academy</p>
                </div>
            </body>
            </html>
        `);

    } catch (error) {
        console.error('❌ Veritabanı hatası:', error);
        res.status(500).send('Bir hata oluştu.');
    }
});

// D) ESKİ FORMAT DESTEĞİ - /api/vote (Eski maillerdeki linkler için)
app.get('/api/vote', async (req, res) => {
    const { email, vote } = req.query;

    if (!email || !vote) {
        return res.status(400).send('Geçersiz istek.');
    }

    try {
        // vote: 'yes' veya 'no' -> satisfaction_response: 1 veya 0
        const responseValue = vote === 'yes' ? 1 : 0;

        // Email ile kullanıcıyı bul ve cevabını kaydet
        const { error } = await supabase
            .from('users')
            .update({
                satisfaction_response: responseValue,
                satisfaction_response_at: new Date().toISOString()
            })
            .eq('email', email);

        if (error) throw error;

        console.log(`✅ Kullanıcı (${email}) cevabı kaydedildi: ${vote === 'yes' ? 'Memnun' : 'Memnun Değil'}`);

        // Teşekkür sayfası
        const emoji = vote === 'yes' ? '😊' : '😞';
        const message = vote === 'yes' ? 'Memnun kaldığınızı duyduğumuza çok sevindik!' : 'Geri bildiriminiz için teşekkürler. Kendimizi geliştirmek için çalışacağız.';

        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Teşekkürler</title>
                <style>
                    body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; }
                    .thank-you { background: white; padding: 50px; border-radius: 20px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.2); max-width: 500px; }
                    .emoji { font-size: 80px; margin-bottom: 20px; }
                    h1 { color: #333; margin-bottom: 20px; }
                    p { color: #666; font-size: 18px; line-height: 1.6; }
                </style>
            </head>
            <body>
                <div class="thank-you">
                    <div class="emoji">${emoji}</div>
                    <h1>Teşekkürler!</h1>
                    <p>${message}</p>
                </div>
            </body>
            </html>
        `);

    } catch (error) {
        console.error('❌ Veritabanı hatası:', error);
        res.status(500).send('Bir hata oluştu.');
    }
});

// F) VERİTABANI TEMİZLE (Sadece Demo/Test Amaçlı)
app.post('/api/clear-database', async (req, res) => {
    try {
        const { error } = await supabase
            .from('users')
            .delete()
            .neq('id', 0); // Tüm satırları sil (id != 0)

        if (error) throw error;

        console.log('⚠️ Veritabanı temizlendi.');
        notifyClients(); // Temizlenince de bildir
        res.json({ message: 'Veritabanı başarıyla temizlendi.' });
    } catch (error) {
        console.error('❌ Temizleme hatası:', error);
        res.status(500).json({ message: 'Veritabanı temizlenemedi.' });
    }
});

// E) İSTATİSTİKLER
app.get('/api/satisfaction-stats', async (req, res) => {
    try {
        // Tüm kullanıcıları çek
        const { data: users, error } = await supabase
            .from('users')
            .select('*');

        if (error) throw error;

        // İstatistikleri hesapla
        const totalUsers = users.length;
        const emailsSent = users.filter(u => u.satisfaction_sent === true).length;

        // satisfaction_response null değilse bir cevap vardır
        const totalResponses = users.filter(u => u.satisfaction_response != null).length;

        // Ortalama Puan Hesaplama
        const responses = users.filter(u => u.satisfaction_response != null).map(u => u.satisfaction_response);
        const totalScore = responses.reduce((acc, score) => acc + score, 0);
        const averageScore = totalResponses > 0 ? (totalScore / totalResponses).toFixed(1) : '0.0';

        // Puan Dağılımı (1-5)
        const distribution = {
            1: responses.filter(s => s == 1).length,
            2: responses.filter(s => s == 2).length,
            3: responses.filter(s => s == 3).length,
            4: responses.filter(s => s == 4).length,
            5: responses.filter(s => s == 5).length
        };

        // Debug log
        if (totalResponses > 0) {
            console.log(`📊 Stats Debug: Avg:${averageScore}, Dist:${JSON.stringify(distribution)}`);
        }

        res.json({
            totalUsers: totalUsers,
            emailsSent: emailsSent,
            totalResponses: totalResponses,
            averageScore: averageScore,
            distribution: distribution,
            responseRate: emailsSent > 0
                ? ((totalResponses / emailsSent) * 100).toFixed(1)
                : '0.0'
        });

    } catch (error) {
        console.error('❌ İstatistik hatası:', error);
        res.status(500).json({ message: 'Hata oluştu' });
    }
});

// G) REALTIME STREAM (SSE Endpoint)
app.get('/api/stats-stream', (req, res) => {
    // SSE Headerları
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Client'ı listeye ekle
    const clientId = Date.now();
    const newClient = {
        id: clientId,
        res
    };
    sseClients.push(newClient);

    // Bağlantı kapandığında listeden çıkar
    req.on('close', () => {
        sseClients = sseClients.filter(c => c.id !== clientId);
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log('------------------------------------------------');
    console.log(`🚀 Server çalışıyor: ${BASE_URL}`);
    console.log('🤖 Mistral AI: SDK v1.x Aktif');
    console.log('💾 Supabase: PostgreSQL Database Aktif');
    console.log('------------------------------------------------');
});