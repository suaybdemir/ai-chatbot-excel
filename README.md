---
title: AI Chatbot & Excel Mailer
emoji: 🤖
colorFrom: blue
colorTo: purple
sdk: docker
pinned: false
license: mit
---

# AI Chatbot & Excel Mailer

Mistral AI chatbot ve Excel tabanlı memnuniyet anketi sistemi.

## Özellikler

- 🤖 **Mistral AI Chatbot** - Yapay zeka destekli sohbet
- 📊 **Excel Yükleme** - Toplu kullanıcı ekleme
- 📧 **Otomatik Email** - Memnuniyet anketi gönderimi
- 📈 **İstatistikler** - Gerçek zamanlı analiz

## Kurulum (Local)

```bash
npm install
node server.js
```

## Environment Variables

Hugging Face Spaces'te **Settings > Secrets** bölümüne ekleyin:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `EMAIL_USER`
- `EMAIL_PASS`
- `MISTRAL_API_KEY`
