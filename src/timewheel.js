// 아이폰 알람 스타일 시간 휠 (24시간, 5분 단위)
const ROW = 44;
const H = [...Array(24).keys()].map((h) => String(h).padStart(2, '0'));
const M = [...Array(12).keys()].map((m) => String(m * 5).padStart(2, '0'));

/** openTimeWheel('14:30', '시간 선택', (value|'') => {}) — '' = 시간 없음 */
export function openTimeWheel(initial, title, onDone, { allowClear = true } = {}) {
  document.getElementById('wheelwrap')?.remove();
  const [ih, im] = (initial || '').split(':');
  const hIdx = initial ? Math.max(0, H.indexOf(ih)) : 12;
  const mIdx = initial ? Math.round(Number(im || 0) / 5) % 12 : 0;

  const w = document.createElement('div'); w.id = 'wheelwrap'; w.className = 'wheelwrap';
  const col = (name, list) => `<div class="wcol" data-col="${name}"><div class="wpad"></div>${list.map((v) => `<div class="witem">${v}</div>`).join('')}<div class="wpad"></div></div>`;
  w.innerHTML = `<div class="wheelsheet" role="dialog" aria-label="${title}">
    <div class="wtop"><span>${title}</span><b class="wval mono"></b></div>
    <div class="wheel">${col('h', H)}<div class="wsep">:</div>${col('m', M)}<div class="wband"></div></div>
    <div class="wbtns">${allowClear ? '<button type="button" class="btn ghost" data-w="clear">시간 없음</button>' : ''}<button type="button" class="btn dark" data-w="ok">완료</button></div>
  </div>`;
  document.body.appendChild(w);
  const hc = w.querySelector('[data-col=h]'), mc = w.querySelector('[data-col=m]');
  const idx = (c, n) => Math.max(0, Math.min(n - 1, Math.round(c.scrollTop / ROW)));
  const val = () => `${H[idx(hc, 24)]}:${M[idx(mc, 12)]}`;
  const paint = () => {
    w.querySelector('.wval').textContent = val();
    [[hc, 24], [mc, 12]].forEach(([c, n]) => { const k = idx(c, n); c.querySelectorAll('.witem').forEach((el, i) => el.classList.toggle('on', i === k)); });
  };
  requestAnimationFrame(() => { hc.scrollTop = hIdx * ROW; mc.scrollTop = mIdx * ROW; paint(); });
  [hc, mc].forEach((c) => {
    c.addEventListener('scroll', () => requestAnimationFrame(paint), { passive: true });
    // 항목을 탭하면 그 값으로 이동
    c.addEventListener('click', (e) => {
      const it = e.target.closest('.witem'); if (!it) return;
      const i = [...c.querySelectorAll('.witem')].indexOf(it);
      c.scrollTo({ top: i * ROW, behavior: 'smooth' });
    });
  });
  const close = () => w.remove();
  w.addEventListener('click', (e) => {
    if (e.target === w) return close();
    const b = e.target.closest('[data-w]'); if (!b) return;
    if (b.dataset.w === 'ok') { const v = val(); close(); onDone(v); }
    else if (b.dataset.w === 'clear') { close(); onDone(''); }
  });
}

/** 폼 안에 넣는 시간 버튼 (hidden input name=name에 값 저장) */
export const timeField = (name, value, placeholder = '시간 선택') =>
  `<button type="button" class="inp timebtn ${value ? '' : 'empty'}" data-timefield="${name}">${value || placeholder}</button><input type="hidden" name="${name}" value="${value || ''}">`;

export function wireTimeFields(root, title = '시간') {
  root.querySelectorAll('[data-timefield]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.timefield; const hid = root.querySelector(`input[name="${name}"]`);
      openTimeWheel(hid.value, title, (v) => {
        hid.value = v; btn.textContent = v || '시간 선택'; btn.classList.toggle('empty', !v);
        hid.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  });
}
