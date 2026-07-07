const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH = path.join(__dirname, 'flights.db');
const AIRLINE_DB_PATH = path.join(__dirname, 'airline_db.json');
const AIRPORTS_PATH = path.join(__dirname, 'airports.json');

// Get today's date in YYYY-MM-DD format (local time)
function getLocalDateString(offsetDays = 0) {
  const d = new Date();
  if (offsetDays !== 0) {
    d.setDate(d.getDate() + offsetDays);
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Load databases
let airlineDb = {};
let airportsDb = {};

try {
  if (fs.existsSync(AIRLINE_DB_PATH)) {
    airlineDb = JSON.parse(fs.readFileSync(AIRLINE_DB_PATH, 'utf8'));
  }
  if (fs.existsSync(AIRPORTS_PATH)) {
    airportsDb = JSON.parse(fs.readFileSync(AIRPORTS_PATH, 'utf8'));
  }
} catch (e) {
  console.error('Veritabanı okuma hatası:', e.message);
}

// International cities lookup dictionary for outside Turkey
const internationalCities = {
  "LHR": "Londra", "LGW": "Londra", "STN": "Londra", "SEN": "Londra",
  "CDG": "Paris", "ORY": "Paris",
  "FRA": "Frankfurt", "MUC": "Münih", "DUS": "Düsseldorf", "HAM": "Hamburg", "TXL": "Berlin", "BER": "Berlin", "SXF": "Berlin",
  "AMS": "Amsterdam", "BRU": "Brüksel", "CRL": "Brüksel", "ZRH": "Zürih", "GVA": "Cenevre",
  "VIE": "Viyana", "FCO": "Roma", "MXP": "Milano", "MAD": "Madrid", "BCN": "Barselona",
  "ATH": "Atina", "SKG": "Selanik", "ECN": "Lefkoşa", "BUD": "Budapeşte", "OTP": "Bükreş", "WAW": "Varşova",
  "RZE": "Rzeszow", "HEL": "Helsinki", "CPH": "Kopenhag", "ARN": "Stokholm", "OSL": "Oslo",
  "LED": "St. Petersburg", "SVO": "Moskova", "DME": "Moskova", "VKO": "Moskova",
  "DXB": "Dubai", "SHJ": "Şarika", "DOH": "Doha", "MCT": "Maskat", "RUH": "Riyad", "JED": "Cidde", "MED": "Medine",
  "TLV": "Tel Aviv", "AMM": "Amman", "BEY": "Beyrut", "GYD": "Bakü", "EVN": "Erivan",
  "TBS": "Tiflis", "TAS": "Taşkent", "ASB": "Aşkabat", "ALA": "Almatı", "NQZ": "Astana",
  "DEL": "Yeni Delhi", "BOM": "Mumbai", "PEK": "Pekin", "PVG": "Şanghay", "HND": "Tokyo",
  "NRT": "Tokyo", "SIN": "Singapur", "BKK": "Bangkok", "JFK": "New York", "EWR": "New York",
  "ORD": "Chicago", "LAX": "Los Angeles", "MCO": "Orlando", "MIA": "Miami", "YYZ": "Toronto",
  "LCA": "Larnaka", "PRG": "Prag", "STR": "Stuttgart", "CGN": "Köln", "HAJ": "Hannover",
  "NUE": "Nürnberg", "BSL": "Basel", "KBP": "Kiev", "ODS": "Odessa", "IEV": "Kiev",
  "MSQ": "Minsk", "CAI": "Kahire", "HRG": "Hurgada", "SSH": "Şarm El-Şeyh", "CMN": "Kazablanka",
  "ALG": "Cezayir", "TUN": "Tunus", "ICN": "Seul", "DYU": "Duşanbe", "FRU": "Bişkek"
};

// Initialize SQLite connection and database
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('SQLite veritabanı bağlantı hatası:', err.message);
  } else {
    console.log('SQLite veritabanı başarıyla bağlandı.');
    initializeDatabase();
  }
});

function initializeDatabase() {
  db.serialize(() => {
    // Drop table if it has the old actualTime column to perform automatic schema migration
    db.all("PRAGMA table_info(flights)", [], (err, columns) => {
      if (!err && columns && columns.some(c => c.name === 'actualTime')) {
        console.log('Eski şema (actualTime) tespit edildi, tablo yeniden oluşturuluyor...');
        db.run("DROP TABLE flights");
      }
      
      db.run(`
        CREATE TABLE IF NOT EXISTS flights (
          flightNumber TEXT,
          date TEXT,
          airline TEXT,
          departureAirport TEXT,
          arrivalAirport TEXT,
          departureCity TEXT,
          arrivalCity TEXT,
          scheduledDeparture TEXT,
          scheduledArrival TEXT,
          actualDeparture TEXT,
          actualArrival TEXT,
          terminal TEXT,
          gate TEXT,
          status TEXT,
          PRIMARY KEY (flightNumber, date, departureAirport, arrivalAirport)
        )
      `);
      
      db.run(`
        CREATE TABLE IF NOT EXISTS webhooks (
          url TEXT PRIMARY KEY,
          createdAt TEXT
        )
      `);

      db.run("CREATE INDEX IF NOT EXISTS idx_flights_search ON flights (flightNumber, date)");
      db.run("CREATE INDEX IF NOT EXISTS idx_flights_route ON flights (departureAirport, arrivalAirport, date)");
      db.run("CREATE INDEX IF NOT EXISTS idx_flights_date ON flights (date)");
      console.log('Veritabanı tabloları ve indeksleri doğrulandı.');
    });
  });
}

// Helpers
function getAirlineName(flightNumber) {
  if (!flightNumber) return "Diğer Havayolu";
  const prefix = flightNumber.trim().slice(0, 2).toUpperCase();
  const threeLetterPrefix = flightNumber.trim().slice(0, 3).toUpperCase();
  return airlineDb[threeLetterPrefix] || airlineDb[prefix] || "Diğer Havayolu";
}

function getAirportCity(iata) {
  if (!iata) return "";
  const code = iata.toUpperCase().trim();
  if (code === 'INT') return ""; // Fallback to raw scraped city name
  if (airportsDb[code]) {
    return airportsDb[code].city;
  }
  return internationalCities[code] || code;
}

function getAirportName(iata) {
  if (!iata) return "";
  const code = iata.toUpperCase().trim();
  if (code === 'INT') return "Uluslararası Havalimanı";
  if (airportsDb[code]) {
    return airportsDb[code].name;
  }
  return internationalCities[code] ? `${internationalCities[code]} Havalimanı (${code})` : `Havalimanı (${code})`;
}

