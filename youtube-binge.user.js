// ==UserScript==
// @name         YouTube Binge (Oldest First)
// @namespace    dwinph.youtube-binge
// @version      0.4.0
// @description  Binge a channel's uploads oldest to newest on real YouTube, so watch history and progress land on your own account.
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-idle
// @inject-into  auto
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  if (window.__ytBingeLoaded) return;
  window.__ytBingeLoaded = true;

  const STORE_KEY = 'ytBinge:v1';
  const WATCHED_PCT = 90; // a video counts as watched at or above this percent
  const LOG = (...a) => console.log('[yt-binge]', ...a);

  // ---------------------------------------------------------------------------
  // Storage (youtube.com localStorage, so it stays on this browser/device)
  // Shape: { active: channelId|null, queues: { [channelId]: Queue } }
  // Queue: { name, source, updated, pos, items: [{ id, t, w }] }  (w = percent watched)
  // ---------------------------------------------------------------------------
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && s.queues) return s;
    } catch (_) { /* ignore */ }
    return { active: null, queues: {} };
  }
  function save(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); }
    catch (e) { console.warn('[yt-binge] could not save', e); }
  }

  // ---------------------------------------------------------------------------
  // YouTube internal API (same calls the YouTube site itself makes)
  // ---------------------------------------------------------------------------
  let parsedCfg = null;
  function cfg(key) {
    const yc = window.ytcfg;
    if (yc) {
      const v = typeof yc.get === 'function' ? yc.get(key) : yc.data_ && yc.data_[key];
      if (v !== undefined) return v;
    }
    // Fallback when running isolated from the page: read ytcfg.set({...}) from inline scripts.
    if (!parsedCfg) {
      parsedCfg = {};
      for (const sc of document.querySelectorAll('script:not([src])')) {
        const txt = sc.textContent;
        if (!txt.includes('INNERTUBE_')) continue;
        for (const m of txt.matchAll(/ytcfg\.set\((\{.*?\})\);/gs)) {
          try { Object.assign(parsedCfg, JSON.parse(m[1])); } catch (_) { /* partial match, skip */ }
        }
      }
    }
    return parsedCfg[key];
  }

  async function sapisidHash() {
    const m = document.cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/) ||
              document.cookie.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/);
    if (!m || !window.crypto || !crypto.subtle) return null;
    const ts = Math.floor(Date.now() / 1000);
    const data = new TextEncoder().encode(`${ts} ${m[1]} ${location.origin}`);
    const buf = await crypto.subtle.digest('SHA-1', data);
    const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    return `SAPISIDHASH ${ts}_${hex}`;
  }

  async function api(endpoint, body) {
    const context = cfg('INNERTUBE_CONTEXT');
    if (!context) throw new Error('Could not read YouTube settings. Reload the page and try again.');
    const headers = { 'Content-Type': 'application/json' };
    const auth = await sapisidHash().catch(() => null);
    if (auth) {
      // Signed-in request, so YouTube includes your watch progress on each video.
      headers['Authorization'] = auth;
      headers['X-Origin'] = location.origin;
      headers['X-Goog-AuthUser'] = String(cfg('SESSION_INDEX') ?? 0);
    }
    const ver = cfg('INNERTUBE_CLIENT_VERSION');
    const name = cfg('INNERTUBE_CONTEXT_CLIENT_NAME');
    if (ver) headers['X-Youtube-Client-Version'] = ver;
    if (name) headers['X-Youtube-Client-Name'] = String(name);
    const key = cfg('INNERTUBE_API_KEY');
    const url = `${location.origin}/youtubei/v1/${endpoint}?prettyPrint=false${key ? `&key=${key}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context, ...body }),
    });
    if (!res.ok) throw new Error(`YouTube ${endpoint} request failed (${res.status}).`);
    return res.json();
  }

  // Depth-first walk over a JSON tree. Return false from visit() to skip a subtree.
  function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x, visit); return; }
    for (const k of Object.keys(node)) {
      if (visit(k, node[k]) !== false) walk(node[k], visit);
    }
  }
  const textOf = (t) =>
    (t && (t.simpleText ?? (t.runs && t.runs.map((r) => r.text).join('')) ?? t.content)) || '';

  const VIDEO_KEYS = new Set(['playlistVideoRenderer', 'videoRenderer', 'gridVideoRenderer',
    'videoWithContextRenderer', 'compactVideoRenderer', 'playlistPanelVideoRenderer']);

  // Pull video items and the next-page token out of a playlist browse response.
  function parsePlaylistPage(json) {
    const items = [];
    let token = null;
    walk(json, (k, v) => {
      // Desktop: playlistVideoRenderer / videoRenderer / gridVideoRenderer.
      // Mobile site (m.youtube.com): videoWithContextRenderer / compactVideoRenderer.
      if (VIDEO_KEYS.has(k) && v && v.videoId) {
        if (v.isPlayable === false) return false; // private or deleted
        let pct = 0;
        walk(v.thumbnailOverlays, (k2, v2) => {
          if (k2 === 'thumbnailOverlayResumePlaybackRenderer') pct = v2.percentDurationWatched || 0;
        });
        items.push({ id: v.videoId, t: textOf(v.title) || textOf(v.headline), w: pct });
        return false;
      }
      // Older/mobile style next-page token.
      if (k === 'nextContinuationData' && v && v.continuation) { token = v.continuation; return false; }
      if (k === 'lockupViewModel' && v && v.contentId && String(v.contentType || 'VIDEO').includes('VIDEO')) {
        let pct = 0;
        let title = '';
        walk(v, (k2, v2) => {
          if (k2 === 'startPercent' && typeof v2 === 'number') pct = v2;
          if (k2 === 'lockupMetadataViewModel') title = textOf(v2.title);
        });
        items.push({ id: v.contentId, t: title, w: pct });
        return false;
      }
      if (k === 'continuationItemRenderer') {
        walk(v, (k2, v2) => { if (k2 === 'continuationCommand' && v2.token) token = v2.token; });
        return false;
      }
    });
    return { items, token };
  }

  // Follow continuation pages until the list ends. Returns items in the order YouTube gives them.
  async function collectPages(firstJson, onProgress) {
    const all = [];
    const seen = new Set();
    let json = firstJson;
    for (let page = 0; json && page < 1000; page++) {
      const { items, token } = parsePlaylistPage(json);
      let added = 0;
      for (const it of items) {
        if (!seen.has(it.id)) { seen.add(it.id); all.push(it); added++; }
      }
      if (onProgress) onProgress(all.length);
      if (!token || !added) break;
      json = await api('browse', { continuation: token });
    }
    return all;
  }

  // Find the sort chips (Latest / Popular / Oldest) on a channel's Videos tab.
  // Handles desktop chips, newer chipViewModel, and mobile-style sort sub-menus.
  // Each result has either a continuation token or a browse request to run.
  const SORT_LABEL = /^(latest|newest|popular|oldest)$/i;
  function sortActionOf(node) {
    let token = null;
    let browse = null;
    walk(node, (k, v) => {
      if (!token && k === 'continuationCommand' && v && v.token) token = v.token;
      if (!token && k === 'nextContinuationData' && v && v.continuation) token = v.continuation;
      if (!browse && k === 'browseEndpoint' && v && v.browseId && v.params) browse = { browseId: v.browseId, params: v.params };
    });
    return token ? { token } : browse ? { browse } : null;
  }
  function findSortChips(json) {
    const chips = [];
    const seen = new Set();
    const visitObj = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(visitObj); return; }
      const raw = o.text ?? o.title ?? o.label;
      const label = (typeof raw === 'string' ? raw : textOf(raw)).trim();
      const isChipKind = o.chipCloudChipRenderer || o.chipViewModel;
      if (isChipKind) {
        const c = o.chipCloudChipRenderer || o.chipViewModel;
        const r = c.text ?? c.title;
        const l = (typeof r === 'string' ? r : textOf(r)).trim();
        const act = sortActionOf(c);
        if (act && !seen.has(l)) { seen.add(l); chips.push({ label: l, chip: true, ...act }); }
        return;
      }
      if (label && SORT_LABEL.test(label) && !seen.has(label)) {
        const act = sortActionOf(o);
        if (act) { seen.add(label); chips.push({ label, ...act }); return; }
      }
      for (const k of Object.keys(o)) visitObj(o[k]);
    };
    visitObj(json);
    return chips;
  }

  // Preferred source: the channel's Videos tab, sorted by YouTube's own "Oldest" option,
  // so the order matches exactly what you see on the site.
  async function fetchVideosTabOldest(channelId, onProgress) {
    const home = await api('browse', { browseId: channelId });
    let params = null;
    walk(home, (k, v) => {
      if (params || k !== 'tabRenderer' || !v || !v.endpoint) return;
      const url = (((v.endpoint.commandMetadata || {}).webCommandMetadata) || {}).url || '';
      if (/\/videos$/.test(url) && v.endpoint.browseEndpoint) params = v.endpoint.browseEndpoint.params;
    });
    const tab = await api('browse', { browseId: channelId, params: params || 'EgZ2aWRlb3PyBgQKAjoA' });
    const chips = findSortChips(tab);
    LOG('sort chips:', chips.map((c) => c.label).join(', ') || '(none)');
    const chipOnly = chips.filter((c) => c.chip);
    const oldest = chips.find((c) => /oldest/i.test(c.label)) || (chipOnly.length === 3 ? chipOnly[2] : null);
    if (oldest) {
      const sorted = await api('browse', oldest.token ? { continuation: oldest.token } : oldest.browse);
      const items = await collectPages(sorted, onProgress);
      if (items.length) return { items, source: 'videos-tab-oldest' };
    }
    // No Oldest chip: load the tab newest-first and flip it.
    const items = await collectPages(tab, onProgress);
    if (items.length) return { items: items.reverse(), source: 'videos-tab-reversed' };
    return null;
  }

  // Load every video of a channel, oldest first.
  async function fetchUploads(channelId, onProgress) {
    let tabResult = null;
    try {
      tabResult = await fetchVideosTabOldest(channelId, onProgress);
      // Best case: YouTube's own Oldest sort worked.
      if (tabResult && tabResult.source === 'videos-tab-oldest') { logSummary(tabResult); return tabResult; }
    } catch (e) { LOG('videos tab failed, trying uploads playlist', e); }
    // Otherwise try the hidden uploads playlist (newest first, flipped) and keep
    // whichever list is longer, so a missed next page can't leave us with only 20.
    const playlistResult = await fetchUploadsPlaylist(channelId, onProgress).catch((e) => { LOG(e); return null; });
    const pick = [tabResult, playlistResult].filter(Boolean)
      .sort((a, b) => b.items.length - a.items.length)[0];
    if (!pick) throw new Error("Could not load this channel's uploads.");
    logSummary(pick);
    return pick;
  }

  // UULF = long-form videos only (no Shorts or past livestreams); UU = everything.
  async function fetchUploadsPlaylist(channelId, onProgress) {
    const base = channelId.slice(2);
    for (const prefix of ['UULF', 'UU']) {
      const first = await api('browse', { browseId: `VL${prefix}${base}` }).catch((e) => { LOG(prefix, e); return null; });
      const items = first ? await collectPages(first, onProgress) : [];
      if (items.length) return { items: items.reverse(), source: `uploads-playlist-${prefix}` };
    }
    return null;
  }

  const SOURCE_LABEL = {
    'videos-tab-oldest': 'Videos tab, Oldest sort',
    'videos-tab-reversed': 'Videos tab, reversed (no Oldest sort found)',
    'uploads-playlist-UULF': 'Uploads playlist (by upload date)',
    'uploads-playlist-UU': 'Uploads playlist, all types (by upload date)',
  };

  function logSummary(r) {
    const first = r.items[0];
    const last = r.items[r.items.length - 1];
    LOG(`loaded ${r.items.length} videos from ${r.source}; first: "${first && first.t}", last: "${last && last.t}"`);
  }

  // ---------------------------------------------------------------------------
  // Page helpers
  // ---------------------------------------------------------------------------
  const CHANNEL_RE = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/;
  const isChannelPage = () => CHANNEL_RE.test(location.pathname);
  const isWatchPage = () => location.pathname === '/watch';
  const currentVideoId = () => new URLSearchParams(location.search).get('v');

  async function resolveChannel() {
    const path = location.pathname.match(CHANNEL_RE)[1];
    let id = (path.match(/^channel\/(UC[\w-]{22})/) || [])[1];
    if (!id) {
      const r = await api('navigation/resolve_url', { url: `${location.origin}/${path}` });
      walk(r, (k, v) => { if (!id && k === 'browseId' && /^UC[\w-]{22}$/.test(v)) id = v; });
    }
    if (!id) throw new Error('Could not figure out which channel this is.');
    const name = document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, '').trim() || path;
    return { id, name };
  }

  const nextUnwatched = (items, from) => {
    for (let i = Math.max(0, from); i < items.length; i++) if (items[i].w < WATCHED_PCT) return i;
    return -1;
  };

  function go(videoId) {
    location.assign(`/watch?v=${encodeURIComponent(videoId)}`);
  }

  // Find the queue that holds the current video (prefer the active one) and sync position.
  function queueForCurrentVideo() {
    const vid = currentVideoId();
    if (!vid) return null;
    const s = load();
    const ids = [s.active, ...Object.keys(s.queues).filter((k) => k !== s.active)].filter(Boolean);
    for (const cid of ids) {
      const q = s.queues[cid];
      const i = q ? q.items.findIndex((x) => x.id === vid) : -1;
      if (i >= 0) {
        if (s.active !== cid || q.pos !== i) { s.active = cid; q.pos = i; save(s); }
        return { s, q, cid, i };
      }
    }
    return null;
  }

  // Build or refresh a channel queue, keeping watch marks we already know about.
  async function buildQueue(channelId, name, onProgress) {
    const { items, source } = await fetchUploads(channelId, onProgress);
    const s = load();
    const old = s.queues[channelId];
    if (old) {
      const known = new Map(old.items.map((x) => [x.id, x.w]));
      for (const it of items) it.w = Math.max(it.w, known.get(it.id) || 0);
    }
    const q = { name: name || (old && old.name) || channelId, source, updated: Date.now(), items, pos: old ? old.pos : 0 };
    s.queues[channelId] = q;
    s.active = channelId;
    save(s);
    return q;
  }

  // ---------------------------------------------------------------------------
  // UI (built with DOM calls only; YouTube's Trusted Types policy blocks innerHTML)
  // ---------------------------------------------------------------------------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.className = v;
        else el.setAttribute(k, v);
      }
    }
    for (const kid of kids) if (kid != null) el.append(kid);
    return el;
  }

  const host = h('div', { id: 'yt-binge-host' });
  const root = host.attachShadow({ mode: 'open' });
  root.append(h('style', null, `
    :host { all: initial; }
    .card { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: rgba(20,20,20,.92); color: #fff; border-radius: 12px; padding: 10px 12px;
      box-shadow: 0 6px 24px rgba(0,0,0,.35); max-width: min(320px, calc(100vw - 32px)); }
    .title { font-weight: 600; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status { opacity: .8; margin-bottom: 8px; }
    .row { display: flex; gap: 6px; flex-wrap: wrap; }
    button { all: unset; cursor: pointer; background: #3a3a3a; color: #fff; border-radius: 8px;
      padding: 6px 10px; font-weight: 500; }
    button:hover { background: #505050; }
    button.primary { background: #cc0000; }
    button.primary:hover { background: #e00000; }
    button[disabled] { opacity: .5; pointer-events: none; }
    .card.wide { width: min(420px, calc(100vw - 32px)); max-width: none; }
    .next { margin-bottom: 8px; font-weight: 500; }
    .source { font-size: 11px; opacity: .6; margin-bottom: 8px; }
    input { all: unset; box-sizing: border-box; width: 100%; background: #2a2a2a; color: #fff;
      border-radius: 8px; padding: 6px 10px; margin-bottom: 6px; }
    .list { max-height: min(50vh, 420px); overflow-y: auto; margin-bottom: 8px;
      border-radius: 8px; background: #1a1a1a; }
    .item { display: flex; gap: 8px; padding: 6px 8px; cursor: pointer; align-items: baseline; }
    .item:hover { background: #333; }
    .item.current { background: #4a1010; }
    .item.watched .name { opacity: .55; }
    .num { min-width: 3em; text-align: right; opacity: .6; font-variant-numeric: tabular-nums; }
    .mark { width: 1em; color: #6c6; }
    .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .min { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; }
  `));
  const mount = h('div');
  root.append(mount);

  let collapsed = false;
  const setView = (...nodes) => { mount.replaceChildren(...nodes); };

  function ensureHost() {
    if (!host.isConnected) (document.body || document.documentElement).append(host);
  }

  function channelView() {
    const status = h('div', { class: 'status' }, 'Watch this channel from the first upload.');
    const btn = h('button', { class: 'primary', onclick: async () => {
      btn.disabled = true;
      try {
        status.textContent = 'Finding channel…';
        const ch = await resolveChannel();
        const q = await buildQueue(ch.id, ch.name, (n) => { status.textContent = `Loading uploads… ${n}`; });
        setView(readyView(ch.id, q));
      } catch (e) {
        status.textContent = e.message || String(e);
        LOG(e);
      } finally {
        btn.disabled = false;
      }
    } }, '▶ Binge oldest → newest');
    return h('div', { class: 'card' }, h('div', { class: 'title' }, 'YouTube Binge'), status, h('div', { class: 'row' }, btn));
  }

  const label = (q, idx) => `#${idx + 1} ${q.items[idx].t || q.items[idx].id}`;

  // Shown after the list loads: confirm the suggested video or choose another.
  function readyView(cid, q) {
    const start = nextUnwatched(q.items, 0);
    const done = q.items.filter((x) => x.w >= WATCHED_PCT).length;
    const info = start < 0
      ? `All ${q.items.length} videos are watched.`
      : `${q.items.length} videos, ${done} watched. Next up:`;
    const row = h('div', { class: 'row' });
    if (start >= 0) row.append(h('button', { class: 'primary', onclick: () => startAt(cid, start) }, `▶ Play #${start + 1}`));
    row.append(h('button', { onclick: () => setView(pickerView(cid, () => setView(readyView(cid, load().queues[cid])))) }, 'Choose video…'));
    return h('div', { class: 'card' },
      h('div', { class: 'title' }, `Binge: ${q.name}`),
      h('div', { class: 'status' }, info),
      start >= 0 ? h('div', { class: 'next' }, label(q, start)) : null,
      h('div', { class: 'source' }, `Source: ${SOURCE_LABEL[q.source] || q.source}`),
      row);
  }

  function startAt(cid, idx) {
    const s = load();
    const q = s.queues[cid];
    if (!q || !q.items[idx]) return;
    s.active = cid;
    s.paused = false;
    q.pos = idx;
    save(s);
    go(q.items[idx].id);
  }

  // Scrollable, searchable list of the whole queue, oldest first.
  function pickerView(cid, onBack) {
    const q = load().queues[cid];
    const list = h('div', { class: 'list' });
    const rows = q.items.map((it, idx) => {
      const watched = it.w >= WATCHED_PCT;
      const el = h('div', { class: 'item' + (idx === q.pos ? ' current' : '') + (watched ? ' watched' : ''),
        title: it.t, onclick: () => startAt(cid, idx) },
        h('span', { class: 'num' }, String(idx + 1)),
        h('span', { class: 'mark' }, watched ? '✓' : it.w > 0 ? '◐' : ''),
        h('span', { class: 'name' }, it.t || it.id));
      list.append(el);
      return el;
    });
    const search = h('input', { type: 'search', placeholder: 'Search titles or type a number' });
    // Keep YouTube's keyboard shortcuts from grabbing what you type.
    for (const ev of ['keydown', 'keyup', 'keypress']) search.addEventListener(ev, (e) => e.stopPropagation());
    search.addEventListener('input', () => {
      const term = search.value.trim().toLowerCase();
      rows.forEach((el, idx) => {
        const hit = !term || String(idx + 1) === term || (q.items[idx].t || '').toLowerCase().includes(term);
        el.style.display = hit ? '' : 'none';
      });
    });
    const card = h('div', { class: 'card wide' },
      h('div', { class: 'title' }, `Choose a video · ${q.name}`),
      h('div', { class: 'status' }, 'Oldest at the top. Click one to play it and continue from there.'),
      search, list,
      h('div', { class: 'row' }, h('button', { onclick: onBack }, 'Back')));
    requestAnimationFrame(() => { if (rows[q.pos]) rows[q.pos].scrollIntoView({ block: 'center' }); });
    return card;
  }

  function watchView(ctx) {
    const { q, cid, i } = ctx;
    const done = q.items.filter((x) => x.w >= WATCHED_PCT).length;
    const status = h('div', { class: 'status' },
      `Video ${i + 1} of ${q.items.length} · ${done} watched` + (load().paused ? ' · paused' : ''),
      h('br'), q.items[i].t || '');

    const jump = (idx) => { if (idx >= 0 && idx < q.items.length) go(q.items[idx].id); };
    const prev = h('button', { onclick: () => jump(i - 1) }, '⏮ Prev');
    const next = h('button', { onclick: () => jump(i + 1) }, 'Next ⏭');
    if (i === 0) prev.disabled = true;
    if (i >= q.items.length - 1) next.disabled = true;

    const pause = h('button', { onclick: () => {
      const s = load(); s.paused = !s.paused; save(s); render(true);
    } }, load().paused ? 'Resume auto-next' : 'Pause auto-next');

    const refresh = h('button', { onclick: async () => {
      refresh.disabled = true;
      try {
        await buildQueue(cid, q.name, (n) => { status.textContent = `Refreshing… ${n}`; });
        render(true);
      } catch (e) { status.textContent = e.message || String(e); refresh.disabled = false; }
    } }, 'Refresh');

    const stop = h('button', { onclick: () => {
      const s = load(); s.active = null; save(s); collapsed = false; setView();
    } }, 'Stop');

    const hide = h('button', { onclick: () => { collapsed = true; render(true); } }, '–');
    const pick = h('button', { onclick: () => setView(pickerView(cid, () => render(true))) }, 'List');

    return h('div', { class: 'card' },
      h('div', { class: 'title' }, `Binge: ${q.name}`),
      status,
      h('div', { class: 'row' }, prev, next, pick, pause, refresh, stop, hide));
  }

  function collapsedView() {
    return h('div', { class: 'min' }, h('button', { class: 'primary', onclick: () => { collapsed = false; render(true); } }, '▶ Binge'));
  }

  let lastRendered = '';
  function render(force) {
    const key = location.pathname + location.search;
    if (!force && key === lastRendered) return;
    lastRendered = key;
    ensureHost();
    if (isWatchPage()) {
      const ctx = queueForCurrentVideo();
      if (!ctx || load().active !== ctx.cid) return setView();
      return setView(collapsed ? collapsedView() : watchView(ctx));
    }
    if (isChannelPage()) return setView(channelView());
    setView();
  }

  // ---------------------------------------------------------------------------
  // Auto-advance when a queued video finishes
  // ---------------------------------------------------------------------------
  document.addEventListener('ended', (e) => {
    if (!(e.target instanceof HTMLVideoElement)) return;
    if (document.querySelector('.ad-showing, .ad-interrupting')) return; // an ad finished, not the video
    const ctx = queueForCurrentVideo();
    if (!ctx) return;
    const { s, q, i } = ctx;
    q.items[i].w = 100;
    const n = nextUnwatched(q.items, i + 1);
    if (n >= 0) q.pos = n;
    save(s);
    if (s.paused) return render(true);
    if (n >= 0) go(q.items[n].id);
    else render(true);
  }, true); // capture: media events don't bubble

  // YouTube is a single-page app, so watch for in-app navigation.
  window.addEventListener('yt-navigate-finish', () => render());
  window.addEventListener('popstate', () => render());
  setInterval(() => render(), 1000);
  LOG('loaded v0.4.0 on', location.href, '| page context:', !!window.ytcfg);
  render(true);
})();
