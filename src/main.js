import './style.css';
import {
  auth, db, login, logout, watchAuth,
  collection, doc, query, where, onSnapshot, setDoc, updateDoc, deleteDoc,
  getDoc, arrayUnion, writeBatch, getDocs,
} from './firebase.js';
import { createMap, mountPlaceSearch, mapsEnabled } from './maps.js';
import {
  esc, uid, randCode, won, num, md, hm, parseD, fmtD, tripDays, dday,
  ICATS, ECATS, DAYCOLORS, CURRENCIES, toast, copy,
} from './util.js';

/* ---------------- state ---------------- */
const S = {
  user: null, authReady: false,
  trips: [], tripsLoaded: false,
  tripId: null, items: [], expenses: [], flights: [],
  tab: 'plan', day: null, mapAll: false,
  unsubTrips: null, unsubSub: [],
};
const params = new URLSearchParams(location.search);
let pendingJoin = params.get('join');

const $ = (id) => document.getElementById(id);
const trip = () => S.trips.find((t) => t.id === S.tripId);
const me = () => S.user?.displayName || S.user?.email?.split('@')[0] || '나';

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
  S.unsubTrips?.(); S.unsubSub.forEach((f) => f()); S.unsubSub = [];
  S.trips = []; S.tripsLoaded = false; S.tripId = null;
  if (u) {
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
  S.items = []; S.expenses = []; S.flights = [];
  S.tripId = id; S.day = null; S.mapAll = false;
  if (id) {
    const sub = (name) => onSnapshot(collection(db, 'trips', id, name), (s) => {
      S[name] = s.docs.map((d) => ({ id: d.id, ...d.data() })); render();
    }, (e) => console.error(name, e));
    S.unsubSub.push(sub('items'), sub('expenses'), sub('flights'));
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
  $('hdr').innerHTML = `<h1>여행노트</h1><button class="iconbtn" data-act="account" aria-label="계정">${I.user}</button>`;
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
  const tabs = [['plan', '일정'], ['flight', '항공권'], ['money', '가계부'], ['settle', '정산']];
  let body = '';
  if (S.tab === 'plan') body = viewPlan(t, days);
  else if (S.tab === 'flight') body = viewFlights(t);
  else if (S.tab === 'money') body = viewMoney(t);
  else body = viewSettle(t);
  $('view').innerHTML = `<div class="wrap">
    <div class="tripmeta">
      ${t.city ? `<span class="chip">📍 ${esc(t.city)}</span>` : ''}
      ${t.start ? `<span class="chip">${esc(md(t.start))}${t.end && t.end !== t.start ? ' – ' + esc(md(t.end)) : ''}</span>` : ''}
      ${dday(t) ? `<span class="chip accent">${esc(dday(t))}</span>` : ''}
      ${(t.people || []).map((m) => `<span class="chip">${esc(m)}</span>`).join('')}
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${S.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}">${l}</button>`).join('')}</div>
    ${body}</div>`;
  const fab = { plan: ['newItem', '+ 일정 추가'], flight: ['newFlight', '+ 항공권 추가'], money: ['newExp', '+ 지출 추가'] }[S.tab];
  $('fabhost').innerHTML = fab ? `<button class="btn pri fab" data-act="${fab[0]}">${fab[1]}</button>` : '';
  if (S.tab === 'plan') drawPlanMap(t, days); else showMap(false);
}

/* ---------- plan ---------- */
function dayItems(d) {
  return S.items.filter((i) => i.date === d)
    .sort((a, b) => (a.time || '99').localeCompare(b.time || '99') || (a.createdAt || 0) - (b.createdAt || 0));
}
function dayFlights(d) {
  const out = [];
  S.flights.forEach((f) => {
    if (f.depAt?.slice(0, 10) === d) out.push({ ...f, _kind: 'dep', time: hm(f.depAt) });
    if (f.arrAt?.slice(0, 10) === d && f.arrAt.slice(0, 10) !== f.depAt?.slice(0, 10)) out.push({ ...f, _kind: 'arr', time: hm(f.arrAt) });
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
  ].sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
  let n = 0;
  const pinNo = new Map(); items.forEach((i) => { if (ll(i)) pinNo.set(i.id, ++n); });
  return `<div class="days">${days.map((d, idx) => {
    const c = dayItems(d).length; return `<button class="day ${d === S.day ? 'on' : ''}" data-act="day" data-v="${esc(d)}" style="--dc:${DAYCOLORS[idx % DAYCOLORS.length]}"><b>Day ${idx + 1}</b><span>${d.startsWith('day') ? '' : esc(md(d))}${c ? ' · ' + c : ''}</span></button>`;
  }).join('')}</div>
  ${rows.length ? `<div class="timeline">${rows.map((r) => r.kind === 'flight' ? flightRow(r.f) : itemRow(t, r.i, pinNo.get(r.i.id))).join('')}</div>`
    : '<div class="empty"><b>이 날 일정이 비어 있어요</b>가고 싶은 곳을 추가해 보세요.</div>'}`;
}
function flightRow(f) {
  const dep = f._kind === 'dep';
  return `<div class="item flightrow" style="--cat:#1F2A44" data-act="tab" data-v="flight">
    <div class="irow"><div class="itime">${esc(f.time || '--:--')}</div>
    <div style="flex:1;min-width:0"><div class="ititle">✈️ ${esc(f.from || '?')} → ${esc(f.to || '?')} ${dep ? '출발' : '도착'}</div>
    <div class="imemo">${esc([f.airline, f.flightNo].filter(Boolean).join(' '))}${f.bookingRef ? ' · 예약 ' + esc(f.bookingRef) : ''}</div></div></div></div>`;
}
function itemRow(t, i, no) {
  const c = ICATS[i.cat] || ICATS.기타;
  return `<div class="item ${i.done ? 'done' : ''}" style="--cat:${c[1]}" ${ll(i) ? `data-act="focus" data-id="${esc(i.id)}"` : ''}>
    <div class="irow"><div class="itime">${esc(i.time || '--:--')}</div>
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
  $('mapToggle').textContent = S.mapAll ? '이 날만 보기' : '전체 일정 보기';
  const r = routeUrl(t, dayItems(S.day));
  $('routeLink').hidden = !r || S.mapAll; if (r) $('routeLink').href = r;
}
function showMap(on) { $('mapwrap').hidden = !on; }

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
      <div class="iactions" style="margin-top:10px">
        ${f.flightNo ? `<a class="lnk map" target="_blank" rel="noopener" href="https://www.google.com/search?q=${encodeURIComponent((f.flightNo || '').replace(/\s/g, '') + ' 항공편')}">운항 상태</a>` : ''}
        <button class="lnk" data-act="editFlight" data-id="${esc(f.id)}">수정</button>
      </div></div>`;
  }).join('');
}

/* ---------- money ---------- */
function toKRW(t, e) { const a = Number(e.amount) || 0; return e.cur === 'KRW' ? a : a * (Number(t.rate) || 1); }
function viewMoney(t) {
  const list = [...S.expenses].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
  const total = list.reduce((s, e) => s + toKRW(t, e), 0);
  const byCat = {}; list.forEach((e) => { byCat[e.cat || '기타'] = (byCat[e.cat || '기타'] || 0) + toKRW(t, e); });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const n = (t.people || []).length || 1;
  const groups = {}; list.forEach((e) => { (groups[e.date || '날짜 없음'] ||= []).push(e); });
  return `<div class="sum"><div class="lbl">총 지출 ${t.currency && t.currency !== 'KRW' ? `· 1 ${esc(t.currency)} = ${esc(t.rate || '?')}원` : ''}</div>
    <div class="big">${won(total)}</div>
    <div class="bars">${total ? cats.map(([c, v]) => `<div style="width:${(v / total) * 100}%;background:${ECATS[c] || '#888'}"></div>`).join('') : ''}</div>
    <div class="legend">${cats.map(([c, v]) => `<span><i style="background:${ECATS[c] || '#888'}"></i>${esc(c)} ${won(v)}</span>`).join('')}${total ? `<span>· 1인당 약 ${won(total / n)}</span>` : ''}</div></div>
  ${list.length ? Object.entries(groups).map(([d, es]) => `<div class="dategrp">${esc(d.includes('-') ? md(d) : d)} · ${won(es.reduce((s, e) => s + toKRW(t, e), 0))}</div>
    ${es.map((e) => {
      const col = ECATS[e.cat] || '#888'; const local = e.cur !== 'KRW' && t.currency && t.currency !== 'KRW';
      return `<button class="exp" data-act="editExp" data-id="${esc(e.id)}">
        <div class="ico" style="background:${col}22;color:${col}">${esc((e.cat || '기타').slice(0, 2))}</div>
        <div style="min-width:0"><div class="t">${esc(e.title)}</div><div class="s">${esc(e.payer || '?')} 결제 · ${(e.split || []).length === n ? '모두' : esc((e.split || []).join(', '))}</div></div>
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
      <label class="f"><span>환율 (1단위 = 원)</span><input class="inp" type="number" step="any" inputmode="decimal" name="rate" value="${esc(t.rate)}"><div class="hint">엔화면 1엔 기준 (예: 9.2)</div></label></div>
    <label class="f"><span>같이 가는 사람 (정산용, 쉼표로 구분)</span><input class="inp" name="people" value="${esc((t.people || []).join(', '))}" placeholder="예: 진주, 민지, 수아"></label>
    ${isNew ? '' : `<div class="card soft"><h3>동행인 초대</h3>
      <p class="small muted">링크를 받은 사람이 구글 로그인하면 이 여행을 같이 보고 수정할 수 있어요.</p>
      <div class="small" style="margin:6px 0">참여 중: ${joined.map(esc).join(', ') || '-'}</div>
      <button class="btn ghost block" data-x="invite">초대 링크 만들기</button><div id="invOut"></div></div>`}
    <div class="rowbtns">${isOwner ? '<button class="btn danger" data-x="del">삭제</button>' : ''}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    const v = fval(sh);
    sh.querySelector('[data-x=save]').onclick = async () => {
      if (!v('name')) return toast('여행 이름을 적어 주세요');
      let start = v('start'), end = v('end'); if (start && end && end < start) [start, end] = [end, start];
      const data = {
        name: v('name'), city: v('city'), start, end: end || start, currency: v('currency'), rate: Number(v('rate')) || 1,
        people: [...new Set(v('people').split(/[,，]/).map((s) => s.trim()).filter(Boolean))],
      };
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
async function deleteTrip(t) {
  const id = t.id; openTrip(null);
  await write(async () => {
    for (const name of ['items', 'expenses', 'flights']) {
      const snap = await getDocs(collection(db, 'trips', id, name));
      let batch = writeBatch(db); let n = 0;
      for (const d of snap.docs) { batch.delete(d.ref); if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); } }
      await batch.commit();
    }
    if (t.inviteCode) await deleteDoc(doc(db, 'invites', t.inviteCode));
    await deleteDoc(doc(db, 'trips', id));
  });
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
      <label class="f"><span>시간</span><input class="inp" type="time" name="time" value="${esc(item.time)}"></label></div>
    <label class="f"><span>분류</span>${pills('cat', Object.keys(ICATS), item.cat || '관광')}</label>
    <label class="f"><span>메모</span><textarea class="inp" name="memo" placeholder="예약번호, 추천 메뉴, 영업시간…">${esc(item.memo)}</textarea></label>
    <label class="f"><span>링크 (선택)</span><input class="inp" name="link" value="${esc(item.link)}" placeholder="https://"></label>
    <div class="rowbtns">${isNew ? '' : '<button class="btn danger" data-x="del">삭제</button>'}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    wirePills(sh); const v = fval(sh);
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
    <label class="f"><span>출발 일시 (출발지 현지 시각)</span><input class="inp" type="datetime-local" name="depAt" value="${esc(f.depAt)}"></label>
    <label class="f"><span>도착 일시 (도착지 현지 시각)</span><input class="inp" type="datetime-local" name="arrAt" value="${esc(f.arrAt)}"></label>
    <div class="two"><label class="f"><span>예약번호</span><input class="inp mono" name="bookingRef" value="${esc(f.bookingRef)}" autocapitalize="characters"></label>
      <label class="f"><span>좌석</span><input class="inp" name="seat" value="${esc(f.seat)}" placeholder="예: 23A"></label></div>
    <div class="two"><label class="f"><span>터미널</span><input class="inp" name="terminal" value="${esc(f.terminal)}" placeholder="예: T1"></label>
      <label class="f"><span>수하물</span><input class="inp" name="baggage" value="${esc(f.baggage)}" placeholder="예: 15kg"></label></div>
    <label class="f"><span>메모</span><textarea class="inp" name="memo" placeholder="체크인 시간, 탑승 게이트…">${esc(f.memo)}</textarea></label>
    <div class="rowbtns">${isNew ? '' : '<button class="btn danger" data-x="del">삭제</button>'}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    wirePills(sh); const v = fval(sh);
    sh.querySelector('[data-x=save]').onclick = async () => {
      if (!v('depAt')) return toast('출발 일시를 넣어 주세요');
      const data = {
        kind: pillVal(sh, 'kind')[0] || '항공편', airline: v('airline'), flightNo: v('flightNo').toUpperCase(),
        from: v('from').toUpperCase(), to: v('to').toUpperCase(), depAt: v('depAt'), arrAt: v('arrAt'),
        bookingRef: v('bookingRef').toUpperCase(), seat: v('seat'), terminal: v('terminal'), baggage: v('baggage'), memo: v('memo'),
      };
      closeSheet();
      if (isNew) await write(() => setDoc(doc(db, 'trips', t.id, 'flights', uid()), { ...data, createdAt: Date.now(), by: S.user.uid }));
      else await write(() => updateDoc(doc(db, 'trips', t.id, 'flights', f.id), data));
    };
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => { closeSheet(); write(() => deleteDoc(doc(db, 'trips', t.id, 'flights', f.id))); });
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
    <label class="f"><span>분류</span>${pills('cat', Object.keys(ECATS), e.cat || '기타')}</label>
    <label class="f"><span>결제한 사람</span>${pills('payer', people, e.payer)}</label>
    <label class="f"><span>나눌 사람</span>${pills('split', people, e.split || people, true)}</label>
    <label class="f"><span>날짜</span><input class="inp" type="date" name="date" value="${esc(e.date)}"></label>
    <div class="rowbtns">${isNew ? '' : '<button class="btn danger" data-x="del">삭제</button>'}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    wirePills(sh); const v = fval(sh);
    sh.querySelector('[data-x=save]').onclick = async () => {
      const amount = Number(v('amount'));
      if (!v('title') || !(amount > 0)) return toast('내용과 금액을 확인해 주세요');
      const split = pillVal(sh, 'split'); if (!split.length) return toast('나눌 사람을 한 명 이상 골라 주세요');
      const data = { title: v('title'), amount, cur: pillVal(sh, 'cur')[0] || curs[0], cat: pillVal(sh, 'cat')[0] || '기타', payer: pillVal(sh, 'payer')[0] || people[0], split, date: v('date') };
      closeSheet();
      if (isNew) await write(() => setDoc(doc(db, 'trips', t.id, 'expenses', uid()), { ...data, createdAt: Date.now(), by: S.user.uid }));
      else await write(() => updateDoc(doc(db, 'trips', t.id, 'expenses', e.id), data));
    };
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => { closeSheet(); write(() => deleteDoc(doc(db, 'trips', t.id, 'expenses', e.id))); });
  });
}

function accountSheet() {
  openSheet(`<h2>계정</h2><p class="muted" style="margin-bottom:14px">${esc(S.user.displayName || '')}<br><span class="small">${esc(S.user.email || '')}</span></p>
    <div class="rowbtns"><button class="btn ghost" data-x="close">닫기</button><button class="btn danger" data-x="out">로그아웃</button></div>`, (sh) => {
    sh.querySelector('[data-x=close]').onclick = closeSheet;
    sh.querySelector('[data-x=out]').onclick = () => { closeSheet(); logout(); };
  });
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
  }
}, true);

window.addEventListener('scroll', () => $('hdr')?.classList.toggle('scrolled', scrollY > 4), { passive: true });
render();
