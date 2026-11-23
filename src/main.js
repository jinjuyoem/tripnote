import './style.css';
import {
  auth, db, login, logout, watchAuth, reauth, deleteMe,
  collection, doc, query, where, onSnapshot, setDoc, updateDoc, deleteDoc,
  getDoc, arrayUnion, writeBatch, getDocs, deleteField, idToken,
} from './firebase.js';
import { createMap, mountPlaceSearch, mapsEnabled, computeRoute, geocodeAirport, geocodeCityG } from './maps.js';
import { tripWeather, geocodeCity } from './weather.js';
import { bump, setMeterUser, UMETERS, ptMonth } from './meter.js';
import { openTimeWheel, timeField, wireTimeFields } from './timewheel.js';
import {
  esc, uid, randCode, won, num, md, hm, parseD, fmtD, tripDays, dday,
  ICATS, ECATS, DAYCOLORS, CURRENCIES, toast, copy,
  rateUnit, MOVES, fmtDur, fmtDist, compressImage, inChina, amapPlaceUrl, amapDirUrl,
} from './util.js';

/* ---------------- state ---------------- */
const S = {
  user: null, authReady: false,
  trips: [], tripsLoaded: false,
  tripId: null, items: [], expenses: [], flights: [], places: [], wishCat: 'all', ordering: false,
  tab: 'plan', day: null, mapAll: false,
  unsubTrips: null, unsubSub: [], unsubMe: null,
  access: null, isAdmin: false, unsubAccess: null, requested: false, // 비공개 베타: 'checking' | 'ok' | 'no'
  profiles: new Map(), // uid -> {name, photo}
  weather: {}, weatherFor: null,
  checks: [], packMine: false, wishSort: 'new', wishHideAdded: (() => { try { return localStorage.getItem('wishHideAdded') === '1'; } catch { return false; } })(), moneyView: 'list', sumLocal: (() => { try { return localStorage.getItem('sumLocal') === '1'; } catch { return false; } })(), fresh: {}, share: null,
};
const DELETE_FLAG = 'tn_pending_delete';
const params = new URLSearchParams(location.search);
let pendingJoin = params.get('join');
const shareCode = params.get('s'); // 보기 전용 공유 링크(?s=코드): 로그인 없이 일정만
// 앱 초대 링크(?hi=1): 로그인하면 사용 요청을 자동으로 보내고, 승인 후 처음 열 때 사용 방법을 띄움
if (params.get('hi')) { try { localStorage.setItem('tn_welcome', '1'); } catch { /* */ } }
const isWelcome = () => { try { return localStorage.getItem('tn_welcome') === '1'; } catch { return false; } };

const $ = (id) => document.getElementById(id);
const trip = () => S.trips.find((t) => t.id === S.tripId);
const pairedFlights = new Set(); // 출발·도착을 한 상자로 보여주는 비행편 id
const me = () => S.profiles.get(S.user?.uid)?.name || S.user?.displayName || S.user?.email?.split('@')[0] || '나';

/* 프로필 사진: 직접 올린 사진 > 구글 사진 > 이름 첫 글자 */
const AV_COLORS = ['#2F6BFF', '#F0532D', '#0A9E62', '#A23ED1', '#F5A623', '#00A3BF'];
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
  return names.map((n) => `<span class="pax">${byName[n] ? avatar(byName[n], 34, n) : `<span class="av" style="width:34px;height:34px;background:#8B95A1;font-size:14px">${esc([...n][0] || '?')}</span>`}<b>${esc(n)}</b></span>`).join('');
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
    <button id="meBtn" class="mebtn" aria-label="내 위치 보기"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></button>
    <div class="mapbar">
      <button id="mapToggle" class="mapbtn"></button>
      <a id="routeLink" class="mapbtn" target="_blank" rel="noopener">구글맵 길찾기</a>
    </div>
  </div>
  <main id="view"></main>
  <div id="fabhost"></div>
  <div id="netbadge" class="netbadge" hidden><i></i><b>오프라인 모드</b><span>바꾼 내용은 연결되면 자동으로 저장돼요</span></div>`;

let mapCtl = null; let mapInitP = null;
async function ensureMap() {
  if (!mapsEnabled) return null;
  if (!mapInitP) mapInitP = createMap($('map')).then((c) => (mapCtl = c)).catch((e) => { console.error(e); mapInitP = null; return null; }); // 오프라인 실패 시 다음에 다시 시도
  return mapInitP;
}
$('mapToggle').onclick = () => { S.mapAll = !S.mapAll; render(); };

/* 내 위치: 누르면 켜고 내 위치로, 켜진 상태에서 내 위치가 이미 가운데면 끄기 */
let meWatch = null, mePos = null, meFirst = false;
function stopMe() {
  if (meWatch != null) navigator.geolocation.clearWatch(meWatch);
  meWatch = null; mePos = null; mapCtl?.setMe(null); $('meBtn').classList.remove('on', 'wait');
}
$('meBtn').onclick = async () => {
  if (!navigator.geolocation) return toast('이 기기에서는 위치를 쓸 수 없어요');
  const ctl = await ensureMap(); if (!ctl) return;
  if (meWatch != null) {
    if (mePos && ctl.centerDist(mePos) > 60) { ctl.focus(mePos); return; }
    if (!mePos) return;
    stopMe(); return;
  }
  $('meBtn').classList.add('wait'); meFirst = true;
  meWatch = navigator.geolocation.watchPosition((p) => {
    mePos = { lat: p.coords.latitude, lng: p.coords.longitude };
    ctl.setMe(mePos, p.coords.accuracy);
    $('meBtn').classList.remove('wait'); $('meBtn').classList.add('on');
    if (meFirst) { meFirst = false; ctl.focus(mePos); }
  }, (err) => {
    stopMe();
    toast(err.code === 1 ? '위치 권한이 꺼져 있어요. 설정에서 위치 접근을 허용해 주세요' : '내 위치를 찾지 못했어요');
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
};
document.addEventListener('visibilitychange', () => { if (document.hidden && meWatch != null) stopMe(); });

/* ---------------- 비공개 베타 (allowlist) ---------------- */
// 저장소가 공개라 관리자 이메일은 SHA-256 해시로만 둠 (firestore.rules의 isAdmin()과 같은 값)
const ADMIN_HASHES = ['8c4c2ef482a22848694d608da19923a106ffc3e525e676ccb67de45bd58b229a'];
const emailOf = (u) => (u?.email || '').trim().toLowerCase();
async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const BETA_NOTE = `<div class="beta-note"><b>🔒 비공개 베타 테스트 중이에요</b>
  <p>지금은 지인에게만 테스트하고 있어요. 사용하려면 승인이 필요해요.</p></div>`;

function stopData() {
  S.unsubTrips?.(); S.unsubSub.forEach((f) => f()); S.unsubSub = []; S.unsubMe?.();
  S.unsubTrips = null; S.unsubMe = null;
  S.trips = []; S.tripsLoaded = false; S.tripId = null;
}

/* ---------------- auth ---------------- */
watchAuth(async (u) => {
  S.user = u; S.authReady = true; setMeterUser(u);
  stopData(); S.unsubAccess?.(); S.unsubAccess = null;
  S.access = null; S.isAdmin = false; S.requested = false;
  if (u && localStorage.getItem(DELETE_FLAG)) { localStorage.removeItem(DELETE_FLAG); render(); return doDeleteAccount(); }
  if (u) {
    S.isAdmin = ADMIN_HASHES.includes(await sha256hex(emailOf(u)));
    if (S.user !== u) return; // 확인하는 사이 계정이 바뀜
    if (S.isAdmin) { S.access = 'ok'; startData(u); }
    else {
      S.access = 'checking';
      // 승인되면 화면이 바로 열리고, 승인이 취소되면 바로 닫히도록 실시간으로 봄
      S.unsubAccess = onSnapshot(doc(db, 'allowlist', emailOf(u)), (snap) => {
        if (!snap.exists() && snap.metadata.fromCache) return; // 캐시에 없을 뿐일 수 있음 → 서버 응답 기다림
        const was = S.access;
        S.access = snap.exists() ? 'ok' : 'no';
        if (S.access === 'ok' && was !== 'ok') {
          startData(u);
          if (isWelcome()) { try { localStorage.removeItem('tn_welcome'); } catch { /* */ } if (!isStandalone()) setTimeout(guideSheet, 600); }
        }
        if (S.access === 'no' && was === 'ok') stopData();
        if (S.access === 'no') getDoc(doc(db, 'accessRequests', emailOf(u))).then((r) => { S.requested = r.exists(); renderSoon(); }).catch(() => {});
        renderSoon();
      }, (e) => { console.error(e); S.access = 'no'; renderSoon(); });
    }
  }
  render();
});

/** 승인된 뒤에만 여행 데이터 구독 시작 */
function startData(u) {
  S.unsubMe = onSnapshot(doc(db, 'users', u.uid), (s) => { S.profiles.set(u.uid, s.exists() ? s.data() : {}); renderSoon(); }, () => {});
  S.unsubTrips = onSnapshot(
    query(collection(db, 'trips'), where('members', 'array-contains', u.uid)),
    (snap) => {
      S.trips = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      S.tripsLoaded = true;
      prefetchTrips();
      if (S.tripId && !trip()) openTrip(null); else renderSoon();
    },
    (err) => { console.error(err); S.tripsLoaded = true; toast('여행 목록을 불러오지 못했어요'); render(); },
  );
  if (pendingJoin) joinTrip(pendingJoin);
  renderSoon();
}

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
  S.items = []; S.expenses = []; S.flights = []; S.places = []; S.checks = []; S.fresh = {};
  S.tripId = id; S.day = null; S.mapAll = false; S.ordering = false; S.viewAs = null; S.wishCat = 'all'; S.wishRoute = null;
  if (id) {
    // includeMetadataChanges: 캐시 내용이 서버와 같아도 '서버 확인됨' 신호를 받으려고 (공유 링크는 서버 확인 후에만 갱신)
    const sub = (name) => onSnapshot(collection(db, 'trips', id, name), { includeMetadataChanges: true }, (s) => {
      const was = !!S.fresh[name];
      if (!s.metadata.fromCache) S.fresh[name] = true;
      if (!s.docChanges().length && was === !!S.fresh[name] && S[name].length === s.size) return; // 메타데이터만 바뀜 → 다시 안 그림
      S[name] = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (name === 'items') { const tt = trip(); if (tt) normalizePositions(tt); }
      renderSoon();
    }, (e) => console.error(name, e));
    S.unsubSub.push(sub('items'), sub('expenses'), sub('flights'), sub('places'), sub('checks'));
    const t = trip(); if (t) loadProfiles(t.members || []);
    loadRouteStore(id).then(() => { if (S.tripId === id && S.tab === 'plan') renderSoon(); });
  }
  render(); window.scrollTo(0, 0);
}

async function write(fn) {
  try { await fn(); } catch (e) {
    console.error(e);
    toast(e?.code === 'permission-denied' ? '권한이 없어요' : '저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
}
// 오프라인이면 쓰기 promise가 서버 응답 올 때까지 안 끝남 → 화면은 기다리지 않음.
// 여러 문서는 batch 하나로: 로컬엔 바로 한꺼번에 반영, 연결되면 같이 올라감 (앞 쓰기가 뒤 쓰기를 막지 않게)
function commit(b) { write(() => b.commit()); }
function needOnline() { if (navigator.onLine) return false; toast('인터넷에 연결된 뒤에 할 수 있어요'); return true; }

/* ---------------- icons ---------------- */
const I = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  logo: '<svg aria-hidden="true" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#2E5BFF"/><g transform="translate(56.7 286.6) scale(0.12437)"><path fill="#fff" d="M218.0 10Q178.0 10 141.0 -0.5Q104.0 -11 73.0 -30.5Q42.0 -50 19.0 -78L89.0 -148Q114.0 -119 146.5 -104.5Q179.0 -90 220.0 -90Q257.0 -90 276.0 -101.0Q295.0 -112 295.0 -133Q295.0 -155 277.0 -167.0Q259.0 -179 230.5 -187.5Q202.0 -196 170.5 -205.0Q139.0 -214 110.5 -229.5Q82.0 -245 64.0 -272.0Q46.0 -299 46.0 -342Q46.0 -388 67.5 -421.0Q89.0 -454 128.5 -472.0Q168.0 -490 223.0 -490Q281.0 -490 325.5 -469.5Q370.0 -449 400.0 -408L330.0 -338Q309.0 -364 282.0 -377.0Q255.0 -390 220.0 -390Q187.0 -390 169.0 -380.0Q151.0 -370 151.0 -351Q151.0 -331 169.0 -320.0Q187.0 -309 215.5 -301.0Q244.0 -293 275.5 -283.5Q307.0 -274 335.5 -257.5Q364.0 -241 382.0 -213.5Q400.0 -186 400.0 -142Q400.0 -72 351.0 -31.0Q302.0 10 218.0 10Z M800.0 0V-277Q800.0 -325 769.5 -356.0Q739.0 -387 691.2448979591836 -387.0Q658.7448979591836 -387.0 633.8724489795918 -373.0Q609.0 -359 595.0 -334.0Q581.0 -309 581.0 -277L538.0 -301Q538.0 -356 562.0 -398.5Q586.0 -441 628.3959390862944 -465.5Q670.7918781725889 -490.0 724.3959390862944 -490.0Q778.0 -490 820.0 -466.0Q862.0 -442 886.0 -399.5Q910.0 -357 910.0 -301V0ZM471.0 0V-720H581.0V0Z M1222.0 10Q1152.0 10 1095.0 -23.5Q1038.0 -57 1004.5 -114.0Q971.0 -171 971.0 -241Q971.0 -311 1004.5 -367.0Q1038.0 -423 1095.0 -456.5Q1152.0 -490 1222.0 -490Q1293.0 -490 1350.0 -457.0Q1407.0 -424 1440.5 -367.5Q1474.0 -311 1474.0 -241Q1474.0 -171 1440.5 -114.0Q1407.0 -57 1350.0 -23.5Q1293.0 10 1222.0 10ZM1222.0 -96Q1263.0 -96 1294.5 -114.5Q1326.0 -133 1343.5 -166.0Q1361.0 -199 1361.0 -241Q1361.0 -283 1343.0 -315.0Q1325.0 -347 1294.0 -365.5Q1263.0 -384 1222.0 -384Q1182.0 -384 1150.5 -365.5Q1119.0 -347 1101.5 -315.0Q1084.0 -283 1084.0 -241Q1084.0 -199 1101.5 -166.0Q1119.0 -133 1150.5 -114.5Q1182.0 -96 1222.0 -96Z M2488.232 0V-277Q2488.232 -325 2457.732 -356.0Q2427.232 -387 2379.4768979591836 -387.0Q2346.9768979591836 -387.0 2322.104448979592 -373.0Q2297.232 -359 2283.232 -334.0Q2269.232 -309 2269.232 -277L2226.232 -301Q2226.232 -356 2250.232 -398.5Q2274.232 -441 2316.6279390862946 -465.5Q2359.023878172589 -490.0 2412.627939086294 -490.0Q2466.232 -490 2508.232 -462.5Q2550.232 -435 2574.232 -391.5Q2598.232 -348 2598.232 -301V0ZM2159.232 0V-480H2269.232V0Z M2890.232 210Q2814.232 210 2757.232 182.5Q2700.232 155 2665.232 105L2737.232 33Q2766.232 69 2803.232 87.0Q2840.232 105 2892.232 105Q2957.232 105 2995.232 71.5Q3033.232 38 3033.232 -20V-138L3052.232 -244L3033.232 -351V-480H3143.232V-20Q3143.232 49 3111.232 100.5Q3079.232 152 3022.232 181.0Q2965.232 210 2890.232 210ZM2885.232 -10Q2821.232 -10 2769.732 -41.5Q2718.232 -73 2688.732 -128.0Q2659.232 -183 2659.232 -251Q2659.232 -319 2688.732 -373.0Q2718.232 -427 2769.732 -458.5Q2821.232 -490 2885.232 -490Q2942.232 -490 2985.232 -467.0Q3028.232 -444 3052.232 -403.5Q3076.232 -363 3076.232 -309V-191Q3076.232 -138 3051.732 -97.0Q3027.232 -56 2984.232 -33.0Q2941.232 -10 2885.232 -10ZM2907.232 -114Q2947.232 -114 2977.232 -131.0Q3007.232 -148 3023.732 -178.5Q3040.232 -209 3040.232 -250Q3040.232 -291 3023.732 -321.5Q3007.232 -352 2977.232 -369.0Q2947.232 -386 2907.232 -386Q2867.232 -386 2836.732 -369.0Q2806.232 -352 2789.232 -321.5Q2772.232 -291 2772.232 -250Q2772.232 -210 2789.232 -179.0Q2806.232 -148 2836.732 -131.0Q2867.232 -114 2907.232 -114Z"/><circle cx="1765.5" cy="-246.4" r="201.9" fill="none" stroke="#FFD66B" stroke-width="105.0"/><path fill="#fff" d="M1784.8,-391.4 L2229.5,-285.1 L1949.2,-227.1Z"/><path fill="#D5DEFF" d="M1949.2,-227.1 L2229.5,-285.1 L1910.5,-72.4Z"/></g></svg>',
  word: '<svg viewBox="-6 -726 3216.2 942" role="img" aria-label="shoong"><path fill="#191F28" d="M218.0 10Q178.0 10 141.0 -0.5Q104.0 -11 73.0 -30.5Q42.0 -50 19.0 -78L89.0 -148Q114.0 -119 146.5 -104.5Q179.0 -90 220.0 -90Q257.0 -90 276.0 -101.0Q295.0 -112 295.0 -133Q295.0 -155 277.0 -167.0Q259.0 -179 230.5 -187.5Q202.0 -196 170.5 -205.0Q139.0 -214 110.5 -229.5Q82.0 -245 64.0 -272.0Q46.0 -299 46.0 -342Q46.0 -388 67.5 -421.0Q89.0 -454 128.5 -472.0Q168.0 -490 223.0 -490Q281.0 -490 325.5 -469.5Q370.0 -449 400.0 -408L330.0 -338Q309.0 -364 282.0 -377.0Q255.0 -390 220.0 -390Q187.0 -390 169.0 -380.0Q151.0 -370 151.0 -351Q151.0 -331 169.0 -320.0Q187.0 -309 215.5 -301.0Q244.0 -293 275.5 -283.5Q307.0 -274 335.5 -257.5Q364.0 -241 382.0 -213.5Q400.0 -186 400.0 -142Q400.0 -72 351.0 -31.0Q302.0 10 218.0 10Z M800.0 0V-277Q800.0 -325 769.5 -356.0Q739.0 -387 691.2448979591836 -387.0Q658.7448979591836 -387.0 633.8724489795918 -373.0Q609.0 -359 595.0 -334.0Q581.0 -309 581.0 -277L538.0 -301Q538.0 -356 562.0 -398.5Q586.0 -441 628.3959390862944 -465.5Q670.7918781725889 -490.0 724.3959390862944 -490.0Q778.0 -490 820.0 -466.0Q862.0 -442 886.0 -399.5Q910.0 -357 910.0 -301V0ZM471.0 0V-720H581.0V0Z M1222.0 10Q1152.0 10 1095.0 -23.5Q1038.0 -57 1004.5 -114.0Q971.0 -171 971.0 -241Q971.0 -311 1004.5 -367.0Q1038.0 -423 1095.0 -456.5Q1152.0 -490 1222.0 -490Q1293.0 -490 1350.0 -457.0Q1407.0 -424 1440.5 -367.5Q1474.0 -311 1474.0 -241Q1474.0 -171 1440.5 -114.0Q1407.0 -57 1350.0 -23.5Q1293.0 10 1222.0 10ZM1222.0 -96Q1263.0 -96 1294.5 -114.5Q1326.0 -133 1343.5 -166.0Q1361.0 -199 1361.0 -241Q1361.0 -283 1343.0 -315.0Q1325.0 -347 1294.0 -365.5Q1263.0 -384 1222.0 -384Q1182.0 -384 1150.5 -365.5Q1119.0 -347 1101.5 -315.0Q1084.0 -283 1084.0 -241Q1084.0 -199 1101.5 -166.0Q1119.0 -133 1150.5 -114.5Q1182.0 -96 1222.0 -96Z M2488.232 0V-277Q2488.232 -325 2457.732 -356.0Q2427.232 -387 2379.4768979591836 -387.0Q2346.9768979591836 -387.0 2322.104448979592 -373.0Q2297.232 -359 2283.232 -334.0Q2269.232 -309 2269.232 -277L2226.232 -301Q2226.232 -356 2250.232 -398.5Q2274.232 -441 2316.6279390862946 -465.5Q2359.023878172589 -490.0 2412.627939086294 -490.0Q2466.232 -490 2508.232 -462.5Q2550.232 -435 2574.232 -391.5Q2598.232 -348 2598.232 -301V0ZM2159.232 0V-480H2269.232V0Z M2890.232 210Q2814.232 210 2757.232 182.5Q2700.232 155 2665.232 105L2737.232 33Q2766.232 69 2803.232 87.0Q2840.232 105 2892.232 105Q2957.232 105 2995.232 71.5Q3033.232 38 3033.232 -20V-138L3052.232 -244L3033.232 -351V-480H3143.232V-20Q3143.232 49 3111.232 100.5Q3079.232 152 3022.232 181.0Q2965.232 210 2890.232 210ZM2885.232 -10Q2821.232 -10 2769.732 -41.5Q2718.232 -73 2688.732 -128.0Q2659.232 -183 2659.232 -251Q2659.232 -319 2688.732 -373.0Q2718.232 -427 2769.732 -458.5Q2821.232 -490 2885.232 -490Q2942.232 -490 2985.232 -467.0Q3028.232 -444 3052.232 -403.5Q3076.232 -363 3076.232 -309V-191Q3076.232 -138 3051.732 -97.0Q3027.232 -56 2984.232 -33.0Q2941.232 -10 2885.232 -10ZM2907.232 -114Q2947.232 -114 2977.232 -131.0Q3007.232 -148 3023.732 -178.5Q3040.232 -209 3040.232 -250Q3040.232 -291 3023.732 -321.5Q3007.232 -352 2977.232 -369.0Q2947.232 -386 2907.232 -386Q2867.232 -386 2836.732 -369.0Q2806.232 -352 2789.232 -321.5Q2772.232 -291 2772.232 -250Q2772.232 -210 2789.232 -179.0Q2806.232 -148 2836.732 -131.0Q2867.232 -114 2907.232 -114Z"/><circle cx="1765.5" cy="-246.4" r="201.9" fill="none" stroke="#2E5BFF" stroke-width="105.0"/><path fill="#2E5BFF" d="M1784.8,-391.4 L2229.5,-285.1 L1949.2,-227.1Z"/><path fill="#6D8BFF" d="M1949.2,-227.1 L2229.5,-285.1 L1910.5,-72.4Z"/></svg>',
  plane: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
};

/* ---------------- render ---------------- */
const splashStart = performance.now();
let splashGone = false;
function hideSplash() {
  if (splashGone) return; splashGone = true;
  const el = document.getElementById('splash'); if (!el) return;
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 700); }, Math.max(0, 2000 - (performance.now() - splashStart)));
}
setTimeout(hideSplash, 5000); // 혹시 로딩이 오래 걸려도 5초면 닫기
let renderQueued = false;
/** 데이터가 연달아 들어올 때 한 프레임에 한 번만 다시 그리기 (끄는 중이면 끝난 뒤로) */
function renderSoon() {
  if (renderQueued) return; renderQueued = true;
  requestAnimationFrame(function go() {
    if (dragOn || document.getElementById('segpop') || packComposing) { requestAnimationFrame(go); return; } // 한글 조합 중엔 화면 다시 안 그림
    renderQueued = false; render();
  });
}
function render() {
  const t = trip();
  if (shareCode) { hideSplash(); return viewShare(); }
  if (S.authReady) hideSplash();
  if (!S.authReady) { $('hdr').innerHTML = ''; $('view').innerHTML = '<div class="empty">불러오는 중…</div>'; return showMap(false); }
  if (!S.user) return viewLogin();
  if (S.access !== 'ok') return viewGate();
  if (S.tripId && t) viewTrip(t); else viewHome();
}

function viewLogin() {
  showMap(false); $('hdr').innerHTML = ''; $('fabhost').innerHTML = ''; $('banner').innerHTML = '';
  $('view').innerHTML = `
    <div class="login">
      <h1 class="login-word" aria-label="슝">${I.word}</h1>
      <p class="muted">일정·지도·항공권·가계부를 한 곳에서.<br>동행인과 같이 보고 같이 고쳐요.</p>
      ${BETA_NOTE}
      ${pendingJoin ? '<p class="invite-note">초대받은 여행이 있어요. 로그인하면 바로 참여돼요.</p>'
        : isWelcome() ? '<p class="invite-note">슝에 초대받았어요. 구글로 로그인하면 사용 요청이 바로 가요.</p>' : ''}
      <button class="btn pri block" id="loginBtn">Google로 시작하기</button>
    </div>`;
  $('loginBtn').onclick = () => login().catch((e) => { console.error(e); toast('로그인하지 못했어요'); });
}

/** 승인 전 화면: 안내 + 사용 요청 */
function viewGate() {
  showMap(false); $('fabhost').innerHTML = ''; $('banner').innerHTML = '';
  $('hdr').innerHTML = '';
  if (S.access === 'checking') { $('view').innerHTML = '<div class="empty">확인하는 중…</div>'; return; }
  const email = emailOf(S.user);
  $('view').innerHTML = `
    <div class="login">
      <h1 class="login-word" aria-label="슝">${I.word}</h1>
      ${BETA_NOTE}
      <p class="small muted gate-mail"><b>${esc(email)}</b> 계정은 아직 승인 전이에요.</p>
      ${S.requested
        ? '<div class="gate-done">✓ 사용 요청을 보냈어요<br><span class="small muted">승인되면 이 화면이 자동으로 열려요.</span></div>'
        : '<button class="btn pri block" id="reqBtn">사용 요청 보내기</button>'}
      <button class="btn ghost block" id="outBtn" style="margin-top:10px">다른 계정으로 로그인</button>
    </div>`;
  const rb = $('reqBtn');
  if (rb) rb.onclick = async () => {
    rb.disabled = true;
    try {
      await setDoc(doc(db, 'accessRequests', email), {
        email, uid: S.user.uid, name: S.user.displayName || '', photo: S.user.photoURL || null, at: Date.now(),
      });
      S.requested = true; render();
    } catch (e) { console.error(e); rb.disabled = false; toast('요청을 보내지 못했어요'); }
  };
  $('outBtn').onclick = () => logout();
  if (rb && isWelcome() && !S.reqAuto) { S.reqAuto = true; rb.click(); }
}

/* 로고 10번 연속 탭 → 관리자 화면 (관리자 계정만) */
let logoTaps = 0; let logoTimer = null;
document.addEventListener('click', (e) => {
  if (!e.target.closest('.brand, .login-word')) return;
  clearTimeout(logoTimer); logoTimer = setTimeout(() => { logoTaps = 0; }, 1500);
  if (++logoTaps < 10) return;
  logoTaps = 0;
  if (S.isAdmin) adminSheet();
});

/** API 사용량 (관리자): /api/usage → 오늘 상한 대비 · 이번 달 무료분 대비 */
let usageCache = null; // { at(ms), data }
let admTab = 'users'; // 관리자 시트 탭: users | usage | people
async function loadUsage(force) {
  if (!force && usageCache && Date.now() - usageCache.at < 60e3) return usageCache.data;
  const tok = await idToken();
  const r = await fetch('/api/usage', { headers: { Authorization: `Bearer ${tok}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.status), { code: j.error });
  usageCache = { at: Date.now(), data: j };
  return j;
}
function usageHtml(u) {
  const left = Math.max(0, new Date(u.resetAt) - Date.now());
  const hh = Math.floor(left / 3600e3), mm = Math.floor((left % 3600e3) / 60e3);
  const bar = (v, cap) => {
    if (!cap) return '';
    const pct = Math.min(100, (v / cap) * 100);
    return `<div class="ubar"><i style="width:${pct.toFixed(1)}%" class="${pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : ''}"></i></div>`;
  };
  const n = (x) => Number(x || 0).toLocaleString('ko-KR');
  return `<p class="small muted" style="margin:0 2px 8px">오늘 한도 리셋까지 ${hh}시간 ${mm}분 · 몇 분 늦게 반영돼요</p>
    ${dailyChartHtml(u)}
    ${u.meters.map((m) => `<div class="urow">
      <div class="uhead"><b>${esc(m.name)}</b>${m.todayErr ? `<span class="ublock">막힘·오류 ${n(m.todayErr)}</span>` : ''}</div>
      ${m.dayCap ? `<div class="uline"><span>오늘</span><span>${n(m.today)} / ${n(m.dayCap)}</span></div>${bar(m.today, m.dayCap)}` : `<div class="uline"><span>오늘</span><span>${n(m.today)}</span></div>`}
      ${m.monthFree ? `<div class="uline"><span>이번 달 무료분</span><span>${n(m.month)} / ${n(m.monthFree)}</span></div>${bar(m.month, m.monthFree)}` : `<div class="uline"><span>이번 달</span><span>${n(m.month)}</span></div>`}
    </div>`).join('')}
    ${u.other?.length ? `<details class="uother"><summary class="small muted">그 밖의 API (이번 달)</summary>${u.other.map((o) => `<div class="uline small"><span>${esc(o.name)}</span><span>${n(o.month)}</span></div>`).join('')}</details>` : ''}
    <p class="small muted" style="margin:8px 2px 0">요청 수 기준이라 실제 청구와 조금 다를 수 있어요. 정확한 금액은 GCP 결제 보고서에서 확인.</p>`;
}
/** 최근 30일 일자별 요청 수 (항목별 쌓은 막대). 막대 누르면 그날 내역 */
const UCOLORS = { map: '#2E5BFF', ac: '#7FA0FF', place: '#FFB547', text: '#F0532D', route: '#0A9E62', wx: '#A23ED1', geo: '#8B95A1' };
function dailyChartHtml(u) {
  const days = u.daily || []; if (!days.length) return '';
  const ids = u.meters.map((m) => m.id);
  const tot = (d) => ids.reduce((a, k) => a + (d.c[k] || 0), 0);
  const max = Math.max(1, ...days.map(tot));
  const W = 300, H = 120, gap = 2, bw = (W - gap * (days.length - 1)) / days.length;
  const bars = days.map((d, k) => {
    let y = H; const x = k * (bw + gap);
    const segs = ids.map((id) => { const v = d.c[id] || 0; if (!v) return ''; const h = (v / max) * (H - 4); y -= h; return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" fill="${UCOLORS[id] || '#888'}"/>`; }).join('');
    return `<g class="udb${d.today ? ' today' : ''}" data-k="${k}">${segs}<rect x="${x.toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H}" fill="transparent"/></g>`;
  }).join('');
  const lab = (d) => d.date.slice(5).replace('-', '/');
  const n = (x) => Number(x || 0).toLocaleString('ko-KR');
  const sumAll = days.reduce((a, d) => a + tot(d), 0);
  return `<div class="udaily" data-days='${esc(JSON.stringify(days.map((d) => ({ l: lab(d), c: d.c, t: d.today ? 1 : 0 }))))}'>
    <div class="uline"><b>최근 30일 요청 수</b><span>합계 ${n(sumAll)}</span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="udsvg">${[0.5, 1].map((f) => `<line x1="0" x2="${W}" y1="${H - (H - 4) * f}" y2="${H - (H - 4) * f}" class="udgrid"/>`).join('')}${bars}</svg>
    <div class="udax"><span>${lab(days[0])}</span><span>최고 ${n(max)}/일</span><span>오늘</span></div>
    <div class="udleg">${u.meters.map((m) => `<span><i style="background:${UCOLORS[m.id] || '#888'}"></i>${esc(m.name)}</span>`).join('')}</div>
    <div class="uddet small muted">막대를 누르면 그날 내역이 보여요</div></div>`;
}
document.addEventListener('click', (e) => {
  const g = e.target.closest('.udaily .udb'); if (!g) return;
  const box = g.closest('.udaily'); const days = JSON.parse(box.dataset.days || '[]'); const d = days[+g.dataset.k]; if (!d) return;
  box.querySelectorAll('.udb').forEach((x) => x.classList.toggle('sel', x === g));
  const names = Object.fromEntries([...box.querySelectorAll('.udleg span')].map((s, k) => [Object.keys(UCOLORS)[k], s.textContent]));
  const rows = Object.entries(d.c).filter(([, v]) => v).sort((a, b) => b[1] - a[1]);
  box.querySelector('.uddet').innerHTML = `<b>${esc(d.l)}${d.t ? ' (오늘)' : ''}</b> · ${rows.length ? rows.map(([k, v]) => `${esc(names[k] || k)} ${Number(v).toLocaleString('ko-KR')}`).join(' · ') : '사용 없음'}`;
});
async function paintUsage(box, force) {
  if (!box) return;
  if (!usageCache || force) box.innerHTML = '<p class="small muted">불러오는 중…</p>';
  try { box.innerHTML = usageHtml(await loadUsage(force)); }
  catch (e) {
    console.error(e);
    const msg = { nokey: 'Vercel에 GCP_SA_KEY 환경변수가 없어요', badkey: 'GCP_SA_KEY 형식이 잘못됐어요 (JSON 키 전체)', admin: '관리자만 볼 수 있어요', upstream: '구글에서 사용량을 못 가져왔어요. 서비스 계정 권한(Monitoring 뷰어)을 확인해 주세요' }[e.code] || '사용량을 불러오지 못했어요';
    box.innerHTML = `<p class="small muted">${esc(msg)}</p>`;
  }
}

/** 사용자별 (관리자): 앱이 직접 센 호출 수 usage/{월}/users/{uid} → 정가 기준 추정 금액 */
let peopleMonth = 0; // 0 = 이번 달, -1 = 지난달
async function paintPeople(box, names) {
  if (!box) return;
  const now = new Date(); const d = new Date(now.getFullYear(), now.getMonth() + peopleMonth, 15);
  const month = ptMonth(peopleMonth ? d : now);
  box.innerHTML = '<p class="small muted">불러오는 중…</p>';
  let rows = [];
  try { rows = (await getDocs(collection(db, 'usage', month, 'users'))).docs.map((x) => ({ id: x.id, ...x.data() })); }
  catch (e) { console.error(e); box.innerHTML = `<p class="small muted">${e?.code === 'permission-denied' ? 'Firebase 콘솔에 새 규칙(usage)을 게시해야 보여요' : '불러오지 못했어요'}</p>`; return; }
  const n = (x) => Number(x || 0).toLocaleString('ko-KR');
  const usd = (c = {}) => UMETERS.reduce((a, m) => a + (m.usd ? ((c[m.id] || 0) / 1000) * m.usd : 0), 0);
  rows.forEach((r) => { r.usd = usd(r.c); });
  rows.sort((a, b) => b.usd - a.usd);
  const total = rows.reduce((a, r) => a + r.usd, 0);
  const $ = (v) => `$${v < 10 ? v.toFixed(2) : v.toFixed(1)}`;
  box.innerHTML = `<p class="small muted" style="margin:0 2px 8px">${month} · 앱에서 센 추정치 · 몇 분 늦게 반영</p>
    ${rows.length ? rows.map((r) => {
      const nm = names[r.email] || r.name || r.email || r.id;
      const pct = total ? (r.usd / total) * 100 : 0;
      const parts = UMETERS.filter((m) => r.c?.[m.id]).map((m) => `<span>${esc(m.name)} ${n(r.c[m.id])}</span>`).join('');
      return `<div class="urow">
        <div class="uline"><b>${esc(nm)}</b><span>${$(r.usd)}${total ? ` · ${pct.toFixed(0)}%` : ''}</span></div>
        <div class="ubar"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="upeople">${parts || '<span>사용 없음</span>'}</div>
      </div>`;
    }).join('') : '<p class="small muted">아직 기록이 없어요</p>'}
    ${rows.length ? `<div class="uline" style="margin-top:6px"><b>합계</b><b>${$(total)}</b></div>` : ''}
    <p class="small muted" style="margin:8px 2px 0">정가 기준이에요. 실제로는 앱 전체 무료분(월 1만 건 등)을 먼저 빼서 대부분 $0이에요. 날씨·항공편은 횟수만 셈.</p>`;
}

/** 테스터 관리: 요청 승인 · 직접 추가 · 이름 메모 · 삭제 */
async function adminSheet() {
  let reqs = []; let allow = [];
  const load = async () => {
    const [r, a] = await Promise.all([getDocs(collection(db, 'accessRequests')), getDocs(collection(db, 'allowlist'))]);
    reqs = r.docs.map((d) => ({ id: d.id, ...d.data() })).sort((x, y) => (y.at || 0) - (x.at || 0));
    allow = a.docs.map((d) => ({ id: d.id, ...d.data() })).sort((x, y) => (y.addedAt || 0) - (x.addedAt || 0));
  };
  try { await load(); } catch (e) { console.error(e); toast('관리자 권한을 확인하지 못했어요'); return; }
  const approve = async (email, name) => {
    const b = writeBatch(db);
    b.set(doc(db, 'allowlist', email), { name: name || '', addedAt: Date.now(), addedBy: emailOf(S.user) });
    b.delete(doc(db, 'accessRequests', email));
    await b.commit();
  };
  const draw = () => openSheet(`<h2>🔑 관리자</h2>
    <div class="adm-tabs">
      <button data-x="tab" data-v="users" class="${admTab === 'users' ? 'on' : ''}">테스터${reqs.length ? ` <span>${reqs.length}</span>` : ''}</button>
      <button data-x="tab" data-v="usage" class="${admTab === 'usage' ? 'on' : ''}">API 사용량</button>
      <button data-x="tab" data-v="people" class="${admTab === 'people' ? 'on' : ''}">사용자별</button>
    </div>
    <div data-pane="people" ${admTab === 'people' ? '' : 'hidden'}><div class="adm-uhead"><button class="btn ghost small" data-x="pmonth">${peopleMonth ? '이번 달 보기' : '지난달 보기'}</button><button class="btn ghost small" data-x="preload">새로고침</button></div>
    <div class="adm-usage" data-x="people"></div></div>
    <div data-pane="usage" ${admTab === 'usage' ? '' : 'hidden'}><div class="adm-uhead"><button class="btn ghost small" data-x="ureload">새로고침</button></div>
    <div class="adm-usage" data-x="usage"></div></div>
    <div data-pane="users" ${admTab === 'users' ? '' : 'hidden'}>
    <div class="adm-add">
      <input class="inp" name="nemail" type="email" inputmode="email" autocapitalize="off" placeholder="구글 이메일">
      <input class="inp" name="nname" placeholder="누군지 (예: 대학 동기 민지)">
      <button class="btn pri block" data-x="add">추가</button>
    </div>
    <button class="btn ghost block" data-x="applink" style="margin-top:8px">🔗 앱 초대 링크 복사</button>
    <p class="small muted" style="margin:6px 2px 0">링크로 들어와 로그인하면 요청이 자동으로 와요. 아래에서 승인만 하면 돼요.</p>
    <h3 class="adm-h">요청 대기 <span>${reqs.length}</span></h3>
    ${reqs.length ? reqs.map((r) => `<div class="adm-row" data-email="${esc(r.id)}">
        <div class="adm-who"><b>${esc(r.name || '(이름 없음)')}</b><span>${esc(r.id)}</span></div>
        <input class="inp adm-name" placeholder="누군지 메모" value="${esc(r.name || '')}">
        <div class="adm-btns"><button class="btn ghost small" data-x="deny">거절</button><button class="btn pri small" data-x="ok">승인</button></div>
      </div>`).join('') : '<p class="small muted adm-none">대기 중인 요청이 없어요</p>'}
    <h3 class="adm-h">승인된 사람 <span>${allow.length + 1}</span></h3>
    <div class="adm-row"><div class="adm-who"><b>나 (관리자)</b><span>${esc(emailOf(S.user))}</span></div></div>
    ${allow.map((a) => `<div class="adm-row" data-email="${esc(a.id)}">
        <div class="adm-who"><span>${esc(a.id)}</span></div>
        <div class="adm-line"><input class="inp adm-name" placeholder="누군지 메모" value="${esc(a.name || '')}"><button class="btn danger small" data-x="del">삭제</button></div>
      </div>`).join('')}</div>`, (sh) => {
    // 탭: 시트를 다시 열지 않고 칸만 바꿈 (열림 애니메이션 반복 방지)
    const ubox = sh.querySelector('[data-x=usage]');
    let uLoaded = false;
    const showTab = (v) => {
      admTab = v;
      sh.querySelectorAll('[data-x=tab]').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
      sh.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== v; });
      if (v === 'usage' && !uLoaded) { uLoaded = true; if (usageCache) ubox.innerHTML = usageHtml(usageCache.data); paintUsage(ubox, false); }
      if (v === 'people' && !pLoaded) { pLoaded = true; paintPeople(pbox, names); }
    };
    const pbox = sh.querySelector('[data-x=people]'); let pLoaded = false;
    const names = Object.fromEntries(allow.filter((a) => a.name).map((a) => [a.id, a.name])); names[emailOf(S.user)] = '나 (관리자)';
    sh.querySelector('[data-x=preload]').onclick = () => paintPeople(pbox, names);
    sh.querySelector('[data-x=pmonth]').onclick = (ev) => { peopleMonth = peopleMonth ? 0 : -1; ev.target.textContent = peopleMonth ? '이번 달 보기' : '지난달 보기'; paintPeople(pbox, names); };
    sh.querySelectorAll('[data-x=tab]').forEach((b) => { b.onclick = () => showTab(b.dataset.v); });
    sh.querySelector('[data-x=ureload]').onclick = () => paintUsage(ubox, true);
    showTab(admTab);
    sh.querySelector('[data-x=applink]').onclick = () => copy(`${location.origin}/?hi=1`, '앱 초대 링크를 복사했어요');
    sh.querySelector('[data-x=add]').onclick = async () => {
      const email = sh.querySelector('[name=nemail]').value.trim().toLowerCase();
      const name = sh.querySelector('[name=nname]').value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('이메일을 확인해 주세요');
      try { await approve(email, name); await load(); draw(); toast('추가했어요'); }
      catch (e) { console.error(e); toast('추가하지 못했어요'); }
    };
    sh.querySelectorAll('.adm-row[data-email]').forEach((row) => {
      const email = row.dataset.email;
      const nameInp = row.querySelector('.adm-name');
      const isAllowed = allow.some((a) => a.id === email);
      if (isAllowed) nameInp.addEventListener('change', async () => {
        try { await updateDoc(doc(db, 'allowlist', email), { name: nameInp.value.trim() }); toast('저장했어요'); }
        catch (e) { console.error(e); toast('저장하지 못했어요'); }
      });
      row.querySelector('[data-x=ok]')?.addEventListener('click', async () => {
        try { await approve(email, nameInp.value.trim()); await load(); draw(); toast('승인했어요'); }
        catch (e) { console.error(e); toast('승인하지 못했어요'); }
      });
      row.querySelector('[data-x=deny]')?.addEventListener('click', () => askConfirm(`${email} 요청을 거절할까요?`, '거절', async () => {
        try { await deleteDoc(doc(db, 'accessRequests', email)); } catch (e) { console.error(e); toast('처리하지 못했어요'); }
        await load(); draw();
      }));
      row.querySelector('[data-x=del]')?.addEventListener('click', () => askConfirm(`${email} 승인을 취소할까요? 바로 앱을 못 쓰게 돼요.`, '삭제', async () => {
        try { await deleteDoc(doc(db, 'allowlist', email)); } catch (e) { console.error(e); toast('삭제하지 못했어요'); }
        await load(); draw();
      }));
    });
  });
  draw();
}

