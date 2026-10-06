/* Zona Supply & Demand — dashboard lihat-saja. Tidak ada beli/jual di sini; itu tetap di Telegram. */

// ---------------------------------------------------------------- konstanta

// Dua kecepatan refresh, disengaja. Satu candle hanya berubah sekali per bar dan API candle
// membatasi ~30 request/menit, jadi menariknya tiap detik akan menghabiskan anggaran untuk
// menggambar ulang chart yang identik. Harga memang bergerak terus dan cache-nya hitungan detik.
const PRICE_POLL_MS = 5000;

// Refresh candle mengikuti timeframe: sekitar setengah bar, minimal 30 detik supaya chart 1m tetap
// hidup, maksimal 5 menit supaya chart 1 jam berhenti meminta bar yang mustahil berubah.
function candlePollMs(tfMinutes) {
  return Math.min(300000, Math.max(30000, (tfMinutes * 60000) / 2));
}

// GeckoTerminal melayani bucket (minute/hour/day) plus aggregate dari daftar tetap, jadi 10m dan 30m
// tidak ada di hulu. Backend men-snap permintaan lain ke yang terdekat dan melaporkan mana yang
// benar-benar dipakai.
const TIMEFRAMES = [
  { m: 1, label: '1m' },
  { m: 5, label: '5m' },
  { m: 15, label: '15m' },
  { m: 60, label: '1j' },
  { m: 240, label: '4j' },
  { m: 720, label: '12j' },
  { m: 1440, label: '1h' },
];

const COLORS = { buy: '#34d399', sell: '#f87171', warn: '#fbbf24' };

// URL adalah sumber kebenaran untuk apa yang sedang dilihat, localStorage hanya cadangan.
//
// Refresh, bookmark, dan tombol back semuanya harus memulihkan coin yang sama. Menyimpannya hanya di
// localStorage berarti satu tab tidak bisa dibagikan dan dua tab saling menimpa pilihan masing-masing.
const params = new URLSearchParams(location.search);

let tf = Number(params.get('tf') || localStorage.getItem('zoneTf') || 5);

// Timeframe ZONA, terpisah dari timeframe chart.
//
// Dulu keduanya satu, dan mengganti chart diam-diam mengganti riwayat yang dianalisis: batas candle
// 300 berlaku di semua timeframe, jadi 1m mencakup 5 jam sementara 1j mencakup 12,5 hari. Level 5
// jam terakhir memang bukan level 12 hari terakhir, jadi pitanya melompat tiap ganti timeframe —
// yang terbaca seperti angkanya berubah sendiri.
//
// Default dikunci di 1 jam: tarik level di timeframe besar, cari entry di timeframe kecil.
let ztf = Number(params.get('ztf') || localStorage.getItem('zoneZtf') || 60);
let tab = params.get('tab') || localStorage.getItem('zoneTab') || 'all';
let watchlistCount = null;

/** Menulis ulang query tanpa menambah entri history, supaya tombol back tetap keluar halaman. */
function syncUrl() {
  const next = new URLSearchParams();
  if (selected) next.set('mint', selected);
  next.set('tf', String(tf));
  next.set('ztf', String(ztf));
  next.set('tab', tab);
  history.replaceState(null, '', location.pathname + '?' + next.toString());
}
let selected = null;
let priceTimer = null;
let candleTimer = null;

// ---------------------------------------------------------------- util

const $ = (id) => document.getElementById(id);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const fmtPrice = (n) => (n == null ? '—' : n >= 1 ? n.toFixed(4) : Number(n).toPrecision(4));
const fmtPct = (n) => (n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%');
const pctClass = (n) => (n == null ? 'muted' : n > 0 ? 'up' : n < 0 ? 'down' : 'muted');

/** Ringkas supaya $1.234.567 tidak memaksa kartu statistik melebar. */
function fmtUsd(n) {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n).toLocaleString('id-ID');
}

const fmtInt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('id-ID'));

// Semua waktu memakai zona waktu browser, bukan UTC bawaan lightweight-charts dan bukan WIB yang
// di-hardcode: mengikuti jam di mesin pembaca selalu benar, termasuk kalau dia pindah ke WITA/WIT.
const timeOpts = { hour: '2-digit', minute: '2-digit', hour12: false };
const localTime = (ts) => new Date(ts * 1000).toLocaleTimeString('id-ID', timeOpts);
const localDate = (ts) => new Date(ts * 1000).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });

const keyEl = $('key');
const mintEl = $('mint');
const statusEl = $('status');

