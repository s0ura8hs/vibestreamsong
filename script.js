
/* ==========================================================================
   Vibestream — offline music app
   Features: IndexedDB persistence, metadata via jsmediatags, 5-band EQ,
   reactive ambient mode, voice search, drag-drop upload, custom playlists
   ========================================================================== */

/* -------------------- State -------------------- */
const state = {
  songs: [],            // [{id, title, artist, album, duration, coverUrl, fileBlob}]
  playlists: [],        // [{id, name, desc, songIds: [], createdAt}]
  liked: new Set(),     // song ids
  recent: [],           // song ids
  view: 'home',
  libraryTab: 'songs',
  search: '',
  // playback
  queue: [],            // ordered song ids
  queueIndex: -1,
  currentId: null,
  shuffle: false,
  repeat: 'off',        // off | all | one
  // detail context (for add-to-playlist menu)
  ctxSongId: null,
  detailPlaylistId: null,
  detailGroup: null,    // {kind, key}
};

const LIKED_ID = 'liked';

/* -------------------- DOM helpers -------------------- */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const fmtTime = (s) => {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${r}`;
};
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const escHtml = (s) => (s ?? '').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function toast(msg) {
  const wrap = $('#toastWrap');
  const t = el(`<div class="toast">${escHtml(msg)}</div>`);
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 2900);
}

/* -------------------- IndexedDB -------------------- */
const DB_NAME = 'vibestream-db';
const DB_VER = 1;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const _db = req.result;
      if (!_db.objectStoreNames.contains('songs')) _db.createObjectStore('songs', { keyPath: 'id' });
      if (!_db.objectStoreNames.contains('playlists')) _db.createObjectStore('playlists', { keyPath: 'id' });
      if (!_db.objectStoreNames.contains('meta')) _db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}
function txStore(store, mode = 'readonly') {
  return db.transaction(store, mode).objectStore(store);
}
function idbPut(store, val) {
  return new Promise((res, rej) => {
    const r = txStore(store, 'readwrite').put(val);
    r.onsuccess = () => res(val); r.onerror = () => rej(r.error);
  });
}
function idbDel(store, key) {
  return new Promise((res, rej) => {
    const r = txStore(store, 'readwrite').delete(key);
    r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  });
}
function idbAll(store) {
  return new Promise((res, rej) => {
    const r = txStore(store).getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function idbGet(store, key) {
  return new Promise((res, rej) => {
    const r = txStore(store).get(key);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

async function loadAll() {
  state.songs = (await idbAll('songs')) || [];
  // rebuild object URLs from blobs (URLs are session-scoped)
  state.songs.forEach(s => {
    if (s.fileBlob) s.audioUrl = URL.createObjectURL(s.fileBlob);
    if (s.coverBlob) s.coverUrl = URL.createObjectURL(s.coverBlob);
  });
  state.playlists = (await idbAll('playlists')) || [];
  const meta = await idbGet('meta', 'app');
  if (meta) {
    state.liked = new Set(meta.liked || []);
    state.recent = meta.recent || [];
    state.shuffle = !!meta.shuffle;
    state.repeat = meta.repeat || 'off';
  }
}
async function saveMeta() {
  await idbPut('meta', {
    key: 'app',
    liked: [...state.liked],
    recent: state.recent.slice(0, 20),
    shuffle: state.shuffle,
    repeat: state.repeat,
  });
}

/* -------------------- Metadata via jsmediatags -------------------- */
function readTags(file) {
  return new Promise((resolve) => {
    if (!window.jsmediatags) return resolve(null);
    window.jsmediatags.read(file, {
      onSuccess: (res) => resolve(res.tags || null),
      onError: () => resolve(null),
    });
  });
}

// Detect garbled text (replacement chars or mojibake patterns)
function looksGarbled(s) {
  if (!s || typeof s !== 'string') return true;
  if (s.includes('\uFFFD')) return true;        // replacement character
  // tons of "Ã" or "â€" sequences → latin-1-as-utf8 mojibake
  if (/(Ã.|â€|Ð|Ñ){2,}/.test(s)) return true;
  // mostly control chars
  if (/^[-\x1f\s\?]+$/.test(s)) return true;
  return false;
}
function cleanTag(s) {
  if (!s) return null;
  const t = s.replace(/[-\u001f]/g, '').trim();
  if (!t || looksGarbled(t)) return null;
  return t;
}
// Try to derive artist/title from filename like "Artist - Title.mp3"
function parseFilename(name) {
  const stem = name.replace(/\.[^/.]+$/, '');
  const m = stem.match(/^\s*(.+?)\s*[-–—]\s*(.+?)\s*$/);
  if (m) return { artist: m[1], title: m[2] };
  return { artist: null, title: stem };
}

function tagsToCoverBlob(tags) {
  if (!tags || !tags.picture) return null;
  const { data, format } = tags.picture;
  const u8 = new Uint8Array(data);
  return new Blob([u8], { type: format || 'image/jpeg' });
}

function getAudioDuration(url) {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    a.src = url;
    a.onloadedmetadata = () => resolve(a.duration || 0);
    a.onerror = () => resolve(0);
  });
}

/* -------------------- Upload pipeline (parallel) -------------------- */
async function handleFiles(fileList) {
  const files = Array.from(fileList).filter(f => /audio\//.test(f.type) || /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(f.name));
  if (!files.length) return toast('No audio files found');
  const bar = $('#uploadBar'); const text = $('#uploadText'); const wrap = $('#uploadProgress');
  wrap.classList.remove('hidden');
  let done = 0;
  const total = files.length;
  text.textContent = `Processing 0 / ${total}…`;
  bar.style.width = '2%';

  // process in parallel chunks
  const tick = () => {
    done += 1;
    bar.style.width = `${Math.round((done / total) * 100)}%`;
    text.textContent = `Processing ${done} / ${total}…`;
  };

  await Promise.all(files.map(async (file) => {
    try {
      const id = uid();
      const audioUrl = URL.createObjectURL(file);
      // parallel: read tags + read duration
      const [tags, duration] = await Promise.all([
        readTags(file),
        getAudioDuration(audioUrl),
      ]);
      const coverBlob = tagsToCoverBlob(tags);
      const coverUrl = coverBlob ? URL.createObjectURL(coverBlob) : null;
      const fb = parseFilename(file.name);
      const title  = cleanTag(tags && tags.title)  || fb.title  || 'Unknown';
      const artist = cleanTag(tags && tags.artist) || fb.artist || 'Unknown Artist';
      const album  = cleanTag(tags && tags.album)  || 'Unknown Album';
      const song = {
        id,
        title,
        artist,
        album,
        year: (tags && tags.year) || '',
        duration: duration || 0,
        fileBlob: file,
        coverBlob,
        addedAt: Date.now(),
      };
      const songForState = { ...song, audioUrl, coverUrl };
      state.songs.push(songForState);
      await idbPut('songs', song);
      tick();
    } catch (e) {
      console.error('upload failed', file?.name, e);
      tick();
    }
  }));

  text.textContent = `Imported ${total} ${total === 1 ? 'song' : 'songs'}`;
  setTimeout(() => wrap.classList.add('hidden'), 1400);
  toast(`Added ${total} ${total === 1 ? 'song' : 'songs'}`);
  renderAll();
}

async function deleteSong(id) {
  const idx = state.songs.findIndex(s => s.id === id);
  if (idx < 0) return;
  state.songs.splice(idx, 1);
  state.playlists.forEach(p => { p.songIds = p.songIds.filter(x => x !== id); });
  state.liked.delete(id);
  state.recent = state.recent.filter(x => x !== id);
  state.queue = state.queue.filter(x => x !== id);
  await Promise.all([
    idbDel('songs', id),
    ...state.playlists.map(p => idbPut('playlists', p)),
    saveMeta(),
  ]);
  if (state.currentId === id) stop();
  toast('Removed from library');
  renderAll();
}

/* -------------------- Playlist ops -------------------- */
async function createPlaylist(name, desc = '') {
  const pl = { id: uid(), name: name.trim() || 'New playlist', desc: desc.trim(), songIds: [], createdAt: Date.now() };
  state.playlists.push(pl);
  await idbPut('playlists', pl);
  renderSidebar(); renderLibrary();
  toast(`Created "${pl.name}"`);
  return pl;
}
async function deletePlaylist(id) {
  state.playlists = state.playlists.filter(p => p.id !== id);
  await idbDel('playlists', id);
  if (state.detailPlaylistId === id) showView('home');
  renderSidebar(); renderLibrary();
  toast('Playlist deleted');
}
async function addSongToPlaylist(pid, sid) {
  if (pid === LIKED_ID) {
    if (state.liked.has(sid)) state.liked.delete(sid); else state.liked.add(sid);
    await saveMeta();
    updateLikeBtn();
    renderSidebar();
    renderCurrentView();
    return;
  }
  const pl = state.playlists.find(p => p.id === pid);
  if (!pl) return;
  if (pl.songIds.includes(sid)) {
    toast('Already in playlist');
    return;
  }
  pl.songIds.push(sid);
  await idbPut('playlists', pl);
  toast(`Added to "${pl.name}"`);
  renderSidebar();
  if (state.view === 'playlist' && state.detailPlaylistId === pid) renderPlaylistDetail();
}
async function removeFromPlaylist(pid, sid) {
  if (pid === LIKED_ID) {
    state.liked.delete(sid);
    await saveMeta();
    renderPlaylistDetail();
    return;
  }
  const pl = state.playlists.find(p => p.id === pid);
  if (!pl) return;
  pl.songIds = pl.songIds.filter(x => x !== sid);
  await idbPut('playlists', pl);
  renderPlaylistDetail();
}

/* -------------------- Derivations -------------------- */
function normStr(s) {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Split artist string into individual artist names
function splitArtists(artistStr) {
  if (!artistStr) return ['Unknown Artist'];
  return artistStr
    .split(/\s*[,/]\s*|\s+feat\.?\s+|\s+ft\.?\s+|\s+x\s+|\s+&\s+/i)
    .map(a => a.trim())
    .filter(Boolean);
}

function songsByAlbum() {
  // Group ONLY by album name (normalized) — ignore artist differences within same album
  const map = new Map();
  state.songs.forEach(s => {
    const normKey = normStr(s.album);
    if (!map.has(normKey)) {
      // collect all distinct artists for this album
      map.set(normKey, { album: s.album, artists: new Set(), songs: [], cover: null });
    }
    const g = map.get(normKey);
    g.songs.push(s);
    splitArtists(s.artist).forEach(a => g.artists.add(a));
    if (!g.cover && s.coverUrl) g.cover = s.coverUrl;
  });
  return Array.from(map.values())
    .map(g => ({ ...g, artist: [...g.artists].slice(0, 3).join(', ') }))
    .sort((a, b) => a.album.localeCompare(b.album));
}

function songsByArtist() {
  // Split multi-artist tags into individual artists; each gets their own entry
  const map = new Map();
  state.songs.forEach(s => {
    const artists = splitArtists(s.artist);
    artists.forEach(artist => {
      const normKey = normStr(artist);
      if (!map.has(normKey)) map.set(normKey, { artist, songs: [], cover: null });
      const g = map.get(normKey);
      if (!g.songs.find(x => x.id === s.id)) g.songs.push(s);
      if (!g.cover && s.coverUrl) g.cover = s.coverUrl;
    });
  });
  return Array.from(map.values()).sort((a, b) => a.artist.localeCompare(b.artist));
}

/* -------------------- Render -------------------- */
function setGreeting() {
  const h = new Date().getHours();
  const txt = h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('#greeting').textContent = txt;
}

function renderAll() {
  renderSidebar();
  renderStats();
  renderHome();
  renderLibrary();
  renderQueuePanel();
  if (state.view === 'playlist') renderPlaylistDetail();
  if (state.view === 'group') renderGroupDetail();
  if (state.view === 'search') renderSearchResults();
}
function renderCurrentView() {
  if (state.view === 'home') renderHome();
  if (state.view === 'library') renderLibrary();
  if (state.view === 'playlist') renderPlaylistDetail();
  if (state.view === 'group') renderGroupDetail();
  if (state.view === 'search') renderSearchResults();
}

function renderStats() {
  $('#statSongs').textContent = state.songs.length;
  $('#statArtists').textContent = new Set(state.songs.map(s => s.artist)).size;
  $('#statAlbums').textContent = new Set(state.songs.map(s => s.album)).size;
}

function renderSidebar() {
  const ul = $('#playlistList');
  ul.innerHTML = '';
  // Liked Songs always first
  const liked = el(`
    <li class="plitem plitem--liked${state.detailPlaylistId === LIKED_ID && state.view === 'playlist' ? ' active' : ''}" data-pid="${LIKED_ID}" data-testid="playlist-liked">
      <span class="plitem__icon"><i class="fa-solid fa-heart"></i></span>
      <span class="plitem__name">Liked Songs</span>
      <span class="plitem__count">${state.liked.size}</span>
    </li>`);
  liked.addEventListener('click', () => openPlaylist(LIKED_ID));
  ul.appendChild(liked);

  state.playlists.forEach(p => {
    const node = el(`
      <li class="plitem${state.detailPlaylistId === p.id && state.view === 'playlist' ? ' active' : ''}" data-pid="${p.id}" data-testid="playlist-${escHtml(p.name)}">
        <span class="plitem__icon"><i class="fa-solid fa-music"></i></span>
        <span class="plitem__name">${escHtml(p.name)}</span>
        <span class="plitem__count">${p.songIds.length}</span>
      </li>`);
    node.addEventListener('click', () => openPlaylist(p.id));
    ul.appendChild(node);
  });
}

function songRow(song, opts = {}) {
  const idx = opts.idx ?? '';
  const playing = state.currentId === song.id;
  const liked = state.liked.has(song.id);
  const cover = song.coverUrl
    ? `<img src="${song.coverUrl}" alt="" />`
    : `<i class="fa-solid fa-music"></i>`;
  const row = el(`
    <div class="songrow${playing ? ' playing' : ''}" data-id="${song.id}" data-testid="songrow-${song.id}">
      <div class="songrow__idx">${playing ? '<i class="fa-solid fa-volume-high"></i>' : idx}</div>
      <div class="songrow__cover">${cover}</div>
      <div class="songrow__main">
        <div class="songrow__title">${escHtml(song.title)}</div>
        <button class="songrow__artist songrow__link" data-kind="artist" data-key="${escHtml(song.artist)}" title="View artist">${escHtml(song.artist)}</button>
      </div>
      <button class="songrow__album songrow__link" data-kind="album" data-key="${escHtml(song.album)}" data-artist="${escHtml(song.artist)}" title="View album">${escHtml(song.album)}</button>
      <div class="songrow__time">${fmtTime(song.duration)}</div>
      <button class="songrow__more" title="More" data-testid="more-${song.id}">
        <i class="fa-solid fa-ellipsis"></i>
      </button>
    </div>`);
  row.addEventListener('dblclick', () => playSong(song.id, opts.list || state.songs.map(s => s.id)));
  row.addEventListener('click', (e) => {
    if (e.target.closest('.songrow__more')) return;
    if (e.target.closest('.songrow__link')) return;
    playSong(song.id, opts.list || state.songs.map(s => s.id));
  });
  row.querySelector('.songrow__more').addEventListener('click', (e) => {
    e.stopPropagation();
    openCtxMenu(e, song.id);
  });
  // clickable artist — if multiple artists, go to first; song.artist raw passed so detail uses splitArtists
  row.querySelector('.songrow__artist').addEventListener('click', (e) => {
    e.stopPropagation();
    const artists = splitArtists(song.artist);
    // always navigate to the primary (first) artist
    openGroup('artist', artists[0]);
  });
  // clickable album — album key only, no artist restriction
  row.querySelector('.songrow__album').addEventListener('click', (e) => {
    e.stopPropagation();
    openGroup('album', song.album);
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openCtxMenu(e, song.id);
  });
  return row;
}

function renderHome() {
  // quick card subs
  $('#quickLikedSub').textContent = `${state.liked.size} ${state.liked.size === 1 ? 'track' : 'tracks'}`;
  $('#quickRecentSub').textContent = state.recent.length
    ? `${state.recent.length} recent ${state.recent.length === 1 ? 'track' : 'tracks'}`
    : 'Pick up where you left off';
  $('#quickShuffleSub').textContent = state.songs.length
    ? `${state.songs.length} ${state.songs.length === 1 ? 'track' : 'tracks'} ready`
    : 'Upload to get started';

  // recent row
  const recent = state.recent
    .map(id => state.songs.find(s => s.id === id))
    .filter(Boolean)
    .slice(0, 10);
  const recentRow = $('#recentRow');
  recentRow.innerHTML = '';
  if (!recent.length) {
    $('#recentSection').classList.add('hidden');
  } else {
    $('#recentSection').classList.remove('hidden');
    recent.forEach(s => {
      const card = el(`
        <div class="card" data-testid="recent-card-${s.id}">
          <div class="card__cover">${s.coverUrl ? `<img src="${s.coverUrl}" alt="" />` : '<i class="fa-solid fa-music"></i>'}</div>
          <div class="card__title">${escHtml(s.title)}</div>
          <div class="card__sub">${escHtml(s.artist)}</div>
        </div>`);
      card.addEventListener('click', () => playSong(s.id, state.recent));
      recentRow.appendChild(card);
    });
  }

  // all tracks grid
  const grid = $('#allTracksGrid');
  grid.innerHTML = '';
  const songs = state.songs.slice().sort((a,b) => (b.addedAt||0) - (a.addedAt||0));
  $('#songCountLabel').textContent = `${songs.length} ${songs.length === 1 ? 'track' : 'tracks'}`;
  if (!songs.length) {
    grid.appendChild(el(`<div class="empty">Drop some audio files above to start your library.</div>`));
    return;
  }
  const ids = songs.map(s => s.id);
  songs.forEach((s) => grid.appendChild(trackCard(s, ids)));
}

function trackCard(s, list) {
  const playing = state.currentId === s.id;
  const card = el(`
    <div class="trackcard${playing ? ' playing' : ''}" data-id="${s.id}" data-testid="trackcard-${s.id}">
      <div class="trackcard__cover">${s.coverUrl ? `<img src="${s.coverUrl}" alt="" />` : '<i class="fa-solid fa-music"></i>'}</div>
      <div class="trackcard__meta">
        <div class="trackcard__title">${escHtml(s.title)}</div>
        <div class="trackcard__sub">${escHtml(s.artist)}</div>
      </div>
      <div class="trackcard__time">${fmtTime(s.duration)}</div>
    </div>`);
  card.addEventListener('click', () => playSong(s.id, list));
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); openCtxMenu(e, s.id); });
  return card;
}

function renderLibrary() {
  // tabs visibility
  $$('.tabpanel').forEach(p => p.classList.toggle('active', p.dataset.panel === state.libraryTab));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.libraryTab));

  if (state.libraryTab === 'songs') {
    const list = $('#librarySongs');
    list.innerHTML = '';
    const ids = state.songs.map(s => s.id);
    if (!state.songs.length) {
      list.appendChild(el(`<div class="empty">Upload songs to populate your library.</div>`));
      return;
    }
    state.songs.forEach((s, i) => list.appendChild(songRow(s, { idx: i + 1, list: ids })));
    return;
  }
  if (state.libraryTab === 'albums') {
    const wrap = $('#libraryAlbums');
    wrap.innerHTML = '';
    const groups = songsByAlbum();
    if (!groups.length) wrap.appendChild(el(`<div class="empty">No albums yet.</div>`));
    groups.forEach(g => {
      const card = el(`
        <div class="card" data-testid="album-${escHtml(g.album)}">
          <div class="card__cover">${g.cover ? `<img src="${g.cover}" alt="" />` : '<i class="fa-solid fa-compact-disc"></i>'}</div>
          <div class="card__title">${escHtml(g.album)}</div>
          <div class="card__sub">${escHtml(g.artist)} · ${g.songs.length} tracks</div>
        </div>`);
      card.addEventListener('click', () => openGroup('album', g.album, g.artist));
      wrap.appendChild(card);
    });
    return;
  }
  if (state.libraryTab === 'artists') {
    const wrap = $('#libraryArtists');
    wrap.innerHTML = '';
    const groups = songsByArtist();
    if (!groups.length) wrap.appendChild(el(`<div class="empty">No artists yet.</div>`));
    groups.forEach(g => {
      const card = el(`
        <div class="card" data-testid="artist-${escHtml(g.artist)}">
          <div class="card__cover">${g.cover ? `<img src="${g.cover}" alt="" />` : '<i class="fa-solid fa-user"></i>'}</div>
          <div class="card__title">${escHtml(g.artist)}</div>
          <div class="card__sub">${g.songs.length} tracks</div>
        </div>`);
      card.addEventListener('click', () => openGroup('artist', g.artist));
      wrap.appendChild(card);
    });
    return;
  }
  if (state.libraryTab === 'playlists') {
    const wrap = $('#libraryPlaylists');
    wrap.innerHTML = '';
    // include liked + user playlists
    const all = [
      { id: LIKED_ID, name: 'Liked Songs', desc: 'Your favorites', songIds: [...state.liked], liked: true },
      ...state.playlists,
    ];
    all.forEach(p => {
      const firstSong = state.songs.find(s => p.songIds.includes(s.id));
      const cover = firstSong?.coverUrl;
      const card = el(`
        <div class="card" data-testid="pl-card-${p.id}">
          <div class="card__cover" style="${p.liked ? 'background: linear-gradient(135deg, #ff5d6b, #ff8a3d);' : ''}">
            ${cover ? `<img src="${cover}" alt="" />` : `<i class="fa-solid ${p.liked ? 'fa-heart' : 'fa-music'}"></i>`}
          </div>
          <div class="card__title">${escHtml(p.name)}</div>
          <div class="card__sub">${p.songIds.length} tracks</div>
        </div>`);
      card.addEventListener('click', () => openPlaylist(p.id));
      wrap.appendChild(card);
    });
  }
}

function renderPlaylistDetail() {
  const pid = state.detailPlaylistId;
  let pl;
  if (pid === LIKED_ID) {
    pl = { id: LIKED_ID, name: 'Liked Songs', desc: 'Songs you love', songIds: [...state.liked], liked: true };
  } else {
    pl = state.playlists.find(p => p.id === pid);
    if (!pl) return;
  }
  $('#pdetailName').textContent = pl.name;
  $('#pdetailDesc').textContent = pl.desc || `${pl.songIds.length} tracks`;
  const cover = $('#pdetailCover');
  const firstSong = state.songs.find(s => pl.songIds.includes(s.id));
  cover.innerHTML = firstSong?.coverUrl
    ? `<img src="${firstSong.coverUrl}" alt="" />`
    : `<i class="fa-solid ${pl.liked ? 'fa-heart' : 'fa-music'}"></i>`;
  if (pl.liked) cover.style.background = 'linear-gradient(135deg, #ff5d6b, #ff8a3d)';
  else cover.style.background = '';

  $('#pdetailDelete').style.display = pl.liked ? 'none' : 'inline-flex';

  const list = $('#playlistSongs');
  list.innerHTML = '';
  const songs = pl.songIds.map(id => state.songs.find(s => s.id === id)).filter(Boolean);
  if (!songs.length) {
    list.appendChild(el(`<div class="empty">${pl.liked ? 'Tap the heart on any song to like it.' : 'Right-click songs to add them here.'}</div>`));
  }
  const ids = songs.map(s => s.id);
  songs.forEach((s, i) => list.appendChild(songRow(s, { idx: i + 1, list: ids })));

  // Play button
  $('#pdetailPlay').onclick = () => {
    if (!ids.length) return;
    playSong(ids[0], ids);
  };
  // Shuffle button
  $('#pdetailShuffle').onclick = () => {
    if (!ids.length) return;
    state.shuffle = true;
    $('#shuffleBtn').classList.add('active');
    const startId = ids[Math.floor(Math.random() * ids.length)];
    buildShuffleBag(ids, startId);
    playSong(startId, ids);
    toast('Shuffling playlist');
  };
  // Upload-to-playlist button
  const uploadBtn = $('#pdetailUpload');
  const fileInput = $('#pdetailFileInput');
  if (pl.liked) {
    uploadBtn.style.display = 'none';
  } else {
    uploadBtn.style.display = 'inline-flex';
    uploadBtn.onclick = () => fileInput.click();
    fileInput.onchange = async (e) => {
      const files = e.target.files;
      if (!files.length) return;
      await handleFiles(files);
      // add all newly added songs (they were appended to state.songs) to this playlist
      const newIds = state.songs.slice(-files.length).map(s => s.id);
      for (const sid of newIds) {
        if (!pl.songIds.includes(sid)) {
          pl.songIds.push(sid);
        }
      }
      await idbPut('playlists', pl);
      fileInput.value = '';
      toast(`Added ${newIds.length} song${newIds.length !== 1 ? 's' : ''} to "${pl.name}"`);
      renderPlaylistDetail();
    };
  }
  $('#pdetailDelete').onclick = () => {
    if (confirm(`Delete playlist "${pl.name}"?`)) deletePlaylist(pl.id);
  };
}

function renderGroupDetail() {
  const g = state.detailGroup;
  if (!g) return;
  let songs = [];
  let title = '', kind = '', desc = '';
  if (g.kind === 'album') {
    // match by album name only (normalized) — ignore per-song artist differences
    songs = state.songs.filter(s => normStr(s.album) === normStr(g.key));
    const allArtists = [...new Set(songs.flatMap(s => splitArtists(s.artist)))];
    title = g.key; kind = 'ALBUM';
    desc = `${allArtists.slice(0, 3).join(', ')}${allArtists.length > 3 ? '\u2026' : ''} · ${songs.length} tracks`;
  } else {
    // artist: match songs where this artist appears in the split list
    const normKey = normStr(g.key);
    songs = state.songs.filter(s => splitArtists(s.artist).some(a => normStr(a) === normKey));
    const albumCount = new Set(songs.map(s => normStr(s.album))).size;
    title = g.key; kind = 'ARTIST';
    desc = `${songs.length} tracks · ${albumCount} album${albumCount !== 1 ? 's' : ''}`;
  }
  $('#groupName').textContent = title;
  $('#groupKind').textContent = kind;
  $('#groupDesc').textContent = desc;
  const cover = $('#groupCover');
  const firstWithCover = songs.find(s => s.coverUrl);
  cover.innerHTML = firstWithCover?.coverUrl
    ? `<img src="${firstWithCover.coverUrl}" alt="" />`
    : `<i class="fa-solid ${g.kind === 'album' ? 'fa-compact-disc' : 'fa-user'}"></i>`;
  if (g.kind === 'artist') { cover.style.borderRadius = '50%'; } else { cover.style.borderRadius = ''; }

  const list = $('#groupSongs'); list.innerHTML = '';
  const ids = songs.map(s => s.id);
  songs.forEach((s, i) => list.appendChild(songRow(s, { idx: i + 1, list: ids })));
  $('#groupPlay').onclick = () => ids.length && playSong(ids[0], ids);
}

function renderSearchResults() {
  const q = state.search.trim().toLowerCase();
  $('#searchTerm').textContent = q;
  const list = $('#searchResults'); list.innerHTML = '';
  if (!q) return;
  const matches = state.songs.filter(s =>
    s.title.toLowerCase().includes(q) ||
    s.artist.toLowerCase().includes(q) ||
    s.album.toLowerCase().includes(q)
  );
  if (!matches.length) {
    list.appendChild(el(`<div class="empty">No matches.</div>`));
    return;
  }
  const ids = matches.map(s => s.id);
  matches.forEach((s, i) => list.appendChild(songRow(s, { idx: i + 1, list: ids })));
}

/* -------------------- View history (Spotify-style back/forward) -------------------- */
const viewHistory = {
  stack: [],   // [{view, playlistId, group, search}]
  cursor: -1,  // current position
  _navigating: false, // suppress push during back/fwd navigation
};

function histSnapshot() {
  return {
    view: state.view,
    playlistId: state.detailPlaylistId,
    group: state.detailGroup ? { ...state.detailGroup } : null,
    search: state.search,
    libraryTab: state.libraryTab,
  };
}

function histPush() {
  if (viewHistory._navigating) return;
  // drop forward stack when user navigates normally
  if (viewHistory.cursor < viewHistory.stack.length - 1) {
    viewHistory.stack.splice(viewHistory.cursor + 1);
  }
  const snap = histSnapshot();
  // avoid duplicate consecutive entries
  const last = viewHistory.stack[viewHistory.cursor];
  if (last && JSON.stringify(last) === JSON.stringify(snap)) return;
  viewHistory.stack.push(snap);
  viewHistory.cursor = viewHistory.stack.length - 1;
  updateHistBtns();
}

function updateHistBtns() {
  const back = $('#histBack');
  const fwd = $('#histFwd');
  if (!back) return;
  back.disabled = viewHistory.cursor <= 0;
  fwd.disabled = viewHistory.cursor >= viewHistory.stack.length - 1;
}

async function histRestore(snap) {
  viewHistory._navigating = true;
  state.view = snap.view;
  state.detailPlaylistId = snap.playlistId ?? null;
  state.detailGroup = snap.group ?? null;
  state.search = snap.search ?? '';
  state.libraryTab = snap.libraryTab ?? 'songs';

  // sync search input
  const si = $('#searchInput');
  if (si) si.value = state.search;

  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === snap.view));
  $$('.navbtn').forEach(b => b.classList.toggle('active', b.dataset.view === snap.view));

  if (snap.view === 'home') renderHome();
  if (snap.view === 'library') renderLibrary();
  if (snap.view === 'search') renderSearchResults();
  if (snap.view === 'playlist') renderPlaylistDetail();
  if (snap.view === 'group') renderGroupDetail();
  renderSidebar();
  viewHistory._navigating = false;
  updateHistBtns();
}

/* -------------------- View routing -------------------- */
function showView(name) {
  state.view = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
  $$('.navbtn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'home') renderHome();
  if (name === 'library') renderLibrary();
  histPush();
}
function openPlaylist(pid) {
  state.detailPlaylistId = pid;
  state.view = 'playlist';
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === 'playlist'));
  $$('.navbtn').forEach(b => b.classList.remove('active'));
  renderPlaylistDetail();
  renderSidebar();
  histPush();
}
function openGroup(kind, key, artist) {
  state.detailGroup = { kind, key, artist };
  state.view = 'group';
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === 'group'));
  $$('.navbtn').forEach(b => b.classList.remove('active'));
  renderGroupDetail();
  histPush();
}

/* -------------------- Playback -------------------- */
const audio = $('#audio');

let audioCtx = null;
let audioSource = null;
let analyser = null;
let eqNodes = [];
let eqEnabledNode = null;

// Spatial effect nodes
let spatialEffect = 'none';
let pannerNode = null;
let convolverNode = null;
let spatialGain = null;
let dryGain = null;
let wetGain = null;
let spatialRAF = null;
let spatialAngle = 0;

const SPATIAL_DESCRIPTIONS = {
  none: 'Normal stereo playback',
  '3d':  '3D — gentle rotating stereo field',
  '8d':  '8D — wide circular head-motion panning',
  room:  'Closed Room — intimate reverb simulation',
  hall:  'Concert Hall — large reverb with long tail',
  cave:  'Cave — deep cavernous echo',
};

// Generate synthetic impulse responses for convolver reverb effects
function makeImpulseResponse(duration, decay, reverse, sampleRate) {
  const length = Math.floor(sampleRate * duration);
  const buf = audioCtx.createBuffer(2, length, sampleRate);
  for (let c = 0; c < 2; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < length; i++) {
      const n = reverse ? length - i : i;
      ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, decay);
    }
  }
  return buf;
}

function buildConvolver(duration, decay) {
  const conv = audioCtx.createConvolver();
  conv.buffer = makeImpulseResponse(duration, decay, false, audioCtx.sampleRate);
  return conv;
}

function stopSpatialRAF() {
  if (spatialRAF) { cancelAnimationFrame(spatialRAF); spatialRAF = null; }
}

function startPanningLoop(speed) {
  // speed: radians per frame
  stopSpatialRAF();
  const loop = () => {
    if (!pannerNode) return;
    spatialAngle += speed;
    const x = Math.sin(spatialAngle);
    const z = Math.cos(spatialAngle);
    try {
      pannerNode.positionX.setValueAtTime(x * 3, audioCtx.currentTime);
      pannerNode.positionZ.setValueAtTime(z * 3, audioCtx.currentTime);
    } catch(e) {
      // fallback for older browsers
      pannerNode.setPosition(x * 3, 0, z * 3);
    }
    spatialRAF = requestAnimationFrame(loop);
  };
  loop();
}

function applySpatialEffect(name) {
  if (!audioCtx) return;
  spatialEffect = name;
  stopSpatialRAF();

  // Disconnect everything
  try { audioSource.disconnect(); } catch(e) {}
  try { if (pannerNode) pannerNode.disconnect(); } catch(e) {}
  try { if (convolverNode) convolverNode.disconnect(); } catch(e) {}
  try { if (dryGain) dryGain.disconnect(); } catch(e) {}
  try { if (wetGain) wetGain.disconnect(); } catch(e) {}
  try { if (spatialGain) spatialGain.disconnect(); } catch(e) {}
  try { eqNodes.forEach(n => n.disconnect()); } catch(e) {}
  try { analyser.disconnect(); } catch(e) {}

  pannerNode = null; convolverNode = null;
  dryGain = null; wetGain = null; spatialGain = null;

  const eqEnabled = $('#eqEnabled')?.checked ?? true;
  const eqOut = eqEnabled ? eqNodes[eqNodes.length - 1] : null;

  // Source -> (optional EQ) -> effectChain -> analyser -> destination
  function connectSource(dest) {
    if (eqEnabled && eqNodes.length) {
      audioSource.connect(eqNodes[0]);
      for (let i = 0; i < eqNodes.length - 1; i++) eqNodes[i].connect(eqNodes[i + 1]);
      eqNodes[eqNodes.length - 1].connect(dest);
    } else {
      audioSource.connect(dest);
    }
  }

  if (name === 'none') {
    connectSource(analyser);
    analyser.connect(audioCtx.destination);

  } else if (name === '3d' || name === '8d') {
    pannerNode = audioCtx.createPanner();
    pannerNode.panningModel = 'HRTF';
    pannerNode.distanceModel = 'linear';
    pannerNode.maxDistance = 10;
    pannerNode.refDistance = 1;
    pannerNode.rolloffFactor = 1;
    // listener
    audioCtx.listener.setPosition(0, 0, 0);
    try { audioCtx.listener.forwardX?.setValueAtTime(0, audioCtx.currentTime); } catch(e) {}

    connectSource(pannerNode);
    pannerNode.connect(analyser);
    analyser.connect(audioCtx.destination);

    const speed = name === '8d' ? 0.012 : 0.005;
    startPanningLoop(speed);

  } else {
    // Room / Hall / Cave — convolver reverb with dry/wet mix
    const configs = {
      room: { dur: 0.6,  decay: 4.0, wet: 0.45 },
      hall: { dur: 2.8,  decay: 2.5, wet: 0.55 },
      cave: { dur: 4.5,  decay: 1.8, wet: 0.65 },
    };
    const cfg = configs[name] || configs.room;

    convolverNode = buildConvolver(cfg.dur, cfg.decay);
    dryGain = audioCtx.createGain();
    wetGain = audioCtx.createGain();
    dryGain.gain.value = 1 - cfg.wet;
    wetGain.gain.value = cfg.wet;

    // source -> dry + wet(convolver) -> analyser
    const merger = audioCtx.createGain(); // just a mixing node
    connectSource(dryGain);
    connectSource(convolverNode);
    dryGain.connect(merger);
    convolverNode.connect(wetGain);
    wetGain.connect(merger);
    merger.connect(analyser);
    analyser.connect(audioCtx.destination);
  }

  // Update UI
  $$('.spatial-btn').forEach(b => b.classList.toggle('active', b.dataset.effect === name));
  const info = $('#spatialInfo');
  if (info) info.textContent = SPATIAL_DESCRIPTIONS[name] || '';
}

function setupAudioGraph() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioSource = audioCtx.createMediaElementSource(audio);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;

  // 5-band EQ
  const freqs = [60, 230, 910, 4000, 14000];
  eqNodes = freqs.map((f, i) => {
    const filter = audioCtx.createBiquadFilter();
    if (i === 0) filter.type = 'lowshelf';
    else if (i === freqs.length - 1) filter.type = 'highshelf';
    else filter.type = 'peaking';
    filter.frequency.value = f;
    filter.Q.value = 1;
    filter.gain.value = 0;
    return filter;
  });

  // Connect: source -> eq chain -> analyser -> destination
  reconnectGraph(true);
}

function reconnectGraph(eqEnabled) {
  // Re-apply current spatial effect (which handles EQ routing too)
  applySpatialEffect(spatialEffect);
}

// Shuffle state for "play all, no repeats" mode
const shuffleState = {
  bag: [],       // remaining unplayed ids in current shuffle cycle
  history: [],   // played ids in current cycle
};

function buildShuffleBag(ids, startId) {
  // Fisher-Yates shuffle, put startId first
  const arr = ids.filter(x => x !== startId);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  shuffleState.bag = arr;
  shuffleState.history = startId ? [startId] : [];
}

function playSong(id, list) {
  const s = state.songs.find(x => x.id === id);
  if (!s) return;
  setupAudioGraph();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  if (list && list.length) state.queue = list.slice();
  else if (!state.queue.length) state.queue = state.songs.map(x => x.id);
  state.queueIndex = state.queue.indexOf(id);
  state.currentId = id;
  audio.src = s.audioUrl;
  audio.play().catch(err => console.warn('play err', err));
  $('#playBtn').innerHTML = '<i class="fa-solid fa-pause"></i>';

  // update UI
  $('#playerTitle').textContent = s.title;
  $('#playerArtist').textContent = `${s.artist} · ${s.album}`;
  const pc = $('#playerCover');
  pc.innerHTML = s.coverUrl ? `<img src="${s.coverUrl}" alt="" />` : '<i class="fa-solid fa-music"></i>';

  // recent
  state.recent = [id, ...state.recent.filter(x => x !== id)].slice(0, 20);
  saveMeta();
  updateLikeBtn();
  renderSidebar();
  renderCurrentView();
  renderQueuePanel();
  updateAmbient();
}

function togglePlay() {
  if (!state.currentId) {
    if (state.songs.length) playSong(state.songs[0].id, state.songs.map(s => s.id));
    return;
  }
  if (audio.paused) { audio.play(); $('#playBtn').innerHTML = '<i class="fa-solid fa-pause"></i>'; }
  else { audio.pause(); $('#playBtn').innerHTML = '<i class="fa-solid fa-play"></i>'; }
}
function stop() {
  audio.pause(); audio.src = '';
  state.currentId = null;
  $('#playBtn').innerHTML = '<i class="fa-solid fa-play"></i>';
}
function next() {
  if (!state.queue.length) return;
  if (state.shuffle) {
    // If bag is empty, refill (new cycle) - no repeats within a cycle
    if (shuffleState.bag.length === 0) {
      buildShuffleBag(state.queue, null);
    }
    const nextId = shuffleState.bag.shift();
    if (!nextId) return;
    shuffleState.history.push(nextId);
    state.queueIndex = state.queue.indexOf(nextId);
    playSong(nextId, state.queue);
  } else {
    state.queueIndex = (state.queueIndex + 1) % state.queue.length;
    playSong(state.queue[state.queueIndex], state.queue);
  }
}
function prev() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (state.shuffle && shuffleState.history.length > 1) {
    // go back in shuffle history
    shuffleState.bag.unshift(shuffleState.history.pop()); // put current back
    const prevId = shuffleState.history[shuffleState.history.length - 1];
    state.queueIndex = state.queue.indexOf(prevId);
    playSong(prevId, state.queue);
  } else {
    state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
    playSong(state.queue[state.queueIndex], state.queue);
  }
}
function updateLikeBtn() {
  const btn = $('#likeBtn');
  if (!state.currentId) { btn.classList.remove('liked'); btn.querySelector('i').className = 'fa-regular fa-heart'; return; }
  const liked = state.liked.has(state.currentId);
  btn.classList.toggle('liked', liked);
  btn.querySelector('i').className = liked ? 'fa-solid fa-heart' : 'fa-regular fa-heart';
}

audio.addEventListener('timeupdate', () => {
  const cur = audio.currentTime, dur = audio.duration || 0;
  $('#curTime').textContent = fmtTime(cur);
  $('#durTime').textContent = fmtTime(dur);
  const pct = dur > 0 ? (cur / dur) * 100 : 0;
  $('#seekFill').style.width = `${pct}%`;
  $('#seekHandle').style.left = `${pct}%`;
});
audio.addEventListener('ended', () => {
  if (state.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (state.repeat === 'all' || state.shuffle || state.queueIndex < state.queue.length - 1) next();
  else { $('#playBtn').innerHTML = '<i class="fa-solid fa-play"></i>'; }
});

/* -------------------- Equalizer UI -------------------- */
const EQ_PRESETS = {
  flat:     [0,0,0,0,0],
  rock:     [4,2,-2,3,4],
  pop:      [-1,2,4,1,-1],
  jazz:     [2,1,1,2,3],
  classical:[3,2,-1,2,3],
  bass:     [7,5,1,0,0],
  vocal:    [-2,0,3,4,1],
};
function buildEqBands() {
  const wrap = $('#eqBands');
  wrap.innerHTML = '';
  const labels = ['60Hz','230Hz','910Hz','4kHz','14kHz'];
  labels.forEach((lab, i) => {
    const band = el(`
      <div class="eqband">
        <div class="eqband__val" data-i="${i}">0 dB</div>
        <input type="range" min="-12" max="12" step="0.5" value="0" class="eqband__slider" data-i="${i}" data-testid="eq-band-${i}" orient="vertical" />
        <div class="eqband__hz">${lab}</div>
      </div>`);
    wrap.appendChild(band);
    band.querySelector('input').addEventListener('input', (e) => {
      const idx = +e.target.dataset.i;
      const v = +e.target.value;
      band.querySelector('.eqband__val').textContent = `${v > 0 ? '+' : ''}${v} dB`;
      if (eqNodes[idx]) eqNodes[idx].gain.value = v;
      // Mark "Flat" preset inactive if user moved
      $$('.eqpresets .chip').forEach(c => c.classList.remove('active'));
    });
  });
}
function applyPreset(name) {
  const vals = EQ_PRESETS[name] || EQ_PRESETS.flat;
  vals.forEach((v, i) => {
    const slider = $$('#eqBands input')[i];
    if (slider) {
      slider.value = v;
      $$('#eqBands .eqband__val')[i].textContent = `${v > 0 ? '+' : ''}${v} dB`;
    }
    if (eqNodes[i]) eqNodes[i].gain.value = v;
  });
  $$('.eqpresets .chip').forEach(c => c.classList.toggle('active', c.dataset.preset === name));
}

/* -------------------- Queue Panel -------------------- */
function renderQueuePanel() {
  const list = $('#queueList');
  list.innerHTML = '';
  if (!state.queue.length) {
    list.appendChild(el(`<div class="empty" style="margin: 16px;">Queue is empty.</div>`));
    return;
  }
  state.queue.forEach((id, i) => {
    const s = state.songs.find(x => x.id === id);
    if (!s) return;
    const playing = id === state.currentId;
    const row = el(`
      <div class="queueRow${playing ? ' playing' : ''}" data-testid="queue-row-${id}">
        <div class="queueRow__cover">${s.coverUrl ? `<img src="${s.coverUrl}" />` : '<i class="fa-solid fa-music"></i>'}</div>
        <div>
          <div class="queueRow__title">${escHtml(s.title)}</div>
          <div class="queueRow__artist">${escHtml(s.artist)}</div>
        </div>
        <div class="queueRow__time">${fmtTime(s.duration)}</div>
        <button class="iconbtn" title="Remove"><i class="fa-solid fa-xmark"></i></button>
      </div>`);
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) {
        state.queue.splice(i, 1);
        if (i < state.queueIndex) state.queueIndex--;
        renderQueuePanel();
        return;
      }
      state.queueIndex = i;
      playSong(id, state.queue);
    });
    list.appendChild(row);
  });
}

/* -------------------- Context menu -------------------- */
function openCtxMenu(e, songId) {
  const menu = $('#ctxMenu');
  state.ctxSongId = songId;
  menu.classList.remove('hidden');
  const x = Math.min(e.clientX, window.innerWidth - 220);
  const y = Math.min(e.clientY, window.innerHeight - 240);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}
function closeCtxMenu() { $('#ctxMenu').classList.add('hidden'); state.ctxSongId = null; }

/* -------------------- Add-to-playlist modal -------------------- */
function openAddToPlaylist(songId) {
  state.ctxSongId = songId;
  const list = $('#addPlaylistList');
  list.innerHTML = '';
  const liked = el(`
    <div class="plitem plitem--liked">
      <span class="plitem__icon"><i class="fa-solid fa-heart"></i></span>
      <span class="plitem__name">Liked Songs</span>
    </div>`);
  liked.addEventListener('click', () => { addSongToPlaylist(LIKED_ID, songId); closeModal('addToPlaylistModal'); });
  list.appendChild(liked);
  state.playlists.forEach(p => {
    const n = el(`
      <div class="plitem">
        <span class="plitem__icon"><i class="fa-solid fa-music"></i></span>
        <span class="plitem__name">${escHtml(p.name)}</span>
        <span class="plitem__count">${p.songIds.length}</span>
      </div>`);
    n.addEventListener('click', () => { addSongToPlaylist(p.id, songId); closeModal('addToPlaylistModal'); });
    list.appendChild(n);
  });
  openModal('addToPlaylistModal');
}

function openModal(id) { $(`#${id}`).classList.remove('hidden'); }
function closeModal(id) { $(`#${id}`).classList.add('hidden'); }

/* -------------------- Theme -------------------- */
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('vibestream:theme', next);
  $('#themeBtn').innerHTML = next === 'dark'
    ? '<i class="fa-solid fa-moon"></i>'
    : '<i class="fa-solid fa-sun"></i>';
}
function initTheme() {
  const saved = localStorage.getItem('vibestream:theme') || 'dark';
  document.documentElement.dataset.theme = saved;
  $('#themeBtn').innerHTML = saved === 'dark'
    ? '<i class="fa-solid fa-moon"></i>'
    : '<i class="fa-solid fa-sun"></i>';
}

