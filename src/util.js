export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2));
export const randCode = (n = 12) => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; const r = crypto.getRandomValues(new Uint8Array(n)); return [...r].map((x) => a[x % a.length]).join(''); };
export const won = (n) => Math.round(n).toLocaleString('ko-KR') + '원';
export const num = (n) => (Math.round(n * 100) / 100).toLocaleString('ko-KR');
export const WD = ['일', '월', '화', '수', '목', '금', '토'];
export const parseD = (s) => { if (!s) return null; const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
export const fmtD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const md = (s) => { const d = parseD(s); return d ? `${d.getMonth() + 1}.${d.getDate()} (${WD[d.getDay()]})` : ''; };
export const hm = (dt) => (dt && dt.length >= 16 ? dt.slice(11, 16) : '');

export function tripDays(t) {
  const a = parseD(t.start), b = parseD(t.end) || a;
  if (!a) return ['day1'];
  const out = [];
  for (let d = new Date(a); d <= b && out.length < 60; d.setDate(d.getDate() + 1)) out.push(fmtD(d));
  return out.length ? out : [t.start];
}
export function dday(t) {
  const a = parseD(t.start); if (!a) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const b = parseD(t.end) || a;
  const diff = Math.round((a - today) / 864e5);
  if (diff > 0) return 'D-' + diff;
  if (today <= b) return '여행중';
  return '완료';
}

export const ICATS = { 관광: ['#EBF2FF', '#2F6BFF'], 맛집: ['#FFEDE8', '#F0532D'], 카페: ['#F6EFE7', '#A0612B'], 쇼핑: ['#F7EBFB', '#A23ED1'], 숙소: ['#E6F7EF', '#0A9E62'], 이동: ['#EEF1F4', '#4E5968'], 기타: ['#F2F4F6', '#8B95A1'] };
export const ECATS = { 식비: '#F0532D', 교통: '#2F6BFF', 숙소: '#0A9E62', 쇼핑: '#A23ED1', 관광: '#F5A623', 항공: '#191F28', 기타: '#8B95A1' };
export const DAYCOLORS = ['#2F6BFF', '#F0532D', '#0A9E62', '#A23ED1', '#F5A623', '#00A3BF', '#E5398B', '#5B5FC7'];
// 엔화·동·루피아는 100단위로 환율을 보는 게 익숙해서 입력/표시를 100단위로
export const rateUnit = (cur) => (['JPY', 'VND', 'IDR'].includes(cur) ? 100 : 1);
export const MOVES = { walk: ['🚶', '도보', 'WALK', 'walking'], transit: ['🚇', '대중교통', 'TRANSIT', 'transit'], drive: ['🚗', '차', 'DRIVE', 'driving'], bike: ['🚲', '자전거', 'BICYCLE', 'bicycling'] };
export function fmtDur(secs) {
  const m = Math.max(1, Math.round(secs / 60));
  return m >= 60 ? `${Math.floor(m / 60)}시간${m % 60 ? ' ' + (m % 60) + '분' : ''}` : `${m}분`;
}
export const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)}km` : `${Math.round(m)}m`);

/** 사진을 줄여서 dataURL로 (Firestore 문서 1MB 제한 안에 들어가게) */
export async function compressImage(file, max = 1100, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    let { width: w, height: h } = img;
    const s = Math.min(1, max / Math.max(w, h)); w = Math.round(w * s); h = Math.round(h * s);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
    let out = c.toDataURL('image/jpeg', quality);
    if (out.length > 850000) out = c.toDataURL('image/jpeg', 0.6);
    return out;
  } finally { URL.revokeObjectURL(url); }
}

export const CURRENCIES =['KRW', 'JPY', 'USD', 'EUR', 'HKD', 'TWD', 'THB', 'VND', 'CNY', 'SGD', 'PHP', 'GBP', 'AUD', 'MYR', 'IDR'];

let toastTimer;
export function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 2400);
}
export async function copy(text, okMsg = '복사했어요') {
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch { toast('복사가 막혀 있어요. 길게 눌러 직접 복사해 주세요.'); }
}

/* ---------- 중국 본토 → 고덕지도(Amap) 링크 ---------- */
// 대략적인 중국 본토 윤곽 [경도, 위도]. 홍콩·마카오는 아래에서 따로 뺌, 대만·한반도·몽골·베트남은 윤곽 밖.
const CN_POLY = [[73.6,39.4],[76.9,41.0],[80.2,42.2],[80.0,44.9],[82.3,45.5],[83.0,47.2],[85.5,47.1],[85.6,48.1],[87.3,49.1],[88.1,48.6],[90.1,47.9],[91.0,46.8],[90.9,45.3],[93.5,45.0],[95.4,44.3],[96.4,42.7],[101.8,42.5],[106.8,42.3],[110.4,42.7],[111.9,43.7],[113.6,44.8],[116.0,45.7],[117.4,46.6],[119.0,46.5],[119.8,47.0],[118.0,47.8],[115.4,47.7],[116.6,49.9],[117.8,49.5],[120.8,53.3],[123.5,53.6],[125.2,52.9],[127.5,49.8],[130.8,48.9],[132.6,47.7],[134.8,48.3],[133.0,45.0],[131.2,44.9],[131.3,43.4],[130.6,42.4],[129.7,42.4],[128.2,41.4],[126.0,41.4],[124.4,39.9],[122.4,39.2],[121.6,38.4],[122.7,37.4],[120.9,33.5],[122.3,31.0],[122.0,29.5],[120.5,27.5],[119.8,26.5],[119.0,25.0],[117.5,23.5],[116.0,22.7],[113.4,21.9],[111.5,21.2],[111.5,18.0],[107.9,18.0],[108.0,21.5],[106.6,22.4],[104.0,22.8],[102.0,22.4],[101.0,21.2],[99.0,22.0],[97.5,24.0],[98.5,25.5],[97.0,28.2],[94.0,29.2],[92.0,27.8],[89.0,28.0],[88.0,27.9],[85.0,28.3],[81.0,30.2],[78.8,31.0],[79.5,32.5],[77.8,35.5],[74.9,37.2]];
const NOT_CN_BOX = [[113.82, 22.13, 114.05, 22.47], [114.05, 22.13, 114.45, 22.515], [113.52, 22.1, 113.6, 22.215]]; // 홍콩(서·동), 마카오
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** 중국 본토 장소인지 (주소 글자 먼저, 없으면 좌표) */
export function inChina(p) {
  const a = (p && (p.address || '')) + '';
  if (/홍콩|마카오|대만|타이완|Hong Kong|Macau|Macao|Taiwan|香港|澳門|澳门|台灣|台湾/i.test(a)) return false;
  if (/중국|China|中国/i.test(a)) return true;
  if (!p || p.lat == null || p.lng == null) return false;
  const x = +p.lng, y = +p.lat;
  if (NOT_CN_BOX.some(([x1, y1, x2, y2]) => x >= x1 && x <= x2 && y >= y1 && y <= y2)) return false;
  return inPoly(x, y, CN_POLY);
}
const AMAP_MODE = { walk: 'walk', transit: 'bus', drive: 'car', bike: 'ride' };
const aq = (o) => Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v).replace(/%2C/g, ',')).join('&');
// 구글맵의 중국 본토 좌표는 고덕과 같은 GCJ-02라서 coordinate=gaode
export const amapPlaceUrl = (p, city = '') => (p.lat != null && p.lng != null
  ? 'https://uri.amap.com/marker?' + aq({ position: `${p.lng},${p.lat}`, name: p.title || p.name || '', src: 'shoong', coordinate: 'gaode', callnative: 1 })
  : 'https://uri.amap.com/search?' + aq({ keyword: p.title || p.name || '', city, src: 'shoong', callnative: 1 }));
export const amapDirUrl = (from, to, m) => 'https://uri.amap.com/navigation?' + aq({
  from: `${from.lng},${from.lat},${from.title || from.name || '출발'}`, to: `${to.lng},${to.lat},${to.title || to.name || '도착'}`,
  mode: AMAP_MODE[m] || 'bus', policy: 1, src: 'shoong', coordinate: 'gaode', callnative: 1,
});
