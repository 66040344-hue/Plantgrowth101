/**
 * Plant Growth Photo Logger — Backend (Google Apps Script)
 * ใช้เป็น Script ที่ผูกกับ Google Sheet (Extensions > Apps Script)
 *
 * โครงสร้างโฟลเดอร์ใน Drive:
 *   PlantGrowth / <สวน> / <วันที่> / <ทรีตเมนต์> / <ตัวอย่าง> / ไฟล์ภาพ
 *
 * การอัปโหลด (แบบเร็ว):
 *   1. startUpload  — สร้าง resumable upload session ของ Drive แล้วส่ง URL ให้มือถือ
 *   2. มือถือ PUT ไฟล์ภาพตรงไปที่ Google Drive (ไม่ผ่าน Apps Script, ไม่ต้องแปลง base64)
 *   3. finishUpload — ลบไฟล์ชื่อซ้ำ + บันทึกลงชีต Photos
 *   (upload = วิธีเดิมแบบ base64 ใช้เป็นทางสำรอง)
 */

// ===== ตั้งค่า =====
const APP_KEY = 'egat-2026';   // ต้องตรงกับ APP_KEY ใน js/config.js
const ADMIN_PIN = '';                      // PIN สำหรับแก้การตั้งค่าสวนผ่านหน้าเว็บ (ว่างไว้ = ไม่ต้องใส่ PIN)
const ROOT_FOLDER_ID = '';                 // ว่างไว้ = สร้างโฟลเดอร์ ROOT_FOLDER_NAME ให้อัตโนมัติ
const ROOT_FOLDER_NAME = 'PlantGrowth';
const TZ = 'Asia/Bangkok';

const SHEETS = {
  Config:   ['garden_id', 'garden_name', 'treatment', 'samples', 'branches'],
  Photos:   ['key', 'uploaded_at', 'garden_id', 'garden_name', 'date', 'treatment', 'sample_id',
             'slot', 'branch', 'part', 'file_name', 'file_id', 'url', 'size_bytes',
             'captured_at', 'recorder', 'device_id', 'thumb'],   // thumb ต้องอยู่คอลัมน์สุดท้าย
  Sessions: ['key', 'saved_at', 'garden_id', 'garden_name', 'date', 'treatment', 'sample_id',
             'photo_count', 'expected_count', 'recorder', 'note', 'device_id', 'folder_url'],
  // ค่าที่วัดของแต่ละสวน (ตั้งค่าในหน้าเว็บ)
  Fields:   ['garden_id', 'field_id', 'label', 'unit', 'order'],
  // ค่าที่วัดได้ 1 แถว = 1 กิ่ง / 1 ค่า
  Measurements: ['key', 'saved_at', 'garden_id', 'date', 'treatment', 'sample_id', 'branch',
                 'field_id', 'label', 'unit', 'value', 'recorder'],
};

// ค่าที่วัดเริ่มต้น (ต้องตรงกับ DEFAULT_FIELDS ใน js/app.js)
const DEFAULT_FIELDS = [
  { id: 'stem_len',  label: 'ความยาวก้าน',  unit: 'cm' },
  { id: 'stem_dia',  label: 'ขนาดก้าน',     unit: 'mm' },
  { id: 'nodes',     label: 'จำนวนข้อปล้อง', unit: 'ข้อ' },
  { id: 'leaves',    label: 'จำนวนใบ',      unit: 'ใบ' },
  { id: 'spad',      label: 'SPAD',         unit: '' },
  { id: 'leaf_area', label: 'พื้นที่ใบ',     unit: 'cm²' },
];

// ===== ติดตั้ง / อนุญาตสิทธิ์: กด Run ฟังก์ชันนี้ (รันซ้ำได้ทุกครั้งที่อัปเดตโค้ด) =====
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(SHEETS[name]);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, SHEETS[name].length).setFontWeight('bold');
    } else {
      ensureColumns_(sh, SHEETS[name]);
    }
  });
  const cfg = ss.getSheetByName('Config');
  if (cfg.getLastRow() === 1) {
    cfg.getRange(2, 1, 3, 5).setValues([
      ['GA', 'สวน A', 'T1', 5, 4],
      ['GA', 'สวน A', 'T2', 5, 4],
      ['GB', 'สวน B', 'T1', 3, 4],
    ]);
  }
  const root = getRootFolder_();
  // เรียก UrlFetchApp 1 ครั้งเพื่อให้ขอสิทธิ์ "เชื่อมต่อบริการภายนอก" (ใช้ตอนสร้าง upload session)
  UrlFetchApp.fetch('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest', { muteHttpExceptions: true });
  Logger.log('พร้อมใช้งาน — Root folder: ' + root.getUrl());
}

