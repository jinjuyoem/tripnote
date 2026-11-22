import { bump } from './meter.js';
// 구글맵 로더 + 지도/핀/동선/장소검색 도우미
const KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
const MAP_ID = import.meta.env.VITE_GOOGLE_MAP_ID || 'DEMO_MAP_ID';

export const mapsEnabled = !!KEY;

let loaded = null;
function bootstrap() {
  if (loaded) return loaded;
  loaded = new Promise((resolve, reject) => {
    // 구글 공식 동적 로더(importLibrary) 방식
    ((g) => {
      let h; const c = 'google', l = 'importLibrary', q = '__ib__', m = document;
      const b = (window[c] = window[c] || {}); const d = (b.maps = b.maps || {});
      const r = new Set(); const e = new URLSearchParams();
      const u = () => h || (h = new Promise((f, n) => {
        const a = m.createElement('script');
        e.set('libraries', [...r] + '');
        for (const k in g) e.set(k.replace(/[A-Z]/g, (t) => '_' + t[0].toLowerCase()), g[k]);
        e.set('callback', c + '.maps.' + q);
        a.src = `https://maps.${c}apis.com/maps/api/js?` + e;
        d[q] = f; a.onerror = () => (h = n(Error('Google Maps could not load.')));
        m.head.append(a);
      }));
      if (!d[l]) d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n));
    })({ key: KEY, v: 'quarterly', language: 'ko', region: 'KR' }); // weekly는 검색창 UI가 예고 없이 바뀌어서 안정판 사용
    Promise.all([
      google.maps.importLibrary('maps'),
      google.maps.importLibrary('marker'),
      google.maps.importLibrary('places'),
    ]).then(resolve, reject);
  });
  return loaded;
}

export async function createMap(el) {
  if (!mapsEnabled) return null;
  const [{ Map, Polyline, InfoWindow, Circle }, { AdvancedMarkerElement, PinElement }] = await bootstrap();
  bump('map');
  const map = new Map(el, {
    mapId: MAP_ID,
    center: { lat: 37.5665, lng: 126.978 },
    zoom: 12,
    disableDefaultUI: true,
    zoomControl: true,
    gestureHandling: 'greedy',
    clickableIcons: false,
  });
  let markers = [];
  let lines = [];
  // 핀 누르면 지도 안에서 뜨는 작은 팝업
  const info = new InfoWindow({ headerDisabled: true, disableAutoPan: false, pixelOffset: new google.maps.Size(0, -4) });
  map.addListener('click', () => info.close());
  function popup(mk, p, color) {
    const el = document.createElement('div'); el.className = 'mpop';
    const h = document.createElement('div'); h.className = 'mpop-t';
    if (p.label !== undefined && p.label !== '') { const b = document.createElement('i'); b.textContent = String(p.label); b.style.background = color; h.appendChild(b); }
    h.appendChild(document.createTextNode(p.title || ''));
    el.appendChild(h);
    if (p.sub) { const s2 = document.createElement('div'); s2.className = 'mpop-s'; s2.textContent = p.sub; el.appendChild(s2); }
    if (p.memo) { const m = document.createElement('div'); m.className = 'mpop-m'; m.textContent = p.memo; el.appendChild(m); }
    info.setContent(el); info.open({ map, anchor: mk });
  }

  function clear() {
    markers.forEach((m) => (m.map = null));
    lines.forEach((l) => l.setMap(null));
    markers = []; lines = [];
  }

  /**
   * groups: [{ color, points: [{lat,lng,label,title,onClick}] , path: bool }]
   */
  function draw(groups) {
    clear(); info.close();
    const bounds = new google.maps.LatLngBounds();
    let n = 0;
    for (const g of groups) {
      for (const p of g.points) {
        const pin = new PinElement({
          background: g.color, borderColor: '#ffffff', glyphColor: '#ffffff',
          glyph: String(p.label ?? ''), scale: g.scale || 1.05,
        });
        const mk = new AdvancedMarkerElement({ map, position: p, content: pin.element, title: p.title || '' });
        mk.addListener('click', () => { popup(mk, p, g.color); if (p.onClick) p.onClick(); });
        markers.push(mk); bounds.extend(p); n++;
      }
      if (g.path && g.points.length > 1) {
        lines.push(new Polyline({
          map, path: g.points, strokeColor: g.color, strokeOpacity: 0,
          icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.9, strokeWeight: 3, scale: 3 }, offset: '0', repeat: '14px' }],
        }));
      }
    }
    if (n === 1) { map.setCenter(bounds.getCenter()); map.setZoom(15); }
    else if (n > 1) map.fitBounds(bounds, 48);
    return n;
  }
  function focus(p) { map.panTo(p); if (map.getZoom() < 15) map.setZoom(15); }
  // 여행 도시로 지도 맞추기. 저장된 좌표(geo)가 있으면 API 없이 바로, 없으면 지오코딩 → 장소 검색 순으로 찾고 좌표를 돌려줌
  async function centerOn(text, geo) {
    const g = geo && geo.lat != null ? geo : await geocodeCityG(text);
    if (g) { map.setCenter({ lat: +g.lat, lng: +g.lng }); map.setZoom(11); }
    return g || null;
  }
  // 내 위치: 파란 점 + 정확도 원 (일정 다시 그려도 안 지워짐)
  let meMk = null, meCircle = null;
  function setMe(pos, acc) {
    if (!pos) { if (meMk) meMk.map = null; if (meCircle) meCircle.setMap(null); meMk = meCircle = null; return; }
    if (!meMk) {
      const dot = document.createElement('div'); dot.className = 'medot';
      meMk = new AdvancedMarkerElement({ map, position: pos, content: dot, title: '내 위치', zIndex: 9999 });
      meCircle = new Circle({ map, center: pos, radius: acc || 30, strokeOpacity: 0, fillColor: '#2E5BFF', fillOpacity: 0.12, clickable: false });
    } else { meMk.position = pos; meCircle.setCenter(pos); meCircle.setRadius(acc || 30); }
  }
  function centerDist(pos) {
    const c = map.getCenter(); if (!c || !pos) return Infinity;
    return google.maps.geometry?.spherical ? google.maps.geometry.spherical.computeDistanceBetween(c, pos)
      : Math.hypot((c.lat() - pos.lat) * 111000, (c.lng() - pos.lng) * 111000 * Math.cos(pos.lat * Math.PI / 180));
  }
  return { map, draw, focus, centerOn, clear, setMe, centerDist };
}

