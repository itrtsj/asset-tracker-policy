/* Pelacak Inventaris — Royal Tulip Springhill Resort Jimbaran (versi web).
 * Memakai Supabase yang SAMA dengan aplikasi Android: login, data, dan RLS identik.
 * Tanpa library luar: satu berkas, CSP ketat, semua teks disisipkan lewat textContent. */
'use strict';

const CFG = window.APP_CONFIG || {};
const AUDIT_DAYS = 365;
const CATEGORIES = ['workstation', 'laptop', 'tablet_gadget', 'tv_iptv', 'videotron', 'printer_scanner',
  'handy_talky', 'switch_hub', 'pos', 'server', 'library_book', 'board_game', 'toy', 'stationery', 'other'];
const STATUSES = ['In Use', 'In Storage', 'Out For Repair', 'Retired'];
const CONDITIONS = ['New', 'Good', 'Fair', 'Poor'];
const BUCKET = 'asset-photos';
const KEYS = {session: 'aset-session', pkce: 'aset-pkce'};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;                 // hanya untuk ikon SVG statis
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
};
const clear = n => { while (n.firstChild) n.removeChild(n.firstChild); };

/* ------------------------------------------------------------------ format */
const fmtDate = s => s ? new Date(s).toLocaleDateString('id-ID', {day: '2-digit', month: 'short', year: 'numeric'}) : '';
const fmtWhen = s => s ? new Date(s).toLocaleString('id-ID', {day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'}) : '';
const rupiah = v => v == null || v === '' ? null : 'Rp ' + Number(v).toLocaleString('id-ID', {maximumFractionDigits: 0});
const label = v => v ? v.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Tidak diketahui';
const todayISO = () => new Date().toLocaleDateString('sv-SE');
const isOverdue = a => !!a.borrowed && !!a.due_date && a.due_date < todayISO();
const needsAudit = a => !a.last_audit_at || (Date.now() - new Date(a.last_audit_at).getTime()) > AUDIT_DAYS * 864e5;

/* ---------------------------------------------------------------- sesi/auth */
let S = null;            // {access, refresh, email}
let remember = true;

function loadSession() {
  try {
    const raw = localStorage.getItem(KEYS.session) || sessionStorage.getItem(KEYS.session);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveSession(s) {
  S = s;
  for (const st of [localStorage, sessionStorage]) st.removeItem(KEYS.session);
  if (!s) return;
  (remember ? localStorage : sessionStorage).setItem(KEYS.session, JSON.stringify(s));
}
const jwtSub = t => {
  try { const p = t.split('.')[1]; return JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))).sub || null; } catch { return null; }
};

class ApiError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const localize = m => {
  const t = String(m || '');
  const has = s => t.toLowerCase().includes(s);
  if (has('invalid login credentials')) return 'Email atau kata sandi salah.';
  if (has('already registered')) return 'Email sudah terdaftar. Silakan masuk.';
  if (has('not confirmed')) return 'Email belum dikonfirmasi. Cek kotak masuk Anda.';
  if (has('rate limit') || has('too many')) return 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.';
  if (has('invalid refresh token') || has('invalid_grant')) return 'Sesi Anda berakhir. Silakan masuk lagi.';
  if (has('column') && has('does not exist')) return 'Server belum mendukung kolom inventaris baru (jalankan migrasi di Supabase).';
  if (has('sedang dipegang')) return 'Aset sedang dipegang orang lain. Segarkan daftar, lalu check-in dulu.';
  if (has('tidak sedang dipinjam')) return 'Aset tidak sedang dipinjam. Segarkan daftar.';
  if (has('personel tidak ditemukan')) return 'Personel tidak ditemukan atau sudah nonaktif.';
  if (has('jatuh tempo')) return 'Jatuh tempo tidak boleh di masa lalu.';
  if (has('aset tidak ditemukan')) return 'Aset tidak ditemukan. Segarkan daftar.';
  if (has('row-level security')) return 'Akses ditolak server. Akun Anda mungkin hanya boleh membaca (peran viewer).';
  if (has('duplicate key')) return 'Kode aset sudah dipakai.';
  if (has('payload too large') || has('maximum allowed size')) return 'Berkas terlalu besar.';
  if (has('failed to fetch') || has('networkerror')) return 'Tidak dapat menghubungi server. Periksa koneksi internet.';
  return t || 'Terjadi kesalahan pada server. Coba lagi.';
};

async function rawFetch(path, {method = 'GET', body, token, headers = {}, binary = false} = {}) {
  const h = {apikey: CFG.key, ...headers};
  h.Authorization = 'Bearer ' + (token || CFG.key);
  const opt = {method, headers: h};
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof Uint8Array) { opt.body = body; }
    else { h['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  }
  let r;
  try { r = await fetch(CFG.url + path, opt); }
  catch (e) { throw new ApiError(0, 'Tidak dapat menghubungi server. Periksa koneksi internet.'); }
  if (binary && r.ok) return new Uint8Array(await r.arrayBuffer());
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    let code = r.status;
    if (path.startsWith('/storage/') && text.includes('"statusCode":"401"')) code = 401;
    const msg = (data && (data.msg || data.error_description || data.message || data.error)) || text;
    throw new ApiError(code, localize(msg));
  }
  return data;
}

async function refreshOnce() {
  if (!S || !S.refresh) throw new ApiError(401, 'Sesi Anda berakhir. Silakan masuk lagi.');
  const d = await rawFetch('/auth/v1/token?grant_type=refresh_token', {method: 'POST', body: {refresh_token: S.refresh}});
  const s = sessionFrom(d);
  saveSession(s);
  return s;
}

async function api(path, opt = {}) {
  if (!S) throw new ApiError(401, 'Sesi Anda berakhir. Silakan masuk lagi.');
  try { return await rawFetch(path, {...opt, token: S.access}); }
  catch (e) {
    if (e.code !== 401) throw e;
    try { await refreshOnce(); }
    catch (f) {
      if (f.code === 400 || f.code === 401) { saveSession(null); showLogin('Sesi Anda berakhir. Silakan masuk lagi.'); }
      throw f;
    }
    return rawFetch(path, {...opt, token: S.access});
  }
}

const sessionFrom = d => {
  if (!d || !d.access_token) throw new ApiError(400, (d && (d.msg || d.message)) || 'Akun dibuat. Cek email untuk konfirmasi, lalu masuk.');
  return {access: d.access_token, refresh: d.refresh_token, email: (d.user && d.user.email) || ''};
};

/* ------------------------------------------------------------------- login */
function showLogin(msg = '') {
  $('#v-app').hidden = true;
  $('#v-login').hidden = false;
  const m = $('#login-msg');
  m.textContent = msg;
  m.className = 'msg';
}

function showApp() {
  $('#v-login').hidden = true;
  $('#v-app').hidden = false;
  $('#who').textContent = (S && S.email) || '';
  loadAll();
}

$('#b-toggle').addEventListener('click', () => {
  const reg = $('#login-h').textContent === 'Masuk';
  $('#login-h').textContent = reg ? 'Daftar' : 'Masuk';
  $('#b-login').textContent = reg ? 'DAFTAR' : 'MASUK';
  $('#b-toggle').textContent = reg ? 'Sudah punya akun? Masuk' : 'Belum punya akun? Daftar';
  $('#login-msg').textContent = '';
  const pw = $('#f-login [name=password]');
  pw.autocomplete = reg ? 'new-password' : 'current-password';
});

$('#f-login').addEventListener('submit', async ev => {
  ev.preventDefault();
  const f = ev.target;
  const email = f.email.value.trim();
  const pw = f.password.value;
  const registering = $('#login-h').textContent === 'Daftar';
  remember = f.remember.checked;
  const msg = $('#login-msg');
  const btn = $('#b-login');
  btn.disabled = true;
  msg.className = 'msg';
  msg.textContent = registering ? 'Mendaftar…' : 'Masuk…';
  try {
    const path = registering ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password';
    const d = await rawFetch(path, {method: 'POST', body: {email, password: pw}});
    saveSession(sessionFrom(d));
    msg.textContent = '';
    showApp();
  } catch (e) {
    msg.textContent = e.message;
  } finally { btn.disabled = false; }
});

/* Google: PKCE seperti aplikasi Android (tanpa implicit flow, tanpa token di URL) */
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sha256b64(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return b64url(new Uint8Array(d));
}

$('#b-google').addEventListener('click', async () => {
  if (!CFG.url) return;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  sessionStorage.setItem(KEYS.pkce, verifier);
  const challenge = await sha256b64(verifier);
  const redirect = location.origin + location.pathname;
  location.href = CFG.url + '/auth/v1/authorize?provider=google'
    + '&redirect_to=' + encodeURIComponent(redirect)
    + '&code_challenge=' + challenge + '&code_challenge_method=s256';
});

async function handleOAuthReturn() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  const err = q.get('error_description') || q.get('error');
  if (!code && !err) return false;
  history.replaceState(null, '', location.pathname);
  if (err) { showLogin(err); return true; }
  const verifier = sessionStorage.getItem(KEYS.pkce);
  sessionStorage.removeItem(KEYS.pkce);
  if (!verifier) { showLogin('Sesi masuk Google kedaluwarsa. Coba lagi.'); return true; }
  try {
    const d = await rawFetch('/auth/v1/token?grant_type=pkce', {method: 'POST', body: {auth_code: code, code_verifier: verifier}});
    saveSession(sessionFrom(d));
    showApp();
  } catch (e) { showLogin(e.message); }
  return true;
}