// ===== HTTP =====
function doGet(e) {
  return respond_(() => {
    const p = e.parameter || {};
    checkKey_(p.key);
    switch (p.action) {
      case 'config': return getConfig_();
      case 'status': return getStatus_(p.garden, p.date);
      case 'sample': return getSample_(p.garden, p.date, p.sample);
      case 'dates':  return getDates_(p.garden);
      case 'history': return getHistory_(p.garden, p.sample, p.slot);
      case 'export': return exportMeasures_(p.garden, p.treatment);
      case 'photolist': return listPhotos_(p.garden, p.treatment);
      case 'photo':  return getPhotoFile_(p.file);
      case 'ping':   return { time: new Date().toISOString() };
      default: throw new Error('Unknown action: ' + p.action);
    }
  });
}

function doPost(e) {
  return respond_(() => {
    if (!e.postData || !e.postData.contents) throw new Error('Empty body');
    const req = JSON.parse(e.postData.contents);
    checkKey_(req.key);
    switch (req.action) {
      case 'startUpload':  return startUpload_(req);
      case 'finishUpload': return finishUpload_(req);
      case 'upload':       return uploadPhoto_(req);
      case 'saveSession':  return saveSession_(req);
      case 'saveConfig':   return saveConfig_(req);
      default: throw new Error('Unknown action: ' + req.action);
    }
  });
}

function respond_(fn) {
  let out;
  try {
    out = { ok: true, data: fn() };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function checkKey_(key) {
  if (key !== APP_KEY) throw new Error('Invalid app key');
}

// ===== Config =====
function getConfig_() {
  const rows = readRows_('Config');
  const gardens = [];
  const byId = {};
  rows.forEach(r => {
    const gid = str_(r.garden_id);
    const tid = str_(r.treatment);
    if (!gid || !tid) return;
    if (!byId[gid]) {
      byId[gid] = { id: gid, name: str_(r.garden_name) || gid, treatments: [] };
      gardens.push(byId[gid]);
    }
    byId[gid].treatments.push({
      id: tid,
      samples: Math.max(1, parseInt(r.samples, 10) || 1),
      branches: Math.max(0, parseInt(r.branches, 10) || 0),
    });
  });
  const fm = fieldsMap_();
  gardens.forEach(g => { g.fields = fm ? (fm[g.id] || []) : DEFAULT_FIELDS.map(f => Object.assign({}, f)); });
  return { gardens: gardens, version: configVersion_() };
}

// ค่าที่วัดของทุกสวน — null = ยังไม่เคยตั้งค่าเอง (ใช้ค่าเริ่มต้น)
function fieldsMap_() {
  if (!PropertiesService.getScriptProperties().getProperty('FIELDS_SET')) return null;
  const map = {};
  readRows_('Fields')
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
    .forEach(r => {
      const gid = str_(r.garden_id);
      (map[gid] || (map[gid] = [])).push({ id: str_(r.field_id), label: str_(r.label), unit: str_(r.unit) });
    });
  return map;
}

function fieldsFor_(gardenId) {
  const fm = fieldsMap_();
  return fm ? (fm[gardenId] || []) : DEFAULT_FIELDS;
}

function sheet_(name) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(SHEETS[name]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, SHEETS[name].length).setFontWeight('bold');
  }
  return sh;
}

function configVersion_() {
  return PropertiesService.getScriptProperties().getProperty('CONFIG_VERSION') || '0';
}

