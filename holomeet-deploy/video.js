// Accounts (signup / login / guest), meeting codes and video-call signalling
const crypto = require('crypto'), fs = require('fs'), path = require('path'), express = require('express');
module.exports = (app, io, iceServers, redis) => {
  app.use(express.json({ limit: '10kb' }));
  const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
  const mac = b => crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  const sign = p => { const b = Buffer.from(JSON.stringify(p)).toString('base64url'); return b + '.' + mac(b); };
  const verify = t => { try { const [b, s] = String(t).split('.'); const e = mac(b);
    if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url')); return p.exp > Date.now() ? p : null; } catch (e) { return null; } };
  const FILE = path.join(__dirname, 'data', 'users.json'); let users = {};
  if (!redis) { try { users = JSON.parse(fs.readFileSync(FILE)); } catch (e) {} }
  const getU = async e => redis ? JSON.parse((await redis.hget('holo:users', e)) || 'null') : users[e] || null;
  const putU = async u => { if (redis) return redis.hset('holo:users', u.email, JSON.stringify(u)); users[u.email] = u;
    try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(users)); } catch (e) {} };
  const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
  const issue = (name, type, uid) => { const exp = Date.now() + 7 * 864e5; return { token: sign({ uid, name, type, exp }), user: { name, type, exp } }; };
  const clean = s => String(s || '').replace(/[<>]/g, '').trim().slice(0, 30);
  const h = f => (q, s) => f(q, s).catch(() => s.status(500).json({ error: 'Server error' }));
  app.post('/api/signup', h(async (q, s) => {
    const name = clean(q.body.name), email = String(q.body.email || '').toLowerCase().trim(), pw = String(q.body.password || '');
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || pw.length < 6) return s.status(400).json({ error: 'Enter a name, a valid email and a password of at least 6 characters.' });
    if (await getU(email)) return s.status(409).json({ error: 'An account with this email already exists.' });
    const salt = crypto.randomBytes(16).toString('hex'); await putU({ email, name, salt, hash: hash(pw, salt) });
    s.json(issue(name, 'user', email));
  }));
  app.post('/api/login', h(async (q, s) => {
    const email = String(q.body.email || '').toLowerCase().trim(), pw = String(q.body.password || ''), u = await getU(email);
    if (!u || !crypto.timingSafeEqual(Buffer.from(hash(pw, u.salt)), Buffer.from(u.hash))) return s.status(401).json({ error: 'Wrong email or password.' });
    s.json(issue(u.name, 'user', email));
  }));
  app.post('/api/guest', h(async (q, s) => s.json(issue(clean(q.body.name) || 'Guest', 'guest', 'g' + crypto.randomBytes(4).toString('hex')))));
  app.post('/api/rooms', (q, s) => {
    if (!verify((q.headers.authorization || '').slice(7))) return s.status(401).json({ error: 'Please sign in first.' });
    const L = 'abcdefghijkmnpqrstuvwxyz', r = n => Array.from({ length: n }, () => L[crypto.randomInt(L.length)]).join('');
    s.json({ code: r(3) + '-' + r(4) + '-' + r(3) });
  });
  const hosts = new Map();
  io.on('connection', sock => {
    const isHost = () => hosts.get(sock.data.vroom) === sock.id;
    sock.on('vjoin', ({ token, code } = {}) => {
      const u = verify(token); if (!u || !/^[a-z0-9-]{3,24}$/.test(String(code))) return sock.emit('verr', 'Please sign in again.');
      const r = 'v:' + code, others = [...(io.sockets.adapter.rooms.get(r) || [])].map(id => ({ sid: id, name: io.sockets.sockets.get(id).data.vname }));
      if (others.length >= 8) return sock.emit('verr', 'This meeting is full (8 people max).');
      sock.data.vroom = r; sock.data.vname = u.name; sock.join(r);
      if (!others.length) hosts.set(r, sock.id);
      sock.emit('vready', { sid: sock.id, peers: others, ice: iceServers, host: hosts.get(r) }); sock.to(r).emit('vjoined', { sid: sock.id, name: u.name });
    });
    sock.on('vsig', ({ to, data }) => io.to(to).emit('vsig', { from: sock.id, data }));
    sock.on('vchat', t => sock.data.vroom && sock.to(sock.data.vroom).emit('vchat', { from: sock.data.vname, text: String(t).slice(0, 500) }));
    sock.on('vstate', st => sock.data.vroom && sock.to(sock.data.vroom).emit('vstate', { sid: sock.id, mic: !!st.mic, cam: !!st.cam, hand: !!st.hand }));
    sock.on('vreact', e => { if (sock.data.vroom && ['👍','👏','❤️','😂','🎉','😮'].includes(e)) sock.to(sock.data.vroom).emit('vreact', { sid: sock.id, e }); });
    sock.on('vcap', t => sock.data.vroom && sock.to(sock.data.vroom).emit('vcap', { from: sock.data.vname, text: String(t).slice(0, 300) }));
    sock.on('vmuteall', () => { if (isHost()) sock.to(sock.data.vroom).emit('vmute'); });
    sock.on('vkick', to => { const t = io.sockets.sockets.get(String(to)); if (isHost() && t && t.data.vroom === sock.data.vroom) t.emit('vkicked'); });
    sock.on('disconnect', () => {
      const r = sock.data.vroom; if (!r) return; sock.to(r).emit('vleft', sock.id);
      if (hosts.get(r) === sock.id) { const rest = [...(io.sockets.adapter.rooms.get(r) || [])];
        if (rest.length) { hosts.set(r, rest[0]); io.to(r).emit('vhost', rest[0]); } else hosts.delete(r); }
    });
  });
};