const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 저장 안 돼도 괜찮음 */ } };
/** 택시 앱으로 넘기기: 출발·도착 좌표를 채워서 */
function taxiSheet(from, to) {
  const f = { lat: from.lat, lng: from.lng, name: from.title || '출발' }, d = { lat: to.lat, lng: to.lng, name: to.title || '도착' };
  const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const uber = 'https://m.uber.com/ul/?' + q({ action: 'setPickup', 'pickup[latitude]': f.lat, 'pickup[longitude]': f.lng, 'pickup[nickname]': f.name, 'dropoff[latitude]': d.lat, 'dropoff[longitude]': d.lng, 'dropoff[nickname]': d.name });
  const kakao = 'kakaot://taxi?' + q({ origin_lat: f.lat, origin_lng: f.lng, origin_name: f.name, dest_lat: d.lat, dest_lng: d.lng, dest_name: d.name });
  const addr = (S.items.find((i) => i.id === to.id)?.address) || d.name;
  const cn = inChina(from) && inChina(to); // 중국 본토는 우버·카카오 T가 안 돼서 알리페이 안 디디
  openSheet(`<h2>🚕 택시 부르기</h2>
    <div class="taxiroute"><div><span>출발</span><b>${esc(f.name)}</b></div><em>→</em><div><span>도착</span><b>${esc(d.name)}</b></div></div>
    <div class="taxiapps">
      ${cn ? `<a class="taxiapp didi" href="https://ds.alipay.com/?scheme=${encodeURIComponent('alipays://platformapi/startapp?saId=10000007')}" target="_blank" rel="noopener" data-x="didi"><span class="ta-ico">D</span><div><b>디디 (알리페이)</b><i>중국 · 알리페이 → 교통 → 디디</i></div></a>` : ''}
      <a class="taxiapp kakao" href="${esc(kakao)}" data-x="kakao"><span class="ta-ico">T</span><div><b>카카오 T</b><i>한국 · 일본 · 베트남</i></div></a>
      <a class="taxiapp uber" href="${esc(uber)}" target="_blank" rel="noopener"><span class="ta-ico">U</span><div><b>Uber</b><i>일본 · 홍콩 · 대만 · 해외 대부분</i></div></a>
    </div>
    <button type="button" class="btn ghost block" data-x="copy">📋 도착지 주소 복사</button>
    ${cn ? '<p class="small muted" style="margin-top:10px">디디는 알리페이를 열고 <b>교통(出行) → 디디(滴滴出行)</b>로 들어가서, 복사된 도착지를 붙여넣으면 돼요. 중국어 주소로 찾으면 정확해요.</p>' : ''}
    <p class="small muted" style="margin-top:10px">앱이 깔려 있으면 바로 열려요. Uber는 출발·도착이 채워져서 열리고, 카카오 T는 버전에 따라 도착지를 한 번 더 확인해야 할 수 있어요. 그럴 땐 복사한 주소를 붙여넣으세요.</p>`, (sh) => {
    sh.querySelector('[data-x=copy]').onclick = () => copy(addr, '도착지 주소를 복사했어요');
    sh.querySelector('[data-x=didi]')?.addEventListener('click', () => {
      copy(addr, '도착지 주소를 복사했어요. 디디에서 붙여넣으세요');
      setTimeout(() => { if (document.visibilityState === 'visible') toast('알리페이 앱이 안 열리면 설치가 필요해요'); }, 1800);
    });
    sh.querySelector('[data-x=kakao]').addEventListener('click', () => {
      copy(addr, '도착지 주소도 복사해 뒀어요');
      setTimeout(() => { if (document.visibilityState === 'visible') toast('카카오 T 앱이 안 열리면 설치가 필요해요'); }, 1800);
    });
  });
}
/** 사용 방법 (홈 화면에 추가하는 법 + 기능 안내) */
function guideSheet() {
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
  const android = /Android/.test(ua);
  const inApp = /KAKAOTALK|Instagram|FBAN|FBAV|NAVER|Line\//.test(ua);
  const iosSteps = `<ol class="gsteps"><li><b>Safari</b>로 열기 <span>(카톡·인스타 안에서는 안 돼요)</span></li><li>아래 <b>점 3개 <span class="gk">···</span></b> 누르고 <b>공유</b> 누르기 <span>(공유 버튼 <span class="gk">□↑</span>이 바로 보이면 그걸 눌러도 돼요)</span></li><li>아래로 내려서 <b>'홈 화면에 추가'</b> → <b>추가</b></li></ol>`;
  const andSteps = `<ol class="gsteps"><li><b>크롬</b>으로 열기</li><li>오른쪽 위 <b class="gk">⋮</b> 누르기</li><li><b>'앱 설치'</b> 또는 <b>'홈 화면에 추가'</b> 누르기</li></ol>`;
  openSheet(`<h2>📖 슝 사용 방법</h2>
    ${isStandalone() ? '' : `    <div class="gsec"><h3>📲 앱처럼 설치하기</h3>
      ${inApp ? '<p class="gwarn">카톡·인스타 안에서 열었어요. 오른쪽 위 메뉴에서 <b>다른 브라우저로 열기</b>를 먼저 눌러 주세요.</p>' : ''}
      ${ios ? `<div class="gdev on">🍎 아이폰</div>${iosSteps}<details><summary>안드로이드는?</summary>${andSteps}</details>`
        : android ? `<div class="gdev on">🤖 안드로이드</div>${andSteps}<details><summary>아이폰은?</summary>${iosSteps}</details>`
        : `<div class="gdev">🍎 아이폰</div>${iosSteps}<div class="gdev">🤖 안드로이드</div>${andSteps}`}
      <p class="small muted">홈 화면 아이콘으로 처음 열면 구글 로그인을 한 번 더 해 주세요. 업데이트는 앱을 껐다 켜면 자동으로 돼요.</p></div>`}
    <div class="gsec"><h3>✈️ 이렇게 써요</h3><ul class="gtips">
      <li><span>👥</span><div><b>동행 초대</b>여행 설정 → 초대 링크를 보내면 같이 보고 수정해요. 앱 안 쓰는 친구는 이름만 추가해도 돼요.</div></li>
      <li><span>🗓</span><div><b>일정</b>+ 일정 추가로 장소를 검색하면 지도에 핀이 찍히고, 장소 사이 이동 시간이 자동으로 나와요.</div></li>
      <li><span>👆</span><div><b>순서 바꾸기</b>일정을 꾹 누르고 끌어서 옮겨요. 항공편도 옮길 수 있어요.</div></li>
      <li><span>↙↘</span><div><b>따로 다니기</b>일정의 '누구랑?'에서 일부만 고르면 사람별 칸으로 나뉘어요. '○○ 일정' 버튼으로 한 사람 동선만 볼 수 있어요.</div></li>
      <li><span>🛫</span><div><b>항공권</b>탑승자와 체크인 QR 사진을 넣어 두면 공항에서 크게 볼 수 있어요.</div></li>
      <li><span>💸</span><div><b>가계부·정산</b>일정에 쓴 돈을 적으면 가계부에 들어가고, 가계부의 '정산'에서 누가 누구한테 얼마 보낼지 알려줘요.</div></li>
      <li><span>⭐</span><div><b>별점</b>다녀온 일정에서 '완료'를 누르고 별을 끌어서 매겨요.</div></li>
      <li><span>🚕</span><div><b>이동·택시</b>장소 사이 '🚶 도보' 버튼을 누르면 이동 수단을 바꿀 수 있어요. 차를 고르면 택시 앱으로 바로 넘어가요.</div></li>
      <li><span>✈️</span><div><b>편명 불러오기·상태 체크</b>항공권에 편명만 넣고 불러오기를 누르면 시간이 채워지고, 카드의 상태 체크로 지연·게이트를 볼 수 있어요.</div></li>
      <li><span>🧳</span><div><b>준비물</b>준비물 탭에서 같이 챙길 걸 적고 담당을 정해요. '내 담당'만 모아 볼 수 있어요.</div></li>
      <li><span>👍</span><div><b>찜 투표</b>가고 싶은 찜에 👍를 누르면 '👍 많은 순'으로 모아 봐요.</div></li>
      <li><span>🔗</span><div><b>보기 전용 링크</b>여행 설정 → 일정 공유 링크를 보내면 로그인 없이 일정만 볼 수 있어요.</div></li>
      <li><span>📴</span><div><b>오프라인</b>한 번 열어 둔 여행은 데이터가 끊겨도 일정·항공권·QR이 보여요.</div></li>
      <li><span>🎨</span><div><b>여행 카드 꾸미기</b>여행 설정에서 카드 색이나 사진을 바꿀 수 있어요.</div></li>
      <li><span>🎞</span><div><b>리캡</b>여행 설정 → 리캡에서 어워드를 보고, 후기와 서로에게 한마디를 남겨요.</div></li>
    </ul></div>
    <button class="btn dark block" data-x="ok">알겠어요</button>`, (sh) => { sh.querySelector('[data-x=ok]').onclick = closeSheet; });
}
/* 여행 카드 꾸미기: 색 또는 사진 */
const COVER_COLORS = ['#2E5BFF', '#FFD66B', '#FF7A59', '#0A9E62', '#A23ED1', '#00A3BF', '#191F28', '#F7C6D9'];
const isLight = (hex) => { const h = hex.replace('#', ''); const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); return (r * 299 + g * 587 + b * 114) / 1000 > 165; };
function coverClass(t) {
  const c = t.cover; if (!c) return '';
  if (c.type === 'image') return 'cov-img';
  return isLight(c.value) ? 'cov-light' : 'cov-dark';
}
function coverStyle(t) {
  const c = t.cover; if (!c) return '';
  if (c.type === 'image') return `background-image:linear-gradient(90deg,rgba(0,10,30,.62),rgba(0,10,30,.15)),url('${c.data}')`;
  return `background:${c.value}`;
}
function viewHome() {
  showMap(false); $('banner').innerHTML = '';
  $('hdr').innerHTML = `<h1 class="brand" aria-label="슝">${I.word}</h1><button class="avbtn" data-act="account" aria-label="내 프로필">${avatar(S.user.uid, 38)}</button>`;
  const list = [...S.trips].sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  const up = list.filter((t) => dday(t) !== '완료'), past = list.filter((t) => dday(t) === '완료');
  const card = (t) => `<button class="ticket ${coverClass(t)}" data-act="open" data-id="${esc(t.id)}" style="${coverStyle(t)}">
      <div style="min-width:0"><div class="city">${esc(t.city || 'TRIP')}</div><div class="name">${esc(t.name)}</div>
      <div class="small muted">${t.start ? esc(md(t.start)) + (t.end && t.end !== t.start ? ' – ' + esc(md(t.end)) : '') : '날짜 미정'} · ${peopleOf(t).length}명</div></div>
      <div class="dd"><b>${esc(dday(t) || '—')}</b><span class="small muted">${esc(t.currency || 'KRW')}</span></div></button>`;
  const showInstall = !isStandalone() && !lsGet('tn_install_hide');
  $('view').innerHTML = `<div class="wrap">${showInstall ? `<div class="installcard"><span class="ic-emoji">📲</span>
      <div style="flex:1;min-width:0"><b>홈 화면에 추가하면 앱처럼 써요</b><span>주소창 없이 아이콘 눌러서 바로 열려요</span></div>
      <button class="btn dark small" data-act="guide">방법 보기</button><button class="ic-x" data-act="hideInstall" aria-label="닫기">✕</button></div>` : ''}${
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
  const tabs = [['plan', '일정'], ['wish', '찜'], ['flight', '항공'], ['pack', '준비물'], ['money', '가계부']];
  let body = '';
  if (S.tab === 'plan') body = viewPlan(t, days);
  else if (S.tab === 'wish') body = viewWish(t);
  else if (S.tab === 'flight') body = viewFlights(t);
  else if (S.tab === 'pack') body = viewPack(t);
  else body = viewMoney(t);
  $('view').innerHTML = `<div class="wrap">
    <div class="tripmeta">
      ${t.city ? `<span class="chip">📍 ${esc(t.city)}</span>` : ''}
      ${t.start ? `<span class="chip">${esc(md(t.start))}${t.end && t.end !== t.start ? ' – ' + esc(md(t.end)) : ''}</span>` : ''}
      ${dday(t) ? `<span class="chip accent">${esc(dday(t))}</span>` : ''}
      ${localTimeChip(t)}
      ${dday(t) === '완료' ? '<button class="chip recapchip" data-act="recap">🎞 여행 리캡</button>' : ''}
      <button class="avstack" data-act="editTrip" aria-label="참여자">${(t.members || []).slice(0, 5).map((u) => avatar(u, 26, t.memberNames?.[u])).join('')}${(t.members || []).length > 5 ? `<span class="av more">+${t.members.length - 5}</span>` : ''}</button>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${S.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}">${l}</button>`).join('')}</div>
    ${body}</div>`;
  const fab = { plan: ['newItem', '+ 일정 추가'], wish: ['newWish', '+ 찜하기'], flight: ['newFlight', '+ 항공권 추가'], money: ['newExp', '+ 지출 추가'] }[S.tab];
  $('fabhost').innerHTML = !fab || (S.tab === 'plan' && S.ordering) ? ''
    : S.tab === 'plan' ? `<div class="fab fabduo"><button class="btn pri" data-act="newItem">+ 일정 추가</button><button class="btn memofab" data-act="newMemo" aria-label="메모 추가">📝 메모</button></div>`
    : `<button class="btn pri fab" data-act="${fab[0]}">${fab[1]}</button>`;
  if (S.tab === 'plan') { drawPlanMap(t, days); ensureAirportGeo(t); fillSegments(t); loadWeather(t, days); }
  else if (S.tab === 'wish') drawWishMap(t);
  else showMap(false);
  if (S.tab === 'flight') loadQrThumbs(t);
  if (S.tab === 'pack') wirePack(t);
  ensureTz(t); syncShare(t);
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
/** 끌어 놓은 뒤 순서 저장: 일정은 pos, 항공편은 그 자리(posDep/posArr)에 고정 */
async function placeRows(t, tokens, movedTok) {
  // 한 상자로 합친 비행편은 도착 줄도 출발 바로 뒤로 같이 옮김
  tokens = tokens.flatMap((tk) => { const m = /^F:(.+)~dep$/.exec(tk); return m && pairedFlights.has(m[1]) ? [tk, `F:${m[1]}~arr`] : [tk]; });
  const d = S.day; const all = dayItems(d);
  const fls = dayFlights(d);
  const order = tokens.map((tk) => (tk.startsWith('F:')
    ? { f: fls.find((f) => `F:${f.id}~${f._kind}` === tk), tk }
    : { i: all.find((i) => i.id === tk), tk })).filter((x) => x.f || x.i);
  const ups = [];
  const items = order.filter((x) => x.i).map((x) => x.i);
  if (!items.every((i) => typeof i.pos === 'number')) {
    // 순서값이 없는 예전 일정이 섞여 있으면 화면 순서대로 채움
    items.forEach((i, k) => { i.pos = (k + 1) * 1000; ups.push(['items', i.id, { pos: i.pos }]); });
  } else if (!movedTok.startsWith('F:')) {
    const k = items.findIndex((i) => i.id === movedTok); const m = items[k];
    const P = items[k - 1], N = items[k + 1];
    const pos = P && N ? (P.pos + N.pos) / 2 : P ? P.pos + 1000 : N ? N.pos - 1000 : 1000;
    if (m && pos !== m.pos) { m.pos = pos; ups.push(['items', m.id, { pos }]); }
  }
  // 항공편: 앞뒤 일정 사이 값으로 자리 고정 (같은 틈에 여러 개면 나눠서)
  order.forEach((x, k) => {
    if (!x.f) return;
    let pk = k - 1; while (pk >= 0 && !order[pk].i) pk--;
    let nk = k + 1; while (nk < order.length && !order[nk].i) nk++;
    const P = pk >= 0 ? order[pk].i.pos : null, N = nk < order.length ? order[nk].i.pos : null;
    const lo = P ?? (N != null ? N - 1000 : 0), hi = N ?? lo + 1000;
    const gap = order.slice(pk + 1, nk); const idx = gap.indexOf(x);
    const ap = lo + ((hi - lo) * (idx + 1)) / (gap.length + 1);
    const key = x.f._kind === 'dep' ? 'posDep' : 'posArr';
    const src = S.flights.find((f) => f.id === x.f.id);
    if (src && src[key] !== ap) { src[key] = ap; ups.push(['flights', src.id, { [key]: ap }]); }
  });
  render();
  if (ups.length) { const b = writeBatch(db); for (const [c, id, data] of ups) b.update(doc(db, 'trips', t.id, c, id), data); commit(b); }
}

/* 순서 바꾸기: 일정(또는 항공편)을 꾹 누르면 그 자리에서 바로 끌어서 이동 (화면 다시 그리지 않음) */
let dragOn = false; let suppressClickUntil = 0;
const blockScroll = (e) => { if (e.cancelable) e.preventDefault(); };
document.addEventListener('contextmenu', (e) => { if (e.target.closest('.timeline [data-lp]') || dragOn) e.preventDefault(); });
document.addEventListener('click', (e) => { if (Date.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); } }, true);
/** 화면 순서대로 줄 토큰 목록 (갈래 안은 칸 순서, 중복 제거) */
function timelineTokens(tl, dragged, ph) {
  const out = [];
  const push = (tk) => { if (tk && !out.includes(tk)) out.push(tk); };
  const walk = (el) => {
    if (el === ph) return push(dragged.dataset.lp);
    if (el === dragged) return;
    if (el.dataset?.lp) return push(el.dataset.lp);
    for (const c of el.children) walk(c);
  };
  walk(tl);
  return out;
}
function startDrag(card, clientY, isTouch) {
  const t = trip(); const tl = card.closest('.timeline'); if (!t || !tl) return;
  const box = card.parentElement; // 맨 위 줄이면 .timeline, 갈래 칸이면 .lane
  const tok = card.dataset.lp;
  dragOn = true; document.addEventListener('touchmove', blockScroll, { passive: false });
  const rect0 = card.getBoundingClientRect();
  const offY = clientY - rect0.top;
  let lastY = clientY; let raf = 0; let ended = false;
  const ph = document.createElement('div'); ph.className = 'dragph'; ph.style.height = rect0.height + 'px';
  card.after(ph);
  card.classList.add('dragging');
  Object.assign(card.style, { position: 'fixed', top: '0px', left: rect0.left + 'px', width: rect0.width + 'px', zIndex: 30, margin: 0, transform: `translateY(${rect0.top}px)` });
  // 놓을 수 있는 자리: 같은 상자 안의 카드들 (맨 위 줄이면 갈래 묶음도 한 덩어리로)
  const spots = () => [...box.children].filter((x) => x !== card && x !== ph && (x.dataset.lp || x.classList.contains('fork')));
  const findSpot = () => {
    const list = spots(); let placed = false;
    for (const o of list) {
      const r = o.getBoundingClientRect();
      if (lastY < r.top + r.height / 2) {
        // 바로 앞 이동 구간 줄까지 같이 넘어가도록, 카드 앞에 붙은 구간 줄 앞에 둠
        let at = o; while (at.previousElementSibling && at.previousElementSibling.classList.contains('seg') && at.previousElementSibling !== ph) at = at.previousElementSibling;
        if (ph.nextElementSibling !== at) at.before(ph);
        placed = true; break;
      }
    }
    if (!placed && list.length) { const last = list[list.length - 1]; if (last.nextElementSibling !== ph) last.after(ph); }
  };
  const moveTo = (y) => {
    lastY = y; card.style.transform = `translateY(${lastY - offY}px)`; findSpot();
    cancelAnimationFrame(raf);
    const edge = 80; const vh = window.innerHeight;
    if (lastY > vh - edge || lastY < edge) {
      const step = () => { window.scrollBy(0, lastY > vh - edge ? 10 : -10); findSpot(); raf = requestAnimationFrame(step); };
      raf = requestAnimationFrame(step);
    }
  };
  const end = () => {
    if (ended) return; ended = true;
    cancelAnimationFrame(raf); dragOn = false; suppressClickUntil = Date.now() + 400; document.removeEventListener('touchmove', blockScroll);
    off();
    const toks = timelineTokens(tl, card, ph);
    ph.replaceWith(card); card.classList.remove('dragging');
    Object.assign(card.style, { transform: '', position: '', top: '', left: '', width: '', zIndex: '', margin: '' });
    placeRows(t, toks, tok);
  };
  // 휴대폰: 터치 이벤트로 따라감 (스크롤로 넘어가며 끊기는 것 방지), 마우스: 포인터 이벤트
  const tmove = (e) => { const p = e.touches[0]; if (p) moveTo(p.clientY); };
  const pmove = (e) => { if (e.pointerType !== 'touch') moveTo(e.clientY); };
  const pup = (e) => { if (e.pointerType !== 'touch') end(); };
  const off = () => {
    document.removeEventListener('touchmove', tmove); document.removeEventListener('touchend', end); document.removeEventListener('touchcancel', end);
    document.removeEventListener('pointermove', pmove); document.removeEventListener('pointerup', pup);
  };
  if (isTouch) { document.addEventListener('touchmove', tmove, { passive: true }); document.addEventListener('touchend', end); document.addEventListener('touchcancel', end); }
  else { document.addEventListener('pointermove', pmove); document.addEventListener('pointerup', pup); }
}
// 꾹 누르기 (0.4초, 손가락이 움직이면 취소 → 그냥 스크롤)
document.addEventListener('pointerdown', (ev) => {
  if (S.ordering || ev.button > 0 || dragOn) return;
  const el = ev.target.closest('.timeline [data-lp]'); if (!el) return;
  if (ev.target.closest('.segsel, .rate, a, .tbtn, select, input, button')) return;
  const isTouch = ev.pointerType === 'touch';
  const x0 = ev.clientX, y0 = ev.clientY; let y = y0;
  el.classList.add('pressing');
  const cancel = () => { clearTimeout(timer); el.classList.remove('pressing'); document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', cancel); document.removeEventListener('pointercancel', cancel); };
  const mv = (e) => { y = e.clientY; if (Math.hypot(e.clientX - x0, e.clientY - y0) > 10) cancel(); };
  const timer = setTimeout(() => { cancel(); navigator.vibrate?.(15); startDrag(el, y, isTouch); }, 400);
  document.addEventListener('pointermove', mv); document.addEventListener('pointerup', cancel); document.addEventListener('pointercancel', cancel);
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
  const items = dayItems(d);
  const rows = items.map((i) => ({ kind: 'item', time: i.time, i }));
  const fl = [...dayFlights(d)].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  // 순서를 직접 바꾼 항공편은 그 자리(pos)에 고정
  const keyed = items.every((i) => typeof i.pos === 'number');
  const anch = (f) => (keyed ? (f._kind === 'dep' ? f.posDep : f.posArr) : undefined);
  fl.filter((f) => typeof anch(f) === 'number').forEach((f) => {
    const ap = anch(f);
    let at = rows.findIndex((r) => (r.kind === 'item' ? r.i.pos : r.ap) > ap);
    if (at < 0) at = rows.length;
    rows.splice(at, 0, { kind: 'flight', time: f.time, f, ap });
  });
  // 나머지 항공편 줄은 '그 시간 이하인 마지막 시간 있는 일정' 바로 뒤에 (없으면 맨 위)
  fl.filter((f) => typeof anch(f) !== 'number').forEach((f) => {
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
    return { id: i.id, lat: i.lat, lng: i.lng, time: i.time, title: i.title, move: i.move, moveMode: i.moveMode, _col: 'items', _doc: i.id, _mk: 'move', _mmk: 'moveMode', _tk: 'tinfo' };
  }
  const f = r.f; const dep = f._kind === 'dep'; const g = dep ? f.depGeo : f.arrGeo;
  if (!g) return null;
  return {
    id: `${f.id}~${f._kind}`, lat: g.lat, lng: g.lng, time: r.time, title: `${dep ? f.from : f.to} 공항`, air: f._kind,
    move: dep ? f.moveDep : f.moveArr, moveMode: dep ? f.moveModeDep : f.moveModeArr,
    _col: 'flights', _doc: f.id, _mk: dep ? 'moveDep' : 'moveArr', _mmk: dep ? 'moveModeDep' : 'moveModeArr', _tk: dep ? 'tinfoDep' : 'tinfoArr',
  };
}
/** 정산·동행 인원 = 초대 링크로 참여한 사람 */
const peopleOf = (t) => {
  const n = [...new Set([...(t?.members || []).map((u) => t.memberNames?.[u] || nameOf(t, u)), ...(t?.guests || [])].filter(Boolean))];
  return n.length ? n : [me()];
};
const myName = (t) => t?.memberNames?.[S.user?.uid] || me();
/** 이 줄에 가는 사람들 (따로 지정 없으면 다 같이) */
function rowWho(t, r) {
  const people = peopleOf(t);
  const w = ((r.kind === 'item' ? r.i.who : flightWho(t, r.f)) || []).filter((n) => people.includes(n));
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
/** 갈래 단계 나누기: 같이 다니는 사람끼리 묶인 칸에 일정이 하나씩만 들어가도록 */
function forkStages(t, grp) {
  const stages = []; let cur = [];
  const clean = (rs) => { const L = forkLanes(t, rs); return rs.every((r) => L.filter((l) => l.rows.includes(r)).length === 1); };
  for (const r of grp) {
    if (cur.length && !clean([...cur, r])) { stages.push(cur); cur = []; }
    cur.push(r);
  }
  if (cur.length) stages.push(cur);
  return stages;
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
    // 같이 다니는 사람끼리는 한 칸: 한 일정이 여러 칸에 겹쳐 나오면 거기서 단계를 나눔
    const stages = forkStages(t, grp);
    const lastBy = new Map(peopleOf(t).map((p) => [p, lastCommon]));
    stages.forEach((sg, si) => {
      const final = si === stages.length - 1;
      const lanes = forkLanes(t, sg).map((l) => {
        const stops = l.rows.map(rowStop).filter(Boolean);
        const start = lastBy.get(l.names[0]) || null;
        const ls = stops.length ? chainSegs([start, ...stops, final ? nextStop : null]) : [];
        segs.push(...ls);
        if (stops.length) l.names.forEach((p) => lastBy.set(p, stops[stops.length - 1]));
        const into = new Map(ls.map((s) => [s[1].id, s]));
        const toNext = final && nextStop ? ls.find((s) => s[1] === nextStop) : null;
        return { ...l, into, toNext };
      });
      blocks.push({ kind: 'fork', grp: sg, lanes, next: final ? rows[j] : null, cont: si > 0, more: !final });
    });
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
  return u ? avatar(u, size, n) : `<span class="av" style="width:${size}px;height:${size}px;background:#8B95A1;font-size:${Math.round(size * 0.45)}px">${esc([...n][0] || '?')}</span>`;
}
/** 누구 일정 보기 버튼 */
function viewAsBtns(t, cur) {
  return `<div class="vabtns">${cur ? '<button class="vab" data-act="viewAs" data-v="">👥 전체</button>' : ''}${peopleOf(t).map((p) => `<button class="vab ${p === cur ? 'on' : ''}" data-act="viewAs" data-v="${esc(p)}">${nameAvatar(t, p, 18)}${esc(p)} 일정</button>`).join('')}</div>`;
}

/** 날씨 이모지 → 분위기 (배경 꾸미기용) */
function wxKind(e = '') {
  if (/⛈|🌧|☔|🌦/.test(e)) return 'rain';
  if (/🌨|❄/.test(e)) return 'snow';
  if (/☁|🌫|💨|🌥/.test(e)) return 'cloud';
  if (/⛅/.test(e)) return 'partly';
  return 'sun';
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
  // 같은 날 출발·도착이 바로 붙어 있으면 한 상자로 (도착 줄은 숨김)
  pairedFlights.clear();
  if (!S.ordering) allRows.forEach((r, k) => { const nx = allRows[k + 1]; if (r.kind === 'flight' && r.f._kind === 'dep' && nx?.kind === 'flight' && nx.f.id === r.f.id && nx.f._kind === 'arr') pairedFlights.add(r.f.id); });
  const rowHtml = (r, seg) => (seg ? segRow(t, seg[0], seg[1]) : '') + (r.kind === 'flight' ? flightRow(r.f, S.ordering) : itemRow(t, r.i, pinNo.get(r.i.id), items));
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
    const w = W[d];
    return `<button class="day ${d === S.day ? 'on' : ''}" data-act="day" data-v="${esc(d)}" style="--dc:${DAYCOLORS[idx % DAYCOLORS.length]}"><b><i class="ddot"></i>Day ${idx + 1}</b><span>${d.startsWith('day') ? '' : esc(md(d))}</span>${w ? `<i class="dwx wx-${wxKind(w.emoji)}">${w.emoji} ${Math.round(w.max)}°</i>` : ''}</button>`;
  }).join('')}</div>
  ${wx ? `<div class="wxcard ${wx.kind} wx-${wxKind(wx.emoji)}">
      <div class="wxc-l"><div class="wxc-place">${esc(t.city || '여행지')}${S.day && !S.day.startsWith('day') ? ` · ${esc(md(S.day))}` : ''}</div>
        <div class="wxc-temp">${Math.round(wx.max)}°</div>
        <div class="wxc-cond">${esc(wx.text || '')}</div>
        <div class="wxc-hl">최고 ${Math.round(wx.max)}° · 최저 ${Math.round(wx.min)}°</div></div>
      <div class="wxc-r"><span class="wxc-e">${wx.emoji}</span>
        <span class="wxc-sub">${wx.kind === 'forecast' ? (wx.pop != null ? `☂︎ ${wx.pop}%` : '예보') : `작년 이맘때${wx.rain ? ` · 비 ${Math.round(wx.rain)}mm` : ''}`}</span></div>
      <div class="wxc-note">${wx.kind === 'forecast' ? '' : '예보는 출발 10일 전부터 떠요 · '}출처 ${esc(wx.src || (wx.kind === 'forecast' ? 'Google 날씨' : 'Open-Meteo'))}</div>
    </div>` : ''}
  ${va ? `<div class="vabar"><b>${nameAvatar(t, va, 22)}${esc(va)} 일정으로 보는 중</b>${viewAsBtns(t, va)}</div>` : ''}
  <div id="daysum">${daySummaryHtml(t, S.day)}</div>
  <div class="planbar">${items.length > 1 ? '<span class="lphint">꾹 눌러서 순서 바꾸기</span>' : ''}</div>
  ${body ? `<div class="timeline">${body}</div>`
    : va && hasFork ? `<div class="empty"><b>${esc(va)} 일정이 없어요</b></div>`
    : '<div class="empty"><b>이 날 일정이 비어 있어요</b>가고 싶은 곳을 추가해 보세요.</div>'}`;
}