keyEl.value = localStorage.getItem('zoneKey') || '';
keyEl.addEventListener('change', () => localStorage.setItem('zoneKey', keyEl.value));

async function api(path) {
  const res = await fetch('/dashboard/api' + path, { headers: { 'x-api-key': keyEl.value } });
  if (res.status === 401) throw new Error('API key salah atau kosong');
  if (res.status === 404) throw new Error('dashboard dimatikan (ENABLE_DASHBOARD=false)');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ---------------------------------------------------------------- chart

const chart = LightweightCharts.createChart($('chart'), {
  layout: { background: { color: 'transparent' }, textColor: '#7d8da6', fontFamily: 'ui-monospace, monospace' },
  grid: { vertLines: { color: 'rgba(35,45,59,.5)' }, horzLines: { color: 'rgba(35,45,59,.5)' } },
  rightPriceScale: { borderColor: '#232d3b' },
  timeScale: {
    borderColor: '#232d3b',
    timeVisible: true,
    // TickMarkType: 0 Year, 1 Month, 2 DayOfMonth, 3 Time, 4 TimeWithSeconds.
    tickMarkFormatter: (ts, type) => {
      if (type === 0) return new Date(ts * 1000).getFullYear();
      if (type <= 2) return localDate(ts);
      return localTime(ts);
    },
  },
  crosshair: { mode: 0 },
  localization: {
    priceFormatter: (p) => '$' + fmtPrice(p),
    timeFormatter: (ts) => localDate(ts) + ' ' + localTime(ts),
  },
});

const series = chart.addCandlestickSeries({
  upColor: COLORS.buy,
  downColor: COLORS.sell,
  borderUpColor: COLORS.buy,
  borderDownColor: COLORS.sell,
  wickUpColor: COLORS.buy,
  wickDownColor: COLORS.sell,
});

// Sumbu harga harus mengikuti besaran harganya.
//
// Default lightweight-charts adalah 2 desimal — benar untuk saham, salah total di sini: memecoin di
// $0,000126 membuat SETIAP label sumbu jadi "0.00", dan grafik yang sumbunya nol semua terlihat
// seperti bug chart padahal datanya benar. `minMove` dipatok ke pangkat sepuluh empat tingkat di
// bawah harga, jadi selalu tersisa sekitar lima angka berarti berapa pun besarannya.
function priceFormatFor(price) {
  const safe = Number.isFinite(price) && price > 0 ? price : 1;
  const exponent = Math.floor(Math.log10(safe));
  return { type: 'custom', formatter: (p) => '$' + fmtPrice(p), minMove: Math.pow(10, exponent - 4) };
}

new ResizeObserver(() => {
  chart.applyOptions({ width: $('chart').clientWidth });
  renderBands();
}).observe($('chart'));

// Menggeser atau zoom mengubah skala harga yang auto-fit, jadi pita harus digambar ulang bersamanya.
chart.timeScale().subscribeVisibleLogicalRangeChange(() => renderBands());

// ---------------------------------------------------------------- pita zona sebagai area

let currentZones = null;

/**
 * Zona digambar sebagai AREA, bukan dua garis.
 *
 * Zona supply adalah RENTANG harga tempat penjual muncul, dan dua garis tipis memaksa pembaca
 * menyusun ulang sendiri pita yang sebenarnya sudah dihitung indikatornya. Overlay DOM dipakai
 * karena lightweight-charts 4.1 tidak punya primitif kotak bawaan, dan `priceToCoordinate` sudah
 * cukup untuk memetakan harga ke piksel.
 */
function renderBands() {
  const box = $('bands');
  if (!currentZones) { box.innerHTML = ''; return; }

  const chartEl = $('chart');
  const axisWidth = chart.priceScale('right').width();
  const timeHeight = chart.timeScale().height();
  box.style.width = Math.max(0, chartEl.clientWidth - axisWidth) + 'px';
  box.style.height = Math.max(0, chartEl.clientHeight - timeHeight) + 'px';

  const html = [];
  for (const z of currentZones.list) {
    const top = series.priceToCoordinate(z.high);
    const bottom = series.priceToCoordinate(z.low);
    // Di luar rentang terlihat, koordinatnya null. Pita itu memang tidak ada di layar.
    if (top == null || bottom == null) continue;

    const cls = z.mark === 'inside' ? 'inside' : z.type === 'SUPPORT' ? 'buy' : 'sell';
    const label = z.mark === 'inside' ? 'DI DALAM' : z.type === 'SUPPORT' ? 'BELI' : 'JUAL';
    const height = Math.max(2, bottom - top);
    const faded = z.mark === 'far' ? ' far' : '';
    html.push(
      '<div class="band ' + cls + faded + '" style="top:' + top + 'px;height:' + height + 'px">' +
        (height >= 16 && z.mark !== 'far'
          ? '<span class="band-label">' + label + ' ' + esc(z.strength.toLowerCase()) + '</span>'
          : '') +
      '</div>',
    );
  }
  box.innerHTML = html.join('');
}

// ---------------------------------------------------------------- bar hidup

// Bar yang sedang terbentuk, supaya candle terakhir ikut bergerak di antara dua pengambilan candle.
let lastBar = null;

/**
 * Menggerakkan candle terakhir dari harga live.
 *
 * Tanpa ini chart hanya berubah saat `loadZones` berjalan — 2,5 menit di timeframe 5m, dan cache
 * candle 60 detik membuat poll di dalamnya mengembalikan data yang sama persis. Jadi harga di teks
 * berdetak sementara lilinnya diam, dan halamannya terasa mati padahal datanya benar.
 *
 * Batas sebenarnya ada di hulu: feed DexScreener hanya memperbarui angkanya sekitar sekali tiap 26
 * detik, jadi lilinnya melangkah, bukan meluncur.
 */
function updateLiveBar(price) {
  if (!lastBar || !Number.isFinite(price) || price <= 0) return;

  const barSeconds = tf * 60;
  const slot = Math.floor(Date.now() / 1000 / barSeconds) * barSeconds;

  if (slot > lastBar.time) {
    lastBar = { time: slot, open: price, high: price, low: price, close: price };
  } else {
    lastBar.high = Math.max(lastBar.high, price);
    lastBar.low = Math.min(lastBar.low, price);
    lastBar.close = price;
  }
  series.update(lastBar);
}

// ---------------------------------------------------------------- daftar coin

/**
 * Menyalin ke clipboard dengan jalur cadangan.
 *
 * `navigator.clipboard` hanya ada di konteks aman, dan dashboard ini sering dibuka lewat `http://`
 * di IP LAN, bukan localhost. Tanpa cadangan, tombolnya diam saja di situ.
 */
async function copyText(text, el) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
  }
  if (el) {
    const before = el.textContent;
    el.textContent = ok ? 'tersalin' : 'gagal';
    el.classList.toggle('copied', ok);
    setTimeout(() => {
      el.textContent = before;
      el.classList.remove('copied');
    }, 1200);
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  e.stopPropagation();
  copyText(btn.dataset.copy, btn);
});

