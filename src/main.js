import './style.css';
import {
  auth, db, login, logout, watchAuth, reauth, deleteMe,
  collection, doc, query, where, onSnapshot, setDoc, updateDoc, deleteDoc,
  getDoc, arrayUnion, writeBatch, getDocs, deleteField,
} from './firebase.js';
import { createMap, mountPlaceSearch, mapsEnabled, computeRoute, geocodeAirport } from './maps.js';
import { tripWeather, geocodeCity } from './weather.js';
import { openTimeWheel, timeField, wireTimeFields } from './timewheel.js';
import {
  esc, uid, randCode, won, num, md, hm, parseD, fmtD, tripDays, dday,
  ICATS, ECATS, DAYCOLORS, CURRENCIES, toast, copy,
  rateUnit, MOVES, fmtDur, fmtDist, compressImage,
} from './util.js';

/* ---------------- state ---------------- */
const S = {
  user: null, authReady: false,
  trips: [], tripsLoaded: false,
  tripId: null, items: [], expenses: [], flights: [], places: [], wishCat: 'all', ordering: false,
  tab: 'plan', day: null, mapAll: false,
  unsubTrips: null, unsubSub: [], unsubMe: null,
  profiles: new Map(), // uid -> {name, photo}
  weather: {}, weatherFor: null,
};
const DELETE_FLAG = 'tn_pending_delete';
const params = new URLSearchParams(location.search);
let pendingJoin = params.get('join');

const $ = (id) => document.getElementById(id);
const trip = () => S.trips.find((t) => t.id === S.tripId);
const me = () => S.profiles.get(S.user?.uid)?.name || S.user?.displayName || S.user?.email?.split('@')[0] || '나';

/* 프로필 사진: 직접 올린 사진 > 구글 사진 > 이름 첫 글자 */
const AV_COLORS = ['#E2552D', '#2D6BE2', '#2F7D5B', '#9B3A93', '#D79A16', '#0E8A9A'];
function avatar(uid, size = 32, fallbackName = '') {
  const p = S.profiles.get(uid) || {};
  const name = p.name || (uid === S.user?.uid ? me() : fallbackName) || '?';
  const photo = p.photo || (uid === S.user?.uid && !p.noGooglePhoto ? S.user.photoURL : null);
  const col = AV_COLORS[[...uid].reduce((s, c) => s + c.charCodeAt(0), 0) % AV_COLORS.length];
  return photo
    ? `<img class="av" src="${esc(photo)}" alt="${esc(name)}" style="width:${size}px;height:${size}px" referrerpolicy="no-referrer">`
    : `<span class="av" style="width:${size}px;height:${size}px;background:${col};font-size:${Math.round(size * 0.42)}px">${esc([...name][0] || '?')}</span>`;
}
const nameOf = (t, uid) => S.profiles.get(uid)?.name || t?.memberNames?.[uid] || '알 수 없음';
/** 이름 목록을 칩으로 (앱 참여자면 프로필 사진도) */
function peopleChips(t, names) {
  const byName = {}; Object.entries(t?.memberNames || {}).forEach(([u, n]) => { byName[n] = u; byName[S.profiles.get(u)?.name || n] = u; });
  return names.map((n) => `<span class="pchip">${byName[n] ? avatar(byName[n], 18, n) : ''}${esc(n)}</span>`).join('');
}
/** 탑승자 이름 목록 (예전 항공권은 등록한 사람) */
const flightWho = (t, f) => (f.who && f.who.length ? f.who : f.by && t?.memberNames?.[f.by] ? [nameOf(t, f.by)] : []);
/** 탑승자: 큰 프로필 사진 + 이름 */
function paxList(t, names) {
  const byName = {}; Object.entries(t?.memberNames || {}).forEach(([u, n]) => { byName[n] = u; byName[S.profiles.get(u)?.name || n] = u; });
  return names.map((n) => `<span class="pax">${byName[n] ? avatar(byName[n], 34, n) : `<span class="av" style="width:34px;height:34px;background:#8C8778;font-size:14px">${esc([...n][0] || '?')}</span>`}<b>${esc(n)}</b></span>`).join('');
}
async function loadProfiles(uids) {
  const need = uids.filter((u) => !S.profiles.has(u));
  if (!need.length) return;
  await Promise.all(need.map(async (u) => {
    try { const s = await getDoc(doc(db, 'users', u)); S.profiles.set(u, s.exists() ? s.data() : {}); }
    catch { S.profiles.set(u, {}); }
  }));
  render();
}

/* ---------------- shell ---------------- */
document.querySelector('#app').innerHTML = `
  <header id="hdr"></header>
  <div id="banner"></div>
  <div id="mapwrap" hidden>
    <div id="map"></div>
    <div class="mapbar">
      <button id="mapToggle" class="mapbtn"></button>
      <a id="routeLink" class="mapbtn" target="_blank" rel="noopener">구글맵 길찾기</a>
    </div>
  </div>
  <main id="view"></main>
  <div id="fabhost"></div>`;

let mapCtl = null; let mapInitP = null;
async function ensureMap() {
  if (!mapsEnabled) return null;
  if (!mapInitP) mapInitP = createMap($('map')).then((c) => (mapCtl = c)).catch((e) => { console.error(e); return null; });
  return mapInitP;
}
$('mapToggle').onclick = () => { S.mapAll = !S.mapAll; render(); };

/* ---------------- auth ---------------- */
watchAuth(async (u) => {
  S.user = u; S.authReady = true;
  S.unsubTrips?.(); S.unsubSub.forEach((f) => f()); S.unsubSub = []; S.unsubMe?.();
  S.trips = []; S.tripsLoaded = false; S.tripId = null;
  if (u && localStorage.getItem(DELETE_FLAG)) { localStorage.removeItem(DELETE_FLAG); render(); return doDeleteAccount(); }
  if (u) {
    S.unsubMe = onSnapshot(doc(db, 'users', u.uid), (s) => { S.profiles.set(u.uid, s.exists() ? s.data() : {}); render(); }, () => {});
    S.unsubTrips = onSnapshot(
      query(collection(db, 'trips'), where('members', 'array-contains', u.uid)),
      (snap) => {
        S.trips = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        S.tripsLoaded = true;
        if (S.tripId && !trip()) openTrip(null); else render();
      },
      (err) => { console.error(err); S.tripsLoaded = true; toast('여행 목록을 불러오지 못했어요'); render(); },
    );
    if (pendingJoin) joinTrip(pendingJoin);
  }
  render();
});

async function joinTrip(code) {
  pendingJoin = null;
  history.replaceState(null, '', location.pathname);
  try {
    const inv = await getDoc(doc(db, 'invites', code));
    if (!inv.exists()) { toast('초대 링크가 만료됐거나 잘못됐어요'); return; }
    const tripId = inv.data().tripId;
    await updateDoc(doc(db, 'trips', tripId), {
      members: arrayUnion(S.user.uid),
      [`memberNames.${S.user.uid}`]: me(),
      lastJoinCode: code,
    });
    toast('여행에 참여했어요!');
    S.tripId = tripId; S.tab = 'plan'; openTrip(tripId);
  } catch (e) {
    console.error(e);
    toast('참여하지 못했어요. 이미 참여 중이거나 링크가 잘못됐어요.');
  }
}

/* ---------------- subscriptions ---------------- */
function openTrip(id) {
  S.unsubSub.forEach((f) => f()); S.unsubSub = [];
  S.items = []; S.expenses = []; S.flights = []; S.places = [];
  S.tripId = id; S.day = null; S.mapAll = false; S.ordering = false; S.viewAs = null; S.wishCat = 'all';
  if (id) {
    const sub = (name) => onSnapshot(collection(db, 'trips', id, name), (s) => {
      S[name] = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (name === 'items') { const tt = trip(); if (tt) normalizePositions(tt); }
      render();
    }, (e) => console.error(name, e));
    S.unsubSub.push(sub('items'), sub('expenses'), sub('flights'), sub('places'));
    const t = trip(); if (t) loadProfiles(t.members || []);
  }
  render(); window.scrollTo(0, 0);
}

async function write(fn) {
  try { await fn(); } catch (e) {
    console.error(e);
    toast(e?.code === 'permission-denied' ? '권한이 없어요' : '저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
}

/* ---------------- icons ---------------- */
const I = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  plane: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
};

/* ---------------- render ---------------- */
function render() {
  const t = trip();
  if (!S.authReady) { $('hdr').innerHTML = ''; $('view').innerHTML = '<div class="empty">불러오는 중…</div>'; return showMap(false); }
  if (!S.user) return viewLogin();
  if (S.tripId && t) viewTrip(t); else viewHome();
}

function viewLogin() {
  showMap(false); $('hdr').innerHTML = ''; $('fabhost').innerHTML = ''; $('banner').innerHTML = '';
  $('view').innerHTML = `
    <div class="login">
      <div class="logo">${I.plane}</div>
      <h1>여행노트</h1>
      <p class="muted">일정·지도·항공권·가계부를 한 곳에서.<br>동행인과 같이 보고 같이 고쳐요.</p>
      ${pendingJoin ? '<p class="invite-note">초대받은 여행이 있어요. 로그인하면 바로 참여돼요.</p>' : ''}
      <button class="btn pri block" id="loginBtn">Google로 시작하기</button>
    </div>`;
  $('loginBtn').onclick = () => login().catch((e) => { console.error(e); toast('로그인하지 못했어요'); });
}

function viewHome() {
  showMap(false); $('banner').innerHTML = '';
  $('hdr').innerHTML = `<h1>여행노트</h1><button class="avbtn" data-act="account" aria-label="내 프로필">${avatar(S.user.uid, 38)}</button>`;
  const list = [...S.trips].sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  const up = list.filter((t) => dday(t) !== '완료'), past = list.filter((t) => dday(t) === '완료');
  const card = (t) => `<button class="ticket" data-act="open" data-id="${esc(t.id)}">
      <div style="min-width:0"><div class="city">${esc(t.city || 'TRIP')}</div><div class="name">${esc(t.name)}</div>
      <div class="small muted">${t.start ? esc(md(t.start)) + (t.end && t.end !== t.start ? ' – ' + esc(md(t.end)) : '') : '날짜 미정'} · ${(t.members || []).length}명 참여</div></div>
      <div class="dd"><b>${esc(dday(t) || '—')}</b><span class="small muted">${esc(t.currency || 'KRW')}</span></div></button>`;
  $('view').innerHTML = `<div class="wrap">${
    !S.tripsLoaded ? '<div class="empty">불러오는 중…</div>'
      : list.length ? up.map(card).join('') + (past.length ? `<div class="dategrp">지난 여행</div>${past.map(card).join('')}` : '')
        : '<div class="empty"><b>아직 여행이 없어요</b>첫 여행을 만들어 일정과 가계부를 시작해 보세요.</div>'
  }</div>`;
  $('fabhost').innerHTML = `<button class="btn pri fab" data-act="newTrip">${I.plane} 새 여행</button>`;
}

function viewTrip(t) {
  const days = tripDays(t);
  if (!S.day || !days.includes(S.day)) { const today = fmtD(new Date()); S.day = days.includes(today) ? today : days[0]; }
  $('hdr').innerHTML = `<button class="iconbtn" data-act="home" aria-label="뒤로">${I.back}</button><h1>${esc(t.name)}</h1>
    <button class="iconbtn" data-act="editTrip" aria-label="설정">${I.gear}</button>`;
  $('banner').innerHTML = '';
  const tabs = [['plan', '일정'], ['wish', '찜'], ['flight', '항공'], ['money', '가계부'], ['settle', '정산']];
  let body = '';
  if (S.tab === 'plan') body = viewPlan(t, days);
  else if (S.tab === 'wish') body = viewWish(t);
  else if (S.tab === 'flight') body = viewFlights(t);
  else if (S.tab === 'money') body = viewMoney(t);
  else body = viewSettle(t);
  $('view').innerHTML = `<div class="wrap">
    <div class="tripmeta">
      ${t.city ? `<span class="chip">📍 ${esc(t.city)}</span>` : ''}
      ${t.start ? `<span class="chip">${esc(md(t.start))}${t.end && t.end !== t.start ? ' – ' + esc(md(t.end)) : ''}</span>` : ''}
      ${dday(t) ? `<span class="chip accent">${esc(dday(t))}</span>` : ''}
      ${dday(t) === '완료' ? '<button class="chip recapchip" data-act="recap">🎞 여행 리캡</button>' : ''}
      <button class="avstack" data-act="editTrip" aria-label="참여자">${(t.members || []).slice(0, 5).map((u) => avatar(u, 26, t.memberNames?.[u])).join('')}${(t.members || []).length > 5 ? `<span class="av more">+${t.members.length - 5}</span>` : ''}</button>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${S.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}">${l}</button>`).join('')}</div>
    ${body}</div>`;
  const fab = { plan: ['newItem', '+ 일정 추가'], wish: ['newWish', '+ 찜하기'], flight: ['newFlight', '+ 항공권 추가'], money: ['newExp', '+ 지출 추가'] }[S.tab];
  $('fabhost').innerHTML = fab && !(S.tab === 'plan' && S.ordering) ? `<button class="btn pri fab" data-act="${fab[0]}">${fab[1]}</button>` : '';
  if (S.tab === 'plan') { drawPlanMap(t, days); ensureAirportGeo(t); fillSegments(t); loadWeather(t, days); }
  else if (S.tab === 'wish') drawWishMap(t);
  else showMap(false);
  if (S.tab === 'flight') loadQrThumbs(t);
}

/* ---------- plan ---------- */
// 정렬: 사용자가 정한 순서(pos)가 우선. 시간은 새 일정을 처음 넣을 자리를 정할 때만 사용
const ordOf = (i) => (i.order ?? i.createdAt ?? 0);
// 예전 데이터(pos 없음)용 정렬
const sortKey = (i) => (i.time ? [i.time, 0, ordOf(i)] : [i.after ?? '99:99', 1, ordOf(i)]);
function legacyCmp(a, b) { const x = sortKey(a), y = sortKey(b); return x[0].localeCompare(y[0]) || x[1] - y[1] || x[2] - y[2]; }
function dayItems(d) {
  const list = S.items.filter((i) => i.date === d);
  return list.every((i) => typeof i.pos === 'number') ? list.sort((a, b) => a.pos - b.pos) : list.sort(legacyCmp);
}
/** 예전 일정에 순서값(pos) 한 번 채워주기 */
let normTimer = null;
function normalizePositions(t) {
  clearTimeout(normTimer);
  normTimer = setTimeout(() => {
    const days = [...new Set(S.items.map((i) => i.date))];
    for (const d of days) {
      const list = S.items.filter((i) => i.date === d);
      if (list.every((i) => typeof i.pos === 'number')) continue;
      const sorted = [...list].sort((a, b) => (typeof a.pos === 'number' && typeof b.pos === 'number' ? a.pos - b.pos : legacyCmp(a, b)));
      sorted.forEach((i, k) => { i.pos = (k + 1) * 1000; updateDoc(doc(db, 'trips', t.id, 'items', i.id), { pos: i.pos }).catch(() => {}); });
    }
  }, 300);
}
/** 새 일정이 들어갈 자리: 시간이 있으면 그 시간보다 늦은 첫 일정 앞, 없으면 맨 뒤 */
function insertPos(d, time, excludeId) {
  const list = dayItems(d).filter((i) => i.id !== excludeId);
  const posOf = (i, k) => (typeof i.pos === 'number' ? i.pos : (k + 1) * 1000);
  if (!list.length) return 1000;
  let k = list.length;
  if (time) { const j = list.findIndex((i) => i.time && i.time > time); if (j >= 0) k = j; }
  const prev = k > 0 ? posOf(list[k - 1], k - 1) : null, next = k < list.length ? posOf(list[k], k) : null;
  if (prev == null) return next - 1000;
  if (next == null) return prev + 1000;
  return (prev + next) / 2;
}

/** 드래그로 옮긴 결과(새 순서의 id 목록) 저장 — 순서가 시간보다 우선 */
async function placeItem(t, id, newIds) {
  const all = dayItems(S.day); const m = all.find((i) => i.id === id); if (!m) return;
  const order = newIds.map((x) => all.find((i) => i.id === x)).filter(Boolean);
  // 순서값이 없는 예전 일정이 섞여 있으면 화면 순서대로 먼저 채움
  if (!order.every((i) => typeof i.pos === 'number')) {
    order.forEach((i, k) => { i.pos = (k + 1) * 1000; });
    render();
    return write(async () => { for (const i of order) await updateDoc(doc(db, 'trips', t.id, 'items', i.id), { pos: i.pos }); });
  }
  const k = order.findIndex((i) => i.id === id);
  const P = order[k - 1], N = order[k + 1];
  const pos = P && N ? (P.pos + N.pos) / 2 : P ? P.pos + 1000 : N ? N.pos - 1000 : 1000;
  if (pos === m.pos) return;
  m.pos = pos; render();
  write(() => updateDoc(doc(db, 'trips', t.id, 'items', m.id), { pos }));
}

/* 드래그: 손잡이(≡)를 잡고 위아래로 */
document.addEventListener('pointerdown', (ev) => {
  const h = ev.target.closest('.draghandle'); if (!h) return;
  const card = h.closest('[data-drag]'); const box = card?.parentElement; if (!card || !box) return;
  ev.preventDefault();
  const t = trip(); const id = card.dataset.drag;
  const startY = ev.clientY; let lastY = startY; let raf = 0;
  card.classList.add('dragging'); h.setPointerCapture?.(ev.pointerId);
  const rect = card.getBoundingClientRect();
  const ph = document.createElement('div'); ph.className = 'dragph'; ph.style.height = rect.height + 'px';
  card.after(ph);
  // 카드를 화면에 띄워서 손가락을 따라오게
  Object.assign(card.style, { position: 'fixed', top: rect.top + 'px', left: rect.left + 'px', width: rect.width + 'px', zIndex: 30, margin: 0 });
  const move = (e) => {
    lastY = e.clientY;
    card.style.transform = `translateY(${lastY - startY}px)`;
    // 자리 찾기: 다른 카드들의 가운데와 비교
    const others = [...box.querySelectorAll('[data-drag]')].filter((x) => x !== card);
    let placed = false;
    for (const o of others) {
      const r = o.getBoundingClientRect();
      if (lastY < r.top + r.height / 2) { if (ph.nextElementSibling !== o) o.before(ph); placed = true; break; }
    }
    if (!placed && others.length) { const lastEl = others[others.length - 1]; if (lastEl.nextElementSibling !== ph) lastEl.after(ph); }
    // 화면 끝에 가면 자동 스크롤
    cancelAnimationFrame(raf);
    const edge = 70; const vh = window.innerHeight;
    if (lastY > vh - edge || lastY < edge) {
      const step = () => { window.scrollBy(0, lastY > vh - edge ? 8 : -8); raf = requestAnimationFrame(step); };
      raf = requestAnimationFrame(step);
    }
  };
  const up = () => {
    cancelAnimationFrame(raf);
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
    ph.replaceWith(card); card.classList.remove('dragging');
    Object.assign(card.style, { transform: '', position: '', top: '', left: '', width: '', zIndex: '', margin: '' });
    const ids = [...box.querySelectorAll('[data-drag]')].map((x) => x.dataset.drag);
    placeItem(t, id, ids);
  };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
});
function dayFlights(d) {
  const out = [];
  S.flights.forEach((f) => {
    if (f.depAt?.slice(0, 10) === d) out.push({ ...f, _kind: 'dep', time: hm(f.depAt) });
    if (f.arrAt?.slice(0, 10) === d) out.push({ ...f, _kind: 'arr', time: hm(f.arrAt) });
  });
  return out;
}
const placeUrl = (t, i) => i.placeId
  ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(i.title)}&query_place_id=${encodeURIComponent(i.placeId)}`
  : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(i.title + (t.city ? ' ' + t.city : ''));