// Find airport IATA code by matching city name
function findAirportCodeByCity(cityName) {
  if (!cityName) return null;
  
  const rawLower = cityName.toLowerCase();
  
  // Specific override mappings for common composite labels
  if (rawLower.includes('sabiha') || rawLower.includes('gökçen') || rawLower.includes('gokcen') || rawLower.includes('saw')) {
    return "SAW";
  }
  if (rawLower.includes('istanbul') || rawLower.includes('ist')) {
    return "IST";
  }
  if (rawLower.includes('bodrum') || rawLower.includes('bjv') || rawLower.includes('milas')) {
    return "BJV";
  }
  if (rawLower.includes('dalaman') || rawLower.includes('dlm')) {
    return "DLM";
  }
  if (rawLower.includes('gazipasa') || rawLower.includes('gazipaşa') || rawLower.includes('gzp')) {
    return "GZP";
  }
  if (rawLower.includes('ankara') || rawLower.includes('esenboga') || rawLower.includes('esenboğa') || rawLower.includes('esb')) {
    return "ESB";
  }
  if (rawLower.includes('izmir') || rawLower.includes('adnan menderes') || rawLower.includes('adb')) {
    return "ADB";
  }
  if (rawLower.includes('antalya') || rawLower.includes('ayt')) {
    return "AYT";
  }

  const clean = (str) => str.toLowerCase().replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/[^a-z0-9]/g, '');
  const searchStr = clean(cityName);
  
  // Try Turkish airports
  for (const [code, ap] of Object.entries(airportsDb)) {
    if (clean(ap.city) === searchStr || clean(ap.name).includes(searchStr) || searchStr.includes(clean(ap.city)) || searchStr.includes(clean(ap.name))) {
      return code;
    }
  }
  
  // Try international cities dictionary
  for (const [code, name] of Object.entries(internationalCities)) {
    if (clean(name) === searchStr || searchStr.includes(clean(name))) {
      return code;
    }
  }
  
  // Try to match parenthesized IATA codes like "BERLİN (BER)"
  const parenthesizedMatch = cityName.match(/\(([A-Z]{3})\)/);
  if (parenthesizedMatch) {
    return parenthesizedMatch[1];
  }
  
  return null;
}

