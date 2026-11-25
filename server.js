// ระบบเช็คชื่อด้วยการแสกนหน้า - เซิร์ฟเวอร์ (Node.js ล้วน ไม่ต้องติดตั้งแพ็กเกจเพิ่ม)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const DEVICE_KEY = process.env.DEVICE_KEY || 'esp32-secret';
const MATCH_THRESHOLD = parseFloat(process.env.MATCH_THRESHOLD || '0.5'); // ยิ่งน้อยยิ่งเข้มงวด
const DUP_MINUTES = parseInt(process.env.DUP_MINUTES || '5', 10); // กันแสกนซ้ำในห้องเดียวกัน

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- ฐานข้อมูล (ไฟล์ JSON) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { students: [], rooms: [], attendance: [] };
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { console.error('อ่าน db.json ไม่ได้', e); }
}
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
const uid = (n = 4) => crypto.randomBytes(n).toString('hex');

// ---------- ตัวช่วย ----------
const tokens = new Map(); // token -> หมดอายุ
function newToken() {
  const t = uid(16);
  tokens.set(t, Date.now() + 12 * 3600 * 1000);
  return t;
}
function isAdmin(req, url) {
  const t = req.headers['x-admin-token'] || url.searchParams.get('token');
  const exp = tokens.get(t);
  if (!exp || exp < Date.now()) { tokens.delete(t); return false; }
  return true;
}
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
function validDescriptor(d) {
  return Array.isArray(d) && d.length === 128 && d.every((x) => typeof x === 'number' && isFinite(x));
}
function dist(a, b) {
  let s = 0;
  for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}