const ll = (i) => (i.lat != null && i.lng != null ? `${i.lat},${i.lng}` : null);
function routeUrl(t, items) {
  const pts = items.filter((i) => i.cat !== '이동').map((i) => ll(i) || i.title + (t.city ? ' ' + t.city : ''));
  if (pts.length < 2) return null;
  const o = pts[0], d = pts[pts.length - 1], w = pts.slice(1, -1).slice(0, 8);
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}${w.length ? '&waypoints=' + encodeURIComponent(w.join('|')) : ''}&travelmode=transit`;
}

/** 그날 화면에 나오는 줄(일정 + 항공편) */
function planRows(d) {
  const rows = dayItems(d).map((i) => ({ kind: 'item', time: i.time, i }));
  // 항공편 줄은 '그 시간 이하인 마지막 시간 있는 일정' 바로 뒤에 (없으면 맨 위)
  [...dayFlights(d)].sort((a, b) => (a.time || '').localeCompare(b.time || '')).forEach((f) => {
    let at = 0;
    rows.forEach((r, k) => { if (r.time && f.time && r.time <= f.time) at = k + 1; });
    rows.splice(at, 0, { kind: 'flight', time: f.time, f });
  });
  return rows;
}
/** 이동 구간 계산용 지점: 위치 있는 일정 + 공항(도착/출발) */
function rowStop(r) {
  if (r.kind === 'item') {
    const i = r.i; if (!ll(i)) return null;
    return { id: i.id, lat: i.lat, lng: i.lng, time: i.time, title: i.title, move: i.move, moveMode: i.moveMode, _col: 'items', _doc: i.id, _mk: 'move', _mmk: 'moveMode' };
  }
  const f = r.f; const dep = f._kind === 'dep'; const g = dep ? f.depGeo : f.arrGeo;
  if (!g) return null;
  return {
    id: `${f.id}~${f._kind}`, lat: g.lat, lng: g.lng, time: r.time, title: `${dep ? f.from : f.to} 공항`, air: f._kind,
    move: dep ? f.moveDep : f.moveArr, moveMode: dep ? f.moveModeDep : f.moveModeArr,
    _col: 'flights', _doc: f.id, _mk: dep ? 'moveDep' : 'moveArr', _mmk: dep ? 'moveModeDep' : 'moveModeArr',
  };
}
/** 정산·동행 인원 = 초대 링크로 참여한 사람 */
const peopleOf = (t) => {
  const n = [...new Set((t?.members || []).map((u) => t.memberNames?.[u] || nameOf(t, u)).filter(Boolean))];
  return n.length ? n : [me()];
};
const myName = (t) => t?.memberNames?.[S.user?.uid] || me();
/** 이 줄에 가는 사람들 (따로 지정 없으면 다 같이) */
function rowWho(t, r) {
  const people = peopleOf(t);
  const w = ((r.kind === 'item' ? r.i.who : r.f.who) || []).filter((n) => people.includes(n));
  return w.length ? w : people;
}
/** 일부만 가는 줄인지 (따로 다니는 시간) */
function isPartialRow(t, r) {
  const people = peopleOf(t); if (people.length < 2) return false;
  return rowWho(t, r).length < people.length;
}
/** 지점 목록을 이어서 구간 [from, to] — 비행 중인 구간은 제외 */
function chainSegs(stops) {
  const out = []; let prev = null;
  for (const st of stops) {
    if (!st) continue;
    if (prev && !(prev.air === 'dep' || st.air === 'arr')) out.push([prev, st]);
    prev = st;
  }
  return out;
}
/** 한 사람 기준 그날 동선 구간 */
function personSegments(d, p) {
  const t = trip();
  return chainSegs(planRows(d).filter((r) => rowWho(t, r).includes(p)).map(rowStop));
}
/** 갈래 칸 나누기: 일정이 똑같은 사람끼리는 한 칸으로 묶음 */
function forkLanes(t, grp) {
  const lanes = [];
  for (const p of peopleOf(t)) {
    const mine = grp.filter((r) => rowWho(t, r).includes(p));
    const sig = mine.map((r) => (r.kind === 'item' ? r.i.id : r.f.id + r.f._kind)).join(',');
    const ex = lanes.find((l) => l.sig === sig);
    if (ex) ex.names.push(p); else lanes.push({ sig, names: [p], rows: mine });
  }
  return lanes;
}
/** 화면 배치: 같이 다니는 줄 / 갈래 묶음 + 각 구간 */
function planLayout(t, rows) {
  const blocks = []; const segs = [];
  let lastCommon = null;
  for (let k = 0; k < rows.length;) {
    const r = rows[k];
    if (!isPartialRow(t, r)) {
      const st = rowStop(r); let seg = null;
      if (st) { if (lastCommon && !(lastCommon.air === 'dep' || st.air === 'arr')) seg = [lastCommon, st]; lastCommon = st; }
      if (seg) segs.push(seg);
      blocks.push({ kind: 'row', r, seg });
      k++; continue;
    }
    let j = k; while (j < rows.length && isPartialRow(t, rows[j])) j++;
    const grp = rows.slice(k, j);
    // 갈래 끝나고 처음 만나는 위치 있는 같이 일정 (다음 갈래 전까지)
    let nextStop = null;
    for (let q = j; q < rows.length && !isPartialRow(t, rows[q]); q++) { const s = rowStop(rows[q]); if (s) { nextStop = s; break; } }
    const lanes = forkLanes(t, grp).map((l) => {
      const stops = l.rows.map(rowStop).filter(Boolean);
      const ls = stops.length ? chainSegs([lastCommon, ...stops, nextStop]) : [];
      segs.push(...ls);
      const into = new Map(ls.map((s) => [s[1].id, s]));
      const toNext = nextStop ? ls.find((s) => s[1] === nextStop) : null;
      return { ...l, into, toNext };
    });
    blocks.push({ kind: 'fork', grp, lanes, next: rows[j] });
    lastCommon = null; // 다음 같이 일정까지는 갈래 칸에서 이동 시간 표시
    k = j;
  }
  return { blocks, segs };
}
/** 화면/요약에 쓰는 구간 (기본: 같이 + 갈래, 사람 보기: 그 사람 동선) */
function daySegments(d, who) {
  const t = trip();
  if (who) return personSegments(d, who);
  return planLayout(t, planRows(d)).segs;
}
/** 항공편 공항 좌표가 없으면 찾아서 저장 (한 번만) */
const airTried = new Set();
function ensureAirportGeo(t) {
  if (!mapsEnabled) return;
  for (const f of S.flights) {
    for (const [code, field] of [[f.from, 'depGeo'], [f.to, 'arrGeo']]) {
      if (!code || (f[field] && f[field].code === code)) continue;
      const k = `${f.id}|${field}|${code}`; if (airTried.has(k)) continue; airTried.add(k);
      geocodeAirport(code).then((g) => { if (g) { f[field] = g; updateDoc(doc(db, 'trips', t.id, 'flights', f.id), { [field]: g }).catch(() => {}); render(); } }).catch(() => {});
    }
  }
}
const stopMap = new Map(); // 화면에 있는 구간 id(from>to) → {from, to} (수단 변경 저장용)
const sidOf = (a, b) => `${a.id}>${b.id}`;
let shownSegs = [];
const rowIdOf = (r) => (r.kind === 'item' ? r.i.id : `${r.f.id}~${r.f._kind}`);
function nameAvatar(t, n, size = 22) {
  const u = (t.members || []).find((x) => t.memberNames?.[x] === n || S.profiles.get(x)?.name === n);
  return u ? avatar(u, size, n) : `<span class="av" style="width:${size}px;height:${size}px;background:#8C8778;font-size:${Math.round(size * 0.45)}px">${esc([...n][0] || '?')}</span>`;
}
/** 누구 일정 보기 버튼 */
function viewAsBtns(t, cur) {
  return `<div class="vabtns">${cur ? '<button class="vab" data-act="viewAs" data-v="">👥 전체</button>' : ''}${peopleOf(t).map((p) => `<button class="vab ${p === cur ? 'on' : ''}" data-act="viewAs" data-v="${esc(p)}">${nameAvatar(t, p, 18)}${esc(p)} 일정</button>`).join('')}</div>`;
}

function viewPlan(t, days) {
  const people = peopleOf(t);
  if (S.viewAs && !people.includes(S.viewAs)) S.viewAs = null;
  const va = S.ordering ? null : S.viewAs;
  const items = dayItems(S.day);
  const allRows = planRows(S.day);
  const hasFork = people.length > 1 && allRows.some((r) => isPartialRow(t, r));
  let n = 0;
  const pinNo = new Map(); items.forEach((i) => { if (ll(i)) pinNo.set(i.id, ++n); });
  stopMap.clear(); shownSegs = [];
  const rowHtml = (r, seg) => (seg ? segRow(t, seg[0], seg[1]) : '') + (r.kind === 'flight' ? flightRow(r.f) : itemRow(t, r.i, pinNo.get(r.i.id), items));
  let body = '';
  if (S.ordering) body = allRows.map((r) => rowHtml(r, null)).join('');
  else if (va) {
    const rows = allRows.filter((r) => rowWho(t, r).includes(va));
    shownSegs = chainSegs(rows.map(rowStop));
    const into = new Map(shownSegs.map((s) => [s[1].id, s]));
    body = rows.map((r) => rowHtml(r, into.get(rowIdOf(r)))).join('');
  } else {
    const L = planLayout(t, allRows); shownSegs = L.segs;
    body = L.blocks.map((b) => (b.kind === 'row' ? rowHtml(b.r, b.seg) : forkHtml(t, b, pinNo))).join('');
  }
  const W = S.weatherFor === t.id ? S.weather : {};
  const wx = W[S.day];
  return `<div class="days">${days.map((d, idx) => {
    const c = dayItems(d).length; const w = W[d];
    return `<button class="day ${d === S.day ? 'on' : ''}" data-act="day" data-v="${esc(d)}" style="--dc:${DAYCOLORS[idx % DAYCOLORS.length]}"><b>Day ${idx + 1}</b><span>${d.startsWith('day') ? '' : esc(md(d))}${c ? ' · ' + c : ''}</span>${w ? `<i class="dwx">${w.emoji} ${Math.round(w.max)}°</i>` : ''}</button>`;
  }).join('')}</div>
  ${wx ? `<div class="wxbar ${wx.kind}"><span class="wxe">${wx.emoji}</span><div><b>${esc(wx.text || '')} ${Math.round(wx.max)}° / ${Math.round(wx.min)}°</b>
      <span>${wx.kind === 'forecast' ? (wx.pop != null ? `강수확률 ${wx.pop}%` : '예보') : `작년 이맘때 날씨 (예보는 10일 전부터)${wx.rain ? ` · 비 ${Math.round(wx.rain)}mm` : ''}`}</span></div></div>` : ''}
  ${va ? `<div class="vabar"><b>${nameAvatar(t, va, 22)}${esc(va)} 일정으로 보는 중</b>${viewAsBtns(t, va)}</div>` : ''}
  <div id="daysum">${daySummaryHtml(t, S.day)}</div>
  <div class="planbar">${S.ordering ? '' : '<button class="ordbtn" data-act="newMemo">📝 메모 추가</button>'}${items.length > 1 ? `<button class="ordbtn ${S.ordering ? 'on' : ''}" data-act="ordering">${S.ordering ? '✓ 완료' : '↕ 순서 바꾸기'}</button>` : ''}</div>
  ${body ? `<div class="timeline">${body}</div>`
    : va && hasFork ? `<div class="empty"><b>${esc(va)} 일정이 없어요</b></div>`
    : '<div class="empty"><b>이 날 일정이 비어 있어요</b>가고 싶은 곳을 추가해 보세요.</div>'}`;
}

/** 따로 다니는 시간: 사람별 칸 (같은 일정끼리는 한 칸), 칸 안에도 이동 시간 */
function forkHtml(t, b, pinNo) {
  const { grp, lanes, next } = b;
  const times = grp.map((r) => r.time).filter(Boolean);
  const mini = (r) => {
    if (r.kind === 'flight') {
      const f = r.f; const dep = f._kind === 'dep';
      return `<div class="mini fl" data-act="tab" data-v="flight"><span>${esc(r.time || '')}</span><b>${dep ? '🛫 ' + esc(f.from || '') + ' 출발' : '🛬 ' + esc(f.to || '') + ' 도착'}</b></div>`;
    }
    const i = r.i; const c = (ICATS[i.cat] || ICATS.기타)[1]; const no = pinNo.get(i.id);
    return `<div class="mini" style="--c:${c}" data-act="editItem" data-id="${esc(i.id)}"><span>${no ? `<i class="mno">${no}</i>` : ''}${esc(i.time || '')}</span><b>${esc(i.title)}</b>${itemSpendHtml(t, i)}</div>`;
  };
  const nextTitle = next ? (next.kind === 'item' ? (next.i.kind === 'memo' ? '' : next.i.title) : '') : '';
  return `<div class="fork">
    <div class="forkhead">↙↘ 따로 다니는 시간${times.length ? ` ${esc(times[0])}${times.length > 1 ? ' – ' + esc(times[times.length - 1]) : ''}` : ''}</div>
    ${viewAsBtns(t, null)}
    <div class="lanes" style="grid-template-columns:repeat(${lanes.length},minmax(0,1fr))">
      ${lanes.map((l) => `<div class="lane"><h4><span class="lav">${l.names.map((p) => nameAvatar(t, p, 22)).join('')}</span>${esc(l.names.join('·'))}</h4>
        ${l.rows.length ? l.rows.map((r) => { const s = l.into.get(rowIdOf(r)); return (s ? segRow(t, s[0], s[1], 'sm') : '') + mini(r); }).join('') : '<div class="lane-empty">자유 시간</div>'}
        ${l.toNext ? segRow(t, l.toNext[0], l.toNext[1], 'sm', `→ ${l.toNext[1].title}`) : ''}</div>`).join('')}
    </div>
    ${next ? `<div class="meet">👥 ${next.time ? esc(next.time) + ' ' : ''}${nextTitle ? esc(nextTitle) + '에서 ' : ''}다시 같이</div>` : ''}
  </div>`;
}

/* ---------- Day 요약 ---------- */
function dayStats(t, d, p) {
  // 기준 사람: 사람 보기 중이면 그 사람, 아니면 나 (따로 다닌 날은 내 동선 기준)
  const who = p || myName(t);
  const items = dayItems(d).filter((i) => i.kind !== 'memo' && rowWho(t, { kind: 'item', i }).includes(who));
  let walkS = 0, walkM = 0, pending = false;
  for (const [a, b] of daySegments(d, who)) {
    const r = segResult(a, b, segMode(null, b));
    if (!r || r === 'loading') { pending = true; continue; }
    const used = r.used || segMode(null, b);
    if (used === 'walk' && r.secs) { walkS += r.secs; walkM += r.meters || 0; }
  }
  const de = S.expenses.filter((e) => e.date === d);
  const spent = p
    ? de.reduce((s, e) => { const sp = e.split?.length ? e.split : peopleOf(t); return s + (sp.includes(p) ? toKRW(t, e) / sp.length : 0); }, 0)
    : de.reduce((s, e) => s + toKRW(t, e), 0);
  return {
    places: items.length, meals: items.filter((i) => i.cat === '맛집').length, cafes: items.filter((i) => i.cat === '카페').length,
    shops: items.filter((i) => i.cat === '쇼핑').length, walkS, walkM, spent, pending,
  };
}
function daySummaryHtml(t, d) {
  const va = S.ordering ? null : S.viewAs;
  const s = dayStats(t, d, va);
  if (!s.places && !s.spent) return '';
  return `<div class="daysum">
    <div><span>🚶</span><b>${s.walkS ? fmtDur(s.walkS) : s.pending ? '…' : '0분'}</b><i>${s.walkM ? fmtDist(s.walkM) : '걸은 시간'}</i></div>
    <div><span>🍜</span><b>${s.meals}끼</b><i>식사</i></div>
    <div><span>☕</span><b>${s.cafes}곳</b><i>카페</i></div>
    <div><span>💸</span><b>${s.spent ? won(s.spent).replace('원', '') : '0'}</b><i>${va ? '원 (내 몫)' : '원 씀'}</i></div>
  </div>`;
}
const refreshDaySum = () => { const t = trip(); const el = $('daysum'); if (t && el) el.innerHTML = daySummaryHtml(t, S.day); };
function itemSpendHtml(t, i) {
  const es = S.expenses.filter((e) => e.itemId === i.id);
  if (!es.length) return '';
  const krw = es.reduce((s, e) => s + toKRW(t, e), 0);
  const local = es.every((e) => e.cur === es[0].cur && e.cur !== 'KRW') ? `${num(es.reduce((s, e) => s + Number(e.amount || 0), 0))} ${es[0].cur} · ` : '';
  return `<div class="ispend">💸 ${esc(local)}${won(krw)}</div>`;
}

/* ---------- 여행 리캡 ---------- */
async function openRecap(t) {
  const days = tripDays(t);
  const v = document.createElement('div'); v.className = 'recap'; v.id = 'recap';
  v.innerHTML = '<div class="rc-load">여행을 돌아보는 중… 🎞</div>';
  document.body.appendChild(v); document.body.classList.add('noscroll');
  v.addEventListener('click', (e) => {
    const q = e.target.closest('[data-rc]')?.dataset.rc;
    if (q === 'x') { v.remove(); document.body.classList.remove('noscroll'); }
    if (q === 'copy') copy(v.querySelector('[data-rc=copy]').dataset.text, '리캡을 복사했어요. 단톡방에 붙여넣기!');
  });
  // 아직 계산 안 된 이동 구간 채우기 (걸은 시간 합계용)
  if (mapsEnabled) {
    const jobs = [];
    for (const d of days) {
      for (const [a, b] of daySegments(d, myName(t))) {
        const mode = segMode(t, b);
        if (segResult(a, b, mode)) continue;
        const key = segKey(a, b, mode);
        jobs.push(routeFor(a, b, mode).then((res) => { segCache.set(key, { ...res, key }); saveStop(t, b, { [b._mk]: { ...res, key } }); }).catch(() => {}));
        if (jobs.length >= 40) break;
      }
    }
    await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 12000))]);
  }
  const per = days.map((d) => ({ d, ...dayStats(t, d), items: dayItems(d).filter((i) => i.kind !== 'memo') }));
  const sum = (k) => per.reduce((s, x) => s + x[k], 0);
  const total = S.expenses.reduce((s2, e) => s2 + toKRW(t, e), 0);
  const ppl = peopleOf(t).length || 1;
  const byCat = {}; S.expenses.forEach((e) => { byCat[e.cat || '기타'] = (byCat[e.cat || '기타'] || 0) + toKRW(t, e); });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const topSpend = [...per].sort((a, b) => b.spent - a.spent)[0];
  const topWalk = [...per].sort((a, b) => b.walkS - a.walkS)[0];
  const done = S.items.filter((i) => i.kind !== 'memo' && i.done).length;
  const leftWish = S.places.filter((p) => !(p.addedTo && S.items.some((i) => i.id === p.addedTo.itemId)));
  const W = S.weatherFor === t.id ? S.weather : {};
  const nights = days[0].startsWith('day') ? '' : `${Math.max(0, days.length - 1)}박 ${days.length}일`;
  const dayLabel = (x, i) => `Day ${i + 1}${x.d.startsWith('day') ? '' : ' · ' + md(x.d)}`;
  const text = [`🎞 ${t.name} 리캡${t.city ? ' · ' + t.city : ''}${nights ? ' · ' + nights : ''}`,
    `📍 ${sum('places')}곳 · 🍜 ${sum('meals')}끼 · ☕ ${sum('cafes')}곳 · 🛍 ${sum('shops')}곳`,
    `🚶 ${fmtDur(sum('walkS') || 60)} 걸음 (${fmtDist(sum('walkM'))})`,
    `💸 총 ${won(total)} (1인당 약 ${won(total / ppl)})`,
    ...per.map((x, i) => `${dayLabel(x, i)}: ${x.items.map((it) => it.title).join(' → ') || '-'}`)].join('\n');
  v.innerHTML = `<div class="rc-in">
    <div class="rc-top"><button class="qv-x" data-rc="x">닫기</button></div>
    <div class="rc-hero"><div class="rc-city">${esc(t.city || 'TRIP')}</div><h1>${esc(t.name)}</h1>
      <div class="rc-dates">${t.start ? esc(md(t.start)) + (t.end && t.end !== t.start ? ' – ' + esc(md(t.end)) : '') : ''}${nights ? ' · ' + nights : ''}</div>
      <div class="rc-people">${(t.members || []).map((u) => avatar(u, 30, t.memberNames?.[u])).join('')}</div></div>
    <div class="rc-grid">
      <div><span>📍</span><b>${sum('places')}</b><i>곳 방문${done ? ` (${done} 완료)` : ''}</i></div>
      <div><span>🚶</span><b>${sum('walkS') ? fmtDur(sum('walkS')) : '-'}</b><i>${sum('walkM') ? fmtDist(sum('walkM')) + ' 걸음' : '걸은 시간'}</i></div>
      <div><span>🍜</span><b>${sum('meals')}끼</b><i>맛집</i></div>
      <div><span>☕</span><b>${sum('cafes')}곳</b><i>카페</i></div>
      <div><span>🛍</span><b>${sum('shops')}곳</b><i>쇼핑</i></div>
      <div><span>✈️</span><b>${S.flights.length}편</b><i>비행</i></div>
    </div>
    <div class="sum rc-money"><div class="lbl">총 지출</div><div class="big">${won(total)}</div>
      <div class="bars">${total ? cats.map(([c, x]) => `<div style="width:${(x / total) * 100}%;background:${ECATS[c] || '#888'}"></div>`).join('') : ''}</div>
      <div class="legend">${cats.map(([c, x]) => `<span><i style="background:${ECATS[c] || '#888'}"></i>${esc(c)} ${won(x)}</span>`).join('')}${total ? `<span>· 1인당 약 ${won(total / ppl)}</span>` : ''}</div></div>
    <div class="rc-best">
      ${topSpend && topSpend.spent ? `<div>💸 가장 많이 쓴 날<b>${esc(dayLabel(topSpend, per.indexOf(topSpend)))} · ${won(topSpend.spent)}</b></div>` : ''}
      ${topWalk && topWalk.walkS ? `<div>🚶 가장 많이 걸은 날<b>${esc(dayLabel(topWalk, per.indexOf(topWalk)))} · ${fmtDur(topWalk.walkS)}</b></div>` : ''}
    </div>
    <h3 class="rc-h">하루하루</h3>
    ${per.map((x, i) => `<div class="rc-day"><div class="rc-dh"><b>${esc(dayLabel(x, i))}</b>${W[x.d] ? `<span>${W[x.d].emoji} ${Math.round(W[x.d].max)}°</span>` : ''}${x.spent ? `<span class="mono">${won(x.spent)}</span>` : ''}</div>
      <div class="rc-route">${x.items.length ? x.items.map((it) => `<span style="--c:${(ICATS[it.cat] || ICATS.기타)[1]}">${esc(it.title)}</span>`).join('<em>→</em>') : '<span class="muted">기록 없음</span>'}</div></div>`).join('')}
    ${leftWish.length ? `<h3 class="rc-h">다음에 가볼 곳 (못 간 찜 ${leftWish.length})</h3><div class="rc-route">${leftWish.map((p) => `<span style="--c:${(ICATS[p.cat] || ICATS.기타)[1]}">${esc(p.name)}</span>`).join('')}</div>` : ''}
    <button class="btn pri block" data-rc="copy" data-text="${esc(text)}" style="margin:22px 0 8px">리캡 텍스트 복사하기</button>
  </div>`;
}

/* ---------- 날씨 ---------- */
let wxLoading = null;
async function loadWeather(t, days) {
  const key = t.id + '|' + days[0] + '|' + days[days.length - 1] + '|' + (t.geo ? t.geo.lat : '') + '|' + t.city;
  if (wxLoading === key) return; wxLoading = key;
  try {
    let geo = t.geo;
    if (!geo) {
      const it = S.items.find((i) => ll(i));
      geo = it ? { lat: it.lat, lng: it.lng } : await geocodeCity(t.city);
      if (geo) updateDoc(doc(db, 'trips', t.id), { geo }).catch(() => {});
    }
    if (!geo) return;
    const w = await tripWeather(geo, days);
    if (S.tripId !== t.id) return;
    S.weather = w; S.weatherFor = t.id;
    if (Object.keys(w).length) render();
  } catch (e) { console.warn(e); }
}

/* ---------- 이동 구간 (거리·시간) ---------- */
// 수단은 알아서: 걸어서 30분 미만 또는 대중교통과 10분 이내 차이면 도보, 아니면 대중교통. 구간마다 직접 바꿀 수도 있음
const WALK_LIMIT = 30 * 60;
const segMode = (_t, i) => i.moveMode || 'auto';
const segKey = (from, to, mode) => [from.id, from.lat, from.lng, to.lat, to.lng, mode].join('|');
const segCache = new Map(); // key -> {meters,secs,used} | {none} | 'loading' | {err}
const dirUrl = (from, to, m) => `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&travelmode=${MOVES[m][3]}`;
function straightM(a, b) {
  const R = 6371000, r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function segRow(t, from, to, cls = '', label = '') {
  const mode = segMode(t, to);
  const r = segResult(from, to, mode);
  const sid = sidOf(from, to); stopMap.set(sid, { from, to });
  // 알아서 고른 수단(결과 나오기 전엔 직선거리로 추정)을 그대로 선택된 상태로 보여줌
  const guess = straightM(from, to) < 1800 ? 'walk' : 'transit';
  const autoUsed = mode === 'auto' ? (r && r.used) || guess : null;
  const shown = mode === 'auto' ? autoUsed : mode;
  return `<div class="seg ${cls}" data-seg="${esc(sid)}">
    ${label ? `<span class="seglbl">${esc(label)}</span>` : ''}
    <select class="segsel" data-act="segmode" data-id="${esc(sid)}" data-auto="${esc(autoUsed || '')}" aria-label="이동 수단">
      ${Object.entries(MOVES).map(([k, v]) => `<option value="${k}" ${k === shown ? 'selected' : ''}>${v[0]} ${cls ? '' : v[1]}</option>`).join('')}
    </select>
    <span class="seginfo" data-seginfo="${esc(sid)}">${segText(from, to, mode)}</span>
    <a class="seglink" data-seglink="${esc(sid)}" href="${esc(dirUrl(from, to, shown))}" target="_blank" rel="noopener">길찾기</a>
  </div>`;
}
function segResult(from, to, mode) {
  const k = segKey(from, to, mode);
  if (segCache.has(k)) return segCache.get(k);
  const m = to.move; // 저장해 둔 계산 결과 재사용 (API 호출 아끼기)
  if (m && m.key === k) { segCache.set(k, m); return m; }
  return null;
}
function segText(from, to, mode) {
  const r = segResult(from, to, mode);
  if (!r || r === 'loading') return '<span class="muted">계산 중…</span>';
  if (r.err) return '<span class="muted">계산 실패</span>';
  if (r.none) {
    // 구글 API가 일부 지역 정보를 안 줌 (예: 일본 대중교통, 한국 도보·차). 길찾기 링크는 구글맵 앱에서 정상 동작
    const m = mode === 'auto' ? 'transit' : mode;
    return `<span class="muted">이 지역은 ${MOVES[m][1]} 시간 미제공 · 직선 ${fmtDist(straightM(from, to))} → 길찾기에서 확인</span>`;
  }
  const note = r.transitNone ? ' <span class="muted">(대중교통 시간 미제공 → 길찾기)</span>' : '';
  return `<b>${fmtDur(r.secs)}</b> · ${fmtDist(r.meters)}${note}`;
}
async function routeFor(from, to, mode) {
  const when = from.time || to.time;
  if (mode !== 'auto') {
    const r = await computeRoute(from, to, MOVES[mode][2], when);
    return r?.none ? { none: true } : { ...r, used: mode };
  }
  const walk = await computeRoute(from, to, 'WALK', when);
  const okWalk = walk && !walk.none;
  if (okWalk && walk.secs < WALK_LIMIT) return { ...walk, used: 'walk' }; // 걸어서 30분 미만 → 도보
  const tr = await computeRoute(from, to, 'TRANSIT', when);
  if (tr && !tr.none) {
    if (okWalk && walk.secs - tr.secs <= 10 * 60) return { ...walk, used: 'walk' }; // 대중교통과 10분 이내 차이 → 도보
    return { ...tr, used: 'transit' };
  }
  // 대중교통 정보가 없는 지역(일본 등): 도보 시간이라도 보여주기
  if (walk && !walk.none) return { ...walk, used: 'walk', transitNone: true };
  return { none: true };
}
async function fillSegments(t) {
  if (!mapsEnabled) return;
  // 화면에 보이는 구간 + 요약(내/보는 사람 동선) 구간
  const all = new Map();
  [...shownSegs, ...daySegments(S.day, (S.ordering ? null : S.viewAs) || myName(t))].forEach(([a, b]) => all.set(sidOf(a, b), [a, b]));
  for (const [sid, [from, to]] of all) {
    const mode = segMode(t, to);
    if (segResult(from, to, mode)) continue;
    const key = segKey(from, to, mode); segCache.set(key, 'loading');
    const paint = () => {
      const q = CSS.escape(sid);
      const r = segCache.get(key);
      document.querySelectorAll(`[data-seginfo="${q}"]`).forEach((el) => { el.innerHTML = segText(from, to, mode); });
      document.querySelectorAll(`[data-seglink="${q}"]`).forEach((a) => { if (r && r.used) a.href = dirUrl(from, to, r.used); });
      document.querySelectorAll(`.segsel[data-id="${q}"]`).forEach((sel) => { if (mode === 'auto' && r && r.used) { sel.value = r.used; sel.dataset.auto = r.used; } });
      refreshDaySum();
    };
    routeFor(from, to, mode).then((res) => {
      segCache.set(key, { ...res, key });
      saveStop(t, to, { [to._mk]: { ...res, key } });
      paint();
    }).catch((e) => { console.error(e); segCache.set(key, { err: true }); paint(); });
  }
}
const saveStop = (t, st, data) => updateDoc(doc(db, 'trips', t.id, st._col, st._doc), data).catch(() => {});

function flightRow(f) {
  const dep = f._kind === 'dep';
  const title = dep ? `🛫 ${esc(f.from || '?')} 출발 → ${esc(f.to || '?')}` : `🛬 ${esc(f.to || '?')} 도착 (${esc(f.from || '?')}에서)`;
  const sub = [f.airline, f.flightNo].filter(Boolean).join(' ')
    + (dep && f.terminal ? ` · ${f.terminal}` : '')
    + (dep && f.arrAt ? ` · 도착 ${hm(f.arrAt)}` : '')
    + (!dep && f.depAt ? ` · 출발 ${hm(f.depAt)}` : '');
  return `<div class="item flightrow ${dep ? '' : 'arr'}" style="--cat:#1F2A44" data-act="tab" data-v="flight">
    <div class="irow"><div class="itime">${esc(f.time || '--:--')}</div>
    <div style="flex:1;min-width:0"><div class="ititle">${title}</div>
    <div class="imemo">${esc(sub)}${dep && f.bookingRef ? ' · 예약 ' + esc(f.bookingRef) : ''}${dep && (f.qrIds || []).length ? ' · 📱 QR' : ''}</div>
    ${(() => { const w = flightWho(trip(), f); return w.length ? `<div class="bp-who small">${peopleChips(trip(), w)}</div>` : ''; })()}</div></div></div>`;
}
function itemRow(t, i, no, list) {
  const c = i.kind === 'memo' ? ['#FFF6CC', '#C9A227'] : ICATS[i.cat] || ICATS.기타;
  if (S.ordering) {
    const k = list.findIndex((x) => x.id === i.id);
    if (i.kind === 'memo') {
      return `<div class="item ordering memo" data-drag="${esc(i.id)}" style="--cat:${c[1]}"><div class="irow">
      <div class="itime">📝</div><div style="flex:1;min-width:0"><div class="imemo clamp">${esc(i.memo || '')}</div></div>
      <div class="draghandle" aria-label="끌어서 순서 바꾸기">≡</div>
    </div></div>`;
    }
    return `<div class="item ordering" data-drag="${esc(i.id)}" style="--cat:${c[1]}"><div class="irow">
      <div class="itime">${esc(i.time || '—')}</div>
      <div style="flex:1;min-width:0"><div class="ititle">${esc(i.title)}</div>${i.who && i.who.length ? `<div class="iaddr">👤 ${esc(i.who.join(', '))}만</div>` : '<div class="iaddr">≡ 잡고 끌어서 이동</div>'}</div>
      <div class="draghandle" aria-label="끌어서 순서 바꾸기">≡</div>
    </div></div>`;
  }
  if (i.kind === 'memo') {
    return `<div class="item memo" style="--cat:${c[1]}" data-act="editMemo" data-id="${esc(i.id)}"><div class="memotxt">${esc(i.memo || '')}</div></div>`;
  }
  return `<div class="item ${i.done ? 'done' : ''}" style="--cat:${c[1]}" ${ll(i) ? `data-act="focus" data-id="${esc(i.id)}"` : ''}>
    <div class="irow"><button class="itime tbtn ${i.time ? '' : 'empty'}" data-act="settime" data-id="${esc(i.id)}" aria-label="시간 변경">${esc(i.time || '시간')}</button>
      <div style="flex:1;min-width:0"><div class="ititle">${no ? `<span class="pinno" style="background:${c[1]}">${no}</span>` : ''}${esc(i.title)}</div>
      ${i.address ? `<div class="iaddr">${esc(i.address)}</div>` : ''}
      ${i.memo ? `<div class="imemo">${esc(i.memo)}</div>` : ''}
      ${itemSpendHtml(t, i)}
      <div class="iactions"><span class="tag" style="--bg:${c[0]};--fg:${c[1]}">${esc(i.cat || '기타')}</span>
        ${i.cat !== '이동' ? `<a class="lnk map" href="${esc(placeUrl(t, i))}" target="_blank" rel="noopener">구글맵</a>` : ''}
        ${i.link ? `<a class="lnk" href="${esc(i.link)}" target="_blank" rel="noopener">링크</a>` : ''}
        <button class="lnk" data-act="toggleDone" data-id="${esc(i.id)}">${i.done ? '되돌리기' : '완료'}</button>
        <button class="lnk" data-act="editItem" data-id="${esc(i.id)}">수정</button>
      </div></div></div></div>`;
}

async function drawPlanMap(t, days) {
  if (!mapsEnabled) return showMap(false);
  showMap(true);
  const ctl = await ensureMap(); if (!ctl) return showMap(false);
  let groups;
  if (S.mapAll) {
    groups = days.map((d, idx) => ({
      color: DAYCOLORS[idx % DAYCOLORS.length], path: true,
      points: dayItems(d).filter(ll).map((i, k) => ({ lat: i.lat, lng: i.lng, label: k + 1, title: i.title })),
    }));
  } else {
    const idx = days.indexOf(S.day);
    groups = [{
      color: DAYCOLORS[Math.max(0, idx) % DAYCOLORS.length], path: true,
      points: dayItems(S.day).filter(ll).map((i, k) => ({ lat: i.lat, lng: i.lng, label: k + 1, title: i.title })),
    }];
  }
  const n = ctl.draw(groups);
  if (!n) ctl.centerOn(t.city);
  $('mapToggle').hidden = false; $('mapToggle').textContent = S.mapAll ? '이 날만 보기' : '전체 일정 보기';
  const r = routeUrl(t, dayItems(S.day));
  $('routeLink').hidden = !r || S.mapAll; if (r) $('routeLink').href = r;
}
function showMap(on) { $('mapwrap').hidden = !on; }

/* ---------- 찜 (일정에 안 넣고 모아두는 곳) ---------- */
const WCATS = ['맛집', '카페', '쇼핑', '관광', '숙소', '기타'];
const SPEND_CAT = { 맛집: '식비', 카페: '식비', 쇼핑: '쇼핑', 관광: '관광', 숙소: '숙소', 이동: '교통', 기타: '기타' };
function viewWish(t) {
  const all = [...S.places].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const cnt = (c) => all.filter((p) => (p.cat || '기타') === c).length;
  const list = S.wishCat === 'all' ? all : all.filter((p) => (p.cat || '기타') === S.wishCat);
  const days = tripDays(t);
  return `<div class="wishfilter">
      <button class="pill ${S.wishCat === 'all' ? 'on' : ''}" data-act="wishcat" data-v="all">전체 ${all.length}</button>
      ${WCATS.filter((c) => cnt(c)).map((c) => `<button class="pill ${S.wishCat === c ? 'on' : ''}" data-act="wishcat" data-v="${c}">${c} ${cnt(c)}</button>`).join('')}
    </div>
    ${list.length ? list.map((p) => {
      const c = ICATS[p.cat] || ICATS.기타;
      const added = p.addedTo && S.items.some((i) => i.id === p.addedTo.itemId);
      const dayNo = added ? days.indexOf(p.addedTo.date) + 1 : 0;
      return `<div class="wish ${added ? 'added' : ''}" style="--cat:${c[1]}" ${ll(p) ? `data-act="focusWish" data-id="${esc(p.id)}"` : ''}>
        <div class="wt"><span class="tag" style="--bg:${c[0]};--fg:${c[1]}">${esc(p.cat || '기타')}</span>${esc(p.name)}${added ? `<span class="addedtag">${dayNo > 0 ? 'Day ' + dayNo : '일정'}에 추가됨</span>` : ''}</div>
        ${p.by ? `<div class="wby">${avatar(p.by, 18, t.memberNames?.[p.by])}<span>${esc(nameOf(t, p.by))} 찜</span></div>` : ''}
        ${p.address ? `<div class="iaddr">${esc(p.address)}</div>` : ''}
        ${p.memo ? `<div class="imemo">${esc(p.memo)}</div>` : ''}
        <div class="iactions">
          <button class="lnk map" data-act="toPlan" data-id="${esc(p.id)}">📅 일정에 넣기</button>
          <a class="lnk" href="${esc(placeUrl(t, { title: p.name, placeId: p.placeId }))}" target="_blank" rel="noopener">구글맵</a>
          ${p.link ? `<a class="lnk" href="${esc(p.link)}" target="_blank" rel="noopener">링크</a>` : ''}
          <button class="lnk" data-act="editWish" data-id="${esc(p.id)}">수정</button>
        </div></div>`;
    }).join('') : `<div class="empty"><b>${S.wishCat === 'all' ? '찜한 곳이 없어요' : S.wishCat + ' 찜이 없어요'}</b>가보고 싶은 맛집·카페·쇼핑 장소를 모아두고<br>날짜가 정해지면 일정으로 옮겨 보세요.</div>`}`;
}
async function drawWishMap(t) {
  if (!mapsEnabled) return showMap(false);
  showMap(true);
  const ctl = await ensureMap(); if (!ctl) return showMap(false);
  const ps = S.places.filter((p) => ll(p) && (S.wishCat === 'all' || (p.cat || '기타') === S.wishCat));
  const groups = WCATS.map((c) => ({
    color: (ICATS[c] || ICATS.기타)[1], path: false,
    points: ps.filter((p) => (p.cat || '기타') === c).map((p) => ({ lat: p.lat, lng: p.lng, label: c[0], title: p.name })),
  }));
  if (!ctl.draw(groups)) ctl.centerOn(t.city);
  $('mapToggle').hidden = true; $('routeLink').hidden = true;
}
function wishForm(t, p) {
  const isNew = !p;
  p = p || { name: '', cat: S.wishCat !== 'all' ? S.wishCat : '맛집', memo: '', link: '' };
  let picked = p.lat != null ? { lat: p.lat, lng: p.lng, address: p.address || '', placeId: p.placeId || null } : null;
  openSheet(`<h2>${isNew ? '찜하기' : '찜 수정'}</h2>
    ${mapsEnabled ? '<label class="f"><span>장소 검색</span><div id="placeBox" class="placebox"><div class="small muted">검색창 불러오는 중…</div></div></label>' : ''}
    <div id="pickedBox"></div>
    <label class="f"><span>이름</span><input class="inp" name="name" value="${esc(p.name)}" placeholder="예: 이치란 라멘 도톤보리점"></label>
    <label class="f"><span>분류</span>${pills('cat', WCATS, p.cat || '기타')}</label>
    <label class="f"><span>메모</span><textarea class="inp" name="memo" placeholder="추천 메뉴, 웨이팅, 영업시간…">${esc(p.memo)}</textarea></label>
    <label class="f"><span>링크 (블로그·인스타 등)</span><input class="inp" name="link" value="${esc(p.link)}" placeholder="https://"></label>
    <div class="rowbtns">${isNew ? '' : '<button class="btn danger" data-x="del">삭제</button>'}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    wirePills(sh); const v = fval(sh);
    const showPicked = () => {
      sh.querySelector('#pickedBox').innerHTML = picked ? `<div class="picked">📍 ${esc(picked.address || '위치 저장됨')} <button type="button" class="lnk" data-x="unpick">위치 빼기</button></div>` : '';
      sh.querySelector('[data-x=unpick]')?.addEventListener('click', () => { picked = null; showPicked(); });
    };
    showPicked();
    if (mapsEnabled) {
      const near = mapCtl?.map?.getCenter?.() ? { center: mapCtl.map.getCenter(), radius: 30000 } : undefined;
      mountPlaceSearch(sh.querySelector('#placeBox'), (r) => {
        picked = { lat: r.lat, lng: r.lng, address: r.address, placeId: r.placeId };
        sh.querySelector('[name=name]').value = r.name; showPicked();
      }, near).catch(() => { sh.querySelector('#placeBox').innerHTML = '<div class="small muted">장소 검색을 불러오지 못했어요</div>'; });
    }
    sh.querySelector('[data-x=save]').onclick = async () => {
      if (!v('name')) return toast('이름을 적어 주세요');
      let link = v('link'); if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
      const data = { name: v('name'), cat: pillVal(sh, 'cat')[0] || '기타', memo: v('memo'), link,
        lat: picked?.lat ?? null, lng: picked?.lng ?? null, address: picked?.address || '', placeId: picked?.placeId || null };
      closeSheet();
      if (isNew) await write(() => setDoc(doc(db, 'trips', t.id, 'places', uid()), { ...data, createdAt: Date.now(), by: S.user.uid }));
      else await write(() => updateDoc(doc(db, 'trips', t.id, 'places', p.id), data));
    };
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => askConfirm(`찜한 '${p.name}'을(를) 삭제할까요?`, '삭제', () => write(() => deleteDoc(doc(db, 'trips', t.id, 'places', p.id)))));
  });
}
function toPlanSheet(t, p) {
  if (!p) return;
  const days = tripDays(t);
  const today = fmtD(new Date());
  const def = p.addedTo?.date || (days.includes(today) ? today : days[0]);
  openSheet(`<h2>'${esc(p.name)}' 일정에 넣기</h2>
    <label class="f"><span>날짜</span>${pills('day', days.map((d, i) => `Day ${i + 1}${d.startsWith('day') ? '' : ' ' + md(d)}`), (() => { const i = days.indexOf(def); return `Day ${i + 1}${def.startsWith('day') ? '' : ' ' + md(def)}`; })())}</label>
    <div class="f"><span class="flbl">시간 (선택)</span>${timeField('time', '', '시간 없이 넣기')}</div>
    <p class="small muted" style="margin:-4px 0 12px">찜 목록에는 '추가됨'으로 남아 있어요.</p>
    <div class="rowbtns"><button class="btn ghost" data-x="no">취소</button><button class="btn pri" data-x="ok">일정에 넣기</button></div>`, (sh) => {
    wirePills(sh); wireTimeFields(sh, '일정 시간');
    sh.querySelector('[data-x=no]').onclick = closeSheet;
    sh.querySelector('[data-x=ok]').onclick = async () => {
      const label = pillVal(sh, 'day')[0];
      const idx = days.findIndex((d, i) => label === `Day ${i + 1}${d.startsWith('day') ? '' : ' ' + md(d)}`);
      const date = days[Math.max(0, idx)];
      const time = sh.querySelector('[name=time]').value;
      const itemId = uid();
      closeSheet();
      await write(async () => {
        await setDoc(doc(db, 'trips', t.id, 'items', itemId), {
          title: p.name, date, time, memo: p.memo || '', link: p.link || '', cat: p.cat === '숙소' ? '숙소' : (ICATS[p.cat] ? p.cat : '기타'),
          lat: p.lat ?? null, lng: p.lng ?? null, address: p.address || '', placeId: p.placeId || null,
          done: false, createdAt: Date.now(), by: S.user.uid, fromWish: p.id, pos: insertPos(date, time),
        });
        await updateDoc(doc(db, 'trips', t.id, 'places', p.id), { addedTo: { itemId, date } });
      });
      toast(`Day ${idx + 1}에 넣었어요`);
    };
  });
}