// Helper to adjust SAW flight date dynamically for post-midnight/pre-midnight schedules
function getCorrectFlightDate(baseDateStr, flightTimeStr) {
  if (!flightTimeStr || flightTimeStr === '-') return baseDateStr;
  
  const [flightHour, flightMin] = flightTimeStr.split(':').map(Number);
  if (isNaN(flightHour)) return baseDateStr;
  
  const now = new Date();
  const currentHour = now.getHours();
  
  let targetDate = new Date(baseDateStr);
  
  // If scraper runs late at night (e.g. 20:00 - 23:59) and the flight is early morning (e.g. 00:00 - 04:00)
  if (currentHour >= 20 && flightHour <= 4) {
    targetDate.setDate(targetDate.getDate() + 1);
  } 
  // If scraper runs early in the morning (e.g. 00:00 - 04:00) and the flight is late at night (e.g. 20:00 - 23:59)
  else if (currentHour <= 4 && flightHour >= 20) {
    targetDate.setDate(targetDate.getDate() - 1);
  } else {
    return baseDateStr;
  }
  
  const year = targetDate.getFullYear();
  const month = String(targetDate.getMonth() + 1).padStart(2, '0');
  const day = String(targetDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Helper to calculate delay in minutes using full ISO datetimes
function calculateDelayMinutes(scheduledIso, actualIso) {
  if (!scheduledIso || scheduledIso === '-' || !actualIso || actualIso === '-') return 0;
  
  const schedDate = new Date(scheduledIso);
  const actualDate = new Date(actualIso);
  
  if (isNaN(schedDate.getTime()) || isNaN(actualDate.getTime())) return 0;
  
  const diffMin = Math.round((actualDate - schedDate) / 60000);
  return diffMin > 0 ? diffMin : 0;
}

// Helper to resolve an estimated/actual time into a full ISO datetime string
function resolveEstimatedDatetime(scheduledDateStr, scheduledTime, estimatedTime) {
  if (!scheduledDateStr || !scheduledTime || scheduledTime === '-' || !estimatedTime || estimatedTime === '-') {
    return '-';
  }
  
  if (estimatedTime.includes('T')) return estimatedTime;
  
  const [sYear, sMonth, sDay] = scheduledDateStr.split('-').map(Number);
  const [sH, sM] = scheduledTime.split(':').map(Number);
  
  if (isNaN(sYear) || isNaN(sH)) return '-';
  
  const schedDate = new Date(sYear, sMonth - 1, sDay, sH, sM, 0);
  
  const [eH, eM] = estimatedTime.split(':').map(Number);
  if (isNaN(eH)) return '-';
  
  const estDate = new Date(sYear, sMonth - 1, sDay, eH, eM, 0);
  
  const diffMin = (eH * 60 + eM) - (sH * 60 + sM);
  
  // If actual time is earlier than scheduled by more than 60 mins, it rolled over to next day
  if (diffMin < -60) {
    estDate.setDate(estDate.getDate() + 1);
  }
  // If actual time is almost 24 hours later but actually 10 mins early
  else if (diffMin > 23 * 60) {
    estDate.setDate(estDate.getDate() - 1);
  }
  
  const year = estDate.getFullYear();
  const month = String(estDate.getMonth() + 1).padStart(2, '0');
  const day = String(estDate.getDate()).padStart(2, '0');
  const hours = String(estDate.getHours()).padStart(2, '0');
  const minutes = String(estDate.getMinutes()).padStart(2, '0');
  
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

// Helper to convert Turkey local datetime string to UTC ISO timestamp
function convertToUtcIso(localIsoStr) {
  if (!localIsoStr || localIsoStr === '-') return '-';
  try {
    if (localIsoStr.endsWith('Z') || localIsoStr.includes('+')) {
      return new Date(localIsoStr).toISOString();
    }
    const d = new Date(localIsoStr + '+03:00');
    if (isNaN(d.getTime())) return '-';
    return d.toISOString();
  } catch (e) {
    return '-';
  }
}

// Helper to standardize flight statuses to numeric codes and uppercase tokens
function getStandardizedStatus(status) {
  if (!status || status === '-') {
    return { code: 0, text: "UNKNOWN" };
  }
  const s = status.toUpperCase();
  if (s.includes('İNDİ') || s.includes('LANDED') || s.includes('UÇUŞ YAPILDI') || s.includes('UÇULDU')) {
    return { code: 4, text: "LANDED" };
  }
  if (s.includes('İPTAL') || s.includes('CANCEL')) {
    return { code: 5, text: "CANCELLED" };
  }
  if (s.includes('GECİKME') || s.includes('DELAY') || s.includes('RÖTAR')) {
    return { code: 2, text: "DELAYED" };
  }
  if (s.includes('KAPI') || s.includes('BOARD') || s.includes('ÇAĞRI') || s.includes('CALL') || s.includes('YAKLAŞIYOR') || s.includes('HAVADA') || s.includes('BİNİŞ')) {
    return { code: 3, text: "BOARDING" };
  }
  if (s.includes('PLAN') || s.includes('SCHED')) {
    return { code: 1, text: "SCHEDULED" };
  }
  return { code: 0, text: "UNKNOWN" };
}

// Helper to fill in missing departure or arrival legs using historical flight durations with caching
function fillMissingLegs(flights, callback) {
  let pending = flights.length;
  if (pending === 0) return callback(flights);

  const flightCache = new Map(); // flightNumber -> durationMin
  const routeCache = new Map();  // depIata-arrIata -> durationMin

  let completed = 0;
  const done = () => {
    completed++;
    if (completed === pending) {
      callback(flights);
    }
  };

  flights.forEach(f => {
    const hasDep = f.scheduledDeparture && f.scheduledDeparture !== '-';
    const hasArr = f.scheduledArrival && f.scheduledArrival !== '-';

    if (hasDep && !hasArr) {
      resolveDuration(f.flightNumber, f.departureAirport, f.arrivalAirport, (durationMin) => {
        if (durationMin > 0) {
          applyMinutes(f, durationMin);
        }
        done();
      });
    } else if (hasArr && !hasDep) {
      resolveDuration(f.flightNumber, f.departureAirport, f.arrivalAirport, (durationMin) => {
        if (durationMin > 0) {
          applyMinutesBackwards(f, durationMin);
        }
        done();
      });
    } else {
      done();
    }
  });

  function resolveDuration(flightNumber, dep, arr, cb) {
    if (flightCache.has(flightNumber)) {
      return cb(flightCache.get(flightNumber));
    }
    
    const routeKey = `${dep}-${arr}`;
    if (routeCache.has(routeKey)) {
      return cb(routeCache.get(routeKey));
    }

    // Step 1: Query by flightNumber
    db.get(
      "SELECT scheduledDeparture, scheduledArrival FROM flights WHERE flightNumber = ? AND scheduledDeparture != '-' AND scheduledArrival != '-' ORDER BY date DESC LIMIT 1",
      [flightNumber],
      (err, row) => {
        if (!err && row) {
          const sDep = new Date(row.scheduledDeparture);
          const sArr = new Date(row.scheduledArrival);
          if (!isNaN(sDep.getTime()) && !isNaN(sArr.getTime())) {
            const dur = Math.round((sArr - sDep) / 60000);
            if (dur > 0 && dur < 1440) {
              flightCache.set(flightNumber, dur);
              routeCache.set(routeKey, dur);
              return cb(dur);
            }
          }
        }

        // Step 2: Query by route
        db.get(
          "SELECT scheduledDeparture, scheduledArrival FROM flights WHERE departureAirport = ? AND arrivalAirport = ? AND scheduledDeparture != '-' AND scheduledArrival != '-' ORDER BY date DESC LIMIT 1",
          [dep, arr],
          (err2, rRow) => {
            if (!err2 && rRow) {
              const sDep = new Date(rRow.scheduledDeparture);
              const sArr = new Date(rRow.scheduledArrival);
              if (!isNaN(sDep.getTime()) && !isNaN(sArr.getTime())) {
                const dur = Math.round((sArr - sDep) / 60000);
                if (dur > 0 && dur < 1440) {
                  routeCache.set(routeKey, dur);
                  return cb(dur);
                }
              }
            }
            cb(-1);
          }
        );
      }
    );
  }

  function applyMinutes(f, durationMin) {
    const currentDep = new Date(f.scheduledDeparture);
    if (!isNaN(currentDep.getTime())) {
      const estArr = new Date(currentDep.getTime() + durationMin * 60000);
      const year = estArr.getFullYear();
      const month = String(estArr.getMonth() + 1).padStart(2, '0');
      const day = String(estArr.getDate()).padStart(2, '0');
      const hours = String(estArr.getHours()).padStart(2, '0');
      const minutes = String(estArr.getMinutes()).padStart(2, '0');
      
      f.scheduledArrival = `${year}-${month}-${day}T${hours}:${minutes}`;
      f.actualArrival = f.scheduledArrival;
      f.isEstimatedArrival = true;
    }
  }

  function applyMinutesBackwards(f, durationMin) {
    const currentArr = new Date(f.scheduledArrival);
    if (!isNaN(currentArr.getTime())) {
      const estDep = new Date(currentArr.getTime() - durationMin * 60000);
      const year = estDep.getFullYear();
      const month = String(estDep.getMonth() + 1).padStart(2, '0');
      const day = String(estDep.getDate()).padStart(2, '0');
      const hours = String(estDep.getHours()).padStart(2, '0');
      const minutes = String(estDep.getMinutes()).padStart(2, '0');
      
      f.scheduledDeparture = `${year}-${month}-${day}T${hours}:${minutes}`;
      f.actualDeparture = f.scheduledDeparture;
      f.isEstimatedDeparture = true;
    }
  }
}

// Parser for Sabiha Gökçen flight table
function parseSawTable(html, type, todayStr) {
  const isDeparture = type === 'departures';
  const flights = [];
  const tbodyRegex = /<tbody[^>]*>([\s\S]*?)<\/tbody>/gi;
  const tbodyMatch = tbodyRegex.exec(html);
  if (!tbodyMatch) return flights;

  const tbodyHtml = tbodyMatch[1];
  const rowRegex = /<tr>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(tbodyHtml)) !== null) {
    const rowContent = rowMatch[1];
    
    // Helper to extract text inside a class span
    const extractClassText = (className) => {
      const regex = new RegExp(`class="${className}"[^>]*>([\\s\\S]*?)<`, 'i');
      const m = rowContent.match(regex);
      return m ? m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
    };

    let status = extractClassText('remark');
    if (!status) {
      const lastcolMatch = rowContent.match(/class="lastcol"[^>]*><span[^>]*>([\s\S]*?)<\/span>/i);
      status = lastcolMatch ? lastcolMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
    }

    const airline = extractClassText('airline');
    const flightNumRaw = extractClassText('flight');
    const flightNum = flightNumRaw.replace(/\s+/g, '').toUpperCase();
    const cityRaw = extractClassText('city');
    const scheduled = extractClassText('scheduled');
    const estimated = extractClassText('estimated');
    const gate = extractClassText('gate') || '-';
    
    if (flightNum && cityRaw) {
      const targetCode = findAirportCodeByCity(cityRaw) || "INT";
      
      const depIata = isDeparture ? "SAW" : targetCode;
      const arrIata = isDeparture ? targetCode : "SAW";

      flights.push({
        flightNumber: flightNum,
        date: getCorrectFlightDate(todayStr, scheduled),
        airline: airline || getAirlineName(flightNum),
        departureAirport: depIata,
        arrivalAirport: arrIata,
        departureCity: getAirportCity(depIata) || (isDeparture ? "İstanbul" : cityRaw),
        arrivalCity: getAirportCity(arrIata) || (isDeparture ? cityRaw : "İstanbul"),
        scheduledDeparture: isDeparture ? scheduled : "-",
        scheduledArrival: isDeparture ? "-" : scheduled,
        actualDeparture: isDeparture ? (estimated || scheduled) : "-",
        actualArrival: isDeparture ? "-" : (estimated || scheduled),
        terminal: 'Ana Terminal',
        gate: gate,
        status: status || "Planlandı"
      });
    }
  }
  return flights;
}

// Fetcher for Istanbul Airport (IST) flights via their JSON API
async function fetchIstFlights(nature, todayStr) {
  const getUrl = "https://www.istairport.com/ucuslar/ucus-bilgileri/giden-ucuslar";
  const postUrl = "https://www.istairport.com/umbraco/api/FlightInfo/GetFlightStatusBoard";
  const flights = [];

  try {
    // Establish session cookies
    const getRes = await fetch(getUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!getRes.ok) return flights;

    const html = await getRes.text();
    const getCookies = getRes.headers.getSetCookie();
    const cookieHeader = getCookies.map(c => c.split(';')[0]).join('; ');

    // Extract start and end dates from HTML to stay in sync with the server timezone
    const todayMatch = html.match(/class="[^"]*today[^"]*"[^>]*data-startdate="([^"]*)"/i);
    const endDateMatch = html.match(/class="[^"]*today[^"]*"[^>]*data-enddate="([^"]*)"/i) || html.match(/data-enddate="([^"]*)"/i);
    
    const startDate = todayMatch ? todayMatch[1] : `${todayStr} 12:00`;
    const endDate = endDateMatch ? endDateMatch[1] : getLocalDateString(1);

    // Call both Domestic (0) and International (1) lists
    for (const locType of ['0', '1']) {
      try {
        const formData = new URLSearchParams();
        formData.append('nature', String(nature));
        formData.append('searchTerm', '');
        formData.append('pageSize', '150'); // Fetch enough rows to capture active traffic
        formData.append('isInternational', locType);
        formData.append('date', startDate);
        formData.append('endDate', endDate);
        formData.append('culture', 'tr');
        formData.append('clickedButton', '');

        const postRes = await fetch(postUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": getUrl,
            "X-Requested-With": "XMLHttpRequest",
            "Cookie": cookieHeader
          },
          body: formData.toString()
        });

        if (postRes.ok) {
          const data = await postRes.json();
          if (data.status === true && data.result && data.result.data && data.result.data.flights) {
            data.result.data.flights.forEach(item => {
              const flightNum = item.flightNumber.replace(/\s+/g, '').toUpperCase();
              const date = item.scheduledDatetime ? item.scheduledDatetime.split('T')[0] : todayStr;
              
              const depIata = item.fromCityCode || (nature === 1 ? "IST" : "-");
              const arrIata = item.toCityCode || (nature === 1 ? "-" : "IST");

              const flightObj = {
                flightNumber: flightNum,
                date: date,
                airline: item.airlineName || getAirlineName(flightNum),
                departureAirport: depIata,
                arrivalAirport: arrIata,
                departureCity: getAirportCity(depIata) || item.fromCityName,
                arrivalCity: getAirportCity(arrIata) || item.toCityName,
                scheduledDeparture: nature === 1 ? formatIsoTime(item.scheduledDatetime) : "-",
                scheduledArrival: nature === 0 ? formatIsoTime(item.scheduledDatetime) : "-",
                actualDeparture: nature === 1 ? formatIsoTime(item.estimatedDatetime || item.scheduledDatetime) : "-",
                actualArrival: nature === 0 ? formatIsoTime(item.estimatedDatetime || item.scheduledDatetime) : "-",
                terminal: item.gate && item.gate.startsWith('G') ? 'T1' : 'Ana Terminal',
                gate: item.gate || "-",
                status: item.remark || "Planlandı"
              };
              flights.push(flightObj);

              // Expand codeshares
              if (Array.isArray(item.codeshare)) {
                item.codeshare.forEach(csNum => {
                  if (csNum) {
                    const cleanCsNum = csNum.replace(/\s+/g, '').toUpperCase();
                    flights.push({
                      ...flightObj,
                      flightNumber: cleanCsNum,
                      airline: getAirlineName(cleanCsNum)
                    });
                  }
                });
              }
            });
          }
        }
      } catch (e) {
        console.error(`IST API call failed for locType ${locType}:`, e.message);
      }
    }
  } catch (error) {
    console.error("IST Scraping establish session error:", error.message);
  }
  return flights;
}