/** 따로 다니는 시간: 사람별 칸 (같은 일정끼리는 한 칸), 칸 안에도 이동 시간 */
function forkHtml(t, b, pinNo) {
  const { grp, lanes, next, cont, more } = b;
  const times = grp.map((r) => r.time).filter(Boolean);
  const mini = (r) => {
    if (r.kind === 'flight') {
      const f = r.f; const dep = f._kind === 'dep';
      return `<div class="mini fl" data-act="tab" data-v="flight" data-lp="F:${esc(f.id)}~${esc(f._kind)}"><span>${esc(r.time || '')}</span><b>${dep ? '🛫 ' + esc(f.from || '') + ' 출발' : '🛬 ' + esc(f.to || '') + ' 도착'}</b></div>`;
    }
    const i = r.i; const c = (ICATS[i.cat] || ICATS.기타)[1]; const no = pinNo.get(i.id);
    return `<div class="mini" style="--c:${c}" data-act="editItem" data-id="${esc(i.id)}" data-lp="${esc(i.id)}"><span>${no ? `<i class="mno">${no}</i>` : ''}${esc(i.time || '')}</span><b>${esc(i.title)}</b>${itemSpendHtml(t, i)}</div>`;
  };
  const nextTitle = next ? (next.kind === 'item' ? (next.i.kind === 'memo' ? '' : next.i.title) : '') : '';
  return `<div class="fork${cont ? ' cont' : ''}${more ? ' more' : ''}">
    <div class="forkhead">${cont ? '↙↘ 이어서' : '↙↘ 따로 다니는 시간'}${times.length ? ` ${esc(times[0])}${times.length > 1 ? ' – ' + esc(times[times.length - 1]) : ''}` : ''}</div>
    ${cont ? '' : viewAsBtns(t, null)}
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
    if (routeStore.tripId !== t.id) loadRouteStore(t.id);
    await routeStore.ready;
    const jobs = [];
    for (const d of days) {
      for (const [a, b] of daySegments(d, myName(t))) {
        const mode = segMode(t, b);
        if (segResult(a, b, mode)) continue;
        const key = segKey(a, b, mode);
        jobs.push(routeFor(t, a, b, mode).then((res) => { segCache.set(key, { ...res, key }); saveStop(t, b, { [b._mk]: { ...res, key } }); putRoute(t, key, res); }).catch(() => {}));
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
  const ttype = tripType(t);
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
    <div class="rc-hero"><div class="rc-glow"></div><div class="rc-city">${esc(t.city || 'TRIP')}</div><h1>${esc(t.name)}</h1>
      <div class="rc-dates">${t.start ? esc(md(t.start)) + (t.end && t.end !== t.start ? ' – ' + esc(md(t.end)) : '') : ''}${nights ? ' · ' + nights : ''}</div>
      <div class="rc-people">${(t.members || []).map((u) => avatar(u, 30, t.memberNames?.[u])).join('')}</div></div>
    <div class="rc-grid rc-a">
      <div><span>📍</span><b data-cnt="${sum('places')}">${sum('places')}</b><i>곳 방문${done ? ` (${done} 완료)` : ''}</i></div>
      <div><span>🚶</span><b>${sum('walkS') ? fmtDur(sum('walkS')) : '-'}</b><i>${sum('walkM') ? fmtDist(sum('walkM')) + ' 걸음' : '걸은 시간'}</i></div>
      <div><span>🍜</span><b data-cnt="${sum('meals')}" data-suf="끼">${sum('meals')}끼</b><i>맛집</i></div>
      <div><span>☕</span><b data-cnt="${sum('cafes')}" data-suf="곳">${sum('cafes')}곳</b><i>카페</i></div>
      <div><span>🛍</span><b data-cnt="${sum('shops')}" data-suf="곳">${sum('shops')}곳</b><i>쇼핑</i></div>
      <div><span>✈️</span><b data-cnt="${S.flights.length}" data-suf="편">${S.flights.length}편</b><i>비행</i></div>
    </div>
    ${ttype ? `<div class="rc-type rc-a"><div class="rct-e">${ttype.emoji}</div><div class="rct-k">이번 여행은</div><div class="rct-t">${esc(ttype.title)}</div><div class="rct-s">${esc(ttype.sub)}</div>
      <div class="rct-bars">${ttype.rows.map(([k, e, x]) => `<div class="rct-row"><span>${e} ${k}</span><div><i style="--w:${Math.round(x * 100)}%"></i></div><b>${Math.round(x * 100)}%</b></div>`).join('')}</div></div>` : ''}
    <div class="sum rc-money rc-a"><div class="lbl">총 지출</div><div class="big" data-cnt="${Math.round(total)}" data-won="1">${won(total)}</div>
      <div class="bars">${total ? cats.map(([c, x]) => `<div style="width:${(x / total) * 100}%;background:${ECATS[c] || '#888'}"></div>`).join('') : ''}</div>
      <div class="legend">${cats.map(([c, x]) => `<span><i style="background:${ECATS[c] || '#888'}"></i>${esc(c)} ${won(x)}</span>`).join('')}${total ? `<span>· 1인당 약 ${won(total / ppl)}</span>` : ''}</div></div>
    <div class="rc-best rc-a">
      ${topSpend && topSpend.spent ? `<div>💸 가장 많이 쓴 날<b>${esc(dayLabel(topSpend, per.indexOf(topSpend)))} · ${won(topSpend.spent)}</b></div>` : ''}
      ${topWalk && topWalk.walkS ? `<div>🚶 가장 많이 걸은 날<b>${esc(dayLabel(topWalk, per.indexOf(topWalk)))} · ${fmtDur(topWalk.walkS)}</b></div>` : ''}
    </div>
    ${awardsHtml(t)}
    <h3 class="rc-h">하루하루</h3>
    ${per.map((x, i) => `<div class="rc-day rc-a"><div class="rc-dh"><b>${esc(dayLabel(x, i))}</b>${W[x.d] ? `<span>${W[x.d].emoji} ${Math.round(W[x.d].max)}°</span>` : ''}${x.spent ? `<span class="mono">${won(x.spent)}</span>` : ''}</div>
      <div class="rc-route">${x.items.length ? x.items.map((it) => `<span style="--c:${(ICATS[it.cat] || ICATS.기타)[1]}">${esc(it.title)}</span>`).join('<em>→</em>') : '<span class="muted">기록 없음</span>'}</div></div>`).join('')}
    ${leftWish.length ? `<h3 class="rc-h">다음에 가볼 곳 (못 간 찜 ${leftWish.length})</h3><div class="rc-route">${leftWish.map((p) => `<span style="--c:${(ICATS[p.cat] || ICATS.기타)[1]}">${esc(p.name)}</span>`).join('')}</div>` : ''}
    <div id="rcNotes"></div>
    <button class="btn pri block" data-rc="copy" data-text="${esc(text)}" style="margin:22px 0 8px">리캡 텍스트 복사하기</button>
  </div>`;
  animateRecap(v);
  const box = v.querySelector('#rcNotes'); const copyBtn = v.querySelector('[data-rc=copy]');
  const syncCopy = (notes) => {
    const extra = notes.filter((n) => !n.to).map((n) => `✍️ ${noteName(t, n)} ${n.mood || ''} "${n.text}"`);
    copyBtn.dataset.text = extra.length ? `${text}\n\n${extra.join('\n')}` : text;
  };
  syncCopy(await drawNotes(t, box));
  box.addEventListener('click', (e) => onNotesClick(e, t, box, syncCopy));
}