/* ---------- flights ---------- */
const sortFlights = () => [...S.flights].sort((a, b) => (a.depAt || '').localeCompare(b.depAt || ''));
function fdate(dt) { return dt ? `${md(dt)} ${hm(dt)}` : ''; }
function viewFlights() {
  const list = sortFlights();
  if (!list.length) return '<div class="empty"><b>등록된 항공권이 없어요</b>예약한 항공편을 넣어두면 일정에 자동으로 표시돼요.</div>';
  return list.map((f) => {
    const dur = f.depAt && f.arrAt ? Math.round((new Date(f.arrAt) - new Date(f.depAt)) / 6e4) : null;
    return `<div class="boarding">
      <div class="bp-top"><span class="bp-type">${esc(f.kind || '항공편')}</span><span class="small">${esc([f.airline, f.flightNo].filter(Boolean).join(' '))}</span></div>
      ${(() => { const tt = trip(); const w = flightWho(tt, f); return w.length ? `<div class="bp-pax"><span>탑승자 ${w.length}명</span><div>${paxList(tt, w)}</div></div>` : ''; })()}
      <div class="bp-route">
        <div><b>${esc(f.from || '---')}</b><span>${esc(fdate(f.depAt))}</span></div>
        <div class="bp-plane">${I.plane}${dur && dur > 0 && dur < 3000 ? `<small>약 ${Math.floor(dur / 60)}시간 ${dur % 60}분<br>(현지시각 기준)</small>` : ''}</div>
        <div style="text-align:right"><b>${esc(f.to || '---')}</b><span>${esc(fdate(f.arrAt))}</span></div>
      </div>
      <div class="bp-info">
        ${f.bookingRef ? `<div><span>예약번호</span><b class="mono">${esc(f.bookingRef)}</b><button class="lnk" data-act="copy" data-text="${esc(f.bookingRef)}">복사</button></div>` : ''}
        ${f.seat ? `<div><span>좌석</span><b>${esc(f.seat)}</b></div>` : ''}
        ${f.terminal ? `<div><span>터미널</span><b>${esc(f.terminal)}</b></div>` : ''}
        ${f.baggage ? `<div><span>수하물</span><b>${esc(f.baggage)}</b></div>` : ''}
      </div>
      ${f.memo ? `<div class="imemo" style="margin-top:8px">${esc(f.memo)}</div>` : ''}
      ${(f.qrIds || []).length ? `<div class="qrrow">${f.qrIds.map((q, k) => `<button class="qrthumb" data-act="qrview" data-flight="${esc(f.id)}" data-idx="${k}">${qrCache.get(q) && qrCache.get(q) !== 'loading' ? `<img src="${qrCache.get(q)}" alt="QR ${k + 1}">` : '<span>QR</span>'}</button>`).join('')}
        <button class="btn dark qrbig" data-act="qrview" data-flight="${esc(f.id)}" data-idx="0">📱 체크인 QR 크게 보기</button></div>` : ''}
      <div class="iactions" style="margin-top:10px">
        ${f.flightNo ? `<a class="lnk map" target="_blank" rel="noopener" href="https://www.google.com/search?q=${encodeURIComponent((f.flightNo || '').replace(/\s/g, '') + ' 항공편')}">운항 상태</a>` : ''}
        <button class="lnk" data-act="editFlight" data-id="${esc(f.id)}">수정</button>
      </div></div>`;
  }).join('');
}