// Convert ISO datetime strings to HH:MM format
function formatIsoTime(isoString) {
  if (!isoString) return "-";
  try {
    const d = new Date(isoString);
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  } catch (e) {
    if (/^\d{2}:\d{2}$/.test(isoString)) return isoString;
    const tIdx = isoString.indexOf('T');
    if (tIdx !== -1) {
      return isoString.slice(tIdx + 1, tIdx + 6);
    }
    return "-";
  }
}
const dhmiAirports = [
  { id: 2, iata: "ESB" }, // Ankara Esenboğa
  { id: 3, iata: "ADB" }, // İzmir Adnan Menderes
  { id: 4, iata: "AYT" }, // Antalya
  { id: 5, iata: "DLM" }, // Muğla Dalaman
  { id: 6, iata: "BJV" }, // Muğla Milas - Bodrum
  { id: 8, iata: "TZX" }, // Trabzon
  { id: 9, iata: "ISE" }, // Isparta Süleyman Demirel
  { id: 10, iata: "NOH" }, // Nevşehir Kapadokya
  { id: 11, iata: "ERZ" }, // Erzurum
  { id: 12, iata: "GZT" }, // Gaziantep
  { id: 13, iata: "ADF" }, // Adıyaman
  { id: 14, iata: "AJI" }, // Ağrı Ahmed-i Hani
  { id: 15, iata: "MZH" }, // Amasya Merzifon
  { id: 16, iata: "BZR" }, // Balıkesir Koca Seyit
  { id: 18, iata: "YEI" }, // Bursa Yenişehir
  { id: 19, iata: "CKY" }, // Çanakkale
  { id: 20, iata: "DNZ" }, // Denizli Çardak
  { id: 21, iata: "DIY" }, // Diyarbakır
  { id: 22, iata: "EZS" }, // Elazığ
  { id: 23, iata: "ERC" }, // Erzincan Yıldırım Akbulut
  { id: 24, iata: "HTY" }, // Hatay
  { id: 25, iata: "KCM" }, // Kahramanmaraş
  { id: 26, iata: "KDF" }, // Kars Harakani
  { id: 27, iata: "ASR" }, // Kayseri
  { id: 28, iata: "KYA" }, // Konya
  { id: 29, iata: "MLX" }, // Malatya
  { id: 30, iata: "MQM" }, // Mardin Prof. Dr. Aziz Sancar
  { id: 32, iata: "SAM" }, // Samsun Çarşamba
  { id: 33, iata: "SXZ" }, // Siirt
  { id: 34, iata: "SFC" }, // Sinop
  { id: 35, iata: "VAS" }, // Sivas Nuri Demirağ
  { id: 36, iata: "GNY" }, // Şanlıurfa GAP
  { id: 37, iata: "TEQ" }, // Tekirdağ Çorlu Atatürk
  { id: 38, iata: "TJK" }, // Tokat
  { id: 40, iata: "VAN" }, // Van Ferit Melen
  { id: 42, iata: "GZP" }, // Antalya Gazipaşa - Alanya
  { id: 44, iata: "BAL" }, // Batman
  { id: 45, iata: "KCO" }, // Kocaeli Cengiz Topel
  { id: 46, iata: "IGR" }, // Iğdır Şehit Bülent Aydın
  { id: 47, iata: "BGG" }, // Bingöl
  { id: 48, iata: "KZR" }, // Kütahya Zafer
  { id: 49, iata: "KFS" }, // Kastamonu
  { id: 50, iata: "ŞNY" }, // Şırnak Şerafettin Elçi
  { id: 54, iata: "OGU" }, // Ordu-Giresun
  { id: 55, iata: "YKO" }, // Hakkari Yüksekova Selahaddin Eyyubi
  { id: 56, iata: "MSR" }, // Muş Sultan Alparslan
  { id: 67, iata: "ONQ" }, // Zonguldak Çaycuma
  { id: 68, iata: "COV" }, // Çukurova International
  { id: 995, iata: "BZI" }, // Balıkesir Merkez
  { id: 996, iata: "GKD" }, // Çanakkale Gökçeada
  { id: 997, iata: "USQ" }, // Uşak
  { id: 998, iata: "RZE" }  // Rize-Artvin
];

