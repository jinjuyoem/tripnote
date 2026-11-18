// 항공편 조회 (AeroDataBox via RapidAPI). 키는 Vercel 환경변수 AERODATABOX_KEY 에만 있음.
// 로그인한 여행노트 사용자만 호출 가능 (Firebase ID 토큰 확인)
import { createRemoteJWKSet, jwtVerify } from 'jose';

const PROJECT = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || 'precise-clock-515103-r8';
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));
const HOST = 'aerodatabox.p.rapidapi.com';

const t = (x) => (x ? (typeof x === 'string' ? x : x.local || null) : null); // "2026-12-05 09:00+09:00"
const side = (s = {}) => ({
  iata: s.airport?.iata || null,
  name: s.airport?.shortName || s.airport?.name || null,
  sched: t(s.scheduledTime) || s.scheduledTimeLocal || null,
  revised: t(s.revisedTime) || s.revisedTimeLocal || t(s.predictedTime) || null,
  actual: t(s.runwayTime) || s.actualTimeLocal || null,
  terminal: s.terminal || null,
  gate: s.gate || null,
  belt: s.baggageBelt || null,
  checkIn: s.checkInDesk || null,
});

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'login' });
    await jwtVerify(token, JWKS, { issuer: `https://securetoken.google.com/${PROJECT}`, audience: PROJECT });
  } catch {
    return res.status(401).json({ error: 'login' });
  }
  const no = String(req.query.no || '').toUpperCase().replace(/\s/g, '');
  const date = String(req.query.date || '');
  if (!/^[A-Z0-9]{2,3}\d{1,5}[A-Z]?$/.test(no) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'input' });
  const key = process.env.AERODATABOX_KEY || process.env.AERODATAX_KEY;
  if (!key) return res.status(503).json({ error: 'nokey' });
  try {
    const r = await fetch(`https://${HOST}/flights/number/${encodeURIComponent(no)}/${date}?withAircraftImage=false&withLocation=false&dateLocalRole=Departure`, {
      headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': HOST },
    });
    if (r.status === 204 || r.status === 404) return res.status(200).json({ flights: [] });
    if (r.status === 429) return res.status(429).json({ error: 'quota' });
    if (!r.ok) return res.status(502).json({ error: 'upstream', status: r.status });
    const data = await r.json();
    const flights = (Array.isArray(data) ? data : []).map((f) => ({
      no: f.number || no, status: f.status || 'Unknown', airline: f.airline?.name || null,
      aircraft: f.aircraft?.model || null, dep: side(f.departure), arr: side(f.arrival),
    }));
    return res.status(200).json({ flights });
  } catch (e) {
    return res.status(502).json({ error: 'fetch' });
  }
}