/** 여행 성격: 일정 분류 비중 + 지출 비중을 반반 섞어서 가장 큰 쪽 */
function tripType(t) {
  const its = S.items.filter((i) => i.kind !== 'memo');
  const th = { 음식: 0, 쇼핑: 0, 관광: 0 }; const map = { 맛집: '음식', 카페: '음식', 쇼핑: '쇼핑', 관광: '관광' };
  let ni = 0; its.forEach((i) => { const k = map[i.cat]; if (k) { th[k]++; ni++; } });
  const sp = { 음식: 0, 쇼핑: 0, 관광: 0 }; const em = { 식비: '음식', 쇼핑: '쇼핑', 관광: '관광' };
  let ns = 0; S.expenses.forEach((e) => { const k = em[e.cat]; const v = toKRW(t, e); if (k && v > 0) { sp[k] += v; ns += v; } });
  if (!ni && !ns) return null;
  const sc = {}; Object.keys(th).forEach((k) => { sc[k] = ni && ns ? (th[k] / ni + sp[k] / ns) / 2 : ni ? th[k] / ni : sp[k] / ns; });
  const rows = [['음식', '🍜'], ['쇼핑', '🛍'], ['관광', '📸']].map(([k, e]) => [k, e, sc[k]]).sort((a, b) => b[2] - a[2]);
  const [top, , x] = rows[0];
  const T = {
    음식: ['🍜', '음식 중심의 여행이었어요', '먹는 게 남는 거, 맞죠?'],
    쇼핑: ['🛍', '쇼핑 중심의 여행이었어요', '캐리어가 무거워진 이유'],
    관광: ['📸', '관광 중심의 여행이었어요', '많이 보고 많이 걸었어요'],
  };
  const [emoji, title, sub] = x < 0.42 ? ['🎒', '골고루 즐긴 여행이었어요', `조금 더 ${top} 쪽이었어요`] : T[top];
  return { emoji, title, sub, rows };
}
/** 리캡 움직임: 스크롤하면 하나씩 떠오르고, 숫자는 0부터 올라감 */
function animateRecap(v) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { v.querySelectorAll('.rc-a').forEach((x) => x.classList.add('in')); return; }
  const count = (el) => {
    const to = Number(el.dataset.cnt) || 0; if (!to) return; const suf = el.dataset.suf || ''; const isWon = el.dataset.won;
    const t0 = performance.now(); const dur = isWon ? 1400 : 900;
    const step = (now) => { const p = Math.min(1, (now - t0) / dur); const e = 1 - Math.pow(1 - p, 3); const n = Math.round(to * e);
      el.textContent = isWon ? won(n) : n + suf; if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  };
  const io = new IntersectionObserver((ents) => ents.forEach((en) => {
    if (!en.isIntersecting) return; const el = en.target; io.unobserve(el); el.classList.add('in');
    el.querySelectorAll('[data-cnt]').forEach(count);
  }), { root: v, threshold: 0.18 });
  v.querySelectorAll('.rc-a').forEach((el, k) => { el.style.setProperty('--d', `${Math.min(k, 3) * 90}ms`); io.observe(el); });
}