/* -------------------------------------------------------------------- data */
const state = {assets: [], people: [], q: '', cat: '', status: '', quick: 'all', limit: 60, auditMode: false, truncated: false};

async function loadAll() {
  progress(true);
  try {
    await Promise.all([loadPeople(), loadAssets()]);
    render();
  } catch (e) {
    if (e.code !== 401) toast(e.message, true);
  } finally { progress(false); }
}

async function loadAssets() {
  state.truncated = false;
  const page = 1000, out = [], max = 20000;
  for (let offset = 0; offset < max; offset += page) {
    const rows = await api(`/rest/v1/assets?select=*&order=created_at.desc,id.desc&limit=${page}&offset=${offset}`);
    out.push(...rows);
    if (rows.length < page) break;
    if (offset + page >= max) state.truncated = true;
  }
  state.assets = out;
}

async function loadPeople() {
  try {
    state.people = await api('/rest/v1/personnel?select=id,name,department,staff_no&active=eq.true&order=name.asc&limit=5000');
  } catch (e) { state.people = []; if (e.code !== 401) throw e; }
}

const personName = id => (state.people.find(p => p.id === id) || {}).name || null;

/* ------------------------------------------------------------------- render */
const progress = on => { $('#progress').hidden = !on; };

function visible() {
  const q = state.q.trim().toLowerCase();
  return state.assets.filter(a => {
    if (state.cat && a.category !== state.cat) return false;
    if (state.status && a.status !== state.status) return false;
    if (state.quick === 'held' && !a.borrowed) return false;
    if (state.quick === 'overdue' && !isOverdue(a)) return false;
    if (state.quick === 'audit' && !needsAudit(a)) return false;
    if (!q) return true;
    return [a.name, a.code, a.location, personName(a.holder_id) || ''].join(' ').toLowerCase().includes(q);
  });
}

