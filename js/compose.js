// หน้าแต่งภาพ: ภาพหลัก + ภาพเสริม/ข้อความ (ลากวาง ใส่กรอบได้) แล้วบันทึกเข้าเครื่อง
// พิกัดทุกอย่างเก็บเป็นสัดส่วนของภาพหลัก จึงได้ผลเหมือนกันทั้งตัวอย่างและไฟล์ที่บันทึก
(() => {
  const $ = s => document.querySelector(s);
  const FONT = '"Noto Sans Thai","Leelawadee UI","Sarabun",Tahoma,sans-serif';
  const MAX_SIDE = 4096;

  const stage = $('#stage'), mainImg = $('#mainImg'), wrap = $('#stageWrap');
  let main = null;          // { img, w, h }
  let items = [];           // ภาพเสริม/ข้อความ (ลำดับท้ายสุดอยู่บนสุด)
  let sel = null;
  let seq = { img: 0, text: 0 };

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('เปิดภาพไม่ได้'));
      img.src = URL.createObjectURL(file);
    });
  }

  // ---------- ขนาดตัวอย่าง ----------
  function layout() {
    if (!main) return;
    const avail = wrap.clientWidth - 24;
    const maxH = window.innerHeight * 0.78;
    const w = Math.max(120, Math.min(avail, maxH * main.w / main.h));
    stage.style.width = w + 'px';
    stage.style.aspectRatio = main.w + ' / ' + main.h;
    stage.style.setProperty('--sw', w + 'px');
  }
  window.addEventListener('resize', layout);

  // ---------- ภาพหลัก ----------
  // แต่ละภาพหลักคือ "งาน" หนึ่งชิ้น มีรายการ ชื่อไฟล์ และนามสกุลของตัวเอง
  let jobs = [], cur = null;

  function stash() {
    if (!cur) return;
    cur.items = items; cur.seq = seq;
    cur.name = $('#fname').value; cur.fmt = $('#fmt').value;
  }

  function openJob(j) {
    stash();
    cur = j; main = j.main; items = j.items; seq = j.seq; sel = null;
    stage.querySelectorAll('.ov').forEach(el => el.remove());
    mainImg.src = main.img.src;
    items.forEach(build);
    $('#fname').value = j.name; $('#fmt').value = j.fmt;
    $('#empty').hidden = true; wrap.hidden = false;
    layout(); select(null); refreshJobs();
  }

  function refreshJobs() {
    const box = $('#jobs'); box.textContent = '';
    jobs.forEach(j => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = (j === cur ? $('#fname').value : j.name) || 'ไม่มีชื่อ';
      b.classList.toggle('on', j === cur);
      b.onclick = () => openJob(j);
      box.appendChild(b);
    });
    $('#jobsBox').hidden = !jobs.length;
    $('#addImg').disabled = $('#addText').disabled = $('#save').disabled = !cur;
    $('#saveAll').disabled = !jobs.length;
    $('#saveAll').hidden = jobs.length < 2;
  }
  $('#fname').addEventListener('input', refreshJobs);

  $('#mainFile').addEventListener('change', async e => {
    const files = [...e.target.files]; e.target.value = '';
    let first = null;
    for (const f of files) {
      try {
        const img = await loadImage(f);
        const j = {
          main: { img, w: img.naturalWidth, h: img.naturalHeight },
          items: [], seq: { img: 0, text: 0 },
          name: f.name.replace(/\.[^.]+$/, ''), fmt: 'jpg',
        };
        jobs.push(j); first = first || j;
      } catch (err) { toast(err.message); }
    }
    if (first) openJob(first);
  });

  $('#delJob').addEventListener('click', () => {
    if (!cur || !confirm('เอาภาพนี้ออกจากรายการ? (การแต่งของภาพนี้จะหายไป)')) return;
    const i = jobs.indexOf(cur);
    jobs.splice(i, 1); cur = null;
    if (jobs.length) openJob(jobs[Math.min(i, jobs.length - 1)]);
    else {
      main = null; items = []; sel = null;
      stage.querySelectorAll('.ov').forEach(el => el.remove());
      wrap.hidden = true; $('#empty').hidden = false; $('#props').hidden = true;
      $('#fname').value = ''; refreshJobs(); refreshList();
    }
  });

  // ---------- เพิ่มรายการ ----------
  $('#addImg').addEventListener('change', async e => {
    const files = [...e.target.files]; e.target.value = '';
    for (const f of files) {
      try {
        const img = await loadImage(f);
        const ar = img.naturalWidth / img.naturalHeight;
        const n = items.length % 6;
        const it = {
          type: 'img', name: 'ภาพเสริม ' + (++seq.img), img, ar,
          w: 0.3, x: 0.03 + n * 0.03, y: 0, border: true, bw: 5, bc: '#ffffff',
        };
        it.y = clamp(1 - (it.w * main.w / ar) / main.h - 0.02 - n * 0.03, 0, 1);
        items.push(it); build(it);
      } catch (err) { toast(err.message); }
    }
    if (items.length) select(items[items.length - 1]);
    refreshList();
  });

  $('#addText').addEventListener('click', () => {
    const n = items.length % 6;
    const it = {
      type: 'text', name: 'ข้อความ ' + (++seq.text), text: $('#fname').value || 'ข้อความ',
      fs: 0.05, x: 0.03 + n * 0.03, y: 0.02 + n * 0.04,
      color: '#0b1a0f', bgOn: true, bg: '#ffd24d', border: false, bw: 4, bc: '#0b1a0f',
    };
    items.push(it); build(it); select(it); refreshList();
  });

  // ---------- วาด DOM ของแต่ละรายการ ----------
  function build(it) {
    const el = document.createElement('div');
    el.className = 'ov ' + (it.type === 'img' ? 'ov-img' : 'ov-text');
    if (it.type === 'img') {
      const im = document.createElement('img'); im.src = it.img.src; im.alt = '';
      el.style.aspectRatio = String(it.ar);
      el.appendChild(im);
    } else {
      const t = document.createElement('span'); t.className = 't'; el.appendChild(t);
    }
    const rh = document.createElement('i'); rh.className = 'rh'; el.appendChild(rh);
    it.el = el; stage.appendChild(el);
    el.addEventListener('pointerdown', e => startDrag(e, it));
    rh.addEventListener('pointerdown', e => startResize(e, it));
    apply(it);
  }

  function apply(it) {
    const s = it.el.style;
    s.left = it.x * 100 + '%'; s.top = it.y * 100 + '%';
    s.borderColor = it.bc;
    s.borderWidth = `calc(var(--sw) * ${(it.border ? it.bw : 0) / 1000})`;
    if (it.type === 'img') {
      s.width = it.w * 100 + '%';
    } else {
      it.el.querySelector('.t').textContent = it.text;
      s.fontSize = `calc(var(--sw) * ${it.fs})`;
      s.color = it.color;
      s.background = it.bgOn ? it.bg : 'transparent';
    }
  }

  // ---------- ลาก / ปรับขนาด ----------
  function frac(it) {   // ขนาดของรายการเป็นสัดส่วนของเวที
    return { w: it.el.offsetWidth / stage.clientWidth, h: it.el.offsetHeight / stage.clientHeight };
  }

  function startDrag(e, it) {
    e.preventDefault(); select(it);
    const sr = stage.getBoundingClientRect(), f = frac(it);
    const sx = e.clientX, sy = e.clientY, ox = it.x, oy = it.y;
    const move = ev => {
      it.x = clamp(ox + (ev.clientX - sx) / sr.width, 0, Math.max(0, 1 - f.w));
      it.y = clamp(oy + (ev.clientY - sy) / sr.height, 0, Math.max(0, 1 - f.h));
      apply(it);
    };
    track(e, it.el, move);
  }

  function startResize(e, it) {
    e.preventDefault(); e.stopPropagation(); select(it);
    const sr = stage.getBoundingClientRect(), r0 = it.el.getBoundingClientRect();
    const w0 = r0.width, ow = it.w, ofs = it.fs;
    const move = ev => {
      const nw = clamp(ev.clientX - r0.left, 24, sr.right - r0.left);
      if (it.type === 'img') it.w = clamp(nw / sr.width, 0.05, 1 - it.x);
      else it.fs = clamp(ofs * nw / w0, 0.015, 0.12);
      apply(it); syncSize(it);
    };
    track(e, e.currentTarget, move);
  }

  function track(e, target, move) {
    target.setPointerCapture(e.pointerId);
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  stage.addEventListener('pointerdown', e => { if (e.target === stage || e.target === mainImg) select(null); });

  // ---------- แผงตั้งค่า ----------
  function refreshList() {
    const box = $('#ovList'); box.textContent = '';
    items.forEach(it => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = it.name;
      b.classList.toggle('on', it === sel);
      b.onclick = () => select(it);
      box.appendChild(b);
    });
    $('#ovHint').hidden = !items.length;
  }

  function select(it) {
    sel = it;
    items.forEach(i => i.el.classList.toggle('sel', i === it));
    $('#props').hidden = !it;
    refreshList();
    if (!it) return;
    $('#propsTitle').textContent = it.name;
    $('#textProps').hidden = it.type !== 'text';
    const size = $('#pSize');
    if (it.type === 'img') { size.min = 5; size.max = 100; size.step = 1; }
    else { size.min = 15; size.max = 120; size.step = 1; }
    syncSize(it);
    $('#pBorder').checked = it.border; $('#pBw').value = it.bw; $('#pBc').value = it.bc;
    $('#borderProps').hidden = !it.border;
    if (it.type === 'text') {
      $('#pText').value = it.text; $('#pColor').value = it.color;
      $('#pBg').value = it.bg; $('#pBgOn').checked = it.bgOn;
    }
  }

  function syncSize(it) { $('#pSize').value = it.type === 'img' ? it.w * 100 : it.fs * 1000; }

  const on = (id, ev, fn) => $(id).addEventListener(ev, () => { if (sel) { fn(sel); apply(sel); } });
  on('#pSize', 'input', it => {
    const v = +$('#pSize').value;
    if (it.type === 'img') it.w = Math.min(v / 100, 1 - it.x); else it.fs = v / 1000;
  });
  on('#pText', 'input', it => { it.text = $('#pText').value; });
  on('#pColor', 'input', it => { it.color = $('#pColor').value; });
  on('#pBg', 'input', it => { it.bg = $('#pBg').value; it.bgOn = true; $('#pBgOn').checked = true; });
  on('#pBgOn', 'change', it => { it.bgOn = $('#pBgOn').checked; });
  on('#pBorder', 'change', it => { it.border = $('#pBorder').checked; $('#borderProps').hidden = !it.border; });
  on('#pBw', 'input', it => { it.bw = +$('#pBw').value; });
  on('#pBc', 'input', it => { it.bc = $('#pBc').value; });

  document.querySelectorAll('[data-corner]').forEach(b => b.addEventListener('click', () => {
    if (!sel) return;
    const f = frac(sel), mx = 0.02, my = 0.02 * stage.clientWidth / stage.clientHeight, c = b.dataset.corner;
    sel.x = c[1] === 'l' ? mx : 1 - f.w - mx;
    sel.y = c[0] === 't' ? my : 1 - f.h - my;
    apply(sel);
  }));

  $('#delOv').addEventListener('click', () => {
    if (!sel) return;
    sel.el.remove(); items = items.filter(i => i !== sel); select(null);
  });

  // ---------- บันทึกเป็นไฟล์ ----------
  function rrect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function render(job) {
    const main = job.main, items = job.items;
    const k = Math.min(1, MAX_SIDE / Math.max(main.w, main.h));
    const W = Math.round(main.w * k), H = Math.round(main.h * k);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.drawImage(main.img, 0, 0, W, H);

    for (const it of items) {
      const bw = (it.border ? it.bw : 0) / 1000 * W, x = it.x * W, y = it.y * H;
      if (it.type === 'img') {
        const w = it.w * W, h = w / it.ar;
        g.drawImage(it.img, x, y, w, h);
        if (bw) { g.strokeStyle = it.bc; g.lineWidth = bw; g.strokeRect(x + bw / 2, y + bw / 2, w - bw, h - bw); }
      } else {
        const fs = it.fs * W, lh = fs * 1.25, px = fs * 0.7, py = fs * 0.4, r = fs * 0.25;
        const lines = it.text.split('\n');
        g.font = `800 ${fs}px ${FONT}`;
        const tw = Math.max(...lines.map(l => g.measureText(l).width));
        const w = tw + 2 * px + 2 * bw, h = lines.length * lh + 2 * py + 2 * bw;
        if (it.bgOn) { g.fillStyle = it.bg; rrect(g, x, y, w, h, r); g.fill(); }
        if (bw) { g.strokeStyle = it.bc; g.lineWidth = bw; rrect(g, x + bw / 2, y + bw / 2, w - bw, h - bw, r); g.stroke(); }
        g.fillStyle = it.color; g.textBaseline = 'middle'; g.textAlign = 'left';
        lines.forEach((l, i) => g.fillText(l, x + bw + px, y + bw + py + lh * (i + 0.5)));
      }
    }
    return c;
  }

  function download(job, name) {
    const png = job.fmt === 'png';
    return new Promise(resolve => render(job).toBlob(blob => {
      if (!blob) { toast('บันทึกไม่สำเร็จ (ภาพใหญ่เกินไป)'); return resolve(false); }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      resolve(true);
    }, png ? 'image/png' : 'image/jpeg', 0.92));
  }
  const fileName = j => (j.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'image');

  $('#save').addEventListener('click', async () => {
    if (!cur) return;
    stash();
    const name = fileName(cur) + (cur.fmt === 'png' ? '.png' : '.jpg');
    if (await download(cur, name)) toast('บันทึกแล้ว: ' + name);
  });

  $('#saveAll').addEventListener('click', async () => {
    stash();
    const used = new Set(); let ok = 0;
    for (const j of jobs) {
      let base = fileName(j), n = 1;
      const ext = j.fmt === 'png' ? '.png' : '.jpg';
      while (used.has(base + ext)) base = fileName(j) + '_' + (++n);
      used.add(base + ext);
      if (await download(j, base + ext)) ok++;
      await new Promise(r => setTimeout(r, 400));   // เว้นระยะ ไม่ให้เบราว์เซอร์บล็อกการดาวน์โหลดต่อเนื่อง
    }
    toast(`บันทึกแล้ว ${ok} ภาพ`);
  });
})();