// ===== บันทึกการตั้งค่าสวนจากหน้าเว็บ (เขียนทับชีต Config ทั้งหมด) =====
function saveConfig_(req) {
  if (ADMIN_PIN && String(req.pin || '') !== ADMIN_PIN) throw new Error('ADMIN_PIN');
  const ID_RE = /^[A-Za-z0-9_\-]{1,20}$/;
  const gardens = req.gardens || [];
  const gids = {};
  const names = {};
  const rows = [];
  const fieldRows = [];
  gardens.forEach(g => {
    const name = String(g.name || '').trim();
    if (!ID_RE.test(g.id)) throw new Error('รหัสสวนไม่ถูกต้อง: ' + g.id);
    if (gids[g.id]) throw new Error('รหัสสวนซ้ำ: ' + g.id);
    if (!name) throw new Error('ไม่มีชื่อสวน: ' + g.id);
    if (names[name]) throw new Error('ชื่อสวนซ้ำ: ' + name);
    gids[g.id] = names[name] = true;
    const tids = {};
    (g.treatments || []).forEach(t => {
      if (!ID_RE.test(t.id)) throw new Error('รหัสทรีตเมนต์ไม่ถูกต้อง: ' + g.id + ' ' + t.id);
      if (tids[t.id]) throw new Error('รหัสทรีตเมนต์ซ้ำ: ' + g.id + ' ' + t.id);
      tids[t.id] = true;
      const samples = parseInt(t.samples, 10);
      const branches = parseInt(t.branches, 10);
      if (!(samples >= 1 && samples <= 500)) throw new Error('จำนวนต้นไม่ถูกต้อง: ' + g.id + ' ' + t.id);
      if (!(branches >= 0 && branches <= 20)) throw new Error('จำนวนกิ่งไม่ถูกต้อง: ' + g.id + ' ' + t.id);
      rows.push({ garden_id: g.id, garden_name: name, treatment: t.id, samples: samples, branches: branches });
    });
    const fids = {};
    (g.fields || []).forEach((f, i) => {
      const label = String(f.label || '').trim();
      if (!ID_RE.test(f.id)) throw new Error('รหัสค่าที่วัดไม่ถูกต้อง: ' + g.id + ' ' + f.id);
      if (fids[f.id]) throw new Error('รหัสค่าที่วัดซ้ำ: ' + g.id + ' ' + f.id);
      if (!label || label.length > 40) throw new Error('ชื่อค่าที่วัดไม่ถูกต้อง: ' + g.id);
      fids[f.id] = true;
      fieldRows.push({ garden_id: g.id, field_id: f.id, label: label, unit: String(f.unit || '').trim().slice(0, 12), order: i + 1 });
    });
  });

  return withLock_(() => {
    if (String(req.baseVersion) !== configVersion_()) throw new Error('CONFIG_CONFLICT');
    const sh = SpreadsheetApp.getActive().getSheetByName('Config');
    const header = ensureColumns_(sh, SHEETS.Config);
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, header.length).clearContent();
    if (rows.length) {
      sh.getRange(2, 1, rows.length, header.length)
        .setValues(rows.map(r => header.map(h => (h in r ? r[h] : ''))));
    }
    const fsh = sheet_('Fields');
    const fheader = ensureColumns_(fsh, SHEETS.Fields);
    if (fsh.getLastRow() > 1) fsh.getRange(2, 1, fsh.getLastRow() - 1, fheader.length).clearContent();
    if (fieldRows.length) {
      fsh.getRange(2, 1, fieldRows.length, fheader.length)
        .setValues(fieldRows.map(r => fheader.map(h => (h in r ? r[h] : ''))));
    }
    const props = PropertiesService.getScriptProperties();
    props.setProperty('FIELDS_SET', '1');
    props.setProperty('CONFIG_VERSION', String(Number(configVersion_()) + 1));
    return getConfig_();
  });
}

// ===== Status: ภาพที่อยู่บน Drive แล้ว แยกตามต้น (จากทุกเครื่อง) =====
function getStatus_(gardenId, date) {
  const samples = {};
  readRows_('Photos', true)
    .filter(r => str_(r.garden_id) === gardenId && str_(r.date) === date)
    .forEach(r => {
      const sid = str_(r.sample_id);
      const s = samples[sid] || (samples[sid] = { slots: [], recorder: '', saved: false });
      s.slots.push(str_(r.slot));
      s.recorder = str_(r.recorder) || s.recorder;
    });
  readRows_('Sessions')
    .filter(r => str_(r.garden_id) === gardenId && str_(r.date) === date)
    .forEach(r => {
      const sid = str_(r.sample_id);
      const s = samples[sid] || (samples[sid] = { slots: [], recorder: '', saved: false });
      s.saved = true;
      s.recorder = s.recorder || str_(r.recorder);
    });
  return { samples: samples };
}

