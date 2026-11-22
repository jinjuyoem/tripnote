// 사용자별 유료 API 호출 수 세기 (관리자 '사용자별' 탭용 추정치)
// 메모리에서 숫자만 더하고, 몇 분에 한 번 / 앱이 뒤로 갈 때 한 줄로 묶어서 저장 → 앱 무게·쓰기 비용 거의 없음
// 저장 위치: usage/{YYYY-MM (미국 태평양 시간 = 구글 청구 기준)}/users/{uid} = { name, email, at, c: { 항목: 누적 수 } }
import { db, doc, setDoc, increment } from './firebase.js';

// 항목: 이름, 정가(1천 건당 USD, 무료분 넘으면 이 단가) — 단가 모르는 건 null
export const UMETERS = [
  { id: 'map', name: '지도 로드', usd: 7 },
  { id: 'ac', name: '장소 자동완성', usd: 2.83 },
  { id: 'place', name: '장소 상세', usd: 5 },
  { id: 'text', name: '텍스트 검색', usd: 32 },
  { id: 'route', name: '경로 계산', usd: 5 },
  { id: 'geo', name: '지오코딩', usd: 5 },
  { id: 'wx', name: '구글 날씨', usd: null },
  { id: 'flight', name: '항공편 조회', usd: null }, // AeroDataBox (월 400 유닛 무료)
];

let who = null; // { uid, name, email }
let pend = {};
let timer = null;

export function ptMonth(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}`;
}

export function setMeterUser(u) {
  if (who && (!u || u.uid !== who.uid)) flushMeter(); // 로그아웃·계정 바뀌기 전에 남은 것 저장
  who = u ? { uid: u.uid, name: u.displayName || '', email: (u.email || '').toLowerCase() } : null;
}

export function bump(id, n = 1) {
  if (!who) return; // 로그인 안 한 공유 링크 보기 등은 안 셈
  pend[id] = (pend[id] || 0) + n;
  if (!timer) timer = setTimeout(flushMeter, 3 * 60e3);
}

export function flushMeter() {
  clearTimeout(timer); timer = null;
  const keys = Object.keys(pend);
  if (!who || !keys.length) return;
  const c = {}; for (const k of keys) c[k] = increment(pend[k]);
  pend = {};
  // 오프라인이면 로컬에 쌓였다가 연결되면 올라감. 기다리지 않음
  setDoc(doc(db, 'usage', ptMonth(), 'users', who.uid), { name: who.name, email: who.email, at: Date.now(), c }, { merge: true })
    .catch((e) => console.warn('meter', e?.code || e));
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushMeter(); });
  addEventListener('pagehide', flushMeter);
}
