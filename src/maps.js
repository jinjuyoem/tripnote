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
  const [{ Map, Polyline }, { AdvancedMarkerElement, PinElement }] = await bootstrap();
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

  function clear() {
    markers.forEach((m) => (m.map = null));
    lines.forEach((l) => l.setMap(null));
    markers = []; lines = [];
  }

  /**
   * groups: [{ color, points: [{lat,lng,label,title,onClick}] , path: bool }]
   */
  function draw(groups) {
    clear();
    const bounds = new google.maps.LatLngBounds();
    let n = 0;
    for (const g of groups) {
      for (const p of g.points) {
        const pin = new PinElement({
          background: g.color, borderColor: '#ffffff', glyphColor: '#ffffff',
          glyph: String(p.label ?? ''), scale: 1.05,
        });
        const mk = new AdvancedMarkerElement({ map, position: p, content: pin.element, title: p.title || '' });
        if (p.onClick) mk.addListener('click', p.onClick);
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
    if (geo && geo.lat != null) { map.setCenter({ lat: +geo.lat, lng: +geo.lng }); map.setZoom(11); return geo; }
    if (!text) return null;
    try {
      const { Geocoder } = await google.maps.importLibrary('geocoding');
      const { results } = await new Geocoder().geocode({ address: text });
      const r = results?.[0];
      if (r) { map.fitBounds(r.geometry.viewport); return { lat: r.geometry.location.lat(), lng: r.geometry.location.lng() }; }
    } catch { /* 장소 검색으로 다시 */ }
    try {
      const { Place } = await google.maps.importLibrary('places');
      const { places } = await Place.searchByText({ textQuery: text, fields: ['location', 'viewport'], maxResultCount: 1 });
      const pl = places?.[0];
      if (pl?.location) {
        if (pl.viewport) map.fitBounds(pl.viewport); else { map.setCenter(pl.location); map.setZoom(11); }
        return { lat: pl.location.lat(), lng: pl.location.lng() };
      }
    } catch { /* 무시 */ }
    return null;
  }
  return { map, draw, focus, centerOn, clear };
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
    const { results } = await new Geocoder().geocode({ address: `${code} airport` });
    const r = results?.[0];
    if (r) return { lat: r.geometry.location.lat(), lng: r.geometry.location.lng(), code };
  } catch (e) { console.warn('geocode 실패, 장소 검색으로 다시 시도', e); }
  try {
    const { Place } = await google.maps.importLibrary('places');
    const { places } = await Place.searchByText({ textQuery: `${code} airport`, fields: ['location'], maxResultCount: 1 });
    const loc = places?.[0]?.location;
    if (loc) return { lat: loc.lat(), lng: loc.lng(), code };
  } catch (e) { console.warn('공항 위치를 못 찾음', code, e); }
  return null;
}

/** 두 지점 사이 거리·시간 (Routes API). mode: WALK | TRANSIT | DRIVE | BICYCLE */
export async function computeRoute(from, to, mode, timeHHMM) {
  if (!mapsEnabled) return null;
  const body = {
    origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
    destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
    travelMode: mode, languageCode: 'ko',
  };
  if (mode === 'DRIVE') body.routingPreference = 'TRAFFIC_UNAWARE';
  if (mode === 'TRANSIT') {
    // 지금 시각(새벽 등) 기준이면 대중교통이 없다고 나와서, 내일 같은 시각(없으면 낮 12시) 기준으로 조회
    // 현지 시각 → UTC는 경도로 대략 환산 (15도 = 1시간)
    const [hh, mm] = (timeHHMM || '12:00').split(':').map(Number);
    const offsetH = Math.round(from.lng / 15);
    const d = new Date(); d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(hh - offsetH, mm || 0, 0, 0);
    if (d < new Date(Date.now() + 3600e3)) d.setUTCDate(d.getUTCDate() + 1);
    body.departureTime = d.toISOString();
  }
  const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('routes ' + r.status);
  const j = await r.json();
  const rt = j.routes?.[0];
  if (!rt) return { none: true };
  return { meters: rt.distanceMeters || 0, secs: parseInt(rt.duration, 10) || 0 };
}

/** 장소 검색창을 container에 붙이고, 고르면 onPick({name,address,lat,lng,placeId}) */
export async function mountPlaceSearch(container, onPick, near) {
  if (!mapsEnabled) return null;
  await bootstrap();
  const { PlaceAutocompleteElement } = await google.maps.importLibrary('places');
  let el;
  try { el = new PlaceAutocompleteElement(near ? { locationBias: near } : {}); }
  catch (e) { console.warn('검색 기준점 무시', e); el = new PlaceAutocompleteElement({}); }
  el.addEventListener('gmp-error', (e) => console.error('장소 검색 오류', e));
  el.setAttribute('placeholder', '장소 검색 (예: 도톤보리)');
  el.style.width = '100%';
  el.style.colorScheme = 'light';
  container.innerHTML = '';
  container.appendChild(el);

  const handle = async (place) => {
    try {
      await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
      onPick({
        name: place.displayName || '',
        address: place.formattedAddress || '',
        lat: place.location?.lat(), lng: place.location?.lng(),
        placeId: place.id,
      });
    } catch (e) { console.error(e); }
  };
  el.addEventListener('gmp-select', ({ placePrediction }) => placePrediction && handle(placePrediction.toPlace()));
  el.addEventListener('gmp-placeselect', ({ place }) => place && handle(place)); // 구버전 호환
  return el;
}
