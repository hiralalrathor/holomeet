// HoloMeet signalling + state server: Express, Socket.IO, optional Redis (TTL room state)
const express = require('express'), http = require('http'), { Server } = require('socket.io');
const app = express(); app.use(express.static(__dirname + '/public'));
const srv = http.createServer(app), io = new Server(srv);
let redis = null;
if (process.env.REDIS_URL) { try { redis = new (require('ioredis'))(process.env.REDIS_URL); } catch (e) { console.log('Redis unavailable, using memory'); } }
const mem = new Map(), byId = new Map(), TTL = 6 * 3600, key = r => 'holo:board:' + r;
const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
if (process.env.TURN_URL) iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER, credential: process.env.TURN_PASS });
async function getBoard(r) { return redis ? (await redis.lrange(key(r), 0, -1)).map(x => JSON.parse(x)) : (mem.get(r) || []); }
async function addStroke(r, s) {
  if (redis) { await redis.rpush(key(r), JSON.stringify(s)); await redis.expire(key(r), TTL); }
  else { if (!mem.has(r)) mem.set(r, []); const a = mem.get(r); a.push(s); if (a.length > 20000) a.shift(); }
}
const wipe = r => redis ? redis.del(key(r)) : mem.delete(r);
io.on('connection', sock => {
  sock.on('join', async ({ room, id }) => {
    room = String(room).slice(0, 20); id = String(id).slice(0, 12);
    sock.data = { room, id }; sock.join(room); byId.set(id, sock);
    sock.emit('cfg', iceServers); sock.emit('board', await getBoard(room));
  });
  sock.on('m', m => {
    const { room } = sock.data || {}; if (!room || typeof m !== 'object') return;
    m.id = sock.data.id; sock.to(room).emit('m', m);
    if (m.t === 'draw') addStroke(room, { a: m.a, b: m.b }); else if (m.t === 'clear') wipe(room);
  });
  sock.on('sig', ({ to, data }) => { const t = byId.get(to); if (t) t.emit('sig', { from: sock.data.id, data }); });
  sock.on('disconnect', () => {
    const { room, id } = sock.data || {}; if (!room) return;
    byId.delete(id); sock.to(room).emit('m', { t: 'bye', id });
    if (!io.sockets.adapter.rooms.get(room)) wipe(room); // last user left: destroy all room data
  });
});
srv.listen(process.env.PORT || 3000, () => console.log('HoloMeet on http://localhost:' + (process.env.PORT || 3000)));