function iconHtml(url, symbol, cls) {
  if (!url) return '';
  return (
    '<img class="icon ' + (cls || '') + '" src="' + esc(url) + '" alt="" loading="lazy" ' +
    'onerror="this.style.visibility=\'hidden\'" />'
  );
}

async function loadCoins(mint) {
  statusEl.textContent = 'memuat daftar…';
  try {
    const query = mint
      ? '?mint=' + encodeURIComponent(mint)
      : '?source=' + encodeURIComponent(tab);
    const data = await api('/coins' + query);
    if (typeof data.watchlistCount === 'number') watchlistCount = data.watchlistCount;
    renderTabs();

    const box = $('coins');
    box.innerHTML = '';
    if (!data.coins.length) {
      // Watchlist dengan baris tapi tanpa pair yang bisa digambar bukan watchlist kosong, dan
      // mengatakan "tidak ada coin" di situ akan menyembunyikan apa yang sebenarnya diawasi bot.
      box.innerHTML =
        tab === 'bot' && watchlistCount
          ? '<div class="muted" style="font-size:13px">' + watchlistCount +
            ' coin diawasi bot, tapi DexScreener belum punya pair-nya — belum bisa dibuat chart.</div>'
          : '<div class="muted" style="font-size:13px">tidak ada coin. tempel mint di atas.</div>';
    }
    for (const c of data.coins) {
      const el = document.createElement('div');
      el.className = 'coin' + (selected === c.mint ? ' active' : '');
      el.innerHTML =
        '<div class="coin-top">' +
          iconHtml(c.imageUrl, c.symbol) +
          '<span class="coin-sym">' + esc(c.symbol || '?') + '</span>' +
          (c.metaLabel ? '<span class="tag">' + esc(c.metaLabel) + '</span>' : '') +
          '<button class="copy" data-copy="' + esc(c.mint) + '" title="salin alamat mint">salin</button>' +
        '</div>' +
        '<div class="coin-price">$' + fmtPrice(c.priceUsd) +
          ' <span class="' + pctClass(c.priceChange1h) + '">' + fmtPct(c.priceChange1h) + '</span></div>' +
        '<small>' + fmtUsd(c.liquidityUsd) + ' · ' +
          (c.ageHours != null ? c.ageHours.toFixed(0) + 'j' : '?') + ' · ' + esc(c.source) + '</small>' +
        (c.botReason
          ? '<span class="coin-reason" title="' + esc(c.botReason) + '">⚑ ' + esc(c.botReason) +
            (c.checkCount != null ? ' · cek ' + c.checkCount + 'x' : '') + '</span>'
          : '');
      el.onclick = () => select(c.mint);
      box.appendChild(el);
    }
    // Daftar pendek tanpa penjelasan terbaca sebagai "tidak ada yang terjadi", padahal yang terjadi
    // adalah belasan kandidat diperiksa lalu ditolak.
    const f = data.filter;
    if (f && (f.tooNew || f.rejected || f.unchecked)) {
      const bits = [];
      if (f.tooNew) bits.push(f.tooNew + ' terlalu baru (<' + f.minAgeHours + 'j)');
      if (f.rejected) bits.push(f.rejected + ' ditolak RugCheck');
      if (f.unchecked) bits.push(f.unchecked + ' tidak bisa dicek');
      $('filterinfo').textContent = 'Disaring: ' + bits.join(' · ');
    } else {
      $('filterinfo').textContent = '';
    }

    statusEl.textContent = data.coins.length + ' coin';
  } catch (e) {
    statusEl.textContent = e.message;
  }
}

