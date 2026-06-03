// public/game.js
// BEFORE RUN: set SERVER_URL to your server (e.g., http://localhost:5000)
const SERVER_URL = window.SERVER_URL || 'http://localhost:5000';

let socket;
let scene, camera, renderer, clock;
let localPlayerId = generateId();
let localPlayer = { id: localPlayerId, x:0, y:5, z:0, vx:0, vy:0, vz:0 };
const otherPlayers = {}; // id -> {mesh, target, name}
let roomId = null;
let seed = null;
let timeLeft = 0;
let keys = { w:0, a:0, s:0, d:0, space:0 };

function connectSocket() {
  if (socket && socket.connected) return;
  socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    console.log('connected to server', socket.id);
  });

  socket.on('playerJoined', data => {
    addPlayerMesh(data.playerId, data.name);
    refreshPlayersUI();
  });

  socket.on('playerLeft', data => {
    removePlayerMesh(data.playerId);
    refreshPlayersUI();
  });

  socket.on('levelStart', data => {
    seed = data.seed;
    timeLeft = data.duration;
    clearScenePlatforms();
    generateTower();
    document.getElementById('timer').textContent = formatTime(timeLeft);
  });

  socket.on('stateUpdate', data => {
    timeLeft = data.timeLeft;
    document.getElementById('timer').textContent = formatTime(timeLeft);
    data.players.forEach(p => {
      if (p.id === localPlayerId) return;
      if (!otherPlayers[p.id]) addPlayerMesh(p.id, p.name || 'Player');
      otherPlayers[p.id].target = { x:p.x, y:p.y, z:p.z, finished:p.finished };
    });
    refreshPlayersUI();
  });

  socket.on('playerUpdate', data => {
    if (data.playerId === localPlayerId) return;
    if (!otherPlayers[data.playerId]) addPlayerMesh(data.playerId, 'Player');
    otherPlayers[data.playerId].target = { x:data.x, y:data.y, z:data.z, finished:data.finished };
  });

  socket.on('playerFinish', data => {
    const id = data.playerId;
    if (otherPlayers[id]) otherPlayers[id].mesh.material.color.set(0xffff00);
  });

  socket.on('levelEnd', data => {
    alert('Level ended');
  });
}

// Three.js init
function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 1000);
  renderer = new THREE.WebGLRenderer({ antialias:true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.getElementById('game').appendChild(renderer.domElement);
  clock = new THREE.Clock();

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
  scene.add(hemi);

  const groundGeo = new THREE.BoxGeometry(200, 1, 200);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x2d2d2d });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.y = -0.5;
  scene.add(ground);

  generateTower();

  const boxGeo = new THREE.BoxGeometry(1,2,1);
  const boxMat = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
  const mesh = new THREE.Mesh(boxGeo, boxMat);
  mesh.position.set(localPlayer.x, localPlayer.y, localPlayer.z);
  mesh.name = 'local';
  scene.add(mesh);
  localPlayer.mesh = mesh;

  camera.position.set(0,5,10);
  camera.lookAt(mesh.position);
  window.addEventListener('resize', onResize);
  animate();
}

function generateTower() {
  const s = seed || Math.floor(Math.random()*1e9);
  const rng = mulberry32(s);
  for (let i=0;i<60;i++) {
    const w = 6 + Math.floor(rng()*6);
    const depth = 2;
    const x = (rng()*40)-20;
    const y = 1 + i*0.7 + Math.floor(rng()*3);
    const z = (rng()*40)-20;
    const geo = new THREE.BoxGeometry(w, 0.4, depth);
    const mat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b });
    const p = new THREE.Mesh(geo, mat);
    p.position.set(x,y,z);
    scene.add(p);
  }
}