/* -------------------- Voice search -------------------- */
let recog = null;
function ensureRecog() {
  if (recog) return recog;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  recog = new SR();
  recog.lang = 'en-US';
  recog.continuous = false;
  recog.interimResults = true;
  recog.onresult = (e) => {
    const text = Array.from(e.results).map(r => r[0].transcript).join('');
    $('#voiceHeard').textContent = `"${text}"`;
    if (e.results[0].isFinal) {
      processVoiceCommand(text.trim());
      closeModal('voiceModal');
      $('#micBtn').classList.remove('active');
    }
  };
  recog.onerror = () => { closeModal('voiceModal'); $('#micBtn').classList.remove('active'); toast('Voice unavailable'); };
  recog.onend = () => { $('#micBtn').classList.remove('active'); closeModal('voiceModal'); };
  return recog;
}
function startVoiceSearch() {
  const r = ensureRecog();
  if (!r) { toast('Voice not supported in this browser'); return; }
  $('#voiceHeard').innerHTML = 'Say "play <em>song</em>" or "open library"';
  openModal('voiceModal');
  $('#micBtn').classList.add('active');
  try { r.start(); } catch (e) {}
}
function processVoiceCommand(text) {
  const t = text.toLowerCase();
  if (/\b(open|go to|show)\s+library\b/.test(t)) { showView('library'); return; }
  if (/\b(open|go to|show)\s+home\b/.test(t)) { showView('home'); return; }
  if (/\b(pause|stop)\b/.test(t)) { audio.pause(); $('#playBtn').innerHTML = '<i class="fa-solid fa-play"></i>'; return; }
  if (/\bnext\b/.test(t)) { next(); return; }
  if (/\bprevious|prev\b/.test(t)) { prev(); return; }
  const m = t.match(/\bplay\s+(.+)$/);
  const query = m ? m[1].replace(/^by\s+/, '') : t;
  $('#searchInput').value = query;
  state.search = query; showView('search'); renderSearchResults();
  const match = state.songs.find(s =>
    s.title.toLowerCase().includes(query) ||
    s.artist.toLowerCase().includes(query) ||
    s.album.toLowerCase().includes(query)
  );
  if (match) playSong(match.id, state.songs.map(s => s.id));
  else toast(`No song matches "${query}"`);
}