async function fetchDhmiFlights(todayStr) {
  const pageUrl = 'https://www.dhmi.gov.tr/Sayfalar/TumUcuslar.aspx';
  const flights = [];
  
  try {
    const pageRes = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!pageRes.ok) return flights;
    
    const html = await pageRes.text();
    const tokenMatch = html.match(/id="Ktoken"\s+value="([^"]+)"/i) || html.match(/name="[^"]*Ktoken"[^>]*value="([^"]+)"/i);
    if (!tokenMatch) return flights;
    
    const token = tokenMatch[1];
    
    // Batch requesting logic to avoid rate limits
    const batchSize = 10;
    const allRequests = [];
    
    for (const ap of dhmiAirports) {
      for (const da of ['DA', 'DD']) {
        for (const i of ['D', 'I']) {
          allRequests.push({ ap, da, i });
        }
      }
    }
    
    console.log(`DHMİ API'sinden toplam ${allRequests.length} sorgu yapılacak...`);
    
    for (let batchStart = 0; batchStart < allRequests.length; batchStart += batchSize) {
      const batch = allRequests.slice(batchStart, batchStart + batchSize);
      
      await Promise.all(batch.map(async ({ ap, da, i }) => {
        try {
          const flightsUrl = `https://flightwebsvc.dhmi.gov.tr/api/Flights/${ap.id}/${da}/${i}`;
          const res = await fetch(flightsUrl, {
            headers: {
              'KToken': token,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'application/json, text/plain, */*'
            }
          });
          
          if (res.ok) {
            const list = await res.json();
            if (Array.isArray(list)) {
              list.forEach(item => {
                if (!item.Number) return;
                const flightNum = item.Number.replace(/\s+/g, '').toUpperCase();
                
                // Parse date ("24.06.2026" to "2026-06-24")
                let flightDate = todayStr;
                if (item.Date) {
                  const parts = item.Date.split('.');
                  if (parts.length === 3) {
                    flightDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
                  }
                }
                
                const targetCode = findAirportCodeByCity(item.SrcDst) || "INT";
                const isDeparture = da === 'DD';
                const depIata = isDeparture ? ap.iata : targetCode;
                const arrIata = isDeparture ? targetCode : ap.iata;
                
                const status = item.Status || "Planlandı";
                
                flights.push({
                  flightNumber: flightNum,
                  date: flightDate,
                  airline: item.Airline || getAirlineName(flightNum),
                  departureAirport: depIata,
                  arrivalAirport: arrIata,
                  departureCity: getAirportCity(depIata) || (isDeparture ? getAirportCity(ap.iata) : item.SrcDst),
                  arrivalCity: getAirportCity(arrIata) || (isDeparture ? item.SrcDst : getAirportCity(ap.iata)),
                  scheduledDeparture: isDeparture ? item.Planned : "-",
                  scheduledArrival: isDeparture ? "-" : item.Planned,
                  actualDeparture: isDeparture ? (item.Estimated || item.Planned) : "-",
                  actualArrival: isDeparture ? "-" : (item.Estimated || item.Planned),
                  terminal: 'Ana Terminal',
                  gate: item.Gate || "-",
                  status: status
                });
              });
            }
          }
        } catch (err) {
          // Ignore request failures to continue gracefully
        }
      }));
      
      await new Promise(r => setTimeout(r, 100));
    }
  } catch (error) {
    console.error("DHMİ veri çekme hatası:", error.message);
  }
  
  return flights;
}

// Tracks last successful update times
const updateStatus = {
  sawIst: { lastRun: null, lastCount: 0, running: false },
  dhmi:   { lastRun: null, lastCount: 0, running: false },
};

// Helper to check for delay updates and trigger Webhook endpoints
function checkAndTriggerWebhooks(newFlights) {
  return new Promise((resolve) => {
    db.all("SELECT url FROM webhooks", [], (err, webhookRows) => {
      if (err || !webhookRows || webhookRows.length === 0) {
        return resolve();
      }
      const urls = webhookRows.map(r => r.url);
      
      let pending = newFlights.length;
      if (pending === 0) return resolve();
      
      newFlights.forEach(f => {
        db.get(
          "SELECT actualDeparture, actualArrival, status FROM flights WHERE flightNumber = ? AND date = ? AND departureAirport = ? AND arrivalAirport = ?",
          [f.flightNumber, f.date, f.departureAirport, f.arrivalAirport],
          (err, row) => {
            if (err) {
              pending--;
              if (pending === 0) resolve();
              return;
            }
            
            const newDepDelay = calculateDelayMinutes(f.scheduledDeparture, f.actualDeparture);
            const newArrDelay = calculateDelayMinutes(f.scheduledArrival, f.actualArrival);
            
            let eventType = null;
            let changeReason = "";
            
            if (!row) {
              // Brand new flight with delay
              if (newDepDelay > 0 || newArrDelay > 0 || (f.status && f.status.toUpperCase().includes('İPTAL'))) {
                eventType = "flight.created_with_delay";
                changeReason = "New flight registered with delay or cancellation";
              }
            } else {
              // Existing flight delay/status change
              const oldDepDelay = calculateDelayMinutes(f.scheduledDeparture, row.actualDeparture);
              const oldArrDelay = calculateDelayMinutes(f.scheduledArrival, row.actualArrival);
              
              const depDelayChanged = newDepDelay !== oldDepDelay;
              const arrDelayChanged = newArrDelay !== oldArrDelay;
              const statusChanged = f.status !== row.status;
              
              if (depDelayChanged || arrDelayChanged) {
                eventType = "flight.delay_updated";
                changeReason = `Delay updated. Departure: ${oldDepDelay}m -> ${newDepDelay}m. Arrival: ${oldArrDelay}m -> ${newArrDelay}m.`;
              } else if (statusChanged && (newDepDelay > 0 || newArrDelay > 0 || f.status.toUpperCase().includes('İPTAL') || f.status.toUpperCase().includes('İNDİ') || f.status.toUpperCase().includes('LANDED'))) {
                eventType = "flight.status_updated";
                changeReason = `Status changed: ${row.status} -> ${f.status}`;
              }
            }
            
            if (eventType) {
              const payload = {
                event: eventType,
                reason: changeReason,
                timestamp: new Date().toISOString(),
                flight: {
                  flightNumber: f.flightNumber,
                  date: f.date,
                  airline: f.airline,
                  departureAirport: f.departureAirport,
                  arrivalAirport: f.arrivalAirport,
                  departureCity: f.departureCity,
                  arrivalCity: f.arrivalCity,
                  scheduledDeparture: f.scheduledDeparture,
                  scheduledArrival: f.scheduledArrival,
                  actualDeparture: f.actualDeparture,
                  actualArrival: f.actualArrival,
                  departureDelayMinutes: newDepDelay,
                  arrivalDelayMinutes: newArrDelay,
                  terminal: f.terminal,
                  gate: f.gate,
                  status: f.status
                }
              };
              
              urls.forEach(url => {
                fetch(url, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload),
                  signal: AbortSignal.timeout(4000)
                }).catch(e => {
                  console.error(`Webhook send failed for ${url}:`, e.message);
                });
              });
            }
            
            pending--;
            if (pending === 0) resolve();
          }
        );
      });
    });
  });
}

