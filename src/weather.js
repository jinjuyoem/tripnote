// 날씨: 10일 이내는 구글 날씨 예보, 그 이후 날짜는 작년 같은 날 실제 날씨(참고용)
const KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

const withTimeout = (p, ms = 10000) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error('timeout')), ms))]);
const ymd = (d) => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

export function emojiFromType(type = '') {
  const t = type.toUpperCase();
  if (t.includes('THUNDER')) return '⛈️';
  if (t.includes('SNOW') || t.includes('HAIL')) return '🌨️';
  if (t.includes('RAIN') || t.includes('SHOWER') || t.includes('DRIZZLE')) return '🌧️';
  if (t.includes('FOG') || t.includes('HAZE')) return '🌫️';
  if (t.includes('WIND')) return '💨';
  if (t === 'PARTLY_CLOUDY' || t === 'MOSTLY_CLEAR') return '⛅';
  if (t.includes('CLOUDY')) return '☁️';
  if (t.includes('CLEAR')) return '☀️';
  return '🌤️';
}
// Open-Meteo(WMO) 날씨 코드
function fromWmo(c) {
  if (c == null) return ['🌤️', ''];
  if (c === 0) return ['☀️', '맑음'];
  if (c <= 2) return ['⛅', '구름 조금'];
  if (c === 3) return ['☁️', '흐림'];
  if (c <= 48) return ['🌫️', '안개'];
  if (c <= 67 || (c >= 80 && c <= 82)) return ['🌧️', '비'];
  if (c <= 77 || c === 85 || c === 86) return ['🌨️', '눈'];
  return ['⛈️', '뇌우'];
}

export async function geocodeCity(name) {
  if (!name) return null;
  const r = await withTimeout(fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=ko`));
  const j = await r.json();
  const x = j.results?.[0];
  return x ? { lat: x.latitude, lng: x.longitude } : null;
}

const mem = new Map();
const cacheGet = (k) => {
  if (mem.has(k)) return mem.get(k);
  try { const v = JSON.parse(localStorage.getItem('wx:' + k) || 'null'); if (v && Date.now() - v.at < 3 * 3600e3) { mem.set(k, v.data); return v.data; } } catch { /* */ }
  return null;
};
const cachePut = (k, data) => { mem.set(k, data); try { localStorage.setItem('wx:' + k, JSON.stringify({ at: Date.now(), data })); } catch { /* */ } };

/** { 'YYYY-MM-DD': {emoji, text, max, min, pop, kind:'forecast'|'lastyear'} } */
export async function tripWeather(geo, days) {
  const real = days.filter((d) => /^\d{4}-/.test(d));
  if (!geo || !real.length) return {};
  const k = `${geo.lat.toFixed(2)},${geo.lng.toFixed(2)}:${real[0]}:${real[real.length - 1]}`;
  const hit = cacheGet(k); if (hit) return hit;
  const out = {};
  // 1) 예보 (오늘부터 10일)
  if (KEY) {
    try {
      const r = await withTimeout(fetch(`https://weather.googleapis.com/v1/forecast/days:lookup?key=${KEY}&location.latitude=${geo.lat}&location.longitude=${geo.lng}&days=10&pageSize=10&languageCode=ko`));
      const j = await r.json();
      for (const f of j.forecastDays || []) {
        const d = ymd(f.displayDate); if (!real.includes(d)) continue;
        const part = f.daytimeForecast?.weatherCondition ? f.daytimeForecast : f.nighttimeForecast || {};
        out[d] = {
          kind: 'forecast', emoji: emojiFromType(part.weatherCondition?.type), text: part.weatherCondition?.description?.text || '',
          max: f.maxTemperature?.degrees, min: f.minTemperature?.degrees, pop: part.precipitation?.probability?.percent,
        };
      }
    } catch (e) { console.warn('forecast', e); }
  }
  // 1-2) 구글 예보가 안 되는 지역(중국 본토 등)은 Open-Meteo 예보(16일)
  const today = new Date().toISOString().slice(0, 10);
  const lim = new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10);
  const need = real.filter((d) => !out[d] && d >= today && d <= lim);
  if (need.length) {
    try {
      const r = await withTimeout(fetch(`https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lng}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=16`));
      const j = await r.json(); const D = j.daily || {};
      (D.time || []).forEach((d, i) => {
        if (!need.includes(d)) return;
        const [emoji, text] = fromWmo(D.weather_code?.[i]);
        out[d] = { kind: 'forecast', emoji, text, max: D.temperature_2m_max?.[i], min: D.temperature_2m_min?.[i], pop: D.precipitation_probability_max?.[i] };
      });
    } catch (e) { console.warn('forecast2', e); }
  }
  // 2) 예보 범위 밖은 작년 같은 날짜 실제 날씨
  const rest = real.filter((d) => !out[d]);
  if (rest.length) {
    const last = (d) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
    try {
      const r = await withTimeout(fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${geo.lat}&longitude=${geo.lng}&start_date=${last(rest[0])}&end_date=${last(rest[rest.length - 1])}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`));
      const j = await r.json(); const D = j.daily || {};
      (D.time || []).forEach((t, i) => {
        const d = `${Number(t.slice(0, 4)) + 1}${t.slice(4)}`; if (!rest.includes(d)) return;
        const [emoji, text] = fromWmo(D.weather_code?.[i]);
        out[d] = { kind: 'lastyear', emoji, text, max: D.temperature_2m_max?.[i], min: D.temperature_2m_min?.[i], rain: D.precipitation_sum?.[i] };
      });
    } catch (e) { console.warn('archive', e); }
  }
  if (Object.keys(out).length) cachePut(k, out); // 실패(빈 결과)는 저장 안 함
  return out;
}