/* -------------------- Ambient + Visualizer state -------------------- */
let ambientRAF = null;
let visualizerRAF = null;
const ambientState = {
  active: false,
  palette: [
    { r: 255, g: 93, b: 143 },
    { r: 156, g: 107, b: 255 },
    { r: 79, g: 209, b: 197 },
    { r: 255, g: 209, b: 102 },
  ],
  particles: [],
  blobs: [],
  drops: [],
  glitter: [],
  lastBeat: 0,
};
const vizState = {
  active: false,
  mode: 'bars',
};

function setupAmbientCanvases() {
  const c = $('#ambientCanvas');
  const fx = $('#ambientFx');
  const v = $('#vizCanvas');
  const resize = () => {
    [c, fx].forEach(el => { el.width = window.innerWidth * devicePixelRatio; el.height = window.innerHeight * devicePixelRatio; });
    v.width = window.innerWidth * devicePixelRatio;
    v.height = 240;
  };
  resize();
  window.addEventListener('resize', resize);

  // blobs (color washes)
  ambientState.blobs = Array.from({ length: 5 }).map((_, i) => ({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    r: 240 + Math.random() * 260,
    vx: (Math.random() - 0.5) * 0.6,
    vy: (Math.random() - 0.5) * 0.6,
    ci: i,
  }));
  // dust particles (mids reactive)
  ambientState.particles = Array.from({ length: 120 }).map(() => ({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    r: Math.random() * 2 + 0.5,
    vx: (Math.random() - 0.5) * 0.3,
    vy: (Math.random() - 0.5) * 0.3,
    a: Math.random() * 0.6 + 0.3,
  }));
  // Holi drops — colorful blobs falling from top
  ambientState.drops = [];
  // glitter sparks (highs reactive)
  ambientState.glitter = Array.from({ length: 80 }).map(() => ({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    s: Math.random() * 1.6 + 0.4,
    a: 0,
    life: 0,
  }));
}