/* ---------- 리캡: 우리끼리 어워드 · 후기 · 서로에게 한마디 ---------- */
function awardsHtml(t) {
  const rated = S.items.filter((i) => i.kind !== 'memo').map((i) => {
    const vs = Object.values(i.ratings || {}).filter((x) => x > 0);
    return { i, avg: vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0, n: vs.length };
  }).filter((x) => x.n).sort((a, b) => b.avg - a.avg || b.n - a.n).slice(0, 3);
  const ppl = peopleOf(t); let wallet = null;
  if (ppl.length > 1 && S.expenses.length) {
    const { paid } = settle(t);
    const top = Object.entries(paid).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] > 0) wallet = top;
  }
  const food = S.items.filter((i) => i.cat === '맛집').length;
  if (!rated.length && !wallet && !food) return '';
  const medal = ['🥇', '🥈', '🥉'];
  return `<h3 class="rc-h">🏆 우리끼리 어워드</h3><div class="aw rc-a">
    ${rated.length ? `<div class="aw-card best"><div class="aw-t">⭐ 별점 베스트</div>${rated.map((x, k) => { const c = Object.values(x.i.comments || {}).filter(Boolean)[0]; return `<div class="aw-row"><span>${medal[k]}</span><b>${esc(x.i.title)}${c ? `<small>“${esc(c)}”</small>` : ''}</b><i>★${x.avg.toFixed(1)}</i></div>`; }).join('')}</div>` : ''}
    ${wallet ? `<div class="aw-card"><div class="aw-big">👛</div><div class="aw-t">든든한 지갑상</div><b>${esc(wallet[0])}</b><i>${won(wallet[1])} 결제</i></div>` : ''}
    ${food ? `<div class="aw-card"><div class="aw-big">🍜</div><div class="aw-t">먹방 기록</div><b>${food}끼</b><i>${food >= 8 ? '배 터지는 여행' : food >= 4 ? '알차게 냠냠' : '소소하게 냠'}</i></div>` : ''}
  </div>`;
}
const noteName = (t, n) => t.memberNames?.[n.by] || nameOf(t, n.by);
const MOODS = ['🥰', '😆', '😋', '🥹', '😴', '🤯'];
const STICKERS = ['💌', '🫶', '🍻', '🐻', '🌸', '👍', '🎉', '🍀'];
const NOTE_BG = ['#FFE9A8', '#FFD6E0', '#D6ECFF', '#DDF5D9', '#EBDDFF'];
async function drawNotes(t, box) {
  let notes = [];
  try {
    const snap = await getDocs(collection(db, 'trips', t.id, 'notes'));
    notes = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  } catch (e) { console.error(e); }
  const mine = myName(t); const others = peopleOf(t).filter((p) => p !== mine);
  const st = box._st || (box._st = { mode: 'review', mood: '🥰', to: others[0] || null, sticker: '💌', draft: '' });
  if (!others.length) st.mode = 'review';
  const reviews = notes.filter((n) => !n.to); const letters = notes.filter((n) => n.to);
  const delBtn = (n) => (n.by === S.user.uid ? `<button class="nt-del" data-rw="del" data-id="${esc(n.id)}">✕</button>` : '');
  box.innerHTML = `
    <h3 class="rc-h">✍️ 여행 후기</h3>
    ${reviews.length ? `<div class="rv-list">${reviews.map((n) => `<div class="rv">${delBtn(n)}<div class="rv-mood">${esc(n.mood || '🥰')}</div>
      <div style="min-width:0"><div class="rv-who">${nameAvatar(t, noteName(t, n), 20)}<b>${esc(noteName(t, n))}</b></div><p>${esc(n.text)}</p></div></div>`).join('')}</div>`
      : '<div class="rc-empty">아직 후기가 없어요. 첫 후기를 남겨 보세요 ✨</div>'}
    ${others.length ? `<h3 class="rc-h">💌 서로에게 한마디</h3>
      ${letters.length ? `<div class="lt-list">${letters.map((n, k) => `<div class="lt ${n.to === mine ? 'forme' : ''}" style="--bg:${NOTE_BG[k % NOTE_BG.length]};--rot:${k % 2 ? 1.6 : -1.4}deg">${delBtn(n)}
        <div class="lt-to">To. ${esc(n.to)}${n.to === mine ? ' <i>나에게 온 편지</i>' : ''}</div><div class="lt-st">${esc(n.sticker || '💌')}</div>
        <p>${esc(n.text)}</p><div class="lt-from">From. ${esc(noteName(t, n))}</div></div>`).join('')}</div>`
        : '<div class="rc-empty">고마웠던 거, 웃겼던 거 한마디 남겨 보세요 💌</div>'}` : ''}
    <div class="rc-write">
      ${others.length ? `<div class="rw-tabs"><button data-rw="mode" data-v="review" class="${st.mode === 'review' ? 'on' : ''}">✍️ 후기 쓰기</button><button data-rw="mode" data-v="letter" class="${st.mode === 'letter' ? 'on' : ''}">💌 한마디 쓰기</button></div>` : ''}
      ${st.mode === 'review'
        ? `<div class="rw-lbl">이번 여행 기분은?</div><div class="rw-pick">${MOODS.map((m) => `<button data-rw="mood" data-v="${m}" class="${m === st.mood ? 'on' : ''}">${m}</button>`).join('')}</div>`
        : `<div class="rw-lbl">누구에게?</div><div class="rw-pick names">${others.map((p) => `<button data-rw="to" data-v="${esc(p)}" class="${p === st.to ? 'on' : ''}">${nameAvatar(t, p, 20)}${esc(p)}</button>`).join('')}</div>
           <div class="rw-lbl">스티커 붙이기</div><div class="rw-pick">${STICKERS.map((m) => `<button data-rw="sticker" data-v="${m}" class="${m === st.sticker ? 'on' : ''}">${m}</button>`).join('')}</div>`}
      <textarea class="inp" id="rwText" rows="3" maxlength="300" placeholder="${st.mode === 'review' ? '제일 좋았던 순간, 다음엔 꼭 할 것…' : `${esc(st.to || '')}에게 하고 싶은 말`}">${esc(st.draft)}</textarea>
      <button class="btn pri block" data-rw="save">${st.mode === 'review' ? '후기 남기기 ✨' : '한마디 보내기 💌'}</button>
    </div>`;
  return notes;
}
async function onNotesClick(e, t, box, syncCopy) {
  const b = e.target.closest('[data-rw]'); if (!b) return;
  const st = box._st; const ta = box.querySelector('#rwText'); if (ta) st.draft = ta.value;
  const k = b.dataset.rw, val = b.dataset.v;
  if (k === 'mode' || k === 'mood' || k === 'to' || k === 'sticker') { st[k] = val; syncCopy(await drawNotes(t, box)); return; }
  if (k === 'del') {
    if (!b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = '지울까요?'; return; }
    write(() => deleteDoc(doc(db, 'trips', t.id, 'notes', b.dataset.id)));
    syncCopy(await drawNotes(t, box)); return;
  }
  if (k === 'save') {
    const text = st.draft.trim(); if (!text) return toast(st.mode === 'review' ? '후기를 한 줄이라도 적어 주세요' : '한마디를 적어 주세요');
    const data = st.mode === 'review'
      ? { text, mood: st.mood, to: null }
      : { text, sticker: st.sticker, to: st.to };
    b.disabled = true;
    write(() => setDoc(doc(db, 'trips', t.id, 'notes', uid()), { ...data, by: S.user.uid, createdAt: Date.now() }));
    st.draft = '';
    syncCopy(await drawNotes(t, box));
    toast(st.mode === 'review' ? '후기를 남겼어요 ✨' : `${st.to}에게 한마디를 보냈어요 💌`);
  }
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
      geo = it ? { lat: it.lat, lng: it.lng } : (await geocodeCity(t.city).catch(() => null)) || (await geocodeCityG(t.city).catch(() => null));
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
// 구간 키: 좌표 + 수단만 (일정 순서가 바뀌어도 같은 두 지점이면 다시 계산 안 함)
const c5 = (x) => Number(x).toFixed(5);
// 'r2' = 대중교통 대기시간 빼고 요일·시차 맞춘 계산 (예전 값은 다시 계산)
const segKey = (from, to, mode) => [c5(from.lat), c5(from.lng), c5(to.lat), c5(to.lng), mode, ...(mode === 'auto' || mode === 'transit' ? ['r2'] : [])].join('|');
const oldSegKey = (from, to, mode) => [from.id, from.lat, from.lng, to.lat, to.lng, mode].join('|'); // 예전에 저장된 결과도 재사용
const segCache = new Map(); // key -> {meters,secs,used} | {none} | 'loading' | {err}
// 여행 전체가 같이 쓰는 경로 결과 (trips/{id}/routes/{key}). 동행인이 이미 계산한 구간은 API 안 부름
const routeStore = { tripId: null, map: new Map(), ready: null };
function loadRouteStore(tripId) {
  routeStore.tripId = tripId; routeStore.map = new Map();
  routeStore.ready = tripId ? getDocs(collection(db, 'trips', tripId, 'routes'))
    .then((s) => { if (routeStore.tripId === tripId) s.docs.forEach((d) => routeStore.map.set(d.id, d.data())); })
    .catch((e) => console.warn('routes', e)) : Promise.resolve();
  return routeStore.ready;
}
function putRoute(t, key, res) {
  if (!res || res.err || routeStore.tripId !== t.id) return;
  const v = { ...res, key, at: Date.now() };
  routeStore.map.set(key, v);
  setDoc(doc(db, 'trips', t.id, 'routes', key), v).catch(() => {});
}
const gDirUrl = (from, to, m) => `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&travelmode=${MOVES[m][3]}`;
const segCN = (from, to) => inChina(from) && inChina(to);
// 중국 본토 구간은 고덕 길찾기
const dirUrl = (from, to, m) => (segCN(from, to) ? amapDirUrl(from, to, m) : gDirUrl(from, to, m));
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
    <button type="button" class="segsel" data-act="segpick" data-id="${esc(sid)}" data-auto="${esc(autoUsed || '')}" data-v="${esc(shown)}" aria-label="이동 수단 바꾸기">${MOVES[shown][0]}${cls ? '' : ` <span>${MOVES[shown][1]}</span>`}<i class="ti-caret">▾</i></button>
    <span class="seginfo" data-seginfo="${esc(sid)}">${segText(from, to, mode)}</span>
    ${(() => { const ti = tinfoOf(to); if (ti) return `<button type="button" class="tichip" data-act="tinfo" data-id="${esc(sid)}">${TKINDS[ti.kind] || '🎫'} ${esc([ti.kind, ti.no].filter(Boolean).join(' ') || '교통편')}${(ti.photos || []).length ? ' · 🎫' : ''}${ti.memo ? ' · 📝' : ''}</button>`; return shown === 'transit' && !cls ? `<button type="button" class="tichip add" data-act="tinfo" data-id="${esc(sid)}">+ 교통편</button>` : ''; })()}
    ${shown === 'drive' ? `<button type="button" class="taxibtn" data-act="taxi" data-id="${esc(sid)}">🚕 택시</button>` : ''}
    <a class="seglink" data-seglink="${esc(sid)}" href="${esc(dirUrl(from, to, shown))}" target="_blank" rel="noopener">${segCN(from, to) ? '고덕 길찾기' : '길찾기'}</a>
  </div>`;
}
function segResult(from, to, mode) {
  const k = segKey(from, to, mode);
  if (segCache.has(k)) return segCache.get(k);
  const m = to.move; // 저장해 둔 계산 결과 재사용 (API 호출 아끼기)
  if (m && (m.key === k || (!k.endsWith('|r2') && m.key === oldSegKey(from, to, mode)))) { segCache.set(k, m); return m; }
  const g = routeStore.map.get(k);
  if (g) { segCache.set(k, g); return g; }
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
async function routeFor(t, from, to, mode) {
  const date = from.date || to.date || t.start || null;
  const when = { time: from.time || to.time, date, offsetMin: t.tz ? tzOffsetMin(t.tz, date ? new Date(date + 'T12:00:00Z') : new Date()) : null };
  if (mode !== 'auto') {
    const r = await computeRoute(from, to, MOVES[mode][2], when);
    return r?.none ? { none: true } : { ...r, used: mode };
  }
  // 직선 4km 넘으면 걸어서 50분 이상이라 도보 계산은 건너뜀 (대중교통 정보 없을 때만 도보 계산)
  if (straightM(from, to) > 4000) {
    const tr0 = await computeRoute(from, to, 'TRANSIT', when);
    if (tr0 && !tr0.none) return { ...tr0, used: 'transit' };
    const w0 = await computeRoute(from, to, 'WALK', when);
    return w0 && !w0.none ? { ...w0, used: 'walk', transitNone: true } : { none: true };
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
  if (routeStore.tripId !== t.id) loadRouteStore(t.id);
  await routeStore.ready; // 동행인이 계산해 둔 결과부터 확인
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
      document.querySelectorAll(`.segsel[data-id="${q}"]`).forEach((sel) => {
        if (mode === 'auto' && r && r.used) {
          sel.dataset.v = r.used; sel.dataset.auto = r.used;
          const small = !sel.querySelector('span'); sel.innerHTML = `${MOVES[r.used][0]}${small ? '' : ` <span>${MOVES[r.used][1]}</span>`}<i class="ti-caret">▾</i>`;
        }
      });
      refreshDaySum();
    };
    routeFor(t, from, to, mode).then((res) => {
      segCache.set(key, { ...res, key });
      saveStop(t, to, { [to._mk]: { ...res, key } });
      putRoute(t, key, res);
      paint();
    }).catch((e) => { console.error(e); segCache.set(key, { err: true }); paint(); });
  }
}
const saveStop = (t, st, data) => updateDoc(doc(db, 'trips', t.id, st._col, st._doc), data).catch(() => {});

function flightRow(f, ordering) {
  const tok = `F:${f.id}~${f._kind}`;
  const dep = f._kind === 'dep';
  if (!ordering && pairedFlights.has(f.id)) {
    if (!dep) return '';
    const mins = f.depAt && f.arrAt ? Math.round((Date.parse(f.arrAt.replace(' ', 'T')) - Date.parse(f.depAt.replace(' ', 'T'))) / 6e4) : 0;
    const sub = [[f.airline, f.flightNo].filter(Boolean).join(' '), f.terminal, f.bookingRef ? '예약 ' + f.bookingRef : '', (f.qrIds || []).length ? '📱 QR' : ''].filter(Boolean).join(' · ');
    return `<div class="item flightrow pair" style="--cat:#1F2A44" data-act="tab" data-v="flight" data-lp="${esc(tok)}">
      <div class="irow"><div class="itime">${esc(f.time || '--:--')}<small>${esc(hm(f.arrAt) || '')}</small></div>
      <div style="flex:1;min-width:0"><div class="ititle">✈️ ${esc(f.from || '?')} <span class="fl-arrow">→</span> ${esc(f.to || '?')}${mins > 0 ? `<span class="fl-dur">${Math.floor(mins / 60) ? Math.floor(mins / 60) + '시간 ' : ''}${mins % 60 ? (mins % 60) + '분' : ''}</span>` : ''}</div>
      ${sub ? `<div class="imemo">${esc(sub)}</div>` : ''}
      ${(() => { const w = flightWho(trip(), f); return w.length ? `<div class="bp-who small">${peopleChips(trip(), w)}</div>` : ''; })()}</div></div></div>`;
  }
  const title = dep ? `🛫 ${esc(f.from || '?')} 출발 → ${esc(f.to || '?')}` : `🛬 ${esc(f.to || '?')} 도착 (${esc(f.from || '?')}에서)`;
  const sub = [f.airline, f.flightNo].filter(Boolean).join(' ')
    + (dep && f.terminal ? ` · ${f.terminal}` : '')
    + (dep && f.arrAt ? ` · 도착 ${hm(f.arrAt)}` : '')
    + (!dep && f.depAt ? ` · 출발 ${hm(f.depAt)}` : '');
  if (ordering) {
    return `<div class="item ordering flightrow ${dep ? '' : 'arr'}" style="--cat:#1F2A44" data-drag="${esc(tok)}"><div class="irow">
      <div class="itime">${esc(f.time || '--:--')}</div><div style="flex:1;min-width:0"><div class="ititle">${title}</div><div class="iaddr">${esc(sub)}</div></div>
      <div class="draghandle" aria-label="끌어서 순서 바꾸기">≡</div></div></div>`;
  }
  return `<div class="item flightrow ${dep ? '' : 'arr'}" style="--cat:#1F2A44" data-act="tab" data-v="flight" data-lp="${esc(tok)}">
    <div class="irow"><div class="itime">${esc(f.time || '--:--')}</div>
    <div style="flex:1;min-width:0"><div class="ititle">${title}</div>
    <div class="imemo">${esc(sub)}${dep && f.bookingRef ? ' · 예약 ' + esc(f.bookingRef) : ''}${dep && (f.qrIds || []).length ? ' · 📱 QR' : ''}</div>
    ${(() => { const w = flightWho(trip(), f); return w.length ? `<div class="bp-who small">${peopleChips(trip(), w)}</div>` : ''; })()}</div></div></div>`;
}
/** 완료한 일정 별점: 내 별점(끌어서 0.5 단위) + 같이 간 사람 평균 */
function starsHtml(t, i) {
  const all = Object.values(i.ratings || {}).filter((v) => v > 0);
  const mine = i.ratings?.[S.user?.uid] || 0;
  const avg = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;
  return `<div class="rate" data-rate="${esc(i.id)}">
    <div class="stars" style="--v:${(mine / 5) * 100}%" aria-label="별점"><span class="sbg">★★★★★</span><span class="sfg">★★★★★</span></div>
    <span class="rtxt">${mine ? mine.toFixed(1) : '← 끌어서 별점'}</span>
    ${all.length > 1 ? `<span class="ravg">같이 평균 ★${avg.toFixed(1)} · ${all.length}명</span>` : ''}
    ${cmtHtml(t, i, mine)}
  </div>`;
}
/** 별점 한줄평: 내 것은 눌러서 수정, 같이 간 사람 것도 보여줌 */
function cmtHtml(t, i, mine) {
  const cs = Object.entries(i.comments || {}).filter(([, x]) => x);
  const my = i.comments?.[S.user?.uid] || '';
  const others = cs.filter(([u]) => u !== S.user?.uid);
  if (!mine && !cs.length) return '';
  return `<div class="rcmts">${mine ? `<button class="rcmt ${my ? 'has' : ''}" data-act="rcomment" data-id="${esc(i.id)}">${my ? `💬 ${esc(my)}` : '💬 한줄평 남기기'}</button>` : ''}
    ${others.map(([u, x]) => `<div class="rcmt-o">${avatar(u, 16, t.memberNames?.[u])}<span>${esc(x)}</span>${i.ratings?.[u] ? `<i>★${Number(i.ratings[u]).toFixed(1)}</i>` : ''}</div>`).join('')}</div>`;
}
function commentSheet(t, i) {
  if (!i) return;
  const my = i.comments?.[S.user.uid] || '';
  openSheet(`<h2>한줄평</h2><p class="small muted" style="margin-top:-6px">${esc(i.title)} · ★${Number(i.ratings?.[S.user.uid] || 0).toFixed(1)}</p>
    <input class="inp" name="cmt" maxlength="60" value="${esc(my)}" placeholder="예: 웨이팅 1시간, 그래도 또 올 맛" enterkeyhint="done">
    <div class="rowbtns">${my ? '<button class="btn danger" data-x="del">지우기</button>' : ''}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    const inp = sh.querySelector('[name=cmt]');
    { let done = false; const f = () => { if (done) return; done = true; inp.focus({ preventScroll: true }); }; sh.addEventListener('animationend', f, { once: true }); setTimeout(f, 350); }
    const save = (txt) => {
      closeSheet(); const it = S.items.find((x) => x.id === i.id); if (it) it.comments = { ...(it.comments || {}), [S.user.uid]: txt };
      write(() => updateDoc(doc(db, 'trips', t.id, 'items', i.id), { [`comments.${S.user.uid}`]: txt }));
      render();
    };
    sh.querySelector('[data-x=save]').onclick = () => save(inp.value.trim());
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save(inp.value.trim()); } });
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => save(''));
  });
}
/* 별점: 별 위를 누르거나 끌어서 */
document.addEventListener('pointerdown', (ev) => {
  const st = ev.target.closest('.rate .stars'); if (!st) return;
  const t = trip(); const id = st.closest('.rate').dataset.rate; if (!t || !id) return;
  ev.preventDefault(); ev.stopPropagation();
  const txt = st.parentElement.querySelector('.rtxt');
  let v = 0;
  const set = (x) => {
    const r = st.getBoundingClientRect();
    v = Math.min(5, Math.max(0.5, Math.ceil(((x - r.left) / r.width) * 10) / 2));
    st.style.setProperty('--v', `${(v / 5) * 100}%`); txt.textContent = v.toFixed(1);
  };
  set(ev.clientX); navigator.vibrate?.(8);
  let last = v;
  const move = (e) => { set(e.clientX); if (v !== last) { last = v; navigator.vibrate?.(5); } };
  const up = () => {
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
    const it = S.items.find((x) => x.id === id); if (it) it.ratings = { ...(it.ratings || {}), [S.user.uid]: v };
    write(() => updateDoc(doc(db, 'trips', t.id, 'items', id), { [`ratings.${S.user.uid}`]: v }));
  };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
});
function itemRow(t, i, no, list) {
  const c = i.kind === 'memo' ? ['#FFF6CC', '#C9A227'] : ICATS[i.cat] || ICATS.기타;
  if (S.ordering) {
    const k = list.findIndex((x) => x.id === i.id);
    if (i.kind === 'memo') {
      return `<div class="item ordering memo" data-drag="${esc(i.id)}" style="${memoStyle(i)}"><div class="irow">
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
    return `<div class="item memo" style="${memoStyle(i)}" data-act="editMemo" data-id="${esc(i.id)}" data-lp="${esc(i.id)}"><div class="memotxt">${esc(i.memo || '')}</div>${itemSpendHtml(t, i)}</div>`;
  }
  return `<div class="item ${i.done ? 'done' : ''}" style="--cat:${c[1]}" data-lp="${esc(i.id)}" ${ll(i) ? `data-act="focus" data-id="${esc(i.id)}"` : ''}>
    ${i.done ? starsHtml(t, i) : ''}<div class="irow"><button class="itime tbtn ${i.time ? '' : 'empty'}" data-act="settime" data-id="${esc(i.id)}" aria-label="시간 변경">${esc(i.time || '시간')}</button>
      <div style="flex:1;min-width:0"><div class="ititle">${no ? `<span class="pinno" style="background:${c[1]}">${no}</span>` : ''}${esc(i.title)}</div>
      ${i.address ? `<div class="iaddr">${esc(i.address)}</div>` : ''}
      ${i.memo ? `<div class="imemo">${esc(i.memo)}</div>` : ''}
      ${itemSpendHtml(t, i)}
      <div class="iactions"><span class="tag" style="--bg:${c[0]};--fg:${c[1]}">${esc(catLabel(i.cat || '기타'))}</span>
        ${i.cat !== '이동' ? `<a class="lnk map" href="${esc(placeUrl(t, i))}" target="_blank" rel="noopener">구글맵</a>` : ''}
        ${i.cat !== '이동' && inChina(i) ? `<a class="lnk map" href="${esc(amapPlaceUrl(i, t.city))}" target="_blank" rel="noopener">고덕</a>` : ''}
        ${i.link ? `<a class="lnk" href="${esc(i.link)}" target="_blank" rel="noopener">링크</a>` : ''}
        <button class="lnk" data-act="toggleDone" data-id="${esc(i.id)}">${i.done ? '되돌리기' : '완료'}</button>
        <button class="lnk" data-act="editItem" data-id="${esc(i.id)}">수정</button>
      </div></div></div></div>`;
}

let lastMapSig = '';
// 지도 핀 팝업 아랫줄: Day · 시간 (주소 대신 메모는 따로 한 줄)
const pinSub = (day, i) => [day, i.time].filter(Boolean).join(' · ');
// 일정이 없을 때 여행 도시로 지도 맞추기 (찾은 좌표는 trip.geo에 저장해서 다음부터 API 없이)
// 구글 지오코딩은 한국(region KR) 쪽으로 쏠려서 '상하이' 같은 이름이 국내 장소로 잡힐 수 있음 → 도시 DB(Open-Meteo) 먼저
async function centerTrip(ctl, t) {
  const pre = t.geo || (await geocodeCity(t.city).catch(() => null));
  ctl.centerOn(t.city, pre).then((g) => {
    if (g && !t.geo && S.tripId === t.id) { t.geo = g; updateDoc(doc(db, 'trips', t.id), { geo: g }).catch(() => {}); }
  });
}
// 장소 검색 기준점: 지도 가운데. 지도가 아직 여행지 근처가 아니면(기본값 서울 등) 여행 도시 좌표
function searchNear(t) {
  const c = mapCtl?.map?.getCenter?.();
  const g = t?.geo;
  if (g && g.lat != null && (!c || straightM({ lat: c.lat(), lng: c.lng() }, g) > 300000)) return { center: { lat: +g.lat, lng: +g.lng }, radius: 50000 };
  return c ? { center: c, radius: 30000 } : undefined;
}
async function drawPlanMap(t, days) {
  if (!mapsEnabled) return showMap(false);
  showMap(true);
  const ctl = await ensureMap(); if (!ctl) return showMap(false);
  let groups;
  if (S.mapAll) {
    groups = days.map((d, idx) => ({
      color: DAYCOLORS[idx % DAYCOLORS.length], path: true,
      points: dayItems(d).filter(ll).map((i, k) => ({ lat: i.lat, lng: i.lng, label: k + 1, title: i.title, sub: pinSub(`Day ${idx + 1}`, i), memo: i.memo || '' })),
    }));
  } else {
    const idx = days.indexOf(S.day);
    groups = [{
      color: DAYCOLORS[Math.max(0, idx) % DAYCOLORS.length], path: true,
      points: dayItems(S.day).filter(ll).map((i, k) => ({ lat: i.lat, lng: i.lng, label: k + 1, title: i.title, sub: pinSub('', i), memo: i.memo || '' })),
    }];
  }
  const sig = JSON.stringify([t.id, groups]);
  if (sig !== lastMapSig) {
    lastMapSig = sig;
    const n = ctl.draw(groups);
    if (!n) centerTrip(ctl, t);
  }
  $('mapToggle').hidden = false; $('mapToggle').textContent = S.mapAll ? '이 날만 보기' : '전체 일정 보기';
  const r = routeUrl(t, dayItems(S.day));
  $('routeLink').hidden = !r || S.mapAll; if (r) $('routeLink').href = r;
}
function showMap(on) { $('mapwrap').hidden = !on; }

/* ---------- 찜 (일정에 안 넣고 모아두는 곳) ---------- */
const WCATS = ['맛집', '카페', '쇼핑', '관광', '숙소', '기타'];
const CAT_EMOJI = { 관광: '📸', 맛집: '🍜', 카페: '☕', 쇼핑: '🛍️', 숙소: '🏨', 이동: '🚌', 기타: '📌', 식비: '🍽️', 교통: '🚇', 항공: '✈️' };
const catLabel = (c) => `${CAT_EMOJI[c] ? CAT_EMOJI[c] + ' ' : ''}${c}`;
const SPEND_CAT = { 맛집: '식비', 카페: '식비', 쇼핑: '쇼핑', 관광: '관광', 숙소: '숙소', 이동: '교통', 기타: '기타' };
const votesOf = (p) => Object.keys(p.votes || {}).filter((u) => p.votes[u]);
const wishAdded = (p) => !!(p.addedTo && S.items.some((i) => i.id === p.addedTo.itemId));
function viewWish(t) {
  const addedN = S.places.filter(wishAdded).length;
  const all = [...S.places].filter((p) => !(S.wishHideAdded && wishAdded(p))).sort((a, b) => (S.wishSort === 'vote' ? votesOf(b).length - votesOf(a).length : 0) || (b.createdAt || 0) - (a.createdAt || 0));
  const cnt = (c) => all.filter((p) => (p.cat || '기타') === c).length;
  const list = S.wishCat === 'all' ? all : all.filter((p) => (p.cat || '기타') === S.wishCat);
  const days = tripDays(t);
  return `<div class="wishfilter">
      <button class="pill ${S.wishCat === 'all' ? 'on' : ''}" data-act="wishcat" data-v="all">전체 ${all.length}</button>
      ${WCATS.filter((c) => cnt(c)).map((c) => `<button class="pill ${S.wishCat === c ? 'on' : ''}" data-act="wishcat" data-v="${c}">${c} ${cnt(c)}</button>`).join('')}
    </div>
    ${(() => {
      // 일정 루트 같이 보기: 좌표 있는 일정이 있는 날만
      if (!mapsEnabled) return '';
      const rd = days.map((d, idx) => ({ d, idx })).filter(({ d }) => dayItems(d).some(ll));
      if (!rd.length) return '';
      const on = (v) => (S.wishRoute === v ? 'on' : '');
      return `<div class="wishroute"><span>🗺️ 루트 같이 보기</span>
        <button class="${S.wishRoute ? '' : 'on'}" data-act="wishroute" data-v="">끄기</button>
        ${rd.length > 1 ? `<button class="${on('all')}" data-act="wishroute" data-v="all">전체</button>` : ''}
        ${rd.map(({ d, idx }) => `<button class="${on(d)}" data-act="wishroute" data-v="${esc(d)}" style="--dc:${DAYCOLORS[idx % DAYCOLORS.length]}"><i></i>Day ${idx + 1}</button>`).join('')}</div>`;
    })()}
    ${all.length > 1 || addedN ? `<div class="wishsort"><button class="${S.wishSort === 'new' ? 'on' : ''}" data-act="wishsort" data-v="new">최신순</button><button class="${S.wishSort === 'vote' ? 'on' : ''}" data-act="wishsort" data-v="vote">👍 많은 순</button>
      ${addedN ? `<button class="hideadd ${S.wishHideAdded ? 'on' : ''}" data-act="wishHideAdded">${S.wishHideAdded ? '✓ ' : ''}일정에 넣은 곳 빼기</button>` : ''}</div>` : ''}
    ${list.length ? list.map((p) => {
      const c = ICATS[p.cat] || ICATS.기타;
      const added = p.addedTo && S.items.some((i) => i.id === p.addedTo.itemId);
      const dayNo = added ? days.indexOf(p.addedTo.date) + 1 : 0;
      return `<div class="wish ${added ? 'added' : ''}" style="--cat:${c[1]}" ${ll(p) ? `data-act="focusWish" data-id="${esc(p.id)}"` : ''}>
        <div class="wt"><span class="tag" style="--bg:${c[0]};--fg:${c[1]}">${esc(catLabel(p.cat || '기타'))}</span>${esc(p.name)}${added ? `<span class="addedtag">${dayNo > 0 ? 'Day ' + dayNo : '일정'}에 추가됨</span>` : ''}</div>
        ${p.by ? `<div class="wby">${avatar(p.by, 18, t.memberNames?.[p.by])}<span>${esc(nameOf(t, p.by))} 찜</span></div>` : ''}
        ${p.address ? `<div class="iaddr">${esc(p.address)}</div>` : ''}
        ${p.memo ? `<div class="imemo">${esc(p.memo)}</div>` : ''}
        <div class="iactions">
          ${(() => { const v = votesOf(p); const mine = v.includes(S.user.uid); return `<button class="vote ${mine ? 'on' : ''}" data-act="vote" data-id="${esc(p.id)}" aria-pressed="${mine}">👍 ${v.length || ''}${v.length ? `<span class="vavs">${v.slice(0, 3).map((u) => avatar(u, 16, t.memberNames?.[u])).join('')}</span>` : ''}</button>`; })()}
          <button class="lnk map" data-act="toPlan" data-id="${esc(p.id)}">📅 일정에 넣기</button>
          <a class="lnk" href="${esc(placeUrl(t, { title: p.name, placeId: p.placeId }))}" target="_blank" rel="noopener">구글맵</a>
          ${inChina(p) ? `<a class="lnk" href="${esc(amapPlaceUrl(p, t.city))}" target="_blank" rel="noopener">고덕</a>` : ''}
          ${p.link ? `<a class="lnk" href="${esc(p.link)}" target="_blank" rel="noopener">링크</a>` : ''}
          <button class="lnk" data-act="editWish" data-id="${esc(p.id)}">수정</button>
        </div></div>`;
    }).join('') : `<div class="empty"><b>${S.wishHideAdded && S.places.length ? '일정에 안 넣은 찜이 없어요' : S.wishCat === 'all' ? '찜한 곳이 없어요' : S.wishCat + ' 찜이 없어요'}</b>가보고 싶은 맛집·카페·쇼핑 장소를 모아두고<br>날짜가 정해지면 일정으로 옮겨 보세요.</div>`}`;
}
async function drawWishMap(t) {
  if (!mapsEnabled) return showMap(false);
  showMap(true);
  const ctl = await ensureMap(); if (!ctl) return showMap(false);
  const ps = S.places.filter((p) => ll(p) && !(S.wishHideAdded && wishAdded(p)) && (S.wishCat === 'all' || (p.cat || '기타') === S.wishCat));
  const route = S.wishRoute;
  const groups = WCATS.map((c) => ({
    color: (ICATS[c] || ICATS.기타)[1], path: false, scale: route ? 1.15 : 1.05,
    points: ps.filter((p) => (p.cat || '기타') === c).map((p) => ({ lat: p.lat, lng: p.lng, label: c[0], title: p.name, sub: [`${CAT_EMOJI[c] || ''} ${c} 찜`, votesOf(p).length ? `👍 ${votesOf(p).length}` : ''].filter(Boolean).join(' · '), memo: p.memo || '' })),
  }));
  // 일자별 루트를 같이 그려서 찜한 곳이 어느 날 동선 근처인지 보기
  if (route) {
    const days = tripDays(t);
    days.forEach((d, idx) => {
      if (route !== 'all' && route !== d) return;
      const pts = dayItems(d).filter(ll).map((i, k) => ({ lat: i.lat, lng: i.lng, label: k + 1, title: i.title || '', sub: pinSub(`Day ${idx + 1}`, i), memo: i.memo || '' }));
      if (pts.length) groups.unshift({ color: DAYCOLORS[idx % DAYCOLORS.length], path: true, scale: 0.8, points: pts });
    });
  }
  lastMapSig = ''; if (!ctl.draw(groups)) centerTrip(ctl, t);
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
      const near = searchNear(t);
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
      const b = writeBatch(db);
      b.set(doc(db, 'trips', t.id, 'items', itemId), {
        title: p.name, date, time, memo: p.memo || '', link: p.link || '', cat: p.cat === '숙소' ? '숙소' : (ICATS[p.cat] ? p.cat : '기타'),
        lat: p.lat ?? null, lng: p.lng ?? null, address: p.address || '', placeId: p.placeId || null,
        done: false, createdAt: Date.now(), by: S.user.uid, fromWish: p.id, pos: insertPos(date, time),
      });
      b.update(doc(db, 'trips', t.id, 'places', p.id), { addedTo: { itemId, date } });
      commit(b);
      toast(`Day ${idx + 1}에 넣었어요`);
    };
  });
}

/* ---------- flights ---------- */
const sortFlights = () => [...S.flights].sort((a, b) => (a.depAt || '').localeCompare(b.depAt || ''));
function fdate(dt) { return dt ? `${md(dt)} ${hm(dt)}` : ''; }
/* ---------- 항공편 조회 (편명 불러오기 · 상태 체크) ---------- */
async function fetchFlight(no, date) {
  const tok = await idToken();
  bump('flight');
  const r = await fetch(`/api/flight?no=${encodeURIComponent(no)}&date=${encodeURIComponent(date)}`, { headers: { Authorization: `Bearer ${tok}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'fail');
  return j.flights || [];
}
const flightErr = (e) => ({ nokey: '항공 조회 키가 아직 설정 안 됐어요', quota: '이번 달 무료 조회를 다 썼어요', login: '다시 로그인해 주세요', input: '편명이랑 날짜를 확인해 주세요' }[e.message] || '항공 정보를 못 불러왔어요. 잠시 뒤 다시 해 주세요');
// "2026-12-05 09:00+09:00" → {d:'2026-12-05', t:'09:00', ms}
const lt = (s) => (s ? { d: s.slice(0, 10), t: s.slice(11, 16), ms: Date.parse(s.replace(' ', 'T')) } : null);
const FSTATUS = {
  Unknown: ['❔', '정보 없음', 'gray'], Expected: ['🟢', '정시 예정', 'ok'], CheckIn: ['🧳', '체크인 중', 'ok'], Boarding: ['🔵', '탑승 중', 'go'],
  GateClosed: ['🚪', '탑승 마감', 'go'], Departed: ['🛫', '출발함', 'go'], EnRoute: ['✈️', '비행 중', 'go'], Delayed: ['🟠', '지연', 'warn'],
  Approaching: ['🛬', '착륙 준비', 'go'], Arrived: ['✅', '도착함', 'ok'], Canceled: ['⛔', '결항', 'bad'], Diverted: ['↪️', '회항', 'bad'], CanceledUncertain: ['⚠️', '결항 가능성', 'bad'],
};
function liveHtml(f) {
  const L = f.live; if (!L) return '';
  if (L.notFound) return `<div class="live gray"><b>❔ 이 날짜 운항 정보를 못 찾았어요</b><span>${esc(agoText(L.checkedAt))} 확인</span></div>`;
  const dd = L.dep || {}, aa = L.arr || {};
  const s0 = lt(dd.sched), s1 = lt(dd.actual || dd.revised);
  const late = s0 && s1 ? Math.round((s1.ms - s0.ms) / 6e4) : 0;
  let st = FSTATUS[L.status] || FSTATUS.Unknown;
  if (late >= 15 && !['Canceled', 'Arrived', 'Diverted'].includes(L.status)) st = ['🟠', `${late}분 지연`, 'warn'];
  const tm = (x) => { const a = lt(x.sched), b = lt(x.actual || x.revised); if (!a) return '-'; return b && b.t !== a.t ? `<s>${a.t}</s> <b>${b.t}</b>` : `<b>${a.t}</b>`; };
  return `<div class="live ${st[2]}">
    <div class="live-h"><b>${st[0]} ${esc(st[1])}</b><span>${esc(agoText(L.checkedAt))} 확인</span></div>
    <div class="live-g">
      <div><i>출발 ${esc(dd.iata || '')}</i>${tm(dd)}${dd.terminal || dd.gate ? `<small>${dd.terminal ? 'T' + esc(String(dd.terminal).replace(/^T/i, '')) : ''}${dd.gate ? ' · 게이트 ' + esc(dd.gate) : ''}</small>` : ''}</div>
      <div><i>도착 ${esc(aa.iata || '')}</i>${tm(aa)}${aa.terminal || aa.belt ? `<small>${aa.terminal ? 'T' + esc(String(aa.terminal).replace(/^T/i, '')) : ''}${aa.belt ? ' · 수하물 ' + esc(aa.belt) : ''}</small>` : ''}</div>
    </div><div class="live-src">항공 정보 제공: AeroDataBox</div></div>`;
}
const agoText = (ms) => { if (!ms) return ''; const m = Math.round((Date.now() - ms) / 6e4); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`; };
async function checkFlight(t, id, btn) {
  const f = S.flights.find((x) => x.id === id); if (!f) return;
  if (!f.flightNo || !f.depAt) return toast('편명이랑 출발 날짜를 먼저 넣어 주세요');
  if (f.live?.checkedAt && Date.now() - f.live.checkedAt < 5 * 6e4) return toast('방금 확인했어요. 5분 뒤에 다시 눌러 주세요');
  if (btn) { btn.disabled = true; btn.textContent = '확인 중…'; }
  try {
    const list = await fetchFlight(f.flightNo, f.depAt.slice(0, 10));
    const m = list.find((x) => (!f.from || x.dep.iata === f.from) && (!f.to || x.arr.iata === f.to)) || list[0];
    const live = m ? { status: m.status, dep: m.dep, arr: m.arr, checkedAt: Date.now() } : { notFound: true, checkedAt: Date.now() };
    f.live = live; render();
    write(() => updateDoc(doc(db, 'trips', t.id, 'flights', id), { live }));
  } catch (e) { toast(flightErr(e)); render(); }
}
/** 항공사 온라인 체크인 페이지 (확인된 곳은 바로, 나머지는 검색 결과로) */
const CHECKIN = {
  // 한국 (진주 확인)
  KE: 'https://www.koreanair.com/check-in',
  OZ: 'https://flyasiana.com/C/KR/KO/contents/online-check-in',
  '7C': 'https://wcc.jejuair.net/ko/ibe/checkin/viewCheckin.do',
  LJ: 'https://www.jinair.com',
  TW: 'https://www.trinityairways.com/app/serviceInfo/contents/1121', // 티웨이 → 트리니티
  BX: 'https://m.airbusan.com/mw/checkin/checkinList',
  RS: 'https://flyairseoul.com/I/ko/viewCheckInList.do',
  ZE: 'https://www.eastarjet.com/newstar/PGWII00001',
  YP: 'https://www.airpremia.com/a/ko/checkin/online',
  RF: 'https://www.aerok.com/ko-KR/boarding/check-in',
  // 해외: 공식 홈페이지
  JL: 'https://www.jal.co.jp', NH: 'https://www.ana.co.jp', MM: 'https://www.flypeach.com', GK: 'https://www.jetstar.com', ZG: 'https://www.zipair.net',
  CX: 'https://www.cathaypacific.com', UO: 'https://www.hkexpress.com', HX: 'https://www.hongkongairlines.com', NX: 'https://www.airmacau.com.mo',
  CI: 'https://www.china-airlines.com', BR: 'https://www.evaair.com', JX: 'https://www.starlux-airlines.com', IT: 'https://www.tigerairtw.com',
  CA: 'https://www.airchina.com', MU: 'https://www.ceair.com', CZ: 'https://www.csair.com',
  VN: 'https://www.vietnamairlines.com', VJ: 'https://www.vietjetair.com', QH: 'https://www.bambooairways.com', TG: 'https://www.thaiairways.com',
  FD: 'https://www.airasia.com', AK: 'https://www.airasia.com', Z2: 'https://www.airasia.com', D7: 'https://www.airasia.com',
  SQ: 'https://www.singaporeair.com', TR: 'https://www.flyscoot.com', MH: 'https://www.malaysiaairlines.com', PR: 'https://www.philippineairlines.com',
  '5J': 'https://www.cebupacificair.com', GA: 'https://www.garuda-indonesia.com',
  UA: 'https://www.united.com', DL: 'https://www.delta.com', AA: 'https://www.aa.com', HA: 'https://www.hawaiianairlines.com', AC: 'https://www.aircanada.com',
  EK: 'https://www.emirates.com', QR: 'https://www.qatarairways.com', TK: 'https://www.turkishairlines.com', AF: 'https://www.airfrance.com',
  KL: 'https://www.klm.com', LH: 'https://www.lufthansa.com', AY: 'https://www.finnair.com', QF: 'https://www.qantas.com',
};
function checkinUrl(f) {
  const code = (f.flightNo || '').toUpperCase().replace(/\s/g, '').slice(0, 2);
  if (CHECKIN[code]) return CHECKIN[code];
  const name = f.airline || code;
  return `https://www.google.com/search?q=${encodeURIComponent(`${name} 온라인 체크인`)}`;
}
function viewFlights() {
  const all = sortFlights();
  if (!all.length) return '<div class="empty"><b>등록된 항공권이 없어요</b>예약한 항공편을 넣어두면 일정에 자동으로 표시돼요.</div>';
  const tt = trip(); const mine = myName(tt);
  const showMine = lsGet('tn_my_flights') === '1';
  const list = showMine ? all.filter((f) => flightWho(tt, f).includes(mine)) : all;
  const bar = peopleOf(tt).length > 1 ? `<div class="fltbar"><button class="fltb ${showMine ? '' : 'on'}" data-act="myFlights" data-v="0">전체 ${all.length}</button><button class="fltb ${showMine ? 'on' : ''}" data-act="myFlights" data-v="1">${nameAvatar(tt, mine, 18)}내 항공권 ${all.filter((f) => flightWho(tt, f).includes(mine)).length}</button></div>` : '';
  if (!list.length) return bar + '<div class="empty"><b>내가 타는 항공권이 없어요</b>항공권 수정에서 탑승자에 나를 넣으면 여기 보여요.</div>';
  return bar + list.map((f) => {
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
      ${liveHtml(f)}
      ${f.memo ? `<div class="imemo" style="margin-top:8px">${esc(f.memo)}</div>` : ''}
      ${(f.qrIds || []).length ? `<div class="qrrow">${f.qrIds.map((q, k) => `<button class="qrthumb" data-act="qrview" data-flight="${esc(f.id)}" data-idx="${k}">${qrCache.get(q) && qrCache.get(q) !== 'loading' ? `<img src="${qrCache.get(q)}" alt="QR ${k + 1}">` : '<span>QR</span>'}</button>`).join('')}
        <button class="btn dark qrbig" data-act="qrview" data-flight="${esc(f.id)}" data-idx="0">📱 체크인 QR 크게 보기</button></div>` : ''}
      <div class="iactions" style="margin-top:10px">
        ${f.flightNo ? `<button class="lnk live-btn" data-act="checkFlight" data-id="${esc(f.id)}">✈️ 상태 체크하기</button>` : ''}
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
const PAY_METHODS = ['카드', '현금'];
const PAY_ICON = { 카드: '💳', 현금: '💵' };
function toKRW(t, e) {
  const a = Number(e.amount) || 0;
  const v = e.cur === 'KRW' ? a : a * (Number(e.rate) || Number(t.rate) || 1);
  return e.refund ? -v : v; // 환급(택스리펀 등)은 빼기
}
const CUR_NAME = { JPY: '엔', USD: '달러', EUR: '유로', CNY: '위안', TWD: '대만달러', HKD: '홍콩달러', THB: '바트', VND: '동', SGD: '싱가포르달러', PHP: '페소', GBP: '파운드', AUD: '호주달러' };
const curName = (c) => CUR_NAME[c] || c;
const rateLabel = (cur, perOne) => `${rateUnit(cur)} ${cur} = ${num((Number(perOne) || 0) * rateUnit(cur))}원`;
/** 같은 날 지출 순서: 꾹 눌러 옮긴 순서(pos)가 있으면 그것, 없으면 최근 것 위 */
function sortDayExp(es) {
  // 순서 정한 뒤에 새로 들어온 지출(pos 없음)은 맨 위
  const np = es.filter((e) => typeof e.pos !== 'number').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return [...np, ...es.filter((e) => typeof e.pos === 'number').sort((a, b) => a.pos - b.pos)];
}
function viewMoney(t) {
  const multi = peopleOf(t).length > 1;
  const seg = multi ? `<div class="mseg"><button class="${S.moneyView === 'settle' ? '' : 'on'}" data-act="moneyView" data-v="list">내역</button><button class="${S.moneyView === 'settle' ? 'on' : ''}" data-act="moneyView" data-v="settle">정산</button></div>` : '';
  if (multi && S.moneyView === 'settle') return seg + viewSettle(t);
  const list = [...S.expenses];
  const total = list.reduce((s, e) => s + toKRW(t, e), 0);
  const refunds = -list.filter((e) => e.refund).reduce((s, e) => s + toKRW(t, e), 0);
  const spent = total + refunds;
  const byCat = {}; list.forEach((e) => { if (!e.refund) byCat[e.cat || '기타'] = (byCat[e.cat || '기타'] || 0) + toKRW(t, e); });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const n = peopleOf(t).length || 1;
  const byPay = {}; list.forEach((e) => { if (e.pay && !e.refund) byPay[e.pay] = (byPay[e.pay] || 0) + toKRW(t, e); });
  const payBits = PAY_METHODS.filter((p) => byPay[p]).map((p) => `<span>${PAY_ICON[p]} ${p} ${won(byPay[p])}</span>`);
  if (refunds > 0.5) payBits.push(`<span class="rf">↩︎ 환급 +${won(refunds)}</span>`);
  const groups = {}; list.forEach((e) => { (groups[e.date || '날짜 없음'] ||= []).push(e); });
  const gkeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  const hasLocal = t.currency && t.currency !== 'KRW' && Number(t.rate) > 0;
  const showLocal = hasLocal && S.sumLocal;
  // 현지 통화로 보기: 그 통화로 쓴 건 원래 금액, 나머지는 원화를 기본 환율로 나눔
  const loc = (e) => (e.cur === t.currency ? (e.refund ? -1 : 1) * (Number(e.amount) || 0) : toKRW(t, e) / Number(t.rate));
  const mv = showLocal ? (krw) => `${num(Math.round(krw / Number(t.rate)))} ${esc(curName(t.currency))}` : won;
  let bigTxt = won(total);
  if (showLocal) {
    const lt = list.reduce((s, e) => s + loc(e), 0);
    bigTxt = `${num(Math.round(lt))} ${esc(curName(t.currency))}`;
  }
  const payBits2 = showLocal ? PAY_METHODS.filter((p) => byPay[p]).map((p) => `<span>${PAY_ICON[p]} ${p} ${mv(byPay[p])}</span>`).concat(refunds > 0.5 ? [`<span class="rf">↩︎ 환급 +${mv(refunds)}</span>`] : []) : payBits;
  const payLine2 = payBits2.length ? `<div class="paysum">${payBits2.join('')}</div>` : '';
  return `${seg}<div class="sum ${hasLocal ? 'curtog' : ''}" ${hasLocal ? 'data-act="sumCur" role="button"' : ''}><div class="lbl">총 지출${refunds > 0.5 ? ' (환급 뺀 금액)' : ''} ${hasLocal ? `· 기본 환율 ${esc(rateLabel(t.currency, t.rate))}` : ''}${hasLocal ? `<span class="curchip">${showLocal ? '원화로 보기' : `${esc(curName(t.currency))}로 보기`} ⇄</span>` : ''}</div>
    <div class="big">${bigTxt}</div>
    <div class="bars">${spent ? cats.map(([c, v]) => `<div style="width:${(v / spent) * 100}%;background:${ECATS[c] || '#888'}"></div>`).join('') : ''}</div>
    <div class="legend">${cats.map(([c, v]) => `<span><i style="background:${ECATS[c] || '#888'}"></i>${esc(c)} ${mv(v)}</span>`).join('')}${total ? `<span>· 1인당 약 ${mv(total / n)}</span>` : ''}</div>${payLine2}</div>
  ${list.length ? `${list.length > 1 ? '<div class="lphint" style="text-align:right;margin:-4px 4px 0">꾹 눌러서 순서 바꾸기</div>' : ''}` + gkeys.map((d) => { const es = sortDayExp(groups[d]); return `<div class="dategrp">${esc(d.includes('-') ? md(d) : d)} · ${won(es.reduce((s, e) => s + toKRW(t, e), 0))}</div>
    <div class="explist" data-d="${esc(d)}">${es.map((e) => {
      const col = ECATS[e.cat] || '#888'; const local = e.cur !== 'KRW' && t.currency && t.currency !== 'KRW';
      const sign = e.refund ? '+' : '';
      return `<button class="exp ${e.refund ? 'refund' : ''}" data-act="editExp" data-id="${esc(e.id)}" data-elp="${esc(e.id)}">
        <div class="ico" style="background:${col}1F;color:${col}">${e.refund ? '↩︎' : CAT_EMOJI[e.cat || '기타'] || esc((e.cat || '기타').slice(0, 2))}</div>
        <div style="min-width:0"><div class="t">${esc(e.title)}</div><div class="s">${e.refund ? `환급 · ${esc(e.payer || '?')} 받음` : `${e.pay ? `${PAY_ICON[e.pay] || ''} ${esc(e.pay)} · ` : ''}${esc(e.payer || '?')} 결제`} · ${(e.split || []).length === n ? '모두' : esc((e.split || []).join(', '))}${local && e.rate ? ` · ${esc(rateLabel(e.cur, e.rate))}` : ''}</div></div>
        <div class="amt">${local ? `${sign}${num(e.amount)} ${esc(t.currency)}<small>${sign}${won(Math.abs(toKRW(t, e)))}</small>` : `${sign}${won(e.amount)}`}</div></button>`;
    }).join('')}</div>`; }).join('')
    : '<div class="empty"><b>기록된 지출이 없어요</b>쓴 돈을 바로바로 적어 두면 정산이 쉬워요.</div>'}`;
}
/* 가계부 꾹 눌러 순서 바꾸기 (같은 날짜 안에서) */
document.addEventListener('contextmenu', (e) => { if (e.target.closest('.explist [data-elp]')) e.preventDefault(); });
document.addEventListener('pointerdown', (ev) => {
  if (ev.button > 0 || dragOn) return;
  const el = ev.target.closest('.explist [data-elp]'); if (!el) return;
  const isTouch = ev.pointerType === 'touch';
  const x0 = ev.clientX, y0 = ev.clientY; let y = y0;
  el.classList.add('pressing');
  const cancel = () => { clearTimeout(timer); el.classList.remove('pressing'); document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', cancel); document.removeEventListener('pointercancel', cancel); };
  const mv = (e) => { y = e.clientY; if (Math.hypot(e.clientX - x0, e.clientY - y0) > 10) cancel(); };
  const timer = setTimeout(() => { cancel(); navigator.vibrate?.(15); dragExp(el, y, isTouch); }, 400);
  document.addEventListener('pointermove', mv); document.addEventListener('pointerup', cancel); document.addEventListener('pointercancel', cancel);
});
function dragExp(card, clientY, isTouch) {
  const t = trip(); const box = card.parentElement; if (!t || !box) return;
  dragOn = true; document.addEventListener('touchmove', blockScroll, { passive: false });
  const r0 = card.getBoundingClientRect(); const offY = clientY - r0.top; let lastY = clientY; let raf = 0; let ended = false;
  const ph = document.createElement('div'); ph.className = 'dragph'; ph.style.height = r0.height + 'px'; card.after(ph);
  card.classList.add('dragging');
  Object.assign(card.style, { position: 'fixed', top: '0px', left: r0.left + 'px', width: r0.width + 'px', zIndex: 30, margin: 0, transform: `translateY(${r0.top}px)` });
  const findSpot = () => {
    const list = [...box.children].filter((x) => x !== card && x !== ph);
    const o = list.find((x) => { const r = x.getBoundingClientRect(); return lastY < r.top + r.height / 2; });
    if (o) { if (ph.nextElementSibling !== o) o.before(ph); } else if (list.length && list[list.length - 1].nextElementSibling !== ph) list[list.length - 1].after(ph);
  };
  const moveTo = (yy) => {
    lastY = yy; card.style.transform = `translateY(${lastY - offY}px)`; findSpot(); cancelAnimationFrame(raf);
    const edge = 80, vh = window.innerHeight;
    if (lastY > vh - edge || lastY < edge) { const step = () => { window.scrollBy(0, lastY > vh - edge ? 10 : -10); findSpot(); raf = requestAnimationFrame(step); }; raf = requestAnimationFrame(step); }
  };
  const end = () => {
    if (ended) return; ended = true;
    cancelAnimationFrame(raf); dragOn = false; suppressClickUntil = Date.now() + 400; document.removeEventListener('touchmove', blockScroll); off();
    ph.replaceWith(card); card.classList.remove('dragging');
    Object.assign(card.style, { transform: '', position: '', top: '', left: '', width: '', zIndex: '', margin: '' });
    const ids = [...box.querySelectorAll('[data-elp]')].map((x) => x.dataset.elp);
    const b = writeBatch(db); let n = 0;
    ids.forEach((id, k) => { const e = S.expenses.find((x) => x.id === id); const pos = (k + 1) * 1000; if (e && e.pos !== pos) { e.pos = pos; b.update(doc(db, 'trips', t.id, 'expenses', id), { pos }); n++; } });
    if (n) commit(b);
    render();
  };
  const tmove = (e) => { const p = e.touches[0]; if (p) moveTo(p.clientY); };
  const pmove = (e) => { if (e.pointerType !== 'touch') moveTo(e.clientY); };
  const pup = (e) => { if (e.pointerType !== 'touch') end(); };
  const off = () => { document.removeEventListener('touchmove', tmove); document.removeEventListener('touchend', end); document.removeEventListener('touchcancel', end); document.removeEventListener('pointermove', pmove); document.removeEventListener('pointerup', pup); };
  if (isTouch) { document.addEventListener('touchmove', tmove, { passive: true }); document.addEventListener('touchend', end); document.addEventListener('touchcancel', end); }
  else { document.addEventListener('pointermove', pmove); document.addEventListener('pointerup', pup); }
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
  s.innerHTML = `<div class="sheet" role="dialog"><button type="button" class="sheetx" aria-label="닫기">✕</button>${html}</div>`;
  s.addEventListener('click', (e) => { if (e.target === s || e.target.closest('.sheetx')) closeSheet(); });
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
  const lbl = name === 'cat' ? catLabel : (o) => o;
  return `<div class="pills" data-pills="${name}" data-multi="${multi ? 1 : 0}">${opts.map((o) => `<button type="button" class="pill ${(multi ? sel.includes(o) : sel === o) ? 'on' : ''}" data-v="${esc(o)}">${esc(lbl(o))}</button>`).join('')}</div>`;
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
    <div class="f"><span class="flbl">여행 카드 꾸미기</span>
      <div class="covpick" id="covPick">
        <button type="button" class="cov none" data-cov="" aria-label="기본">기본</button>
        ${COVER_COLORS.map((c) => `<button type="button" class="cov" data-cov="${c}" style="background:${c}" aria-label="색 ${c}"></button>`).join('')}
        <label class="cov photo" aria-label="사진 넣기">📷<input type="file" accept="image/*" hidden id="covFile"></label>
      </div>
      <div class="covprev ticket" id="covPrev"><div style="min-width:0"><div class="city">${esc(t.city || 'TRIP')}</div><div class="name">${esc(t.name || '여행 이름')}</div><div class="small muted">미리보기</div></div><div class="dd"><b>D-?</b></div></div>
    </div>
    <div class="two"><label class="f"><span>출발</span><input class="inp" type="date" name="start" value="${esc(t.start)}"></label>
      <label class="f"><span>도착</span><input class="inp" type="date" name="end" value="${esc(t.end)}"></label></div>
    <div class="two"><label class="f"><span>현지 통화</span><select class="inp" name="currency">${CURRENCIES.map((c) => `<option ${c === t.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="f"><span id="rateLbl">기본 환율</span><input class="inp" type="number" step="any" inputmode="decimal" name="rate" value="${esc(String(Math.round((Number(t.rate) || 1) * rateUnit(t.currency) * 10000) / 10000))}"><button type="button" class="fxbtn" data-x="fx">오늘 환율</button><div class="hint" id="rateHint"></div></label></div>
    ${isNew ? '' : `<div class="card soft"><h3>동행인 초대</h3>
      <p class="small muted">링크를 받은 사람이 구글 로그인하면 이 여행을 같이 보고 수정할 수 있어요. 정산·'누구랑?'·탑승자는 여기 참여한 사람 기준이에요.</p>
      <div class="joined" id="mList">${(t.members || []).map((u) => `<span class="jm">${avatar(u, 24, t.memberNames?.[u])}${esc(S.profiles.get(u)?.name || t.memberNames?.[u] || '?')}${u === t.ownerId ? ' <small>(방장)</small>' : isOwner ? ` <button type="button" class="gdel" data-kick="${esc(u)}" aria-label="내보내기">✕</button>` : ''}</span>`).join('') || '-'}</div>
      ${isOwner && (t.members || []).length > 1 ? '<p class="small muted" style="margin-top:6px">✕를 누르면 이 여행에서 내보내요. 초대 링크도 새로 바뀌어요.</p>' : ''}
      <button class="btn ghost block" data-x="invite">초대 링크 만들기</button><div id="invOut"></div></div>`}
    <div class="card soft"><h3>로그인 안 하는 동행</h3>
      <p class="small muted">앱을 안 쓰는 친구도 이름만 넣으면 정산·누구랑?·탑승자에 같이 나와요.</p>
      <div class="joined" id="gList"></div>
      <div class="gadd"><input class="inp" id="gName" placeholder="이름 (예: 수아)" maxlength="20"><button type="button" class="btn ghost" data-x="gadd">추가</button></div></div>
    ${isNew ? '' : `<div class="card soft"><h3>일정 공유 링크 <small class="muted">보기 전용</small></h3>
      <p class="small muted">로그인 없이 일정만 볼 수 있는 링크예요. 부모님·친구한테 보내기 좋아요. 가계부·메모·예약번호·QR은 안 보여요. 일정을 고치면 자동으로 반영돼요.</p>
      <div id="shareOut"></div></div>`}
    ${isNew ? '' : '<button type="button" class="btn ghost block" data-x="recap" style="margin-bottom:10px">🎞 여행 리캡 보기</button>'}
    <div class="rowbtns">${isOwner ? '<button class="btn danger" data-x="del">삭제</button>' : ''}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    const v = fval(sh); wirePills(sh);
    const guests = [...(t.guests || [])];
    let cover = t.cover || null;
    const drawCov = () => {
      const pv = sh.querySelector('#covPrev');
      pv.className = `covprev ticket ${coverClass({ cover })}`; pv.setAttribute('style', coverStyle({ cover }));
      sh.querySelectorAll('.cov[data-cov]').forEach((b) => b.classList.toggle('on', (cover?.type === 'color' ? cover.value : '') === b.dataset.cov && cover?.type !== 'image'));
      sh.querySelector('.cov.photo').classList.toggle('on', cover?.type === 'image');
    };
    drawCov();
    sh.querySelector('#covPick').addEventListener('click', (e) => { const b = e.target.closest('[data-cov]'); if (!b) return; cover = b.dataset.cov ? { type: 'color', value: b.dataset.cov } : null; drawCov(); });
    sh.querySelector('#covFile').addEventListener('change', async (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      try { cover = { type: 'image', data: await compressImage(f, 900, 0.72) }; drawCov(); } catch { toast('사진을 못 읽었어요'); }
      e.target.value = '';
    });
    const memberNm = (t.members || []).map((u) => t.memberNames?.[u]);
    const drawG = () => { sh.querySelector('#gList').innerHTML = guests.map((g, k) => `<span class="jm">${nameAvatar(t, g, 24)}${esc(g)} <button type="button" class="gdel" data-g="${k}" aria-label="빼기">✕</button></span>`).join('') || '<span class="small muted">아직 없어요</span>'; };
    drawG();
    const addG = () => {
      const inp = sh.querySelector('#gName'); const n = inp.value.trim(); if (!n) return;
      if (guests.includes(n) || memberNm.includes(n) || (isNew && n === me())) return toast('이미 있는 이름이에요');
      guests.push(n); inp.value = ''; drawG();
    };
    sh.querySelector('[data-x=gadd]').onclick = addG;
    sh.querySelector('#gName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addG(); } });
    sh.querySelector('#gList').addEventListener('click', (e) => { const b = e.target.closest('.gdel'); if (b) { guests.splice(Number(b.dataset.g), 1); drawG(); } });
    sh.querySelector('[data-x=recap]')?.addEventListener('click', () => { closeSheet(); openRecap(t); });
    const rateUi = () => {
      const cur = v('currency'); const unit = rateUnit(cur);
      sh.querySelector('#rateLbl').textContent = cur === 'KRW' ? '기본 환율' : `기본 환율 (${unit} ${cur} = ? 원)`;
      sh.querySelector('#rateHint').textContent = cur === 'KRW' ? '원화 여행이면 신경 안 써도 돼요' : unit === 100 ? `예: 100엔 = 920원이면 920` : `예: 1 ${cur} = 1,400원이면 1400`;
    };
    rateUi();
    const fxBtn = sh.querySelector('[data-x=fx]'); const rateInp = sh.querySelector('[name=rate]');
    const fxUi = () => { fxBtn.hidden = v('currency') === 'KRW'; };
    fxUi();
    fxBtn.onclick = () => fillRate(rateInp, v('currency'), fxBtn);
    sh.querySelector('[name=currency]').addEventListener('change', () => {
      rateUi(); fxUi();
      if (v('currency') === 'KRW') rateInp.value = '1';
      else fillRate(rateInp, v('currency'), fxBtn); // 통화 바꾸면 오늘 환율 자동으로
    });
    // 공유 링크
    const shareOut = sh.querySelector('#shareOut');
    const drawShare = () => {
      if (!shareOut) return;
      const cur = trip() || t;
      if (!cur.shareCode) { shareOut.innerHTML = '<button type="button" class="btn ghost block" data-x="mkshare">공유 링크 만들기</button>'; }
      else {
        const url = `${location.origin}/?s=${cur.shareCode}`;
        shareOut.innerHTML = `<div class="invlink mono">${esc(url)}</div>
          <div class="rowbtns"><button type="button" class="btn ghost" data-x="scp">링크 복사</button>${navigator.share ? '<button type="button" class="btn pri" data-x="ssh">공유하기</button>' : ''}</div>
          <button type="button" class="lnk" data-x="sstop" style="margin-top:8px">링크 끄기</button>`;
        shareOut.querySelector('[data-x=scp]').onclick = () => copy(url, '공유 링크를 복사했어요');
        shareOut.querySelector('[data-x=ssh]')?.addEventListener('click', () => navigator.share({ title: cur.name, text: `'${cur.name}' 일정이에요`, url }).catch(() => {}));
        shareOut.querySelector('[data-x=sstop]').onclick = () => askConfirm('공유 링크를 끌까요? 이미 보낸 링크로는 더 이상 볼 수 없어요.', '끄기', async () => {
          if (needOnline()) return;
          await write(() => stopShare(trip() || t)); t.shareCode = null; drawShare(); toast('공유 링크를 껐어요');
        });
      }
      shareOut.querySelector('[data-x=mkshare]')?.addEventListener('click', async () => {
        if (needOnline()) return;
        if (S.tripId !== t.id || !S.fresh.items) return toast('일정을 불러온 뒤 다시 눌러 주세요');
        try { t.shareCode = await makeShare(trip() || t); drawShare(); } catch (e) { console.error(e); toast(e?.code === 'permission-denied' ? '권한이 없어요 (규칙 업데이트 필요)' : '링크를 만들지 못했어요'); }
      });
    };
    drawShare();
    sh.querySelector('[data-x=save]').onclick = async () => {
      if (!v('name')) return toast('여행 이름을 적어 주세요');
      let start = v('start'), end = v('end'); if (start && end && end < start) [start, end] = [end, start];
      const data = {
        name: v('name'), city: v('city'), start, end: end || start, currency: v('currency'),
        rate: (Number(v('rate')) || 1) / rateUnit(v('currency')),
        guests,
        cover,
      };
      if (!isNew && data.city !== t.city) data.geo = null; // 도시 바뀌면 날씨 위치 다시 찾기
      closeSheet();
      if (isNew) {
        const id = uid();
        const nt = { ...data, ownerId: S.user.uid, members: [S.user.uid], memberNames: { [S.user.uid]: me() }, createdAt: Date.now() };
        write(() => setDoc(doc(db, 'trips', id), nt));
        if (!S.trips.some((x) => x.id === id)) S.trips.push({ id, ...nt }); // 오프라인이어도 바로 열리게
        S.tab = 'plan'; openTrip(id);
      } else write(() => updateDoc(doc(db, 'trips', t.id), data));
    };
    sh.querySelector('[data-x=invite]')?.addEventListener('click', async () => {
      let code = t.inviteCode;
      if (!code) {
        if (needOnline()) return;
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
      sh.querySelector('[data-x=sh]')?.addEventListener('click', () => navigator.share({ title: `${t.name} 초대`, text: `슝에서 '${t.name}' 같이 보자!`, url }).catch(() => {}));
    });
    // 방장: 참여자 내보내기 (예전 초대 링크는 막고 새 링크로)
    sh.querySelector('#mList')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-kick]'); if (!b || !isOwner) return;
      const u = b.dataset.kick; const nm = S.profiles.get(u)?.name || t.memberNames?.[u] || '이 사람';
      askConfirm(`${nm}님을 이 여행에서 내보낼까요? 이제 이 여행을 볼 수 없어요. 일정·지출에 적힌 이름은 그대로 남아요.`, '내보내기', () => write(async () => {
        const cur = trip() || t;
        if (cur.inviteCode) await deleteDoc(doc(db, 'invites', cur.inviteCode)).catch(() => {});
        await updateDoc(doc(db, 'trips', t.id), { members: (cur.members || []).filter((x) => x !== u), [`memberNames.${u}`]: deleteField(), inviteCode: null });
        closeSheet(); toast(`${nm}님을 내보냈어요`);
      }));
    });
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => askConfirm(`'${t.name}' 여행을 삭제할까요? 일정·항공권·가계부가 모두 지워지고 되돌릴 수 없어요.`, '삭제', () => deleteTrip(t)));
  });
}
async function deleteTripData(t) {
  const id = t.id;
  for (const name of ['items', 'expenses', 'flights', 'files', 'places', 'notes', 'routes', 'checks']) {
    const snap = await getDocs(collection(db, 'trips', id, name));
    let batch = writeBatch(db); let n = 0;
    for (const d of snap.docs) { batch.delete(d.ref); if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); } }
    await batch.commit();
  }
  if (t.inviteCode) await deleteDoc(doc(db, 'invites', t.inviteCode));
  if (t.shareCode) await deleteDoc(doc(db, 'shares', t.shareCode)).catch(() => {});
  await deleteDoc(doc(db, 'trips', id));
}
async function deleteTrip(t) {
  if (needOnline()) return; // 이 기기에 안 받아둔 하위 문서가 서버에 남을 수 있어서
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
      <div style="margin-top:8px"><span class="flbl">결제 수단</span>${pills('spay', PAY_METHODS, linked ? linked.pay || '' : lsGet('payMethod') || '카드')}</div>
      ${people.length > 1 ? `<div style="margin-top:8px"><span class="flbl">결제한 사람</span>${pills('spayer', people, linked?.payer || (people.includes(myName(t)) ? myName(t) : people[0]))}</div>
      <div style="margin-top:8px"><span class="flbl">나눌 사람</span>${pills('ssplit', people, linked?.split || item.who || people, true)}</div>` : ''}
      <div class="hint">가계부 정산에 바로 반영돼요.</div></div>
    ${isNew ? '' : '<button type="button" class="towish" data-x="towish">💛 찜으로 옮기기 <span>날짜 미정으로 빼두기</span></button>'}
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
      const near = searchNear(t);
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
      {
        const b = writeBatch(db);
        // 쓴 돈 → 가계부 지출로 연결 (있으면 수정, 비우면 삭제)
        let expenseId = item.expenseId || null;
        if (spend > 0) {
          const exp = {
            title: data.title, amount: spend, cur: pillVal(sh, 'scur')[0] || spCurs[0], cat: SPEND_CAT[data.cat] || '기타',
            pay: pillVal(sh, 'spay')[0] || null, payer: pillVal(sh, 'spayer')[0] || linked?.payer || people[0], split: (() => { const x = pillVal(sh, 'ssplit'); return x.length ? x : linked?.split || [...people]; })(), date: data.date.startsWith('day') ? fmtD(new Date()) : data.date, itemId,
          };
          if (expenseId && linked) b.update(doc(db, 'trips', t.id, 'expenses', expenseId), exp);
          else { expenseId = uid(); b.set(doc(db, 'trips', t.id, 'expenses', expenseId), { ...exp, createdAt: Date.now(), by: S.user.uid }); }
        } else if (expenseId) { b.delete(doc(db, 'trips', t.id, 'expenses', expenseId)); expenseId = null; }
        data.expenseId = expenseId;
        if (isNew || data.date !== item.date) data.pos = insertPos(data.date, data.time, itemId);
        if (isNew) b.set(doc(db, 'trips', t.id, 'items', itemId), { ...data, done: false, createdAt: Date.now(), by: S.user.uid });
        else b.update(doc(db, 'trips', t.id, 'items', itemId), data);
        commit(b);
      }
    };
    sh.querySelector('[data-x=towish]')?.addEventListener('click', () => itemToWish(t, item));
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => askConfirm(`'${item.title}' 일정을 삭제할까요?${item.expenseId ? ' 연결된 지출도 같이 지워져요.' : ''}`, '삭제', () => { const b = writeBatch(db); if (item.expenseId) b.delete(doc(db, 'trips', t.id, 'expenses', item.expenseId)); b.delete(doc(db, 'trips', t.id, 'items', item.id)); commit(b); }));
  });
}

// 일정 → 찜: 찜에서 왔으면 그 찜을 '추가 전'으로 되돌리고, 아니면 새 찜을 만든 뒤 일정은 지움
function itemToWish(t, item) {
  const src = item.fromWish ? S.places.find((p) => p.id === item.fromWish) : null;
  const exp = item.expenseId ? S.expenses.find((e) => e.id === item.expenseId) : null;
  askConfirm(`'${item.title}'을(를) 일정에서 빼고 찜으로 옮길까요?${exp ? ' 쓴 돈은 가계부에 그대로 남아요.' : ''}`, '옮기기', () => {
    {
      const b = writeBatch(db);
      if (src) {
        const up = src.addedTo?.itemId === item.id ? { addedTo: deleteField() } : {};
        if (!src.memo && item.memo) up.memo = item.memo;
        if (src.lat == null && item.lat != null) Object.assign(up, { lat: item.lat, lng: item.lng, address: item.address || '', placeId: item.placeId || null });
        if (Object.keys(up).length) b.update(doc(db, 'trips', t.id, 'places', src.id), up);
      } else {
        b.set(doc(db, 'trips', t.id, 'places', uid()), {
          name: item.title, cat: WCATS.includes(item.cat) ? item.cat : '기타', memo: item.memo || '', link: item.link || '',
          lat: item.lat ?? null, lng: item.lng ?? null, address: item.address || '', placeId: item.placeId || null,
          createdAt: Date.now(), by: S.user.uid,
        });
      }
      if (exp) b.update(doc(db, 'trips', t.id, 'expenses', exp.id), { itemId: null });
      b.delete(doc(db, 'trips', t.id, 'items', item.id));
      commit(b);
    }
    toast('찜으로 옮겼어요');
  });
}

/* memo (장소·시간 없이 메모만) */
// 메모 색: [바탕, 테두리·점, 글자]
const MEMO_COLORS = {
  yellow: ['#FFF8D6', '#C9A227', '#4A4128'], pink: ['#FFE8EE', '#E0738F', '#5A2F3B'], mint: ['#E3F6EC', '#3FA772', '#21432F'],
  blue: ['#E6EEFF', '#2E5BFF', '#1F2E57'], purple: ['#F0E8FF', '#8A5CF0', '#3A2A5C'], gray: ['#EEF0F3', '#8B95A1', '#333D4B'],
};
const memoCol = (i) => MEMO_COLORS[i.color] || MEMO_COLORS.yellow;
const memoStyle = (i) => { const [bg, line, ink] = memoCol(i); return `--cat:${line};--mbg:${bg};--mink:${ink}`; };
function memoForm(t, m) {
  const isNew = !m; const days = tripDays(t);
  m = m || { date: S.day, memo: '', color: localStorage.getItem('memoColor') || 'yellow' };
  let color = MEMO_COLORS[m.color] ? m.color : 'yellow';
  const linked = m.expenseId ? S.expenses.find((e) => e.id === m.expenseId) : null;
  const spCurs = [...new Set([t.currency || 'KRW', 'KRW'])];
  const people = peopleOf(t);
  openSheet(`<h2>${isNew ? '메모 추가' : '메모 수정'}</h2>
    <label class="f"><span>메모</span><textarea class="inp" name="memo" rows="5" placeholder="예: 숙소 체크인 15시, 짐 맡기기 / 환전 잊지 말기">${esc(m.memo)}</textarea></label>
    <div class="f"><span class="flbl">색</span><div class="covpick" id="memoPick">${Object.entries(MEMO_COLORS).map(([k, [bg, line]]) => `<button type="button" class="cov ${k === color ? 'on' : ''}" data-mc="${k}" style="background:${bg};box-shadow:inset 0 0 0 1.5px ${line}55" aria-label="메모 색 ${k}"></button>`).join('')}</div></div>
    <label class="f"><span>날짜</span><select class="inp" name="date">${days.map((d, i) => `<option value="${esc(d)}" ${d === m.date ? 'selected' : ''}>Day ${i + 1}${d.startsWith('day') ? '' : ' · ' + esc(md(d))}</option>`).join('')}</select></label>
    <p class="small muted" style="margin:-4px 0 12px">맨 아래에 붙어요. '순서 바꾸기'로 끌어서 원하는 위치로 옮길 수 있어요.</p>
    <button type="button" class="lnk addspend" data-x="addspend" ${linked ? 'hidden' : ''}>💸 쓴 돈 가계부에 기록하기</button>
    <div class="spendbox" id="memoSpend" ${linked ? '' : 'hidden'}><span class="flbl">💸 쓴 돈 (가계부에 자동 기록)</span>
      <div class="two"><input class="inp mono" type="number" step="any" inputmode="decimal" name="spend" value="${esc(linked?.amount ?? '')}" placeholder="0" style="flex:2">${pills('scur', spCurs, linked?.cur || spCurs[0])}</div>
      <div id="spendMore" ${linked ? '' : 'hidden'}>
        <label class="f" style="margin-top:8px"><span>가계부에 적을 이름</span><input class="inp" name="stitle" value="${esc(linked?.title || '')}" placeholder="비우면 메모 첫 줄"></label>
        <div><span class="flbl">분류</span>${pills('scat', Object.keys(ECATS), linked?.cat || '기타')}</div>
        <div style="margin-top:8px"><span class="flbl">결제 수단</span>${pills('spay', PAY_METHODS, linked ? linked.pay || '' : lsGet('payMethod') || '카드')}</div>
        ${people.length > 1 ? `<div style="margin-top:8px"><span class="flbl">결제한 사람</span>${pills('spayer', people, linked?.payer || (people.includes(myName(t)) ? myName(t) : people[0]))}</div>
        <div style="margin-top:8px"><span class="flbl">나눌 사람</span>${pills('ssplit', people, linked?.split || people, true)}</div>` : ''}
      </div>
      <div class="hint">가계부 정산에 바로 반영돼요.</div></div>
    <div class="rowbtns">${isNew ? '' : '<button class="btn danger" data-x="del">삭제</button>'}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    wirePills(sh); const v = fval(sh);
    const spendIn = sh.querySelector('[name=spend]');
    spendIn.addEventListener('input', () => { if (Number(spendIn.value) > 0) sh.querySelector('#spendMore').hidden = false; });
    sh.querySelector('[data-x=addspend]').addEventListener('click', (e) => { e.currentTarget.hidden = true; sh.querySelector('#memoSpend').hidden = false; spendIn.focus(); });
    // 시트 올라오는 애니메이션 끝난 뒤에 포커스 (애니메이션 중에 포커스하면 아이폰에서 커서 위치·한글 입력이 어긋남)
    { let done = false; const f = () => { if (done) return; done = true; sh.querySelector('[name=memo]').focus({ preventScroll: true }); };
      sh.addEventListener('animationend', f, { once: true }); setTimeout(f, 350); }
    const ta = sh.querySelector('[name=memo]');
    const paint = () => { const [bg, line, ink] = MEMO_COLORS[color]; ta.style.background = bg; ta.style.borderColor = line + '66'; ta.style.color = ink; };
    paint();
    sh.querySelector('#memoPick').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mc]'); if (!b) return; color = b.dataset.mc;
      sh.querySelectorAll('[data-mc]').forEach((x) => x.classList.toggle('on', x === b)); paint();
    });
    sh.querySelector('[data-x=save]').onclick = async () => {
      if (!v('memo')) return toast('메모를 적어 주세요');
      const data = { kind: 'memo', memo: v('memo'), date: v('date'), title: '', time: '', color };
      try { localStorage.setItem('memoColor', color); } catch {}
      const itemId = isNew ? uid() : m.id;
      if (isNew || data.date !== m.date) data.pos = insertPos(data.date, '', itemId);
      const spend = Number(spendIn.value);
      closeSheet(); S.day = data.date;
      const b = writeBatch(db);
      // 쓴 돈 → 가계부 지출로 연결 (있으면 수정, 비우면 삭제). 이름은 비우면 메모 첫 줄
      let expenseId = m.expenseId || null;
      if (spend > 0) {
        const first = data.memo.split('\n').map((x) => x.trim()).find(Boolean) || '메모';
        const exp = {
          title: v('stitle') || (first.length > 30 ? first.slice(0, 30) + '…' : first), amount: spend, cur: pillVal(sh, 'scur')[0] || spCurs[0], cat: pillVal(sh, 'scat')[0] || '기타',
          pay: pillVal(sh, 'spay')[0] || null, payer: pillVal(sh, 'spayer')[0] || linked?.payer || (people.includes(myName(t)) ? myName(t) : people[0]),
          split: (() => { const x = pillVal(sh, 'ssplit'); return x.length ? x : linked?.split || [...people]; })(),
          date: data.date.startsWith('day') ? fmtD(new Date()) : data.date, itemId,
        };
        if (expenseId && linked) b.update(doc(db, 'trips', t.id, 'expenses', expenseId), exp);
        else { expenseId = uid(); b.set(doc(db, 'trips', t.id, 'expenses', expenseId), { ...exp, createdAt: Date.now(), by: S.user.uid }); }
      } else if (expenseId) { if (linked) b.delete(doc(db, 'trips', t.id, 'expenses', expenseId)); expenseId = null; }
      data.expenseId = expenseId;
      if (isNew) b.set(doc(db, 'trips', t.id, 'items', itemId), { ...data, createdAt: Date.now(), by: S.user.uid });
      else b.update(doc(db, 'trips', t.id, 'items', itemId), data);
      commit(b);
    };
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => askConfirm(`이 메모를 삭제할까요?${linked ? ' 연결된 지출도 같이 지워져요.' : ''}`, '삭제', () => { const b = writeBatch(db); if (linked) b.delete(doc(db, 'trips', t.id, 'expenses', linked.id)); b.delete(doc(db, 'trips', t.id, 'items', m.id)); commit(b); }));
  });
}

/* flight */
function flightForm(t, f) {
  const isNew = !f;
  const plusH = (dt, h) => { if (!dt) return ''; const d = new Date(dt + ':00'); d.setHours(d.getHours() + h); return `${fmtD(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const isReturn = S.flights.length > 0;
  const defDep = isReturn ? (t.end ? t.end + 'T15:00' : '') : (t.start ? t.start + 'T09:00' : '');
  f = f || { kind: isReturn ? '오는편' : '가는편', airline: '', flightNo: '', from: '', to: '', depAt: defDep, arrAt: plusH(defDep, 2), bookingRef: '', seat: '', terminal: '', baggage: '', memo: '', who: [myName(t)] };
  // 탑승자 후보: 정산용 이름 + 앱 참여자 이름 + 이미 지정된 사람
  const whoOpts = [...new Set([...peopleOf(t), ...(f.who || [])].filter(Boolean))];
  const whoSel = f.who || (f.by && t.memberNames?.[f.by] ? [t.memberNames[f.by]] : []);
  openSheet(`<h2>${isNew ? '항공권 추가' : '항공권 수정'}</h2>
    <label class="f"><span>구분</span>${pills('kind', ['가는편', '오는편', '경유·기타'], f.kind)}</label>
    <label class="f"><span>탑승자 (이 비행기 타는 사람)</span>${pills('who', whoOpts, whoSel, true)}</label>
    <div class="two"><label class="f"><span>항공사</span><input class="inp" name="airline" value="${esc(f.airline)}" placeholder="예: 제주항공"></label>
      <label class="f"><span>편명</span><div class="fnrow"><input class="inp mono" name="flightNo" value="${esc(f.flightNo)}" placeholder="예: 7C1301" autocapitalize="characters"><button type="button" class="btn dark small" data-x="lookup">불러오기</button></div></label></div>
    <div class="hint" style="margin:-6px 0 12px">출발 날짜를 고르고 편명 옆 <b>불러오기</b>를 누르면 공항·시간·터미널이 자동으로 채워져요. <span class="muted">(항공 정보: AeroDataBox)</span></div>
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
    sh.querySelector('[data-x=lookup]').addEventListener('click', async (e) => {
      e.preventDefault();
      const b = e.currentTarget; const no = v('flightNo').toUpperCase().replace(/\s/g, '');
      const date = sh.querySelector('[name=depDate]').value || t.start;
      if (!no) return toast('편명을 먼저 적어 주세요');
      if (!date) return toast('출발 날짜를 먼저 골라 주세요');
      b.disabled = true; b.textContent = '찾는 중…';
      try {
        const list = await fetchFlight(no, date);
        const m = list[0];
        if (!m) { toast(`${date} ${no} 운항 정보를 못 찾았어요`); return; }
        const setV = (n, val) => { if (val) sh.querySelector(`[name=${n}]`).value = val; };
        const setT = (n, val) => { if (!val) return; const hid = sh.querySelector(`[name=${n}]`); hid.value = val; const tb = sh.querySelector(`[data-timefield=${n}]`); tb.textContent = val; tb.classList.remove('empty'); };
        sh.querySelector('[name=flightNo]').value = no;
        setV('from', m.dep.iata); setV('to', m.arr.iata);
        if (m.airline && !v('airline')) setV('airline', m.airline);
        const d0 = lt(m.dep.sched), a0 = lt(m.arr.sched);
        if (d0) { setV('depDate', d0.d); setT('depTime', d0.t); }
        if (a0) { setV('arrDate', a0.d); setT('arrTime', a0.t); }
        if (d0 && a0) gapH = (new Date(`${a0.d}T${a0.t}`) - new Date(`${d0.d}T${d0.t}`)) / 36e5; // 현지 시각끼리 간격
        if (m.dep.terminal) setV('terminal', `T${String(m.dep.terminal).replace(/^T/i, '')}`);
        toast(`✈️ ${m.dep.iata} ${d0?.t || ''} → ${m.arr.iata} ${a0?.t || ''} 불러왔어요`);
      } catch (err) { toast(flightErr(err)); } finally { b.disabled = false; b.textContent = '불러오기'; }
    });
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
    const saveQrs = (b, flightId) => {
      for (const q of qrs.filter((x) => x.isNew)) {
        b.set(doc(db, 'trips', t.id, 'files', q.id), { flightId, data: q.data, createdAt: Date.now(), by: S.user.uid });
        qrCache.set(q.id, q.data);
      }
      for (const id of removed) { b.delete(doc(db, 'trips', t.id, 'files', id)); qrCache.delete(id); }
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
      const b = writeBatch(db);
      data.qrIds = saveQrs(b, fid);
      if (isNew) b.set(doc(db, 'trips', t.id, 'flights', fid), { ...data, createdAt: Date.now(), by: S.user.uid });
      else {
        // 날짜·시간이 바뀌면 순서 고정을 풀고 다시 시간 기준으로
        if (data.depAt !== f.depAt) data.posDep = null;
        if (data.arrAt !== f.arrAt) data.posArr = null;
        b.update(doc(db, 'trips', t.id, 'flights', fid), data);
      }
      closeSheet();
      commit(b);
    };
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => askConfirm(`${f.from || ''}→${f.to || ''} 항공권을 삭제할까요?${(f.qrIds || []).length ? ' QR 사진도 같이 지워져요.' : ''}`, '삭제', () => {
      const b = writeBatch(db);
      for (const id of f.qrIds || []) b.delete(doc(db, 'trips', t.id, 'files', id));
      b.delete(doc(db, 'trips', t.id, 'flights', f.id));
      commit(b);
    }));
  });
}

