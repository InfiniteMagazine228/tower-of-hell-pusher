/**
 * Tower of Hell Offline Enhanced
 * - Single player + local bots
 * - Improved bot AI using platform graph and greedy path selection
 * - Moving platforms and spikes obstacles
 * - Local leaderboard stored in localStorage
 *
 * Open public/index.html in browser or serve static folder
 */

/* CONFIG */
const LEVEL_DURATION = 180; // seconds
const MAX_PLATFORMS = 90;
const BOT_THINK_INTERVAL = 0.12;
const MOVING_PLATFORM_COUNT = 8;
const SPIKE_COUNT = 12;

/* GLOBALS */
let scene, camera, renderer, clock;
let localPlayerId = generateId();
let players = {}; // id -> player
let localPlayer = createPlayer(localPlayerId, true, false, 'You');
players[localPlayerId] = localPlayer;
let seed = Math.floor(Math.random()*1e9);
let levelTimer = LEVEL_DURATION;
let levelRunning = false;
let platformGroup, movingGroup, spikeGroup;
let uiPlayersEl = document.getElementById('players');
let leaderListEl = document.getElementById('leaderList');
let difficulty = 'normal';

/* THREE INIT */
function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1220);
  camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 1000);
  renderer = new THREE.WebGLRenderer({ antialias:true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.getElementById('game').appendChild(renderer.domElement);
  clock = new THREE.Clock();

  const hemi = new THREE.HemisphereLight(0xffffff, 0x222244, 1.0);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(5,10,7);
  scene.add(dir);

  const groundGeo = new THREE.BoxGeometry(300, 1, 300);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x101218 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.y = -0.5;
  scene.add(ground);

  platformGroup = new THREE.Group();
  movingGroup = new THREE.Group();
  spikeGroup = new THREE.Group();
  scene.add(platformGroup, movingGroup, spikeGroup);

  // local player mesh
  const boxGeo = new THREE.BoxGeometry(1,2,1);
  const boxMat = new THREE.MeshStandardMaterial({ color: 0x00ff88 });
  const mesh = new THREE.Mesh(boxGeo, boxMat);
  mesh.position.set(localPlayer.x, localPlayer.y, localPlayer.z);
  mesh.name = 'local';
  scene.add(mesh);
  localPlayer.mesh = mesh;

  camera.position.set(0,8,18);
  camera.lookAt(mesh.position);
  window.addEventListener('resize', onResize);
  animate();
}

/* PLAYER FACTORY */
function createPlayer(id, isLocal=false, isBot=false, name='Player') {
  return {
    id, name, isLocal, isBot,
    x: (Math.random()-0.5)*6, y: 1, z: (Math.random()-0.5)*6,
    vx:0, vy:0, vz:0,
    finished:false, finishTime:null,
    mesh:null,
    botState: { path: [], lastThink: 0, targetPlatform: null }
  };
}

/* RNG */
function mulberry32(a) {
  return function() {
    var t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

/* MAP GENERATION */
let platformNodes = []; // nodes for pathfinding
function generateTower() {
  // clear
  [platformGroup, movingGroup, spikeGroup].forEach(g => {
    while (g.children.length) g.remove(g.children[0]);
  });
  platformNodes = [];

  const rng = mulberry32(seed);
  for (let i=0;i<MAX_PLATFORMS;i++) {
    const w = 4 + Math.floor(rng()*8);
    const depth = 2 + Math.floor(rng()*3);
    const x = (rng()*120)-60;
    const y = 1 + i*0.9 + Math.floor(rng()*2);
    const z = (rng()*120)-60;
    const geo = new THREE.BoxGeometry(w, 0.4, depth);
    const mat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b });
    const p = new THREE.Mesh(geo, mat);
    p.position.set(x,y,z);
    p.userData = { w, depth, id: i, topY: y + 0.2, moving:false };
    platformGroup.add(p);
    platformNodes.push({ id:i, x, y: p.userData.topY, z, mesh:p });
  }

  // moving platforms
  for (let i=0;i<MOVING_PLATFORM_COUNT;i++) {
    const base = platformGroup.children[Math.floor(rng()*platformGroup.children.length)];
    const geo = new THREE.BoxGeometry(4, 0.4, 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4b6bff });
    const p = new THREE.Mesh(geo, mat);
    p.position.copy(base.position).add(new THREE.Vector3(0, 2 + rng()*6, 0));
    p.userData = { w:4, depth:2, id: 'm'+i, topY: p.position.y + 0.2, moving:true, axis: rng() < 0.5 ? 'x' : 'z', range: 6 + rng()*8, speed: 0.6 + rng()*0.8, phase: rng()*Math.PI*2 };
    movingGroup.add(p);
    platformNodes.push({ id:'m'+i, x:p.position.x, y:p.userData.topY, z:p.position.z, mesh:p, moving:true });
  }

  // spikes obstacles
  for (let i=0;i<SPIKE_COUNT;i++) {
    const px = (rng()*120)-60;
    const pz = (rng()*120)-60;
    const py = 0.2 + Math.floor(rng()*2);
    const geo = new THREE.ConeGeometry(0.6, 1.2, 6);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff4444 });
    const s = new THREE.Mesh(geo, mat);
    s.position.set(px, py, pz);
    s.rotation.x = Math.PI;
    spikeGroup.add(s);
  }

  // build adjacency for pathfinding (simple radius-based)
  buildAdjacency();
}

