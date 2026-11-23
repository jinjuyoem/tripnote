// 관리자 전용: 구글 API 오늘·이번 달 사용량 (Cloud Monitoring)
// 필요 환경변수: GCP_SA_KEY = 서비스 계정 JSON 키 (원문 또는 base64). 서비스 계정에 'Monitoring 뷰어' 역할 필요
import { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8 } from 'jose';
import { createHash } from 'node:crypto';

const PROJECT = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || 'precise-clock-515103-r8';
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));
// main.js ADMIN_HASHES / firestore.rules isAdmin() 와 같은 값
const ADMIN_HASHES = ['8c4c2ef482a22848694d608da19923a106ffc3e525e676ccb67de45bd58b229a'];

// 항목: 이름, 일일 상한(GCP 콘솔에 걸어둔 값), 월 무료분(SKU 기준), 매칭 규칙(service + method)
// 상한을 콘솔에서 바꾸면 여기 day 값도 같이 바꾸기
export const METERS = [
  { id: 'map', name: '지도 로드', day: 300, month: 10000, sku: 'Dynamic Maps (Essentials)', re: /maps-backend|MapsJavaScript|MapLoad/i },
  { id: 'ac', name: '장소 자동완성', day: 1000, month: 10000, sku: 'Autocomplete Requests', re: /Autocomplete/i },
  { id: 'place', name: '장소 상세', day: 500, month: 10000, sku: 'Place Details Essentials', re: /GetPlace/i },
  { id: 'text', name: '장소 텍스트 검색', day: 150, month: 5000, sku: 'Text Search Pro', re: /SearchText/i },
  { id: 'route', name: '경로 계산', day: 500, month: 10000, sku: 'Compute Routes Essentials', re: /ComputeRoutes/i },
  { id: 'wx', name: '날씨 예보', day: 330, month: null, sku: 'Weather', re: /weather/i },
  { id: 'geo', name: '지오코딩', day: null, month: 10000, sku: 'Geocoding', re: /geocod/i },
];

/** 미국 태평양 시간 기준 오늘 0시 / 이번 달 1일 0시 (구글 할당량·청구 기준) */
export function ptStarts(now = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const off = asUTC - Math.floor(now.getTime() / 1000) * 1000; // PT가 UTC보다 얼마나 앞/뒤인지
  const day = new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - off);
  const month = new Date(Date.UTC(+p.year, +p.month - 1, 1) - off);
  const nextDay = new Date(day.getTime() + 864e5);
  return { day, month, nextDay };
}

/** 하루 단위 시리즈 → [{date:'YYYY-MM-DD'(PT), c:{항목:성공 수}}] (버킷 끝 = PT 자정이라 하루 빼서 날짜) */
export function dailySeries(series = []) {
  const by = {};
  const ptDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  for (const s of series) {
    if (!/^2/.test(s.metric?.labels?.response_code_class || '')) continue;
    const m = METERS.find((x) => x.re.test(`${s.resource?.labels?.service || ''} ${s.resource?.labels?.method || ''}`)); if (!m) continue;
    for (const p of s.points || []) {
      const end = Date.parse(p.interval?.endTime); if (!end) continue;
      const d = ptDate(end - 36e5 * 12); // 버킷 끝(자정)에서 반나절 빼면 그날
      const c = (by[d] ||= {}); c[m.id] = (c[m.id] || 0) + Number(p.value?.int64Value ?? p.value?.doubleValue ?? 0);
    }
  }
  return by;
}

/** Monitoring 응답(timeSeries) → 항목별 {ok, err} 합계 */
export function sumSeries(series = []) {
  const out = {}; const other = {};
  for (const s of series) {
    const svc = s.resource?.labels?.service || '';
    const method = s.resource?.labels?.method || '';
    const cls = s.metric?.labels?.response_code_class || '';
    const n = (s.points || []).reduce((a, p) => a + Number(p.value?.int64Value ?? p.value?.doubleValue ?? 0), 0);
    const m = METERS.find((x) => x.re.test(`${svc} ${method}`));
    const bucket = m ? (out[m.id] ||= { ok: 0, err: 0 }) : (other[`${svc} ${method}`.trim()] ||= { ok: 0, err: 0 });
    if (/^2/.test(cls)) bucket.ok += n; else bucket.err += n;
  }
  return { out, other };
}

