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