/** 도시 이름 → 좌표 (구글). 한국 쪽 쏠림을 피하려고 도시·지역 결과만 받음 */
export async function geocodeCityG(name) {
  if (!mapsEnabled || !name) return null;
  await bootstrap();
  const ok = (types = []) => types.some((x) => ['locality', 'administrative_area_level_1', 'administrative_area_level_2', 'country', 'colloquial_area'].includes(x));
  try {
    const { Geocoder } = await google.maps.importLibrary('geocoding');
    bump('geo'); const { results } = await new Geocoder().geocode({ address: name });
    const r = (results || []).find((x) => ok(x.types));
    if (r) return { lat: r.geometry.location.lat(), lng: r.geometry.location.lng() };
  } catch { /* 장소 검색으로 */ }
  try {
    const { Place } = await google.maps.importLibrary('places');
    bump('text'); const { places } = await Place.searchByText({ textQuery: name, includedType: 'locality', fields: ['location'], maxResultCount: 1 });
    const loc = places?.[0]?.location;
    if (loc) return { lat: loc.lat(), lng: loc.lng() };
  } catch { /* 무시 */ }
  return null;
}

/** 공항 코드(KIX 등) → 좌표 */
// 자주 가는 공항은 바로 좌표 (API 호출 없이)
const AIRPORTS = {
  ICN: [37.4602, 126.4407], GMP: [37.5583, 126.7906], PUS: [35.1795, 128.9382], CJU: [33.5104, 126.4914], TAE: [35.8941, 128.6589], CJJ: [36.7166, 127.4991],
  KIX: [34.4347, 135.2440], ITM: [34.7855, 135.4382], NRT: [35.7720, 140.3929], HND: [35.5494, 139.7798], FUK: [33.5859, 130.4511], CTS: [42.7752, 141.6923],
  OKA: [26.1958, 127.6459], NGO: [34.8584, 136.8054], KOJ: [31.8034, 130.7195], KMJ: [32.8373, 130.8551], OIT: [33.4794, 131.7372], SDJ: [38.1397, 140.9170],
  TPE: [25.0797, 121.2342], TSA: [25.0694, 121.5525], KHH: [22.5771, 120.3500], HKG: [22.3080, 113.9185], MFM: [22.1496, 113.5915],
  PVG: [31.1443, 121.8083], SHA: [31.1979, 121.3363], PEK: [40.0799, 116.6031], PKX: [39.5098, 116.4105], TAO: [36.3661, 120.0950], CAN: [23.3924, 113.2988],
  BKK: [13.6900, 100.7501], DMK: [13.9126, 100.6068], CNX: [18.7668, 98.9626], HKT: [8.1132, 98.3169], SGN: [10.8188, 106.6520], HAN: [21.2187, 105.8042],
  DAD: [16.0439, 108.1994], CXR: [11.9982, 109.2194], PQC: [10.1698, 103.9931], MNL: [14.5086, 121.0194], CEB: [10.3075, 123.9794], SIN: [1.3644, 103.9915],
  KUL: [2.7456, 101.7099], DPS: [-8.7482, 115.1675], CGK: [-6.1256, 106.6559], GUM: [13.4834, 144.7960], SPN: [15.1190, 145.7290],
  LAX: [33.9416, -118.4085], SFO: [37.6213, -122.3790], JFK: [40.6413, -73.7781], HNL: [21.3245, -157.9251], CDG: [49.0097, 2.5479], LHR: [51.4700, -0.4543],
  FCO: [41.8003, 12.2389], BCN: [41.2974, 2.0833], FRA: [50.0379, 8.5622], IST: [41.2753, 28.7519], SYD: [-33.9399, 151.1753], DXB: [25.2532, 55.3657],
};
export async function geocodeAirport(code) {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  if (AIRPORTS[c]) return { lat: AIRPORTS[c][0], lng: AIRPORTS[c][1], code };
  if (!mapsEnabled) return null;
  await bootstrap();
  try {
    const { Geocoder } = await google.maps.importLibrary('geocoding');
    bump('geo'); const { results } = await new Geocoder().geocode({ address: `${code} airport` });
    const r = results?.[0];
    if (r) return { lat: r.geometry.location.lat(), lng: r.geometry.location.lng(), code };
  } catch (e) { console.warn('geocode 실패, 장소 검색으로 다시 시도', e); }
  try {
    const { Place } = await google.maps.importLibrary('places');
    bump('text'); const { places } = await Place.searchByText({ textQuery: `${code} airport`, fields: ['location'], maxResultCount: 1 });
    const loc = places?.[0]?.location;
    if (loc) return { lat: loc.lat(), lng: loc.lng(), code };
  } catch (e) { console.warn('공항 위치를 못 찾음', code, e); }
  return null;
}