/* ---------- QR 사진 ---------- */
const qrCache = new Map(); // fileId -> dataURL | 'loading'
async function loadQr(t, id) {
  if (qrCache.has(id)) return qrCache.get(id);
  qrCache.set(id, 'loading');
  try {
    const s = await getDoc(doc(db, 'trips', t.id, 'files', id));
    qrCache.set(id, s.exists() ? s.data().data : null);
  } catch (e) { console.error(e); qrCache.delete(id); }
  return qrCache.get(id);
}
function loadQrThumbs(t) {
  const ids = S.flights.flatMap((f) => f.qrIds || []).filter((id) => !qrCache.has(id));
  if (!ids.length) return;
  Promise.all(ids.map((id) => loadQr(t, id))).then(() => { if (S.tab === 'flight') render(); });
}
async function openQrViewer(flightId, idx) {
  const t = trip(); const f = S.flights.find((x) => x.id === flightId); if (!f) return;
  const ids = f.qrIds || []; if (!ids.length) return;
  let k = Math.min(idx, ids.length - 1);
  const v = document.createElement('div'); v.className = 'qrviewer'; v.id = 'qrviewer';
  const show = async () => {
    v.innerHTML = `<div class="qv-top"><span>${esc([f.flightNo, f.from && f.to ? f.from + '→' + f.to : ''].filter(Boolean).join(' · '))} ${ids.length > 1 ? `(${k + 1}/${ids.length})` : ''}</span><button class="qv-x" data-q="x">닫기</button></div>
      <div class="qv-img"><span class="muted">불러오는 중…</span></div>
      <div class="qv-hint">화면 밝기를 최대로 올리고 보여주세요</div>
      ${ids.length > 1 ? '<div class="qv-nav"><button data-q="prev">‹ 이전</button><button data-q="next">다음 ›</button></div>' : ''}`;
    const src = await loadQr(t, ids[k]);
    const box = v.querySelector('.qv-img'); if (box) box.innerHTML = src ? `<img src="${src}" alt="체크인 QR">` : '<span class="muted">사진을 불러오지 못했어요</span>';
  };
  v.addEventListener('click', (e) => {
    const q = e.target.closest('[data-q]')?.dataset.q;
    if (q === 'x') { v.remove(); document.body.classList.remove('noscroll'); }
    else if (q === 'prev') { k = (k - 1 + ids.length) % ids.length; show(); }
    else if (q === 'next') { k = (k + 1) % ids.length; show(); }
  });
  document.body.appendChild(v); document.body.classList.add('noscroll'); show();
}