// ===== Sample: รายละเอียดภาพของต้นเดียว (พร้อม thumbnail) สำหรับถ่ายต่อ =====
function getSample_(gardenId, date, sampleId) {
  const rows = readRows_('Photos', true)
    .filter(r => str_(r.garden_id) === gardenId && str_(r.date) === date && str_(r.sample_id) === sampleId);
  const thumbs = readThumbs_(rows.map(r => r._row));
  const photos = rows.map(r => ({
    slot: str_(r.slot),
    file_id: str_(r.file_id),
    url: str_(r.url),
    captured_at: iso_(r.captured_at),
    recorder: str_(r.recorder),
    thumb: thumbs[r._row] || '',
  }));
  const s = readRows_('Sessions').find(r =>
    str_(r.garden_id) === gardenId && str_(r.date) === date && str_(r.sample_id) === sampleId);
  const measures = {};
  readRows_('Measurements')
    .filter(r => str_(r.garden_id) === gardenId && str_(r.date) === date && str_(r.sample_id) === sampleId)
    .forEach(r => {
      const b = String(r.branch);
      (measures[b] || (measures[b] = {}))[str_(r.field_id)] = String(r.value);
    });
  return {
    photos: photos,
    measures: measures,
    session: s ? { note: str_(s.note), recorder: str_(s.recorder), saved_at: iso_(s.saved_at) } : null,
  };
}

// ===== Export: ค่าที่วัดทุกรอบของทรีตเมนต์ (1 แถว = วันที่ / ต้น / กิ่ง) สำหรับนำไปวิเคราะห์ =====
function exportMeasures_(gardenId, treatment) {
  const cols = [];   // ลำดับคอลัมน์: ค่าที่ตั้งไว้ปัจจุบันก่อน แล้วตามด้วยค่าเก่าที่ถูกลบไปแล้วแต่ยังมีข้อมูล
  const seen = {};
  const addCol = (id, label, unit) => { if (!seen[id]) { seen[id] = true; cols.push({ id: id, label: label, unit: unit }); } };
  fieldsFor_(gardenId).forEach(f => addCol(f.id, f.label, f.unit));

  const byKey = {};
  const rowOf = (date, sid, branch, recorder) => {
    const k = [date, sid, branch].join('|');
    return byKey[k] || (byKey[k] = {
      date: date, sample_id: sid, branch: Number(branch), recorder: recorder, values: {}, plant: '', cluster: '', leaf: '',
    });
  };
  readRows_('Measurements')
    .filter(r => str_(r.garden_id) === gardenId && str_(r.treatment) === treatment)
    .forEach(r => {
      addCol(str_(r.field_id), str_(r.label), str_(r.unit));
      rowOf(str_(r.date), str_(r.sample_id), r.branch, str_(r.recorder)).values[str_(r.field_id)] = r.value;
    });

  // ลิงก์ภาพ: ภาพชุดใบ/ใบเดี่ยวอยู่ในแถวของกิ่งนั้น (กิ่งที่มีแต่ภาพไม่มีค่าที่วัดก็ได้แถว) ภาพต้นใส่ทุกแถวของต้นนั้น
  const plantUrl = {};
  const photoRows = readRows_('Photos', true)
    .filter(r => str_(r.garden_id) === gardenId && str_(r.treatment) === treatment);
  photoRows.forEach(r => {
    const date = str_(r.date), sid = str_(r.sample_id), branch = Number(r.branch) || 0;
    if (str_(r.part) === 'PLANT' || branch === 0) { plantUrl[date + '|' + sid] = str_(r.url); return; }
    const o = rowOf(date, sid, branch, str_(r.recorder));
    if (str_(r.part) === 'CLUSTER') o.cluster = str_(r.url);
    else if (str_(r.part) === 'LEAF') o.leaf = str_(r.url);
  });
  Object.keys(byKey).forEach(k => {
    const o = byKey[k];
    o.plant = plantUrl[o.date + '|' + o.sample_id] || '';
  });

  const notes = {};
  readRows_('Sessions')
    .filter(r => str_(r.garden_id) === gardenId && str_(r.treatment) === treatment)
    .forEach(r => { notes[str_(r.date) + '|' + str_(r.sample_id)] = str_(r.note); });

  const rows = Object.keys(byKey).map(k => byKey[k]).sort((a, b) =>
    a.date.localeCompare(b.date) || a.sample_id.localeCompare(b.sample_id, 'en', { numeric: true }) || a.branch - b.branch);
  rows.forEach(r => { r.note = notes[r.date + '|' + r.sample_id] || ''; });
  return { fields: cols, rows: rows };
}

