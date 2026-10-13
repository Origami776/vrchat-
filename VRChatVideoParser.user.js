// ==UserScript==
// @name         VRChat 当前视频解析
// @namespace    local.universal-video-parser
// @version      3.5.0
// @description  通用网页/媒体分享链接解析复制；B站弹幕入口；抖音403自动回退
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_addValueChangeListener
// @connect      api.bilibili.com
// @connect      *
// ==/UserScript==

(() => {
  'use strict';
  let host, button, tip, copyPageButton, linkInput, busy = false;
  const SERVICE = 'vrc.service';
  const SHARE_TASK = 'vrc.shareTask';
  let resumeStarted = '', waitingToken = '';
  const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const incomingURL = new URL(location.href);
  const taskMatch = incomingURL.hash.match(/(?:^#|&)vrc-parse=([^&]+)$/);
  const incomingToken = taskMatch ? decodeURIComponent(taskMatch[1]) : '';
  if (taskMatch) {
    // 在网站脚本启动前移除任务标记，保留原来的 SPA 路由片段。
    incomingURL.hash = incomingURL.hash.slice(0, taskMatch.index);
    try { page.history.replaceState(page.history.state, '', incomingURL.href); } catch {}
  }
  const payloads = [];
  let detected = null;
  function biliPlayerURL(value = location.href) {
    const original = new URL(value);
    const id = original.pathname.match(/\/video\/(BV\w+|av\d+)/i)?.[1] || original.searchParams.get('bvid');
    if (!id || !/^(BV\w+|av\d+)$/i.test(id)) throw new Error('请打开 B 站视频播放页。');
    const target = new URL(`https://www.bilibili.com/video/${id}/`);
    const part = original.searchParams.get('p');
    if (part && /^[1-9]\d*$/.test(part)) target.searchParams.set('p', part);
    return `https://biliplayer.91vrchat.com/player/?url=${encodeURIComponent(target.href)}`;
  }
  function douyinURL(text) {
    const match = String(text || '').match(/https?:\/\/[^\s<>"'，。；！）]+/i);
    if (!match) throw new Error('请粘贴抖音视频链接或包含链接的分享文字。');
    const url = new URL(httpURL(match[0]));
    if (!/(^|\.)douyin\.com$/.test(url.hostname) && url.hostname !== 'www.iesdouyin.com') throw new Error('请输入抖音域名的链接。');
    const id = url.pathname.match(/\/(?:share\/)?video\/(\d+)/)?.[1] || url.searchParams.get('modal_id');
    if (id && /^\d+$/.test(id)) return { url: `https://www.douyin.com/video/${id}`, id };
    if (url.hostname === 'v.douyin.com' && url.pathname !== '/') return { url: url.href, id: null };
    throw new Error('请使用具体作品链接或 v.douyin.com 分享短链接。');
  }
  function copyDouyinPage() {
    try {
      const video = current(), id = identity(video);
      if (!id) throw new Error('无法识别当前作品编号，请打开该视频独立页后复制。');
      const url = `https://www.douyin.com/video/${id}`;
      GM_setClipboard(url, 'text'); linkInput.value = url;
      show('已复制当前抖音作品链接。点击“一键解析”可解析并复制媒体链接。');
    } catch (error) { show(error.message); }
  }
  function pastedURL(text) {
    const match = String(text || '').match(/https?:\/\/[^\s<>"'，。；！）]+/i);
    if (!match) throw new Error('请粘贴视频网页链接、媒体直链或含链接的分享文字。');
    return httpURL(match[0]);
  }
  function siteFor(value) {
    const domain = new URL(value).hostname;
    if (/(^|\.)(douyin\.com|iesdouyin\.com)$/.test(domain)) return '抖音';
    if (/(^|\.)bilibili\.com$/.test(domain)) return 'B站';
    if (domain === 'v.qq.com' || domain === 'm.v.qq.com') return '腾讯视频';
    if (/(^|\.)youtube\.com$/.test(domain) || domain === 'youtu.be') return 'YouTube';
    return '网页视频';
  }
  function youtubeVideoURL(value) {
    const url = new URL(value);
    const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) :
      url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/)?.[1] || (url.pathname === '/watch' ? url.searchParams.get('v') : '');
    if (!id || !/^[\w-]{11}$/.test(id)) throw new Error('请使用具体 YouTube 视频链接。');
    return `https://www.youtube.com/watch?v=${id}`;
  }
  function copyPageLink() {
    if (siteName() === '抖音') return copyDouyinPage();
    try {
      const url = siteName() === 'B站' ? new URL(biliPlayerURL()).searchParams.get('url') : httpURL(location.href);
      GM_setClipboard(url, 'text'); linkInput.value = url; refreshDetection();
      show('已复制网页视频链接，可点击“一键解析”复制媒体地址。');
    } catch (error) { show(error.message); }
  }
  async function parseLinkInput() {
    if (busy) return;
    if (!linkInput?.value.trim()) return copyCurrent();
    let target;
    try { target = pastedURL(linkInput.value); } catch (error) { show(error.message); return; }
    const site = siteFor(target);
    if (site === '抖音') return parseDouyinInput();
    if (target === location.href && !['B站', 'YouTube'].includes(site)) {
      try { current(); return copyCurrent(); } catch {}
    }
    const original = linkInput.value;
    busy = true; button.disabled = true; button.textContent = '解析中…';
    try {
      let url, note = '已复制媒体链接，已验证视频和声音；不含网页弹幕。';
      if (site === 'B站') { url = biliPlayerURL(target); note = '已复制 B站弹幕解析入口，无需播放。'; }
      else if (site === 'YouTube') { url = youtubeVideoURL(target); note = '已复制 YouTube 视频链接，由 VRChat 播放器解析。'; }
      else if (GM_getValue(SERVICE, '')) {
        url = serviceResult(await jsonRequest(httpURL(GM_getValue(SERVICE, '')), {
          pageUrl: target, mediaUrl: null, site, videoId: null, currentTime: 0,
          requirements: { audio: true, burnDanmaku: true, target: 'vrchat' }
        }));
        note = '已复制服务返回的声音+弹幕链接。';
      } else {
        try {
          if (/\.(mp4|webm|m3u8|mpd|m4s)(?:[?#]|$)/i.test(target)) url = await verifiedGeneric([target]);
          else {
            const response = await pageRequest(target);
            target = httpURL(response.finalUrl || target);
            if (siteFor(target) === 'B站') { url = biliPlayerURL(target); note = '已复制 B站弹幕解析入口，无需播放。'; }
            else if (siteFor(target) === 'YouTube') { url = youtubeVideoURL(target); note = '已复制 YouTube 视频链接，由 VRChat 解析。'; }
            else if (siteFor(target) === '抖音') { openShareTask({ ...douyinURL(target), kind: 'douyin' }); return; }
            else if (mediaTracks(response.response).video || /^\s*#EXTM3U/.test(new TextDecoder().decode(response.response.slice(0, 256)))) url = await verifiedGeneric([target]);
            else {
              const doc = new DOMParser().parseFromString(new TextDecoder().decode(response.response), 'text/html');
              const candidates = pageVideoCandidates(doc, target);
              if (!candidates.length) throw new Error('需要加载网页播放器。');
              url = await verifiedGeneric(candidates);
            }
          }
        } catch (error) {
          if (/\.(mp4|webm|m3u8|mpd|m4s)(?:[?#]|$)/i.test(target)) throw error;
          if (linkInput.value === original) { openShareTask({ url: target, id: null, kind: 'generic' }); return; }
          throw error;
        }
      }
      if (linkInput.value !== original) throw new Error('输入链接已改变，请重新解析。');
      GM_setClipboard(url, 'text'); show(note);
    } catch (error) { show(error.message || '解析失败，未复制链接。'); }
    finally { busy = false; button.disabled = false; refreshDetection(); }
  }
  async function parseDouyinInput() {
    if (!linkInput?.value.trim()) return copyCurrent();
    if (busy) return;
    let target;
    try { target = douyinURL(linkInput.value); } catch (error) { show(error.message); return; }
    let video;
    try { video = current(); } catch {}
    if (video && target.id && identity(video) === target.id) return copyCurrent();
    const endpoint = GM_getValue(SERVICE, '');
    busy = true; button.disabled = true; button.textContent = '解析中…';
    const original = linkInput.value;
    try {
      let url;
      if (endpoint) {
        const result = await jsonRequest(httpURL(endpoint), {
          pageUrl: target.url, mediaUrl: null, site: '抖音', videoId: target.id,
          currentTime: 0, requirements: { audio: true, burnDanmaku: true, target: 'vrchat' }
        });
        url = serviceResult(result);
      } else {
        try {
          const data = await douyinPageCandidates(target);
          try { url = await verifiedDouyin(data.urls); }
          catch (error) { error.target = data.target; throw error; }
        }
        catch (error) {
          if (error.target && linkInput.value === original) { openShareTask(error.target); return; }
          throw error;
        }
      }
      if (linkInput.value !== original) throw new Error('输入链接已改变，请重新解析。');
      GM_setClipboard(url, 'text'); show(endpoint ? '已复制服务返回的声音+弹幕链接。' : '已复制抖音直链，已验证视频和声音轨；不含网页弹幕，链接会过期。');
    } catch (error) { show(error.message); }
    finally { busy = false; button.disabled = false; refreshDetection(); }
  }
  function openShareTask(target) {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const job = { token, id: target.id, url: target.url, kind: target.kind || 'douyin', status: 'waiting', expires: Date.now() + 120000 };
    GM_setValue(SHARE_TASK, job); waitingToken = token;
    const url = new URL(target.url); url.hash = `${url.hash ? url.hash.slice(1) + '&' : ''}vrc-parse=${token}`;
    GM_openInTab(url.href, { active: true, insert: true });
    show('已自动打开目标网页；播放器加载后自动解析并复制，无需再点击。网站要求验证时请先完成验证。');
  }
  function visibleVideo(video) {
    const r = video.getBoundingClientRect(), style = getComputedStyle(video);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && style.display !== 'none' && style.visibility !== 'hidden';
  }
  async function resumeShareTask() {
    if (busy) return;
    const token = incomingToken;
    const job = GM_getValue(SHARE_TASK, null);
    if (!token || !job || job.token !== token || job.status !== 'waiting' || resumeStarted === token) return;
    if (Date.now() > job.expires) { GM_setValue(SHARE_TASK, { ...job, status: 'error', message: '作品加载超时，请完成网页验证后重新解析。' }); show('自动解析超时，请完成网页验证后重试。'); return; }
    if (job.kind === 'generic') return resumeGenericTask(token, job);
    if (siteName() !== '抖音') return;
    button.textContent = '正在加载分享视频…';
    const targetId = job.id || location.pathname.match(/^\/video\/(\d+)/)?.[1];
    if (!targetId || (job.id && location.pathname !== `/video/${job.id}` && location.pathname !== `/video/${job.id}/`)) return;
    const video = collect().find(v => v.readyState >= 2 && visibleVideo(v) && identity(v) === targetId && !/\.(mp3|m4a|aac)(?:[?#]|$)/i.test(v.currentSrc || ''));
    if (!video) return;
    const candidates = douyinCandidates(video);
    if (!candidates.length) return;
    resumeStarted = token; busy = true; button.disabled = true; button.textContent = '分享视频解析中…';
    GM_setValue(SHARE_TASK, { ...job, status: 'working' });
    const start = location.href;
    try {
      if (video.mediaKeys) throw new Error('该视频使用加密媒体，不能作普通直链解析。');
      const url = await verifiedDouyin(candidates, () => identity(video) === targetId ? douyinCandidates(video) : []);
      if (location.href !== start || identity(video) !== targetId) throw new Error('作品已切换，请重新解析分享链接。');
      if (GM_getValue(SHARE_TASK, null)?.token !== token) throw new Error('该任务已被新的分享解析替代。');
      GM_setClipboard(url, 'text');
      const message = '分享视频已自动解析并复制，已验证视频和声音轨，可粘贴到 VRChat；不含网页弹幕。';
      GM_setValue(SHARE_TASK, { ...job, status: 'done', message }); show(message);
    } catch (error) {
      if (GM_getValue(SHARE_TASK, null)?.token === token) GM_setValue(SHARE_TASK, { ...job, status: 'error', message: error.message });
      show(error.message);
    }
    finally { busy = false; button.disabled = false; refreshDetection(); }
  }
  async function resumeGenericTask(token, job) {
    if (siteFor(location.href) === '抖音') {
      try { GM_setValue(SHARE_TASK, { ...job, ...douyinURL(location.href), kind: 'douyin' }); } catch {}
      return;
    }
    let video, candidates, url;
    try {
      if (siteName() === 'B站') url = biliPlayerURL();
      else if (siteFor(location.href) === 'YouTube') url = youtubeVideoURL(location.href);
      else {
        try { video = current(); }
        catch {
          const visible = collect().filter(v => visibleVideo(v) && v.readyState >= 2);
          if (visible.length !== 1) { button.textContent = visible.length > 1 ? '多个视频，请只播放目标视频' : '等待目标视频加载…'; return; }
          video = visible[0];
        }
        if (video.mediaKeys) throw new Error('目标视频使用 DRM，无法作为普通直链解析。');
        candidates = genericVideoCandidates(video);
        if (!candidates.length) { button.textContent = '等待视频源，请播放目标视频'; return; }
      }
      resumeStarted = token; busy = true; button.disabled = true; button.textContent = '网页视频解析中…';
      GM_setValue(SHARE_TASK, { ...job, status: 'working' });
      const start = location.href, source = video?.currentSrc;
      if (!url) url = await verifiedGeneric(candidates);
      if (location.href !== start || (video && video.currentSrc !== source)) throw new Error('目标视频已切换，请重新解析。');
      if (GM_getValue(SHARE_TASK, null)?.token !== token) throw new Error('该解析任务已被新任务替代。');
      GM_setClipboard(url, 'text');
      const message = '目标视频已解析并复制。普通媒体已验证视频和声音；网页弹幕需对应解析服务。';
      GM_setValue(SHARE_TASK, { ...job, status: 'done', message }); show(message);
    } catch (error) {
      if (GM_getValue(SHARE_TASK, null)?.token === token) GM_setValue(SHARE_TASK, { ...job, status: 'error', message: error.message });
      show(error.message);
    } finally { if (busy) { busy = false; button.disabled = false; refreshDetection(); } }
  }
  function siteName() {
    const domain = location.hostname;
    if (/(^|\.)douyin\.com$/.test(domain)) return '抖音';
    if (/(^|\.)bilibili\.com$/.test(domain)) return 'B站';
    if (domain === 'v.qq.com' || domain === 'm.v.qq.com') return '腾讯视频';
    return '网页视频';
  }
  function identity(video) {
    const url = new URL(location.href);
    if (siteName() === '抖音') {
      // 播放器源地址上的作品编号比推荐流网页地址更接近当前视频。
      try { const sourceId = new URL(video.currentSrc || video.src).searchParams.get('__vid'); if (sourceId && /^\d+$/.test(sourceId)) return sourceId; } catch {}
      const modal = url.searchParams.get('modal_id');
      if (modal && /^\d+$/.test(modal)) return modal;
      // 推荐流必须使用当前视频所在卡片编号，不选全页的推荐链接。
      for (let el = video; el && el !== document.body; el = el.parentElement) {
        for (const attr of ['data-aweme-id', 'data-item-id', 'data-video-id']) {
          const value = el.getAttribute?.(attr);
          if (value && /^\d+$/.test(value)) return value;
        }
      }
      return url.pathname.match(/^\/video\/(\d+)/)?.[1] || null;
    }
    if (siteName() === '腾讯视频') return url.searchParams.get('vid') || url.pathname.match(/\/([A-Za-z0-9]+)\.html$/)?.[1] || null;
    return null;
  }
  function remember(data) {
    if (!data || typeof data !== 'object') return;
    payloads.push(data); if (payloads.length > 12) payloads.shift();
  }
  // 只记录站点播放器已获取的 JSON，保留原请求及结果；不请求私有接口。
  if (['抖音', '腾讯视频'].includes(siteName())) {
    try {
      const original = page.fetch;
      if (original) page.fetch = function (...args) {
        const result = Reflect.apply(original, this, args);
        result.then(async response => {
          try {
            if (!/json/i.test(response.headers.get('content-type') || '')) return;
            const size = Number(response.headers.get('content-length'));
            if (size > 2000000) return;
            const text = await response.clone().text();
            if (text.length <= 2000000) remember(JSON.parse(text));
          } catch {}
        }, () => {});
        return result;
      };
    } catch {}
    try {
      const proto = page.XMLHttpRequest.prototype, original = proto.send;
      proto.send = function (...args) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType === 'json') remember(this.response);
            else if ((!this.responseType || this.responseType === 'text') && /json/i.test(this.getResponseHeader('content-type') || '') && this.responseText.length <= 2000000) remember(JSON.parse(this.responseText));
          } catch {}
        }, { once: true });
        return Reflect.apply(original, this, args);
      };
    } catch {}
  }
  function matchedObjects(data, id) {
    const found = [], seen = new WeakSet(); let count = 0;
    function walk(obj, depth = 0) {
      if (!obj || typeof obj !== 'object' || depth > 18 || ++count > 15000 || seen.has(obj)) return;
      seen.add(obj);
      if (String(obj.aweme_id || obj.awemeId || obj.vid || (obj.video ? obj.id : '') || '') === id) { found.push(obj); return; }
      for (const child of Object.values(obj)) if (typeof child === 'object') walk(child, depth + 1);
    }
    walk(data); return found;
  }
  function compatible(value) {
    try {
      const url = httpURL(value), parsed = new URL(url);
      return /\.(mp4|webm|m3u8)(?:[?#]|$)/i.test(url) || /\/aweme\/v\d+\/play\//i.test(url) ||
        (/(^|\.)(douyinvod\.com|douyinvod\.com\.cn)$/.test(parsed.hostname) && parsed.searchParams.get('mime_type') === 'video_mp4') ? url : null;
    } catch { return null; }
  }
  function douyinAddresses(item) {
    const video = item.video || item.aweme?.detail?.video || item.detail?.video;
    if (!video) return [];
    const urls = [];
    function addr(value) {
      if (!value) return;
      if (typeof value === 'string') { const url = compatible(value); if (url) urls.push(url); }
      else if (Array.isArray(value)) value.forEach(addr);
      else { addr(value.url_list || value.urlList || value.src); }
    }
    addr(video.play_addr_h264 || video.playAddrH264); addr(video.playAddr); addr(video.play_addr);
    addr(video.playApi); addr(video.play_addr_lowbr);
    for (const rate of video.bit_rate || video.bitRateList || []) {
      if (rate.format !== 'dash' && !rate.is_h265 && !rate.is_bytevc1 && !/h265|bytevc1|h266/i.test(rate.gear_name || rate.gearName || '')) addr(rate.play_addr || rate.playAddr);
    }
    // 保留原始下载地址及水印参数；只在播放地址均失败时作为备用。
    addr(video.download_addr || video.downloadAddr);
    // 只使用本作品播放器给出的资源编号，走官方播放重定向获取新的 CDN 签名。
    // 不拼接 CDN 域名，不改写现有签名；最终直链还须单独通过匿名验证。
    const resource = video.play_addr?.uri || video.play_addr_h264?.uri || video.playAddr?.uri ||
      video.playAddr?.[0]?.uri || video.videoId;
    if (typeof resource === 'string' && /^v[a-zA-Z0-9]{10,80}$/.test(resource)) {
      for (const line of [1, 0]) {
        const playback = new URL('https://www.douyin.com/aweme/v1/play/');
        playback.searchParams.set('video_id', resource);
        playback.searchParams.set('ratio', '720p'); playback.searchParams.set('line', String(line));
        urls.push(playback.href);
      }
    }
    return [...new Set(urls)];
  }
  function pageRoots(doc = document) {
    const roots = [];
    for (const script of doc.querySelectorAll('script[type="application/json"],script#RENDER_DATA,script#__NEXT_DATA__')) {
      try { if (script.textContent.length <= 3000000) roots.push(JSON.parse(script.id === 'RENDER_DATA' ? decodeURIComponent(script.textContent) : script.textContent)); } catch {}
    }
    for (const script of doc.querySelectorAll('script:not([src])')) {
      const text = script.textContent;
      if (text.length > 3000000) continue;
      try {
        const assignment = text.match(/^\s*(?:window|self)\._ROUTER_DATA\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
        if (assignment) roots.push(JSON.parse(assignment[1]));
        if (!text.includes('__pace_f.push')) continue;
        const match = text.match(/\.push\((\[[\s\S]*\])\)\s*;?\s*$/);
        if (!match) continue;
        const chunk = JSON.parse(match[1])[1];
        if (typeof chunk !== 'string') continue;
        if (chunk.startsWith('%7B')) roots.push(JSON.parse(decodeURIComponent(chunk)));
        else for (const line of chunk.split('\n')) {
          const data = line.replace(/^[0-9a-f]+:/i, '');
          if (/^[\[{]/.test(data)) { try { roots.push(JSON.parse(data)); } catch {} }
        }
      } catch {}
    }
    return roots;
  }
  function douyinPageCandidates(target) {
    return new Promise((resolve, reject) => {
      let handle, resolvedTarget = target;
      handle = GM_xmlhttpRequest({ method: 'GET', url: target.url, timeout: 20000,
        onprogress: event => { if (event.loaded > 4000000) { handle?.abort(); reject(new Error('分享页面响应过大。')); } },
        onload: response => {
          try {
            if (response.status !== 200) throw new Error(`分享页面 HTTP ${response.status}`);
            if (response.responseText.length > 4000000) throw new Error('分享页面响应过大。');
            const final = douyinURL(response.finalUrl || target.url);
            resolvedTarget = final;
            const id = target.id || final.id;
            if (!id) throw new Error('未展开为作品页，请先打开分享链接并播放视频。');
            const doc = new DOMParser().parseFromString(response.responseText, 'text/html');
            const urls = [];
            for (const root of pageRoots(doc)) for (const item of matchedObjects(root, id)) urls.push(...douyinAddresses(item));
            if (!urls.length) throw new Error('分享页未返回播放数据（可能需要验证或登录）。请打开该作品并播放后，在网页按钮解析。');
            resolve({ urls: [...new Set(urls)], target: { url: `https://www.douyin.com/video/${id}`, id } });
          } catch (error) { error.target = resolvedTarget; reject(error); }
        }, onerror: () => reject(Object.assign(new Error('无法读取分享页面。'), { target: resolvedTarget })),
        ontimeout: () => reject(Object.assign(new Error('读取分享页面超时。'), { target: resolvedTarget })) });
    });
  }
  function douyinCandidates(video) {
    const urls = [];
    for (const value of [video.currentSrc, video.src, ...[...video.querySelectorAll('source')].map(el => el.src)]) {
      const url = compatible(value); if (url) urls.push(url);
    }
    const id = identity(video);
    if (id) for (const root of [...pageRoots(), ...payloads, ...reactRoots(video)].reverse()) for (const item of matchedObjects(root, id)) urls.push(...douyinAddresses(item));
    return [...new Set(urls)];
  }
  function reactRoots(video) {
    const roots = [];
    for (let el = video, level = 0; el && level < 16; el = el.parentElement, level++) {
      for (const key of Object.keys(el)) {
        if (key.startsWith('__reactProps$')) roots.push(el[key]);
        if (key.startsWith('__reactFiber$')) {
          for (let fiber = el[key], depth = 0; fiber && depth < 12; fiber = fiber.return, depth++) {
            if (fiber.memoizedProps) roots.push(fiber.memoizedProps);
          }
        }
      }
    }
    return roots;
  }
  function mp4Tracks(buffer) {
    const bytes = new Uint8Array(buffer), view = new DataView(buffer); const tracks = new Set();
    const four = pos => String.fromCharCode(...bytes.subarray(pos, pos + 4));
    function walk(start, end, depth = 0) {
      if (depth > 8) return;
      for (let pos = start; pos + 8 <= end;) {
        let size = view.getUint32(pos), header = 8;
        if (size === 1) { if (pos + 16 > end) return; size = Number(view.getBigUint64(pos + 8)); header = 16; }
        if (!size) size = end - pos;
        if (size < header || pos + size > end) return;
        const type = four(pos + 4);
        if (['moov', 'trak', 'mdia'].includes(type)) walk(pos + header, pos + size, depth + 1);
        if (type === 'hdlr' && size >= header + 12) tracks.add(four(pos + header + 8));
        pos += size;
      }
    }
    // 尾部 Range 可能从 mdat 中间开始；只解析完整的 moov 子树。
    for (let pos = 4; pos + 4 <= bytes.length; pos++) if (four(pos) === 'moov') {
      const start = pos - 4, size = view.getUint32(start);
      if (size >= 8 && start + size <= bytes.length) walk(start, start + size);
    }
    return { video: tracks.has('vide'), audio: tracks.has('soun') };
  }
  function moovEnd(buffer) {
    const bytes = new Uint8Array(buffer), view = new DataView(buffer);
    for (let pos = 4; pos + 4 <= Math.min(bytes.length, 262144); pos++) {
      if (String.fromCharCode(...bytes.subarray(pos, pos + 4)) !== 'moov') continue;
      const size = view.getUint32(pos - 4), end = pos - 4 + size;
      if (size >= 8 && end <= 8388608) return end;
    }
    return null;
  }
  function webmTracks(buffer) {
    const bytes = new Uint8Array(buffer), tracks = new Set();
    function vint(pos, id = false) {
      if (!bytes[pos]) return null;
      let length = 1, mask = 128;
      while (!(bytes[pos] & mask) && length <= 8) { mask >>= 1; length++; }
      if (length > 8 || pos + length > bytes.length) return null;
      let value = id ? bytes[pos] : bytes[pos] & (mask - 1);
      for (let i = 1; i < length; i++) value = value * 256 + bytes[pos + i];
      return { value, next: pos + length };
    }
    if (bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) return { video: false, audio: false };
    for (let pos = 4; pos + 5 < Math.min(bytes.length, 262144); pos++) {
      if (bytes[pos] !== 0x16 || bytes[pos + 1] !== 0x54 || bytes[pos + 2] !== 0xae || bytes[pos + 3] !== 0x6b) continue;
      const size = vint(pos + 4); if (!size || size.next + size.value > bytes.length) continue;
      for (let p = size.next, end = p + size.value; p < end;) {
        const id = vint(p, true), entry = id && vint(id.next);
        if (!entry || entry.next + entry.value > end) break;
        if (id.value === 0xae) for (let q = entry.next, stop = q + entry.value; q < stop;) {
          const field = vint(q, true), length = field && vint(field.next);
          if (!length || length.next + length.value > stop) break;
          if (field.value === 0x83 && length.value === 1) tracks.add(bytes[length.next]);
          q = length.next + length.value;
        }
        p = entry.next + entry.value;
      }
      if (tracks.size) break;
    }
    return { video: tracks.has(1), audio: tracks.has(2) };
  }
  function mediaTracks(buffer) {
    const mp4 = mp4Tracks(buffer);
    return mp4.video || mp4.audio ? mp4 : webmTracks(buffer);
  }
  function pageRequest(url) {
    return new Promise((resolve, reject) => {
      let handle, settled = false;
      const fail = message => { if (!settled) { settled = true; reject(new Error(message)); } };
      handle = GM_xmlhttpRequest({ method: 'GET', url, responseType: 'arraybuffer', timeout: 15000,
        headers: { Range: 'bytes=0-3999999' },
        onprogress: e => { if (e.loaded > 4000000) { fail('网页响应过大，需打开播放器解析。'); handle?.abort(); } },
        onload: r => {
          if (settled) return;
          if (![200, 206].includes(r.status)) return fail(`网页 HTTP ${r.status}`);
          if (!r.response || r.response.byteLength > 4000000) return fail('网页响应过大或为空。');
          settled = true; resolve(r);
        }, onerror: () => fail('网页无法连接。'), ontimeout: () => fail('读取网页超时。') });
    });
  }
  function absoluteMedia(value, base) {
    try { return httpURL(new URL(value, base).href); } catch { return null; }
  }
  function pageVideoCandidates(doc, base) {
    const declaredBase = doc.querySelector('base[href]')?.getAttribute('href');
    if (declaredBase) base = absoluteMedia(declaredBase, base) || base;
    const videos = [...doc.querySelectorAll('video')];
    if (videos.length > 1) throw new Error('网页有多个视频，需要打开网页并只播放目标视频。');
    const sources = videos.flatMap(v => [v.getAttribute('src'), ...[...v.querySelectorAll('source')].map(s => s.getAttribute('src'))]);
    const native = sources.filter(Boolean).map(s => absoluteMedia(s, base)).filter(Boolean);
    if (native.length) return [...new Set(native)];
    const metadata = [...doc.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[itemprop="contentUrl"]')].map(m => m.getAttribute('content'));
    const objects = [];
    function walk(value, depth = 0) {
      if (!value || typeof value !== 'object' || depth > 12) return;
      if ([value['@type']].flat().includes('VideoObject') && typeof value.contentUrl === 'string') objects.push(value.contentUrl);
      else for (const child of Object.values(value)) if (typeof child === 'object') walk(child, depth + 1);
    }
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { if (script.textContent.length < 1000000) walk(JSON.parse(script.textContent)); } catch {}
    }
    if (new Set(objects).size > 1) throw new Error('网页描述了多个视频，需要打开播放器确认目标。');
    return [...new Set([...metadata, ...objects].filter(Boolean).map(s => absoluteMedia(s, base)).filter(Boolean))];
  }
  function genericVideoCandidates(video) {
    const values = [video.currentSrc, video.src, ...[...video.querySelectorAll('source')].map(s => s.src)];
    // 仅查看目标 video 的局部播放器配置，不扫描全页推荐列表和所有网络请求。
    const seen = new WeakSet();
    function walk(value, depth = 0) {
      if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); return; }
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'string' && /^(src|file|url|playUrl|videoUrl|hlsUrl|contentUrl)$/i.test(key) && /\.(mp4|webm|m3u8)(?:[?#]|$)/i.test(child)) values.push(child);
        else if (typeof child === 'object' && /^(sources?|video|player|props|config|options|children)$/i.test(key)) walk(child, depth + 1);
      }
    }
    for (let el = video, i = 0; el && i < 3; el = el.parentElement, i++) {
      values.push(el.getAttribute?.('data-video-url'), el.getAttribute?.('data-src'));
      for (const key of Object.keys(el)) if (key.startsWith('__reactProps$')) walk(el[key]);
    }
    if (siteName() === '腾讯视频') { try { values.push(siteLink(video)); } catch {} }
    return [...new Set(values.filter(Boolean).map(v => absoluteMedia(v, location.href)).filter(Boolean))];
  }
  function hlsAttributes(line) {
    const attrs = {};
    for (const match of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,\r\n]+)/g)) attrs[match[1]] = match[2].replace(/^"|"$/g, '');
    return attrs;
  }
  function tsTracks(buffer) {
    const bytes = new Uint8Array(buffer); let video = false, audio = false;
    // 读取 TS 的 PMT 声明，避免把单独音频分片当作完整视频。
    for (let pos = 0; pos + 188 <= bytes.length; pos++) {
      if (bytes[pos] !== 0x47 || bytes[pos + 188] !== 0x47 || !(bytes[pos + 1] & 0x40)) continue;
      const control = (bytes[pos + 3] >> 4) & 3;
      if (!(control & 1)) continue;
      let p = pos + 4; if (control & 2) p += 1 + bytes[p];
      if (p >= pos + 188) continue;
      p += 1 + bytes[p];
      if (p + 12 > pos + 188 || bytes[p] !== 2) continue;
      const end = p + 3 + ((bytes[p + 1] & 15) << 8 | bytes[p + 2]) - 4;
      if (end > pos + 188) continue;
      for (let q = p + 12 + ((bytes[p + 10] & 15) << 8 | bytes[p + 11]); q + 5 <= end;) {
        video ||= [0x1b, 0x24, 0x02, 0x10].includes(bytes[q]);
        audio ||= [0x0f, 0x11, 0x03, 0x04, 0x81].includes(bytes[q]);
        q += 5 + ((bytes[q + 3] & 15) << 8 | bytes[q + 4]);
      }
      if (video && audio) break;
    }
    return { video, audio };
  }
  function budgetRange(url, range, maxBytes, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('媒体验证超时，请重新解析。');
    return mediaRange(url, range, maxBytes, Math.min(8000, remaining));
  }
  async function verifiedHLS(url, depth = 0, deadline = Date.now() + 55000) {
    if (depth > 3) throw new Error('HLS 嵌套过深。');
    const response = await budgetRange(url, 'bytes=0-524287', 550000, deadline);
    const text = new TextDecoder().decode(response.response).trim(), base = httpURL(response.finalUrl || url);
    if (!text.startsWith('#EXTM3U')) throw new Error('该地址不是 HLS 播放列表。');
    const lines = text.split(/\r?\n/).map(s => s.trim());
    if (lines.some(line => /^#EXT-X-(?:SESSION-)?KEY:/.test(line) && hlsAttributes(line).METHOD !== 'NONE')) throw new Error('加密 HLS 需要对应授权解析服务。');
    const variants = [];
    const separated = lines.filter(line => line.startsWith('#EXT-X-MEDIA:')).map(hlsAttributes).filter(a => a.TYPE === 'AUDIO' && a.URI).map(a => a['GROUP-ID']);
    for (let i = 0; i < lines.length - 1; i++) if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = hlsAttributes(lines[i]);
      if (!separated.includes(attrs.AUDIO) && lines[i + 1] && !lines[i + 1].startsWith('#')) variants.push({ url: absoluteMedia(lines[i + 1], base), bitrate: Number(attrs.BANDWIDTH) || 0 });
    }
    if (lines.some(line => line.startsWith('#EXT-X-STREAM-INF:'))) {
      if (!variants.length) throw new Error('HLS 声音与视频分离，需要合并解析服务。');
      let error;
      for (const variant of variants.sort((a, b) => b.bitrate - a.bitrate).slice(0, 4)) {
        try { return await verifiedHLS(variant.url, depth + 1, deadline); } catch (e) { error = e; }
      }
      throw error;
    }
    if (lines.some(line => line.startsWith('#EXT-X-BYTERANGE:'))) throw new Error('此 HLS 使用分片字节区间，需要对应解析服务。');
    const segment = lines.find(line => line && !line.startsWith('#'));
    if (!segment || !lines.some(line => line.startsWith('#EXTINF:'))) throw new Error('HLS 没有可验证的视频分片。');
    const sample = await budgetRange(absoluteMedia(segment, base), 'bytes=0-1048575', undefined, deadline);
    let tracks = tsTracks(sample.response);
    const map = lines.find(line => line.startsWith('#EXT-X-MAP:'));
    if (map) {
      const attrs = hlsAttributes(map);
      if (!attrs.URI || attrs.BYTERANGE) throw new Error('无法验证此 HLS 的初始化数据。');
      const init = await budgetRange(absoluteMedia(attrs.URI, base), 'bytes=0-1048575', undefined, deadline);
      tracks = mp4Tracks(init.response);
    }
    if (!tracks.video || !tracks.audio) throw new Error('HLS 未确认同一视频流包含声音，需要合并服务。');
    return base;
  }
  async function verifiedGeneric(candidates) {
    let error;
    const deadline = Date.now() + 55000;
    for (const url of new Set(candidates)) {
      if (Date.now() > deadline) break;
      try {
        if (/\.(mpd|m4s)(?:[?#]|$)/i.test(url)) throw new Error('DASH 或分离轨需要合并服务。');
        if (/\.m3u8(?:[?#]|$)/i.test(url)) return await verifiedHLS(url, 0, deadline);
        const head = await budgetRange(url, 'bytes=0-1048575', undefined, deadline);
        if (/^\s*#EXTM3U/.test(new TextDecoder().decode(head.response.slice(0, 256)))) return await verifiedHLS(head.finalUrl || url, 0, deadline);
        return await verifiedDouyin([url], null, '网页媒体', deadline);
      } catch (e) { error = e; }
    }
    throw error || new Error('未找到可直接访问并包含声音的视频地址，请播放目标视频后重试。');
  }
  function mediaRange(url, range, maxBytes = 1100000, timeout = 8000) {
    return new Promise((resolve, reject) => {
      let handle, settled = false;
      const fail = (message, status) => { if (!settled) { settled = true; reject(Object.assign(new Error(message), { status })); } };
      handle = GM_xmlhttpRequest({ method: 'GET', url, anonymous: true, responseType: 'arraybuffer',
        headers: { Range: range }, timeout,
        onprogress: event => { if (event.loaded > maxBytes) { fail('媒体服务器不支持小范围验证。'); handle?.abort(); } },
        onload: response => {
          if (settled) return;
          if (response.status !== 200 && response.status !== 206) { fail(`媒体地址 HTTP ${response.status}`, response.status); return; }
          if (!response.response || response.response.byteLength > maxBytes) { fail('媒体响应过大或为空。'); return; }
          settled = true; resolve(response);
        }, onerror: () => fail('媒体地址无法连接。'), ontimeout: () => fail('媒体验证超时。'), onabort: () => fail('媒体验证取消。') });
    });
  }
  function douyinQueue(candidates) {
    const hosts = new Map(), official = [];
    for (const url of new Set(candidates)) {
      try {
        const parsed = new URL(url);
        if (parsed.hostname === 'www.douyin.com' && /^\/aweme\/v\d+\/play\/$/.test(parsed.pathname)) official.push(url);
        else { if (!hosts.has(parsed.hostname)) hosts.set(parsed.hostname, []); hosts.get(parsed.hostname).push(url); }
      } catch {}
    }
    const groups = [...hosts.values()], first = groups.flatMap(group => group.splice(0, 1));
    // 优先不同 CDN，再尝试官方新签名入口，其余地址按域名交替，避免截断后漏掉备用链接。
    const queue = [...first.slice(0, 2), ...official, ...first.slice(2)];
    while (groups.some(group => group.length)) for (const group of groups) if (group.length) queue.push(group.shift());
    return queue;
  }
  async function verifiedDouyin(candidates, refresh, label = '抖音', deadline = Date.now() + 55000) {
    let lastError, forbidden = false, refreshed = false;
    const tried = new Set(), queue = douyinQueue(candidates);
    const read = (url, range, limit) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('解析重试超时，请重新解析。');
      return mediaRange(url, range, limit, Math.min(8000, remaining));
    };
    while (queue.length && Date.now() < deadline) {
      const url = queue.shift();
      if (tried.has(url)) continue;
      tried.add(url);
      try {
        let head = await read(url, 'bytes=0-1048575');
        const direct = httpURL(head.finalUrl || url);
        // 官方入口重定向成功还不够：确认复制出来的裸 CDN URL 本身也能访问。
        if (direct !== httpURL(url)) head = await read(direct, 'bytes=0-1048575');
        if (new URL(head.finalUrl || direct).hostname === 'www.douyin.com') throw new Error('官方入口未返回可用的 MP4 直链。');
        const detectTracks = label === '抖音' ? mp4Tracks : mediaTracks;
        let tracks = detectTracks(head.response);
        const end = moovEnd(head.response);
        if ((!tracks.video || !tracks.audio) && end && end > head.response.byteLength) {
          const metadata = await read(head.finalUrl || direct, `bytes=0-${end - 1}`, end + 1024);
          tracks = detectTracks(metadata.response);
        }
        if (!tracks.video || !tracks.audio) {
          const tail = await read(head.finalUrl || direct, 'bytes=-1048576');
          tracks = detectTracks(tail.response);
        }
        if (!tracks.video || !tracks.audio) throw new Error('未验证到同一媒体中的视频轨和声音轨。');
        return httpURL(head.finalUrl || direct);
      } catch (error) {
        lastError = error; forbidden ||= error.status === 403;
        if (!refreshed && refresh && error.status === 403) {
          refreshed = true;
          const fresh = douyinQueue(refresh()).filter(value => !tried.has(value));
          queue.unshift(...fresh);
        }
      }
    }
    if (forbidden) throw new Error(`${label}地址返回 403，可用备用地址重试仍未通过。请刷新作品页、完成网页验证后重新解析；该链接当前不能作为 VRChat 直链。`);
    throw new Error(lastError ? `${lastError.message} 未复制链接，请刷新作品页后重试。` : '未找到当前抖音媒体地址，请刷新后播放视频再点击。');
  }
  function siteLink(video) {
    const id = identity(video);
    if (!id) throw new Error(`无法确定${siteName()}当前视频编号，请打开该视频的独立播放页，或配置解析服务。`);
    const roots = [...payloads];
    for (const script of document.querySelectorAll('script[type="application/json"],script#RENDER_DATA,script#__NEXT_DATA__')) {
      try { if (script.textContent.length <= 2000000) roots.push(JSON.parse(script.id === 'RENDER_DATA' ? decodeURIComponent(script.textContent) : script.textContent)); } catch {}
    }
    for (const root of roots.reverse()) for (const item of matchedObjects(root, id)) {
      if (siteName() === '抖音') {
        const candidates = douyinAddresses(item);
        for (const value of candidates) { const url = compatible(value); if (url) return url; }
      } else {
        if (item.drm || item.drm_token || item.is_drm) continue;
        for (const entry of item.ul?.ui || []) {
          const direct = compatible(entry.url); if (direct) return direct;
          if (entry.url && entry.hls?.pt) {
            const url = compatible(new URL(entry.hls.pt, entry.url).href); if (url) return url;
          }
        }
      }
    }
    throw new Error(`未发现与当前编号匹配的${siteName()}可用媒体地址。请刷新后播放；分离、加密或受限内容需要有权限的解析服务。`);
  }
  function collect(scope = document) {
    const result = [...scope.querySelectorAll('video')];
    for (const el of scope.querySelectorAll('*')) if (el !== host && el.shadowRoot) result.push(...collect(el.shadowRoot));
    return result;
  }
  function current() {
    const list = collect().filter(video => {
      const r = video.getBoundingClientRect(), s = getComputedStyle(video);
      return !video.paused && !video.ended && video.readyState >= 2 && !/\.(mp3|m4a|aac)(?:[?#]|$)/i.test(video.currentSrc || '') && r.width > 0 && r.height > 0 &&
        r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden';
    });
    if (list.length !== 1) throw new Error(list.length ? '多个视频正在播放，请暂停其他视频。' : '请先播放当前视频；跨域播放器请使用框架内的按钮。');
    return list[0];
  }
  function httpURL(value) {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('需要有效的 HTTP/HTTPS 链接。');
    return url.href;
  }
  function jsonRequest(url, body) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: body ? 'POST' : 'GET', url,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(body) } : {}),
      timeout: body ? 120000 : 15000,
      onload: response => {
        try {
          if (response.status < 200 || response.status >= 300) throw new Error(`接口 HTTP ${response.status}`);
          resolve(JSON.parse(response.responseText));
        } catch (error) { reject(error); }
      },
      onerror: () => reject(new Error('接口请求失败。')),
      ontimeout: () => reject(new Error('解析超时；未复制链接，请查看服务状态。'))
    }));
  }
  function serviceResult(data) {
    if (!data || data.hasAudio !== true || data.danmakuBurned !== true) throw new Error('服务未确认同时包含声音和烧录弹幕，未复制链接。');
    return httpURL(data.mediaUrl);
  }
  function nativeLink(video) {
    const url = httpURL(video.currentSrc || video.src);
    if (/\.(m4s|mpd)(?:[?#]|$)/i.test(url)) throw new Error('当前是分离轨或 DASH 地址，无法确认声音；请配置合并服务。');
    if (!/\.(mp4|webm|m3u8)(?:[?#]|$)/i.test(url)) throw new Error('无法确认当前地址是兼容媒体；请配置解析服务。');
    if (collect().some(other => other !== video && !other.paused && !other.ended)) throw new Error('存在另一个播放组件，无法确认音视频已合并。');
    if ([...document.querySelectorAll('audio')].some(audio => !audio.paused && !audio.ended)) throw new Error('发现独立音频播放，需要合并服务。');
    return url;
  }
  function show(message) {
    tip.textContent = message; tip.hidden = false;
    clearTimeout(show.timer); show.timer = setTimeout(() => { tip.hidden = true; }, 10000);
  }
  async function copyCurrent() {
    if (busy) return;
    // B 站只需作品页 URL，不依赖视频元素、加载状态或播放权限。
    if (siteName() === 'B站') {
      try {
        GM_setClipboard(biliPlayerURL(), 'text');
        show('已复制 B站解析链接，无需播放视频；可直接粘贴到 VRChat。');
      } catch (error) { show(error.message); }
      refreshDetection();
      return;
    }
    let video;
    try { video = current(); } catch (error) { show(error.message); return; }
    busy = true; button.disabled = true; button.textContent = '解析中…';
    const start = location.href, source = video.currentSrc;
    try {
      const endpoint = GM_getValue(SERVICE, '');
      let url, note;
      if (video.mediaKeys) throw new Error('当前使用加密媒体，不能作为普通 VRChat 视频链接解析。');
      if (endpoint) {
        const result = await jsonRequest(httpURL(endpoint), {
          pageUrl: start, mediaUrl: /^https?:/.test(source) ? source : null,
          site: siteName(), videoId: identity(video),
          currentTime: video.currentTime, requirements: { audio: true, burnDanmaku: true, target: 'vrchat' }
        });
        url = serviceResult(result);
        note = '服务已声明链接包含声音和烧录弹幕。';
      } else if (/(^|\.)youtube\.com$/.test(location.hostname) && (/^\/watch$/.test(location.pathname) || /^\/shorts\//.test(location.pathname))) {
        url = httpURL(start); note = '已复制 YouTube 页面链接，由 VRChat 解析；不包含网页叠加弹幕。';
      } else if (siteName() === '抖音') {
        const id = identity(video);
        url = await verifiedDouyin(douyinCandidates(video), () => identity(video) === id ? douyinCandidates(video) : []);
        note = '已复制抖音直链，匿名请求已验证视频和声音轨；不含网页弹幕，链接会过期。';
      } else {
        if (collect().some(other => other !== video && !other.paused && !other.ended) || [...document.querySelectorAll('audio')].some(audio => !audio.paused && !audio.ended)) throw new Error('发现独立播放组件，需合并声音后才能直接解析。');
        url = await verifiedGeneric(genericVideoCandidates(video));
        note = `已复制${siteName()}媒体链接，已验证视频和声音；不含网页叠加弹幕。`;
      }
      if (location.href !== start || video.currentSrc !== source || video.ended || video.paused) throw new Error('当前视频已切换或停止，请重新点击。');
      GM_setClipboard(url, 'text'); show(note);
    } catch (error) { show(error.message || '解析失败。'); }
    finally { busy = false; button.disabled = false; refreshDetection(); }
  }
  function configure() {
    const value = prompt('填写你信任的解析服务完整 API 地址（POST JSON）。服务须合并声音、烧录弹幕并返回远程媒体 URL。配置后点击按钮会把当前网页 URL 发给该服务；留空可清除。', GM_getValue(SERVICE, ''));
    if (value === null) return;
    try { GM_setValue(SERVICE, value.trim() ? httpURL(value.trim()) : ''); show(value.trim() ? '服务已配置；下次点击使用声音+烧录弹幕模式。' : '服务已清除，使用候选链接模式（不含弹幕）。'); }
    catch (error) { show(error.message); }
  }
  function place(x, y, save = false) {
    const r = host.getBoundingClientRect();
    x = Math.max(0, Math.min(Number(x) || 0, Math.max(0, innerWidth - r.width)));
    y = Math.max(0, Math.min(Number(y) || 0, Math.max(0, innerHeight - r.height)));
    host.style.left = `${x}px`; host.style.top = `${y}px`; host.style.right = 'auto'; host.style.bottom = 'auto';
    if (save) GM_setValue('vrc.position', { x, y });
  }
  function refreshDetection() {
    if (!button || busy) return;
    const isDouyin = siteName() === '抖音';
    if (copyPageButton) copyPageButton.hidden = false;
    if (linkInput) {
      linkInput.hidden = false;
      linkInput.setAttribute('aria-label', isDouyin ? '抖音视频链接' : '视频链接');
      linkInput.placeholder = isDouyin ? '粘贴抖音分享文字或任意网站视频链接，再点一键解析' : '粘贴任意网站视频链接或分享文字，再点一键解析';
    }
    if (siteName() === 'B站' && !linkInput?.value.trim()) {
      detected = null;
      try { biliPlayerURL(); button.textContent = 'B站 · 复制解析链接'; button.title = '打开视频页面即可复制，无需播放；按住可拖动'; }
      catch { button.textContent = 'B站 · 请打开视频页'; button.title = '请打开 BV/av 视频页面后复制'; }
      return;
    }
    try { detected = current(); button.textContent = '一键解析'; button.title = '解析输入链接；输入为空时解析当前播放视频，按住可拖动'; }
    catch { detected = null; button.textContent = '一键解析'; button.title = '粘贴视频链接，或先播放当前视频；按住可拖动'; }
  }
  function mount() {
    if (!document.body) return;
    host = document.createElement('div'); host.style.cssText = 'position:fixed;right:16px;bottom:24px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = 'button{background:#2265c6;color:white;border:0;border-radius:24px;padding:13px 18px;font:14px system-ui;cursor:grab;touch-action:none;user-select:none}button:disabled{opacity:.7}p{position:absolute;bottom:100%;right:0;width:280px;background:#17243a;color:#fff;border-radius:8px;padding:12px;font:14px/1.6 system-ui;pointer-events:none}[hidden]{display:none!important}';
    button = document.createElement('button'); button.textContent = '解析复制到 VRChat'; button.title = '点击解析当前播放视频；按住拖动';
    tip = document.createElement('p'); tip.hidden = true;
    copyPageButton = document.createElement('button'); copyPageButton.textContent = '复制视频链接'; copyPageButton.style.marginRight = '6px';
    copyPageButton.addEventListener('click', copyPageLink);
    linkInput = document.createElement('textarea'); linkInput.rows = 3; linkInput.setAttribute('aria-label', '视频链接');
    linkInput.style.cssText = 'display:block;width:260px;box-sizing:border-box;margin-bottom:8px;padding:10px;border:1px solid #526681;border-radius:8px;background:#17243a;color:#fff;font:13px system-ui';
    linkInput.addEventListener('input', refreshDetection);
    linkInput.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); parseLinkInput(); } });
    root.append(style, tip, linkInput, copyPageButton, button); document.body.append(host);
    const saved = GM_getValue('vrc.position', null); if (saved) place(saved.x, saved.y);
    let start, moved = false;
    button.addEventListener('pointerdown', event => { if (event.button !== 0) return; const r = host.getBoundingClientRect(); start = { id: event.pointerId, x: event.clientX, y: event.clientY, left: r.left, top: r.top }; moved = false; button.setPointerCapture(event.pointerId); });
    button.addEventListener('pointermove', event => { if (!start || start.id !== event.pointerId) return; const dx = event.clientX - start.x, dy = event.clientY - start.y; if (Math.hypot(dx, dy) > 5) moved = true; if (moved) { event.preventDefault(); place(start.left + dx, start.top + dy); } });
    const end = event => { if (!start || start.id !== event.pointerId) return; if (moved) { const r = host.getBoundingClientRect(); place(r.left, r.top, true); } start = null; };
    button.addEventListener('pointerup', end); button.addEventListener('pointercancel', end);
    button.addEventListener('click', () => { if (moved) { moved = false; return; } parseLinkInput(); });
    window.addEventListener('resize', () => { const r = host.getBoundingClientRect(); place(r.left, r.top); });
    GM_registerMenuCommand('配置声音+弹幕解析服务', configure);
    GM_registerMenuCommand('解析复制当前视频', copyCurrent);
    GM_registerMenuCommand('复制视频网页链接', copyPageLink);
    if (siteName() === '抖音') GM_registerMenuCommand('复制当前抖音作品链接', copyDouyinPage);
    GM_addValueChangeListener(SHARE_TASK, (key, oldValue, value) => {
      if (waitingToken && value?.token === waitingToken && ['done', 'error'].includes(value.status)) { show(value.message); waitingToken = ''; }
    });
    GM_registerMenuCommand('重置按钮位置', () => place(innerWidth - host.offsetWidth - 16, innerHeight - host.offsetHeight - 24, true));
    for (const name of ['playing', 'pause', 'ended', 'loadedmetadata']) document.addEventListener(name, refreshDetection, true);
    setInterval(() => { refreshDetection(); resumeShareTask(); }, 1000);
    refreshDetection();
    resumeShareTask();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
})();