// ---------------------------------------------------------------- timeframe

const TABS = [
  { id: 'all', label: 'Semua' },
  { id: 'bot', label: 'Watchlist' },
  { id: 'feed', label: 'Feed' },
];

function renderTabs() {
  $('tabs').innerHTML = TABS.map((t) => {
    const count = t.id === 'bot' && watchlistCount != null
      ? '<span class="count">' + watchlistCount + '</span>'
      : '';
    return '<button class="tab' + (t.id === tab ? ' on' : '') + '" data-t="' + t.id + '">' +
      t.label + count + '</button>';
  }).join('');
  for (const b of $('tabs').querySelectorAll('.tab')) {
    b.onclick = () => {
      if (b.dataset.t === tab) return;
      tab = b.dataset.t;
      localStorage.setItem('zoneTab', tab);
      syncUrl();
      renderTabs();
      loadCoins();
    };
  }
}

function renderZoneTf() {
  const opts = TIMEFRAMES.map(
    (t) => '<option value="' + t.m + '"' + (t.m === ztf ? ' selected' : '') + '>' + t.label + '</option>',
  ).join('');
  $('ztfbar').innerHTML =
    '<label class="ztf">zona dari <select id="ztfsel">' + opts + '</select></label>';
  $('ztfsel').onchange = (e) => {
    ztf = Number(e.target.value);
    localStorage.setItem('zoneZtf', ztf);
    syncUrl();
    if (selected) restartPolling();
  };
}

function renderTimeframes() {
  $('tfbar').innerHTML = TIMEFRAMES.map(
    (t) => '<button class="tf' + (t.m === tf ? ' on' : '') + '" data-m="' + t.m + '">' + t.label + '</button>',
  ).join('');
  for (const b of $('tfbar').querySelectorAll('.tf')) {
    b.onclick = () => {
      tf = Number(b.dataset.m);
      localStorage.setItem('zoneTf', tf);
      syncUrl();
      renderTimeframes();
      if (selected) restartPolling();
    };
  }
}

function restartPolling() {
  clearInterval(priceTimer);
  clearInterval(candleTimer);
  lastBar = null;
  freshSelection = true;
  loadZones();
  loadPrice();
  loadRisk();
  candleTimer = setInterval(loadZones, candlePollMs(tf));
  priceTimer = setInterval(loadPrice, PRICE_POLL_MS);
}

function select(mint) {
  selected = mint;
  syncUrl();
  for (const el of document.querySelectorAll('.coin')) el.classList.remove('active');
  restartPolling();
  loadCoins();
}

// ---------------------------------------------------------------- zona

let lastZonesPayload = null;
// Hanya pemilihan coin baru yang boleh memindahkan viewport; poll berikutnya menghormati
// geseran pembaca, karena menarik chart kembali tiap menit membuatnya mustahil dibaca.
let freshSelection = true;