function render() {
  const all = state.assets;
  const overdue = all.filter(isOverdue).length;
  const kpis = $('#kpis');
  clear(kpis);
  const kpi = (n, t, cls = '') => el('div', {class: 'kpi ' + cls}, el('b', {text: String(n)}), el('span', {text: t}));
  kpis.append(
    kpi(all.length, 'aset'),
    kpi(all.filter(a => !a.borrowed).length, 'tersedia'),
    kpi(all.filter(a => a.borrowed).length, 'dipegang'),
    kpi(overdue, 'lewat tempo', overdue ? 'warn' : 'gold'),
  );

  const cats = $('#f-cat'), statuses = $('#f-status');
  if (!cats.options.length) {
    cats.append(el('option', {value: '', text: 'Kategori: semua'}));
    CATEGORIES.forEach(c => cats.append(el('option', {value: c, text: label(c)})));
    statuses.append(el('option', {value: '', text: 'Status: semua'}));
    STATUSES.forEach(s => statuses.append(el('option', {value: s, text: s})));
  }

  const chips = $('#chips');
  clear(chips);
  const chip = (id, text, n) => el('button', {
    class: 'chip', role: 'tab', 'aria-selected': String(state.quick === id),
    onclick: () => { state.quick = id; state.limit = 60; render(); },
  }, `${text} ${n}`);
  const counts = {all: all.length, held: all.filter(a => a.borrowed).length, overdue, audit: all.filter(needsAudit).length};
  chips.append(chip('all', 'Semua', counts.all), chip('held', 'Dipegang', counts.held),
    chip('overdue', 'Lewat tempo', counts.overdue), chip('audit', 'Perlu audit', counts.audit));

  const rows = visible();
  const list = $('#list');
  clear(list);
  for (const a of rows.slice(0, state.limit)) list.append(card(a));
  observeThumbs();

  const empty = $('#empty');
  empty.hidden = rows.length > 0;
  if (!rows.length) {
    empty.textContent = state.q.trim() ? `Tidak ada aset yang cocok dengan "${state.q.trim()}".`
      : (state.cat || state.status || state.quick !== 'all') ? 'Tidak ada aset dengan filter ini.'
      : 'Belum ada aset. Tekan tombol + untuk menambah.';
  }
  $('#more-wrap').hidden = rows.length <= state.limit;
  $('#truncated').hidden = !state.truncated;
  $('#scan-label').textContent = state.auditMode ? 'Pindai untuk audit' : 'Pindai / cari kode';
  $('#m-audit').textContent = state.auditMode ? 'Matikan mode audit' : 'Mode audit (pindai = audit)';
}

function card(a) {
  const holder = personName(a.holder_id);
  const late = isOverdue(a);
  const sub = [a.category ? label(a.category) : null, a.status].filter(Boolean).join(' · ');
  return el('button', {class: 'card', onclick: () => openDetail(a.id)},
    a.photo_path ? el('div', {class: 'thumb', 'data-path': a.photo_path}) : null,
    el('div', {class: 'main'},
      el('div', {class: 'name', text: a.name}),
      el('div', {class: 'meta', text: `${a.code} · ${a.location || 'Tanpa lokasi'}`}),
      sub ? el('div', {class: 'sub', text: sub}) : null,
      holder ? el('div', {class: 'held' + (late ? ' late' : ''), text: `Dipegang ${holder}${a.due_date ? ' · s/d ' + fmtDate(a.due_date) : ''}`}) : null,
      late ? el('span', {class: 'pill r', text: 'LEWAT TEMPO'}) : null,
      needsAudit(a) ? el('span', {class: 'pill a', text: 'PERLU AUDIT'}) : null,
    ),
    el('span', {class: 'pill g', text: a.borrowed ? 'Check-in' : 'Check-out'}),
  );
}

/* ----------------------------------------------------- thumbnail (malas) */
/* Foto disimpan di bucket privat, jadi tiap thumbnail butuh fetch bertoken.
   Dimuat hanya saat kartu terlihat, maksimal 3 permintaan bersamaan, hasil
   disimpan di cache agar tidak diunduh ulang saat daftar dirender lagi. */
const thumbCache = new Map();
let thumbBusy = 0;
const thumbQueue = [];
const thumbSeen = new WeakSet();

function paintThumb(box, url) {
  clear(box);
  box.append(el('img', {src: url, alt: ''}));
}
function pumpThumbs() {
  while (thumbBusy < 3 && thumbQueue.length) {
    const box = thumbQueue.shift();
    if (!box.isConnected) continue;
    const path = box.dataset.path;
    const hit = thumbCache.get(path);
    if (hit) { paintThumb(box, hit); continue; }
    thumbBusy++;
    api(`/storage/v1/object/authenticated/${BUCKET}/${path}`, {binary: true})
      .then(bytes => {
        const url = URL.createObjectURL(new Blob([bytes], {type: 'image/jpeg'}));
        thumbCache.set(path, url);
        if (box.isConnected) paintThumb(box, url);
      })
      .catch(() => { /* foto hilang / tanpa izin — kartu tetap tampil */ })
      .finally(() => { thumbBusy--; pumpThumbs(); });
  }
}
const thumbWatch = 'IntersectionObserver' in window ? new IntersectionObserver(es => {
  for (const e of es) if (e.isIntersecting) { thumbWatch.unobserve(e.target); thumbQueue.push(e.target); pumpThumbs(); }
}, {rootMargin: '200px'}) : null;