// ===== รายการภาพของทรีตเมนต์ (สำหรับดาวน์โหลดรูป) =====
function listPhotos_(gardenId, treatment) {
  return readRows_('Photos', true)
    .filter(r => str_(r.garden_id) === gardenId && str_(r.treatment) === treatment)
    .map(r => ({
      date: str_(r.date), sample_id: str_(r.sample_id), slot: str_(r.slot),
      file_id: str_(r.file_id), file_name: str_(r.file_name),
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.sample_id.localeCompare(b.sample_id, 'en', { numeric: true }));
}

// ส่งไฟล์ภาพ 1 ไฟล์เป็น base64 — เฉพาะไฟล์ที่ลงทะเบียนในชีต Photos เท่านั้น
function getPhotoFile_(fileId) {
  const sh = SpreadsheetApp.getActive().getSheetByName('Photos');
  const col = headerOf_(sh).indexOf('file_id') + 1;
  const found = fileId && col && sh.getLastRow() >= 2 && sh.getRange(2, col, sh.getLastRow() - 1, 1)
    .createTextFinder(fileId).matchEntireCell(true).findNext();
  if (!found) throw new Error('ไม่พบภาพนี้');
  const blob = DriveApp.getFileById(fileId).getBlob();
  return { name: blob.getName(), mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

// ===== บันทึกค่าที่วัด: แทนที่ค่าของต้นนี้ในรอบนี้ (เฉพาะค่าที่อยู่ใน req.fieldIds) =====
function saveMeasures_(req) {
  if (!req.measures) return;
  const sh = sheet_('Measurements');
  const header = ensureColumns_(sh, SHEETS.Measurements);
  const meta = {};
  fieldsFor_(req.gardenId).forEach(f => { meta[f.id] = f; });
  const clearable = {};
  (req.fieldIds || []).forEach(id => { clearable[id] = true; });
  const prefix = [req.gardenId, req.date, req.sampleId].join('|') + '|';

  const desired = {};
  Object.keys(req.measures).forEach(b => {
    const o = req.measures[b] || {};
    Object.keys(o).forEach(fid => {
      const raw = o[fid];
      const v = Number(raw);
      if (raw === '' || raw == null || !isFinite(v)) return;
      const f = meta[fid] || { label: fid, unit: '' };
      desired[prefix + b + '|' + fid] = {
        saved_at: new Date(), garden_id: req.gardenId, date: req.date, treatment: req.treatment,
        sample_id: req.sampleId, branch: Number(b), field_id: fid, label: f.label, unit: f.unit,
        value: v, recorder: req.recorder || '',
      };
    });
  });

  withLock_(() => {
    const last = sh.getLastRow();
    const keys = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0])) : [];
    const have = {};
    const del = [];
    keys.forEach((k, i) => {
      if (k.indexOf(prefix) !== 0) return;
      if (desired[k]) have[k] = i + 2;
      else if (clearable[k.split('|').pop()]) del.push(i + 2);
    });
    const toRow = (k) => header.map(h => (h === 'key' ? k : h in desired[k] ? desired[k][h] : ''));
    const fresh = [];
    Object.keys(desired).forEach(k => {
      if (have[k]) sh.getRange(have[k], 1, 1, header.length).setValues([toRow(k)]);
      else fresh.push(toRow(k));
    });
    if (fresh.length) sh.getRange(last + 1, 1, fresh.length, header.length).setValues(fresh);
    del.sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
  });
}

// ===== Dates: รอบการเก็บข้อมูลทั้งหมดของสวน (ใหม่ → เก่า) =====
function getDates_(gardenId) {
  const byDate = {};
  readRows_('Photos', true)
    .filter(r => str_(r.garden_id) === gardenId)
    .forEach(r => {
      const d = str_(r.date);
      const o = byDate[d] || (byDate[d] = { date: d, photos: 0, samples: {} });
      o.photos++;
      o.samples[str_(r.sample_id)] = true;
    });
  return Object.keys(byDate).sort().reverse().map(d => ({
    date: d,
    photos: byDate[d].photos,
    samples: Object.keys(byDate[d].samples).length,
  }));
}

// ===== History: ภาพของต้นเดียวกันทุกรอบ (เก่า → ใหม่) สำหรับดูการเจริญเติบโต =====
function getHistory_(gardenId, sampleId, slot) {
  const rows = readRows_('Photos', true)
    .filter(r => str_(r.garden_id) === gardenId && str_(r.sample_id) === sampleId && (!slot || str_(r.slot) === slot))
    .sort((a, b) => str_(a.date).localeCompare(str_(b.date)));
  const thumbs = readThumbs_(rows.map(r => r._row));
  const notes = {};
  readRows_('Sessions')
    .filter(r => str_(r.garden_id) === gardenId && str_(r.sample_id) === sampleId)
    .forEach(r => { if (str_(r.note)) notes[str_(r.date)] = str_(r.note); });
  return {
    photos: rows.map(r => ({
      date: str_(r.date),
      slot: str_(r.slot),
      file_id: str_(r.file_id),
      url: str_(r.url),
      captured_at: iso_(r.captured_at),
      recorder: str_(r.recorder),
      thumb: thumbs[r._row] || '',
    })),
    notes: notes,
  };
}

// อ่าน thumbnail ตามแถวที่ต้องการ — รวมแถวที่อยู่ติดกันเป็นช่วงเดียวเพื่อลดจำนวนครั้งที่อ่านชีต
function readThumbs_(rowNums) {
  const out = {};
  if (!rowNums.length) return out;
  const sh = SpreadsheetApp.getActive().getSheetByName('Photos');
  const col = headerOf_(sh).indexOf('thumb') + 1;
  if (!col) return out;
  const sorted = rowNums.slice().sort((a, b) => a - b);
  let start = sorted[0];
  let prev = start;
  const flush = (a, b) => {
    sh.getRange(a, col, b - a + 1, 1).getValues().forEach((v, i) => { out[a + i] = String(v[0] || ''); });
  };
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - prev > 3) { flush(start, prev); start = sorted[i]; }
    prev = sorted[i];
  }
  flush(start, prev);
  return out;
}