async function loadZones() {
  if (!selected) return;
  try {
    const d = await api('/zones/' + selected + '?tf=' + tf + '&ztf=' + ztf);
    $('warn').textContent = '';

    if (d.problem) {
      const why = {
        no_pool: 'tidak ada pool di DexScreener',
        no_candles: 'tidak ada candle dari sumber data',
        rate_limited: 'sumber candle sedang membatasi permintaan — coba lagi sebentar',
        scale_mismatch: 'skala harga candle tidak cocok dengan harga pasar — data dibuang',
      }[d.problem] || d.problem;
      $('warn').textContent = 'Zona tidak dihitung: ' + why;
      series.setData([]);
      currentZones = null;
      lastBar = null;
      renderBands();
      $('zones').innerHTML = '';
      $('verdict').style.display = 'none';
      renderHead(d, null);
      return;
    }

    lastZonesPayload = d;

    // Dipasang sebelum data, supaya sumbu tidak pernah sempat menggambar satu frame penuh nol.
    series.applyOptions({ priceFormat: priceFormatFor(d.price) });

    const bars = d.candles.map((c) => ({
      time: c.at, open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    series.setData(bars);
    lastBar = bars.length ? { ...bars[bars.length - 1] } : null;

    // 300 candle sekaligus membuat harga sekarang jadi sepotong piksel di ujung kanan. Begitu
    // coin dipilih, yang tampil adalah ~90 bar terakhir dengan sedikit ruang di kanan.
    if (freshSelection && bars.length) {
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, bars.length - 90),
        to: bars.length + 6,
      });
      freshSelection = false;
    }

    // Semua zona digambar, bukan cuma pasangan terdekat: yang di bawah adalah lantai berikutnya
    // kalau level ini jatuh, yang di atas adalah target berikutnya kalau bertahan. Yang terdekat
    // ditandai lebih tegas supaya tetap menonjol di antara sisanya.
    const near = new Set(
      [d.buyZone, d.sellZone].filter(Boolean).map((z) => z.low + ':' + z.high),
    );
    const list = (d.zones || []).map((z) => ({
      ...z,
      mark:
        d.insideZone && d.insideZone.low === z.low && d.insideZone.high === z.high
          ? 'inside'
          : near.has(z.low + ':' + z.high)
            ? 'near'
            : 'far',
    }));
    currentZones = { list };
    renderBands();
    renderPlans(d);

    renderVerdict(d);
    renderNextMove(d);
    renderZones(d);
    renderHead(d, d.price);

    // Riwayat tipis tidak boleh bersembunyi di balik chart yang terlihat yakin.
    if (d.candleCount < d.minimumCandles * 2) {
      $('warn').textContent =
        'Riwayat tipis: ' + d.candleCount + ' candle. Zona dari data sesedikit ini belum tentu berarti.';
    }
  } catch (e) {
    statusEl.textContent = e.message;
  }
}

// ---------------------------------------------------------------- harga + statistik

async function loadPrice() {
  if (!selected) return;
  try {
    const p = await api('/price/' + selected);

    const el = $('livePrice');
    if (el && p.priceUsd) {
      const prev = parseFloat(el.dataset.v || '0');
      el.textContent = '$' + fmtPrice(p.priceUsd);
      el.dataset.v = p.priceUsd;
      el.style.color = !prev ? '' : p.priceUsd > prev ? COLORS.buy : p.priceUsd < prev ? COLORS.sell : '';
    }

    const ch = $('liveChange');
    if (ch) {
      ch.innerHTML =
        '<span class="' + pctClass(p.priceChange5m) + '">' + fmtPct(p.priceChange5m) + '</span> 5m · ' +
        '<span class="' + pctClass(p.priceChange1h) + '">' + fmtPct(p.priceChange1h) + '</span> 1j';
    }

    updateLiveBar(p.priceUsd);
    renderStats(p);
    statusEl.textContent = 'diperbarui ' + new Date().toLocaleTimeString('id-ID', timeOpts);
  } catch (e) {
    statusEl.textContent = e.message;
  }
}