/* ADJACENCY */
let adjacency = {};
function buildAdjacency() {
  adjacency = {};
  const nodes = platformNodes;
  for (let a of nodes) {
    adjacency[a.id] = [];
    for (let b of nodes) {
      if (a.id === b.id) continue;
      const dy = b.y - a.y;
      if (dy < -6) continue; // too far below
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const dist = Math.hypot(dx, dz);
      // allow jump up to 3.5 units, horizontal reach limit depends on dist
      if (dy <= 3.5 && dist < 20 + Math.abs(dy)*4) {
        adjacency[a.id].push({ id: b.id, cost: dist + Math.max(0, dy)*2 });
      }
    }
  }
}

/* SIMPLE A STAR */
function findPath(fromId, toId) {
  // nodes map
  const nodes = {};
  for (let n of platformNodes) nodes[n.id] = n;
  if (!nodes[fromId] || !nodes[toId]) return [];

  const open = new TinyPriorityQueue();
  const cameFrom = {};
  const gScore = {};
  const fScore = {};
  for (let id in adjacency) { gScore[id] = Infinity; fScore[id] = Infinity; }
  gScore[fromId] = 0;
  fScore[fromId] = heuristic(nodes[fromId], nodes[toId]);
  open.push({ id: fromId, f: fScore[fromId] });

  while (open.size()) {
    const current = open.pop().id;
    if (current === toId) return reconstructPath(cameFrom, current);
    for (let nb of adjacency[current] || []) {
      const tentative = gScore[current] + nb.cost;
      if (tentative < gScore[nb.id]) {
        cameFrom[nb.id] = current;
        gScore[nb.id] = tentative;
        fScore[nb.id] = tentative + heuristic(nodes[nb.id], nodes[toId]);
        open.push({ id: nb.id, f: fScore[nb.id] });
      }
    }
  }
  return [];
}
function heuristic(a,b) { return Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z); }
function reconstructPath(cameFrom, current) {
  const total = [current];
  while (cameFrom[current]) { current = cameFrom[current]; total.push(current); }
  return total.reverse();
}

/* Tiny Priority Queue for A* */
class TinyPriorityQueue {
  constructor(){ this._ = []; }
  push(item){ this._.push(item); this._.sort((a,b)=>a.f-b.f); }
  pop(){ return this._.shift(); }
  size(){ return this._.length; }
}

/* PHYSICS */
function integratePlayer(player, dt, input) {
  const speed = difficulty === 'easy' ? 5 : difficulty === 'hard' ? 7 : 6;
  const dx = input ? input.dx : 0;
  const dz = input ? input.dz : 0;
  player.vx = dx * speed;
  player.vz = dz * speed;
  player.vy = (player.vy || 0) - 9.8 * dt;
  if (input && input.jump && Math.abs(player.vy) < 0.1) {
    player.vy = 6.2;
    if (difficulty === 'hard') player.vy = 7.2;
  }
  player.x += player.vx * dt;
  player.y += player.vy * dt;
  player.z += player.vz * dt;
  if (player.y < 1) { player.y = 1; player.vy = 0; }
  // spike collision
  for (let s of spikeGroup.children) {
    const d = Math.hypot(player.x - s.position.x, player.z - s.position.z);
    if (d < 0.9 && player.y < s.position.y + 1.0) {
      // knock back and small penalty
      player.vy = 4;
      player.x += (Math.random()-0.5)*2;
      player.z += (Math.random()-0.5)*2;
    }
  }
  // finish detection
  if (!player.finished && player.y > 48) {
    player.finished = true;
    player.finishTime = LEVEL_DURATION - levelTimer;
    if (player.mesh) player.mesh.material.color.set(0xffff00);
    addToLeaderboard(player.name, player.finishTime);
  }
}