/* expense */
function expForm(t, e) {
  const isNew = !e; const people = peopleOf(t);
  const today = fmtD(new Date()); const days = tripDays(t);
  e = e || { title: '', amount: '', cur: t.currency || 'KRW', payer: people.includes(myName(t)) ? myName(t) : people[0], split: [...people], date: days.includes(today) ? today : (days[0].startsWith('day') ? today : days[0]), cat: '식비', pay: localStorage.getItem('payMethod') || '카드' };
  const curs = [...new Set([t.currency || 'KRW', 'KRW'])];
  openSheet(`<h2>${isNew ? '지출 추가' : '지출 수정'}</h2>
    <div class="mseg" id="expKind"><button type="button" class="${e.refund ? '' : 'on'}" data-k="0">− 지출</button><button type="button" class="${e.refund ? 'on' : ''}" data-k="1">+ 환급·받은 돈</button></div>
    <label class="f"><span>내용</span><input class="inp" name="title" value="${esc(e.title)}" placeholder="예: 이치란 라멘"></label>
    <div class="two"><label class="f" style="flex:2"><span>금액</span><input class="inp mono" type="number" step="any" inputmode="decimal" name="amount" value="${esc(e.amount)}" placeholder="0"></label>
      <label class="f"><span>통화</span>${pills('cur', curs, e.cur || curs[0])}</label></div>
    <div id="rateBox"></div>
    <label class="f"><span>분류</span>${pills('cat', Object.keys(ECATS), e.cat || '기타')}</label>
    <label class="f" id="payRow"><span>결제 수단</span>${pills('pay', PAY_METHODS, e.pay || '')}</label>
    <label class="f"><span id="payerLbl">결제한 사람</span>${pills('payer', people, e.payer)}</label>
    <label class="f"><span>나눌 사람</span>${pills('split', people, e.split || people, true)}</label>
    <label class="f"><span>날짜</span><input class="inp" type="date" name="date" value="${esc(e.date)}"></label>
    <div class="rowbtns">${isNew ? '' : '<button class="btn danger" data-x="del">삭제</button>'}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    wirePills(sh); const v = fval(sh);
    let refund = !!e.refund;
    const paintKind = () => {
      sh.querySelectorAll('#expKind button').forEach((b) => b.classList.toggle('on', (b.dataset.k === '1') === refund));
      sh.querySelector('#payRow').hidden = refund;
      sh.querySelector('#payerLbl').textContent = refund ? '받은 사람' : '결제한 사람';
      sh.querySelector('[name=title]').placeholder = refund ? '예: 택스 리펀, 보증금 환불' : '예: 이치란 라멘';
    };
    paintKind();
    sh.querySelector('#expKind').addEventListener('click', (ev) => { const b = ev.target.closest('[data-k]'); if (!b) return; refund = b.dataset.k === '1'; paintKind(); });
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
        <button type="button" class="fxbtn" data-x="efx">오늘 환율</button>
        <div class="hint">비워두면 여행 기본 환율(${esc(rateLabel(cur, t.rate))})로 계산해요. 카드 결제 환율을 넣으면 정산이 더 정확해요.</div></label>`;
      rateBox.querySelector('[name=rate]').addEventListener('input', (ev) => { rateTyped = ev.target.value; preview(); });
      rateBox.querySelector('[data-x=efx]').onclick = (ev) => fillRate(rateBox.querySelector('[name=rate]'), cur, ev.currentTarget);
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
      const data = { title: v('title'), amount, cur, rate: cur !== 'KRW' && rIn > 0 ? rIn / rateUnit(cur) : null, cat: pillVal(sh, 'cat')[0] || '기타', refund, pay: refund ? null : pillVal(sh, 'pay')[0] || null, payer: pillVal(sh, 'payer')[0] || people[0], split, date: v('date') };
      try { if (data.pay) localStorage.setItem('payMethod', data.pay); } catch {}
      closeSheet();
      if (isNew) await write(() => setDoc(doc(db, 'trips', t.id, 'expenses', uid()), { ...data, createdAt: Date.now(), by: S.user.uid }));
      else await write(() => updateDoc(doc(db, 'trips', t.id, 'expenses', e.id), data));
    };
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => askConfirm(`'${e.title}' 지출을 삭제할까요?`, '삭제', () => { const b = writeBatch(db); b.delete(doc(db, 'trips', t.id, 'expenses', e.id)); if (e.itemId && S.items.some((i) => i.id === e.itemId)) b.update(doc(db, 'trips', t.id, 'items', e.itemId), { expenseId: null }); commit(b); }));
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
    <button type="button" class="btn ghost block" data-x="guide" style="margin-bottom:10px">${isStandalone() ? '📖 사용 방법' : '📖 사용 방법 · 앱으로 설치하기'}</button>
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
    sh.querySelector('[data-x=guide]').onclick = () => guideSheet();
    sh.querySelector('[data-x=save]').onclick = async () => {
      const name = sh.querySelector('[name=pname]').value.trim() || S.user.displayName || '나';
      closeSheet();
      const b = writeBatch(db);
      b.set(doc(db, 'users', uidMe), { name, photo: photo || null, noGooglePhoto: noGoogle, updatedAt: Date.now() });
      // 참여 중인 여행들에 보이는 이름도 갱신
      const renames = [];
      for (const t of S.trips) {
        const old = t.memberNames?.[uidMe];
        b.update(doc(db, 'trips', t.id), { [`memberNames.${uidMe}`]: name });
        if (old && old !== name) renames.push([t.id, old]);
      }
      commit(b);
      toast('프로필을 저장했어요');
      for (const [id, old] of renames) write(() => renameInTrip(id, old, name));
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
  if (n) commit(batch);
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

/* ---------- 준비물 체크리스트 (여행마다 공유, 사람별 담당) ---------- */
const PACK_ABROAD = ['여권', '항공권·숙소 예약 확인', '환전·해외결제 카드', 'eSIM·유심', '충전기·멀티 어댑터', '보조배터리', '상비약', '세면도구', '여행자 보험'];
const PACK_LOCAL = ['숙소 예약 확인', '신분증', '충전기', '보조배터리', '상비약', '세면도구'];
const packOrder = (c) => c.pos ?? c.createdAt ?? 0;
let packDraft = ''; let packFocus = false; let packComposing = false; // 다시 그려도 입력 중인 글자 유지
function viewPack(t) {
  const mine = myName(t);
  const all = [...S.checks].sort((a, b) => packOrder(a) - packOrder(b));
  const mineCnt = all.filter((c) => c.who === mine).length;
  const list = S.packMine ? all.filter((c) => c.who === mine) : all;
  const done = all.filter((c) => c.done).length;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  return `<div class="packsum"><div><b>${done}</b> / ${all.length} 챙김</div><div class="ubar"><i style="width:${pct}%"></i></div></div>
    <div class="packadd"><input class="inp" id="ckInput" placeholder="챙길 것 (예: 우산)" maxlength="40" enterkeyhint="done" value="${esc(packDraft)}"><button class="btn dark" id="ckAdd">추가</button></div>
    ${all.length ? `<div class="wishfilter"><button class="pill ${S.packMine ? '' : 'on'}" data-act="packMine" data-v="0">전체 ${all.length}</button><button class="pill ${S.packMine ? 'on' : ''}" data-act="packMine" data-v="1">내 담당 ${mineCnt}</button></div>` : ''}
    ${list.length ? `<div class="packlist">${list.map((c) => `<div class="ck ${c.done ? 'done' : ''}">
        <button class="ckbox" data-act="ckToggle" data-id="${esc(c.id)}" aria-label="${c.done ? '체크 해제' : '챙겼어요'}">${c.done ? '✓' : ''}</button>
        <div class="ckt">${esc(c.text)}${c.done && c.doneBy ? `<span>${esc(c.doneBy)} 챙김</span>` : ''}</div>
        <button class="ckwho ${c.who ? '' : 'none'}" data-act="ckWho" data-id="${esc(c.id)}">${c.who ? `${nameAvatar(t, c.who, 18)}${esc(c.who)}` : '담당 정하기'}</button>
        <button class="ckdel" data-act="ckDel" data-id="${esc(c.id)}" aria-label="지우기">✕</button>
      </div>`).join('')}</div>`
      : S.packMine ? '<div class="empty"><b>내 담당이 없어요</b>항목 옆 \'담당 정하기\'로 나눠 보세요.</div>'
        : `<div class="empty"><b>준비물을 같이 챙겨요</b>담당을 정해 두면 누가 뭘 가져올지 헷갈리지 않아요.<br><button class="btn ghost" data-act="packDefaults" style="margin-top:14px">기본 목록 넣기</button></div>`}`;
}
function wirePack(t) {
  const inp = $('ckInput'); if (!inp) return;
  if (packFocus) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  inp.addEventListener('input', () => { packDraft = inp.value; });
  inp.addEventListener('focus', () => { packFocus = true; });
  inp.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement?.id !== 'ckInput') packFocus = false; }, 0); });
  inp.addEventListener('compositionstart', () => { packComposing = true; });
  inp.addEventListener('compositionend', () => { packComposing = false; packDraft = inp.value; });
  const add = () => {
    const text = inp.value.trim(); if (!text) return;
    inp.value = ''; packDraft = '';
    const max = S.checks.reduce((m, c) => Math.max(m, packOrder(c)), 0);
    write(() => setDoc(doc(db, 'trips', t.id, 'checks', uid()), { text, who: S.packMine ? myName(t) : null, done: false, pos: max + 1000, by: S.user.uid, createdAt: Date.now() }));
    packFocus = true; setTimeout(() => $('ckInput')?.focus(), 50);
  };
  $('ckAdd').onclick = add;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(); } });
}
function addPackDefaults(t) {
  const list = (t.currency || 'KRW') === 'KRW' ? PACK_LOCAL : PACK_ABROAD;
  const b = writeBatch(db); const now = Date.now();
  list.forEach((text, k) => b.set(doc(db, 'trips', t.id, 'checks', uid()), { text, who: null, done: false, pos: (k + 1) * 1000, by: S.user.uid, createdAt: now + k }));
  write(() => b.commit());
}
function packWhoSheet(t, c) {
  if (!c) return;
  const people = peopleOf(t);
  openSheet(`<h2>누가 챙길까요?</h2><p class="small muted" style="margin-top:-6px">${esc(c.text)}</p>
    <div class="whopick">${people.map((n) => `<button class="pill ${c.who === n ? 'on' : ''}" data-who="${esc(n)}">${nameAvatar(t, n, 20)}${esc(n)}</button>`).join('')}
      <button class="pill ${c.who ? '' : 'on'}" data-who="">같이 (안 정함)</button></div>`, (sh) => {
    sh.querySelector('.whopick').addEventListener('click', (e) => {
      const b = e.target.closest('[data-who]'); if (!b) return;
      closeSheet(); write(() => updateDoc(doc(db, 'trips', t.id, 'checks', c.id), { who: b.dataset.who || null }));
    });
  });
}