function renderStats(p) {
  const cell = (k, v, extra) =>
    '<div class="stat"><div class="stat-k">' + k + '</div><div class="stat-v">' + v + '</div>' +
    (extra || '') + '</div>';

  // Tekanan beli/jual sebagai bar: dua angka bersebelahan memaksa pembaca membagi sendiri.
  const pressure = (share, buys, sells) => {
    if (share == null) return cell('Beli vs Jual 1j', '<span class="muted">tidak ada trade</span>');
    return cell(
      'Beli vs Jual 1j',
      share.toFixed(0) + '% beli <small>' + fmtInt(buys) + ' / ' + fmtInt(sells) + '</small>',
      '<div class="bar"><span style="width:' + share.toFixed(1) + '%"></span></div>',
    );
  };

  $('stats').innerHTML =
    cell('Likuiditas', fmtUsd(p.liquidityUsd)) +
    cell('Market cap', fmtUsd(p.marketCap)) +
    cell('Volume 24j', fmtUsd(p.volume24h)) +
    cell('Volume 1j', fmtUsd(p.volume1h)) +
    cell('Volume 5m', fmtUsd(p.volume5m)) +
    cell(
      'Trade 5m',
      fmtInt((p.buys5m || 0) + (p.sells5m || 0)) +
        ' <small>' + fmtInt(p.buys5m) + ' / ' + fmtInt(p.sells5m) + '</small>',
    ) +
    pressure(p.buyShare1h, p.buys1h, p.sells1h) +
    cell(
      'Perubahan 6j / 24j',
      '<span class="' + pctClass(p.priceChange6h) + '">' + fmtPct(p.priceChange6h) + '</span> / ' +
        '<span class="' + pctClass(p.priceChange24h) + '">' + fmtPct(p.priceChange24h) + '</span>',
    );
}

// ---------------------------------------------------------------- tag risiko

const TAG_TEXT = {
  POTENTIAL: 'POTENSIAL',
  RUG_RISK: 'RISIKO RUG',
  LP_UNLOCKED: 'LP TIDAK TERKUNCI',
  HIGH_RISK_SCORE: 'SKOR RISIKO TINGGI',
  RUGCHECK_CLEAR: 'RUGCHECK BERSIH',
  UNCHECKED: 'BELUM DICEK',
  BUSY: 'RAMAI',
  QUIET: 'SEPI',
  THIN_LIQUIDITY: 'LIKUIDITAS TIPIS',
  VERY_NEW: 'MASIH BARU',
  SELLERS_LEADING: 'PENJUAL DOMINAN',
  BOT_REJECTED: 'DITOLAK BOT',
};

async function loadRisk() {
  if (!selected) return;
  const box = $('tags');
  box.innerHTML = '<span class="rtag INFO">memeriksa…</span>';
  try {
    const z = lastZonesPayload;
    const qs =
      '?rr=' + (z && z.advice && z.advice.rewardRisk != null ? z.advice.rewardRisk : '') +
      '&thin=' + (z && z.advice ? Boolean(z.advice.thin) : 'false');
    const d = await api('/risk/' + selected + qs);

    box.innerHTML = d.tags
      .map(
        (t) =>
          '<span class="rtag ' + t.tone + '" title="' + esc(t.because) + '">' +
          esc(TAG_TEXT[t.code] || t.code) + '</span>',
      )
      .join('');
    if (!d.tags.length) box.innerHTML = '';
  } catch (e) {
    // Gagal memuat tag tidak boleh terbaca sebagai "tidak ada masalah".
    box.innerHTML = '<span class="rtag WARN" title="' + esc(e.message) + '">TAG GAGAL DIMUAT</span>';
  }
}

// ---------------------------------------------------------------- render

/** Mint panjangnya 44 karakter; ujung-ujungnya cukup untuk mengenali, tengahnya tidak. */
function shortMint(mint) {
  return mint && mint.length > 14 ? mint.slice(0, 6) + '…' + mint.slice(-6) : mint || '';
}

function renderHead(d, price) {
  const t = TIMEFRAMES.find((x) => x.m === d.timeframeMinutes);
  const tfLabel = d.timeframeMinutes ? (t ? t.label : d.timeframeMinutes + 'm') : '';
  $('head').innerHTML =
    iconHtml(d.imageUrl, d.symbol, 'icon-lg') +
    '<span class="sym">' + esc(d.symbol || selected.slice(0, 8)) + '</span>' +
    '<span class="big" id="livePrice" data-v="' + (price || '') + '">$' + fmtPrice(price) + '</span>' +
    '<span class="meta" id="liveChange"></span>' +
    '<span class="meta">' + (d.candleCount || 0) + ' candle' + (tfLabel ? ' · ' + tfLabel : '') + '</span>' +
    '<span class="mintbox">' +
      '<code>' + esc(shortMint(selected)) + '</code>' +
      '<button class="copy" data-copy="' + esc(selected) + '" title="salin alamat mint">salin</button>' +
    '</span>';
}

