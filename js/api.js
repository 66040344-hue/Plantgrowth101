// เรียก Google Apps Script Web App
// POST ใช้ Content-Type: text/plain เพื่อเลี่ยง CORS preflight (Apps Script ไม่รองรับ OPTIONS)
const API = (() => {
  const CFG = window.APP_CONFIG || {};

  function ready() {
    return !!CFG.API_URL && !CFG.API_URL.includes('XXXX');
  }

  async function parse(res) {
    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw new Error('เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง — ตรวจสอบ API_URL และการ Deploy (Who has access: Anyone)');
    }
    if (!json.ok) throw new Error(json.error || 'Server error');
    return json.data;
  }

  async function get(action, params = {}) {
    const url = new URL(CFG.API_URL);
    url.searchParams.set('action', action);
    url.searchParams.set('key', CFG.APP_KEY);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    return parse(await fetch(url.toString()));
  }

  async function post(action, body, timeoutMs = 6 * 60 * 1000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(CFG.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, key: CFG.APP_KEY, ...body }),
        signal: ctrl.signal,
      });
      return await parse(res);
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('หมดเวลาการเชื่อมต่อ');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  return { ready, get, post };
})();