/* BOT AI */
function botThink(bot, dt) {
  bot.botState.lastThink += dt;
  if (bot.botState.lastThink < BOT_THINK_INTERVAL) return;
  bot.botState.lastThink = 0;
  if (bot.finished) return;

  // choose a high target node
  const nodes = platformNodes.filter(n => n.y > bot.y + 1);
  if (!nodes.length) {
    bot._aiInput = { dx: (Math.random()-0.5)*0.6, dz: (Math.random()-0.5)*0.6, jump: Math.random() < 0.03 };
    return;
  }
  // pick a target biased by height and distance
  nodes.sort((a,b) => (b.y - a.y) - (a.x - b.x)*0.0001);
  const target = nodes[Math.floor(Math.random()*Math.min(6, nodes.length))];
  // find nearest node to bot
  const nearest = findNearestNode(bot.x, bot.y, bot.z);
  if (!nearest) { bot._aiInput = { dx:0, dz:0, jump:0 }; return; }
  const path = findPath(nearest.id, target.id);
  bot.botState.path = path;
  bot.botState.targetPlatform = target;

  // follow first step
  if (path && path.length > 1) {
    const nextId = path[1];
    const nextNode = platformNodes.find(n => n.id === nextId);
    if (nextNode) {
      const vx = nextNode.x - bot.x;
      const vz = nextNode.z - bot.z;
      const len = Math.hypot(vx, vz) || 1;
      const ndx = vx/len;
      const ndz = vz/len;
      const needJump = (nextNode.y - bot.y) > 0.6;
      const jumpProb = needJump ? 0.9 : 0.05;
      bot._aiInput = { dx: ndx, dz: ndz, jump: Math.random() < jumpProb };
    }
  } else {
    // direct move
    const vx = target.x - bot.x;
    const vz = target.z - bot.z;
    const len = Math.hypot(vx, vz) || 1;
    bot._aiInput = { dx: vx/len, dz: vz/len, jump: Math.random() < 0.05 };
  }
}

/* UTIL find nearest node */
function findNearestNode(x,y,z) {
  let best = null, bestD = Infinity;
  for (let n of platformNodes) {
    const d = Math.hypot(n.x - x, n.z - z) + Math.abs(n.y - y)*0.6;
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

/* INPUT local */
let keys = { w:0, a:0, s:0, d:0, space:0 };
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

/* UI */
function refreshPlayersUI() {
  uiPlayersEl.innerHTML = '';
  const arr = Object.values(players).sort((a,b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.y - a.y;
  });
  for (let p of arr) {
    const d = document.createElement('div');
    d.className = 'playerLabel';
    const left = document.createElement('div');
    left.innerHTML = `<strong>${p.name}</strong> ${p.isBot ? '<span class="botBadge">BOT</span>' : ''}`;
    const right = document.createElement('div');
    right.className = 'small';
    right.textContent = p.finished ? `Finished ${formatTime(p.finishTime)}` : `Y ${p.y.toFixed(1)}`;
    d.appendChild(left);
    d.appendChild(right);
    uiPlayersEl.appendChild(d);
  }
  updateLeaderboardUI();
}

/* LEADERBOARD localStorage */
function addToLeaderboard(name, time) {
  const key = 'toh_leaderboard_v1';
  const list = JSON.parse(localStorage.getItem(key) || '[]');
  list.push({ name, time, date: Date.now() });
  list.sort((a,b)=>a.time - b.time);
  localStorage.setItem(key, JSON.stringify(list.slice(0,20)));
  updateLeaderboardUI();
}
function updateLeaderboardUI() {
  const key = 'toh_leaderboard_v1';
  const list = JSON.parse(localStorage.getItem(key) || '[]');
  leaderListEl.innerHTML = '';
  list.forEach(item => {
    const li = document.createElement('li');
    li.textContent = `${item.name} - ${formatTime(item.time)}`;
    leaderListEl.appendChild(li);
  });
}

/* ANIMATE */
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());

  // moving platforms animation
  movingGroup.children.forEach(p => {
    const ud = p.userData;
    const t = clock.elapsedTime * ud.speed + ud.phase;
    const off = Math.sin(t) * ud.range;
    if (ud.axis === 'x') p.position.x = (ud.baseX || ud.baseX === 0 ? ud.baseX : (ud.baseX = p.position.x)) + off;
    else p.position.z = (ud.baseZ || ud.baseZ === 0 ? ud.baseZ : (ud.baseZ = p.position.z)) + off;
    p.userData.topY = p.position.y + 0.2;
  });

  if (levelRunning) {
    // local input
    const dx = (keys.d - keys.a);
    const dz = (keys.s - keys.w);
    const jump = keys.space ? 1 : 0;
    integratePlayer(localPlayer, dt, { dx, dz, jump, dt });

    // bots
    Object.values(players).forEach(p => {
      if (!p.isBot) return;
      botThink(p, dt);
      const ai = p._aiInput || { dx:0, dz:0, jump:0 };
      integratePlayer(p, dt, { dx: ai.dx, dz: ai.dz, jump: ai.jump, dt });
    });

    // timer
    levelTimer = Math.max(0, levelTimer - dt);
    document.getElementById('timer').textContent = formatTime(levelTimer);
    if (levelTimer <= 0) endLevel();
  }

  // update meshes
  Object.values(players).forEach(p => {
    if (p.mesh) p.mesh.position.set(p.x, p.y + 1, p.z);
  });

  // camera follow
  const target = localPlayer.mesh.position;
  const desired = new THREE.Vector3(target.x, target.y + 8, target.z + 18);
  camera.position.lerp(desired, 0.08);
  camera.lookAt(target.x, target.y + 1, target.z);

  renderer.render(scene, camera);
}