// Satu kalimat yang menjawab "beli sekarang atau nggak". Kata-katanya ada di sini, keputusannya
// tidak: `advice.action` datang dari backend, jadi halaman ini dan report Telegram tidak mungkin
// berbeda pendapat soal chart yang sama.
const VERDICT = {
  IN_BUY_ZONE: { cls: 'v-buy', text: 'BELI — harga sedang DI DALAM zona beli' },
  NEAR_BUY: { cls: 'v-buy', text: 'SIAP-SIAP — harga sudah mepet zona beli' },
  WAIT: { cls: '', text: 'TUNGGU — harga masih jauh di atas zona beli' },
  NEAR_SELL: { cls: 'v-warn', text: 'JANGAN KEJAR — harga mepet zona jual' },
  IN_SELL_ZONE: { cls: 'v-sell', text: 'JANGAN BELI — harga DI DALAM zona jual' },
  NO_PLAN: { cls: '', text: 'TIDAK ADA RENCANA — tidak ada lantai di bawah harga' },
};

function renderVerdict(d) {
  const a = d.advice;
  const box = $('verdict');
  if (!a || !VERDICT[a.action]) { box.style.display = 'none'; return; }

  const v = VERDICT[a.action];
  const bits = [];
  if (a.buyDistancePct != null) bits.push('beli ' + fmtPct(a.buyDistancePct) + ' dari sini');
  if (a.sellDistancePct != null) bits.push('jual ' + fmtPct(a.sellDistancePct) + ' dari sini');
  if (a.rewardRisk != null) bits.push('untung:rugi ' + a.rewardRisk.toFixed(1) + ':1');
  if (a.thin) bits.push('riwayat tipis (' + d.candleCount + ' candle), belum tentu berarti');

  box.style.display = '';
  box.className = v.cls;
  box.innerHTML =
    '<span class="v-head">' + v.text + '</span>' +
    '<span class="v-sub">' + bits.join(' · ') + '</span>';
}

/**
 * Rencana beli-jual, satu kartu per zona beli.
 *
 * Angka utamanya sengaja yang paling pesimis: beli di harga paling tidak menguntungkan dalam pita,
 * jual di harga pertama tempat penjual muncul. Versi optimisnya ikut di sebelahnya, bukan
 * menggantikannya.
 */
function renderPlans(d) {
  const box = $('plans');
  const plans = d.plans || [];
  if (!plans.length) {
    box.innerHTML =
      '<div class="footnote">Tidak ada pasangan beli-jual yang untungnya melewati biaya fee.</div>';
    return;
  }

  box.innerHTML = plans
    .map((p, i) => {
      const where = p.active
        ? '<span class="plan-now">HARGA DI SINI SEKARANG</span>'
        : '<span class="muted" style="font-size:12px">' + fmtPct(p.distancePct) + ' dari harga</span>';

      const targets = p.targets
        .map(
          (t, j) =>
            '<div class="plan-t">' +
            '<span class="plan-tn">Target ' + (j + 1) + '</span>' +
            '<span class="zone-range">$' + fmtPrice(t.low) + ' - $' + fmtPrice(t.high) + '</span>' +
            '<span class="plan-gain">+' + t.gainPct.toFixed(1) + '%' +
            '<small> s/d +' + t.bestGainPct.toFixed(1) + '%</small></span>' +
            '</div>',
        )
        .join('');

      return (
        '<div class="plan' + (p.active ? ' active' : '') + '">' +
        '<div class="plan-head">' +
        '<span class="plan-no">#' + (i + 1) + '</span>' +
        '<span class="zone-label" style="color:var(--buy)">BELI $' +
        fmtPrice(p.entryLow) + ' - $' + fmtPrice(p.entryHigh) + '</span>' +
        '<span class="tag">' + esc(p.entryStrength.toLowerCase()) + '</span>' +
        '<span class="muted" style="font-size:12px">' + p.entryHits + ' sentuhan</span>' +
        where +
        '</div>' + targets + '</div>'
      );
    })
    .join('');
}

/**
 * Prediksi posisi berikutnya.
 *
 * Confidence di sini adalah jumlah sinyal yang sepakat, bukan perasaan: 3 dari 3 kuat, 2 dari 3
 * sedang, sisanya lemah. Suara yang imbang menghasilkan DATAR, bukan tebakan ke arah mayoritas.
 *
 * Peringatan rekam jejak selalu ikut, dan itu disengaja. `sol-prediction.ts` baru boleh mengirim
 * alert setelah mengalahkan baseline; yang ini belum pernah diadu dengan apa pun. Prediksi tanpa
 * rekam jejak adalah pendapat terstruktur, dan halamannya tidak boleh menampilkannya lebih dari itu.
 */