function findMatch(desc) {
  let best = null, bestD = Infinity;
  for (const s of db.students) {
    if (!s.descriptor) continue;
    const d = dist(desc, s.descriptor);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best && bestD < MATCH_THRESHOLD ? { student: best, distance: bestD } : null;
}
function bkkDate(ts) { return new Date(new Date(ts).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10); }

function record(student, room, source) {
  const now = Date.now();
  const last = [...db.attendance].reverse().find((a) => a.studentId === student.studentId && a.roomId === room.id);
  if (last && now - new Date(last.ts).getTime() < DUP_MINUTES * 60000) {
    return { duplicate: true, rec: last };
  }
  const rec = {
    id: uid(), studentId: student.studentId, name: student.name, branch: student.branch,
    roomId: room.id, roomName: room.name, source, ts: new Date(now).toISOString(),
  };
  db.attendance.push(rec);
  saveDb();
  return { duplicate: false, rec };
}
function publicRec(r, duplicate) {
  return { ok: true, duplicate: !!duplicate, name: r.name, studentId: r.studentId, branch: r.branch, room: r.roomName, time: r.ts };
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  // เข้าสู่ระบบแอดมิน
  if (p === '/api/admin/login' && m === 'POST') {
    const b = await readBody(req);
    if (b.password === ADMIN_PASSWORD) return send(res, 200, { token: newToken() });
    return send(res, 401, { error: 'รหัสผ่านไม่ถูกต้อง' });
  }

  // ข้อมูลห้อง (สาธารณะ - ใช้ในหน้าแสกน)
  let mm = p.match(/^\/api\/rooms\/([\w-]+)$/);
  if (mm && m === 'GET') {
    const room = db.rooms.find((r) => r.id === mm[1]);
    return room ? send(res, 200, { id: room.id, name: room.name }) : send(res, 404, { error: 'ไม่พบห้องนี้' });
  }

  // แสกนหน้า (จากเบราว์เซอร์ที่เข้าผ่าน QR)
  if (p === '/api/scan' && m === 'POST') {
    const b = await readBody(req);
    const room = db.rooms.find((r) => r.id === b.roomId);
    if (!room) return send(res, 404, { error: 'ไม่พบห้องนี้' });
    if (!validDescriptor(b.descriptor)) return send(res, 400, { error: 'ข้อมูลใบหน้าไม่ถูกต้อง' });
    const match = findMatch(b.descriptor);
    if (!match) return send(res, 404, { ok: false, error: 'ไม่พบข้อมูลใบหน้าในระบบ' });
    const r = record(match.student, room, 'web');
    return send(res, 200, publicRec(r.rec, r.duplicate));
  }

  // ESP32 / อุปกรณ์ภายนอก: ส่ง studentId หรือ descriptor + roomId พร้อมคีย์อุปกรณ์
  if (p === '/api/device/attendance' && m === 'POST') {
    if (req.headers['x-device-key'] !== DEVICE_KEY) return send(res, 401, { error: 'device key ไม่ถูกต้อง' });
    const b = await readBody(req);
    const room = db.rooms.find((r) => r.id === b.roomId);
    if (!room) return send(res, 404, { error: 'ไม่พบห้องนี้' });
    let student = null;
    if (b.studentId) student = db.students.find((s) => s.studentId === String(b.studentId));
    else if (validDescriptor(b.descriptor)) { const mt = findMatch(b.descriptor); student = mt && mt.student; }
    if (!student) return send(res, 404, { ok: false, error: 'ไม่พบนักเรียน' });
    const r = record(student, room, 'esp32');
    return send(res, 200, publicRec(r.rec, r.duplicate));
  }

  // ESP32 จอ: ถามว่าตอนนี้ให้แสดง QR ของห้องไหน (ตอบเป็นข้อความล้วน ว่าง = ยังไม่เลือก)
  if (p === '/api/device/active-room' && m === 'GET') {
    if (req.headers['x-device-key'] !== DEVICE_KEY && url.searchParams.get('key') !== DEVICE_KEY) return send(res, 401, { error: 'device key ไม่ถูกต้อง' });
    const id = db.rooms.some((r) => r.id === db.activeRoomId) ? db.activeRoomId : '';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(id);
  }

  // ---- ต่อจากนี้ต้องเป็นแอดมิน ----
  if (!p.startsWith('/api/admin/')) return send(res, 404, { error: 'not found' });
  if (!isAdmin(req, url)) return send(res, 401, { error: 'unauthorized' });

  if (p === '/api/admin/students' && m === 'GET') {
    return send(res, 200, db.students.map((s) => ({ id: s.id, studentId: s.studentId, name: s.name, branch: s.branch, hasFace: !!s.descriptor })));
  }
  if (p === '/api/admin/students' && m === 'POST') {
    const b = await readBody(req);
    if (!b.studentId || !b.name || !b.branch) return send(res, 400, { error: 'กรอกรหัส ชื่อ และสาขาให้ครบ' });
    if (!validDescriptor(b.descriptor)) return send(res, 400, { error: 'ยังไม่ได้จับภาพใบหน้า' });
    const sid = String(b.studentId).trim();
    let s = db.students.find((x) => x.studentId === sid);
    if (s) { s.name = b.name.trim(); s.branch = b.branch.trim(); s.descriptor = b.descriptor; }
    else { s = { id: uid(), studentId: sid, name: b.name.trim(), branch: b.branch.trim(), descriptor: b.descriptor, createdAt: new Date().toISOString() }; db.students.push(s); }
    saveDb();
    return send(res, 200, { ok: true });
  }
  mm = p.match(/^\/api\/admin\/students\/([\w-]+)$/);
  if (mm && m === 'DELETE') {
    db.students = db.students.filter((s) => s.id !== mm[1]);
    saveDb();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/admin/rooms' && m === 'GET') return send(res, 200, db.rooms);
  if (p === '/api/admin/rooms' && m === 'POST') {
    const b = await readBody(req);
    if (!b.name || !String(b.name).trim()) return send(res, 400, { error: 'ใส่ชื่อห้อง' });
    const room = { id: uid(3), name: String(b.name).trim() };
    db.rooms.push(room);
    saveDb();
    return send(res, 200, room);
  }
  if (p === '/api/admin/active-room' && m === 'GET') return send(res, 200, { roomId: db.activeRoomId || '' });
  if (p === '/api/admin/active-room' && m === 'POST') {
    const b = await readBody(req);
    if (b.roomId && !db.rooms.some((r) => r.id === b.roomId)) return send(res, 404, { error: 'ไม่พบห้องนี้' });
    db.activeRoomId = b.roomId || '';
    saveDb();
    return send(res, 200, { ok: true, roomId: db.activeRoomId });
  }
  mm = p.match(/^\/api\/admin\/rooms\/([\w-]+)$/);
  if (mm && m === 'DELETE') {
    if (db.activeRoomId === mm[1]) db.activeRoomId = '';
    db.rooms = db.rooms.filter((r) => r.id !== mm[1]);
    saveDb();
    return send(res, 200, { ok: true });
  }

  if ((p === '/api/admin/attendance' || p === '/api/admin/attendance.csv') && m === 'GET') {
    const date = url.searchParams.get('date');
    const branch = url.searchParams.get('branch');
    const roomId = url.searchParams.get('room');
    const q = (url.searchParams.get('q') || '').toLowerCase();
    let list = db.attendance.filter((a) =>
      (!date || bkkDate(a.ts) === date) &&
      (!branch || a.branch === branch) &&
      (!roomId || a.roomId === roomId) &&
      (!q || a.name.toLowerCase().includes(q) || a.studentId.toLowerCase().includes(q))
    ).reverse();
    if (p.endsWith('.csv')) {
      const fmt = (ts) => new Date(ts).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
      const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
      const rows = [['วันเวลา', 'รหัส', 'ชื่อ', 'สาขา', 'ห้อง', 'ช่องทาง'].map(esc).join(',')];
      list.forEach((a) => rows.push([fmt(a.ts), a.studentId, a.name, a.branch, a.roomName, a.source].map(esc).join(',')));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="attendance.csv"' });
      return res.end('\ufeff' + rows.join('\r\n'));
    }
    return send(res, 200, list.slice(0, 2000));
  }
  if (p === '/api/admin/branches' && m === 'GET') {
    return send(res, 200, [...new Set(db.students.map((s) => s.branch))].sort());
  }
  mm = p.match(/^\/api\/admin\/attendance\/([\w-]+)$/);
  if (mm && m === 'DELETE') {
    db.attendance = db.attendance.filter((a) => a.id !== mm[1]);
    saveDb();
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not found' });
}

// ---------- ไฟล์หน้าเว็บ ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 400, { error: e.message });
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`เปิดใช้งานที่ http://localhost:${PORT}  (หลังบ้าน: /admin.html)`);
  if (ADMIN_PASSWORD === 'admin1234') console.log('⚠ กรุณาเปลี่ยนรหัสผ่านด้วย ADMIN_PASSWORD และ DEVICE_KEY');
});