/* HELPERS */
function onResize() {
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
function formatTime(sec) {
  if (sec === undefined || sec === null) return '--:--';
  const m = Math.floor(sec/60).toString().padStart(2,'0');
  const s = Math.floor(sec%60).toString().padStart(2,'0');
  return `${m}:${s}`;
}
function generateId() { return 'p-' + Math.random().toString(36).slice(2,9); }

/* START / RESET */
function startLevel() {
  // difficulty
  difficulty = document.getElementById('difficulty').value;
  // reset seed and map
  seed = Math.floor(Math.random()*1e9);
  generateTower();
  // reset timer
  levelTimer = LEVEL_DURATION;
  levelRunning = true;
  // reset players
  Object.values(players).forEach(p => {
    p.x = (Math.random()-0.5)*6;
    p.y = 1;
    p.z = (Math.random()-0.5)*6;
    p.vx = p.vy = p.vz = 0;
    p.finished = false;
    p.finishTime = null;
    if (!p.mesh) {
      const geo = new THREE.BoxGeometry(1,2,1);
      const mat = new THREE.MeshStandardMaterial({ color: p.isBot ? 0xff6b6b : 0x00ff88 });
      const m = new THREE.Mesh(geo, mat);
      scene.add(m);
      p.mesh = m;
    } else {
      p.mesh.material.color.set(p.isBot ? 0xff6b6b : 0x00ff88);
    }
  });
  refreshPlayersUI();
}

function resetAll() {
  // remove bot meshes
  Object.keys(players).forEach(id => {
    if (players[id].isBot) {
      if (players[id].mesh) scene.remove(players[id].mesh);
      delete players[id];
    }
  });
  // reset local player
  localPlayer.x = localPlayer.y = localPlayer.z = 0;
  localPlayer.vx = localPlayer.vy = localPlayer.vz = 0;
  localPlayer.finished = false;
  if (localPlayer.mesh) localPlayer.mesh.position.set(localPlayer.x, localPlayer.y+1, localPlayer.z);
  levelRunning = false;
  levelTimer = LEVEL_DURATION;
  document.getElementById('timer').textContent = formatTime(levelTimer);
  refreshPlayersUI();
}

/* UI wiring */
document.getElementById('startBtn').addEventListener('click', () => {
  // create bots
  const desired = parseInt(document.getElementById('botCount').value, 10);
  // remove existing bots
  Object.keys(players).forEach(id => {
    if (players[id].isBot) {
      if (players[id].mesh) scene.remove(players[id].mesh);
      delete players[id];
    }
  });
  for (let i=0;i<desired;i++) {
    const id = generateId();
    const bot = createPlayer(id, false, true, 'Bot-' + (i+1));
    players[id] = bot;
  }
  // set local name
  localPlayer.name = document.getElementById('name').value || 'You';
  players[localPlayerId] = localPlayer;
  startLevel();
});
document.getElementById('resetBtn').addEventListener('click', () => resetAll());

/* LOCAL STORAGE LEADERBOARD INIT */
updateLeaderboardUI();

/* INIT */
(function main(){
  initThree();
  generateTower();
  refreshPlayersUI();
})();
