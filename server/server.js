// server/server.js
require('dotenv').config();
const express = require('express');
const Pusher = require('pusher');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();

// CORS: allow frontend origin if provided, else allow all (dev)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(bodyParser.json());

// Initialize Pusher
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true
});

// In-memory rooms (demo). For production use Redis or DB.
const rooms = {}; // roomId -> { id, players: {playerId: {...}}, maxPlayers, seed, started, timeLeft, interval }

function createRoom(maxPlayers = 9) {
  const id = uuidv4();
  rooms[id] = {
    id,
    players: {},
    maxPlayers,
    seed: Math.floor(Math.random() * 1e9),
    started: false,
    timeLeft: 0,
    interval: null
  };
  return rooms[id];
}

// Create a new room
app.post('/create-room', (req, res) => {
  const room = createRoom(9);
  res.json({ roomId: room.id, seed: room.seed });
});

// Join room (server-side registration). Client should also subscribe to presence channel.
app.post('/join-room', (req, res) => {
  const { roomId, playerId, name } = req.body;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (Object.keys(room.players).length >= room.maxPlayers) {
    return res.status(400).json({ error: 'Room full' });
  }
  room.players[playerId] = {
    id: playerId,
    name: name || 'Player',
    x: 0, y: 5, z: 0,
    vx: 0, vy: 0, vz: 0,
    finished: false
  };
  // optional server-side event to presence channel
  pusher.trigger(`presence-room-${roomId}`, 'server:player-registered', { playerId, name });
  res.json({ ok: true, seed: room.seed });
});

// Start level (host triggers). duration in seconds (default 180)
app.post('/start-level', (req, res) => {
  const { roomId, duration } = req.body;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.started) return res.status(400).json({ error: 'Already started' });
  room.started = true;
  room.timeLeft = duration || 180;
  pusher.trigger(`presence-room-${roomId}`, 'levelStart', { seed: room.seed, duration: room.timeLeft });

  // server tick: broadcast minimal authoritative state every 300ms
  room.interval = setInterval(() => {
    room.timeLeft = Math.max(0, room.timeLeft - 0.3);
    const players = Object.values(room.players).map(p => ({
      id: p.id, x: p.x, y: p.y, z: p.z, finished: p.finished, name: p.name
    }));
    pusher.trigger(`presence-room-${roomId}`, 'stateUpdate', { players, timeLeft: Math.ceil(room.timeLeft) });
    if (room.timeLeft <= 0) {
      clearInterval(room.interval);
      room.started = false;
      pusher.trigger(`presence-room-${roomId}`, 'levelEnd', { players });
    }
  }, 300);

  res.json({ ok: true });
});

// Input endpoint: clients send input; server applies simple physics and broadcasts playerUpdate
app.post('/input', (req, res) => {
  const { roomId, playerId, input } = req.body;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const player = room.players[playerId];
  if (!player) return res.status(404).json({ error: 'Player not in room' });

  // Simple physics integration (demo)
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
    pusher.trigger(`presence-room-${roomId}`, 'playerFinish', { playerId });
  }

  pusher.trigger(`presence-room-${roomId}`, 'playerUpdate', {
    playerId,
    x: player.x, y: player.y, z: player.z, finished: player.finished
  });

  res.json({ ok: true });
});

// Debug: get room state
app.get('/room/:roomId', (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ room });
});

/*
  Pusher auth endpoint for private/presence channels.
  Client will POST { socket_id, channel_name, playerId, name } to this endpoint.
  IMPORTANT: In production, validate the caller (session/JWT) before authenticating.
*/
app.post('/pusher/auth', (req, res) => {
  const socketId = req.body.socket_id;
  const channel = req.body.channel_name;
  const userId = req.body.playerId || ('anon-' + Math.random().toString(36).slice(2,8));
  const userInfo = { name: req.body.name || 'Player' };

  if (!socketId || !channel) return res.status(400).send('Missing socket_id or channel_name');

  if (channel.startsWith('presence-')) {
    const auth = pusher.authenticate(socketId, channel, {
      user_id: userId,
      user_info: userInfo
    });
    res.send(auth);
    return;
  }

  const auth = pusher.authenticate(socketId, channel);
  res.send(auth);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