/** 두 지점 사이 거리·시간 (Routes API). mode: WALK | TRANSIT | DRIVE | BICYCLE
 * opt: { time:'HH:MM', date:'YYYY-MM-DD'(그날 요일 기준), offsetMin: 현지 UTC 오프셋(분) } */
export async function computeRoute(from, to, mode, opt = {}) {
  if (!mapsEnabled) return null;
  const body = {
    origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
    destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
    travelMode: mode, languageCode: 'ko',
  };
  if (mode === 'DRIVE') body.routingPreference = 'TRAFFIC_UNAWARE';
  if (mode === 'TRANSIT') body.departureTime = transitDeparture(from, opt);
  const mask = mode === 'TRANSIT'
    ? 'routes.distanceMeters,routes.duration,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.transitDetails.stopDetails'
    : 'routes.distanceMeters,routes.duration';
  const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': mask },
    body: JSON.stringify(body),
  });
  bump('route');
  if (!r.ok) throw new Error('routes ' + r.status);
  const j = await r.json();
  const rt = j.routes?.[0];
  if (!rt) return { none: true };
  const secs = mode === 'TRANSIT' ? transitSecs(rt) : parseInt(rt.duration, 10) || 0;
  return { meters: rt.distanceMeters || 0, secs };
}

// 대중교통 조회 시각: 그 일정 날짜와 같은 요일, 같은 현지 시각 중 가장 가까운 미래 (시간표는 먼 미래·과거가 없어서)
function transitDeparture(from, { time, date, offsetMin } = {}) {
  const [hh, mm] = (time || '12:00').split(':').map(Number);
  const off = offsetMin != null ? offsetMin : Math.round(from.lng / 15) * 60; // tz 모르면 경도로 대략
  const want = date ? new Date(date + 'T00:00:00Z').getUTCDay() : null;
  const minAt = Date.now() + 30 * 60e3;
  const now = new Date();
  for (let i = 0; i < 15; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i, hh, mm || 0) - off * 60e3);
    const localDay = new Date(d.getTime() + off * 60e3).getUTCDay();
    if (d.getTime() < minAt) continue;
    if (want == null || localDay === want) return d.toISOString();
  }
  return new Date(minAt + 86400e3).toISOString();
}

