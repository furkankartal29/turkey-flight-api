<h1 align="center">
  ✈️ Türkiye Uçuş Takip API
</h1>

<p align="center">
  <strong>Türkiye'deki 54 havalimanını kapsayan, gerçek zamanlı, 100% yasal uçuş takip REST API'si</strong><br/>
  IST · SAW · 52 DHMİ Havalimanı · Canlı Arama Paneli
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20-green?logo=node.js" />
  <img src="https://img.shields.io/badge/SQLite-3-blue?logo=sqlite" />
  <img src="https://img.shields.io/badge/Docker-ready-blue?logo=docker" />
  <img src="https://img.shields.io/badge/license-MIT-green" />
</p>

---

## 🗺️ Scraper Mimarisi

```
┌─────────────────────────────────────────────────────────────────────┐
│                     TÜRK HAVALİMANI SCRAPER MİMARİSİ               │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  HIZLI WORKER  (Her 5 dakikada bir)                        │   │
│   │                                                             │   │
│   │  ┌──────────────────┐     ┌──────────────────────────┐    │   │
│   │  │  SAW Sabiha      │     │  IST İstanbul Airport    │    │   │
│   │  │  Gökçen          │     │                          │    │   │
│   │  │  ─────────────   │     │  ─────────────────────   │    │   │
│   │  │  GET → HTML tablo│     │  GET session cookie      │    │   │
│   │  │  (Kalkış)        │     │  POST JSON API:          │    │   │
│   │  │                  │     │  /umbraco/api/           │    │   │
│   │  │  GET+POST cookie │     │  FlightInfo/             │    │   │
│   │  │  (Varış ASP.NET) │     │  GetFlightStatusBoard    │    │   │
│   │  └────────┬─────────┘     └───────────┬──────────────┘    │   │
│   │           └──────────────┬────────────┘                    │   │
│   │                    ~417 uçuş/çalışma                       │   │
│   └────────────────────────┬────────────────────────────────────┘  │
│                            │                                        │
│   ┌────────────────────────▼────────────────────────────────────┐  │
│   │  YAVAŞ WORKER  (Her 20 dakikada bir)                        │  │
│   │                                                             │  │
│   │  DHMİ API  ─  flightwebsvc.dhmi.gov.tr                     │  │
│   │                                                             │  │
│   │  1. dhmi.gov.tr'den KToken çek (oturum jetonu)             │  │
│   │  2. 52 havalimanı × DA/DD × D/I = 208 paralel sorgu        │  │
│   │     (10'lu batch, 100ms throttle)                           │  │
│   │  3. Şehir adı → IATA kodu dönüşümü                         │  │
│   │                                                ~3300 uçuş  │  │
│   └────────────────────────┬────────────────────────────────────┘  │
│                            │                                        │
│   ┌────────────────────────▼────────────────────────────────────┐  │
│   │  SQLite  ─  flights.db                                      │  │
│   │                                                             │  │
│   │  INSERT OR REPLACE (PRIMARY KEY çakışma kontrolü)          │  │
│   │  İndeksler: (flightNumber,date) · (dep,arr,date) · (date)  │  │
│   │  3 günden eski kayıtlar otomatik temizlenir                 │  │
│   │  Toplam: ~3.800 uçuş / güncelleme döngüsü                  │  │
│   └────────────────────────┬────────────────────────────────────┘  │
│                            │                                        │
│   ┌────────────────────────▼────────────────────────────────────┐  │
│   │  REST API  (Express.js — port 3000)                         │  │
│   │                                                             │  │
│   │  GET /api/flights          → rota + tarih filtreleme        │  │
│   │  GET /api/flights/search   → uçuş no + tarih ile arama     │  │
│   │  GET /api/airports         → 54 havalimanı sözlüğü         │  │
│   │  GET /api/status           → scraper durumu + bellek       │  │
│   └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## 🚀 Kurulum

### Docker ile (Önerilen)

```bash
git clone https://github.com/KULLANICI_ADI/turkey-flight-api.git
cd turkey-flight-api

# İlk çalıştırma (build + başlat)
docker compose up --build -d

# Log takibi
docker logs -f flight-api-service
```

`http://localhost:3000` adresinde hazır.

> `server.js` değişikliklerinde `docker compose up --build -d` gerekir.  
> `public/` klasöründeki CSS/HTML değişiklikleri rebuild gerektirmez — sayfa yenileme yeterli.

### Manuel (Node.js)

```bash
npm install
node server.js
```

---

## 📡 API Uç Noktaları

| Yöntem | Uç Nokta | Açıklama |
|--------|----------|----------|
| `GET` | `/api/flights` | Rota, tarih, havayolu filtreli liste |
| `GET` | `/api/flights/search` | Uçuş numarası + tarih ile arama |
| `GET` | `/api/airports` | 54 havalimanı sözlüğü |
| `GET` | `/api/status` | Scraper durumu, bellek, uçuş sayısı |

### Örnek İstekler

```bash
# SAW → ADB arası bugünkü uçuşlar
curl http://localhost:3000/api/flights?departure=SAW&arrival=ADB

# Belirli uçuşu ara
curl http://localhost:3000/api/flights/search?flightNumber=TK2348&date=2026-06-24

# Sistem durumu
curl http://localhost:3000/api/status
```

### Örnek Yanıt

```json
{
  "success": true,
  "count": 12,
  "flights": [
    {
      "flightNumber": "PC2521",
      "date": "2026-06-24",
      "airline": "Pegasus Airlines",
      "departureAirport": "SAW",
      "arrivalAirport": "AYT",
      "departureCity": "İstanbul",
      "arrivalCity": "Antalya",
      "scheduledDeparture": "06:45",
      "scheduledArrival": "-",
      "actualTime": "06:45",
      "terminal": "Ana Terminal",
      "gate": "B12",
      "status": "Kalktı"
    }
  ]
}
```

---

## 🏗️ Teknoloji Yığını

| Katman | Teknoloji | Neden? |
|--------|-----------|--------|
| Runtime | Node.js 20 | Stabil, geniş ekosistem |
| Web Sunucu | Express.js | Hafif, hızlı |
| Veritabanı | SQLite (sqlite3) | Sunucusuz, dosya tabanlı, indeks desteği |
| Container | Docker + Alpine | Küçük imaj boyutu (~150 MB) |
| Frontend | Vanilla HTML/CSS/JS | Sıfır bağımlılık, hızlı yükleme |

---

## 📊 Veri Kaynakları

| Kaynak | Havalimanı | Güncelleme | Yöntem |
|--------|-----------|------------|--------|
| sabihagokcen.aero | SAW | Her 5 dk | HTML scraping + ASP.NET POST |
| istairport.com | IST | Her 5 dk | Umbraco JSON API |
| flightwebsvc.dhmi.gov.tr | 52 havalimanı | Her 20 dk | KToken + REST API |

> **Yasal Not:** Tüm veri kaynakları resmi havalimanı web sitelerinin herkese açık sayfalarından alınmaktadır. Ticari API anahtarı veya ücretli servis kullanılmamaktadır.

---

## 📄 Lisans

MIT © 2026 — Özgürce kullanın, fork edin, katkıda bulunun.