// ===== Upload แบบเร็ว: ขั้นที่ 1 สร้าง upload session =====
function startUpload_(req) {
  const m = photoMeta_(req);
  if (!req.size) throw new Error('Missing field: size');

  // เคยอัปโหลดภาพนี้ (captured_at เดียวกัน) สำเร็จแล้ว → ไม่ต้องส่งซ้ำ
  const existing = findRow_('Photos', m.key);
  if (existing && sameTime_(existing.captured_at, req.capturedAt)) {
    const fileId = str_(existing.file_id);
    try {
      const f = DriveApp.getFileById(fileId);
      if (!f.isTrashed()) return { skip: true, fileId: fileId, url: f.getUrl() };
    } catch (e) { /* ไฟล์ถูกลบ → อัปโหลดใหม่ */ }
  }

  const folder = withLock_(() => getFolderPath_(m.folderParts));
  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size', {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        'X-Upload-Content-Type': m.mime,
        'X-Upload-Content-Length': String(req.size),
        Origin: req.origin || '',   // ทำให้มือถือ PUT ข้ามโดเมนได้ (CORS)
      },
      payload: JSON.stringify({ name: m.fileName, parents: [folder.getId()], mimeType: m.mime }),
      muteHttpExceptions: true,
    });
  if (res.getResponseCode() !== 200) {
    throw new Error('Drive upload session failed: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  }
  const headers = res.getAllHeaders();
  const uploadUrl = headers.Location || headers.location;
  if (!uploadUrl) throw new Error('No upload URL');
  return { uploadUrl: uploadUrl, fileName: m.fileName };
}

// ===== Upload แบบเร็ว: ขั้นที่ 3 บันทึกข้อมูลหลังไฟล์ขึ้น Drive แล้ว =====
function finishUpload_(req) {
  const m = photoMeta_(req);
  if (!req.fileId) throw new Error('Missing field: fileId');
  const file = DriveApp.getFileById(req.fileId);
  const folder = withLock_(() => getFolderPath_(m.folderParts));
  trashSameName_(folder, m.fileName, file.getId());
  withLock_(() => upsert_('Photos', m.key, photoRow_(m, req, file)));
  return { fileId: file.getId(), url: file.getUrl() };
}

// ===== Upload แบบเดิม (base64) — ทางสำรอง =====
function uploadPhoto_(req) {
  const m = photoMeta_(req);
  if (!req.data) throw new Error('Missing field: data');
  const folder = withLock_(() => getFolderPath_(m.folderParts));
  trashSameName_(folder, m.fileName, null);
  const blob = Utilities.newBlob(Utilities.base64Decode(req.data), m.mime, m.fileName);
  const file = folder.createFile(blob);
  withLock_(() => upsert_('Photos', m.key, photoRow_(m, req, file)));
  return { fileId: file.getId(), url: file.getUrl() };
}

function photoMeta_(req) {
  ['gardenId', 'gardenName', 'date', 'treatment', 'sampleId', 'slot'].forEach(k => {
    if (!req[k]) throw new Error('Missing field: ' + k);
  });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.date)) throw new Error('Invalid date');
  const mime = req.mimeType || 'image/jpeg';
  const ext = mime === 'image/png' ? 'png' : mime === 'image/heic' ? 'heic' : 'jpg';
  return {
    mime: mime,
    key: [req.gardenId, req.date, req.sampleId, req.slot].join('|'),
    fileName: [safeId_(req.gardenId), req.date.replace(/-/g, ''), safeId_(req.sampleId), safeId_(req.slot)].join('_') + '.' + ext,
    folderParts: [safeName_(req.gardenName), req.date, safeName_(req.treatment), safeName_(req.sampleId)],
  };
}