function renderNextMove(d) {
  const m = d.nextMove;
  const box = $('predict');
  if (!m) { box.style.display = 'none'; return; }

  const face = {
    UP: { cls: 'p-up', text: 'NAIK' },
    DOWN: { cls: 'p-down', text: 'TURUN' },
    FLAT: { cls: '', text: 'DATAR' },
  }[m.direction] || { cls: '', text: m.direction };

  const conf = { strong: 'kuat', medium: 'sedang', weak: 'lemah' }[m.confidence] || m.confidence;

  const target =
    m.targetLow != null
      ? '<span class="p-target">ke $' + fmtPrice(m.targetLow) + ' – $' + fmtPrice(m.targetHigh) +
        '<b>' + fmtPct(m.expectedMovePct) + '</b></span>'
      : '<span class="muted">tidak ada pita di arah itu</span>';

  const eta = m.etaBars != null ? '<span class="muted">~' + m.etaBars + ' bar lagi</span>' : '';

  box.style.display = '';
  box.className = face.cls;
  box.innerHTML =
    '<div class="p-top">' +
      '<span class="p-dir">' + face.text + '</span>' +
      '<span class="p-conf">' + conf + ' · ' + m.agreement.for + '/' + m.agreement.total + ' sinyal sepakat</span>' +
      target + eta +
    '</div>' +
    '<div class="p-why">' + m.reasons.map((r) => esc(r)).join(' · ') + '</div>' +
    '<div class="p-warn">Belum punya rekam jejak. Ini pembacaan keadaan sekarang, bukan ramalan yang sudah terbukti.</div>';
}

function renderZones(d) {
  const row = (z, label, cls) => {
    if (!z) {
      return '<div class="zone"><span class="zone-label muted">' + label + '</span>' +
        '<span class="muted" style="font-size:13px">tidak ada zona</span></div>';
    }
    return '<div class="zone ' + cls + '">' +
      '<span><span class="zone-label">' + label + '</span> ' +
        '<span class="tag">' + esc(z.strength.toLowerCase()) + '</span> ' +
        '<span class="muted" style="font-size:12px">' + z.hits + ' sentuhan</span></span>' +
      '<span class="zone-range">$' + fmtPrice(z.low) + ' – $' + fmtPrice(z.high) +
        (z.distancePct != null ? ' <span class="muted">(' + fmtPct(z.distancePct) + ')</span>' : '') +
      '</span></div>';
  };

  // Harga di dalam pita bukan target beli maupun jual — itu posisi, bukan instruksi.
  const insideRow = d.insideZone
    ? '<div class="zone inside"><span><span class="zone-label">DI DALAM ZONA</span> ' +
      '<span class="tag">' + esc(d.insideZone.strength.toLowerCase()) + '</span></span>' +
      '<span class="zone-range">$' + fmtPrice(d.insideZone.low) + ' – $' + fmtPrice(d.insideZone.high) +
      '</span></div>'
    : '';

  // Zona dihitung dari candle timeframe yang sedang dipilih, jadi mengganti timeframe memang
  // mengganti pitanya. Itu sifat indikatornya, bukan kesalahan, tapi tanpa disebut di sini angkanya
  // terlihat seperti berubah sendiri.
  const zt = TIMEFRAMES.find((x) => x.m === d.zoneTimeframeMinutes);
  const ztLabel = zt ? zt.label : (d.zoneTimeframeMinutes || '?') + 'm';
  const hours = d.zoneHistoryHours;
  const span = hours == null ? '?' : hours >= 48 ? (hours / 24).toFixed(0) + ' hari' : hours.toFixed(0) + ' jam';
  const locked = d.zoneTimeframeMinutes !== d.timeframeMinutes;

  $('zones').innerHTML =
    row(d.sellZone, 'JUAL di', 'sell') + insideRow + row(d.buyZone, 'BELI di', 'buy') +
    '<div class="footnote">' + d.zones.length + ' zona dari candle <b>' + ztLabel +
    '</b>, mencakup <b>' + span + '</b> riwayat' +
    (locked
      ? ' · terkunci: zoom chart tidak menggeser ambangnya'
      : ' · ikut chart: ganti timeframe akan menggeser ambangnya') +
    ' · hanya tampilan, bot tidak bertindak atas ini</div>';
}

// ---------------------------------------------------------------- start

$('go').onclick = () => {
  const m = mintEl.value.trim();
  if (m) { loadCoins(m); select(m); }
};
$('reload').onclick = () => loadCoins();
mintEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('go').click(); });

renderTabs();
renderTimeframes();
renderZoneTf();

// Coin dari URL dipulihkan lebih dulu, supaya refresh tidak membuang apa yang sedang dilihat.
const fromUrl = params.get('mint');
if (fromUrl) {
  mintEl.value = fromUrl;
  selected = fromUrl;
  restartPolling();
}
syncUrl();
loadCoins();
