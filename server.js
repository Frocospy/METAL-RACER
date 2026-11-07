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

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

function makeCode() {
  let code;
  do { code = String(Math.floor(10000 + Math.random() * 90000)); }
  while (rooms.has(code));
  return code;
}
function roomInfo(code) {
  const room = rooms.get(code);
  if (!room) return null;
  return {
    code,
    players: [...room.players].map(([id, p]) => ({
      id, name: p.name, host: id === room.host
    }))
  };
}
function updateRoom(code) {
  const info = roomInfo(code);
  if (info) io.to(code).emit("roomUpdate", info);
}
function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  socket.data.roomCode = null;
  if (!room) return;
  room.players.delete(socket.id);
  if (room.players.size === 0) {
    rooms.delete(code);
  } else {
    if (room.host === socket.id) room.host = room.players.keys().next().value;
    updateRoom(code);
    io.to(code).emit("playerLeft");
  }
}
io.on("connection", socket => {
  socket.data.roomCode = null;

  socket.on("createRoom", () => {
    leaveRoom(socket);
    const code = makeCode();
    const room = { host: socket.id, players: new Map([[socket.id, { name: "Игрок 1" }]]) };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("roomCreated", roomInfo(code));
    updateRoom(code);
  });

  socket.on("joinRoom", rawCode => {
    const code = String(rawCode || "").replace(/\D/g, "").slice(0, 5);
    const room = rooms.get(code);
    if (!room) return socket.emit("roomError", "Комната с таким кодом не найдена.");
    if (room.players.size >= 2) return socket.emit("roomError", "Комната уже заполнена (максимум 2 игрока).");
    leaveRoom(socket);
    room.players.set(socket.id, { name: "Игрок 2" });
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
    io.to(code).emit("gameStarted");
  });

  socket.on("playerState", state => {
    const code = socket.data.roomCode;
    if (!code || !rooms.has(code) || !state) return;
    const clean = {
      id: socket.id,
      x: Number.isFinite(state.x) ? Math.max(-5.2, Math.min(5.2, state.x)) : 0,
      speed: Number.isFinite(state.speed) ? Math.max(0, Math.min(250, state.speed)) : 0,
      dist: Number.isFinite(state.dist) ? Math.max(0, state.dist) : 0,
      steer: Number.isFinite(state.steer) ? Math.max(-1, Math.min(1, state.steer)) : 0
    };
    socket.to(code).emit("playerState", clean);
  });

  socket.on("leaveRoom", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`METAL RACER server listening on ${PORT}`);
});
