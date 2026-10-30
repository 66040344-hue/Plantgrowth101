// IndexedDB wrapper — เก็บภาพไว้ในเครื่องก่อนอัปโหลด (รองรับออฟไลน์)
//   photos   : ข้อมูลภาพ + thumbnail (ไม่มีไฟล์จริง)
//   blobs    : ไฟล์ภาพจริงเป็น Blob (ลบทิ้งเมื่ออัปโหลดสำเร็จ)
//   sessions : การบันทึก 1 ต้น / 1 รอบ
const DB = (() => {
  const NAME = 'plantgrowth';
  const VERSION = 2;
  let dbPromise;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(NAME, VERSION);
        req.onupgradeneeded = ev => {
          const db = req.result;
          const tx = req.transaction;
          if (ev.oldVersion < 1) {
            const p = db.createObjectStore('photos', { keyPath: 'key' });
            p.createIndex('session', 'sessionKey');
            p.createIndex('status', 'status');
            db.createObjectStore('blobs', { keyPath: 'key' });
            const s = db.createObjectStore('sessions', { keyPath: 'key' });
            s.createIndex('status', 'status');
          }
          if (ev.oldVersion < 2) {
            // ค้นหาตาม สวน+วันที่ โดยไม่ต้องโหลดทั้งฐานข้อมูล
            tx.objectStore('photos').createIndex('gardenDate', ['gardenId', 'date']);
            tx.objectStore('sessions').createIndex('gardenDate', ['gardenId', 'date']);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function run(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let result;
      const req = fn(tx.objectStore(store));
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    }));
  }

  return {
    get: (store, key) => run(store, 'readonly', s => s.get(key)),
    put: (store, value) => run(store, 'readwrite', s => s.put(value)),
    del: (store, key) => run(store, 'readwrite', s => s.delete(key)),
    all: (store) => run(store, 'readonly', s => s.getAll()),
    byIndex: (store, index, value) => run(store, 'readonly', s => s.index(index).getAll(value)),
    count: (store, index, value) => run(store, 'readonly', s => s.index(index).count(value)),
  };
})();