function observeThumbs() {
  let eager = 6;   // layar pertama langsung dimuat, sisanya menunggu terlihat
  document.querySelectorAll('#list .thumb').forEach(box => {
    if (thumbSeen.has(box)) return;
    thumbSeen.add(box);
    if (eager > 0) { eager--; thumbQueue.push(box); return; }
    if (thumbWatch) thumbWatch.observe(box); else thumbQueue.push(box);
  });
  pumpThumbs();
}
function forgetThumb(path) {
  const url = thumbCache.get(path);
  if (url) { URL.revokeObjectURL(url); thumbCache.delete(path); }
}

/* ------------------------------------------------------------------ dialog */
function dialog(title, body, footer) {
  const d = $('#dlg');
  clear($('#dlg-body'));
  $('#dlg-body').append(
    el('div', {class: 'dlg-h'}, el('h2', {text: title}), el('button', {class: 'btn link', text: '×', 'aria-label': 'Tutup', onclick: () => d.close()})),
    el('div', {class: 'dlg-c'}, body),
  );
  if (footer) $('#dlg-body').append(el('div', {class: 'dlg-f'}, footer));
  if (!d.open) d.showModal();
  return d;
}
const closeDlg = () => { const d = $('#dlg'); if (d.open) d.close(); };

/** Konfirmasi dalam aplikasi (bukan window.confirm: dialog bawaan memblokir halaman). */
function askConfirm(title, text, yesLabel = 'Ya') {
  const d = $('#ask');
  $('#ask-t').textContent = title;
  $('#ask-x').textContent = text;
  $('#ask-yes').textContent = yesLabel;
  if (d.open) d.close();
  d.showModal();
  return new Promise(res => {
    const done = v => { d.close(); res(v); };
    $('#ask-yes').onclick = () => done(true);
    $('#ask-no').onclick = () => done(false);
    d.addEventListener('cancel', ev => { ev.preventDefault(); done(false); }, {once: true});
  });
}

$('#dlg').addEventListener('click', e => { if (e.target.id === 'dlg') closeDlg(); });

function toast(text, isErr = false) {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 3000);
}

const guard = async fn => {
  progress(true);
  try { await fn(); }
  catch (e) { if (e.code !== 401) toast(e.message, true); }
  finally { progress(false); }
};

/* ------------------------------------------------------------- detail aset */
async function openDetail(id) {
  const a = state.assets.find(x => x.id === id);
  if (!a) return;
  const body = el('div', {class: 'stack'});
  dialog(a.name, body);
  const photoBox = el('div');
  body.append(photoBox, el('p', {class: 'note', text: 'Memuat detail…'}));
  loadPhoto(a, photoBox);

  let events = [];
  try { events = await api(`/rest/v1/asset_events?select=action,note,created_at&asset_id=eq.${id}&order=created_at.desc&limit=12`); }
  catch (e) { events = []; }

  const holder = personName(a.holder_id);
  const kv = el('dl', {class: 'kv'});
  const row = (k, v) => { if (v === null || v === undefined || v === '') return; kv.append(el('dt', {text: k}), el('dd', {text: v})); };
  row('Kode', a.code);
  row('Status', a.borrowed ? 'Dipegang' + (holder ? ' ' + holder : '') : 'Tersedia');
  row('Lokasi', a.location);
  if (a.checked_out_at) row('Sejak', fmtWhen(a.checked_out_at));
  if (a.due_date) row('Jatuh tempo', fmtDate(a.due_date) + (isOverdue(a) ? ' (LEWAT)' : ''));
  row('Audit terakhir', a.last_audit_at ? fmtWhen(a.last_audit_at) + (needsAudit(a) ? ' · perlu audit' : '') : 'belum pernah');
  row('Kategori', label(a.category));
  row('Merek', a.brand || 'Tidak diketahui');
  row('Model', a.model || 'Tidak diketahui');
  row('Serial', a.serial || 'Tidak diketahui');
  row('Kondisi', a.condition || 'Tidak diketahui');
  row('Status inventaris', a.status || 'Tidak diketahui');
  row('Vendor', a.vendor);
  if (a.purchase_date) row('Tanggal beli', fmtDate(a.purchase_date));
  if (rupiah(a.purchase_price)) row('Harga beli', rupiah(a.purchase_price));
  if (a.warranty_until) row('Garansi s/d', fmtDate(a.warranty_until) + (a.warranty_until < todayISO() ? ' (BERAKHIR)' : ''));
  row('Catatan', a.notes || 'Tidak diketahui');

  const hist = el('ul', {class: 'hist'});
  if (!events.length) hist.append(el('li', {text: 'Belum ada riwayat.'}));
  events.forEach(e => hist.append(el('li', {},
    el('time', {text: fmtWhen(e.created_at)}), `${e.action}${e.note ? ': ' + e.note : ''}`)));

  const locInput = el('input', {value: a.location || '', maxlength: '200', 'aria-label': 'Lokasi baru'});
  const noteInput = el('input', {maxlength: '120', placeholder: 'Catatan (opsional)', 'aria-label': 'Catatan'});

  clear(body);
  body.append(
    photoBox,
    photoControls(a),
    kv,
    el('div', {class: 'section-t', text: 'Pindahkan lokasi'}),
    el('div', {class: 'grid2'}, locInput, el('button', {class: 'btn outline sm', text: 'Pindahkan', onclick: () => guard(async () => {
      const loc = locInput.value.trim();
      if (!loc || loc === a.location) return;
      await api('/rest/v1/rpc/move_asset', {method: 'POST', body: {p_asset: a.id, p_location: loc}});
      a.location = loc;
      toast('Lokasi diperbarui.');
      closeDlg(); await refresh(); openDetail(a.id);
    })})),
    el('div', {class: 'section-t', text: 'Audit'}),
    el('div', {class: 'grid2'}, noteInput, el('button', {class: 'btn outline sm', text: 'Audit sekarang', onclick: () => doAudit(a, locInput.value, noteInput.value)})),
    el('div', {class: 'section-t', text: 'Riwayat'}),
    hist,
  );

  const footer = el('div', {class: 'dlg-f'},
    el('button', {class: 'btn danger sm', text: 'Hapus', onclick: async () => {
      if (!await askConfirm('Hapus aset?', `${a.name} beserta riwayat dan fotonya akan dihapus permanen.`, 'Hapus')) return;
      guard(async () => {
        await api(`/rest/v1/assets?id=eq.${a.id}`, {method: 'DELETE'});
        toast('Aset dihapus.');
        closeDlg(); await refresh();
      });
    }}),
    el('button', {class: 'btn outline sm', text: 'Ubah inventaris', onclick: () => openEdit(a)}),
    el('span', {class: 'spacer'}),
    el('button', {class: 'btn gold sm', text: a.borrowed ? 'Check-in' : 'Check-out',
      onclick: () => a.borrowed ? openCheckIn(a) : openCheckOut(a)}),
  );
  $('#dlg-body').append(footer);
}