/* ---------- money ---------- */
function toKRW(t, e) {
  const a = Number(e.amount) || 0;
  return e.cur === 'KRW' ? a : a * (Number(e.rate) || Number(t.rate) || 1);
}
const rateLabel = (cur, perOne) => `${rateUnit(cur)} ${cur} = ${num((Number(perOne) || 0) * rateUnit(cur))}원`;
function viewMoney(t) {
  const list = [...S.expenses].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
  const total = list.reduce((s, e) => s + toKRW(t, e), 0);
  const byCat = {}; list.forEach((e) => { byCat[e.cat || '기타'] = (byCat[e.cat || '기타'] || 0) + toKRW(t, e); });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const n = peopleOf(t).length || 1;
  const groups = {}; list.forEach((e) => { (groups[e.date || '날짜 없음'] ||= []).push(e); });
  return `<div class="sum"><div class="lbl">총 지출 ${t.currency && t.currency !== 'KRW' ? `· 기본 환율 ${esc(rateLabel(t.currency, t.rate))}` : ''}</div>
    <div class="big">${won(total)}</div>
    <div class="bars">${total ? cats.map(([c, v]) => `<div style="width:${(v / total) * 100}%;background:${ECATS[c] || '#888'}"></div>`).join('') : ''}</div>
    <div class="legend">${cats.map(([c, v]) => `<span><i style="background:${ECATS[c] || '#888'}"></i>${esc(c)} ${won(v)}</span>`).join('')}${total ? `<span>· 1인당 약 ${won(total / n)}</span>` : ''}</div></div>
  ${list.length ? Object.entries(groups).map(([d, es]) => `<div class="dategrp">${esc(d.includes('-') ? md(d) : d)} · ${won(es.reduce((s, e) => s + toKRW(t, e), 0))}</div>
    ${es.map((e) => {
      const col = ECATS[e.cat] || '#888'; const local = e.cur !== 'KRW' && t.currency && t.currency !== 'KRW';
      return `<button class="exp" data-act="editExp" data-id="${esc(e.id)}">
        <div class="ico" style="background:${col}22;color:${col}">${esc((e.cat || '기타').slice(0, 2))}</div>
        <div style="min-width:0"><div class="t">${esc(e.title)}</div><div class="s">${esc(e.payer || '?')} 결제 · ${(e.split || []).length === n ? '모두' : esc((e.split || []).join(', '))}${local && e.rate ? ` · ${esc(rateLabel(e.cur, e.rate))}` : ''}</div></div>
        <div class="amt">${local ? `${num(e.amount)} ${esc(t.currency)}<small>${won(toKRW(t, e))}</small>` : won(e.amount)}</div></button>`;
    }).join('')}`).join('')
    : '<div class="empty"><b>기록된 지출이 없어요</b>쓴 돈을 바로바로 적어 두면 정산이 쉬워요.</div>'}`;
}
function settle(t) {
  // 초대로 참여한 사람 + (예전에 이름으로 넣었던 사람이 지출에 남아 있으면 같이)
  const people = [...new Set([...peopleOf(t), ...S.expenses.flatMap((e) => [e.payer, ...(e.split || [])])].filter(Boolean))]; const bal = {}, paid = {}, owe = {};
  people.forEach((m) => { bal[m] = 0; paid[m] = 0; owe[m] = 0; });
  S.expenses.forEach((e) => {
    const amt = toKRW(t, e); const split = (e.split || []).filter((m) => m in bal);
    if (e.payer in bal) { bal[e.payer] += amt; paid[e.payer] += amt; }
    if (split.length) { const sh = amt / split.length; split.forEach((m) => { bal[m] -= sh; owe[m] += sh; }); }
  });
  const cred = people.filter((m) => bal[m] > 0.5).map((m) => [m, bal[m]]).sort((a, b) => b[1] - a[1]);
  const debt = people.filter((m) => bal[m] < -0.5).map((m) => [m, -bal[m]]).sort((a, b) => b[1] - a[1]);
  const xs = []; let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const x = Math.min(debt[i][1], cred[j][1]); xs.push([debt[i][0], cred[j][0], x]);
    debt[i][1] -= x; cred[j][1] -= x; if (debt[i][1] < 0.5) i++; if (cred[j][1] < 0.5) j++;
  }
  return { bal, paid, owe, xs };
}
function viewSettle(t) {
  if (peopleOf(t).length < 2) return '<div class="empty"><b>동행인을 초대해 주세요</b>오른쪽 위 설정에서 초대 링크를 보내면, 참여한 사람끼리 자동으로 정산돼요.</div>';
  const { bal, paid, owe, xs } = settle(t); const people = Object.keys(bal);
  const text = xs.length ? `[${t.name} 정산]\n` + xs.map(([a, b, x]) => `${a} → ${b} ${won(x)}`).join('\n') : '';
  return `<div class="card"><h3>보낼 돈</h3>
    ${xs.length ? xs.map(([a, b, x]) => `<div class="xfer">${esc(a)} <span class="arrow">→</span> ${esc(b)}<span class="m">${won(x)}</span></div>`).join('')
      + `<button class="btn ghost block small" data-act="copy" data-text="${esc(text)}" style="margin-top:4px">정산 내역 복사하기</button>`
    : '<div class="muted small">정산할 금액이 없어요. 깔끔!</div>'}</div>
  <div class="card"><h3>사람별 내역</h3>
    ${people.map((m) => `<div class="bal"><div><b>${esc(m)}</b><div class="small muted">결제 ${won(paid[m])} · 부담 ${won(owe[m])}</div></div>
      <div class="mono ${bal[m] > 0.5 ? 'pos' : bal[m] < -0.5 ? 'neg' : ''}">${bal[m] > 0.5 ? '+' : ''}${won(bal[m])}</div></div>`).join('')}</div>
  <p class="small muted" style="padding:0 4px">외화 지출은 설정의 환율로 원화 환산해서 계산해요.</p>`;
}

