// ==UserScript==
// @name         YouTube Binge (Oldest First)
// @namespace    dwinph.youtube-binge
// @version      0.1.1
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

  // Pull video items and the next-page token out of a playlist browse response.
  function parsePlaylistPage(json) {
    const items = [];
    let token = null;
    walk(json, (k, v) => {
      if (k === 'playlistVideoRenderer' && v && v.videoId) {
        if (v.isPlayable === false) return false; // private or deleted
        let pct = 0;
        walk(v.thumbnailOverlays, (k2, v2) => {
          if (k2 === 'thumbnailOverlayResumePlaybackRenderer') pct = v2.percentDurationWatched || 0;
        });
        items.push({ id: v.videoId, t: textOf(v.title), w: pct });
        return false;
      }
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

  // Load every upload of a channel, then flip to oldest first.
  // UULF = long-form videos only (no Shorts or past livestreams); UU = everything.
  async function fetchUploads(channelId, onProgress) {
    const base = channelId.slice(2);
    for (const prefix of ['UULF', 'UU']) {
      const all = [];
      const seen = new Set();
      let json = await api('browse', { browseId: `VL${prefix}${base}` }).catch((e) => { LOG(prefix, e); return null; });
      for (let page = 0; json && page < 500; page++) {
        const { items, token } = parsePlaylistPage(json);
        let added = 0;
        for (const it of items) {
          if (!seen.has(it.id)) { seen.add(it.id); all.push(it); added++; }
        }
        if (onProgress) onProgress(all.length);
        if (!token || !added) break;
        json = await api('browse', { continuation: token });
      }
      if (all.length) return { items: all.reverse(), source: prefix };
    }
    throw new Error("Could not load this channel's uploads.");
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
        const start = nextUnwatched(q.items, 0);
        if (start < 0) { status.textContent = `All ${q.items.length} videos already watched.`; return; }
        status.textContent = `Starting video ${start + 1} of ${q.items.length}…`;
        go(q.items[start].id);
      } catch (e) {
        status.textContent = e.message || String(e);
        LOG(e);
      } finally {
        btn.disabled = false;
      }
    } }, '▶ Binge oldest → newest');
    return h('div', { class: 'card' }, h('div', { class: 'title' }, 'YouTube Binge'), status, h('div', { class: 'row' }, btn));
  }

  function watchView(ctx) {
    const { q, cid, i } = ctx;
    const done = q.items.filter((x) => x.w >= WATCHED_PCT).length;
    const status = h('div', { class: 'status' },
      `Video ${i + 1} of ${q.items.length} · ${done} watched` + (load().paused ? ' · paused' : ''));

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

    return h('div', { class: 'card' },
      h('div', { class: 'title' }, `Binge: ${q.name}`),
      status,
      h('div', { class: 'row' }, prev, next, pause, refresh, stop, hide));
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
  LOG('loaded v0.1.1 on', location.href, '| page context:', !!window.ytcfg);
  render(true);
})();