async function doAudit(a, loc, note) {
  await guard(async () => {
    const b = {p_asset: a.id};
    if (loc && loc.trim() && loc.trim() !== a.location) b.p_location = loc.trim();
    if (note && note.trim()) b.p_note = note.trim();
    await api('/rest/v1/rpc/audit_asset', {method: 'POST', body: b});
    toast('Audit tercatat.');
    closeDlg(); await refresh();
  });
}

async function refresh() {
  await guard(async () => { await loadAssets(); render(); });
}

/* -------------------------------------------------------------------- foto */
function photoControls(a) {
  const wrap = el('div', {class: 'seg'});
  const file = el('input', {type: 'file', accept: 'image/*', hidden: true});
  file.addEventListener('change', () => { if (file.files[0]) uploadPhoto(a, file.files[0]); });
  wrap.append(file, el('button', {class: 'btn outline sm', text: a.photo_path ? 'Ganti foto' : 'Tambah foto', onclick: () => file.click()}));
  if (a.photo_path) wrap.append(el('button', {class: 'btn danger sm', text: 'Hapus foto', onclick: () => guard(async () => {
    if (!await askConfirm('Hapus foto?', `Foto ${a.code} akan dihapus dari server.`, 'Hapus')) return;
    await api('/rest/v1/rpc/set_photo', {method: 'POST', body: {p_asset: a.id, p_has_photo: false}});
    await api(`/storage/v1/object/${BUCKET}`, {method: 'DELETE', body: {prefixes: [a.photo_path]}});
    forgetThumb(a.photo_path);
    a.photo_path = null;
    toast('Foto dihapus.');
    closeDlg(); await refresh();
  })}));
  return wrap;
}

async function loadPhoto(a, box) {
  clear(box);
  if (!a.photo_path) { box.append(el('p', {class: 'note', text: 'Belum ada foto.'})); return; }
  try {
    const bytes = await api(`/storage/v1/object/authenticated/${BUCKET}/${a.photo_path}`, {binary: true});
    const url = URL.createObjectURL(new Blob([bytes], {type: 'image/jpeg'}));
    const img = el('img', {class: 'photo', src: url, alt: 'Foto ' + a.name});
    img.addEventListener('load', () => URL.revokeObjectURL(url), {once: true});
    clear(box); box.append(img);
  } catch (e) {
    box.append(el('p', {class: 'note', text: 'Foto tidak dapat dimuat: ' + e.message}));
  }
}

async function uploadPhoto(a, file) {
  await guard(async () => {
    const uid = jwtSub(S.access);
    if (!uid) throw new Error('Sesi tidak memuat identitas pengguna. Masuk ulang.');
    const blob = await shrink(file);
    if (blob.size > 2 * 1024 * 1024) throw new Error('Foto terlalu besar setelah dikompresi (maks 2 MB).');
    const path = `${uid}/${a.id}.jpg`;
    await api(`/storage/v1/object/${BUCKET}/${path}`, {method: 'POST', body: blob,
      headers: {'Content-Type': 'image/jpeg', 'x-upsert': 'true', 'cache-control': 'no-cache'}});
    await api('/rest/v1/rpc/set_photo', {method: 'POST', body: {p_asset: a.id, p_has_photo: true}});
    forgetThumb(path);
    a.photo_path = path;
    toast('Foto tersimpan.');
    closeDlg(); await refresh(); openDetail(a.id);
  });
}

/** Kompres di perangkat (sisi terpanjang 1400 px, JPEG q0.82) — server membatasi 2 MB. */
function shrink(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const max = 1400;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b ? res(b) : rej(new Error('Gagal mengompresi foto.')), 'image/jpeg', 0.82);
    };
    img.onerror = () => rej(new Error('Berkas bukan gambar yang bisa dibaca.'));
    img.src = URL.createObjectURL(file);
  });
}