function spawnDrop() {
  const pal = ambientState.palette;
  const c = pal[Math.floor(Math.random() * pal.length)];
  ambientState.drops.push({
    x: Math.random() * window.innerWidth,
    y: -40,
    vy: 1.4 + Math.random() * 2.6,
    vx: (Math.random() - 0.5) * 1.2,
    r: 6 + Math.random() * 14,
    color: c,
    trail: [],
    alpha: 0.85,
    bursts: [],
    splashed: false,
  });
}

// Cover palette extraction (4 dominant clusters)
function extractCoverPalette(imgEl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      const SZ = 32;
      c.width = SZ; c.height = SZ;
      const ctx = c.getContext('2d');
      try {
        ctx.drawImage(img, 0, 0, SZ, SZ);
        const data = ctx.getImageData(0, 0, SZ, SZ).data;
        // bucketize by quantizing to 4 bits per channel
        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i+1], b = data[i+2];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          if (max < 28 || min > 232) continue; // skip near-black/near-white
          const key = `${r>>4}_${g>>4}_${b>>4}`;
          const cur = buckets.get(key) || { r:0, g:0, b:0, n:0 };
          cur.r += r; cur.g += g; cur.b += b; cur.n += 1;
          buckets.set(key, cur);
        }
        let arr = Array.from(buckets.values())
          .map(o => ({ r: Math.round(o.r/o.n), g: Math.round(o.g/o.n), b: Math.round(o.b/o.n), n: o.n }))
          .sort((a,b) => b.n - a.n);
        // boost saturation a bit
        arr = arr.map(c => boostSat(c, 1.25));
        if (arr.length < 4) {
          while (arr.length < 4) arr.push({ r: 255, g: 138, b: 61 });
        }
        resolve(arr.slice(0, 6));
      } catch (e) {
        resolve([{r:255,g:93,b:143},{r:156,g:107,b:255},{r:79,g:209,b:197},{r:255,g:209,b:102}]);
      }
    };
    img.onerror = () => resolve([{r:255,g:93,b:143},{r:156,g:107,b:255},{r:79,g:209,b:197},{r:255,g:209,b:102}]);
    img.src = imgEl.src;
  });
}
function boostSat({r,g,b}, k=1.2) {
  const avgC = (r+g+b)/3;
  return {
    r: Math.max(0, Math.min(255, Math.round(avgC + (r - avgC) * k))),
    g: Math.max(0, Math.min(255, Math.round(avgC + (g - avgC) * k))),
    b: Math.max(0, Math.min(255, Math.round(avgC + (b - avgC) * k))),
  };
}