/* ---------- 현지 시간·시차 ---------- */
function tzOffsetMin(tz, d = new Date()) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(d.getTime() / 60000) * 60000) / 60000);
  } catch { return null; }
}
function localTimeText(tz) {
  const off = tzOffsetMin(tz), kr = tzOffsetMin('Asia/Seoul');
  if (off == null) return '';
  const now = new Intl.DateTimeFormat('ko-KR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const diff = off - kr; const h = Math.floor(Math.abs(diff) / 60), m = Math.abs(diff) % 60;
  const gap = `${h ? h + '시간' : ''}${m ? ` ${m}분` : ''}`.trim();
  return `🕒 현지 ${now} · ${diff === 0 ? '한국과 같음' : `한국보다 ${gap} ${diff > 0 ? '빠름' : '느림'}`}`;
}
function localTimeChip(t) {
  if (!t.tz || t.tz === 'Asia/Seoul' || tzOffsetMin(t.tz) == null) return '';
  return `<span class="chip" data-ltime="${esc(t.tz)}">${esc(localTimeText(t.tz))}</span>`;
}
setInterval(() => document.querySelectorAll('[data-ltime]').forEach((el) => { el.textContent = localTimeText(el.dataset.ltime); }), 30e3);
const tzTried = new Set();
async function ensureTz(t) {
  if (t.tz || tzTried.has(t.id) || !navigator.onLine) return;
  tzTried.add(t.id);
  try {
    const g = t.geo || (await geocodeCity(t.city).catch(() => null));
    if (!g) return;
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lng}&timezone=auto&forecast_days=1&daily=weather_code`);
    const tz = (await r.json()).timezone;
    if (tz && tzOffsetMin(tz) != null) await updateDoc(doc(db, 'trips', t.id), { tz });
  } catch (e) { console.warn('tz', e); }
}

/* ---------- 환율 불러오기 (무료, 키 없음) ---------- */
async function fetchRate(cur) {
  if (!cur || cur === 'KRW') return 1;
  const k = `fx:${cur}:${new Date().toISOString().slice(0, 10)}`;
  const hit = Number(lsGet(k)); if (hit > 0) return hit;
  let v = null;
  try { const j = await (await fetch(`https://open.er-api.com/v6/latest/${cur}`)).json(); v = Number(j?.rates?.KRW) || null; } catch { /* 다음 */ }
  if (!v) {
    try { const j = await (await fetch(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${cur.toLowerCase()}.json`)).json(); v = Number(j?.[cur.toLowerCase()]?.krw) || null; } catch { /* 실패 */ }
  }
  if (v) lsSet(k, String(v));
  return v;
}
/** 환율 입력칸에 오늘 환율 채우기 (단위: 1 또는 100 통화당 원) */
async function fillRate(input, cur, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '불러오는 중…'; }
  const v = await fetchRate(cur);
  if (btn) { btn.disabled = false; btn.textContent = '오늘 환율'; }
  if (!v) return toast('환율을 못 불러왔어요. 직접 넣어 주세요');
  input.value = String(Math.round(v * rateUnit(cur) * 100) / 100);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  toast(`${rateUnit(cur)} ${cur} = ${num(Math.round(v * rateUnit(cur)))}원 (오늘 시세, 카드 결제와 조금 달라요)`);
}

/* ---------- 오프라인 ---------- */
function paintNet() {
  const off = !navigator.onLine;
  document.body.classList.toggle('offline', off);
  $('netbadge').hidden = !off;
}
window.addEventListener('online', () => { paintNet(); if (mapInitP && !mapCtl) mapInitP = null; renderSoon(); });
window.addEventListener('offline', paintNet);
// 곧 떠나거나 여행 중인 여행은 데이터를 미리 받아 둠 (오프라인에서도 일정·항공권·QR 보이게)
const prefetched = new Set();
function prefetchTrips() {
  if (!navigator.onLine) return;
  const today = fmtD(new Date()); const soon = fmtD(new Date(Date.now() + 14 * 864e5));
  S.trips.filter((t) => t.start && t.start <= soon && (t.end || t.start) >= today && !prefetched.has(t.id)).forEach((t) => {
    prefetched.add(t.id);
    ['items', 'flights', 'places', 'checks', 'expenses', 'files'].forEach((c) => getDocs(collection(db, 'trips', t.id, c)).catch(() => {}));
  });
}

/* ---------- 보기 전용 공유 링크 (shares/{code}: 로그인 없이 읽기, 목록 조회 불가) ---------- */
function shareSnapshot(t) {
  const days = tripDays(t);
  return {
    tripId: t.id, name: t.name || '', city: t.city || '', start: t.start || '', end: t.end || '', tz: t.tz || null, days,
    items: days.flatMap((d) => dayItems(d)).filter((i) => i.kind !== 'memo').map((i) => ({
      date: i.date, time: i.time || '', title: i.title || '', cat: i.cat || '기타', address: i.address || '',
      lat: i.lat ?? null, lng: i.lng ?? null, placeId: i.placeId || null, who: i.who || [],
    })),
    flights: S.flights.map((f) => ({ from: f.from || '', to: f.to || '', depAt: f.depAt || '', arrAt: f.arrAt || '', airline: f.airline || '', flightNo: f.flightNo || '' }))
      .sort((a, b) => a.depAt.localeCompare(b.depAt)),
  };
}
const shareSig = new Map(); let shareTimer = null;
function syncShare(t) {
  if (!t.shareCode || !S.fresh.items || !S.fresh.flights || !navigator.onLine) return;
  const snap = shareSnapshot(t); const sig = JSON.stringify(snap);
  if (shareSig.get(t.shareCode) === sig) return;
  clearTimeout(shareTimer);
  shareTimer = setTimeout(() => {
    shareSig.set(t.shareCode, sig);
    setDoc(doc(db, 'shares', t.shareCode), { ...snap, updatedAt: Date.now(), by: S.user.uid }).catch((e) => { console.warn('share', e); shareSig.delete(t.shareCode); });
  }, 3000);
}
async function makeShare(t) {
  const code = t.shareCode || randCode(12);
  await setDoc(doc(db, 'shares', code), { ...shareSnapshot(t), updatedAt: Date.now(), by: S.user.uid });
  if (!t.shareCode) await updateDoc(doc(db, 'trips', t.id), { shareCode: code });
  shareSig.set(code, JSON.stringify(shareSnapshot(t)));
  return code;
}
async function stopShare(t) {
  if (!t.shareCode) return;
  await deleteDoc(doc(db, 'shares', t.shareCode)).catch(() => {});
  await updateDoc(doc(db, 'trips', t.id), { shareCode: null });
}
function viewShare() {
  showMap(false); $('fabhost').innerHTML = ''; $('banner').innerHTML = '';
  $('hdr').innerHTML = `<h1 class="brand" aria-label="슝">${I.word}</h1><span class="sv-badge">보기 전용</span>`;
  const sv = S.share;
  if (!sv) {
    $('view').innerHTML = '<div class="empty">불러오는 중…</div>';
    getDoc(doc(db, 'shares', shareCode)).then((d) => { S.share = d.exists() ? d.data() : { missing: true }; viewShare(); })
      .catch(() => { S.share = { missing: true }; viewShare(); });
    return;
  }
  if (sv.missing) { $('view').innerHTML = '<div class="empty"><b>링크가 꺼졌거나 잘못됐어요</b>공유한 사람에게 다시 받아 주세요.</div>'; return; }
  const days = sv.days || [];
  if (!S.day || !days.includes(S.day)) { const today = fmtD(new Date()); S.day = days.includes(today) ? today : days[0]; }
  const items = (sv.items || []).filter((i) => i.date === S.day);
  const fl = (sv.flights || []).filter((f) => (f.depAt || '').slice(0, 10) === S.day || (f.arrAt || '').slice(0, 10) === S.day);
  const gUrl = (i) => (i.placeId ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(i.title)}&query_place_id=${encodeURIComponent(i.placeId)}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(i.lat != null ? `${i.lat},${i.lng}` : `${i.title} ${sv.city || ''}`)}`);
  $('view').innerHTML = `<div class="wrap">
    <div class="sv-head"><div class="city">${esc(sv.city || 'TRIP')}</div><h2>${esc(sv.name)}</h2>
      <div class="tripmeta">${sv.start ? `<span class="chip">${esc(md(sv.start))}${sv.end && sv.end !== sv.start ? ' – ' + esc(md(sv.end)) : ''}</span>` : ''}${localTimeChip(sv)}</div></div>
    <div class="days">${days.map((d, idx) => `<button class="day ${d === S.day ? 'on' : ''}" data-sday="${esc(d)}" style="--dc:${DAYCOLORS[idx % DAYCOLORS.length]}"><b>Day ${idx + 1}</b><span>${d.startsWith('day') ? '' : esc(md(d))}</span></button>`).join('')}</div>
    ${fl.map((f) => `<div class="sv-row flight"><div class="sv-t">${esc(hm(f.depAt) || '')}</div><div><b>✈️ ${esc(f.from)} → ${esc(f.to)}</b><span>${esc([f.airline, f.flightNo].filter(Boolean).join(' '))}${f.arrAt ? ` · 도착 ${esc(hm(f.arrAt))}` : ''}</span></div></div>`).join('')}
    ${items.length ? items.map((i) => { const c = ICATS[i.cat] || ICATS.기타; return `<div class="sv-row" style="--cat:${c[1]}"><div class="sv-t">${esc(i.time || '')}</div>
      <div style="min-width:0"><b>${esc(i.title)}</b>${i.address ? `<span>${esc(i.address)}</span>` : ''}${(i.who || []).length ? `<span>👥 ${esc(i.who.join(', '))}</span>` : ''}</div>
      <a class="lnk" href="${esc(gUrl(i))}" target="_blank" rel="noopener">지도</a></div>`; }).join('') : (fl.length ? '' : '<div class="empty">이날은 일정이 없어요</div>')}
    <p class="small muted sv-foot">${sv.updatedAt ? `${esc(new Date(sv.updatedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))} 기준 · ` : ''}슝으로 만든 여행 일정이에요</p>
  </div>`;
  $('view').querySelectorAll('[data-sday]').forEach((b) => { b.onclick = () => { S.day = b.dataset.sday; viewShare(); }; });
}

/* ---------------- events ---------------- */
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]'); if (!el || el.closest('.sheet')) return;
  if (ev.target.closest('a.ckbtn')) { const f = S.flights.find((x) => x.id === el.dataset.id); if (f?.bookingRef) copy(f.bookingRef, `예약번호 ${f.bookingRef} 복사해 뒀어요`); return; }
  if (ev.target.closest('a')) return; // 링크는 그대로 열기
  if (ev.target.closest('.rate') && el.dataset.act !== 'rcomment') return; // 별점 영역은 지도 이동 안 함
  const a = el.dataset.act, id = el.dataset.id, t = trip();
  switch (a) {
    case 'open': S.tab = 'plan'; openTrip(id); break;
    case 'home': openTrip(null); break;
    case 'account': accountSheet(); break;
    case 'newTrip': tripForm(null); break;
    case 'guide': guideSheet(); break;
    case 'myFlights': lsSet('tn_my_flights', el.dataset.v); render(); break;
    case 'segpick': ev.stopPropagation(); openSegPicker(el); break;
    case 'tinfo': ev.stopPropagation(); transitSheet(id); break;
    case 'checkFlight': checkFlight(t, id, el); break;
    case 'taxi': { ev.stopPropagation(); const sg = stopMap.get(id); if (sg) taxiSheet(sg.from, sg.to); break; }
    case 'hideInstall': lsSet('tn_install_hide', '1'); render(); break;
    case 'editTrip': tripForm(t); break;
    case 'tab': S.tab = el.dataset.v; render(); window.scrollTo(0, 0); break;
    case 'rcomment': commentSheet(t, S.items.find((i) => i.id === id)); break;
    case 'moneyView': S.moneyView = el.dataset.v; render(); break;
    case 'sumCur': S.sumLocal = !S.sumLocal; try { localStorage.setItem('sumLocal', S.sumLocal ? '1' : ''); } catch {} render(); break;
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
    case 'viewAs': {
      // 화면 위치 유지: 누른 갈래 자리에 그 사람 일정이 오도록
      const fork = el.closest('.fork'); const y0 = scrollY;
      const anchorTop = fork ? fork.getBoundingClientRect().top : null;
      const toks = fork ? [...fork.querySelectorAll('[data-lp]')].map((x) => x.dataset.lp) : [];
      S.viewAs = el.dataset.v || null; render();
      const target = toks.length ? [...document.querySelectorAll('.timeline > [data-lp]')].find((x) => toks.includes(x.dataset.lp)) : null;
      if (target && anchorTop != null) window.scrollTo(0, scrollY + target.getBoundingClientRect().top - anchorTop);
      else window.scrollTo(0, y0);
      break;
    }
    case 'wishcat': S.wishCat = el.dataset.v; render(); break;
    case 'wishsort': S.wishSort = el.dataset.v; render(); break;
    case 'wishHideAdded': S.wishHideAdded = !S.wishHideAdded; lsSet('wishHideAdded', S.wishHideAdded ? '1' : ''); render(); break;
    case 'wishroute': S.wishRoute = el.dataset.v || null; render(); document.getElementById('mapwrap')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); break;
    case 'vote': {
      ev.stopPropagation(); const p = S.places.find((x) => x.id === id); if (!p) break;
      const on = !!p.votes?.[S.user.uid];
      p.votes = { ...(p.votes || {}), [S.user.uid]: !on }; if (on) delete p.votes[S.user.uid]; render();
      write(() => updateDoc(doc(db, 'trips', t.id, 'places', id), { [`votes.${S.user.uid}`]: on ? deleteField() : true }));
      break;
    }
    case 'ckToggle': {
      ev.stopPropagation(); const c = S.checks.find((x) => x.id === id); if (!c) break;
      const done = !c.done; c.done = done; render();
      write(() => updateDoc(doc(db, 'trips', t.id, 'checks', id), { done, doneBy: done ? myName(t) : null }));
      break;
    }
    case 'ckWho': ev.stopPropagation(); packWhoSheet(t, S.checks.find((x) => x.id === id)); break;
    case 'ckDel': {
      ev.stopPropagation(); const c = S.checks.find((x) => x.id === id); if (!c) break;
      askConfirm(`'${c.text}'을(를) 목록에서 지울까요?`, '삭제', () => write(() => deleteDoc(doc(db, 'trips', t.id, 'checks', id))));
      break;
    }
    case 'packMine': S.packMine = el.dataset.v === '1'; render(); break;
    case 'packDefaults': addPackDefaults(t); break;
    case 'newWish': wishForm(t, null); break;
    case 'editWish': wishForm(t, S.places.find((x) => x.id === id)); break;
    case 'toPlan': toPlanSheet(t, S.places.find((x) => x.id === id)); break;
    case 'focusWish': { const p = S.places.find((x) => x.id === id); if (p && mapCtl && ll(p)) { mapCtl.focus({ lat: p.lat, lng: p.lng }); window.scrollTo({ top: 0, behavior: 'smooth' }); } break; }
    case 'qrview': ev.stopPropagation(); openQrViewer(el.dataset.flight, Number(el.dataset.idx || 0)); break;
  }
}, true);