// Shared helper: writes new flights to SQLite via transaction with conflict resolution (upsert)
async function persistFlights(newFlights) {
  if (!newFlights || newFlights.length === 0) return;
  
  // Pre-process flights to convert times to full ISO datetimes
  const processedFlights = newFlights.map(f => {
    let scheduledDeparture = f.scheduledDeparture;
    let scheduledArrival = f.scheduledArrival;
    let actualDeparture = f.actualDeparture;
    let actualArrival = f.actualArrival;
    
    if (scheduledDeparture !== '-' && !scheduledDeparture.includes('T')) {
      scheduledDeparture = f.date + 'T' + scheduledDeparture;
    }
    if (scheduledArrival !== '-' && !scheduledArrival.includes('T')) {
      scheduledArrival = f.date + 'T' + scheduledArrival;
    }
    
    if (actualDeparture !== '-' && !actualDeparture.includes('T')) {
      const schedTime = scheduledDeparture !== '-' ? scheduledDeparture.split('T')[1] : '00:00';
      actualDeparture = resolveEstimatedDatetime(f.date, schedTime, actualDeparture);
    }
    if (actualArrival !== '-' && !actualArrival.includes('T')) {
      const schedTime = scheduledArrival !== '-' ? scheduledArrival.split('T')[1] : '00:00';
      actualArrival = resolveEstimatedDatetime(f.date, schedTime, actualArrival);
    }
    
    return {
      ...f,
      scheduledDeparture,
      scheduledArrival,
      actualDeparture,
      actualArrival
    };
  });
  
  try {
    await checkAndTriggerWebhooks(processedFlights);
  } catch (e) {
    console.error("Webhook trigger check failed:", e.message);
  }

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    const stmt = db.prepare(`
      INSERT INTO flights (
        flightNumber, date, airline, departureAirport, arrivalAirport,
        departureCity, arrivalCity, scheduledDeparture, scheduledArrival,
        actualDeparture, actualArrival, terminal, gate, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(flightNumber, date, departureAirport, arrivalAirport) DO UPDATE SET
        airline = CASE WHEN excluded.airline != 'Diğer Havayolu' AND excluded.airline != '' THEN excluded.airline ELSE flights.airline END,
        departureCity = CASE WHEN excluded.departureCity != '' AND excluded.departureCity IS NOT NULL THEN excluded.departureCity ELSE flights.departureCity END,
        arrivalCity = CASE WHEN excluded.arrivalCity != '' AND excluded.arrivalCity IS NOT NULL THEN excluded.arrivalCity ELSE flights.arrivalCity END,
        scheduledDeparture = CASE WHEN excluded.scheduledDeparture != '-' AND excluded.scheduledDeparture != '' AND excluded.scheduledDeparture IS NOT NULL THEN excluded.scheduledDeparture ELSE flights.scheduledDeparture END,
        scheduledArrival = CASE WHEN excluded.scheduledArrival != '-' AND excluded.scheduledArrival != '' AND excluded.scheduledArrival IS NOT NULL THEN excluded.scheduledArrival ELSE flights.scheduledArrival END,
        actualDeparture = CASE 
          WHEN (UPPER(flights.status) LIKE '%İNDİ%' OR UPPER(flights.status) LIKE '%LANDED%' OR UPPER(flights.status) LIKE '%İPTAL%' OR UPPER(flights.status) LIKE '%CANCEL%')
               AND (UPPER(excluded.status) NOT LIKE '%İNDİ%' AND UPPER(excluded.status) NOT LIKE '%LANDED%' AND UPPER(excluded.status) NOT LIKE '%İPTAL%' AND UPPER(excluded.status) NOT LIKE '%CANCEL%')
               THEN flights.actualDeparture
          WHEN excluded.actualDeparture != '-' AND excluded.actualDeparture != '' AND excluded.actualDeparture IS NOT NULL THEN excluded.actualDeparture
          ELSE flights.actualDeparture
        END,
        actualArrival = CASE 
          WHEN (UPPER(flights.status) LIKE '%İNDİ%' OR UPPER(flights.status) LIKE '%LANDED%' OR UPPER(flights.status) LIKE '%İPTAL%' OR UPPER(flights.status) LIKE '%CANCEL%')
               AND (UPPER(excluded.status) NOT LIKE '%İNDİ%' AND UPPER(excluded.status) NOT LIKE '%LANDED%' AND UPPER(excluded.status) NOT LIKE '%İPTAL%' AND UPPER(excluded.status) NOT LIKE '%CANCEL%')
               THEN flights.actualArrival
          WHEN excluded.actualArrival != '-' AND excluded.actualArrival != '' AND excluded.actualArrival IS NOT NULL THEN excluded.actualArrival
          ELSE flights.actualArrival
        END,
        terminal = CASE WHEN excluded.terminal != 'Ana Terminal' AND excluded.terminal != '-' AND excluded.terminal != '' AND excluded.terminal IS NOT NULL THEN excluded.terminal ELSE flights.terminal END,
        gate = CASE WHEN excluded.gate != '-' AND excluded.gate != '' AND excluded.gate IS NOT NULL THEN excluded.gate ELSE flights.gate END,
        status = CASE 
          WHEN (UPPER(flights.status) LIKE '%İNDİ%' OR UPPER(flights.status) LIKE '%LANDED%' OR UPPER(flights.status) LIKE '%İPTAL%' OR UPPER(flights.status) LIKE '%CANCEL%')
               AND (UPPER(excluded.status) NOT LIKE '%İNDİ%' AND UPPER(excluded.status) NOT LIKE '%LANDED%' AND UPPER(excluded.status) NOT LIKE '%İPTAL%' AND UPPER(excluded.status) NOT LIKE '%CANCEL%')
               THEN flights.status
          WHEN excluded.status != 'Planlandı' AND excluded.status != 'PLANLANDI' AND excluded.status != 'Planlandı / Scheduled' AND excluded.status != '-' AND excluded.status != '' AND excluded.status IS NOT NULL THEN excluded.status
          ELSE flights.status
        END
    `);
    processedFlights.forEach(f => {
      stmt.run([
        f.flightNumber, f.date, f.airline, f.departureAirport, f.arrivalAirport,
        f.departureCity, f.arrivalCity, f.scheduledDeparture, f.scheduledArrival,
        f.actualDeparture, f.actualArrival, f.terminal, f.gate, f.status
      ]);
    });
    stmt.finalize();
    db.run("COMMIT", (err) => {
      if (err) console.error("Commit Error:", err.message);
    });
  });
}

// FAST WORKER — SAW + IST every 5 minutes
async function runFastWorker() {
  if (updateStatus.sawIst.running) return; // skip if already running
  updateStatus.sawIst.running = true;
  const todayStr = getLocalDateString();
  const newFlights = [];

  // 1. SAW Departures
  try {
    const url = "https://www.sabihagokcen.aero/passengers-and-visitors/passenger-guide/flight-info";
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      newFlights.push(...parseSawTable(await res.text(), 'departures', todayStr));
    }
  } catch (e) { console.error("SAW Dep hatası:", e.message); }

  // 2. SAW Arrivals
  try {
    const url = "https://www.sabihagokcen.aero/passengers-and-visitors/passenger-guide/flight-info";
    const getRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (getRes.ok) {
      const html = await getRes.text();
      const hiddenInputsRegex = /<input\s+type="hidden"\s+name="([^"]*)"\s+id="[^"]*"\s+value="([^"]*)"/gi;
      const formData = new URLSearchParams();
      let match;
      while ((match = hiddenInputsRegex.exec(html)) !== null) formData.append(match[1], match[2]);
      formData.set('__EVENTTARGET', 'ctl00$ctl00$ContentPlaceHolder_ForNested$ContentPlaceHolder_ForNested$LinkButton_Arrival');
      formData.set('__EVENTARGUMENT', '');
      const cookieHeader = getRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
      const postRes = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': url, 'Cookie': cookieHeader },
        body: formData.toString()
      });
      if (postRes.ok) newFlights.push(...parseSawTable(await postRes.text(), 'arrivals', todayStr));
    }
  } catch (e) { console.error("SAW Arr hatası:", e.message); }

  // 3. IST Departures + Arrivals
  try { newFlights.push(...await fetchIstFlights(1, todayStr)); } catch (e) { console.error("IST Dep hatası:", e.message); }
  try { newFlights.push(...await fetchIstFlights(0, todayStr)); } catch (e) { console.error("IST Arr hatası:", e.message); }

  persistFlights(newFlights);
  updateStatus.sawIst = { lastRun: new Date().toISOString(), lastCount: newFlights.length, running: false };
  console.log(`[HIZLI] SAW+IST güncellendi: ${newFlights.length} uçuş — ${new Date().toLocaleTimeString('tr-TR')}`);
}