async function updateAmbient() {
  const s = state.songs.find(x => x.id === state.currentId);
  if (!s) return;
  $('#ambientTitle').textContent = s.title;
  $('#ambientArtist').textContent = `${s.artist} · ${s.album}`;
  const ac = $('#ambientCover');
  ac.innerHTML = s.coverUrl ? `<img src="${s.coverUrl}" />` : '<i class="fa-solid fa-music"></i>';
  if (s.coverUrl) {
    const img = ac.querySelector('img');
    const pal = await extractCoverPalette(img);
    ambientState.palette = pal;
    const [c0] = pal;
    ac.style.setProperty('--cover-glow', `rgba(${c0.r}, ${c0.g}, ${c0.b}, 0.55)`);
  } else {
    ambientState.palette = [
      { r: 255, g: 93, b: 143 },
      { r: 156, g: 107, b: 255 },
      { r: 79, g: 209, b: 197 },
      { r: 255, g: 209, b: 102 },
    ];
  }
}

function openAmbient() {
  $('#ambient').classList.remove('hidden');
  ambientState.active = true;
  if (!ambientState.blobs.length) setupAmbientCanvases();
  updateAmbient();
  startAmbientLoop();
}
function closeAmbient() {
  $('#ambient').classList.add('hidden');
  ambientState.active = false;
  if (ambientRAF) cancelAnimationFrame(ambientRAF);
}