function saKey() {
  let raw = process.env.GCP_SA_KEY || '';
  if (!raw) return null;
  if (!raw.trim().startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(raw);
}

async function accessToken(sa) {
  const key = await importPKCS8(sa.private_key, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/monitoring.read' })
    .setProtectedHeader({ alg: 'RS256', kid: sa.private_key_id })
    .setIssuer(sa.client_email).setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!r.ok) throw new Error('token ' + r.status);
  return (await r.json()).access_token;
}

async function requestCounts(tok, project, start, end, period) {
  const secs = period || Math.max(60, Math.ceil((end - start) / 1000));
  const q = new URLSearchParams({
    filter: 'metric.type="serviceruntime.googleapis.com/api/request_count" AND resource.type="consumed_api"',
    'interval.startTime': start.toISOString(), 'interval.endTime': end.toISOString(),
    'aggregation.alignmentPeriod': `${secs}s`, 'aggregation.perSeriesAligner': 'ALIGN_SUM',
    'aggregation.crossSeriesReducer': 'REDUCE_SUM',
  });
  ['resource.labels.service', 'resource.labels.method', 'metric.labels.response_code_class'].forEach((g) => q.append('aggregation.groupByFields', g));
  const all = []; let page = '';
  do {
    if (page) q.set('pageToken', page);
    const r = await fetch(`https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?${q}`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) throw new Error('monitoring ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    all.push(...(j.timeSeries || [])); page = j.nextPageToken || '';
  } while (page);
  return all;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'login' });
    const { payload } = await jwtVerify(token, JWKS, { issuer: `https://securetoken.google.com/${PROJECT}`, audience: PROJECT });
    const email = String(payload.email || '').trim().toLowerCase();
    const h = createHash('sha256').update(email).digest('hex');
    if (payload.email_verified !== true || !ADMIN_HASHES.includes(h)) return res.status(403).json({ error: 'admin' });
  } catch {
    return res.status(401).json({ error: 'login' });
  }
  let sa;
  try { sa = saKey(); } catch { return res.status(500).json({ error: 'badkey' }); }
  if (!sa) return res.status(503).json({ error: 'nokey' });
  try {
    const now = new Date();
    const { day, month, nextDay } = ptStarts(now);
    const tok = await accessToken(sa);
    const project = sa.project_id || PROJECT;
    const from = new Date(day.getTime() - 29 * 864e5);
    const [d, m, hist] = await Promise.all([requestCounts(tok, project, day, now), requestCounts(tok, project, month, now), requestCounts(tok, project, from, day, 86400).catch(() => [])]);
    const today = sumSeries(d); const mon = sumSeries(m);
    // 최근 30일 일자별 (지난 29일 + 오늘 지금까지)
    const byDay = dailySeries(hist);
    const ptDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
    const daily = [];
    for (let k = 29; k >= 1; k--) { const dt = ptDate(day.getTime() - k * 864e5 + 36e5 * 12); daily.push({ date: dt, c: byDay[dt] || {} }); }
    daily.push({ date: ptDate(day.getTime() + 36e5 * 12), c: Object.fromEntries(Object.entries(today.out).map(([k, v]) => [k, v.ok])), today: true });
    const meters = METERS.map((x) => ({
      id: x.id, name: x.name, sku: x.sku, dayCap: x.day, monthFree: x.month,
      today: today.out[x.id]?.ok || 0, todayErr: today.out[x.id]?.err || 0,
      month: mon.out[x.id]?.ok || 0,
    }));
    const other = Object.entries(mon.other).map(([k, v]) => ({ name: k, month: v.ok })).filter((x) => x.month).sort((a, b) => b.month - a.month).slice(0, 8);
    return res.status(200).json({ at: now.toISOString(), resetAt: nextDay.toISOString(), meters, other, daily });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: 'upstream', detail: String(e?.message || e).slice(0, 200) });
  }
}