// 구글 대중교통 시간은 '조회 시각부터'라 첫 차 기다리는 시간이 들어감 → 구글맵 앱처럼 출발해야 할 때부터 계산
function transitSecs(rt) {
  const total = parseInt(rt.duration, 10) || 0;
  const steps = (rt.legs || []).flatMap((l) => l.steps || []);
  const tIdx = steps.map((s, i) => (s.transitDetails?.stopDetails ? i : -1)).filter((i) => i >= 0);
  if (!tIdx.length) return total;
  const sd = (s) => parseInt(s.staticDuration, 10) || 0;
  const first = steps[tIdx[0]].transitDetails.stopDetails;
  const last = steps[tIdx[tIdx.length - 1]].transitDetails.stopDetails;
  const dep = Date.parse(first.departureTime), arr = Date.parse(last.arrivalTime);
  if (!dep || !arr || arr <= dep) return total;
  const before = steps.slice(0, tIdx[0]).reduce((a, s) => a + sd(s), 0);
  const after = steps.slice(tIdx[tIdx.length - 1] + 1).reduce((a, s) => a + sd(s), 0);
  const secs = before + Math.round((arr - dep) / 1000) + after;
  return secs > 0 && secs <= total ? secs : total;
}

/** 장소 검색창을 container에 붙이고, 고르면 onPick({name,address,lat,lng,placeId})
 * 구글 기본 검색 위젯은 폰에서 전체 화면으로 바뀌고 결과가 안 뜨는 일이 있어서, 입력칸·목록은 직접 그림 (데이터만 Places API) */
export async function mountPlaceSearch(container, onPick, near) {
  if (!mapsEnabled) return null;
  await bootstrap();
  const { AutocompleteSuggestion, AutocompleteSessionToken } = await google.maps.importLibrary('places');
  container.innerHTML = `<div class="psearch"><input class="inp" type="search" enterkeyhint="search" autocomplete="off" placeholder="장소 검색 (예: 도톤보리)"><div class="pslist" hidden></div></div>`;
  const inp = container.querySelector('input'), list = container.querySelector('.pslist');
  let token = new AutocompleteSessionToken(), seq = 0, timer = null, items = [];
  const acCache = new Map(); // 같은 검색어는 다시 안 부름
  const escH = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const show = (html) => { list.innerHTML = html; list.hidden = !html; };
  function paint() {
      show(items.length ? items.map((p, i) => `<button type="button" class="psitem" data-i="${i}"><b>${escH(p.mainText?.text || p.text?.text)}</b><span>${escH(p.secondaryText?.text || '')}</span></button>`).join('')
        : '<div class="psmsg">검색 결과가 없어요. 영어나 현지어로도 쳐 보세요.</div>');
  }
  async function run(q) {
    const my = ++seq;
    q = q.trim();
    if (q.length < 2) { items = []; return show(''); } // 한 글자는 결과가 의미 없고 호출만 늘어서 2글자부터
    if (acCache.has(q)) { items = acCache.get(q); return paint(); }
    try {
      const req = { input: q, language: 'ko', sessionToken: token };
      if (near) req.locationBias = near;
      let res;
      bump('ac');
      try { res = await AutocompleteSuggestion.fetchAutocompleteSuggestions(req); }
      catch (e) { if (!near || /quota|RESOURCE_EXHAUSTED|429/i.test(String(e?.message || e))) throw e; delete req.locationBias; bump('ac'); res = await AutocompleteSuggestion.fetchAutocompleteSuggestions(req); }
      if (my !== seq) return;
      items = (res.suggestions || []).map((x) => x.placePrediction).filter(Boolean);
      acCache.set(q, items); if (acCache.size > 100) acCache.delete(acCache.keys().next().value);
      paint();
    } catch (e) {
      if (my !== seq) return;
      console.error('장소 검색 오류', e);
      const quota = /quota|RESOURCE_EXHAUSTED|429|OVER_QUERY_LIMIT/i.test(String(e?.message || e));
      show(`<div class="psmsg">${quota ? '오늘 검색 한도를 다 썼어요. 내일 다시 돼요.' : '검색이 안 돼요. 잠시 후 다시 해 주세요.'}</div>`);
    }
  }
  inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run(inp.value), 1000); }); // 치는 동안엔 안 부르고 1초 멈췄을 때만
  list.addEventListener('click', async (e) => {
    const b = e.target.closest('.psitem'); if (!b) return;
    const pred = items[+b.dataset.i]; if (!pred) return;
    show(''); inp.value = pred.mainText?.text || pred.text?.text || '';
    try {
      const place = pred.toPlace();
      // displayName을 받으면 Pro 요금(1천 건당 $17)이라, 이름은 검색 목록 글자를 쓰고 주소·좌표만 받음 (Essentials, $5)
      bump('place');
      await place.fetchFields({ fields: ['formattedAddress', 'location'] });
      token = new AutocompleteSessionToken();
      onPick({ name: pred.mainText?.text || pred.text?.text || inp.value, address: place.formattedAddress || '', lat: place.location?.lat(), lng: place.location?.lng(), placeId: place.id });
    } catch (err) { console.error(err); show('<div class="psmsg">장소 정보를 못 가져왔어요. 다시 골라 주세요.</div>'); }
  });
  return inp;
}