/** 이동 수단 고르기: 버튼 아래 유리 느낌 선택창 */
let segPopOff = null;
function closeSegPop() {
  document.getElementById('segpop')?.remove();
  // 바깥 누르면 닫는 리스너도 같이 정리 (안 지우면 다음에 열 때 방금 연 팝오버를 바로 닫아버림)
  if (segPopOff) { document.removeEventListener('click', segPopOff, true); segPopOff = null; }
}
function openSegPicker(btn) {
  closeSegPop();
  const sid = btn.dataset.id; const sg = stopMap.get(sid); if (!sg) return;
  const cur = btn.dataset.v, auto = btn.dataset.auto;
  const pop = document.createElement('div'); pop.id = 'segpop'; pop.className = 'segpop'; pop.setAttribute('role', 'menu');
  pop.innerHTML = `<div class="sp-h">어떻게 갈까요?</div>${Object.entries(MOVES).map(([k, v]) => {
    const r = segResult(sg.from, sg.to, k) || (k === auto ? segResult(sg.from, sg.to, 'auto') : null);
    const info = r && r.secs && !r.none ? `${fmtDur(r.secs)} · ${fmtDist(r.meters)}` : '';
    return `<button type="button" class="sp-row ${k === cur ? 'on' : ''}" data-mode="${k}" role="menuitem"><span class="sp-e">${v[0]}</span><span class="sp-l">${v[1]}${k === auto ? '<em>추천</em>' : ''}</span><span class="sp-i">${info}</span>${k === cur ? '<span class="sp-c">✓</span>' : ''}</button>`;
  }).join('')}<button type="button" class="sp-row sp-ti" data-x="tinfo"><span class="sp-e">🎫</span><span class="sp-l">${tinfoOf(sg.to) ? '교통편 정보 보기·수정' : '교통편 정보 적기'}</span><span class="sp-i">승차권·메모</span></button>`;
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect(); const w = pop.offsetWidth, h = pop.offsetHeight;
  const left = Math.min(Math.max(12, r.left), innerWidth - w - 12);
  const below = r.bottom + 8 + h < innerHeight;
  pop.style.left = `${left}px`; pop.style.top = `${(below ? r.bottom + 8 : r.top - h - 8) + scrollY}px`;
  pop.classList.toggle('up', !below);
  pop.addEventListener('click', (e) => {
    const row = e.target.closest('.sp-row'); if (!row) return;
    closeSegPop(); applySegMode(sid, row.dataset.mode, auto);
    if (row.dataset.mode === 'transit' && !tinfoOf(sg.to)) setTimeout(() => transitSheet(sid), 120);
  });
  pop.querySelector('[data-x=tinfo]')?.addEventListener('click', (e) => { e.stopPropagation(); closeSegPop(); transitSheet(sid); });
  setTimeout(() => {
    if (!pop.isConnected) return;
    segPopOff = (e) => { if (!e.target.closest('#segpop')) closeSegPop(); };
    document.addEventListener('click', segPopOff, true);
  }, 0);
}
/* 대중교통 구간 정보: 종류·편명/노선·메모·승차권 사진 (도착 지점 문서에 저장) */
const TKINDS = { 버스: '🚌', 기차: '🚆', 지하철: '🚇', 비행기: '✈️', 배: '⛴️', 기타: '🎫' };
const stopSrc = (st) => (st._col === 'items' ? S.items.find((x) => x.id === st._doc) : S.flights.find((x) => x.id === st._doc));
function tinfoOf(st) {
  if (!st?._tk) return null; const src = stopSrc(st); const ti = src?.[st._tk];
  return ti && (ti.kind || ti.no || ti.memo || (ti.photos || []).length) ? ti : null;
}
function transitSheet(sid) {
  const t = trip(); const sg = stopMap.get(sid); if (!t || !sg || !sg.to._tk) return;
  const st = sg.to; const ti = tinfoOf(st) || {};
  const photos = (ti.photos || []).map((id) => ({ id, data: qrCache.get(id) && qrCache.get(id) !== 'loading' ? qrCache.get(id) : null }));
  const removed = [];
  openSheet(`<h2>교통편 정보</h2><p class="small muted" style="margin-top:-6px">${esc(sg.from.title || '')} → ${esc(st.title || '')}</p>
    <label class="f"><span>종류</span>${pills('tkind', Object.keys(TKINDS), ti.kind || '버스')}</label>
    <label class="f"><span>노선·편명 (선택)</span><input class="inp" name="tno" value="${esc(ti.no || '')}" placeholder="예: 공항리무진 6001, KTX 101, 좌석 7A"></label>
    <label class="f"><span>메모</span><textarea class="inp" name="tmemo" rows="3" placeholder="예: 3번 승강장, 현금만 됨, 10분 간격">${esc(ti.memo || '')}</textarea></label>
    <div class="f"><span class="flbl">승차권·탑승권 사진 (최대 4장)</span><div class="qredit" id="tiPics"></div>
      <label class="btn ghost small" style="margin-top:8px;display:inline-flex">📷 사진 넣기<input type="file" accept="image/*" multiple hidden id="tiFile"></label></div>
    <div class="rowbtns">${tinfoOf(st) ? '<button class="btn danger" data-x="del">지우기</button>' : ''}<button class="btn dark" data-x="save">저장</button></div>`, (sh) => {
    wirePills(sh); const v = fval(sh);
    const draw = () => {
      sh.querySelector('#tiPics').innerHTML = photos.map((q, k) => `<div class="qrthumb" data-k="${k}">${q.data ? `<img src="${q.data}" alt="">` : '<span>사진</span>'}<button type="button" class="qrdel" data-k="${k}" aria-label="삭제">×</button></div>`).join('');
      sh.querySelectorAll('#tiPics img').forEach((img) => img.onclick = () => { const w = document.createElement('div'); w.className = 'tiview'; w.innerHTML = `<img src="${img.src}" alt="">`; w.onclick = () => w.remove(); document.body.appendChild(w); });
      sh.querySelectorAll('#tiPics .qrdel').forEach((b) => b.onclick = () => {
        if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = '삭제?'; return; }
        const [q] = photos.splice(Number(b.dataset.k), 1); if (q && !q.isNew) removed.push(q.id); draw();
      });
    };
    draw();
    photos.filter((q) => !q.data).forEach((q) => loadQr(t, q.id).then((d) => { q.data = d; draw(); }));
    sh.querySelector('#tiFile').addEventListener('change', async (ev) => {
      const files = [...ev.target.files].slice(0, 4 - photos.length);
      if (!files.length) return toast('사진은 4장까지 넣을 수 있어요');
      for (const f of files) { try { photos.push({ id: uid(), data: await compressImage(f), isNew: true }); } catch { toast('사진을 읽지 못했어요'); } }
      ev.target.value = ''; draw();
    });
    const save = (data) => {
      const b = writeBatch(db);
      for (const q of photos.filter((x) => x.isNew)) { b.set(doc(db, 'trips', t.id, 'files', q.id), { seg: `${st._col}/${st._doc}`, data: q.data, createdAt: Date.now(), by: S.user.uid }); qrCache.set(q.id, q.data); }
      for (const id of removed) { b.delete(doc(db, 'trips', t.id, 'files', id)); qrCache.delete(id); }
      const src = stopSrc(st); if (src) src[st._tk] = data;
      b.update(doc(db, 'trips', t.id, st._col, st._doc), { [st._tk]: data });
      closeSheet(); commit(b); render();
    };
    sh.querySelector('[data-x=save]').onclick = () => save({ kind: pillVal(sh, 'tkind')[0] || '기타', no: v('tno'), memo: v('tmemo'), photos: photos.map((q) => q.id) });
    sh.querySelector('[data-x=del]')?.addEventListener('click', () => askConfirm('교통편 정보를 지울까요? 사진도 같이 지워져요.', '지우기', () => { removed.push(...photos.filter((q) => !q.isNew).map((q) => q.id)); photos.length = 0; save(null); }));
  });
}
// 알아서 고른 수단과 같은 걸 고르면 계속 자동, 다른 걸 고르면 그 구간만 고정
function applySegMode(sid, value, auto) {
  const t = trip(); if (!t) return;
  const mm = value === auto ? null : value;
  const st = stopMap.get(sid)?.to; if (!st) return;
  const src = st._col === 'items' ? S.items.find((x) => x.id === st._doc) : S.flights.find((x) => x.id === st._doc);
  if (src) src[st._mmk] = mm; // 즉시 반영
  write(() => updateDoc(doc(db, 'trips', t.id, st._col, st._doc), { [st._mmk]: mm }));
  render();
}
window.addEventListener('scroll', closeSegPop, { passive: true });

window.addEventListener('scroll', () => $('hdr')?.classList.toggle('scrolled', scrollY > 4), { passive: true });
render();
paintNet();