/* -------------------------------------------------------- check-out / in */
function openCheckOut(a) {
  const q = el('input', {placeholder: 'Cari / nama pemegang', maxlength: '120', autocomplete: 'off'});
  const list = el('div', {class: 'pick'});
  const due = el('input', {type: 'date', min: todayISO()});
  const note = el('input', {maxlength: '120', placeholder: 'Catatan (opsional)'});
  let chosen = null;

  const paint = () => {
    clear(list);
    const needle = q.value.trim().toLowerCase();
    const found = state.people.filter(p => !needle || p.name.toLowerCase().includes(needle)).slice(0, 40);
    found.forEach(p => list.append(el('button', {type: 'button', 'aria-pressed': String(chosen && chosen.id === p.id),
      onclick: () => { chosen = p; paint(); }}, `${p.name}${p.department ? ' · ' + p.department : ''}`)));
    if (!found.length) list.append(el('p', {class: 'note', text: needle ? 'Tidak ada personel yang cocok.' : 'Belum ada personel. Tambahkan di menu Personel.'}));
  };
  q.addEventListener('input', paint);
  paint();

  const body = el('div', {class: 'stack'},
    el('p', {class: 'note', text: `${a.name} · ${a.code}`}),
    q, list,
    el('label', {text: 'Jatuh tempo'}, due),
    el('label', {text: 'Catatan'}, note),
  );
  const d = dialog('Check-out ' + a.code, body, el('div', {class: 'dlg-f'},
    el('button', {class: 'btn link', text: 'Batal', onclick: () => d.close()}),
    el('button', {class: 'btn gold', text: 'Check-out', onclick: () => {
      if (!chosen) return toast('Pilih pemegang aset lebih dulu.', true);
      guard(async () => {
        const b = {p_asset: a.id, p_person: chosen.id};
        if (due.value) b.p_due = due.value;
        if (note.value.trim()) b.p_note = note.value.trim();
        await api('/rest/v1/rpc/check_out', {method: 'POST', body: b});
        toast(`Check-out ke ${chosen.name}.`);
        d.close(); await refresh();
      });
    }}),
  ));
}

function openCheckIn(a) {
  const holder = personName(a.holder_id) || 'tidak diketahui';
  const cond = el('select', {}, el('option', {value: '', text: 'Kondisi: tidak diubah'}), ...CONDITIONS.map(c => el('option', {value: c, text: c})));
  const note = el('input', {maxlength: '120', placeholder: 'Catatan (opsional)'});
  const body = el('div', {class: 'stack'},
    el('p', {class: 'note', text: `${a.name}\nDipegang: ${holder}`}), cond, note);
  const d = dialog('Check-in ' + a.code, body, el('div', {class: 'dlg-f'},
    el('button', {class: 'btn link', text: 'Batal', onclick: () => d.close()}),
    el('button', {class: 'btn gold', text: 'Check-in', onclick: () => guard(async () => {
      const b = {p_asset: a.id};
      if (cond.value) b.p_condition = cond.value;
      if (note.value.trim()) b.p_note = note.value.trim();
      await api('/rest/v1/rpc/check_in', {method: 'POST', body: b});
      toast('Check-in tercatat.');
      d.close(); await refresh();
    })}),
  ));
}

/* ------------------------------------------------------------------ tambah */
function field(labelText, input) { return el('label', {text: labelText}, input); }
function textInput(value = '', max = 200, type = 'text') { return el('input', {type, value, maxlength: String(max)}); }
function selectOf(options, value = '', none = 'Tidak diisi') {
  const s = el('select', {});
  s.append(el('option', {value: '', text: none}));
  options.forEach(o => s.append(el('option', {value: o.value, text: o.text, selected: o.value === value})));
  return s;
}

function openAdd() {
  const name = textInput('', 200), code = textInput('', 128), loc = textInput('', 200);
  const cat = selectOf(CATEGORIES.map(c => ({value: c, text: label(c)})));
  const status = selectOf(STATUSES.map(s => ({value: s, text: s})));
  const cond = selectOf(CONDITIONS.map(c => ({value: c, text: c})));
  const brand = textInput('', 64), model = textInput('', 120), serial = textInput('', 128);
  const vendor = textInput('', 128), buy = el('input', {type: 'date', max: todayISO()}), price = textInput('', 12);
  const notes = el('textarea', {rows: '2', maxlength: '500'});
  const msg = el('p', {class: 'msg'});
  const genCode = () => 'AST-' + Array.from(crypto.getRandomValues(new Uint8Array(5))).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  code.value = genCode();
  code.readOnly = false;

  const body = el('div', {class: 'stack'},
    field('Nama aset (wajib)', name),
    field('Kode aset', code),
    field('Lokasi', loc),
    el('div', {class: 'grid2'}, field('Kategori', cat), field('Status', status)),
    el('div', {class: 'grid2'}, field('Kondisi', cond), field('Merek', brand)),
    el('div', {class: 'grid2'}, field('Model', model), field('Serial', serial)),
    el('div', {class: 'grid2'}, field('Vendor', vendor), field('Tanggal beli', buy)),
    field('Harga beli (angka rupiah)', price),
    field('Catatan', notes), msg,
  );
  const d = dialog('Tambah aset', body, el('div', {class: 'dlg-f'},
    el('button', {class: 'btn link', text: 'Batal', onclick: () => d.close()}),
    el('button', {class: 'btn primary', text: 'Simpan', onclick: () => guard(async () => {
      if (!name.value.trim()) { msg.textContent = 'Nama aset wajib diisi.'; return; }
      msg.textContent = '';
      const b = {name: name.value.trim()};
      if (code.value.trim()) b.code = code.value.trim();
      if (loc.value.trim()) b.location = loc.value.trim();
      for (const [k, n] of [['category', cat], ['status', status], ['condition', cond], ['brand', brand],
        ['model', model], ['serial', serial], ['vendor', vendor], ['notes', notes]]) {
        if (n.value && n.value.trim()) b[k] = n.value.trim();
      }
      if (buy.value) b.purchase_date = buy.value;
      if (price.value.trim()) {
        const digits = price.value.replace(/[^\d]/g, '');
        if (!digits || digits.length > 12) { msg.textContent = 'Harga beli harus angka rupiah, mis. 1500000.'; return; }
        b.purchase_price = digits;
      }
      await api('/rest/v1/assets', {method: 'POST', body: b, headers: {Prefer: 'return=representation'}});
      toast('Aset ditambahkan.');
      d.close(); await refresh();
    })}),
  ));
}

