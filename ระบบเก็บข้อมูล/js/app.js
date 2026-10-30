(() => {
  'use strict';

  const view = document.getElementById('view');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = sel => view.querySelector(sel) || document.querySelector(sel);

  const UPLOAD_CONCURRENCY = 3;   // อัปโหลดพร้อมกันกี่ภาพ
  const THUMB_SIZE = 320;         // px ด้านยาวของภาพย่อ (เก็บในเครื่อง + ส่งขึ้นชีต)
  const KEEP_DONE_DAYS = 30;      // ลบประวัติที่อัปโหลดแล้วออกจากเครื่องอัตโนมัติ

  // ---------- localStorage ----------
  const LS = {
    get(k, def) {
      try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ }
    },
  };

  const settings = Object.assign({ recorder: '', imageSize: 'original', lastGarden: '' }, LS.get('pg_settings', {}));
  const saveSettings = () => LS.set('pg_settings', settings);

  let deviceId = LS.get('pg_device', '');
  if (!deviceId) {
    deviceId = 'D' + Math.random().toString(36).slice(2, 8).toUpperCase();
    LS.set('pg_device', deviceId);
  }

  let config = LS.get('pg_config', null);
  const remoteStatus = {};      // `${garden}|${date}` -> { sampleId: { slots: [], recorder, saved } }
  const homeFetchedAt = {};     // `${garden}|${date}` -> timestamp
  const historyCache = {};      // `${garden}|${sample}|${slot}` -> { photos, notes }
  const unlocked = new Set();   // sessionKey ของรอบเก่าที่กด "แก้ไขรอบนี้"

  // ---------- helpers ----------
  function today() {
    const d = new Date();
    const z = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  }

  function parseDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  const thaiDate = iso => parseDate(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
  const thaiDay = iso => parseDate(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
  const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 864e5);

  function thaiDateTime(isoTs) {
    const d = new Date(isoTs);
    if (isNaN(d)) return '-';
    return d.toLocaleString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function fmtBytes(n) {
    if (n > 1e9) return (n / 1e9).toFixed(2) + ' GB';
    if (n > 1e6) return (n / 1e6).toFixed(1) + ' MB';
    return Math.round(n / 1e3) + ' KB';
  }

  // ค่าที่วัดเริ่มต้นของสวน (ต้องตรงกับ DEFAULT_FIELDS ใน apps-script/Code.gs) — เพิ่ม/ลบได้ในหน้าตั้งค่าสวน
  const DEFAULT_FIELDS = [
    { id: 'stem_len', label: 'ความยาวก้าน', unit: 'cm' },
    { id: 'stem_dia', label: 'ขนาดก้าน', unit: 'mm' },
    { id: 'nodes', label: 'จำนวนข้อปล้อง', unit: 'ข้อ' },
    { id: 'leaves', label: 'จำนวนใบ', unit: 'ใบ' },
    { id: 'spad', label: 'SPAD', unit: '' },
    { id: 'leaf_area', label: 'พื้นที่ใบ', unit: 'cm²' },
  ];
  const fieldsOf = g => (g && g.fields) || DEFAULT_FIELDS;

  // ค่าที่วัดที่กรอกแล้วแต่ยังไม่กดบันทึก: sessionKey -> { กิ่ง: { fieldId: 'ค่า' } }  (เก็บถาวรเผื่อเบราว์เซอร์รีโหลดตอนเปิดกล้อง)
  const mdraft = LS.get('pg_mdraft', {});
  const saveMdraft = () => LS.set('pg_mdraft', mdraft);

  // ค่าปัจจุบัน = ที่บันทึกไว้ (session.measures) ซ้อนด้วยที่กำลังกรอก; ค่าว่าง = ลบค่านั้น
  function mergedMeasures(sKey, session) {
    const out = {};
    const base = (session && session.measures) || {};
    Object.keys(base).forEach(b => { out[b] = Object.assign({}, base[b]); });
    const d = mdraft[sKey] || {};
    Object.keys(d).forEach(b => Object.keys(d[b]).forEach(f => {
      const v = String(d[b][f]).trim().replace(',', '.');
      if (v === '') { if (out[b]) delete out[b][f]; } else (out[b] || (out[b] = {}))[f] = v;
    }));
    Object.keys(out).forEach(b => { if (!Object.keys(out[b]).length) delete out[b]; });
    return out;
  }

  const sameTime = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) < 1000;
  const findGarden = id => config && config.gardens.find(g => g.id === id);
  const sampleIds = t => Array.from({ length: t.samples }, (_, i) => `${t.id}P${i + 1}`);
  const sessionKey = (g, d, s) => `${g}|${d}|${s}`;

  function slotsFor(branches) {
    const slots = [{ id: 'PLANT', branch: 0, part: 'PLANT', label: 'ภาพต้น', name: 'ภาพต้น' }];
    for (let b = 1; b <= branches; b++) {
      slots.push({ id: `B${b}_CLUSTER`, branch: b, part: 'CLUSTER', label: 'ชุดใบ', name: `กิ่ง ${b} · ชุดใบ` });
      slots.push({ id: `B${b}_LEAF`, branch: b, part: 'LEAF', label: 'ใบเดี่ยว', name: `กิ่ง ${b} · ใบเดี่ยว` });
    }
    return slots;
  }

  function slotLabel(p) {
    if (p.part === 'PLANT') return 'ภาพต้น';
    return `กิ่ง ${p.branch} ${p.part === 'CLUSTER' ? 'ชุดใบ' : 'ใบเดี่ยว'}`;
  }

  function sampleList(g) {
    return g.treatments.flatMap(t => sampleIds(t).map(s => ({ t: t.id, s })));
  }
  function siblingSample(g, sid, step) {
    const list = sampleList(g);
    const i = list.findIndex(x => x.s === sid);
    return i >= 0 ? list[i + step] || null : null;
  }

  function hashFor(path, q) {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v != null && v !== '')).toString();
    return '#' + path + (qs ? '?' + qs : '');
  }

  let toastTimer;
  function toast(msg, ms = 2500) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // สถานะ: ใช้ไอคอน + ข้อความคู่กับสีเสมอ (อ่านได้แม้กลางแดดหรือแยกสีไม่ออก)
  const CHIP_ST = {
    none:    { icon: 'circle',      text: 'ยังไม่ถ่าย' },
    partial: { icon: 'half',        text: 'ยังไม่ครบ' },
    draft:   { icon: 'pencil',      text: 'ยังไม่บันทึก' },
    queued:  { icon: 'clock',       text: 'รออัปโหลด' },
    done:    { icon: 'checkCircle', text: 'ครบแล้ว' },
  };
  const TILE_ST = {
    empty:   { icon: 'camera',      text: 'แตะเพื่อถ่าย' },
    nophoto: { icon: 'circle',      text: 'ไม่มีภาพ' },
    draft:   { icon: 'pencil',      text: 'ยังไม่บันทึก' },
    queued:  { icon: 'clock',       text: 'รออัปโหลด' },
    done:    { icon: 'checkCircle', text: 'บน Drive แล้ว' },
    missing: { icon: 'alert',       text: 'ภาพหาย ถ่ายใหม่' },
  };

  // ---------- image processing ----------
  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('อ่านภาพไม่ได้')); };
      img.src = url;
    });
  }

  function drawScaled(src, w, h, max) {
    const r = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * r);
    c.height = Math.round(h * r);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  const canvasToBlob = (c, type, q) => new Promise(res => c.toBlob(res, type, q));

  // ภาพย่อ: ให้เบราว์เซอร์ถอดรหัสภาพที่ขนาดเล็กเลย (createImageBitmap + resize) ใช้ RAM น้อยกว่าโหลดภาพเต็ม
  async function makeThumb(file) {
    if (window.createImageBitmap) {
      try {
        const bmp = await createImageBitmap(file, { resizeWidth: THUMB_SIZE * 2, resizeQuality: 'medium' });
        const c = drawScaled(bmp, bmp.width, bmp.height, THUMB_SIZE);
        if (bmp.close) bmp.close();
        return c.toDataURL('image/jpeg', 0.6);
      } catch (e) { /* fallback */ }
    }
    const img = await loadImage(file);
    return drawScaled(img, img.naturalWidth, img.naturalHeight, THUMB_SIZE).toDataURL('image/jpeg', 0.6);
  }

  async function resizeIfNeeded(file) {
    const max = parseInt(settings.imageSize, 10);
    if (!max) return file;
    const img = await loadImage(file);
    if (Math.max(img.naturalWidth, img.naturalHeight) <= max) return file;
    return (await canvasToBlob(drawScaled(img, img.naturalWidth, img.naturalHeight, max), 'image/jpeg', 0.9)) || file;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  // ส่งไฟล์ตรงไปที่ Google Drive (resumable upload session) — ส่ง Blob จากดิสก์ ไม่ต้องแปลง base64
  function putBlob(url, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.timeout = 10 * 60 * 1000;
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        if (xhr.status === 200 || xhr.status === 201) {
          try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(new Error('Drive response ไม่ถูกต้อง')); }
        } else {
          reject(new Error('Drive upload HTTP ' + xhr.status));
        }
      };
      xhr.onerror = () => reject(Object.assign(new Error('เชื่อมต่อ Drive ไม่ได้'), { network: true }));
      xhr.ontimeout = () => reject(new Error('หมดเวลาการอัปโหลด'));
      xhr.send(blob);
    });
  }

  // ---------- server data ----------
  const online = () => navigator.onLine && API.ready();

  async function loadConfig() {
    const data = await API.get('config');
    config = Object.assign(data, { fetchedAt: new Date().toISOString() });
    LS.set('pg_config', config);
    return config;
  }

  async function fetchRemoteStatus(gid, date) {
    try {
      const data = await API.get('status', { garden: gid, date });
      remoteStatus[`${gid}|${date}`] = data.samples || {};
      return true;
    } catch (e) {
      return false;
    }
  }

  async function fetchDates(gid) {
    try {
      LS.set('pg_dates_' + gid, await API.get('dates', { garden: gid }));
      return true;
    } catch (e) {
      return false;
    }
  }

  // รอบการเก็บข้อมูล = วันที่จาก Drive (cache ไว้ใช้ตอนออฟไลน์) + วันที่ที่มีข้อมูลในเครื่อง
  async function roundDates(g) {
    const map = {};
    LS.get('pg_dates_' + g.id, []).forEach(d => { map[d.date] = d; });
    (await DB.all('sessions')).forEach(s => {
      if (s.gardenId === g.id && !map[s.date]) map[s.date] = { date: s.date, samples: null, local: true };
    });
    return Object.values(map).sort((a, b) => b.date.localeCompare(a.date));
  }

  // ดึงภาพที่อยู่บน Drive แล้วของต้นนี้ (จากทุกเครื่อง) มาเก็บในเครื่อง เพื่อถ่ายต่อเฉพาะช่องที่ขาด
  async function syncSample(c) {
    if (!online()) return false;
    let data;
    try {
      data = await API.get('sample', { garden: c.g.id, date: c.date, sample: c.sampleId });
    } catch (e) {
      return false;
    }
    let changed = false;
    for (const r of data.photos) {
      const slot = c.slots.find(s => s.id === r.slot);
      if (!slot) continue;
      const key = `${c.sKey}|${r.slot}`;
      const cur = await DB.get('photos', key);
      if (cur && (cur.status === 'draft' || cur.status === 'queued')) continue;  // ภาพในเครื่องใหม่กว่า
      if (cur && cur.status === 'done' && sameTime(cur.capturedAt, r.captured_at) && cur.thumb) continue;
      await DB.put('photos', {
        key, sessionKey: c.sKey,
        gardenId: c.g.id, gardenName: c.g.name, date: c.date,
        treatment: c.t.id, sampleId: c.sampleId,
        slot: slot.id, branch: slot.branch, part: slot.part,
        thumb: r.thumb || (cur && cur.thumb) || null,
        status: 'done', capturedAt: r.captured_at, fileId: r.file_id, url: r.url,
        remote: true, recorder: r.recorder,
      });
      changed = true;
    }
    const localS = await DB.get('sessions', c.sKey);
    const remoteM = data.measures || {};
    if (data.session && !localS) {
      await DB.put('sessions', {
        key: c.sKey, gardenId: c.g.id, gardenName: c.g.name, date: c.date,
        treatment: c.t.id, sampleId: c.sampleId, expected: c.slots.length,
        note: data.session.note, recorder: data.session.recorder, measures: remoteM,
        status: 'done', savedAt: data.session.saved_at || new Date().toISOString(), remote: true,
      });
      changed = true;
    } else if (localS && localS.status === 'done' && JSON.stringify(localS.measures || {}) !== JSON.stringify(remoteM)) {
      localS.measures = remoteM;   // ค่าที่วัดบน Drive ใหม่กว่า (เช่น กรอกจากเครื่องอื่น)
      await DB.put('sessions', localS);
      changed = true;
    }
    return changed;
  }

  // ---------- uploader (คิวอัปโหลด) ----------
  const Uploader = {
    running: false,
    lastError: '',
    progress: {},        // photoKey -> { label, frac }
    directFailed: false, // ถ้าอัปโหลดตรงไม่ได้ (เช่น CORS) ใช้วิธี base64 ผ่าน Apps Script แทน

    async run() {
      if (this.running || !online()) return;
      this.running = true;
      this.lastError = '';
      emitQueue();
      try {
        for (let guard = 0; guard < 100; guard++) {
          const sessions = (await DB.byIndex('sessions', 'status', 'queued'))
            .sort((a, b) => a.savedAt.localeCompare(b.savedAt));
          if (!sessions.length) break;
          for (const s of sessions) await this.uploadSession(s);
        }
      } catch (e) {
        this.lastError = e.message || String(e);
      } finally {
        this.running = false;
        this.progress = {};
        emitQueue();
      }
    },

    async uploadSession(s) {
      const photos = (await DB.byIndex('photos', 'session', s.key)).filter(p => p.status === 'queued');
      let i = 0;
      const errors = [];
      const worker = async () => {
        while (i < photos.length && !errors.length) {
          const p = photos[i++];
          try { await this.uploadPhoto(s, p); } catch (e) { errors.push(e); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, photos.length) }, worker));
      if (errors.length) throw errors[0];

      const all = await DB.byIndex('photos', 'session', s.key);
      if (all.some(p => p.status === 'queued')) return; // มีภาพใหม่เข้าคิวระหว่างส่ง จะวนกลับมาใหม่
      await API.post('saveSession', {
        gardenId: s.gardenId, gardenName: s.gardenName, date: s.date,
        treatment: s.treatment, sampleId: s.sampleId,
        photoCount: all.filter(p => p.status === 'done').length,
        expectedCount: s.expected, note: s.note, recorder: s.recorder, deviceId,
        measures: s.measures, fieldIds: s.fieldIds,
      });
      const curS = await DB.get('sessions', s.key);
      if (curS && curS.savedAt === s.savedAt) {
        curS.status = 'done';
        curS.uploadedAt = new Date().toISOString();
        await DB.put('sessions', curS);
      }
      Object.keys(historyCache).forEach(k => { if (k.startsWith(`${s.gardenId}|${s.sampleId}|`)) delete historyCache[k]; });
    },

    async uploadPhoto(s, p) {
      const rec = await DB.get('blobs', p.key);
      if (!rec) {
        p.status = 'missing';
        await DB.put('photos', p);
        return;
      }
      // รองรับข้อมูลจากเวอร์ชันก่อนที่เก็บเป็น ArrayBuffer
      const blob = rec.blob || new Blob([rec.data], { type: rec.type });
      const meta = {
        gardenId: s.gardenId, gardenName: s.gardenName, date: s.date,
        treatment: s.treatment, sampleId: s.sampleId,
        slot: p.slot, branch: p.branch, part: p.part,
        mimeType: blob.type || rec.type || 'image/jpeg', size: blob.size,
        capturedAt: p.capturedAt, recorder: s.recorder, deviceId,
      };
      const label = `${s.sampleId} ${slotLabel(p)}`;
      this.setProgress(p.key, label, 0);

      let res = null;
      if (!this.directFailed) {
        const start = await API.post('startUpload', { ...meta, origin: location.origin });
        if (start.skip) {
          res = start;   // ภาพนี้ขึ้น Drive แล้ว (เช่น ส่งครั้งก่อนสำเร็จแต่เน็ตหลุด) ไม่ต้องส่งซ้ำ
        } else {
          try {
            const file = await putBlob(start.uploadUrl, blob, f => this.setProgress(p.key, label, f));
            res = await API.post('finishUpload', { ...meta, fileId: file.id, thumb: p.thumb });
          } catch (e) {
            if (!e.network || !navigator.onLine) throw e;
            this.directFailed = true;
          }
        }
      }
      if (!res) {
        const data = await blobToBase64(blob);
        res = await API.post('upload', { ...meta, data, thumb: p.thumb });
      }

      // ถ้าระหว่างอัปโหลดมีการถ่ายใหม่ อย่าเขียนทับภาพใหม่
      const cur = await DB.get('photos', p.key);
      if (cur && cur.capturedAt === p.capturedAt) {
        Object.assign(cur, { status: 'done', fileId: res.fileId, url: res.url });
        await DB.put('photos', cur);
        await DB.del('blobs', p.key);
      }
      delete this.progress[p.key];
      emitQueue();
    },

    setProgress(key, label, frac) {
      this.progress[key] = { label, frac };
      emitProgress();
    },

    statusText() {
      const items = Object.values(this.progress);
      if (!items.length) return 'กำลังเตรียมอัปโหลด…';
      return items.map(x => `${x.label} ${Math.round(x.frac * 100)}%`).join(' · ');
    },
  };

  let progressQueued = false;
  function emitProgress() {
    if (progressQueued) return;
    progressQueued = true;
    requestAnimationFrame(() => {
      progressQueued = false;
      const el = document.getElementById('upStatus');
      if (el && Uploader.running) el.textContent = Uploader.statusText();
    });
  }

  async function emitQueue() {
    const queued = await DB.count('photos', 'status', 'queued');
    const badge = document.getElementById('badge');
    const on = navigator.onLine;
    badge.className = 'badge' + (on ? '' : ' offline') + (Uploader.running ? ' busy' : '');
    badge.innerHTML = icon(on ? 'wifi' : 'wifiOff') + `<span>${on ? 'ออนไลน์' : 'ออฟไลน์'}</span>` +
      (queued ? `<b class="count">${icon('upload')}${queued}</b>` : '');
    if (route().path === '/queue') renderQueue();
  }

  // ลบประวัติที่อัปโหลดเสร็จแล้วและเก่ากว่า KEEP_DONE_DAYS ออกจากเครื่อง
  async function pruneOld() {
    const cutoff = new Date(Date.now() - KEEP_DONE_DAYS * 864e5).toISOString().slice(0, 10);
    const sessions = (await DB.byIndex('sessions', 'status', 'done')).filter(s => s.date < cutoff);
    for (const s of sessions) {
      const ps = await DB.byIndex('photos', 'session', s.key);
      if (ps.some(p => p.status !== 'done')) continue;
      for (const p of ps) await DB.del('photos', p.key);
      await DB.del('sessions', s.key);
    }
  }

  // ---------- router ----------
  function route() {
    const h = location.hash.slice(1) || '/';
    const [path, qs] = h.split('?');
    return { path, q: Object.fromEntries(new URLSearchParams(qs || '')) };
  }

  function setNav(path) {
    const section = { '/capture': '/', '/history': '/', '/admin': '/settings' }[path] || path;
    document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.path === section));
  }

  async function render() {
    const { path, q } = route();
    if (path !== '/capture') ctx = null;
    setNav(path);
    window.scrollTo(0, 0);
    if (path === '/capture') return renderCapture(q, true);
    if (path === '/history') return renderHistory(q);
    if (path === '/queue') return renderQueue();
    if (path === '/settings') return renderSettings();
    if (path === '/admin') return renderAdmin();
    return renderHome(q);
  }

  function emptyState(title, text, actions = '') {
    return `<section class="panel empty">${icon('sprout', 'ic-xl')}<h2>${title}</h2><p>${text}</p>
      ${actions ? `<div class="actions">${actions}</div>` : ''}</section>`;
  }

  function noConfigView() {
    return emptyState('ยังไม่มีข้อมูลสวน',
      API.ready() ? 'ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อโหลดการตั้งค่าครั้งแรก หรือสร้างสวนใหม่' : 'ยังไม่ได้ตั้งค่า API_URL ในไฟล์ js/config.js',
      `<button class="btn" data-action="reload-config">${icon('refresh')}<span>โหลดการตั้งค่า</span></button>
       <a class="btn primary" href="#/admin">${icon('plus')}<span>สร้างสวน</span></a>`);
  }

  // ---------- views: home ----------
  async function renderHome(q) {
    if (!config || !config.gardens.length) { view.innerHTML = noConfigView(); return; }
    const g = findGarden(q.g) || findGarden(settings.lastGarden) || config.gardens[0];
    const date = q.d || today();
    const isToday = date === today();
    if (settings.lastGarden !== g.id) { settings.lastGarden = g.id; saveSettings(); }

    const photos = await DB.byIndex('photos', 'gardenDate', [g.id, date]);
    const sessions = await DB.byIndex('sessions', 'gardenDate', [g.id, date]);
    const remote = remoteStatus[`${g.id}|${date}`] || {};
    const totalSamples = g.treatments.reduce((a, t) => a + t.samples, 0);

    // สถานะของแต่ละต้น: รวมภาพในเครื่อง + ภาพบน Drive (ช่องเดียวกันนับครั้งเดียว)
    const sampleState = (t, sid) => {
      const key = sessionKey(g.id, date, sid);
      const ps = photos.filter(p => p.sessionKey === key);
      const s = sessions.find(x => x.key === key);
      const expected = slotsFor(t.branches).length;
      const slots = new Set(ps.map(p => p.slot));
      (remote[sid] ? remote[sid].slots : []).forEach(x => slots.add(x));
      const count = slots.size;
      let st = 'none';
      if (count) st = count >= expected ? 'done' : 'partial';
      if ((s && s.status === 'queued') || ps.some(p => p.status === 'queued')) st = 'queued';
      if (ps.some(p => p.status === 'draft')) st = 'draft';
      return { st, count, expected };
    };

    let doneAll = 0;
    const treatmentCard = t => {
      const states = sampleIds(t).map(sid => ({ sid, ...sampleState(t, sid) }));
      const finished = states.filter(x => x.st === 'done').length;
      doneAll += finished;
      return `<section class="panel">
        <div class="panel-head">
          <h2>${esc(t.id)}</h2>
          <span class="meta-text">${t.samples} ต้น · ${t.branches} กิ่ง</span>
          <span class="pill ${finished === t.samples ? 'pill-done' : ''}">${finished}/${t.samples}</span>
        </div>
        <div class="chips">${states.map(x => `
          <a class="chip st-${x.st}" href="${hashFor('/capture', { g: g.id, t: t.id, s: x.sid, d: date })}"
             aria-label="${esc(x.sid)} ${CHIP_ST[x.st].text}">
            <span class="chip-id">${esc(x.sid)}</span>
            <span class="chip-st">${icon(CHIP_ST[x.st].icon)}${x.count ? `${x.count}/${x.expected}` : ''}</span>
          </a>`).join('')}</div>
        <div class="panel-foot">
          <span class="meta-text">ดาวน์โหลดข้อมูล ${esc(t.id)} ทุกรอบ</span>
          <button class="btn sm" data-action="export" data-g="${esc(g.id)}" data-t="${esc(t.id)}"
            aria-label="ดาวน์โหลดข้อมูล ${esc(t.id)} เป็น CSV">${icon('download')}<span>CSV</span></button>
          <button class="btn sm" data-action="photos" data-g="${esc(g.id)}" data-t="${esc(t.id)}"
            aria-label="ดาวน์โหลดรูป ${esc(t.id)}">${icon('image')}<span>รูป</span></button>
        </div>
      </section>`;
    };
    const cards = g.treatments.map(treatmentCard).join('');

    // รอบการเก็บข้อมูล
    const rounds = await roundDates(g);
    const pills = [{ date: today(), label: 'วันนี้' }];
    rounds.forEach(r => { if (r.date !== today()) pills.push(r); });
    if (!pills.some(p => p.date === date)) pills.splice(1, 0, { date });
    const todayInfo = rounds.find(r => r.date === today());
    pills[0].samples = todayInfo ? todayInfo.samples : null;

    view.innerHTML = `
      <section class="panel">
        <label class="field">สวน
          <select id="selGarden">${config.gardens.map(x =>
            `<option value="${esc(x.id)}" ${x.id === g.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        </label>
        <div class="field-label">รอบการเก็บข้อมูล</div>
        <div class="rounds" id="rounds">
          ${pills.map(p => `
            <a class="round${p.date === date ? ' on' : ''}" href="${hashFor('/', { g: g.id, d: p.date })}">
              <b>${p.label || thaiDay(p.date)}</b>
              <small>${p.label ? thaiDay(p.date) : parseDate(p.date).getFullYear() + 543}</small>
              <small>${p.samples != null ? `${p.samples}/${totalSamples} ต้น` : p.local ? 'ในเครื่อง' : '&nbsp;'}</small>
            </a>`).join('')}
          <label class="round round-pick">${icon('calendar')}<b>วันอื่น</b>
            <input type="date" id="selDate" value="${esc(date)}" aria-label="เลือกวันที่">
          </label>
        </div>
      </section>

      ${isToday ? '' : `
        <div class="banner banner-lock">
          ${icon('lock')}
          <div><b>รอบ ${thaiDate(date)}</b><span>ดูอย่างเดียว · แตะที่ต้นเพื่อดูภาพ</span></div>
          <a class="btn sm" href="${hashFor('/', { g: g.id, d: today() })}">ไปวันนี้</a>
        </div>`}

      <div class="summary">
        <div><b>${doneAll}</b><span>/${totalSamples} ต้น ครบแล้ว</span></div>
        <div class="summary-bar"><div style="width:${totalSamples ? Math.round(doneAll / totalSamples * 100) : 0}%"></div></div>
      </div>

      ${cards}

      <div class="legend">${Object.values(CHIP_ST).map(s => `<span>${icon(s.icon)}${s.text}</span>`).join('')}</div>`;

    const sel = $('#rounds .round.on');
    if (sel) sel.scrollIntoView({ inline: 'center', block: 'nearest' });
    $('#selGarden').addEventListener('change', e => { location.hash = hashFor('/', { g: e.target.value }); });
    $('#selDate').addEventListener('change', e => {
      if (e.target.value) location.hash = hashFor('/', { g: g.id, d: e.target.value });
    });

    // ดึงสถานะ + รายการรอบจาก Drive แล้ว render ใหม่ถ้ายังอยู่หน้าเดิม
    const key = `${g.id}|${date}`;
    if (online() && Date.now() - (homeFetchedAt[key] || 0) > 30 * 1000) {
      homeFetchedAt[key] = Date.now();
      const [a, b] = await Promise.all([fetchRemoteStatus(g.id, date), fetchDates(g.id)]);
      if (!a && !b) { homeFetchedAt[key] = 0; return; }
      const r = route();
      if (r.path === '/' && (r.q.g || settings.lastGarden) === g.id && (r.q.d || today()) === date) {
        const y = window.scrollY;
        await renderHome(r.q);
        window.scrollTo(0, y);
      }
    }
  }

  // ---------- views: capture ----------
  let ctx = null;  // context ของหน้าถ่ายภาพปัจจุบัน

  async function renderCapture(q, withSync) {
    if (!config) { view.innerHTML = noConfigView(); return; }
    const g = findGarden(q.g);
    const t = g && g.treatments.find(x => x.id === q.t);
    if (!g || !t || !sampleIds(t).includes(q.s)) {
      view.innerHTML = emptyState(`ไม่พบต้น ${esc(q.s || '')}`,
        'ตรวจสอบการตั้งค่าสวน/ทรีตเมนต์ หรือโหลดการตั้งค่าใหม่ในหน้าตั้งค่า',
        `<a class="btn" href="#/">${icon('home')}<span>กลับหน้าหลัก</span></a>`);
      return;
    }
    // ล็อกวันที่ไว้ใน URL เพื่อให้กลับมาหน้าเดิมได้ถ้าเบราว์เซอร์รีโหลดหลังเปิดกล้อง
    if (!q.d) { location.replace(hashFor('/capture', { ...q, d: today() })); return; }

    const date = q.d;
    const sKey = sessionKey(g.id, date, q.s);
    const slots = slotsFor(t.branches);
    const isPast = date !== today();
    const readOnly = isPast && !unlocked.has(sKey);
    const c = { g, t, date, sampleId: q.s, sKey, slots, readOnly };
    ctx = c;

    const photos = await DB.byIndex('photos', 'session', sKey);
    const session = await DB.get('sessions', sKey);
    const bySlot = Object.fromEntries(photos.map(p => [p.slot, p]));
    const count = photos.length;
    const drafts = photos.filter(p => p.status === 'draft').length;
    const remoteCount = photos.filter(p => p.remote && p.status === 'done').length;
    const prev = siblingSample(g, q.s, -1);
    const next = siblingSample(g, q.s, 1);
    const fields = fieldsOf(g);
    const measures = mergedMeasures(sKey, session);
    const sampleHash = x => hashFor('/capture', { g: g.id, t: x.t, s: x.s, d: date });

    const tile = slot => {
      const p = bySlot[slot.id];
      const st = p ? p.status : readOnly ? 'nophoto' : 'empty';
      const meta = TILE_ST[st] || TILE_ST.empty;
      const img = `<span class="tile-img"${p && p.thumb ? ` style="background-image:url('${p.thumb}')"` : ''}>
          ${p && p.thumb ? '' : icon(p ? 'cloud' : readOnly ? 'image' : 'camera', 'ic-lg')}</span>
        <span class="tile-st">${icon(meta.icon)}${meta.text}</span>`;
      // ช่องว่าง (โหมดแก้ไข) → แตะแล้วเปิดกล้องทันที / ช่องที่มีภาพ → เปิดหน้าดูภาพ (ถ่ายทับได้จากในนั้น)
      const hit = !p && !readOnly
        ? `<label class="tile-hit"><input type="file" accept="image/*" capture="environment" class="vh" data-slot="${slot.id}">${img}</label>`
        : `<button class="tile-hit" data-view="${slot.id}">${img}</button>`;
      return `<div class="tile st-${st}${slot.part === 'PLANT' ? ' wide' : ''}" data-slot="${slot.id}">
        ${hit}
        <div class="tile-label"><span>${esc(slot.label)}</span>
          ${!p && !readOnly ? `<label class="tile-alt" aria-label="เลือก${esc(slot.name)}จากคลังภาพ">
            <input type="file" accept="image/*" class="vh" data-slot="${slot.id}">${icon('image')}</label>` : ''}
        </div>
      </div>`;
    };

    const branchBlocks = [];
    const jumpItems = [];
    for (let b = 1; b <= t.branches; b++) {
      const bs = slots.filter(s => s.branch === b);
      const have = bs.filter(s => bySlot[s.id]).length;
      const mv = measures[b] || {};
      const filled = fields.filter(f => mv[f.id] != null && mv[f.id] !== '').length;
      const measureHtml = fields.length ? `
        <div class="measures">
          <div class="measures-head"><b>ค่าที่วัด</b>
            <span class="meta-text">${filled}/${fields.length} · ข้ามได้</span></div>
          <div class="mgrid">${fields.map(f => `
            <label class="mfield"><span>${esc(f.label)}${f.unit ? ` <small>(${esc(f.unit)})</small>` : ''}</span>
              <input class="m-in" type="text" inputmode="decimal" enterkeyhint="next" autocomplete="off" data-b="${b}" data-f="${esc(f.id)}"
                value="${esc(mv[f.id] != null ? mv[f.id] : '')}" ${readOnly ? 'readonly' : ''} placeholder="-"></label>`).join('')}
          </div>
        </div>` : '';
      jumpItems.push(`<button type="button" data-jump="${b}" class="${have === bs.length && (!fields.length || filled === fields.length) ? 'full' : ''}">
        กิ่ง ${b} <small>${have}/${bs.length}${fields.length ? ` · ${filled}/${fields.length}` : ''}</small></button>`);
      branchBlocks.push(`<section class="panel" id="br${b}">
        <div class="panel-head"><h2>กิ่ง ${b}</h2><span class="pill ${have === bs.length ? 'pill-done' : ''}">${have}/${bs.length}</span></div>
        <div class="tiles">${bs.map(tile).join('')}</div>${measureHtml}</section>`);
    }

    let banner = '';
    if (readOnly) {
      banner = `<div class="banner banner-lock">${icon('lock')}
        <div><b>ดูอย่างเดียว</b><span>รอบ ${thaiDate(date)} · แตะภาพเพื่อดู</span></div>
        <button class="btn sm" data-action="unlock">${icon('unlock')}<span>แก้ไขรอบนี้</span></button></div>`;
    } else if (isPast) {
      banner = `<div class="banner banner-warn">${icon('pencil')}
        <div><b>กำลังแก้ไขรอบเก่า</b><span>${thaiDate(date)} · ภาพที่ถ่ายจะถูกบันทึกเป็นรอบนี้</span></div>
        <button class="btn sm" data-action="lock">${icon('lock')}<span>ล็อก</span></button></div>`;
    }

    view.innerHTML = `
      <section class="panel head">
        <div class="head-top">
          <a class="icon-btn" href="${hashFor('/', { g: g.id, d: date })}" aria-label="กลับ">${icon('left')}</a>
          <div class="head-title">
            <h1>${esc(q.s)}</h1>
            <div class="meta-text">${esc(g.name)} · ${esc(t.id)} · ${thaiDate(date)}</div>
          </div>
          <a class="icon-btn labeled" href="${hashFor('/history', { g: g.id, t: t.id, s: q.s, d: date })}">${icon('history')}<span>ประวัติ</span></a>
        </div>
        <div class="progress"><div style="width:${Math.round(count / slots.length * 100)}%"></div></div>
        <div class="head-meta"><b>${count}/${slots.length}</b> ภาพ
          ${remoteCount ? `<span class="meta-text">· จาก Drive ${remoteCount}</span>` : ''}
          <span class="meta-text" id="syncNote"></span></div>
      </section>
      ${banner}
      ${jumpItems.length > 1 ? `<nav class="jump" aria-label="ข้ามไปกิ่ง">${jumpItems.join('')}</nav>` : ''}
      <section class="panel"><div class="tiles">${tile(slots[0])}</div></section>
      ${branchBlocks.join('')}
      <section class="panel">
        <label class="field">หมายเหตุ
          <textarea id="note" rows="2" placeholder="เช่น กิ่ง 3 หัก, ใบมีโรค" ${readOnly ? 'readonly' : ''}>${esc(session ? session.note : '')}</textarea>
        </label>
      </section>
      <div class="actionbar">
        ${prev ? `<a class="btn nav-btn" href="${sampleHash(prev)}" aria-label="ต้นก่อนหน้า ${esc(prev.s)}">${icon('left')}<span>${esc(prev.s)}</span></a>` : '<span class="nav-btn"></span>'}
        ${readOnly
          ? `<a class="btn grow" href="${hashFor('/history', { g: g.id, t: t.id, s: q.s, d: date })}">${icon('history')}<span>ดูประวัติต้นนี้</span></a>`
          : `<button class="btn primary grow" data-action="save">${icon('save')}<span>บันทึก${drafts ? ` (${drafts} ใหม่)` : ''}</span></button>`}
        ${next ? `<a class="btn nav-btn" href="${sampleHash(next)}" aria-label="ต้นถัดไป ${esc(next.s)}"><span>${esc(next.s)}</span>${icon('right')}</a>` : '<span class="nav-btn"></span>'}
      </div>`;

    bindPickers(view, c);

    if (withSync && online()) {
      const note = $('#syncNote');
      if (note) note.textContent = '· กำลังตรวจสอบ Drive…';
      const changed = await syncSample(c);
      if (ctx !== c || route().path !== '/capture') return;
      if (changed) {
        await rerenderCapture();
      } else {
        const n = $('#syncNote');
        if (n) n.textContent = '';
      }
    }
  }

  // ผูก listener กับ input โดยตรง — ถ้าหน้าถูก render ใหม่ระหว่างเปิดกล้อง input เดิมยังรับภาพได้
  function bindPickers(root, c, slotId) {
    root.querySelectorAll('input[type=file]').forEach(input => {
      const sid = slotId || input.dataset.slot;
      if (!sid) return;
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        hideSheet();
        handleCapture(c, sid, file);
      });
    });
  }

  async function rerenderCapture() {
    const y = window.scrollY;
    const typed = ($('#note') || {}).value;
    await renderCapture(route().q, false);
    if (typed && $('#note') && !$('#note').readOnly) $('#note').value = typed;
    window.scrollTo(0, y);
  }

  async function handleCapture(c, slotId, file) {
    const slot = c.slots.find(s => s.id === slotId);
    const tileEl = view.querySelector(`.tile[data-slot="${slotId}"]`);
    if (ctx === c && tileEl) tileEl.classList.add('busy');
    try {
      let thumb = null;
      try { thumb = await makeThumb(file); } catch (e) { /* อ่าน preview ไม่ได้ (เช่น HEIC บางเครื่อง) — ยังเก็บไฟล์ได้ */ }
      let blob = file;
      try { blob = await resizeIfNeeded(file); } catch (e) { /* ใช้ไฟล์ต้นฉบับ */ }
      // คัดลอกเป็น Blob ใหม่ — iOS อาจลบไฟล์ชั่วคราวจากกล้องทิ้งภายหลัง
      const stored = new Blob([await blob.arrayBuffer()], { type: blob.type || 'image/jpeg' });
      const key = `${c.sKey}|${slot.id}`;
      await DB.put('blobs', { key, blob: stored });
      await DB.put('photos', {
        key, sessionKey: c.sKey,
        gardenId: c.g.id, gardenName: c.g.name, date: c.date,
        treatment: c.t.id, sampleId: c.sampleId,
        slot: slot.id, branch: slot.branch, part: slot.part,
        type: stored.type, size: stored.size, thumb,
        status: 'draft', capturedAt: new Date().toISOString(),
      });
    } catch (e) {
      toast('เก็บภาพไม่สำเร็จ: ' + (e.message || e), 4000);
    }
    if (ctx === c && route().path === '/capture') await rerenderCapture();
  }

  // ---------- viewer (ดูภาพ) ----------
  let sheetCleanup = null;

  function showSheet(html, cleanup) {
    hideSheet();
    const el = document.getElementById('sheet');
    el.querySelector('.sheet-body').innerHTML = html;
    el.classList.add('show');
    sheetCleanup = cleanup || null;
    return el;
  }

  function hideSheet() {
    const el = document.getElementById('sheet');
    el.classList.remove('show');
    if (sheetCleanup) { sheetCleanup(); sheetCleanup = null; }
  }

  // ถ้าผู้ใช้ล็อกอิน Google และมีสิทธิ์ในโฟลเดอร์ จะได้ภาพความละเอียดสูงจาก Drive มาแทนภาพย่อ
  function tryHiRes(fileId) {
    const img = document.getElementById('viewerImg');
    if (!img || !fileId || !navigator.onLine) return;
    const hi = new Image();
    hi.referrerPolicy = 'no-referrer';
    hi.onload = () => { if (document.getElementById('viewerImg') === img && hi.naturalWidth > THUMB_SIZE) img.src = hi.src; };
    hi.src = `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1600`;
  }

  function viewerHtml({ title, sub, src, rows, actions, hint }) {
    return `
      <div class="sheet-head">
        <div><h2>${title}</h2><div class="meta-text">${sub}</div></div>
        <button class="icon-btn" data-action="close-sheet" aria-label="ปิด">${icon('x')}</button>
      </div>
      <div class="viewer-img">${src ? `<img id="viewerImg" src="${src}" alt="">`
        : `<div class="viewer-empty">${icon('image', 'ic-xl')}<span>ยังไม่มีภาพ</span></div>`}</div>
      ${rows && rows.length ? `<dl class="meta">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` : ''}
      ${hint ? `<p class="hint">${hint}</p>` : ''}
      <div class="sheet-actions">${actions || ''}</div>`;
  }

  async function openSlotViewer(slotId) {
    const c = ctx;
    if (!c) return;
    const slot = c.slots.find(s => s.id === slotId);
    const p = await DB.get('photos', `${c.sKey}|${slotId}`);
    let src = p && p.thumb;
    let objUrl = null;
    if (p) {
      const rec = await DB.get('blobs', p.key);
      if (rec) {
        objUrl = URL.createObjectURL(rec.blob || new Blob([rec.data], { type: rec.type }));
        src = objUrl;
      }
    }
    const st = p ? TILE_ST[p.status] : null;
    const rows = p ? [
      ['สถานะ', st ? `<span class="st-inline st-${p.status}">${icon(st.icon)}${st.text}</span>` : '-'],
      ['ถ่ายเมื่อ', esc(thaiDateTime(p.capturedAt))],
      ['ผู้บันทึก', esc(p.recorder || settings.recorder || '-')],
    ] : [];

    let actions = '';
    if (!c.readOnly) {
      actions += `<label class="btn primary">${icon('camera')}<span>${p ? 'ถ่ายใหม่แทนภาพนี้' : 'ถ่ายภาพ'}</span>
          <input type="file" accept="image/*" capture="environment" class="vh"></label>
        <label class="btn">${icon('image')}<span>เลือกจากคลังภาพ</span><input type="file" accept="image/*" class="vh"></label>`;
      if (p && p.status === 'draft') actions += `<button class="btn danger" data-del="${slotId}">${icon('trash')}<span>ลบภาพนี้</span></button>`;
    }
    if (p && p.url) actions += `<a class="btn" href="${esc(p.url)}" target="_blank" rel="noopener">${icon('external')}<span>เปิดใน Google Drive</span></a>`;

    const el = showSheet(viewerHtml({
      title: `${esc(c.sampleId)} · ${esc(slot.name)}`,
      sub: `${esc(c.g.name)} · ${thaiDate(c.date)}`,
      src, rows, actions,
      hint: !c.readOnly && p && p.status === 'done' ? 'ถ่ายใหม่แล้วภาพเดิมบน Drive จะถูกย้ายไปถังขยะ (กู้คืนได้ภายใน 30 วัน)' : '',
    }), () => { if (objUrl) URL.revokeObjectURL(objUrl); });
    bindPickers(el, c, slotId);
    if (!objUrl && p) tryHiRes(p.fileId);
  }

  async function deleteDraft(slotId) {
    if (!ctx || !confirm('ลบภาพนี้?')) return;
    const key = `${ctx.sKey}|${slotId}`;
    await DB.del('photos', key);
    await DB.del('blobs', key);
    hideSheet();
    rerenderCapture();
  }

  let pendingShare = [];   // ไฟล์ภาพที่เพิ่งบันทึก รอให้ผู้ใช้กดเก็บลงเครื่อง

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // เว็บเขียนลงแกลเลอรีเองเงียบ ๆ ไม่ได้ จึงเปิดหน้าต่างแชร์ของเครื่อง (ต้องเรียกตรงจากการกดปุ่ม)
  function savePhotosToDevice() {
    const files = pendingShare;
    if (!files.length) return;
    if (navigator.canShare && navigator.canShare({ files })) {
      navigator.share({ files }).catch(e => { if (e.name !== 'AbortError') toast('เก็บภาพไม่สำเร็จ: ' + e.message, 4000); });
    } else {
      files.forEach((f, i) => setTimeout(() => downloadBlob(f, f.name), i * 400));
      toast('เครื่องนี้ไม่รองรับการแชร์ภาพ ดาวน์โหลดไฟล์ไว้ในโฟลเดอร์ Downloads แทน', 4000);
    }
  }

  // ดาวน์โหลดค่าที่วัดของทรีตเมนต์ (ทุกรอบ) เป็น CSV เปิดใน Excel ได้
  async function exportTreatment(btn) {
    if (!online()) { toast('ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อดาวน์โหลดข้อมูล', 3500); return; }
    const gid = btn.dataset.g, tid = btn.dataset.t;
    btn.disabled = true;
    try {
      const data = await API.get('export', { garden: gid, treatment: tid });
      if (!data.rows.length) { toast(`${tid} ยังไม่มีค่าที่วัดหรือภาพบันทึกไว้`, 3500); return; }
      const cell = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const head = ['วันที่', 'ทรีตเมนต์', 'ต้น', 'กิ่ง']
        .concat(data.fields.map(f => f.unit ? `${f.label} (${f.unit})` : f.label),
          ['ผู้บันทึก', 'หมายเหตุ', 'ลิงก์ภาพต้น', 'ลิงก์ภาพชุดใบ', 'ลิงก์ภาพใบเดี่ยว']);
      const lines = [head].concat(data.rows.map(r => [r.date, tid, r.sample_id, r.branch]
        .concat(data.fields.map(f => r.values[f.id]), [r.recorder, r.note, r.plant, r.cluster, r.leaf])));
      const csv = '﻿' + lines.map(l => l.map(cell).join(',')).join('\r\n');
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${gid}_${tid}_measurements_${today().replace(/-/g, '')}.csv`);
      toast(`ดาวน์โหลด ${data.rows.length} แถวแล้ว`);
    } catch (e) {
      toast('ดาวน์โหลดไม่สำเร็จ: ' + e.message, 4000);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- ดาวน์โหลดรูปของทรีตเมนต์เป็น ZIP (ทีละรอบ) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ZIP แบบไม่บีบอัด (ภาพ JPEG บีบซ้ำไม่ได้ผลอยู่แล้ว)
  function buildZip(entries) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const crc = crc32(e.data);
      const size = e.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(12, 33, true);   // วันที่ในไฟล์ = 1980-01-01
      lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
      lh.setUint16(26, name.length, true);
      parts.push(lh, name, e.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(14, 33, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(ch, name);
      offset += 30 + name.length + size;
    }
    const cSize = central.reduce((a, x) => a + (x.byteLength !== undefined ? x.byteLength : x.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  const b64ToBytes = b64 => Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));

  let photoDl = null;   // { gid, tid, photos } ของหน้าต่างดาวน์โหลดรูปที่เปิดอยู่

  async function openPhotoDownload(btn) {
    if (!online()) { toast('ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อดาวน์โหลดรูป', 3500); return; }
    const gid = btn.dataset.g, tid = btn.dataset.t;
    btn.disabled = true;
    try {
      const photos = await API.get('photolist', { garden: gid, treatment: tid });
      if (!photos.length) { toast(`${tid} ยังไม่มีรูปบน Drive`, 3500); return; }
      const byDate = {};
      photos.forEach(p => { byDate[p.date] = (byDate[p.date] || 0) + 1; });
      photoDl = { gid, tid, photos, cancelled: false };
      const st = photoDl;
      showSheet(`
        <div class="sheet-head"><div><h2>ดาวน์โหลดรูป ${esc(tid)}</h2>
          <div class="meta-text">เลือกรอบที่ต้องการ · ได้ไฟล์ ZIP แยกโฟลเดอร์ตามต้น</div></div>
          <button class="icon-btn" data-action="close-sheet" aria-label="ปิด">${icon('x')}</button></div>
        <ul class="list">${Object.keys(byDate).sort().reverse().map(d => `
          <li><b>${thaiDate(d)}</b><span>${byDate[d]} ภาพ</span>
            <button class="btn sm" data-action="zip-round" data-d="${esc(d)}">${icon('download')}<span>ZIP</span></button></li>`).join('')}</ul>
        <p class="hint" id="zipStatus">ภาพต้นฉบับขนาดใหญ่ใช้เวลาและอินเทอร์เน็ตพอสมควร ควรใช้ Wi-Fi</p>`,
      () => { st.cancelled = true; });
    } catch (e) {
      toast('โหลดรายการรูปไม่สำเร็จ: ' + e.message, 4000);
    } finally {
      btn.disabled = false;
    }
  }

  async function zipRound(date) {
    const st = photoDl;
    if (!st || st.busy) return;
    const list = st.photos.filter(p => p.date === date);
    const status = document.getElementById('zipStatus');
    const say = t => { if (status && !st.cancelled) status.textContent = t; };
    st.busy = true;
    document.querySelectorAll('#sheet [data-action=zip-round]').forEach(b => { b.disabled = true; });
    try {
      const entries = [];
      for (let i = 0; i < list.length; i++) {
        if (st.cancelled) return;
        say(`กำลังโหลดภาพ ${i + 1}/${list.length}…`);
        let f;
        for (let tries = 0; ; tries++) {
          try { f = await API.get('photo', { file: list[i].file_id }); break; }
          catch (e) { if (tries >= 2) throw e; }
        }
        entries.push({ name: `${list[i].sample_id}/${list[i].file_name || f.name}`, data: b64ToBytes(f.data) });
      }
      say('กำลังสร้างไฟล์ ZIP…');
      downloadBlob(buildZip(entries), `${st.gid}_${st.tid}_${date.replace(/-/g, '')}_photos.zip`);
      say(`ดาวน์โหลดแล้ว ${entries.length} ภาพ`);
    } catch (e) {
      say('ไม่สำเร็จ: ' + e.message);
    } finally {
      st.busy = false;
      document.querySelectorAll('#sheet [data-action=zip-round]').forEach(b => { b.disabled = false; });
    }
  }

  async function saveCurrent() {
    const c = ctx;
    const photos = await DB.byIndex('photos', 'session', c.sKey);
    const oldSession = await DB.get('sessions', c.sKey);
    const measures = mergedMeasures(c.sKey, oldSession);
    for (const b of Object.keys(measures)) {
      for (const [f, v] of Object.entries(measures[b])) {
        if (isFinite(Number(v))) continue;
        const fd = fieldsOf(c.g).find(x => x.id === f);
        toast(`กิ่ง ${b} · ${fd ? fd.label : f} ต้องเป็นตัวเลข`, 4000);
        return;
      }
    }
    if (!photos.length && !Object.keys(measures).length) { toast('ยังไม่มีภาพหรือค่าที่วัด'); return; }
    const missing = c.slots.length - photos.length;
    if (photos.length && missing > 0 && !confirm(`ยังขาดอีก ${missing} ภาพ (มีแล้ว ${photos.length}/${c.slots.length})\nต้องการบันทึกเลยหรือไม่? กลับมาถ่ายต่อภายหลังได้`)) return;

    if (!settings.recorder) {
      const name = prompt('ชื่อผู้บันทึกข้อมูล', '');
      if (name) { settings.recorder = name.trim(); saveSettings(); }
    }

    // เตรียมไฟล์สำหรับ "เก็บภาพลงเครื่อง" ก่อนเริ่มอัปโหลด (อัปโหลดเสร็จแล้วไฟล์ในเครื่องจะถูกลบ)
    pendingShare = [];
    for (const p of photos.filter(x => x.status === 'draft').sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
      const rec = await DB.get('blobs', p.key);
      if (!rec) continue;
      const blob = rec.blob || new Blob([rec.data], { type: rec.type });
      const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/heic' ? 'heic' : 'jpg';
      pendingShare.push(new File([blob], `${c.g.id}_${c.date.replace(/-/g, '')}_${c.sampleId}_${p.slot}.${ext}`,
        { type: blob.type || 'image/jpeg', lastModified: Date.parse(p.capturedAt) || Date.now() }));
    }
    for (const p of photos) {
      if (p.status === 'draft') { p.status = 'queued'; await DB.put('photos', p); }
    }
    await DB.put('sessions', {
      key: c.sKey, gardenId: c.g.id, gardenName: c.g.name, date: c.date,
      treatment: c.t.id, sampleId: c.sampleId, expected: c.slots.length,
      note: ($('#note') || {}).value || '', recorder: settings.recorder,
      measures, fieldIds: fieldsOf(c.g).map(f => f.id),
      status: 'queued', savedAt: new Date().toISOString(),
    });
    delete mdraft[c.sKey];
    saveMdraft();

    Uploader.run();
    emitQueue();

    const next = siblingSample(c.g, c.sampleId, 1);
    showSheet(`
      <div class="done-mark">${icon('checkCircle', 'ic-xl')}</div>
      <h2 class="center">บันทึก ${esc(c.sampleId)} แล้ว</h2>
      <p class="center meta-text">${navigator.onLine ? 'ภาพกำลังอัปโหลดอยู่เบื้องหลัง ทำงานต่อได้เลย' : 'ตอนนี้ออฟไลน์ ภาพเก็บไว้ในเครื่อง จะอัปโหลดให้อัตโนมัติเมื่อมีสัญญาณ'}</p>
      <div class="sheet-actions">
        ${pendingShare.length ? `<button class="btn" data-action="share-photos">${icon('download')}<span>เก็บภาพลงเครื่อง (${pendingShare.length} ภาพ)</span></button>
          <p class="hint center">กดแล้วเลือก "บันทึกรูปภาพ" (iPhone) หรือ "แกลเลอรี" (Android)</p>` : ''}
        ${next ? `<a class="btn primary big" href="${hashFor('/capture', { g: c.g.id, t: next.t, s: next.s, d: c.date })}"><span>ต้นถัดไป ${esc(next.s)}</span>${icon('right')}</a>` : ''}
        <a class="btn" href="${hashFor('/', { g: c.g.id, d: c.date })}">${icon('home')}<span>กลับหน้าหลัก</span></a>
      </div>`);
    rerenderCapture();
  }

  // ---------- views: history (การเจริญเติบโตของต้นเดียวกันทุกรอบ) ----------
  let historyView = null;

  async function renderHistory(q) {
    if (!config) { view.innerHTML = noConfigView(); return; }
    const g = findGarden(q.g);
    const t = g && g.treatments.find(x => x.id === q.t);
    if (!g || !t || !sampleIds(t).includes(q.s)) { view.innerHTML = emptyState('ไม่พบต้นนี้', ''); return; }
    const slots = slotsFor(t.branches);
    const slot = slots.find(s => s.id === q.slot) || slots[0];
    const back = hashFor('/capture', { g: g.id, t: t.id, s: q.s, d: q.d || today() });
    const cacheKey = `${g.id}|${q.s}|${slot.id}`;

    view.innerHTML = `
      <section class="panel head">
        <div class="head-top">
          <a class="icon-btn" href="${back}" aria-label="กลับ">${icon('left')}</a>
          <div class="head-title">
            <h1>ประวัติ ${esc(q.s)}</h1>
            <div class="meta-text">${esc(g.name)} · ${esc(t.id)}</div>
          </div>
        </div>
        <div class="tabs">${slots.map(s => `
          <a class="tab${s.id === slot.id ? ' on' : ''}" href="${hashFor('/history', { ...q, slot: s.id })}">${esc(s.name)}</a>`).join('')}
        </div>
      </section>
      <div id="histBody">${historyCache[cacheKey] ? '' : `<section class="panel empty"><p>กำลังโหลดประวัติ…</p></section>`}</div>`;

    const tab = $('.tab.on');
    if (tab) tab.scrollIntoView({ inline: 'center', block: 'nearest' });

    const draw = data => {
      const body = $('#histBody');
      if (!body) return;
      const photos = data.photos;
      historyView = { g, t, sampleId: q.s, slot, photos, notes: data.notes || {} };
      if (!photos.length) {
        body.innerHTML = emptyState('ยังไม่มีภาพในตำแหน่งนี้', `${esc(slot.name)} ของ ${esc(q.s)} ยังไม่เคยถูกอัปโหลด`);
        return;
      }
      const first = photos[0].date;
      body.innerHTML = `
        <div class="summary"><div><b>${photos.length}</b><span> รอบ · ${thaiDate(first)} – ${thaiDate(photos[photos.length - 1].date)}</span></div></div>
        <div class="hgrid">${photos.map((p, i) => `
          <button class="hcard" data-hist="${i}">
            <span class="hcard-img"${p.thumb ? ` style="background-image:url('${p.thumb}')"` : ''}>${p.thumb ? '' : icon('cloud', 'ic-lg')}</span>
            <span class="hcard-cap">
              <b>${thaiDate(p.date)}</b>
              <span class="day">วันที่ ${daysBetween(first, p.date)}</span>
            </span>
            ${data.notes && data.notes[p.date] ? `<span class="hcard-note">${esc(data.notes[p.date])}</span>` : ''}
          </button>`).join('')}
        </div>`;
    };

    if (historyCache[cacheKey]) draw(historyCache[cacheKey]);
    if (!online()) {
      if (!historyCache[cacheKey]) $('#histBody').innerHTML = emptyState('ออฟไลน์', 'ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อดูประวัติจาก Drive');
      return;
    }
    try {
      const data = await API.get('history', { garden: g.id, sample: q.s, slot: slot.id });
      historyCache[cacheKey] = data;
      const r = route();
      if (r.path === '/history' && r.q.s === q.s && (r.q.slot || slots[0].id) === slot.id) draw(data);
    } catch (e) {
      if (!historyCache[cacheKey] && $('#histBody')) $('#histBody').innerHTML = emptyState('โหลดไม่สำเร็จ', esc(e.message));
    }
  }

  function openHistoryViewer(i) {
    const h = historyView;
    if (!h) return;
    const p = h.photos[i];
    const first = h.photos[0].date;
    const rows = [
      ['รอบ', `${thaiDate(p.date)} · วันที่ ${daysBetween(first, p.date)}`],
      ['ถ่ายเมื่อ', esc(thaiDateTime(p.captured_at))],
      ['ผู้บันทึก', esc(p.recorder || '-')],
    ];
    if (h.notes[p.date]) rows.push(['หมายเหตุ', esc(h.notes[p.date])]);
    const prev = h.photos[i - 1], next = h.photos[i + 1];
    showSheet(viewerHtml({
      title: `${esc(h.sampleId)} · ${esc(h.slot.name)}`,
      sub: esc(h.g.name),
      src: p.thumb,
      rows,
      actions: `
        <div class="row-actions">
          <button class="btn" data-hist="${i - 1}" ${prev ? '' : 'disabled'}>${icon('left')}<span>รอบก่อน</span></button>
          <button class="btn" data-hist="${i + 1}" ${next ? '' : 'disabled'}><span>รอบถัดไป</span>${icon('right')}</button>
        </div>
        ${p.url ? `<a class="btn" href="${esc(p.url)}" target="_blank" rel="noopener">${icon('external')}<span>เปิดใน Google Drive</span></a>` : ''}
        <a class="btn" href="${hashFor('/capture', { g: h.g.id, t: h.t.id, s: h.sampleId, d: p.date })}">${icon('eye')}<span>ดูทุกภาพของรอบนี้</span></a>`,
    }));
    tryHiRes(p.file_id);
  }

  // ---------- views: queue ----------
  async function renderQueue() {
    const sessions = await DB.all('sessions');
    const queuedPhotos = await DB.byIndex('photos', 'status', 'queued');
    const draftPhotos = await DB.byIndex('photos', 'status', 'draft');
    const queued = sessions.filter(s => s.status === 'queued').sort((a, b) => a.savedAt.localeCompare(b.savedAt));
    const draftKeys = [...new Set(draftPhotos.map(p => p.sessionKey))];
    const doneCount = sessions.filter(s => s.status === 'done').length;
    const pendingBytes = queuedPhotos.concat(draftPhotos).reduce((a, p) => a + (p.size || 0), 0);

    const statusLine = Uploader.running ? { ic: 'upload', cls: 'busy', text: esc(Uploader.statusText()) }
      : !navigator.onLine ? { ic: 'wifiOff', cls: 'warn', text: 'ออฟไลน์ — จะส่งอัตโนมัติเมื่อมีสัญญาณ' }
      : queued.length ? { ic: 'clock', cls: '', text: 'พร้อมส่ง' }
      : { ic: 'checkCircle', cls: 'ok', text: 'ไม่มีงานค้าง' };

    const qRow = s => {
      const left = queuedPhotos.filter(p => p.sessionKey === s.key).length;
      return `<li><b>${esc(s.sampleId)}</b><span>${esc(s.gardenName)} · ${thaiDate(s.date)}</span>
        <em>${left ? `เหลือ ${left} ภาพ` : 'กำลังสรุป'}</em></li>`;
    };
    const dRow = key => {
      const p = draftPhotos.find(x => x.sessionKey === key);
      return `<li><a href="${hashFor('/capture', { g: p.gardenId, t: p.treatment, s: p.sampleId, d: p.date })}">
        <b>${esc(p.sampleId)}</b><span>${esc(p.gardenName)} · ${thaiDate(p.date)}</span><em>เปิด${icon('right')}</em></a></li>`;
    };

    view.innerHTML = `
      <section class="panel">
        <h1>คิวอัปโหลด</h1>
        <div class="status-box ${statusLine.cls}">${icon(statusLine.ic)}<span id="upStatus">${statusLine.text}</span></div>
        ${Uploader.lastError ? `<div class="status-box err">${icon('alert')}<span>${esc(Uploader.lastError)}</span></div>` : ''}
        ${Uploader.directFailed ? `<p class="hint">ส่งตรงเข้า Drive ไม่ได้ กำลังใช้วิธีสำรองซึ่งช้ากว่า</p>` : ''}
        <p class="hint">ข้อมูลที่ยังอยู่ในเครื่อง: <b>${fmtBytes(pendingBytes)}</b></p>
        <button class="btn primary" data-action="upload-now" ${Uploader.running ? 'disabled' : ''}>${icon('upload')}<span>อัปโหลดตอนนี้</span></button>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>รออัปโหลด</h2><span class="pill">${queued.length} ต้น</span></div>
        ${queued.length ? `<ul class="list">${queued.map(qRow).join('')}</ul>` : '<p class="hint">ไม่มี</p>'}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>ถ่ายแล้ว ยังไม่กดบันทึก</h2><span class="pill">${draftKeys.length} ต้น</span></div>
        ${draftKeys.length ? `<ul class="list">${draftKeys.map(dRow).join('')}</ul>` : '<p class="hint">ไม่มี</p>'}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>อัปโหลดเสร็จแล้ว</h2><span class="pill">${doneCount} ต้น</span></div>
        <button class="btn" data-action="clear-done" ${doneCount ? '' : 'disabled'}>${icon('trash')}<span>ล้างประวัติในเครื่อง</span></button>
        <p class="hint">ลบเฉพาะในมือถือ ไม่กระทบไฟล์บน Google Drive · ประวัติที่เก่ากว่า ${KEEP_DONE_DAYS} วันจะถูกล้างให้อัตโนมัติ</p>
      </section>`;
  }

  async function clearDone() {
    if (!confirm('ล้างประวัติที่อัปโหลดเสร็จแล้วออกจากเครื่องนี้?')) return;
    const sessions = await DB.byIndex('sessions', 'status', 'done');
    for (const s of sessions) {
      const ps = await DB.byIndex('photos', 'session', s.key);
      if (ps.some(p => p.status !== 'done')) continue;
      for (const p of ps) await DB.del('photos', p.key);
      await DB.del('sessions', s.key);
    }
    renderQueue();
  }

  // ---------- views: settings ----------
  async function renderSettings() {
    let storage = '';
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      storage = `${fmtBytes(est.usage || 0)} / ${fmtBytes(est.quota || 0)}`;
    }
    view.innerHTML = `
      <section class="panel">
        <h1>ตั้งค่า</h1>
        <label class="field">ชื่อผู้บันทึก
          <input id="setRecorder" value="${esc(settings.recorder)}" placeholder="ชื่อ-นามสกุล">
        </label>
        <label class="field">ขนาดภาพที่อัปโหลด
          <select id="setSize">
            ${[['original', 'ต้นฉบับ (ความละเอียดเต็ม)'], ['3000', 'ย่อ ด้านยาว 3000px'], ['2048', 'ย่อ ด้านยาว 2048px'], ['1600', 'ย่อ ด้านยาว 1600px']]
              .map(([v, l]) => `<option value="${v}" ${settings.imageSize === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <p class="hint">ถ้าสัญญาณในแปลงไม่ดี หรือ Drive ใกล้เต็ม เลือกย่อขนาดได้ (มีผลกับภาพที่ถ่ายหลังจากนี้)</p>
      </section>
      <section class="panel">
        <h2>สวน / ทรีตเมนต์</h2>
        ${config ? `<ul class="list">${config.gardens.map(g =>
          `<li><b>${esc(g.name)}</b><span>${g.treatments.map(t => `${esc(t.id)}×${t.samples}`).join(', ')}</span></li>`).join('')}</ul>
          <p class="hint">โหลดล่าสุด: ${esc(thaiDateTime(config.fetchedAt))}</p>` : '<p class="hint">ยังไม่มีข้อมูล</p>'}
        <div class="actions">
          <a class="btn primary" href="#/admin">${icon('pencil')}<span>จัดการสวน / ทรีตเมนต์</span></a>
          <button class="btn" data-action="reload-config">${icon('refresh')}<span>โหลดใหม่</span></button>
          <a class="btn" href="qr.html">${icon('qr')}<span>พิมพ์ QR Code</span></a>
        </div>
      </section>
      <section class="panel">
        <h2>ข้อมูลเครื่อง</h2>
        <ul class="list">
          <li><b>Device ID</b><span>${esc(deviceId)}</span></li>
          <li><b>พื้นที่ที่ใช้</b><span>${esc(storage || '-')}</span></li>
          <li><b>API</b><span>${API.ready() ? 'ตั้งค่าแล้ว' : 'ยังไม่ได้ตั้งค่า'}</span></li>
          <li><b>วิธีอัปโหลด</b><span>${Uploader.directFailed ? 'สำรอง (ผ่าน Apps Script)' : `ส่งตรงเข้า Drive · พร้อมกัน ${UPLOAD_CONCURRENCY} ภาพ`}</span></li>
        </ul>
      </section>`;
    $('#setRecorder').addEventListener('change', e => { settings.recorder = e.target.value.trim(); saveSettings(); toast('บันทึกแล้ว'); });
    $('#setSize').addEventListener('change', e => { settings.imageSize = e.target.value; saveSettings(); toast('บันทึกแล้ว'); });
  }

  // ---------- views: admin (จัดการสวน / ทรีตเมนต์) ----------
  // แก้ไขบนสำเนา (adminDraft) แล้วค่อยบันทึกทีเดียว
  // รหัสสวน/ทรีตเมนต์ที่บันทึกแล้วแก้ไม่ได้ เพราะใช้เป็นชื่อไฟล์, key ในชีต และ QR
  let adminDraft = null;
  const ID_RE = /^[A-Za-z0-9_-]{1,20}$/;

  function newDraft() {
    return {
      version: config ? config.version : undefined,
      dirty: false,
      gardens: (config ? config.gardens : []).map(g => ({
        id: g.id, name: g.name, saved: true,
        treatments: g.treatments.map(t => ({ id: t.id, samples: t.samples, branches: t.branches, saved: true })),
        fields: fieldsOf(g).map(f => ({ id: f.id, label: f.label, unit: f.unit || '' })),
      })),
    };
  }

  function nextId(prefix, existing) {
    let n = 1;
    while (existing.includes(prefix + n)) n++;
    return prefix + n;
  }

  async function renderAdmin() {
    const isOnline = online();
    if (!adminDraft) {
      if (isOnline) {
        view.innerHTML = '<section class="panel empty"><p>กำลังโหลดการตั้งค่าล่าสุด…</p></section>';
        try { await loadConfig(); } catch (e) { /* ใช้ค่าที่ cache ไว้ */ }
        if (route().path !== '/admin') return;
      }
      adminDraft = newDraft();
    }
    const d = adminDraft;

    const tRow = (gi, t, ti) => `<tr>
        <td><input class="in-id" data-g="${gi}" data-t="${ti}" data-f="id" value="${esc(t.id)}"
          ${t.saved ? 'readonly' : ''} autocapitalize="characters" placeholder="T1" aria-label="รหัสทรีตเมนต์"></td>
        <td><input type="number" inputmode="numeric" min="1" max="500" data-g="${gi}" data-t="${ti}" data-f="samples" value="${esc(t.samples)}" aria-label="จำนวนต้น"></td>
        <td><input type="number" inputmode="numeric" min="0" max="20" data-g="${gi}" data-t="${ti}" data-f="branches" value="${esc(t.branches)}" aria-label="จำนวนกิ่ง"></td>
        <td><button class="icon-btn danger" data-admin="del-t" data-g="${gi}" data-t="${ti}" aria-label="ลบทรีตเมนต์">${icon('trash')}</button></td>
      </tr>`;

    const gCard = (g, gi) => `<section class="panel">
      <div class="row">
        <label class="field grow">ชื่อสวน
          <input data-g="${gi}" data-f="name" value="${esc(g.name)}" placeholder="เช่น สวนลำไย ลำพูน"></label>
        <label class="field narrow">รหัสสวน
          <input class="in-id" data-g="${gi}" data-f="id" value="${esc(g.id)}" ${g.saved ? 'readonly' : ''}
            autocapitalize="characters" placeholder="GA"></label>
      </div>
      <table class="tbl">
        <thead><tr><th>ทรีตเมนต์</th><th>จำนวนต้น</th><th>จำนวนกิ่ง</th><th></th></tr></thead>
        <tbody>${g.treatments.map((t, ti) => tRow(gi, t, ti)).join('')}</tbody>
      </table>
      <div class="field-label">ค่าที่วัดต่อกิ่ง (กรอกในหน้าถ่ายภาพ)</div>
      <table class="tbl">
        <thead><tr><th>ชื่อ</th><th>หน่วย</th><th></th></tr></thead>
        <tbody>${g.fields.map((f, fi) => `<tr>
          <td><input data-g="${gi}" data-fi="${fi}" data-f="label" value="${esc(f.label)}" placeholder="เช่น SPAD" aria-label="ชื่อค่าที่วัด"></td>
          <td class="td-unit"><input data-g="${gi}" data-fi="${fi}" data-f="unit" value="${esc(f.unit)}" placeholder="หน่วย" aria-label="หน่วย"></td>
          <td><button class="icon-btn danger" data-admin="del-f" data-g="${gi}" data-fi="${fi}" aria-label="ลบค่าที่วัด">${icon('trash')}</button></td>
        </tr>`).join('')}</tbody>
      </table>
      <div class="actions">
        <button class="btn" data-admin="add-f" data-g="${gi}">${icon('plus')}<span>เพิ่มค่าที่วัด</span></button>
        <button class="btn" data-admin="add-t" data-g="${gi}">${icon('plus')}<span>เพิ่มทรีตเมนต์</span></button>
        <button class="btn danger" data-admin="del-g" data-g="${gi}">${icon('trash')}<span>ลบสวน</span></button>
      </div>
    </section>`;

    view.innerHTML = `
      <section class="panel head">
        <div class="head-top">
          <a class="icon-btn" href="#/settings" aria-label="กลับ">${icon('left')}</a>
          <div class="head-title"><h1>จัดการสวน</h1><div class="meta-text">สวน · ทรีตเมนต์ · จำนวนต้น · จำนวนกิ่ง</div></div>
        </div>
        <ul class="notes">
          <li>รหัสสวนและรหัสทรีตเมนต์ที่บันทึกแล้วจะแก้ไม่ได้ (ใช้ในชื่อไฟล์และ QR)</li>
          <li>เปลี่ยนชื่อสวนได้ แต่ภาพรอบถัดไปจะถูกเก็บในโฟลเดอร์ชื่อใหม่</li>
          <li>การลบสวน/ทรีตเมนต์ ไม่ลบภาพที่อยู่บน Drive</li>
          <li>เพิ่ม/ลบ/เปลี่ยนชื่อค่าที่วัดได้ตลอด ค่าที่เคยบันทึกไว้ยังอยู่ในชีต Measurements</li>
        </ul>
        ${isOnline ? '' : `<div class="status-box warn">${icon('wifiOff')}<span>ต้องเชื่อมต่ออินเทอร์เน็ตจึงจะบันทึกได้</span></div>`}
      </section>
      ${d.gardens.map(gCard).join('')}
      <button class="btn block dashed" data-admin="add-g">${icon('plus')}<span>เพิ่มสวน</span></button>
      <div class="actionbar">
        <button class="btn" data-admin="reset">${icon('x')}<span>ยกเลิก</span></button>
        <button class="btn primary grow" data-admin="save" ${isOnline ? '' : 'disabled'}>${icon('save')}<span>บันทึกการตั้งค่า</span></button>
      </div>`;
  }

  function validateDraft(d) {
    const gids = new Set();
    const names = new Set();
    for (const g of d.gardens) {
      const name = String(g.name || '').trim();
      if (!ID_RE.test(g.id)) return `รหัสสวน "${g.id}" ไม่ถูกต้อง (ใช้ A-Z, 0-9, _ - ไม่เกิน 20 ตัว)`;
      if (gids.has(g.id)) return `รหัสสวน ${g.id} ซ้ำกัน`;
      if (!name) return `กรุณาใส่ชื่อสวน (${g.id})`;
      if (names.has(name)) return `ชื่อสวน "${name}" ซ้ำกัน`;
      gids.add(g.id);
      names.add(name);
      if (!g.treatments.length) return `${name}: ต้องมีอย่างน้อย 1 ทรีตเมนต์`;
      const tids = new Set();
      for (const t of g.treatments) {
        if (!ID_RE.test(t.id)) return `${name}: รหัสทรีตเมนต์ "${t.id}" ไม่ถูกต้อง`;
        if (tids.has(t.id)) return `${name}: ทรีตเมนต์ ${t.id} ซ้ำกัน`;
        tids.add(t.id);
        if (!(t.samples >= 1 && t.samples <= 500)) return `${name} ${t.id}: จำนวนต้นต้องอยู่ระหว่าง 1–500`;
        if (!(t.branches >= 0 && t.branches <= 20)) return `${name} ${t.id}: จำนวนกิ่งต้องอยู่ระหว่าง 0–20`;
      }
      const labels = new Set();
      for (const f of g.fields) {
        const label = String(f.label || '').trim();
        if (!label) return `${name}: ค่าที่วัดต้องมีชื่อ (หรือลบแถวที่ว่างออก)`;
        if (label.length > 40) return `${name}: ชื่อค่าที่วัด "${label}" ยาวเกินไป`;
        if (labels.has(label)) return `${name}: ค่าที่วัด "${label}" ซ้ำกัน`;
        labels.add(label);
      }
    }
    return '';
  }

  async function saveAdmin(btn) {
    const err = validateDraft(adminDraft);
    if (err) { toast(err, 4000); return; }
    btn.disabled = true;
    const payload = {
      baseVersion: adminDraft.version,
      pin: settings.adminPin || '',
      gardens: adminDraft.gardens.map(g => ({
        id: g.id, name: String(g.name).trim(),
        treatments: g.treatments.map(t => ({ id: t.id, samples: t.samples, branches: t.branches })),
        fields: g.fields.map(f => ({ id: f.id, label: String(f.label).trim(), unit: String(f.unit || '').trim() })),
      })),
    };
    try {
      const data = await API.post('saveConfig', payload, 60 * 1000);
      config = Object.assign(data, { fetchedAt: new Date().toISOString() });
      LS.set('pg_config', config);
      adminDraft = null;
      toast('บันทึกการตั้งค่าแล้ว');
      renderAdmin();
    } catch (e) {
      btn.disabled = false;
      if (e.message === 'ADMIN_PIN') {
        const pin = prompt(settings.adminPin ? 'PIN ไม่ถูกต้อง กรุณาใส่ใหม่' : 'ใส่ PIN ผู้ดูแล', '');
        if (pin) { settings.adminPin = pin.trim(); saveSettings(); saveAdmin(btn); }
      } else if (e.message === 'CONFIG_CONFLICT') {
        alert('มีคนแก้ไขการตั้งค่าไปก่อนแล้ว\nกด "ยกเลิก" เพื่อโหลดค่าล่าสุด แล้วแก้ไขใหม่อีกครั้ง');
      } else {
        toast('บันทึกไม่สำเร็จ: ' + e.message, 5000);
      }
    }
  }

  async function adminAction(el) {
    const d = adminDraft;
    if (!d) return;
    const gi = +el.dataset.g;
    const g = d.gardens[gi];
    let focus = null;
    switch (el.dataset.admin) {
      case 'save':
        return saveAdmin(el);
      case 'reset':
        if (d.dirty && !confirm('ยกเลิกการแก้ไขทั้งหมดที่ยังไม่บันทึก?')) return;
        adminDraft = null;
        return renderAdmin();
      case 'add-g':
        d.gardens.push({
          id: nextId('G', d.gardens.map(x => x.id)), name: '', saved: false,
          treatments: [{ id: 'T1', samples: 5, branches: 4, saved: false }],
          fields: DEFAULT_FIELDS.map(f => ({ ...f })),
        });
        focus = `[data-g="${d.gardens.length - 1}"][data-f="name"]`;
        break;
      case 'del-g':
        if (!confirm(`ลบสวน "${g.name || g.id}" ทั้งหมด?\n(ภาพบน Drive จะไม่ถูกลบ)`)) return;
        d.gardens.splice(gi, 1);
        break;
      case 'add-t': {
        const last = g.treatments[g.treatments.length - 1];
        g.treatments.push({
          id: nextId('T', g.treatments.map(t => t.id)),
          samples: last ? last.samples : 5, branches: last ? last.branches : 4, saved: false,
        });
        break;
      }
      case 'add-f':
        // รหัสไม่ซ้ำกับค่าที่เคยลบไป เพื่อไม่ให้ข้อมูลเก่าปนกัน
        g.fields.push({ id: 'F' + Date.now().toString(36).toUpperCase(), label: '', unit: '' });
        focus = `[data-g="${gi}"][data-fi="${g.fields.length - 1}"][data-f="label"]`;
        break;
      case 'del-f': {
        const f = g.fields[+el.dataset.fi];
        if (!confirm(`ลบค่าที่วัด "${f.label || 'ไม่มีชื่อ'}"?\n(ค่าที่เคยบันทึกไว้ในชีตจะไม่ถูกลบ)`)) return;
        g.fields.splice(+el.dataset.fi, 1);
        break;
      }
      case 'del-t': {
        const t = g.treatments[+el.dataset.t];
        if (!confirm(`ลบทรีตเมนต์ ${t.id} ของ ${g.name || g.id}?`)) return;
        g.treatments.splice(+el.dataset.t, 1);
        break;
      }
    }
    d.dirty = true;
    const y = window.scrollY;
    await renderAdmin();
    window.scrollTo(0, y);
    if (focus && $(focus)) { $(focus).focus(); $(focus).scrollIntoView({ block: 'center' }); }
  }

  view.addEventListener('input', e => {
    const el = e.target;
    if (el.classList.contains('m-in')) {
      const k = ctx && ctx.sKey;
      if (!k) return;
      ((mdraft[k] || (mdraft[k] = {}))[el.dataset.b] || (mdraft[k][el.dataset.b] = {}))[el.dataset.f] = el.value;
      saveMdraft();
      return;
    }
    if (route().path !== '/admin' || !adminDraft || !el.dataset.f) return;
    const g = adminDraft.gardens[+el.dataset.g];
    if (!g) return;
    const target = el.dataset.t != null ? g.treatments[+el.dataset.t]
      : el.dataset.fi != null ? g.fields[+el.dataset.fi] : g;
    const f = el.dataset.f;
    let v = el.value;
    if (f === 'id') {
      v = v.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      if (v !== el.value) el.value = v;
    }
    if (f === 'samples' || f === 'branches') v = v === '' ? NaN : parseInt(v, 10);
    target[f] = v;
    adminDraft.dirty = true;
  });

  window.addEventListener('beforeunload', e => {
    if (adminDraft && adminDraft.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- events ----------
  document.addEventListener('click', async e => {
    const t = e.target;
    const del = t.closest('[data-del]');
    if (del) { e.preventDefault(); deleteDraft(del.dataset.del); return; }
    const adm = t.closest('[data-admin]');
    if (adm) { e.preventDefault(); adminAction(adm); return; }
    const jp = t.closest('[data-jump]');
    if (jp) {
      const el = document.getElementById('br' + jp.dataset.jump);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const vw = t.closest('[data-view]');
    if (vw) { e.preventDefault(); openSlotViewer(vw.dataset.view); return; }
    const hs = t.closest('[data-hist]');
    if (hs) { e.preventDefault(); if (!hs.disabled) openHistoryViewer(+hs.dataset.hist); return; }
    if (t.id === 'sheet') { hideSheet(); return; }

    const btn = t.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'close-sheet') hideSheet();
    if (action === 'save') saveCurrent();
    if (action === 'share-photos') savePhotosToDevice();
    if (action === 'export') exportTreatment(btn);
    if (action === 'photos') openPhotoDownload(btn);
    if (action === 'zip-round') zipRound(btn.dataset.d);
    if (action === 'unlock' && ctx) { unlocked.add(ctx.sKey); rerenderCapture(); }
    if (action === 'lock' && ctx) { unlocked.delete(ctx.sKey); rerenderCapture(); }
    if (action === 'upload-now') Uploader.run();
    if (action === 'clear-done') clearDone();
    if (action === 'reload-config') {
      btn.disabled = true;
      try { await loadConfig(); toast('โหลดการตั้งค่าแล้ว'); render(); }
      catch (err) { toast('โหลดไม่สำเร็จ: ' + err.message, 4000); btn.disabled = false; }
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') hideSheet();
    // กด Enter ในช่องค่าที่วัด → ไปช่องถัดไป (ช่องสุดท้ายปิดคีย์บอร์ด)
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('m-in')) {
      e.preventDefault();
      const all = Array.from(view.querySelectorAll('.m-in:not([readonly])'));
      const nxt = all[all.indexOf(e.target) + 1];
      if (nxt) { nxt.focus(); nxt.select(); } else e.target.blur();
    }
  });
  window.addEventListener('hashchange', () => { hideSheet(); render(); });
  window.addEventListener('online', () => { emitQueue(); Uploader.run(); });
  window.addEventListener('offline', emitQueue);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) Uploader.run(); });
  setInterval(() => Uploader.run(), 60 * 1000);

  // ---------- start ----------
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  render();
  emitQueue();
  pruneOld().catch(() => {});
  Uploader.run();
  if (online()) {
    // ไม่ render หน้าถ่ายภาพซ้ำ ยกเว้นยังไม่เคยมี config
    const hadConfig = !!config;
    loadConfig().then(() => { if (!hadConfig || !['/capture', '/admin'].includes(route().path)) render(); }).catch(() => {});
  }
})();
