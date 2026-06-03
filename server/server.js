// server/server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());
app.use(express.static('../public')); // optional if serving public from server

const io = new Server(server, {
  cors: { origin: FRONTEND_ORIGIN }
});

// In-memory rooms (demo). Use Redis for production.
const rooms = {}; // roomId -> { id, players: {socketId: player}, maxPlayers, seed, started, timeLeft, interval }

// create room helper
function createRoom(maxPlayers = 9) {
  const id = uuidv4();
  rooms[id] = {
    id,
    players: {}, // socketId -> playerState
    maxPlayers,
    seed: Math.floor(Math.random() * 1e9),
    started: false,
    timeLeft: 0,
    interval: null
  };
  return rooms[id];
}

// physics update for a player (same logic as client)
function applyInputToPlayer(player, input) {
  const speed = 5;
  const dt = Math.min(0.1, input.dt || 0.05);
  player.vx = input.dx * speed;
  player.vz = input.dz * speed;
  player.vy = (player.vy || 0) - 9.8 * dt;
  if (input.jump && Math.abs(player.vy) < 0.1) {
    player.vy = 6;
  }
  player.x += player.vx * dt;
  player.y += player.vy * dt;
  player.z += player.vz * dt;
  if (player.y < 1) {
    player.y = 1;
    player.vy = 0;
  }
  if (!player.finished && player.y > 40) {
    player.finished = true;
  }
}

io.on('connection', socket => {
  console.log('socket connected', socket.id);

  // create room (optional from client)
  socket.on('createRoom', (cb) => {
    const room = createRoom(9);
    cb({ roomId: room.id, seed: room.seed });
  });

  // join room: payload { roomId, playerId, name }
  socket.on('joinRoom', (payload, cb) => {
    const { roomId, playerId, name } = payload;
    const room = rooms[roomId];
    if (!room) {
      cb({ ok: false, error: 'Room not found' });
      return;
    }
    if (Object.keys(room.players).length >= room.maxPlayers) {
      cb({ ok: false, error: 'Room full' });
      return;
    }
    // register player
    room.players[socket.id] = {
      socketId: socket.id,
      id: playerId,
      name: name || 'Player',
      x: 0, y: 5, z: 0,
      vx: 0, vy: 0, vz: 0,
      finished: false
    };
    socket.join(roomId);
    // notify others
    io.to(roomId).emit('playerJoined', { playerId, name });
    cb({ ok: true, seed: room.seed });
  });

  // client input: { roomId, playerId, input }
  socket.on('input', (payload) => {
    const { roomId, playerId, input } = payload;
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    // apply input server-side (authoritative-ish)
    applyInputToPlayer(player, input);
    // broadcast this player's update to room (lightweight)
    io.to(roomId).emit('playerUpdate', {
      playerId: player.id,
      x: player.x, y: player.y, z: player.z, finished: player.finished
    });
    // if finished, notify
    if (player.finished) {
      io.to(roomId).emit('playerFinish', { playerId: player.id });
    }
  });

  // start level (host triggers): payload { roomId, duration }
  socket.on('startLevel', (payload, cb) => {
    const { roomId, duration } = payload;
    const room = rooms[roomId];
    if (!room) {
      cb && cb({ ok: false, error: 'Room not found' });
      return;
    }
    if (room.started) {
      cb && cb({ ok: false, error: 'Already started' });
      return;
    }
    room.started = true;
    room.timeLeft = duration || 180;
    io.to(roomId).emit('levelStart', { seed: room.seed, duration: room.timeLeft });

    room.interval = setInterval(() => {
      room.timeLeft = Math.max(0, room.timeLeft - 0.3);
      const players = Object.values(room.players).map(p => ({
        id: p.id, x: p.x, y: p.y, z: p.z, finished: p.finished, name: p.name
      }));
      io.to(roomId).emit('stateUpdate', { players, timeLeft: Math.ceil(room.timeLeft) });
      if (room.timeLeft <= 0) {
        clearInterval(room.interval);
        room.started = false;
        io.to(roomId).emit('levelEnd', { players });
      }
    }, 300);

    cb && cb({ ok: true });
  });

  // leave / disconnect
  socket.on('disconnect', () => {
    // remove from any room
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (room.players[socket.id]) {
        const pid = room.players[socket.id].id;
        delete room.players[socket.id];
        io.to(roomId).emit('playerLeft', { playerId: pid });
        // if room empty, cleanup
        if (Object.keys(room.players).length === 0) {
          if (room.interval) clearInterval(room.interval);
          delete rooms[roomId];
        }
      }
    }
    console.log('socket disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