function photoRow_(m, req, file) {
  return {
    key: m.key,
    uploaded_at: new Date(),
    garden_id: req.gardenId,
    garden_name: req.gardenName,
    date: req.date,
    treatment: req.treatment,
    sample_id: req.sampleId,
    slot: req.slot,
    branch: req.branch || 0,
    part: req.part || '',
    file_name: m.fileName,
    file_id: file.getId(),
    url: file.getUrl(),
    size_bytes: file.getSize(),
    captured_at: req.capturedAt || '',
    recorder: req.recorder || '',
    device_id: req.deviceId || '',
    // cell ของ Sheets เก็บได้ไม่เกิน 50,000 ตัวอักษร — ถ้าใหญ่เกินไม่เก็บ (ตัดครึ่งจะได้ภาพเสีย)
    thumb: String(req.thumb || '').length <= 48000 ? String(req.thumb || '') : '',
  };
}

// ถ่ายใหม่ / ส่งซ้ำ → ไฟล์ชื่อเดิมไปอยู่ในถังขยะ (กู้คืนได้ 30 วัน)
function trashSameName_(folder, fileName, keepId) {
  const it = folder.getFilesByName(fileName);
  while (it.hasNext()) {
    const f = it.next();
    if (f.getId() !== keepId) f.setTrashed(true);
  }
}

// ===== Save session (สรุป 1 ต้น / 1 รอบ) =====
function saveSession_(req) {
  ['gardenId', 'gardenName', 'date', 'treatment', 'sampleId'].forEach(k => {
    if (!req[k]) throw new Error('Missing field: ' + k);
  });
  const key = [req.gardenId, req.date, req.sampleId].join('|');
  const folder = withLock_(() =>
    getFolderPath_([safeName_(req.gardenName), req.date, safeName_(req.treatment), safeName_(req.sampleId)]));
  withLock_(() => upsert_('Sessions', key, {
    key: key,
    saved_at: new Date(),
    garden_id: req.gardenId,
    garden_name: req.gardenName,
    date: req.date,
    treatment: req.treatment,
    sample_id: req.sampleId,
    photo_count: req.photoCount || 0,
    expected_count: req.expectedCount || 0,
    recorder: req.recorder || '',
    note: req.note || '',
    device_id: req.deviceId || '',
    folder_url: folder.getUrl(),
  }));
  saveMeasures_(req);
  return { key: key, folderUrl: folder.getUrl() };
}