// SLOW WORKER — DHMİ (52 airports) every 20 minutes
async function runSlowWorker() {
  if (updateStatus.dhmi.running) return;
  updateStatus.dhmi.running = true;
  const todayStr = getLocalDateString();

  try {
    console.log("[YAVAS] DHMİ Anadolu havalimanları güncelleniyor...");
    const dhmiFlights = await fetchDhmiFlights(todayStr);
    persistFlights(dhmiFlights);
    updateStatus.dhmi = { lastRun: new Date().toISOString(), lastCount: dhmiFlights.length, running: false };
    console.log(`[YAVAS] DHMİ tamamlandı: ${dhmiFlights.length} uçuş — ${new Date().toLocaleTimeString('tr-TR')}`);
  } catch (e) {
    console.error("DHMİ Worker hatası:", e.message);
    updateStatus.dhmi.running = false;
  }

  // Clean up flights older than 3 days (only done in slow worker)
  const limitDate = getLocalDateString(-3);
  db.run("DELETE FROM flights WHERE date < ?", [limitDate]);

  db.get("SELECT COUNT(*) AS total FROM flights", (err, row) => {
    if (!err && row) console.log(`[DB] Toplam uçuş kaydı: ${row.total}`);
  });
}

// Startup: run both workers immediately, then on schedule
runFastWorker();
runSlowWorker();
setInterval(runFastWorker, 5 * 60 * 1000);   // SAW + IST: every 5 minutes
setInterval(runSlowWorker, 20 * 60 * 1000);  // DHMİ: every 20 minutes


// --- API ENDPOINTS ---

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/developer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'developer.html'));
});

// Get list of all airports in Turkey
app.get('/api/airports', (req, res) => {
  res.json({
    success: true,
    count: Object.keys(airportsDb).length,
    airports: airportsDb
  });
});

// System status endpoint — shows last update times & freshness
app.get('/api/status', (req, res) => {
  db.get("SELECT COUNT(*) AS total FROM flights", (err, row) => {
    const now = new Date();

    const ageMinutes = (isoStr) => {
      if (!isoStr) return null;
      return Math.round((now - new Date(isoStr)) / 60000);
    };

    res.json({
      success: true,
      server: {
        uptime: Math.round(process.uptime()) + 's',
        memory: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1) + ' MB',
        nodeVersion: process.version
      },
      database: {
        totalFlights: err ? 'error' : row.total
      },
      scrapers: {
        'SAW + IST (hizli)': {
          interval: '5 dakika',
          lastRun: updateStatus.sawIst.lastRun,
          ageMinutes: ageMinutes(updateStatus.sawIst.lastRun),
          lastFlightCount: updateStatus.sawIst.lastCount,
          running: updateStatus.sawIst.running
        },
        'DHMİ Anadolu (yavas)': {
          interval: '20 dakika',
          lastRun: updateStatus.dhmi.lastRun,
          ageMinutes: ageMinutes(updateStatus.dhmi.lastRun),
          lastFlightCount: updateStatus.dhmi.lastCount,
          running: updateStatus.dhmi.running
        }
      }
    });
  });
});

// Main combined list of flights
app.get('/api/flights', (req, res) => {
  let query = "SELECT * FROM flights WHERE 1=1";
  const params = [];

  // Specific Departure Airport Filter
  if (req.query.departure) {
    query += " AND departureAirport = ?";
    params.push(req.query.departure.toUpperCase().trim());
  }
  // Specific Arrival Airport Filter
  if (req.query.arrival) {
    query += " AND arrivalAirport = ?";
    params.push(req.query.arrival.toUpperCase().trim());
  }
  // Single Airport Search
  if (req.query.airport && !req.query.departure && !req.query.arrival) {
    query += " AND (departureAirport = ? OR arrivalAirport = ?)";
    const searchVal = req.query.airport.toUpperCase().trim();
    params.push(searchVal, searchVal);
  }

  // Type Filter
  if (req.query.type) {
    const search = req.query.type.toLowerCase().trim();
    if (search === 'departure' || search === 'departures') {
      query += " AND scheduledDeparture != '-'";
    } else if (search === 'arrival' || search === 'arrivals') {
      query += " AND scheduledArrival != '-'";
    }
  }

  // Airline Filter
  if (req.query.airline) {
    query += " AND airline LIKE ?";
    params.push(`%${req.query.airline.trim()}%`);
  }

  // Flight Number Filter
  if (req.query.flight) {
    query += " AND flightNumber LIKE ?";
    params.push(`%${req.query.flight.replace(/\s+/g, '').trim()}%`);
  }

  // Date Filter
  const dateStr = req.query.date ? req.query.date.trim() : getLocalDateString();
  query += " AND date = ?";
  params.push(dateStr);

  // Delayed Filter
  if (req.query.delayed === 'true') {
    query += " AND ((scheduledDeparture != '-' AND actualDeparture > scheduledDeparture) OR (scheduledArrival != '-' AND actualArrival > scheduledArrival) OR status LIKE '%Gecikme%' OR status LIKE '%Rötar%' OR status LIKE '%Delay%')";
  }

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    fillMissingLegs(rows, (healedRows) => {
      const flightsWithDelay = healedRows.map(r => {
        const depDelay = calculateDelayMinutes(r.scheduledDeparture, r.actualDeparture);
        const arrDelay = calculateDelayMinutes(r.scheduledArrival, r.actualArrival);
        const statusInfo = getStandardizedStatus(r.status);
        return { 
          ...r, 
          departureDelayMinutes: depDelay,
          arrivalDelayMinutes: arrDelay,
          scheduledDepartureUtc: convertToUtcIso(r.scheduledDeparture),
          scheduledArrivalUtc: convertToUtcIso(r.scheduledArrival),
          actualDepartureUtc: convertToUtcIso(r.actualDeparture),
          actualArrivalUtc: convertToUtcIso(r.actualArrival),
          statusCode: statusInfo.code,
          statusText: statusInfo.text
        };
      });
      res.json({
        success: true,
        count: flightsWithDelay.length,
        timestamp: new Date().toISOString(),
        flights: flightsWithDelay
      });
    });
  });
});