/* ---------------- sheets ---------------- */
function openSheet(html, onMount) {
  closeSheet();
  const s = document.createElement('div'); s.className = 'scrim'; s.id = 'scrim';
  s.innerHTML = `<div class="sheet" role="dialog">${html}</div>`;
  s.addEventListener('click', (e) => { if (e.target === s) closeSheet(); });
  document.body.appendChild(s); document.body.classList.add('noscroll');
  onMount?.(s.querySelector('.sheet'));
}
function closeSheet() { $('scrim')?.remove(); document.body.classList.remove('noscroll'); }
function askConfirm(msg, okLabel, fn) {
  openSheet(`<h2>${esc(msg)}</h2><div class="rowbtns"><button class="btn ghost" data-x="no">취소</button><button class="btn danger" data-x="yes">${esc(okLabel)}</button></div>`, (sh) => {
    sh.querySelector('[data-x=no]').onclick = closeSheet;
    sh.querySelector('[data-x=yes]').onclick = () => { closeSheet(); fn(); };
  });
}
function pills(name, opts, sel, multi) {
  return `<div class="pills" data-pills="${name}" data-multi="${multi ? 1 : 0}">${opts.map((o) => `<button type="button" class="pill ${(multi ? sel.includes(o) : sel === o) ? 'on' : ''}" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>`;
}
function wirePills(sh) {
  sh.querySelectorAll('[data-pills]').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('.pill'); if (!b) return;
    if (g.dataset.multi === '1') b.classList.toggle('on');
    else { g.querySelectorAll('.pill').forEach((p) => p.classList.remove('on')); b.classList.add('on'); }
  }));
}
const pillVal = (sh, n) => [...sh.querySelectorAll(`[data-pills="${n}"] .pill.on`)].map((p) => p.dataset.v);
const fval = (sh) => (n) => sh.querySelector(`[name=${n}]`).value.trim();

/* trip settings */
function tripForm(t) {
  const isNew = !t;
  t = t || { name: '', city: '', start: '', end: '', currency: 'KRW', rate: 1 };
  const isOwner = !isNew && t.ownerId === S.user.uid;
  const joined = Object.values(t.memberNames || {});
  openSheet(`<h2>${isNew ? '새 여행' : '여행 설정'}</h2>
    <label class="f"><span>여행 이름</span><input class="inp" name="name" value="${esc(t.name)}" placeholder="예: 오사카 먹방 여행"></label>
    <label class="f"><span>도시</span><input class="inp" name="city" value="${esc(t.city)}" placeholder="예: 오사카"><div class="hint">지도 위치랑 장소 검색할 때 써요.</div></label>
    <div class="two"><label class="f"><span>출발</span><input class="inp" type="date" name="start" value="${esc(t.start)}"></label>
      <label class="f"><span>도착</span><input class="inp" type="date" name="end" value="${esc(t.end)}"></label></div>
    <div class="two"><label class="f"><span>현지 통화</span><select class="inp" name="currency">${CURRENCIES.map((c) => `<option ${c === t.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="f"><span id="rateLbl">기본 환율</span><input class="inp" type="number" step="any" inputmode="decimal" name="rate" value="${esc(String(Math.round((Number(t.rate) || 1) * rateUnit(t.currency) * 10000) / 10000))}"><div class="hint" id="rateHint"></div></label></div>
    ${isNew ? '' : `<div class="card soft"><h3>동행인 초대</h3>
      <p class="small muted">링크를 받은 사람이 구글 로그인하면 이 여행을 같이 보고 수정할 수 있어요. 정산·'누구랑?'·탑승자는 여기 참여한 사람 기준이에요.</p>
      <div class="joined">${(t.members || []).map((u) => `<span class="jm">${avatar(u, 24, t.memberNames?.[u])}${esc(S.profiles.get(u)?.name || t.memberNames?.[u] || '?')}${u === t.ownerId ? ' <small>(방장)</small>' : ''}</span>`).join('') || '-'}</div>
      <button class="btn ghost block" data-x="invite">초대 링크 만들기</button><div id="invOut"></div></div>`}
    ${isNew ? '' : '<button type="button" class="btn ghost block" data-x="recap" style="margin-bottom:10px">🎞 여행 리캡 보기</button>'}
    <div class="rowbtns">${isOwner ? '<button class="btn danger" data-x="del">삭제</button>' : ''}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    const v = fval(sh); wirePills(sh);
    sh.querySelector('[data-x=recap]')?.addEventListener('click', () => { closeSheet(); openRecap(t); });
    const rateUi = () => {
      const cur = v('currency'); const unit = rateUnit(cur);
      sh.querySelector('#rateLbl').textContent = cur === 'KRW' ? '기본 환율' : `기본 환율 (${unit} ${cur} = ? 원)`;
      sh.querySelector('#rateHint').textContent = cur === 'KRW' ? '원화 여행이면 신경 안 써도 돼요' : unit === 100 ? `예: 100엔 = 920원이면 920` : `예: 1 ${cur} = 1,400원이면 1400`;
    };
    rateUi(); sh.querySelector('[name=currency]').addEventListener('change', rateUi);
    sh.querySelector('[data-x=save]').onclick = async () => {
      if (!v('name')) return toast('여행 이름을 적어 주세요');
      let start = v('start'), end = v('end'); if (start && end && end < start) [start, end] = [end, start];
      const data = {
        name: v('name'), city: v('city'), start, end: end || start, currency: v('currency'),
        rate: (Number(v('rate')) || 1) / rateUnit(v('currency')),
      };
      if (!isNew && data.city !== t.city) data.geo = null; // 도시 바뀌면 날씨 위치 다시 찾기
      closeSheet();
      if (isNew) {
        const id = uid();
        await write(() => setDoc(doc(db, 'trips', id), {
          ...data, ownerId: S.user.uid, members: [S.user.uid], memberNames: { [S.user.uid]: me() }, createdAt: Date.now(),
        }));
        S.tab = 'plan'; openTrip(id);
      } else await write(() => updateDoc(doc(db, 'trips', t.id), data));
    };
    sh.querySelector('[data-x=invite]')?.addEventListener('click', async () => {
      let code = t.inviteCode;
      if (!code) {
        code = randCode(14);
        await write(async () => {
          await setDoc(doc(db, 'invites', code), { tripId: t.id, createdBy: S.user.uid, createdAt: Date.now() });
          await updateDoc(doc(db, 'trips', t.id), { inviteCode: code });
        });
      }
      const url = `${location.origin}/?join=${code}`;
      sh.querySelector('#invOut').innerHTML = `<div class="invlink mono">${esc(url)}</div>
        <div class="rowbtns"><button class="btn ghost" data-x="cp">링크 복사</button>${navigator.share ? '<button class="btn pri" data-x="sh">공유하기</button>' : ''}</div>`;
      sh.querySelector('[data-x=cp]').onclick = () => copy(url, '초대 링크를 복사했어요');
      sh.querySelector('[data-x=sh]')?.addEventListener('click', () => navigator.share({ title: `${t.name} 초대`, text: `여행노트에서 '${t.name}' 같이 보자!`, url }).catch(() => {}));
    });
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => askConfirm(`'${t.name}' 여행을 삭제할까요? 일정·항공권·가계부가 모두 지워지고 되돌릴 수 없어요.`, '삭제', () => deleteTrip(t)));
  });
}
async function deleteTripData(t) {
  const id = t.id;
  for (const name of ['items', 'expenses', 'flights', 'files', 'places']) {
    const snap = await getDocs(collection(db, 'trips', id, name));
    let batch = writeBatch(db); let n = 0;
    for (const d of snap.docs) { batch.delete(d.ref); if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); } }
    await batch.commit();
  }
  if (t.inviteCode) await deleteDoc(doc(db, 'invites', t.inviteCode));
  await deleteDoc(doc(db, 'trips', id));
}
async function deleteTrip(t) {
  openTrip(null);
  await write(() => deleteTripData(t));
  toast('삭제했어요');
}

/* item */
function itemForm(t, item) {
  const isNew = !item; const days = tripDays(t);
  item = item || { date: S.day, time: '', title: '', memo: '', cat: '관광', link: '' };
  let picked = item.lat != null ? { lat: item.lat, lng: item.lng, address: item.address || '', placeId: item.placeId || null } : null;
  const linked = item.expenseId ? S.expenses.find((e) => e.id === item.expenseId) : null;
  const spCurs = [...new Set([t.currency || 'KRW', 'KRW'])];
  const people = peopleOf(t);
  openSheet(`<h2>${isNew ? '일정 추가' : '일정 수정'}</h2>
    ${mapsEnabled ? '<label class="f"><span>장소 검색</span><div id="placeBox" class="placebox"><div class="small muted">검색창 불러오는 중…</div></div><div class="hint">고르면 지도에 핀이 찍혀요. 장소가 아닌 일정은 아래 이름만 적어도 돼요.</div></label>' : ''}
    <div id="pickedBox"></div>
    <label class="f"><span>이름</span><input class="inp" name="title" value="${esc(item.title)}" placeholder="예: 도톤보리"></label>
    <div class="two"><label class="f"><span>날짜</span><select class="inp" name="date">${days.map((d, i) => `<option value="${esc(d)}" ${d === item.date ? 'selected' : ''}>Day ${i + 1}${d.startsWith('day') ? '' : ' · ' + esc(md(d))}</option>`).join('')}</select></label>
      <div class="f"><span class="flbl">시간</span>${timeField('time', item.time)}</div></div>
    ${people.length > 1 ? `<label class="f"><span>누구랑? (따로 다니면 일부만 선택)</span>${pills('who', people, item.who && item.who.length ? item.who : people, true)}</label>` : ''}
    <label class="f"><span>분류</span>${pills('cat', Object.keys(ICATS), item.cat || '관광')}</label>
    <label class="f"><span>메모</span><textarea class="inp" name="memo" placeholder="예약번호, 추천 메뉴, 영업시간…">${esc(item.memo)}</textarea></label>
    <label class="f"><span>링크 (선택)</span><input class="inp" name="link" value="${esc(item.link)}" placeholder="https://"></label>
    <div class="spendbox"><span class="flbl">💸 여기서 쓴 돈 (가계부에 자동 기록)</span>
      <div class="two"><input class="inp mono" type="number" step="any" inputmode="decimal" name="spend" value="${esc(linked?.amount ?? '')}" placeholder="0" style="flex:2">${pills('scur', spCurs, linked?.cur || spCurs[0])}</div>
      ${people.length > 1 ? `<div style="margin-top:8px"><span class="flbl">결제한 사람</span>${pills('spayer', people, linked?.payer || (people.includes(myName(t)) ? myName(t) : people[0]))}</div>
      <div style="margin-top:8px"><span class="flbl">나눌 사람</span>${pills('ssplit', people, linked?.split || item.who || people, true)}</div>` : ''}
      <div class="hint">정산 탭에 바로 반영돼요.</div></div>
    <div class="rowbtns">${isNew ? '' : '<button class="btn danger" data-x="del">삭제</button>'}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    wirePills(sh); wireTimeFields(sh, '일정 시간'); const v = fval(sh);
    // '누구랑?'을 바꾸면 돈 나눌 사람도 같이 맞춤 (지출이 아직 없을 때)
    sh.querySelector('[data-pills=who]')?.addEventListener('click', () => setTimeout(() => {
      if (linked) return; const w = pillVal(sh, 'who');
      sh.querySelectorAll('[data-pills=ssplit] .pill').forEach((b) => b.classList.toggle('on', w.includes(b.dataset.v)));
    }));
    const showPicked = () => {
      sh.querySelector('#pickedBox').innerHTML = picked ? `<div class="picked">📍 ${esc(picked.address || '위치 저장됨')} <button type="button" class="lnk" data-x="unpick">위치 빼기</button></div>` : '';
      sh.querySelector('[data-x=unpick]')?.addEventListener('click', () => { picked = null; showPicked(); });
    };
    showPicked();
    if (mapsEnabled) {
      const near = mapCtl?.map?.getCenter?.() ? { center: mapCtl.map.getCenter(), radius: 30000 } : undefined;
      mountPlaceSearch(sh.querySelector('#placeBox'), (p) => {
        picked = { lat: p.lat, lng: p.lng, address: p.address, placeId: p.placeId };
        sh.querySelector('[name=title]').value = p.name; showPicked();
      }, near).catch(() => { sh.querySelector('#placeBox').innerHTML = '<div class="small muted">장소 검색을 불러오지 못했어요</div>'; });
    }
    sh.querySelector('[data-x=save]').onclick = async () => {
      if (!v('title')) return toast('장소나 할 일을 적어 주세요');
      let link = v('link'); if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
      const data = {
        title: v('title'), date: v('date'), time: v('time'), memo: v('memo'), link, cat: pillVal(sh, 'cat')[0] || '기타',
        lat: picked?.lat ?? null, lng: picked?.lng ?? null, address: picked?.address || '', placeId: picked?.placeId || null,
        who: (() => { const w = pillVal(sh, 'who'); return people.length > 1 && w.length && w.length < people.length ? w : null; })(),
      };
      if (people.length > 1 && !pillVal(sh, 'who').length) return toast('누구랑 가는지 한 명 이상 골라 주세요');
      const spend = Number(sh.querySelector('[name=spend]').value);
      const itemId = isNew ? uid() : item.id;
      closeSheet(); S.day = data.date;
      await write(async () => {
        // 쓴 돈 → 가계부 지출로 연결 (있으면 수정, 비우면 삭제)
        let expenseId = item.expenseId || null;
        if (spend > 0) {
          const exp = {
            title: data.title, amount: spend, cur: pillVal(sh, 'scur')[0] || spCurs[0], cat: SPEND_CAT[data.cat] || '기타',
            payer: pillVal(sh, 'spayer')[0] || linked?.payer || people[0], split: (() => { const x = pillVal(sh, 'ssplit'); return x.length ? x : linked?.split || [...people]; })(), date: data.date.startsWith('day') ? fmtD(new Date()) : data.date, itemId,
          };
          if (expenseId && linked) await updateDoc(doc(db, 'trips', t.id, 'expenses', expenseId), exp);
          else { expenseId = uid(); await setDoc(doc(db, 'trips', t.id, 'expenses', expenseId), { ...exp, createdAt: Date.now(), by: S.user.uid }); }
        } else if (expenseId) { await deleteDoc(doc(db, 'trips', t.id, 'expenses', expenseId)); expenseId = null; }
        data.expenseId = expenseId;
        if (isNew || data.date !== item.date) data.pos = insertPos(data.date, data.time, itemId);
        if (isNew) await setDoc(doc(db, 'trips', t.id, 'items', itemId), { ...data, done: false, createdAt: Date.now(), by: S.user.uid });
        else await updateDoc(doc(db, 'trips', t.id, 'items', itemId), data);
      });
    };
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => askConfirm(`'${item.title}' 일정을 삭제할까요?${item.expenseId ? ' 연결된 지출도 같이 지워져요.' : ''}`, '삭제', () => write(async () => { if (item.expenseId) await deleteDoc(doc(db, 'trips', t.id, 'expenses', item.expenseId)); await deleteDoc(doc(db, 'trips', t.id, 'items', item.id)); })));
  });
}