function mulberry32(a) {
  return function() {
    var t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

function onResize() {
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  updateLocalPhysics(dt);
  updateCamera();
  renderer.render(scene, camera);
}

function updateLocalPhysics(dt) {
  const speed = 6;
  const dx = (keys.d - keys.a);
  const dz = (keys.s - keys.w);
  localPlayer.vx = dx * speed;
  localPlayer.vz = dz * speed;
  localPlayer.vy = (localPlayer.vy || 0) - 9.8 * dt;
  if (keys.space && Math.abs(localPlayer.vy) < 0.1) {
    localPlayer.vy = 6;
  }
  localPlayer.x += localPlayer.vx * dt;
  localPlayer.y += localPlayer.vy * dt;
  localPlayer.z += localPlayer.vz * dt;
  if (localPlayer.y < 1) { localPlayer.y = 1; localPlayer.vy = 0; }
  localPlayer.mesh.position.set(localPlayer.x, localPlayer.y, localPlayer.z);

  if (roomId) sendInput({ dx, dz, jump: keys.space?1:0, dt });
}

let lastInputSent = 0;
function sendInput(input) {
  const now = performance.now();
  if (now - lastInputSent < 80) return;
  lastInputSent = now;
  socket.emit('input', { roomId, playerId: localPlayerId, input });
}

function updateCamera() {
  const target = localPlayer.mesh.position;
  const desired = new THREE.Vector3(target.x, target.y + 4, target.z + 8);
  camera.position.lerp(desired, 0.12);
  camera.lookAt(target.x, target.y + 1, target.z);
}

function generateId() {
  return 'p-' + Math.random().toString(36).slice(2,9);
}

function addPlayerMesh(id, name) {
  if (id === localPlayerId) return;
  if (otherPlayers[id]) return;
  const geo = new THREE.BoxGeometry(1,2,1);
  const mat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(0,1,0);
  scene.add(m);
  otherPlayers[id] = { id, name, mesh: m, target: {x:0,y:1,z:0} };
}

function removePlayerMesh(id) {
  const p = otherPlayers[id];
  if (!p) return;
  scene.remove(p.mesh);
  delete otherPlayers[id];
}

function clearScenePlatforms() {
  const toRemove = [];
  scene.traverse(obj => {
    if (obj.isMesh && obj.name !== 'local' && obj.geometry && obj.material) {
      if (obj.position.y > 0.1) toRemove.push(obj);
    }
  });
  toRemove.forEach(o => scene.remove(o));
}

function refreshPlayersUI() {
  const el = document.getElementById('players');
  el.innerHTML = '';
  const local = document.createElement('div');
  local.textContent = `You: ${localPlayerId} (${(document.getElementById('name')||{}).value || 'Player'})`;
  el.appendChild(local);
  Object.values(otherPlayers).forEach(p => {
    const d = document.createElement('div');
    d.textContent = `${p.name} (${p.id.slice(0,6)})`;
    el.appendChild(d);
  });
}

// interpolation for other players
setInterval(() => {
  Object.values(otherPlayers).forEach(p => {
    if (!p.target) return;
    p.mesh.position.lerp(new THREE.Vector3(p.target.x, p.target.y, p.target.z), 0.2);
  });
}, 50);

// input handling
window.addEventListener('keydown', e => {
  if (e.key === 'w') keys.w = 1;
  if (e.key === 's') keys.s = 1;
  if (e.key === 'a') keys.a = 1;
  if (e.key === 'd') keys.d = 1;
  if (e.code === 'Space') keys.space = 1;
});
window.addEventListener('keyup', e => {
  if (e.key === 'w') keys.w = 0;
  if (e.key === 's') keys.s = 0;
  if (e.key === 'a') keys.a = 0;
  if (e.key === 'd') keys.d = 0;
  if (e.code === 'Space') keys.space = 0;
});

// UI buttons
document.getElementById('create').addEventListener('click', async () => {
  connectSocket();
  socket.emit('createRoom', (res) => {
    roomId = res.roomId;
    seed = res.seed;
    document.getElementById('roomId').value = roomId;
    // auto-join
    const name = document.getElementById('name').value || 'Host';
    socket.emit('joinRoom', { roomId, playerId: localPlayerId, name }, (r) => {
      if (!r.ok) return alert(r.error || 'Join failed');
      addPlayerMesh(localPlayerId, name);
      refreshPlayersUI();
    });
  });
});

document.getElementById('join').addEventListener('click', async () => {
  connectSocket();
  roomId = document.getElementById('roomId').value.trim();
  if (!roomId) return alert('Enter room id');
  const name = document.getElementById('name').value || 'Player';
  socket.emit('joinRoom', { roomId, playerId: localPlayerId, name }, (r) => {
    if (!r.ok) return alert(r.error || 'Join failed');
    seed = r.seed;
    addPlayerMesh(localPlayerId, name);
    refreshPlayersUI();
  });
});

document.getElementById('start').addEventListener('click', async () => {
  if (!roomId) return alert('No room');
  socket.emit('startLevel', { roomId, duration: 180 }, (r) => {
    if (!r.ok) alert(r.error || 'Start failed');
  });
});

function formatTime(sec) {
  if (sec === undefined || sec === null) return '--:--';
  const m = Math.floor(sec/60).toString().padStart(2,'0');
  const s = Math.floor(sec%60).toString().padStart(2,'0');
  return `${m}:${s}`;
}

(function main(){
  initThree();
  // socket will connect on first create/join
})();
