import './style.css';
import {
  auth, db, login, logout, watchAuth, reauth, deleteMe,
  collection, doc, query, where, onSnapshot, setDoc, updateDoc, deleteDoc,
  getDoc, arrayUnion, writeBatch, getDocs, deleteField,
} from './firebase.js';
import { createMap, mountPlaceSearch, mapsEnabled, computeRoute } from './maps.js';
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
  S.tripId = id; S.day = null; S.mapAll = false; S.ordering = false; S.wishCat = 'all';
  if (id) {
    const sub = (name) => onSnapshot(collection(db, 'trips', id, name), (s) => {
      S[name] = s.docs.map((d) => ({ id: d.id, ...d.data() })); render();
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
      <button class="avstack" data-act="editTrip" aria-label="참여자">${(t.members || []).slice(0, 5).map((u) => avatar(u, 26, t.memberNames?.[u])).join('')}${(t.members || []).length > 5 ? `<span class="av more">+${t.members.length - 5}</span>` : ''}</button>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${S.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}">${l}</button>`).join('')}</div>
    ${body}</div>`;
  const fab = { plan: ['newItem', '+ 일정 추가'], wish: ['newWish', '+ 찜하기'], flight: ['newFlight', '+ 항공권 추가'], money: ['newExp', '+ 지출 추가'] }[S.tab];
  $('fabhost').innerHTML = fab && !(S.tab === 'plan' && S.ordering) ? `<button class="btn pri fab" data-act="${fab[0]}">${fab[1]}</button>` : '';
  if (S.tab === 'plan') { drawPlanMap(t, days); fillSegments(t); loadWeather(t, days); }
  else if (S.tab === 'wish') drawWishMap(t);
  else showMap(false);
  if (S.tab === 'flight') loadQrThumbs(t);
}

/* ---------- plan ---------- */
// 정렬: 시간 있는 일정은 시간 순. 시간 없는 일정은 'after'(어느 시간 뒤에 둘지) + order로 자유 배치
const ordOf = (i) => (i.order ?? i.createdAt ?? 0);
const sortKey = (i) => (i.time ? [i.time, 0, ordOf(i)] : [i.after ?? '99:99', 1, ordOf(i)]);
function cmpItems(a, b) {
  const x = sortKey(a), y = sortKey(b);
  return x[0].localeCompare(y[0]) || x[1] - y[1] || x[2] - y[2];
}
function dayItems(d) { return S.items.filter((i) => i.date === d).sort(cmpItems); }

async function moveItem(t, id, dir) {
  const list = dayItems(S.day); const k = list.findIndex((i) => i.id === id);
  const cur = list[k], nb = list[k + dir]; if (!cur || !nb) return;
  const ref = (i) => doc(db, 'trips', t.id, 'items', i.id);
  if (cur.time) {
    if (nb.time === cur.time) {
      return write(async () => { await updateDoc(ref(cur), { order: ordOf(nb) }); await updateDoc(ref(nb), { order: ordOf(cur) }); });
    }
    return toast('시간이 있는 일정은 시간 순서가 우선이에요. 시간을 바꾸거나 지워 주세요.');
  }
  let after, order;
  if (!nb.time) {
    // 시간 없는 일정끼리: 같은 자리 그룹에서 앞뒤로
    after = nb.after ?? '99:99';
    const beyond = list[k + 2 * dir];
    const sameGroup = beyond && !beyond.time && (beyond.after ?? '99:99') === after;
    order = sameGroup ? (ordOf(nb) + ordOf(beyond)) / 2 : ordOf(nb) + dir;
  } else if (dir > 0) {
    // 시간 있는 일정 아래로 넘어가기 → 그 시간 바로 뒤 첫 번째
    after = nb.time;
    const grp = list.filter((i) => !i.time && (i.after ?? '99:99') === after);
    order = grp.length ? Math.min(...grp.map(ordOf)) - 1 : Date.now();
  } else {
    // 시간 있는 일정 위로 넘어가기 → 그 앞 시간 그룹 맨 뒤 (맨 위면 '')
    const prevTimed = list.slice(0, k + dir).reverse().find((i) => i.time);
    after = prevTimed ? prevTimed.time : '';
    const grp = list.filter((i) => !i.time && i.id !== cur.id && (i.after ?? '99:99') === after);
    order = grp.length ? Math.max(...grp.map(ordOf)) + 1 : Date.now();
  }
  Object.assign(cur, { after, order }); render(); // 바로 반영
  write(() => updateDoc(ref(cur), { after, order }));
}
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

function viewPlan(t, days) {
  const items = dayItems(S.day);
  const fls = dayFlights(S.day);
  const rows = [
    ...fls.map((f) => ({ kind: 'flight', time: f.time, f })),
    ...items.map((i) => ({ kind: 'item', time: i.time, i })),
  ].sort((a, b) => {
    // 항공편은 시간 기준, 일정은 수동 순서(시간 우선) 그대로
    const ka = a.kind === 'flight' ? [a.time || '99:99', -1, 0] : sortKey(a.i);
    const kb = b.kind === 'flight' ? [b.time || '99:99', -1, 0] : sortKey(b.i);
    return ka[0].localeCompare(kb[0]) || ka[1] - kb[1] || ka[2] - kb[2];
  });
  let n = 0;
  const pinNo = new Map(); items.forEach((i) => { if (ll(i)) pinNo.set(i.id, ++n); });
  // 위치 있는 장소끼리 바로 앞 장소 → 이 장소 구간
  const prevOf = new Map(); let last = null;
  items.forEach((i) => { if (ll(i)) { if (last) prevOf.set(i.id, last); last = i; } });
  const W = S.weatherFor === t.id ? S.weather : {};
  const wx = W[S.day];
  return `<div class="days">${days.map((d, idx) => {
    const c = dayItems(d).length; const w = W[d];
    return `<button class="day ${d === S.day ? 'on' : ''}" data-act="day" data-v="${esc(d)}" style="--dc:${DAYCOLORS[idx % DAYCOLORS.length]}"><b>Day ${idx + 1}</b><span>${d.startsWith('day') ? '' : esc(md(d))}${c ? ' · ' + c : ''}</span>${w ? `<i class="dwx">${w.emoji} ${Math.round(w.max)}°</i>` : ''}</button>`;
  }).join('')}</div>
  ${wx ? `<div class="wxbar ${wx.kind}"><span class="wxe">${wx.emoji}</span><div><b>${esc(wx.text || '')} ${Math.round(wx.max)}° / ${Math.round(wx.min)}°</b>
      <span>${wx.kind === 'forecast' ? (wx.pop != null ? `강수확률 ${wx.pop}%` : '예보') : `작년 이맘때 날씨 (예보는 10일 전부터)${wx.rain ? ` · 비 ${Math.round(wx.rain)}mm` : ''}`}</span></div></div>` : ''}
  ${items.length > 1 ? `<div class="planbar"><button class="ordbtn ${S.ordering ? 'on' : ''}" data-act="ordering">${S.ordering ? '✓ 순서 편집 끝' : '↕ 순서 바꾸기'}</button></div>` : ''}
  ${rows.length ? `<div class="timeline">${rows.map((r) => r.kind === 'flight' ? flightRow(r.f)
    : (!S.ordering && prevOf.has(r.i.id) ? segRow(t, prevOf.get(r.i.id), r.i) : '') + itemRow(t, r.i, pinNo.get(r.i.id), items)).join('')}</div>`
    : '<div class="empty"><b>이 날 일정이 비어 있어요</b>가고 싶은 곳을 추가해 보세요.</div>'}`;
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
const segMode = (t, i) => i.moveMode || t.defaultMove || 'transit';
const segKey = (from, to, mode) => [from.id, from.lat, from.lng, to.lat, to.lng, mode].join('|');
const segCache = new Map(); // key -> {meters,secs} | {none} | 'loading' | {err}
function segRow(t, from, to) {
  const mode = segMode(t, to);
  const dir = `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&travelmode=${MOVES[mode][3]}`;
  return `<div class="seg" data-seg="${esc(to.id)}">
    <select class="segsel" data-act="segmode" data-id="${esc(to.id)}" aria-label="이동 수단">
      ${Object.entries(MOVES).map(([k, v]) => `<option value="${k}" ${k === mode ? 'selected' : ''}>${v[0]} ${v[1]}</option>`).join('')}
    </select>
    <span class="seginfo" data-seginfo="${esc(to.id)}">${segText(from, to, mode)}</span>
    <a class="seglink" href="${esc(dir)}" target="_blank" rel="noopener">길찾기</a>
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
    const R = 6371000, toR = (x) => (x * Math.PI) / 180;
    const a = Math.sin(toR(to.lat - from.lat) / 2) ** 2 + Math.cos(toR(from.lat)) * Math.cos(toR(to.lat)) * Math.sin(toR(to.lng - from.lng) / 2) ** 2;
    const straight = 2 * R * Math.asin(Math.sqrt(a));
    return `<span class="muted">이 지역은 ${MOVES[mode][1]} 시간 미제공 · 직선 ${fmtDist(straight)} → 길찾기에서 확인</span>`;
  }
  return `<b>${fmtDur(r.secs)}</b> · ${fmtDist(r.meters)}`;
}
async function fillSegments(t) {
  if (!mapsEnabled) return;
  const items = dayItems(S.day).filter(ll);
  for (let k = 1; k < items.length; k++) {
    const from = items[k - 1], to = items[k], mode = segMode(t, to);
    if (segResult(from, to, mode)) continue;
    const key = segKey(from, to, mode); segCache.set(key, 'loading');
    computeRoute(from, to, MOVES[mode][2], from.time || to.time).then((r) => {
      const res = r?.none ? { none: true } : r;
      segCache.set(key, { ...res, key });
      updateDoc(doc(db, 'trips', t.id, 'items', to.id), { move: { ...res, key } }).catch(() => {});
      const el = document.querySelector(`[data-seginfo="${CSS.escape(to.id)}"]`);
      if (el) el.innerHTML = segText(from, to, mode);
    }).catch((e) => {
      console.error(e); segCache.set(key, { err: true });
      const el = document.querySelector(`[data-seginfo="${CSS.escape(to.id)}"]`);
      if (el) el.innerHTML = segText(from, to, mode);
    });
  }
}
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
    <div class="imemo">${esc(sub)}${dep && f.bookingRef ? ' · 예약 ' + esc(f.bookingRef) : ''}${dep && (f.qrIds || []).length ? ' · 📱 QR' : ''}</div></div></div></div>`;
}
function itemRow(t, i, no, list) {
  const c = ICATS[i.cat] || ICATS.기타;
  if (S.ordering) {
    const k = list.findIndex((x) => x.id === i.id);
    return `<div class="item ordering" style="--cat:${c[1]}"><div class="irow">
      <div class="itime">${esc(i.time || '—')}</div>
      <div style="flex:1;min-width:0"><div class="ititle">${esc(i.title)}</div>${i.time ? '<div class="iaddr">시간 순 고정</div>' : '<div class="iaddr">자유롭게 이동</div>'}</div>
      <div class="ordctl"><button data-act="mv" data-dir="-1" data-id="${esc(i.id)}" ${k === 0 ? 'disabled' : ''} aria-label="위로">▲</button><button data-act="mv" data-dir="1" data-id="${esc(i.id)}" ${k === list.length - 1 ? 'disabled' : ''} aria-label="아래로">▼</button></div>
    </div></div>`;
  }
  return `<div class="item ${i.done ? 'done' : ''}" style="--cat:${c[1]}" ${ll(i) ? `data-act="focus" data-id="${esc(i.id)}"` : ''}>
    <div class="irow"><button class="itime tbtn ${i.time ? '' : 'empty'}" data-act="settime" data-id="${esc(i.id)}" aria-label="시간 변경">${esc(i.time || '시간')}</button>
      <div style="flex:1;min-width:0"><div class="ititle">${no ? `<span class="pinno" style="background:${c[1]}">${no}</span>` : ''}${esc(i.title)}</div>
      ${i.address ? `<div class="iaddr">${esc(i.address)}</div>` : ''}
      ${i.memo ? `<div class="imemo">${esc(i.memo)}</div>` : ''}
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
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => { closeSheet(); write(() => deleteDoc(doc(db, 'trips', t.id, 'places', p.id))); });
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
          done: false, createdAt: Date.now(), by: S.user.uid, fromWish: p.id,
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
  const n = (t.people || []).length || 1;
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
  const people = t.people || []; const bal = {}, paid = {}, owe = {};
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
  const people = t.people || [];
  if (people.length < 2) return '<div class="empty"><b>같이 가는 사람을 추가해 주세요</b>오른쪽 위 설정에서 이름을 넣으면 자동으로 정산돼요.</div>';
  const { bal, paid, owe, xs } = settle(t);
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
  t = t || { name: '', city: '', start: '', end: '', currency: 'KRW', rate: 1, people: [me()] };
  const isOwner = !isNew && t.ownerId === S.user.uid;
  const joined = Object.values(t.memberNames || {});
  openSheet(`<h2>${isNew ? '새 여행' : '여행 설정'}</h2>
    <label class="f"><span>여행 이름</span><input class="inp" name="name" value="${esc(t.name)}" placeholder="예: 오사카 먹방 여행"></label>
    <label class="f"><span>도시</span><input class="inp" name="city" value="${esc(t.city)}" placeholder="예: 오사카"><div class="hint">지도 위치랑 장소 검색할 때 써요.</div></label>
    <div class="two"><label class="f"><span>출발</span><input class="inp" type="date" name="start" value="${esc(t.start)}"></label>
      <label class="f"><span>도착</span><input class="inp" type="date" name="end" value="${esc(t.end)}"></label></div>
    <div class="two"><label class="f"><span>현지 통화</span><select class="inp" name="currency">${CURRENCIES.map((c) => `<option ${c === t.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="f"><span id="rateLbl">기본 환율</span><input class="inp" type="number" step="any" inputmode="decimal" name="rate" value="${esc(String(Math.round((Number(t.rate) || 1) * rateUnit(t.currency) * 10000) / 10000))}"><div class="hint" id="rateHint"></div></label></div>
    <label class="f"><span>장소 사이 기본 이동수단</span>${pills('move', Object.values(MOVES).map((m) => m[0] + ' ' + m[1]), (MOVES[t.defaultMove || 'transit'] || MOVES.transit).slice(0, 2).join(' '))}<div class="hint">일정 화면에서 구간마다 바꿀 수도 있어요.</div></label>
    <label class="f"><span>같이 가는 사람 (정산용, 쉼표로 구분)</span><input class="inp" name="people" value="${esc((t.people || []).join(', '))}" placeholder="예: 진주, 민지, 수아"></label>
    ${isNew ? '' : `<div class="card soft"><h3>동행인 초대</h3>
      <p class="small muted">링크를 받은 사람이 구글 로그인하면 이 여행을 같이 보고 수정할 수 있어요.</p>
      <div class="joined">${(t.members || []).map((u) => `<span class="jm">${avatar(u, 24, t.memberNames?.[u])}${esc(S.profiles.get(u)?.name || t.memberNames?.[u] || '?')}${u === t.ownerId ? ' <small>(방장)</small>' : ''}</span>`).join('') || '-'}</div>
      <button class="btn ghost block" data-x="invite">초대 링크 만들기</button><div id="invOut"></div></div>`}
    <div class="rowbtns">${isOwner ? '<button class="btn danger" data-x="del">삭제</button>' : ''}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    const v = fval(sh); wirePills(sh);
    const rateUi = () => {
      const cur = v('currency'); const unit = rateUnit(cur);
      sh.querySelector('#rateLbl').textContent = cur === 'KRW' ? '기본 환율' : `기본 환율 (${unit} ${cur} = ? 원)`;
      sh.querySelector('#rateHint').textContent = cur === 'KRW' ? '원화 여행이면 신경 안 써도 돼요' : unit === 100 ? `예: 100엔 = 920원이면 920` : `예: 1 ${cur} = 1,400원이면 1400`;
    };
    rateUi(); sh.querySelector('[name=currency]').addEventListener('change', rateUi);
    sh.querySelector('[data-x=save]').onclick = async () => {
      if (!v('name')) return toast('여행 이름을 적어 주세요');
      let start = v('start'), end = v('end'); if (start && end && end < start) [start, end] = [end, start];
      const mvLabel = pillVal(sh, 'move')[0] || '';
      const defaultMove = Object.keys(MOVES).find((k) => MOVES[k].slice(0, 2).join(' ') === mvLabel) || 'transit';
      const data = {
        name: v('name'), city: v('city'), start, end: end || start, currency: v('currency'),
        rate: (Number(v('rate')) || 1) / rateUnit(v('currency')), defaultMove,
        people: [...new Set(v('people').split(/[,，]/).map((s) => s.trim()).filter(Boolean))],
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
  openSheet(`<h2>${isNew ? '일정 추가' : '일정 수정'}</h2>
    ${mapsEnabled ? '<label class="f"><span>장소 검색</span><div id="placeBox" class="placebox"><div class="small muted">검색창 불러오는 중…</div></div><div class="hint">고르면 지도에 핀이 찍혀요. 장소가 아닌 일정은 아래 이름만 적어도 돼요.</div></label>' : ''}
    <div id="pickedBox"></div>
    <label class="f"><span>이름</span><input class="inp" name="title" value="${esc(item.title)}" placeholder="예: 도톤보리"></label>
    <div class="two"><label class="f"><span>날짜</span><select class="inp" name="date">${days.map((d, i) => `<option value="${esc(d)}" ${d === item.date ? 'selected' : ''}>Day ${i + 1}${d.startsWith('day') ? '' : ' · ' + esc(md(d))}</option>`).join('')}</select></label>
      <div class="f"><span class="flbl">시간</span>${timeField('time', item.time)}</div></div>
    <label class="f"><span>분류</span>${pills('cat', Object.keys(ICATS), item.cat || '관광')}</label>
    <label class="f"><span>메모</span><textarea class="inp" name="memo" placeholder="예약번호, 추천 메뉴, 영업시간…">${esc(item.memo)}</textarea></label>
    <label class="f"><span>링크 (선택)</span><input class="inp" name="link" value="${esc(item.link)}" placeholder="https://"></label>
    <div class="rowbtns">${isNew ? '' : '<button class="btn danger" data-x="del">삭제</button>'}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    wirePills(sh); wireTimeFields(sh, '일정 시간'); const v = fval(sh);
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
      };
      closeSheet(); S.day = data.date;
      if (isNew) await write(() => setDoc(doc(db, 'trips', t.id, 'items', uid()), { ...data, done: false, createdAt: Date.now(), by: S.user.uid }));
      else await write(() => updateDoc(doc(db, 'trips', t.id, 'items', item.id), data));
    };
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => { closeSheet(); write(() => deleteDoc(doc(db, 'trips', t.id, 'items', item.id))); });
  });
}

/* flight */
function flightForm(t, f) {
  const isNew = !f;
  f = f || { kind: S.flights.length ? '오는편' : '가는편', airline: '', flightNo: '', from: '', to: '', depAt: t.start ? t.start + 'T09:00' : '', arrAt: '', bookingRef: '', seat: '', terminal: '', baggage: '', memo: '' };
  openSheet(`<h2>${isNew ? '항공권 추가' : '항공권 수정'}</h2>
    <label class="f"><span>구분</span>${pills('kind', ['가는편', '오는편', '경유·기타'], f.kind)}</label>
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
    sh.querySelector('[name=depDate]').addEventListener('change', (e) => { const a = sh.querySelector('[name=arrDate]'); if (!a.value) a.value = e.target.value; });
    // 사진 목록: 기존(id) + 새로 넣은 것(data) — 저장 누를 때 반영
    let qrs = (f.qrIds || []).map((id) => ({ id, data: qrCache.get(id) && qrCache.get(id) !== 'loading' ? qrCache.get(id) : null }));
    const removed = [];
    const drawQr = () => {
      sh.querySelector('#qrEdit').innerHTML = qrs.map((q, k) => `<div class="qrthumb">${q.data ? `<img src="${q.data}" alt="">` : '<span>QR</span>'}<button type="button" class="qrdel" data-k="${k}" aria-label="삭제">×</button></div>`).join('');
      sh.querySelectorAll('.qrdel').forEach((b) => b.onclick = () => { const [q] = qrs.splice(Number(b.dataset.k), 1); if (q.id && !q.isNew) removed.push(q.id); drawQr(); });
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
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => {
      closeSheet();
      write(async () => {
        for (const id of f.qrIds || []) await deleteDoc(doc(db, 'trips', t.id, 'files', id));
        await deleteDoc(doc(db, 'trips', t.id, 'flights', f.id));
      });
    });
  });
}

/* expense */
function expForm(t, e) {
  const isNew = !e; const people = t.people || [];
  if (!people.length) { toast('설정에서 같이 가는 사람을 먼저 넣어 주세요'); return tripForm(t); }
  const today = fmtD(new Date()); const days = tripDays(t);
  e = e || { title: '', amount: '', cur: t.currency || 'KRW', payer: people.includes(me()) ? me() : people[0], split: [...people], date: days.includes(today) ? today : (days[0].startsWith('day') ? today : days[0]), cat: '식비' };
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
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => { closeSheet(); write(() => deleteDoc(doc(db, 'trips', t.id, 'expenses', e.id))); });
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
        for (const t of S.trips) await updateDoc(doc(db, 'trips', t.id), { [`memberNames.${uidMe}`]: name });
      });
      toast('프로필을 저장했어요');
    };
    sh.querySelector('[data-x=delete]').onclick = () => askConfirm('정말 탈퇴할까요? 되돌릴 수 없어요.', '탈퇴하기', startDeleteAccount);
  });
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
    case 'mv': moveItem(t, id, Number(el.dataset.dir)); break;
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
    const it = S.items.find((x) => x.id === id); if (it) it.moveMode = sel.value; // 즉시 반영
    write(() => updateDoc(doc(db, 'trips', t.id, 'items', id), { moveMode: sel.value }));
    render();
  }
});

window.addEventListener('scroll', () => $('hdr')?.classList.toggle('scrolled', scrollY > 4), { passive: true });
render();