// ===== Drive helpers =====
function getRootFolder_() {
  if (ROOT_FOLDER_ID) return DriveApp.getFolderById(ROOT_FOLDER_ID);
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ROOT_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* ถูกลบไปแล้ว สร้างใหม่ */ }
  }
  const folder = DriveApp.createFolder(ROOT_FOLDER_NAME);
  props.setProperty('ROOT_FOLDER_ID', folder.getId());
  return folder;
}

function getFolderPath_(parts) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'f:' + parts.join('/');
  const cachedId = cache.get(cacheKey);
  if (cachedId) {
    try { return DriveApp.getFolderById(cachedId); } catch (e) { /* fallthrough */ }
  }
  let folder = getRootFolder_();
  parts.forEach(name => {
    const it = folder.getFoldersByName(name);
    folder = it.hasNext() ? it.next() : folder.createFolder(name);
  });
  cache.put(cacheKey, folder.getId(), 21600);
  return folder;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ===== Sheet helpers =====
function headerOf_(sh) {
  if (!sh || sh.getLastColumn() === 0) return [];
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

// skipThumb = ไม่อ่านคอลัมน์ thumb (คอลัมน์สุดท้าย) เพื่อให้อ่านเร็ว
function readRows_(name, skipThumb) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const header = headerOf_(sh);
  let width = header.length;
  const ti = header.indexOf('thumb');
  if (skipThumb && ti === header.length - 1) width = ti;
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, width).getValues();
  return values.map((row, i) => {
    const o = { _row: i + 2 };
    for (let c = 0; c < width; c++) o[header[c]] = row[c];
    return o;
  });
}

function findRow_(name, key) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (sh.getLastRow() < 2) return null;
  const found = sh.getRange(2, 1, sh.getLastRow() - 1, 1)
    .createTextFinder(key).matchEntireCell(true).findNext();
  if (!found) return null;
  const header = headerOf_(sh);
  const ti = header.indexOf('thumb');
  const width = ti === header.length - 1 ? ti : header.length;
  const row = sh.getRange(found.getRow(), 1, 1, width).getValues()[0];
  const o = { _row: found.getRow() };
  for (let c = 0; c < width; c++) o[header[c]] = row[c];
  return o;
}

// เพิ่มคอลัมน์ที่ยังไม่มี (สำหรับชีตที่สร้างจากเวอร์ชันก่อน)
function ensureColumns_(sh, cols) {
  const header = headerOf_(sh);
  const missing = cols.filter(c => header.indexOf(c) < 0);
  if (missing.length) {
    sh.getRange(1, header.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  return header.concat(missing);
}

function upsert_(name, key, obj) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  const header = ensureColumns_(sh, Object.keys(obj));
  const row = header.map(h => (h in obj ? obj[h] : ''));
  const found = sh.getLastRow() >= 2 && sh.getRange(2, 1, sh.getLastRow() - 1, 1)
    .createTextFinder(key).matchEntireCell(true).findNext();
  if (found) sh.getRange(found.getRow(), 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
}

// ค่าจาก Sheet อาจเป็น Date object (Sheets แปลง 2026-10-30 เป็นวันที่ให้อัตโนมัติ)
let sheetTz_ = null;
function str_(v) {
  if (v instanceof Date) {
    if (!sheetTz_) sheetTz_ = SpreadsheetApp.getActive().getSpreadsheetTimeZone() || TZ;
    return Utilities.formatDate(v, sheetTz_, 'yyyy-MM-dd');
  }
  return v == null ? '' : String(v).trim();
}

function iso_(v) {
  if (v instanceof Date) return v.toISOString();
  return v == null ? '' : String(v).trim();
}

function sameTime_(a, b) {
  const ta = a instanceof Date ? a.getTime() : Date.parse(a);
  const tb = b instanceof Date ? b.getTime() : Date.parse(b);
  return !isNaN(ta) && !isNaN(tb) && Math.abs(ta - tb) < 1000;
}

function safeName_(s) {
  return String(s).replace(/[\/\\:*?"<>|]/g, '_').trim() || '_';
}

function safeId_(s) {
  return String(s).replace(/[^A-Za-z0-9_\-]/g, '_');
}
