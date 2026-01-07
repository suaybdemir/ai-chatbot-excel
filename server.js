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
            messages: [{ role: 'user', content: message }],
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

                // Memnuniyet butonları için linkler
                const satisfiedLink = `${BASE_URL}/api/satisfaction-response?userId=${user.id}&response=1`;
                const neutralLink = `${BASE_URL}/api/satisfaction-response?userId=${user.id}&response=2`;
                const notSatisfiedLink = `${BASE_URL}/api/satisfaction-response?userId=${user.id}&response=0`;

                // Not bölümü - eğer not varsa göster
                const notSection = not !== '' ? `
                    <div style="text-align: center; margin: 25px 0; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 10px;">
                        <div style="color: rgba(255,255,255,0.8); font-size: 14px; margin-bottom: 5px;">Notunuz</div>
                        <div style="color: white; font-size: 48px; font-weight: bold;">${not}</div>
                    </div>
                ` : '';

                const htmlContent = `
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta charset="UTF-8">
                            <style>
                                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7f6; margin: 0; padding: 0; }
                                .container { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.05); }
                                .header { background: linear-gradient(135deg, #4f46e5 0%, #312e81 100%); padding: 40px 30px; text-align: center; color: white; }
                                .header h1 { margin: 0; font-size: 24px; font-weight: 600; letter-spacing: 0.5px; }
                                .header p { margin: 10px 0 0; opacity: 0.9; font-size: 14px; }
                                .content { padding: 40px 30px; text-align: center; }
                                h2 { color: #1e293b; margin-top: 0; font-size: 20px; }
                                .text-body { color: #64748b; line-height: 1.6; margin-bottom: 30px; font-size: 15px; }
                                .buttons { margin-top: 35px; display: flex; justify-content: center; gap: 15px; flex-wrap: wrap; }
                                .btn { display: inline-block; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; transition: all 0.3s ease; }
                                .btn-success { background-color: #10b981; color: white; border-bottom: 3px solid #059669; }
                                .btn-danger { background-color: #ef4444; color: white; border-bottom: 3px solid #b91c1c; }
                                .btn:hover { transform: translateY(-2px); filter: brightness(110%); }
                                .grade-box { background: #f8fafc; border: 1px solid #e2e8f0; padding: 15px; border-radius: 8px; margin: 20px 0; color: #334155; font-weight: 500; }
                                .footer { background-color: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; }
                            </style>
                        </head>
                        <body>
                            <div class="container">
                                <div class="header">
                                    <h1>Yüksek Trafikli Sistemlerde<br>AI Chatbot Geliştirme</h1>
                                    <p>Eğitim Değerlendirme Anketi</p>
                                </div>
                                <div class="content">
                                    <h2>Sayın ${fullName},</h2>
                                    ${notSection ? `<div class="grade-box">${notSection}</div>` : ''}
                                    <p class="text-body">
                                        Eğitimimize katılımınız için teşekkür ederiz. Eğitim kalitemizi sürekli artırmak ve sizlere daha iyi bir öğrenme deneyimi sunmak adına görüşleriniz bizim için çok değerli.
                                    </p>
                                    <p class="text-body" style="font-weight: 500; color: #334155;">
                                        Bu dersin size kattıkları ve genel işleyiş hakkında ne düşünüyorsunuz?
                                    </p>
                                    
                                    <div class="buttons">
                                        <a href="${satisfiedLink}" class="btn btn-success">
                                            🚀 Harikaydı
                                        </a>
                                        <a href="${neutralLink}" class="btn" style="background-color: #64748b; color: white; border-bottom: 3px solid #475569;">
                                            🤔 Fena Değil
                                        </a>
                                        <a href="${notSatisfiedLink}" class="btn btn-danger">
                                            👎 Beğenmedim
                                        </a>
                                    </div>
                                </div>
                                <div class="footer">
                                    <p>© 2026 AI Chatbot Academy. Tüm hakları saklıdır.</p>
                                    <p>Bu e-posta otomatik olarak gönderilmiştir. Lütfen cevaplamayınız.</p>
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

    if (!userId || (response !== '0' && response !== '1' && response !== '2')) {
        return res.status(400).send('Geçersiz istek.');
    }

    try {
        // Kullanıcının cevabını kaydet
        const { error } = await supabase
            .from('users')
            .update({
                satisfaction_response: parseInt(response),
                satisfaction_response_at: new Date().toISOString()
            })
            .eq('id', parseInt(userId));

        if (error) throw error;

        const responseInt = parseInt(response);
        let statusText = '';
        if (responseInt === 1) statusText = 'Memnun';
        else if (responseInt === 2) statusText = 'Kararsız';
        else statusText = 'Memnun Değil';

        console.log(`✅ Kullanıcı #${userId} cevabı kaydedildi: ${statusText}`);

        // TÜM İSTEMCİLERE BİLDİR (REALTIME UPDATE)
        notifyClients();

        // Teşekkür sayfası
        let emoji = '😊';
        let message = 'Memnun kaldığınızı duyduğumuza çok sevindik!';

        if (responseInt === 2) {
            emoji = '🤔';
            message = 'Geri bildiriminiz için teşekkürler. Daha iyisini yapabilmek için çalışacağız.';
        } else if (responseInt === 0) {
            emoji = '😔';
            message = 'Geri bildiriminiz için teşekkürler. Eksiklerimizi gidermek için çalışacağız.';
        }

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

        // Loose equality (==) kullanarak string/number/boolean farkını yoksay
        const satisfiedCount = users.filter(u => u.satisfaction_response == 1).length;
        const neutralCount = users.filter(u => u.satisfaction_response == 2).length;
        const notSatisfiedCount = users.filter(u => u.satisfaction_response == 0).length;

        // Debug log
        if (totalResponses > 0) {
            console.log(`📊 Stats Debug: Total:${totalResponses}, Happy:${satisfiedCount}, Neutral:${neutralCount}, Sad:${notSatisfiedCount}`);
        }

        res.json({
            totalUsers: totalUsers,
            emailsSent: emailsSent,
            totalResponses: totalResponses,
            satisfiedCount: satisfiedCount,
            neutralCount: neutralCount,
            notSatisfiedCount: notSatisfiedCount,
            responseRate: emailsSent > 0
                ? ((totalResponses / emailsSent) * 100).toFixed(1)
                : '0.0',
            satisfactionRate: totalResponses > 0
                ? (((satisfiedCount + (neutralCount * 0.5)) / totalResponses) * 100).toFixed(1)
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