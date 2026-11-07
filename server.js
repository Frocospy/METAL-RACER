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
  return Number.isInteger(k) && k >= 0 && k <= 5 ? k : 0;
}
function roomInfo(code) {
  const room = rooms.get(code);
  if (!room) return null;
  return {
    code,
    players: [...room.players].map(([id, p]) => ({
      id, name: p.name, skin: p.skin, host: id === room.host
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
function endRace(code, winner, reason) {
  const room = rooms.get(code);
  if (!room || !room.race || !room.race.active) return;
  room.race.active = false;
  const dists = {};
  for (const [id, r] of Object.entries(room.race.players)) dists[id] = Math.round(r.dist);
  io.to(code).emit("raceEnd", { winner: winner || null, reason, dists, finish: FINISH });
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
    const p = { name: cleanName(prof && prof.name, "Игрок 1"), skin: cleanSkin(prof && prof.skin) };
    const room = { host: socket.id, players: new Map([[socket.id, p]]), race: null };
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
    room.players.set(socket.id, { name: cleanName(prof && prof.name, "Игрок 2"), skin: cleanSkin(prof && prof.skin) });
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("roomJoined", roomInfo(code));
    updateRoom(code);
  });

  socket.on("startGame", () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    if (room.players.size < 2) return socket.emit("roomError", "Нужны два игрока, чтобы начать гонку.");
    room.race = { active: true, players: {} };
    for (const id of room.players.keys()) room.race.players[id] = { dist: 0, crashed: false };
    // один seed на двоих — у обоих игроков одинаковый трафик на трассе
    io.to(code).emit("gameStarted", { seed: Math.floor(Math.random() * 2147483647), finish: FINISH });
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
      c: cleanSkin(state.c)
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