/* memo (장소·시간 없이 메모만) */
function memoForm(t, m) {
  const isNew = !m; const days = tripDays(t);
  m = m || { date: S.day, memo: '' };
  openSheet(`<h2>${isNew ? '메모 추가' : '메모 수정'}</h2>
    <label class="f"><span>메모</span><textarea class="inp" name="memo" rows="5" placeholder="예: 숙소 체크인 15시, 짐 맡기기 / 환전 잊지 말기">${esc(m.memo)}</textarea></label>
    <label class="f"><span>날짜</span><select class="inp" name="date">${days.map((d, i) => `<option value="${esc(d)}" ${d === m.date ? 'selected' : ''}>Day ${i + 1}${d.startsWith('day') ? '' : ' · ' + esc(md(d))}</option>`).join('')}</select></label>
    <p class="small muted" style="margin:-4px 0 12px">맨 아래에 붙어요. '순서 바꾸기'로 끌어서 원하는 위치로 옮길 수 있어요.</p>
    <div class="rowbtns">${isNew ? '' : '<button class="btn danger" data-x="del">삭제</button>'}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    const v = fval(sh);
    setTimeout(() => sh.querySelector('[name=memo]').focus(), 50);
    sh.querySelector('[data-x=save]').onclick = async () => {
      if (!v('memo')) return toast('메모를 적어 주세요');
      const data = { kind: 'memo', memo: v('memo'), date: v('date'), title: '', time: '' };
      if (isNew || data.date !== m.date) data.pos = insertPos(data.date, '', m.id);
      closeSheet(); S.day = data.date;
      if (isNew) await write(() => setDoc(doc(db, 'trips', t.id, 'items', uid()), { ...data, createdAt: Date.now(), by: S.user.uid }));
      else await write(() => updateDoc(doc(db, 'trips', t.id, 'items', m.id), data));
    };
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => askConfirm('이 메모를 삭제할까요?', '삭제', () => write(() => deleteDoc(doc(db, 'trips', t.id, 'items', m.id)))));
  });
}

/* flight */
function flightForm(t, f) {
  const isNew = !f;
  const plusH = (dt, h) => { if (!dt) return ''; const d = new Date(dt + ':00'); d.setHours(d.getHours() + h); return `${fmtD(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const isReturn = S.flights.length > 0;
  const defDep = isReturn ? (t.end ? t.end + 'T15:00' : '') : (t.start ? t.start + 'T09:00' : '');
  f = f || { kind: isReturn ? '오는편' : '가는편', airline: '', flightNo: '', from: '', to: '', depAt: defDep, arrAt: plusH(defDep, 2), bookingRef: '', seat: '', terminal: '', baggage: '', memo: '', who: [me()] };
  // 탑승자 후보: 정산용 이름 + 앱 참여자 이름 + 이미 지정된 사람
  const whoOpts = [...new Set([...peopleOf(t), ...(f.who || [])].filter(Boolean))];
  const whoSel = f.who || (f.by && t.memberNames?.[f.by] ? [t.memberNames[f.by]] : []);
  openSheet(`<h2>${isNew ? '항공권 추가' : '항공권 수정'}</h2>
    <label class="f"><span>구분</span>${pills('kind', ['가는편', '오는편', '경유·기타'], f.kind)}</label>
    <label class="f"><span>탑승자 (이 비행기 타는 사람)</span>${pills('who', whoOpts, whoSel, true)}</label>
    <div class="two"><label class="f"><span>항공사</span><input class="inp" name="airline" value="${esc(f.airline)}" placeholder="예: 제주항공"></label>
      <label class="f"><span>편명</span><input class="inp mono" name="flightNo" value="${esc(f.flightNo)}" placeholder="예: 7C1301" autocapitalize="characters"></label></div>
    <div class="two"><label class="f"><span>출발 공항</span><input class="inp mono" name="from" value="${esc(f.from)}" placeholder="ICN" autocapitalize="characters"></label>
      <label class="f"><span>도착 공항</span><input class="inp mono" name="to" value="${esc(f.to)}" placeholder="KIX" autocapitalize="characters"></label></div>
    <div class="f"><span class="flbl">출발 (출발지 현지 시각)</span><div class="two"><input class="inp" type="date" name="depDate" value="${esc((f.depAt || '').slice(0, 10))}">${timeField('depTime', (f.depAt || '').slice(11, 16), '출발 시간')}</div></div>
    <div class="f"><span class="flbl">도착 (도착지 현지 시각)</span><div class="two"><input class="inp" type="date" name="arrDate" value="${esc((f.arrAt || '').slice(0, 10))}">${timeField('arrTime', (f.arrAt || '').slice(11, 16), '도착 시간')}</div></div>
    <div class="two"><label class="f"><span>예약번호</span><input class="inp mono" name="bookingRef" value="${esc(f.bookingRef)}" autocapitalize="characters"></label>
      <label class="f"><span>좌석</span><input class="inp" name="seat" value="${esc(f.seat)}" placeholder="예: 23A"></label></div>
    <div class="two"><label class="f"><span>터미널</span><input class="inp" name="terminal" value="${esc(f.terminal)}" placeholder="예: T1"></label>
      <label class="f"><span>수하물</span><input class="inp" name="baggage" value="${esc(f.baggage)}" placeholder="예: 15kg"></label></div>
    <label class="f"><span>메모</span><textarea class="inp" name="memo" placeholder="체크인 시간, 탑승 게이트…">${esc(f.memo)}</textarea></label>
    <div class="f"><span class="flbl">체크인 QR · 모바일 탑승권 사진 (최대 4장)</span>
      <div class="qredit" id="qrEdit"></div>
      <label class="btn ghost block" style="margin-top:8px">📷 사진 추가<input type="file" accept="image/*" multiple hidden id="qrFile"></label>
      <div class="hint">캡처한 QR이나 탑승권 화면을 넣어두면 공항에서 바로 꺼내 볼 수 있어요.</div></div>
    <div class="rowbtns">${isNew ? '' : '<button class="btn danger" data-x="del">삭제</button>'}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    wirePills(sh); wireTimeFields(sh, '비행기 시간'); const v = fval(sh);
    // 출발일 고르면 도착일 비어 있을 때 같은 날로
    // 출발을 바꾸면 도착을 '출발 + 같은 비행시간'으로 따라 맞춤 (기본 2시간). 도착을 직접 고치면 그 간격 유지
    const getDT = (p) => { const d = sh.querySelector(`[name=${p}Date]`).value, h = sh.querySelector(`[name=${p}Time]`).value; return d && h ? `${d}T${h}` : ''; };
    let gapH = (() => { const a = getDT('dep'), b = getDT('arr'); return a && b ? Math.max(0, (new Date(b) - new Date(a)) / 36e5) : 2; })();
    const setArr = (dt) => {
      if (!dt) return;
      sh.querySelector('[name=arrDate]').value = dt.slice(0, 10);
      const hid = sh.querySelector('[name=arrTime]'); hid.value = dt.slice(11, 16);
      const btn = sh.querySelector('[data-timefield=arrTime]'); btn.textContent = hid.value; btn.classList.remove('empty');
    };
    const followDep = () => { const dep = getDT('dep'); if (dep) setArr(plusHf(dep, gapH)); };
    const plusHf = (dt, h) => { const d = new Date(dt + ':00'); d.setMinutes(d.getMinutes() + Math.round(h * 60)); return `${fmtD(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    sh.querySelector('[name=depDate]').addEventListener('change', followDep);
    sh.querySelector('[name=depTime]').addEventListener('change', followDep);
    const onArr = () => { const a = getDT('dep'), b = getDT('arr'); if (a && b && new Date(b) >= new Date(a)) gapH = (new Date(b) - new Date(a)) / 36e5; };
    sh.querySelector('[name=arrDate]').addEventListener('change', onArr);
    sh.querySelector('[name=arrTime]').addEventListener('change', onArr);
    // 사진 목록: 기존(id) + 새로 넣은 것(data) — 저장 누를 때 반영
    let qrs = (f.qrIds || []).map((id) => ({ id, data: qrCache.get(id) && qrCache.get(id) !== 'loading' ? qrCache.get(id) : null }));
    const removed = [];
    const drawQr = () => {
      sh.querySelector('#qrEdit').innerHTML = qrs.map((q, k) => `<div class="qrthumb">${q.data ? `<img src="${q.data}" alt="">` : '<span>QR</span>'}<button type="button" class="qrdel" data-k="${k}" aria-label="삭제">×</button></div>`).join('');
      // 사진 삭제는 한 번 더 눌러야 (× → '삭제?' → 삭제)
      sh.querySelectorAll('.qrdel').forEach((b) => b.onclick = () => {
        if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = '삭제?'; setTimeout(() => { if (b.isConnected) { b.classList.remove('armed'); b.textContent = '×'; } }, 3000); return; }
        const [q] = qrs.splice(Number(b.dataset.k), 1); if (q.id && !q.isNew) removed.push(q.id); drawQr();
      });
    };
    drawQr();
    qrs.filter((q) => !q.data).forEach((q) => loadQr(t, q.id).then((d) => { q.data = d; drawQr(); }));
    sh.querySelector('#qrFile').addEventListener('change', async (ev) => {
      const files = [...ev.target.files].slice(0, 4 - qrs.length);
      if (!files.length) return toast('사진은 4장까지 넣을 수 있어요');
      for (const file of files) {
        try { qrs.push({ id: uid(), data: await compressImage(file), isNew: true }); }
        catch { toast('사진을 읽지 못했어요'); }
      }
      ev.target.value = ''; drawQr();
    });
    const saveQrs = async (flightId) => {
      for (const q of qrs.filter((x) => x.isNew)) {
        await setDoc(doc(db, 'trips', t.id, 'files', q.id), { flightId, data: q.data, createdAt: Date.now(), by: S.user.uid });
        qrCache.set(q.id, q.data);
      }
      for (const id of removed) { await deleteDoc(doc(db, 'trips', t.id, 'files', id)); qrCache.delete(id); }
      return qrs.map((q) => q.id);
    };
    sh.querySelector('[data-x=save]').onclick = async () => {
      if (!v('depDate') || !v('depTime')) return toast('출발 날짜와 시간을 넣어 주세요');
      const depAt = `${v('depDate')}T${v('depTime')}`;
      const arrAt = v('arrDate') && v('arrTime') ? `${v('arrDate')}T${v('arrTime')}` : '';
      const data = {
        kind: pillVal(sh, 'kind')[0] || '항공편', airline: v('airline'), flightNo: v('flightNo').toUpperCase(),
        from: v('from').toUpperCase(), to: v('to').toUpperCase(), depAt, arrAt,
        bookingRef: v('bookingRef').toUpperCase(), seat: v('seat'), terminal: v('terminal'), baggage: v('baggage'), memo: v('memo'),
        who: pillVal(sh, 'who'),
      };
      const fid = isNew ? uid() : f.id;
      const btn = sh.querySelector('[data-x=save]'); btn.disabled = true; btn.textContent = '저장 중…';
      await write(async () => {
        data.qrIds = await saveQrs(fid);
        if (isNew) await setDoc(doc(db, 'trips', t.id, 'flights', fid), { ...data, createdAt: Date.now(), by: S.user.uid });
        else await updateDoc(doc(db, 'trips', t.id, 'flights', fid), data);
      });
      closeSheet();
    };
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => askConfirm(`${f.from || ''}→${f.to || ''} 항공권을 삭제할까요?${(f.qrIds || []).length ? ' QR 사진도 같이 지워져요.' : ''}`, '삭제', () => {
      write(async () => {
        for (const id of f.qrIds || []) await deleteDoc(doc(db, 'trips', t.id, 'files', id));
        await deleteDoc(doc(db, 'trips', t.id, 'flights', f.id));
      });
    }));
  });
}

/* expense */
function expForm(t, e) {
  const isNew = !e; const people = peopleOf(t);
  const today = fmtD(new Date()); const days = tripDays(t);
  e = e || { title: '', amount: '', cur: t.currency || 'KRW', payer: people.includes(myName(t)) ? myName(t) : people[0], split: [...people], date: days.includes(today) ? today : (days[0].startsWith('day') ? today : days[0]), cat: '식비' };
  const curs = [...new Set([t.currency || 'KRW', 'KRW'])];
  openSheet(`<h2>${isNew ? '지출 추가' : '지출 수정'}</h2>
    <label class="f"><span>내용</span><input class="inp" name="title" value="${esc(e.title)}" placeholder="예: 이치란 라멘"></label>
    <div class="two"><label class="f" style="flex:2"><span>금액</span><input class="inp mono" type="number" step="any" inputmode="decimal" name="amount" value="${esc(e.amount)}" placeholder="0"></label>
      <label class="f"><span>통화</span>${pills('cur', curs, e.cur || curs[0])}</label></div>
    <div id="rateBox"></div>
    <label class="f"><span>분류</span>${pills('cat', Object.keys(ECATS), e.cat || '기타')}</label>
    <label class="f"><span>결제한 사람</span>${pills('payer', people, e.payer)}</label>
    <label class="f"><span>나눌 사람</span>${pills('split', people, e.split || people, true)}</label>
    <label class="f"><span>날짜</span><input class="inp" type="date" name="date" value="${esc(e.date)}"></label>
    <div class="rowbtns">${isNew ? '' : '<button class="btn danger" data-x="del">삭제</button>'}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    wirePills(sh); const v = fval(sh);
    // 외화일 때: 이 지출에 적용할 환율 (카드 결제 환율 등) — 기본값은 여행 설정 환율
    let rateTyped = e.rate ? String(Math.round(e.rate * rateUnit(e.cur) * 10000) / 10000) : '';
    const rateBox = sh.querySelector('#rateBox');
    const curNow = () => pillVal(sh, 'cur')[0] || curs[0];
    const preview = () => {
      const cur = curNow(); const unit = rateUnit(cur); const amt = Number(sh.querySelector('[name=amount]').value) || 0;
      const r = (Number(sh.querySelector('[name=rate]')?.value) || (Number(t.rate) || 0) * unit) / unit;
      const p = sh.querySelector('#ratePrev'); if (p) p.textContent = amt ? `≈ ${won(amt * r)}` : '';
    };
    const drawRate = () => {
      const cur = curNow();
      if (cur === 'KRW') { rateBox.innerHTML = ''; return; }
      const unit = rateUnit(cur);
      rateBox.innerHTML = `<label class="f"><span>환율 (${unit} ${esc(cur)} = ? 원)</span>
        <div class="two" style="align-items:center"><input class="inp mono" type="number" step="any" inputmode="decimal" name="rate" value="${esc(rateTyped)}" placeholder="${esc(String(Math.round((Number(t.rate) || 0) * unit * 100) / 100))}">
        <b id="ratePrev" class="mono" style="flex:1;text-align:right"></b></div>
        <div class="hint">비워두면 여행 기본 환율(${esc(rateLabel(cur, t.rate))})로 계산해요. 카드 결제 환율을 넣으면 정산이 더 정확해요.</div></label>`;
      rateBox.querySelector('[name=rate]').addEventListener('input', (ev) => { rateTyped = ev.target.value; preview(); });
      preview();
    };
    drawRate();
    sh.querySelector('[data-pills=cur]').addEventListener('click', () => setTimeout(drawRate));
    sh.querySelector('[name=amount]').addEventListener('input', preview);
    sh.querySelector('[data-x=save]').onclick = async () => {
      const amount = Number(v('amount'));
      if (!v('title') || !(amount > 0)) return toast('내용과 금액을 확인해 주세요');
      const split = pillVal(sh, 'split'); if (!split.length) return toast('나눌 사람을 한 명 이상 골라 주세요');
      const cur = curNow(); const rIn = Number(sh.querySelector('[name=rate]')?.value);
      const data = { title: v('title'), amount, cur, rate: cur !== 'KRW' && rIn > 0 ? rIn / rateUnit(cur) : null, cat: pillVal(sh, 'cat')[0] || '기타', payer: pillVal(sh, 'payer')[0] || people[0], split, date: v('date') };
      closeSheet();
      if (isNew) await write(() => setDoc(doc(db, 'trips', t.id, 'expenses', uid()), { ...data, createdAt: Date.now(), by: S.user.uid }));
      else await write(() => updateDoc(doc(db, 'trips', t.id, 'expenses', e.id), data));
    };
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => askConfirm(`'${e.title}' 지출을 삭제할까요?`, '삭제', () => write(async () => { await deleteDoc(doc(db, 'trips', t.id, 'expenses', e.id)); if (e.itemId) await updateDoc(doc(db, 'trips', t.id, 'items', e.itemId), { expenseId: null }).catch(() => {}); })));
  });
}

function accountSheet() {
  const uidMe = S.user.uid;
  const cur = S.profiles.get(uidMe) || {};
  let photo = cur.photo || null; let noGoogle = !!cur.noGooglePhoto;
  openSheet(`<h2>내 프로필</h2>
    <div class="profile-top">
      <div id="pfAv" class="pf-av"></div>
      <div class="pf-btns">
        <label class="btn ghost small">📷 사진 바꾸기<input type="file" accept="image/*" hidden id="pfFile"></label>
        <button type="button" class="btn ghost small" data-x="google">${S.user.photoURL ? '구글 사진 쓰기' : '기본 이미지'}</button>
        <button type="button" class="btn ghost small" data-x="none">사진 없이</button>
      </div>
    </div>
    <label class="f"><span>이름 (동행인에게 보이는 이름)</span><input class="inp" name="pname" value="${esc(me())}"></label>
    <p class="small muted" style="margin:-4px 0 14px">${esc(S.user.email || '')} 로 로그인 중</p>
    <div class="rowbtns"><button class="btn ghost" data-x="out">로그아웃</button><button class="btn dark" data-x="save">저장</button></div>
    <div class="danger-zone"><b>계정 탈퇴</b><p class="small muted">내 로그인 정보와 프로필이 삭제돼요. 나만 있는 여행은 통째로 지워지고, 동행인과 함께 쓰는 여행에서는 나만 빠져요(동행인 데이터는 그대로 남아요).</p>
      <button class="btn danger block" data-x="delete">탈퇴하기</button></div>`, (sh) => {
    const drawAv = () => {
      const p = photo || (!noGoogle ? S.user.photoURL : null);
      sh.querySelector('#pfAv').innerHTML = p ? `<img src="${esc(p)}" alt="" referrerpolicy="no-referrer">` : `<span>${esc([...me()][0] || '?')}</span>`;
    };
    drawAv();
    sh.querySelector('#pfFile').addEventListener('change', async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      try { photo = await compressAvatar(f); noGoogle = true; drawAv(); } catch { toast('사진을 읽지 못했어요'); }
    });
    sh.querySelector('[data-x=google]').onclick = () => { photo = null; noGoogle = false; drawAv(); };
    sh.querySelector('[data-x=none]').onclick = () => { photo = null; noGoogle = true; drawAv(); };
    sh.querySelector('[data-x=out]').onclick = () => { closeSheet(); logout(); };
    sh.querySelector('[data-x=save]').onclick = async () => {
      const name = sh.querySelector('[name=pname]').value.trim() || S.user.displayName || '나';
      closeSheet();
      await write(async () => {
        await setDoc(doc(db, 'users', uidMe), { name, photo: photo || null, noGooglePhoto: noGoogle, updatedAt: Date.now() });
        // 참여 중인 여행들에 보이는 이름도 갱신
        for (const t of S.trips) {
          const old = t.memberNames?.[uidMe];
          await updateDoc(doc(db, 'trips', t.id), { [`memberNames.${uidMe}`]: name });
          if (old && old !== name) await renameInTrip(t.id, old, name);
        }
      });
      toast('프로필을 저장했어요');
    };
    sh.querySelector('[data-x=delete]').onclick = () => askConfirm('정말 탈퇴할까요? 되돌릴 수 없어요.', '탈퇴하기', startDeleteAccount);
  });
}
/** 이름이 바뀌면 그 여행의 결제자·나눌 사람·누구랑·탑승자 이름도 같이 바꾸기 */
async function renameInTrip(tripId, from, to) {
  const swap = (arr) => (Array.isArray(arr) && arr.includes(from) ? [...new Set(arr.map((x) => (x === from ? to : x)))] : null);
  const batch = writeBatch(db); let n = 0;
  for (const col of ['expenses', 'items', 'flights']) {
    const snap = await getDocs(collection(db, 'trips', tripId, col));
    snap.forEach((d) => {
      const x = d.data(); const up = {};
      if (col === 'expenses') { if (x.payer === from) up.payer = to; const sp = swap(x.split); if (sp) up.split = sp; }
      const w = swap(x.who); if (w) up.who = w;
      if (Object.keys(up).length && n < 450) { batch.update(d.ref, up); n++; }
    });
  }
  if (n) await batch.commit();
}
async function compressAvatar(file) {
  // 정사각형으로 잘라 256px
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(img.width, img.height); const c = document.createElement('canvas'); c.width = c.height = 256;
    c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
    return c.toDataURL('image/jpeg', 0.85);
  } finally { URL.revokeObjectURL(url); }
}

/* ---------- 계정 탈퇴 ---------- */
async function startDeleteAccount() {
  try {
    localStorage.setItem(DELETE_FLAG, '1'); // 리디렉트로 본인 확인하면 돌아와서 이어서 진행
    const r = await reauth();
    if (r === 'redirect') return;
    localStorage.removeItem(DELETE_FLAG);
    await doDeleteAccount();
  } catch (e) {
    localStorage.removeItem(DELETE_FLAG);
    console.error(e); toast('본인 확인을 하지 못해서 탈퇴를 멈췄어요');
  }
}
async function doDeleteAccount() {
  const u = S.user; if (!u) return;
  $('view').innerHTML = '<div class="empty"><b>탈퇴 처리 중…</b>잠시만 기다려 주세요.</div>';
  try {
    S.unsubTrips?.(); S.unsubSub.forEach((f) => f()); S.unsubSub = []; S.unsubMe?.();
    const snap = await getDocs(query(collection(db, 'trips'), where('members', 'array-contains', u.uid)));
    for (const d of snap.docs) {
      const t = { id: d.id, ...d.data() };
      const others = (t.members || []).filter((x) => x !== u.uid);
      if (!others.length) await deleteTripData(t);
      else {
        await updateDoc(doc(db, 'trips', t.id), {
          members: others, [`memberNames.${u.uid}`]: deleteField(),
          ...(t.ownerId === u.uid ? { ownerId: others[0] } : {}),
        });
      }
    }
    await deleteDoc(doc(db, 'users', u.uid));
    await deleteMe();
    toast('탈퇴가 완료됐어요. 그동안 고마웠어요!');
  } catch (e) {
    console.error(e);
    toast(e?.code === 'auth/requires-recent-login' ? '보안을 위해 다시 로그인한 뒤 탈퇴해 주세요' : '탈퇴 중 문제가 생겼어요. 다시 시도해 주세요');
    location.reload();
  }
}

/* ---------------- events ---------------- */
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]'); if (!el || el.closest('.sheet')) return;
  if (ev.target.closest('a')) return; // 링크는 그대로 열기
  const a = el.dataset.act, id = el.dataset.id, t = trip();
  switch (a) {
    case 'open': S.tab = 'plan'; openTrip(id); break;
    case 'home': openTrip(null); break;
    case 'account': accountSheet(); break;
    case 'newTrip': tripForm(null); break;
    case 'editTrip': tripForm(t); break;
    case 'tab': S.tab = el.dataset.v; render(); window.scrollTo(0, 0); break;
    case 'day': S.day = el.dataset.v; S.mapAll = false; render(); break;
    case 'newItem': itemForm(t, null); break;
    case 'editItem': ev.stopPropagation(); itemForm(t, S.items.find((i) => i.id === id)); break;
    case 'newMemo': memoForm(t, null); break;
    case 'recap': openRecap(t); break;
    case 'editMemo': memoForm(t, S.items.find((i) => i.id === id)); break;
    case 'focus': { const i = S.items.find((x) => x.id === id); if (i && mapCtl) { mapCtl.focus({ lat: i.lat, lng: i.lng }); window.scrollTo({ top: 0, behavior: 'smooth' }); } break; }
    case 'toggleDone': { ev.stopPropagation(); const i = S.items.find((x) => x.id === id); if (i) write(() => updateDoc(doc(db, 'trips', t.id, 'items', id), { done: !i.done })); break; }
    case 'newFlight': flightForm(t, null); break;
    case 'editFlight': flightForm(t, S.flights.find((x) => x.id === id)); break;
    case 'newExp': expForm(t, null); break;
    case 'editExp': expForm(t, S.expenses.find((x) => x.id === id)); break;
    case 'copy': copy(el.dataset.text); break;
    case 'settime': {
      const i = S.items.find((x) => x.id === id); if (!i) break;
      openTimeWheel(i.time, `${i.title} 시간`, (v) => { i.time = v; render(); write(() => updateDoc(doc(db, 'trips', t.id, 'items', id), { time: v })); });
      break;
    }
    case 'ordering': S.ordering = !S.ordering; render(); break;
    case 'viewAs': S.viewAs = el.dataset.v || null; render(); document.querySelector('.days')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); break;
    case 'wishcat': S.wishCat = el.dataset.v; render(); break;
    case 'newWish': wishForm(t, null); break;
    case 'editWish': wishForm(t, S.places.find((x) => x.id === id)); break;
    case 'toPlan': toPlanSheet(t, S.places.find((x) => x.id === id)); break;
    case 'focusWish': { const p = S.places.find((x) => x.id === id); if (p && mapCtl && ll(p)) { mapCtl.focus({ lat: p.lat, lng: p.lng }); window.scrollTo({ top: 0, behavior: 'smooth' }); } break; }
    case 'qrview': ev.stopPropagation(); openQrViewer(el.dataset.flight, Number(el.dataset.idx || 0)); break;
  }
}, true);

document.addEventListener('change', (ev) => {
  const t = trip(); if (!t) return;
  const sel = ev.target.closest('.segsel');
  if (sel) {
    const id = sel.dataset.id;
    // 알아서 고른 수단과 같은 걸 고르면 계속 자동, 다른 걸 고르면 그 구간만 고정
    const mm = sel.value === sel.dataset.auto ? null : sel.value;
    const st = stopMap.get(id)?.to; if (!st) return;
    const src = st._col === 'items' ? S.items.find((x) => x.id === st._doc) : S.flights.find((x) => x.id === st._doc);
    if (src) src[st._mmk] = mm; // 즉시 반영
    write(() => updateDoc(doc(db, 'trips', t.id, st._col, st._doc), { [st._mmk]: mm }));
    render();
  }
});

window.addEventListener('scroll', () => $('hdr')?.classList.toggle('scrolled', scrollY > 4), { passive: true });
render();