// Search flight by number and date (No mock generation fallback)
app.get('/api/flights/search', (req, res) => {
  const flightNumber = req.query.flightNumber ? req.query.flightNumber.replace(/\s+/g, '').toUpperCase().trim() : '';
  const dateVal = Array.isArray(req.query.date) ? req.query.date[0] : req.query.date;
  const dateStr = dateVal || getLocalDateString();

  if (!flightNumber) {
    return res.status(400).json({
      success: false,
      message: 'Uçuş numarası (flightNumber) girmek zorunludur.'
    });
  }

  // Get records close to dateStr (yesterday, today, tomorrow) to capture overnight/next-day connections
  const d = new Date(dateStr);
  const prevDate = new Date(d);
  prevDate.setDate(d.getDate() - 1);
  const nextDate = new Date(d);
  nextDate.setDate(d.getDate() + 1);
  
  const formatDate = (dateObj) => {
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const datesToSearch = [dateStr, formatDate(prevDate), formatDate(nextDate)];

  let query = "SELECT * FROM flights WHERE flightNumber = ? AND date IN (?, ?, ?)";
  const params = [flightNumber, ...datesToSearch];

  if (req.query.departure) {
    query += " AND departureAirport = ?";
    params.push(req.query.departure.toUpperCase().trim());
  }
  if (req.query.arrival) {
    query += " AND arrivalAirport = ?";
    params.push(req.query.arrival.toUpperCase().trim());
  }

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Belirtilen uçuş numarası (${flightNumber}) ve tarih (${dateStr}) için uçuş bulunamadı.`
      });
    }

    // Sort rows by date ascending, then by departure/arrival time
    rows.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      const timeA = a.scheduledDeparture !== '-' ? a.scheduledDeparture : a.scheduledArrival;
      const timeB = b.scheduledDeparture !== '-' ? b.scheduledDeparture : b.scheduledArrival;
      return timeA.localeCompare(timeB);
    });

    // Merge complementary adjacent-day rows (overnight flights)
    const processedRows = [];
    const mergedIndices = new Set();

    for (let i = 0; i < rows.length; i++) {
      if (mergedIndices.has(i)) continue;
      
      const current = { ...rows[i] };

      // Look for a complementary row in subsequent rows
      for (let j = i + 1; j < rows.length; j++) {
        if (mergedIndices.has(j)) continue;
        
        const next = rows[j];
        
        // Must be same route
        if (current.departureAirport !== next.departureAirport || current.arrivalAirport !== next.arrivalAirport) {
          continue;
        }

        // Must be adjacent days (current.date is D, next.date is D+1 or same date)
        const dateA = new Date(current.date);
        const dateB = new Date(next.date);
        const diffDays = Math.round((dateB - dateA) / (1000 * 60 * 60 * 24));

        if (diffDays === 0 || diffDays === 1) {
          // Check if they are complementary:
          // Case 1: current has departure but no arrival, next has arrival but no departure
          const currentHasDepOnly = current.scheduledDeparture !== '-' && current.scheduledArrival === '-';
          const nextHasArrOnly = next.scheduledArrival !== '-' && next.scheduledDeparture === '-';

          // Case 2: current has arrival but no departure, next has departure but no arrival (less common chronologically, but possible)
          const currentHasArrOnly = current.scheduledArrival !== '-' && current.scheduledDeparture === '-';
          const nextHasDepOnly = next.scheduledDeparture !== '-' && next.scheduledArrival === '-';

          if ((currentHasDepOnly && nextHasArrOnly) || (currentHasArrOnly && nextHasDepOnly)) {
            // Merge next into current
            if (next.scheduledDeparture !== '-') {
              current.scheduledDeparture = next.scheduledDeparture;
              current.date = next.date; // Prefer departure date
            }
            if (next.scheduledArrival !== '-') {
              current.scheduledArrival = next.scheduledArrival;
            }
            if (next.actualDeparture !== '-' && next.actualDeparture !== '') {
              current.actualDeparture = next.actualDeparture;
            }
            if (next.actualArrival !== '-' && next.actualArrival !== '') {
              current.actualArrival = next.actualArrival;
            }
            if (next.gate !== '-' && current.gate === '-') {
              current.gate = next.gate;
            }
            if (next.terminal !== 'Ana Terminal' && current.terminal === 'Ana Terminal') {
              current.terminal = next.terminal;
            }
            
            const getStatusPriority = (status) => {
              if (!status || status === '-' || status.toLowerCase().includes('plan')) return 0;
              if (status.toLowerCase().includes('time') || status.toLowerCase().includes('zaman')) return 1;
              return 2;
            };
            if (getStatusPriority(next.status) > getStatusPriority(current.status)) {
              current.status = next.status;
            }

            mergedIndices.add(j);
            break;
          }
        }
      }

      processedRows.push(current);
    }

    fillMissingLegs(processedRows, (healedRows) => {
      const processedRowsWithDelay = healedRows.map(r => {
        const depDelay = calculateDelayMinutes(r.scheduledDeparture, r.actualDeparture);
        const arrDelay = calculateDelayMinutes(r.scheduledArrival, r.actualArrival);
        const statusInfo = getStandardizedStatus(r.status);
        return { 
          ...r, 
          departureDelayMinutes: depDelay,
          arrivalDelayMinutes: arrDelay,
          scheduledDepartureUtc: convertToUtcIso(r.scheduledDeparture),
          scheduledArrivalUtc: convertToUtcIso(r.scheduledArrival),
          actualDepartureUtc: convertToUtcIso(r.actualDeparture),
          actualArrivalUtc: convertToUtcIso(r.actualArrival),
          statusCode: statusInfo.code,
          statusText: statusInfo.text
        };
      });

      // Find the best match for the requested dateStr
      let bestMatch = processedRowsWithDelay.find(f => f.date === dateStr);
      if (!bestMatch && processedRowsWithDelay.length > 0) {
        bestMatch = processedRowsWithDelay[0];
      }

      res.json({
        success: true,
        query: {
          flightNumber: flightNumber,
          date: dateStr
        },
        count: processedRowsWithDelay.length,
        flights: processedRowsWithDelay,
        flight: bestMatch
      });
    });
  });
});

// Backward compatible specific airport endpoint
app.get('/api/airports/:iata/:type', (req, res) => {
  const iata = req.params.iata.toUpperCase().trim();
  const type = req.params.type.toLowerCase().trim();

  if (!airportsDb[iata]) {
    return res.status(400).json({ success: false, message: `Geçersiz havalimanı kodu: ${iata}` });
  }
  if (type !== 'departures' && type !== 'arrivals') {
    return res.status(400).json({ success: false, message: 'Sadece departures veya arrivals desteklenmektedir.' });
  }

  const today = getLocalDateString();
  let query = "SELECT * FROM flights WHERE date = ?";
  const params = [today];

  if (type === 'departures') {
    query += " AND departureAirport = ? AND scheduledDeparture != '-'";
  } else {
    query += " AND arrivalAirport = ? AND scheduledArrival != '-'";
  }
  params.push(iata);

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({
      success: true,
      airport: iata,
      type: type,
      lastUpdated: today,
      count: rows.length,
      flights: rows
    });
  });
});

// --- WEBHOOK ENDPOINTS ---
const receivedWebhooks = [];

// Subscribe a new Webhook URL
app.post('/api/webhooks/subscribe', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "URL is required" });
  
  db.run(
    "INSERT OR REPLACE INTO webhooks (url, createdAt) VALUES (?, ?)",
    [url, new Date().toISOString()],
    (err) => {
      if (err) return res.status(500).json({ success: false, error: err.message });
      res.json({ success: true, message: `Successfully subscribed ${url}` });
    }
  );
});

// Unsubscribe a Webhook URL
app.post('/api/webhooks/unsubscribe', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "URL is required" });
  
  db.run(
    "DELETE FROM webhooks WHERE url = ?",
    [url],
    (err) => {
      if (err) return res.status(500).json({ success: false, error: err.message });
      res.json({ success: true, message: `Successfully unsubscribed ${url}` });
    }
  );
});

// Get all active Webhook URL subscriptions
app.get('/api/webhooks', (req, res) => {
  db.all("SELECT * FROM webhooks ORDER BY createdAt DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, count: rows.length, webhooks: rows });
  });
});

// Built-in Webhook Test Receiver Endpoint
app.post('/api/webhooks/test-receiver', (req, res) => {
  receivedWebhooks.unshift({
    id: Date.now() + Math.random().toString(36).substr(2, 5),
    timestamp: new Date().toISOString(),
    headers: req.headers,
    body: req.body
  });
  if (receivedWebhooks.length > 50) receivedWebhooks.pop();
  res.json({ success: true, message: "Webhook received by built-in test receiver" });
});

// Get received webhooks logs
app.get('/api/webhooks/test-receiver', (req, res) => {
  res.json({ success: true, count: receivedWebhooks.length, webhooks: receivedWebhooks });
});

// Clear received webhooks logs
app.delete('/api/webhooks/test-receiver', (req, res) => {
  receivedWebhooks.length = 0;
  res.json({ success: true, message: "Cleared received webhook logs" });
});

app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`  Uçuş Takip API Servisi Başlatıldı!`);
  console.log(`  Port: http://localhost:3000`);
  console.log(`==================================================`);
});