function openEdit(a) {
  const name = textInput(a.name, 200);
  const cat = selectOf(CATEGORIES.map(c => ({value: c, text: label(c)})), a.category || '');
  const status = selectOf(STATUSES.map(s => ({value: s, text: s})), a.status || '');
  const cond = selectOf(CONDITIONS.map(c => ({value: c, text: c})), a.condition || '');
  const brand = textInput(a.brand || '', 64), model = textInput(a.model || '', 120), serial = textInput(a.serial || '', 128);
  const vendor = textInput(a.vendor || '', 128), buy = el('input', {type: 'date', max: todayISO(), value: a.purchase_date || ''});
  const price = textInput(a.purchase_price ? String(a.purchase_price).replace(/\.00$/, '') : '', 12);
  const notes = el('textarea', {rows: '2', maxlength: '500'}, a.notes || '');
  const msg = el('p', {class: 'msg'});

  const body = el('div', {class: 'stack'},
    el('p', {class: 'note', text: 'Kolom yang dibiarkan kosong tidak diubah. Untuk menghapus nilai, isi "-" atau kosongkan lalu simpan.'}),
    field('Nama aset', name),
    el('div', {class: 'grid2'}, field('Kategori', cat), field('Status', status)),
    el('div', {class: 'grid2'}, field('Kondisi', cond), field('Merek', brand)),
    el('div', {class: 'grid2'}, field('Model', model), field('Serial', serial)),
    el('div', {class: 'grid2'}, field('Vendor', vendor), field('Tanggal beli', buy)),
    field('Harga beli (angka rupiah)', price),
    field('Catatan', notes), msg,
  );
  const d = dialog('Ubah ' + a.code, body, el('div', {class: 'dlg-f'},
    el('button', {class: 'btn link', text: 'Batal', onclick: () => d.close()}),
    el('button', {class: 'btn primary', text: 'Simpan', onclick: () => guard(async () => {
      msg.textContent = '';
      const b = {};
      if (name.value.trim() && name.value.trim() !== a.name) b.name = name.value.trim();
      for (const [k, n, old] of [['category', cat, a.category], ['status', status, a.status],
        ['condition', cond, a.condition], ['brand', brand, a.brand], ['model', model, a.model],
        ['serial', serial, a.serial], ['vendor', vendor, a.vendor], ['notes', notes, a.notes]]) {
        const v = (n.value || '').trim();
        if (v && v !== (old || '')) b[k] = v;
      }
      if (buy.value && buy.value !== (a.purchase_date || '')) b.purchase_date = buy.value;
      if (price.value.trim()) {
        const digits = price.value.replace(/[^\d]/g, '');
        if (!digits) { msg.textContent = 'Harga beli harus angka rupiah.'; return; }
        if (digits !== String(a.purchase_price || '').replace(/\.00$/, '')) b.purchase_price = digits;
      }
      if (!Object.keys(b).length) { msg.textContent = 'Tidak ada perubahan.'; return; }
      await api(`/rest/v1/assets?id=eq.${a.id}`, {method: 'PATCH', body: b, headers: {Prefer: 'return=representation'}});
      toast('Perubahan tersimpan.');
      d.close(); await refresh(); openDetail(a.id);
    })}),
  ));
}

/* ---------------------------------------------------------------- personel */
async function openPeople() {
  await guard(async () => { await loadPeople(); });
  const body = el('div', {class: 'stack'});
  const draw = () => {
    clear(body);
    body.append(el('p', {class: 'note', text: 'Hanya nama, departemen, dan nomor staf. Email/telepon sengaja tidak disimpan.'}));
    const ul = el('ul', {class: 'people'});
    if (!state.people.length) ul.append(el('li', {text: 'Belum ada personel.'}));
    state.people.forEach(p => ul.append(el('li', {},
      el('span', {text: p.name + (p.department ? ' · ' + p.department : '') + (p.staff_no ? ' · ' + p.staff_no : '')}),
      el('span', {class: 'pill', text: String(state.assets.filter(a => a.holder_id === p.id).length) + ' aset'}))));
    const name = textInput('', 120), dept = textInput('', 80), no = textInput('', 40);
    body.append(ul,
      el('div', {class: 'section-t', text: 'Tambah personel'}),
      field('Nama', name), el('div', {class: 'grid2'}, field('Departemen (opsional)', dept), field('No. staf (opsional)', no)),
      el('button', {class: 'btn outline sm', text: 'Tambah', onclick: () => guard(async () => {
        if (!name.value.trim()) return toast('Nama personel wajib diisi.', true);
        const b = {name: name.value.trim()};
        if (dept.value.trim()) b.department = dept.value.trim();
        if (no.value.trim()) b.staff_no = no.value.trim();
        await api('/rest/v1/personnel', {method: 'POST', body: b, headers: {Prefer: 'return=representation'}});
        await loadPeople(); draw(); render();
        toast('Personel ditambahkan.');
      })}));
  };
  draw();
  const d = dialog('Personel', body, el('div', {class: 'dlg-f'}, el('button', {class: 'btn link', text: 'Tutup', onclick: () => d.close()})));
}

/* ----------------------------------------------------------------- menu/CSV */
$('#b-menu').addEventListener('click', e => {
  e.stopPropagation();
  const m = $('#menu');
  m.hidden = !m.hidden;
});
document.addEventListener('click', () => { $('#menu').hidden = true; });
$('#menu').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  $('#menu').hidden = true;
  const act = b.dataset.act;
  if (act === 'people') openPeople();
  if (act === 'csv') exportCsv();
  if (act === 'audit-mode') { state.auditMode = !state.auditMode; render(); }
  if (act === 'logout') {
    guard(async () => { try { await api('/auth/v1/logout', {method: 'POST'}); } catch {} });
    saveSession(null);
    showLogin('Anda sudah keluar.');
  }
});

