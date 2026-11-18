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
    })({ key: KEY, v: 'weekly', language: 'ko', region: 'KR' });
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
  async function centerOn(text) {
    if (!text) return;
    try {
      const { Geocoder } = await google.maps.importLibrary('geocoding');
      const { results } = await new Geocoder().geocode({ address: text });
      if (results?.[0]) map.fitBounds(results[0].geometry.viewport);
    } catch { /* 무시 */ }
  }
  return { map, draw, focus, centerOn, clear };
}

/** 두 지점 사이 거리·시간 (Routes API). mode: WALK | TRANSIT | DRIVE | BICYCLE */
export async function computeRoute(from, to, mode) {
  if (!mapsEnabled) return null;
  const body = {
    origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
    destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
    travelMode: mode, languageCode: 'ko',
  };
  if (mode === 'DRIVE') body.routingPreference = 'TRAFFIC_UNAWARE';
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
  const opts = {};
  if (near) opts.locationBias = near;
  const el = new PlaceAutocompleteElement(opts);
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
