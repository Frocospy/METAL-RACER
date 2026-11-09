const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 25000,
  pingTimeout: 20000
});

const rooms = new Map();
const PORT = process.env.PORT || 3000;
const FINISH = 1500; // длина гонки в метрах

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

function makeCode() {
  let code;
  do { code = String(Math.floor(10000 + Math.random() * 90000)); }
  while (rooms.has(code));
  return code;
}
function cleanName(n, def) {
  const s = String(n || "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 14);
  return s || def;
}
function cleanSkin(k) {
  k = Number(k);
  return Number.isInteger(k) && k >= 0 && k <= 15 ? k : 0;
}
// Профиль игрока: имя, машина, скин машины, скин персонажа
function readProf(prof, def) {
  return {
    name: cleanName(prof && prof.name, def),
    skin: cleanSkin(prof && prof.skin),
    car: prof && Number(prof.car) === 1 ? 1 : 0,
    cs: prof && Number(prof.cs) === 1 ? 1 : 0,
    ready: false
  };
}
function roomInfo(code) {
  const room = rooms.get(code);
  if (!room) return null;
  return {
    code,
    inRace: !!(room.race && room.race.active),
    players: [...room.players].map(([id, p]) => ({
      id, name: p.name, skin: p.skin, car: p.car, cs: p.cs, ready: p.ready, host: id === room.host
    }))
  };
}
function updateRoom(code) {
  const info = roomInfo(code);
  if (info) io.to(code).emit("roomUpdate", info);
}
function otherOf(room, id) {
  return Object.entries(room.race.players).find(([pid]) => pid !== id);
}
function clearReady(room) {
  for (const p of room.players.values()) p.ready = false;
}
function startRace(code) {
  const room = rooms.get(code);
  if (!room || room.players.size < 2 || (room.race && room.race.active)) return;
  room.race = { active: true, players: {} };
  for (const id of room.players.keys()) room.race.players[id] = { dist: 0, crashed: false };
  clearReady(room);
  updateRoom(code);
  // один seed на двоих — у обоих игроков одинаковый трафик, монеты и лужи
  io.to(code).emit("gameStarted", { seed: Math.floor(Math.random() * 2147483647), finish: FINISH });
}
function endRace(code, winner, reason) {
  const room = rooms.get(code);
  if (!room || !room.race || !room.race.active) return;
  room.race.active = false;
  const dists = {};
  for (const [id, r] of Object.entries(room.race.players)) dists[id] = Math.round(r.dist);
  clearReady(room);
  io.to(code).emit("raceEnd", { winner: winner || null, reason, dists, finish: FINISH });
  updateRoom(code);
}
function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  socket.data.roomCode = null;
  if (!room) return;
  const hadRace = room.race && room.race.active;
  room.players.delete(socket.id);
  if (room.players.size === 0) {
    rooms.delete(code);
  } else {
    if (room.host === socket.id) room.host = room.players.keys().next().value;
    clearReady(room);
    updateRoom(code);
    io.to(code).emit("playerLeft");
    if (hadRace) endRace(code, room.players.keys().next().value, "left");
  }
}
io.on("connection", socket => {
  socket.data.roomCode = null;

  socket.on("createRoom", prof => {
    leaveRoom(socket);
    const code = makeCode();
    const room = { host: socket.id, players: new Map([[socket.id, readProf(prof, "Игрок 1")]]), race: null };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("roomCreated", roomInfo(code));
    updateRoom(code);
  });

  socket.on("joinRoom", (rawCode, prof) => {
    const code = String(rawCode || "").replace(/\D/g, "").slice(0, 5);
    const room = rooms.get(code);
    if (!room) return socket.emit("roomError", "Комната с таким кодом не найдена.");
    if (room.players.size >= 2) return socket.emit("roomError", "Комната уже заполнена (максимум 2 игрока).");
    leaveRoom(socket);
    room.players.set(socket.id, readProf(prof, "Игрок 2"));
    clearReady(room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("roomJoined", roomInfo(code));
    updateRoom(code);
  });

  // Обновить профиль (скины), пока сидишь в лобби
  socket.on("profile", prof => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || (room.race && room.race.active)) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const n = readProf(prof, p.name);
    Object.assign(p, { name: n.name, skin: n.skin, car: n.car, cs: n.cs });
    updateRoom(socket.data.roomCode);
  });

  // Оба игрока нажали «Готов» — гонка стартует сама
  socket.on("setReady", v => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || (room.race && room.race.active)) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.ready = !!v && room.players.size >= 2;
    updateRoom(code);
    if (room.players.size === 2 && [...room.players.values()].every(x => x.ready)) startRace(code);
  });

  // Старый способ (для совместимости): хозяин жмёт «Начать»
  socket.on("startGame", () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    if (room.players.size < 2) return socket.emit("roomError", "Нужны два игрока, чтобы начать гонку.");
    startRace(code);
  });

  socket.on("playerState", state => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!code || !room || !state) return;
    const clean = {
      id: socket.id,
      x: Number.isFinite(state.x) ? Math.max(-5.2, Math.min(5.2, state.x)) : 0,
      speed: Number.isFinite(state.speed) ? Math.max(0, Math.min(250, state.speed)) : 0,
      dist: Number.isFinite(state.dist) ? Math.max(0, state.dist) : 0,
      steer: Number.isFinite(state.steer) ? Math.max(-1, Math.min(1, state.steer)) : 0,
      c: cleanSkin(state.c),
      k: state.k === 1 ? 1 : 0
    };
    socket.to(code).emit("playerState", clean);
    const r = room.race;
    if (r && r.active) {
      const me = r.players[socket.id];
      if (!me || me.crashed) return;
      me.dist = clean.dist;
      if (me.dist >= FINISH) return endRace(code, socket.id, "finish");
      const o = otherOf(room, socket.id);
      if (o && o[1].crashed && me.dist > o[1].dist) endRace(code, socket.id, "farther");
    }
  });

  socket.on("playerCrashed", d => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || !room.race || !room.race.active) return;
    const me = room.race.players[socket.id];
    if (!me || me.crashed) return;
    me.crashed = true;
    if (d && Number.isFinite(d.dist)) me.dist = Math.max(me.dist, Math.min(d.dist, FINISH));
    socket.to(code).emit("playerCrashed", { id: socket.id });
    const o = otherOf(room, socket.id);
    if (!o) return;
    if (o[1].crashed) {
      endRace(code, me.dist > o[1].dist ? socket.id : (o[1].dist > me.dist ? o[0] : null), "farther");
    } else if (o[1].dist > me.dist) {
      endRace(code, o[0], "farther");
    }
  });

  socket.on("leaveRoom", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`METAL RACER server listening on ${PORT}`);
});