function startAmbientLoop() {
  const c = $('#ambientCanvas');
  const fx = $('#ambientFx');
  const v = $('#vizCanvas');
  const ctx = c.getContext('2d');
  const fctx = fx.getContext('2d');
  const vctx = v.getContext('2d');
  const W = () => c.width;
  const H = () => c.height;
  const dpr = devicePixelRatio || 1;

  const freqData = new Uint8Array(analyser ? analyser.frequencyBinCount : 128);
  let dropTimer = 0;
  let beatGate = 0;

  const loop = () => {
    if (!ambientState.active) return;
    if (analyser) analyser.getByteFrequencyData(freqData);
    const bass = analyser ? avg(freqData, 0, 12) / 255 : 0.2;
    const mids = analyser ? avg(freqData, 12, 60) / 255 : 0.2;
    const highs = analyser ? avg(freqData, 60, 128) / 255 : 0.2;

    // beat detection (simple)
    const now = performance.now();
    const isBeat = bass > 0.6 && now - beatGate > 220;
    if (isBeat) beatGate = now;

    /* ----- Layer 1: color wash blobs ----- */
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(0, 0, W(), H());
    ambientState.blobs.forEach((b) => {
      b.x += b.vx * (1 + bass * 2);
      b.y += b.vy * (1 + bass * 2);
      if (b.x < -300 || b.x > window.innerWidth + 300) b.vx *= -1;
      if (b.y < -300 || b.y > window.innerHeight + 300) b.vy *= -1;
      const col = ambientState.palette[b.ci % ambientState.palette.length];
      const radius = (b.r + bass * 220) * dpr;
      const x = b.x * dpr, y = b.y * dpr;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
      grad.addColorStop(0, `rgba(${col.r}, ${col.g}, ${col.b}, ${0.55 + bass * 0.3})`);
      grad.addColorStop(0.4, `rgba(${col.r}, ${col.g}, ${col.b}, 0.18)`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
    });
    // dust
    ambientState.particles.forEach(p => {
      p.x += p.vx + (mids - 0.2) * 0.6;
      p.y += p.vy;
      if (p.x < 0) p.x = window.innerWidth; else if (p.x > window.innerWidth) p.x = 0;
      if (p.y < 0) p.y = window.innerHeight; else if (p.y > window.innerHeight) p.y = 0;
      ctx.beginPath();
      const size = (p.r + highs * 1.5) * dpr;
      ctx.arc(p.x * dpr, p.y * dpr, size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${p.a * (0.35 + highs * 0.65)})`;
      ctx.fill();
    });

    /* ----- Layer 2 (FX canvas): Holi drops + glitter + beat bursts ----- */
    fctx.clearRect(0, 0, W(), H());
    // Spawn drops based on tempo / mids
    dropTimer += 1 + Math.floor(mids * 4) + (isBeat ? 6 : 0);
    while (dropTimer >= 14) {
      dropTimer -= 14;
      if (ambientState.drops.length < 60) spawnDrop();
    }
    // Drops
    for (let i = ambientState.drops.length - 1; i >= 0; i--) {
      const d = ambientState.drops[i];
      d.trail.push({ x: d.x, y: d.y, r: d.r * 0.9 });
      if (d.trail.length > 8) d.trail.shift();
      d.x += d.vx;
      d.y += d.vy * (1 + bass * 0.8);
      // trail
      d.trail.forEach((t, ti) => {
        const a = (ti / d.trail.length) * 0.5 * d.alpha;
        fctx.beginPath();
        fctx.arc(t.x * dpr, t.y * dpr, t.r * (0.6 + ti/d.trail.length * 0.4) * dpr, 0, Math.PI * 2);
        fctx.fillStyle = `rgba(${d.color.r}, ${d.color.g}, ${d.color.b}, ${a})`;
        fctx.fill();
      });
      // head
      fctx.beginPath();
      fctx.arc(d.x * dpr, d.y * dpr, d.r * dpr, 0, Math.PI * 2);
      const g = fctx.createRadialGradient(d.x * dpr, d.y * dpr, 0, d.x * dpr, d.y * dpr, d.r * dpr);
      g.addColorStop(0, `rgba(${d.color.r}, ${d.color.g}, ${d.color.b}, ${d.alpha})`);
      g.addColorStop(0.6, `rgba(${d.color.r}, ${d.color.g}, ${d.color.b}, ${d.alpha * 0.6})`);
      g.addColorStop(1, `rgba(${d.color.r}, ${d.color.g}, ${d.color.b}, 0)`);
      fctx.fillStyle = g;
      fctx.fill();
      // splash at bottom
      if (!d.splashed && d.y > window.innerHeight - 40) {
        d.splashed = true;
        for (let k = 0; k < 14; k++) {
          d.bursts.push({
            x: d.x, y: d.y,
            vx: (Math.random() - 0.5) * 6,
            vy: -Math.random() * 6 - 2,
            life: 30 + Math.random() * 20,
            r: 2 + Math.random() * 3,
          });
        }
      }
      // bursts
      if (d.bursts.length) {
        d.bursts.forEach(b => {
          b.x += b.vx;
          b.y += b.vy;
          b.vy += 0.25;
          b.life -= 1;
          if (b.life > 0) {
            fctx.beginPath();
            fctx.arc(b.x * dpr, b.y * dpr, b.r * dpr, 0, Math.PI * 2);
            fctx.fillStyle = `rgba(${d.color.r}, ${d.color.g}, ${d.color.b}, ${b.life / 40})`;
            fctx.fill();
          }
        });
        d.bursts = d.bursts.filter(b => b.life > 0);
      }
      if (d.y > window.innerHeight + 40 && (!d.bursts.length)) ambientState.drops.splice(i, 1);
    }

    // Glitter sparkles (highs reactive)
    ambientState.glitter.forEach(p => {
      if (p.life <= 0) {
        if (Math.random() < 0.04 + highs * 0.3) {
          p.x = Math.random() * window.innerWidth;
          p.y = Math.random() * window.innerHeight;
          p.life = 30 + Math.random() * 30;
          p.a = 1;
        }
        return;
      }
      p.life -= 1;
      const alpha = (p.life / 60) * (0.6 + highs * 0.5);
      const size = p.s * (1 + highs * 2) * dpr;
      // diamond sparkle
      fctx.save();
      fctx.translate(p.x * dpr, p.y * dpr);
      fctx.rotate(Math.PI / 4);
      fctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      fctx.fillRect(-size, -size * 4, size * 2, size * 8);
      fctx.fillRect(-size * 4, -size, size * 8, size * 2);
      fctx.restore();
    });

    // Beat shockwave ring from center
    if (isBeat) {
      const cx = window.innerWidth / 2 * dpr;
      const cy = window.innerHeight / 2 * dpr;
      const col = ambientState.palette[0];
      fctx.strokeStyle = `rgba(${col.r}, ${col.g}, ${col.b}, 0.6)`;
      fctx.lineWidth = 3 * dpr;
      fctx.beginPath();
      fctx.arc(cx, cy, 80 * dpr, 0, Math.PI * 2);
      fctx.stroke();
    }

    /* ----- Bottom viz bars ----- */
    vctx.clearRect(0, 0, v.width, v.height);
    const bars = 64;
    const step = Math.floor(freqData.length / bars);
    const bw = v.width / bars;
    for (let i = 0; i < bars; i++) {
      const val = freqData[i * step] || 0;
      const bh = (val / 255) * v.height * 0.95;
      const x = i * bw;
      const col = ambientState.palette[i % ambientState.palette.length];
      const grd = vctx.createLinearGradient(0, v.height, 0, 0);
      grd.addColorStop(0, `rgba(${col.r},${col.g},${col.b},0.9)`);
      grd.addColorStop(1, `rgba(255,255,255,0.5)`);
      vctx.fillStyle = grd;
      vctx.fillRect(x + 1, v.height - bh, bw - 2, bh);
    }

    ambientRAF = requestAnimationFrame(loop);
  };
  loop();
}
function avg(arr, a, b) { let s = 0; for (let i = a; i < b; i++) s += arr[i]; return s / (b - a); }

/* -------------------- Visualizer mode (fullscreen) -------------------- */
function openVisualizer() {
  setupAudioGraph();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  $('#visualizer').classList.remove('hidden');
  vizState.active = true;
  if (!ambientState.palette.length || ambientState.palette.length < 4) updateAmbient();
  resizeVizCanvas();
  startVisualizerLoop();
}
function closeVisualizer() {
  $('#visualizer').classList.add('hidden');
  vizState.active = false;
  if (visualizerRAF) cancelAnimationFrame(visualizerRAF);
}
function resizeVizCanvas() {
  const c = $('#visualizerCanvas');
  c.width = window.innerWidth * devicePixelRatio;
  c.height = window.innerHeight * devicePixelRatio;
}
window.addEventListener('resize', () => { if (vizState.active) resizeVizCanvas(); });

function startVisualizerLoop() {
  const c = $('#visualizerCanvas');
  const ctx = c.getContext('2d');
  const dpr = devicePixelRatio || 1;
  const freqData = new Uint8Array(analyser ? analyser.frequencyBinCount : 128);
  const waveData = new Uint8Array(analyser ? analyser.fftSize : 256);

  const loop = () => {
    if (!vizState.active) return;
    if (analyser) {
      analyser.getByteFrequencyData(freqData);
      analyser.getByteTimeDomainData(waveData);
    }
    // trailing fade
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    ctx.fillRect(0, 0, c.width, c.height);

    const W = c.width, H = c.height;
    const cx = W / 2, cy = H / 2;
    const pal = ambientState.palette;

    if (vizState.mode === 'bars') {
      const bars = 96;
      const step = Math.floor(freqData.length / bars);
      const bw = W / bars;
      for (let i = 0; i < bars; i++) {
        const val = freqData[i * step] || 0;
        const bh = (val / 255) * H * 0.7;
        const col = pal[i % pal.length];
        const grd = ctx.createLinearGradient(0, H, 0, H - bh);
        grd.addColorStop(0, `rgba(${col.r},${col.g},${col.b},0.95)`);
        grd.addColorStop(1, `rgba(255,255,255,0.8)`);
        ctx.fillStyle = grd;
        ctx.fillRect(i * bw + 2, H - bh, bw - 4, bh);
        // mirror top
        const grd2 = ctx.createLinearGradient(0, 0, 0, bh);
        grd2.addColorStop(0, `rgba(${col.r},${col.g},${col.b},0.3)`);
        grd2.addColorStop(1, `rgba(${col.r},${col.g},${col.b},0)`);
        ctx.fillStyle = grd2;
        ctx.fillRect(i * bw + 2, 0, bw - 4, bh * 0.4);
      }
    } else if (vizState.mode === 'wave') {
      ctx.lineWidth = 3 * dpr;
      const col = pal[0];
      ctx.strokeStyle = `rgba(${col.r},${col.g},${col.b},0.95)`;
      ctx.shadowColor = `rgba(${col.r},${col.g},${col.b},0.6)`;
      ctx.shadowBlur = 24 * dpr;
      ctx.beginPath();
      const slice = W / waveData.length;
      for (let i = 0; i < waveData.length; i++) {
        const v = waveData[i] / 128.0;
        const y = (v * H) / 2;
        const x = i * slice;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      // second wave (mids)
      const col2 = pal[2 % pal.length];
      ctx.strokeStyle = `rgba(${col2.r},${col2.g},${col2.b},0.6)`;
      ctx.beginPath();
      for (let i = 0; i < waveData.length; i++) {
        const v = waveData[i] / 128.0;
        const y = (v * H) / 2 + 60 * dpr;
        const x = i * slice;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else if (vizState.mode === 'circle') {
      const bars = 96;
      const step = Math.floor(freqData.length / bars);
      const baseR = Math.min(W, H) * 0.18;
      for (let i = 0; i < bars; i++) {
        const val = freqData[i * step] || 0;
        const len = (val / 255) * Math.min(W, H) * 0.22;
        const angle = (i / bars) * Math.PI * 2;
        const x1 = cx + Math.cos(angle) * baseR;
        const y1 = cy + Math.sin(angle) * baseR;
        const x2 = cx + Math.cos(angle) * (baseR + len);
        const y2 = cy + Math.sin(angle) * (baseR + len);
        const col = pal[i % pal.length];
        ctx.strokeStyle = `rgba(${col.r},${col.g},${col.b},0.95)`;
        ctx.lineWidth = 3 * dpr;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
      // inner ring
      const col0 = pal[0];
      ctx.strokeStyle = `rgba(${col0.r},${col0.g},${col0.b},0.4)`;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
      ctx.stroke();
    } else if (vizState.mode === 'grid') {
      const cols = 16, rows = 10;
      const gw = W / cols, gh = H / rows;
      for (let r = 0; r < rows; r++) {
        for (let cc = 0; cc < cols; cc++) {
          const i = (r * cols + cc) % freqData.length;
          const val = freqData[i] / 255;
          const col = pal[(r + cc) % pal.length];
          ctx.fillStyle = `rgba(${col.r},${col.g},${col.b},${val * 0.95})`;
          const m = 4 * dpr;
          ctx.fillRect(cc * gw + m, r * gh + m, gw - m * 2, gh - m * 2);
        }
      }
    }
    visualizerRAF = requestAnimationFrame(loop);
  };
  loop();
}

/* -------------------- Drag & drop -------------------- */
function setupDropzone() {
  const dz = $('#dropzone');
  ['dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('hover'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, () => dz.classList.remove('hover')));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files);
  });
  // Whole window drop too
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files);
  });
}

/* -------------------- Wire up events -------------------- */
function bindEvents() {
  // History nav back/forward
  $('#histBack').addEventListener('click', () => {
    if (viewHistory.cursor <= 0) return;
    viewHistory.cursor--;
    histRestore(viewHistory.stack[viewHistory.cursor]);
  });
  $('#histFwd').addEventListener('click', () => {
    if (viewHistory.cursor >= viewHistory.stack.length - 1) return;
    viewHistory.cursor++;
    histRestore(viewHistory.stack[viewHistory.cursor]);
  });

  // upload
  $('#uploadBtn').addEventListener('click', () => $('#fileInput').click());
  $('#dropzoneBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });

  // nav
  $$('.navbtn').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

  // tabs
  $$('.tab').forEach(t => t.addEventListener('click', () => { state.libraryTab = t.dataset.tab; renderLibrary(); }));

  // theme
  $('#themeBtn').addEventListener('click', toggleTheme);

  // search
  $('#searchInput').addEventListener('input', (e) => {
    state.search = e.target.value;
    if (state.search.trim()) {
      state.view = 'search';
      $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === 'search'));
      $$('.navbtn').forEach(b => b.classList.remove('active'));
      renderSearchResults();
      histPush();
    } else if (state.view === 'search') {
      showView('home');
    }
  });
  $('#micBtn').addEventListener('click', startVoiceSearch);
  $('#voiceCancel').addEventListener('click', () => { closeModal('voiceModal'); try { recog?.stop(); } catch(e){} });

  // new playlist
  $('#newPlaylistBtn').addEventListener('click', () => { $('#newPlaylistName').value = ''; $('#newPlaylistDesc').value = ''; openModal('createModal'); });
  $('#createPlaylistConfirm').addEventListener('click', async () => {
    const name = $('#newPlaylistName').value.trim();
    if (!name) { toast('Name required'); return; }
    const desc = $('#newPlaylistDesc').value.trim();
    await createPlaylist(name, desc);
    closeModal('createModal');
  });
  $('#openCreateFromAdd').addEventListener('click', () => {
    closeModal('addToPlaylistModal');
    $('#newPlaylistName').value = ''; $('#newPlaylistDesc').value = '';
    openModal('createModal');
  });

  // modal close buttons
  $$('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
  $$('.modal').forEach(m => m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));

  // player controls
  $('#playBtn').addEventListener('click', togglePlay);
  $('#nextBtn').addEventListener('click', next);
  $('#prevBtn').addEventListener('click', prev);
  $('#shuffleBtn').addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    $('#shuffleBtn').classList.toggle('active', state.shuffle);
    if (state.shuffle && state.queue.length) {
      buildShuffleBag(state.queue, state.currentId);
    }
    saveMeta();
  });
  $('#repeatBtn').addEventListener('click', () => {
    state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
    const btn = $('#repeatBtn');
    btn.classList.toggle('active', state.repeat !== 'off');
    btn.innerHTML = state.repeat === 'one'
      ? '<i class="fa-solid fa-repeat"></i><sup style="font-size:9px">1</sup>'
      : '<i class="fa-solid fa-repeat"></i>';
    saveMeta();
  });

  // seek
  const seekWrap = $('#seekWrap');
  let seeking = false;
  const seekTo = (clientX) => {
    const rect = seekWrap.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    if (audio.duration) audio.currentTime = pct * audio.duration;
  };
  seekWrap.addEventListener('mousedown', (e) => { seeking = true; seekTo(e.clientX); });
  window.addEventListener('mousemove', (e) => { if (seeking) seekTo(e.clientX); });
  window.addEventListener('mouseup', () => seeking = false);
  // Touch seek
  seekWrap.addEventListener('touchstart', (e) => { seeking = true; seekTo(e.touches[0].clientX); e.preventDefault(); }, { passive: false });
  window.addEventListener('touchmove', (e) => { if (seeking) seekTo(e.touches[0].clientX); }, { passive: true });
  window.addEventListener('touchend', () => seeking = false);

  // volume
  $('#volume').addEventListener('input', (e) => { audio.volume = +e.target.value; });

  // like
  $('#likeBtn').addEventListener('click', async () => {
    if (!state.currentId) return;
    if (state.liked.has(state.currentId)) state.liked.delete(state.currentId);
    else state.liked.add(state.currentId);
    await saveMeta();
    updateLikeBtn();
    renderSidebar();
    if (state.view === 'playlist' && state.detailPlaylistId === LIKED_ID) renderPlaylistDetail();
  });

  // EQ
  $('#eqBtn').addEventListener('click', () => { setupAudioGraph(); $('#eqPanel').classList.toggle('hidden'); $('#queuePanel').classList.add('hidden'); });
  $('#eqEnabled').addEventListener('change', (e) => { reconnectGraph(e.target.checked); });
  $$('.eqpresets .chip').forEach(c => c.addEventListener('click', () => applyPreset(c.dataset.preset)));

  // Spatial effects
  $$('.spatial-btn').forEach(b => b.addEventListener('click', () => {
    setupAudioGraph();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    applySpatialEffect(b.dataset.effect);
  }));

  // Queue
  $('#queueBtn').addEventListener('click', () => { $('#queuePanel').classList.toggle('hidden'); $('#eqPanel').classList.add('hidden'); renderQueuePanel(); });

  // Ambient
  $('#ambientBtn').addEventListener('click', () => { setupAudioGraph(); openAmbient(); });
  $('#ambientClose').addEventListener('click', closeAmbient);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (vizState.active) closeVisualizer();
      else if (ambientState.active) closeAmbient();
    }
  });

  // Visualizer (fullscreen, only viz visible)
  $('#vizBtn').addEventListener('click', openVisualizer);
  $('#visualizerClose').addEventListener('click', closeVisualizer);

  // Visualizer left nav bar toggle
  const vizNavToggle = $('#vizNavToggle');
  const vizNavOptions = $('#vizNavOptions');
  let vizNavOpen = false;
  vizNavToggle.addEventListener('click', () => {
    vizNavOpen = !vizNavOpen;
    vizNavOptions.classList.toggle('open', vizNavOpen);
  });

  $$('.visualizer__nav-options .vchip').forEach(b => {
    b.addEventListener('click', () => {
      vizState.mode = b.dataset.vmode;
      $$('.visualizer__nav-options .vchip').forEach(x => x.classList.toggle('active', x === b));
      // close nav after picking
      vizNavOpen = false;
      vizNavOptions.classList.remove('open');
    });
  });

  // Quick cards
  $$('.quickcard').forEach(card => {
    card.addEventListener('click', () => {
      const action = card.dataset.quick;
      if (action === 'liked') {
        openPlaylist(LIKED_ID);
      } else if (action === 'recent') {
        if (!state.recent.length) return toast('No recent tracks yet');
        playSong(state.recent[0], state.recent);
      } else if (action === 'shuffle') {
        if (!state.songs.length) return toast('Upload some songs first');
        const ids = state.songs.map(s => s.id);
        state.shuffle = true;
        $('#shuffleBtn').classList.add('active');
        const startId = ids[Math.floor(Math.random() * ids.length)];
        buildShuffleBag(ids, startId);
        playSong(startId, ids);
      }
    });
  });

  // Ctx menu
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.ctxmenu')) closeCtxMenu();
  });
  $('#ctxMenu').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-action]');
    if (!li) return;
    const act = li.dataset.action;
    const sid = state.ctxSongId;
    closeCtxMenu();
    if (!sid) return;
    if (act === 'play') playSong(sid, state.songs.map(s => s.id));
    if (act === 'queue') { if (!state.queue.includes(sid)) { state.queue.push(sid); toast('Added to queue'); renderQueuePanel(); } }
    if (act === 'addToPlaylist') openAddToPlaylist(sid);
    if (act === 'like') addSongToPlaylist(LIKED_ID, sid);
    if (act === 'delete') { if (confirm('Remove from your library?')) deleteSong(sid); }
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowRight' && e.shiftKey) next();
    if (e.code === 'ArrowLeft' && e.shiftKey) prev();
  });
}

/* -------------------- Init -------------------- */
(async function init() {
  initTheme();
  setGreeting();
  bindEvents();
  buildEqBands();
  // Mark "Normal" spatial btn as active by default
  const defaultSpatialBtn = document.querySelector('.spatial-btn[data-effect="none"]');
  if (defaultSpatialBtn) defaultSpatialBtn.classList.add('active');
  setupDropzone();
  await openDB();
  await loadAll();
  audio.volume = 0.8;
  renderAll();
  // seed history with home
  histPush();
})();