function exportCsv() {
  const rows = visible();
  const cols = ['code', 'name', 'location', 'category', 'status', 'condition', 'brand', 'model', 'serial',
    'borrowed', 'holder', 'due_date', 'last_audit_at', 'vendor', 'purchase_date', 'purchase_price', 'warranty_until', 'notes'];
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  for (const a of rows) {
    const rec = Object.assign({}, a, {holder: personName(a.holder_id) || ''});
    lines.push(cols.map(c => esc(rec[c])).join(','));
  }
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], {type: 'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = el('a', {href: url, download: `inventaris-${todayISO()}.csv`});
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`${rows.length} baris diunduh.`);
}

/* ------------------------------------------------------------------- pindai */
$('#b-scan').addEventListener('click', async () => {
  if ('BarcodeDetector' in window) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: 'environment'}});
    } catch {
      return findByCode();
    }
    const video = el('video', {class: 'scan', autoplay: true, playsinline: true});
    video.srcObject = stream;
    const body = el('div', {class: 'stack'}, video,
      el('p', {class: 'note', text: 'Arahkan kamera ke barcode aset (Code 128 / QR).'}),
      el('button', {class: 'btn outline sm', text: 'Ketik kode manual', onclick: () => { stop(); d.close(); findByCode(); }}));
    const stop = () => stream.getTracks().forEach(t => t.stop());
    const d = dialog('Pindai barcode', body, el('div', {class: 'dlg-f'},
      el('button', {class: 'btn link', text: 'Tutup', onclick: () => { stop(); d.close(); }})));
    d.addEventListener('close', stop, {once: true});
    try {
      const det = new BarcodeDetector({formats: ['code_128', 'qr_code', 'code_39', 'ean_13']});
      const tick = async () => {
        if (!d.open) return;
        try {
          const found = await det.detect(video);
          if (found.length) {
            stop(); d.close();
            const v = found[0].rawValue.trim();
            if (state.auditMode) return auditByCode(v);
            return byCode(v);
          }
        } catch {}
        requestAnimationFrame(tick);
      };
      video.addEventListener('loadeddata', tick, {once: true});
    } catch { /* detektor gagal dibuat: pakai input manual */ }
  } else {
    findByCode();
  }
});

function findByCode() {
  const input = el('input', {placeholder: 'Kode aset, mis. AST-001', maxlength: '128', autocomplete: 'off'});
  const body = el('div', {class: 'stack'}, input,
    el('p', {class: 'note', text: 'Browser ini tidak mendukung pemindaian kamera. Ketik kode aset atau sebagian nama.'}));
  const d = dialog(state.auditMode ? 'Audit — cari kode' : 'Cari kode aset', body, el('div', {class: 'dlg-f'},
    el('button', {class: 'btn link', text: 'Batal', onclick: () => d.close()}),
    el('button', {class: 'btn gold', text: 'Cari', onclick: () => {
      const v = input.value.trim();
      if (!v) return;
      d.close();
      state.auditMode ? auditByCode(v) : byCode(v);
    }})));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('.dlg-f .btn.gold').click(); } });
  setTimeout(() => input.focus(), 50);
}

async function byCode(code) {
  await guard(async () => {
    const rows = await api('/rest/v1/assets?select=*&code=eq.' + encodeURIComponent(code));
    if (!rows.length) {
      const hits = state.assets.filter(a => a.code.toLowerCase().includes(code.toLowerCase()));
      if (hits.length === 1) return openDetail(hits[0].id);
      return toast(`Kode "${code}" tidak ditemukan.`, true);
    }
    await refresh();
    openDetail(rows[0].id);
  });
}

async function auditByCode(code) {
  await guard(async () => {
    const rows = await api('/rest/v1/assets?select=*&code=eq.' + encodeURIComponent(code));
    if (!rows.length) return toast(`Kode "${code}" tidak ditemukan.`, true);
    const a = rows[0];
    await api('/rest/v1/rpc/audit_asset', {method: 'POST', body: {p_asset: a.id}});
    toast(`Audit tercatat: ${a.name}`);
    await refresh();
  });
}

/* ------------------------------------------------------------------ pasang */
$('#b-refresh').addEventListener('click', () => refresh());
$('#b-add').addEventListener('click', () => openAdd());
$('#b-more').addEventListener('click', () => { state.limit += 60; render(); });
$('#q').addEventListener('input', e => { state.q = e.target.value; state.limit = 60; render(); });
$('#f-cat').addEventListener('change', e => { state.cat = e.target.value; state.limit = 60; render(); });
$('#f-status').addEventListener('change', e => { state.status = e.target.value; state.limit = 60; render(); });
window.addEventListener('storage', e => { if (e.key === KEYS.session) location.reload(); });

(async function boot() {
  if (!CFG.url || !CFG.key) {
    $('#v-login').hidden = false;
    showLogin('Konfigurasi server belum diisi (config.js).');
    return;
  }
  const handled = await handleOAuthReturn();
  if (handled) return;
  S = loadSession();
  if (!S) return showLogin();
  try {
    await rawFetch('/rest/v1/personnel?select=id&limit=1', {token: S.access});
    showApp();
  } catch (e) {
    if (e.code === 401) {
      try { await refreshOnce(); showApp(); }
      catch { saveSession(null); showLogin('Sesi Anda berakhir. Silakan masuk lagi.'); }
    } else showLogin(e.message);
  }
})();
