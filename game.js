"use strict";

const TUNING = {
  fixedDt: 1 / 60,
  world: {
    xMin: -5.2,
    xMax: 5.2,
    yMin: -13.4,
    yMax: 13.4,
    singlesX: 4.115,
    doublesX: 5.0,
    baselineY: 11.885,
    serviceY: 6.4,
    netHeight: 0.95,
  },
  player: {
    speed: 5.95,
    accel: 21,
    friction: 27,
    xMin: -4.55,
    xMax: 4.55,
    yMin: 1.15,
    yMax: 11.55,
    hitRadiusX: 1.0,
    hitRadiusY: 1.16,
    perfectRadius: 0.34,
    goodRadius: 0.78,
    reachZ: 2.85,
    hitCooldown: 0.36,
    hitBuffer: 0.32,
    chargeTime: 0.78,
    powerThreshold: 0.52,
  },
  ai: {
    reaction: 0.28,
    speed: 4.7,
    accel: 15.5,
    friction: 21,
    targetError: 0.58,
    failRate: 0.012,
    hitCooldown: 0.48,
  },
  ball: {
    gravity: 22,
    bounce: 0.68,
    floorDrag: 0.7,
    rollStopSpeed: 1.45,
  },
  shots: {
    normal: { kind: "normal", time: 1.02, height: 2.6, error: 0.38, energy: 10 },
    power: { kind: "power", time: 0.78, height: 2.0, error: 0.62, energy: 14 },
    lob: { kind: "lob", time: 1.5, height: 6.2, error: 0.5, energy: 12 },
    drop: { kind: "drop", time: 0.72, height: 1.35, error: 0.56, energy: 13 },
    special: { kind: "special", time: 0.67, height: 1.75, error: 0.18, energy: 0 },
    serve: { kind: "serve", time: 0.96, height: 2.85, error: 0.28, energy: 0 },
  },
  match: {
    gamesToWin: 3,
    nextPointDelay: 1.1,
    serveDelay: 0.78,
  },
};

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const roomCodeNativeInput = document.getElementById("room-code-native-input");
ctx.imageSmoothingEnabled = false;

const W = canvas.width;
const H = canvas.height;
const IS_PORTRAIT = H > W;
const URL_PARAMS = new URLSearchParams(window.location.search);
const ONLINE_MODE = URL_PARAMS.get("mode") === "online";
const DEBUG_NET = URL_PARAMS.get("debug") === "net";
const ONLINE_PING_MS = 1200;
const ONLINE_PRODUCTION_ORIGIN = "https://pixel-tennis-web.onrender.com";
const DIRECT_GAME_START = ONLINE_MODE || URL_PARAMS.has("previewResult");
const SHOW_PROTOTYPE_BADGE = URL_PARAMS.get("badge") === "prototype";
const COURT = {
  cx: W / 2,
  top: IS_PORTRAIT ? 168 : 78,
  bottom: IS_PORTRAIT ? H - 76 : 692,
  baseScaleX: IS_PORTRAIT ? 33 : 50,
};

const scoreLabels = ["0", "15", "30", "40"];

const ONLINE = {
  enabled: ONLINE_MODE,
  status: ONLINE_MODE ? "connecting" : "off",
  socket: null,
  serverUrl: "",
  room: URL_PARAMS.get("room") || "",
  playerId: null,
  role: null,
  lastInputSent: 0,
  lastInputAt: 0,
  lastPingAt: 0,
  lastPongAt: 0,
  rttMs: null,
  reconnectAt: 0,
  snapshotAt: 0,
  message: "",
};

// --- Online presentation-layer netcode -------------------------------------
// Tuning for client prediction, interpolation, and dead reckoning.
const NET_TUNE = {
  interpDelayMs: 110, // remote player rendered slightly in the past for smooth lerp
  maxExtrapolateMs: 250,
  snapDist: 1.6, // prediction error beyond this snaps instead of smoothing
  correctRate: 12, // exponential rate at which prediction error bleeds away
  inputResendMs: 50, // keepalive resend cadence when input is unchanged
  redundantInputs: 3, // recent inputs piggybacked on each packet (loss masking)
};

// Server movement/ball constants mirrored locally for prediction.
// Keep in sync with server/multiplayer-server.js (PLAYER / WORLD / BALL).
const NET_PHYS = {
  speed: 5.95,
  accel: 21,
  friction: 27,
  xMin: -4.55,
  xMax: 4.55,
  p1YMin: 1.15,
  p1YMax: 11.55,
  p2YMin: -11.55,
  p2YMax: -1.15,
  gravity: 22,
  bounce: 0.68,
  floorDrag: 0.7,
};

const NET_SIM = {
  snapshots: [], // [{at, receivedAt, serverTime, players, ball}] newest last
  inputSeq: 0,
  recentInputs: [], // [{seq, input}] for redundancy
  lastSentKey: "",
  predHistory: [], // [{t, x, y}] local predicted positions for reconciliation
  corrX: 0,
  corrY: 0,
  lastAck: 0,
  serverOffsetMs: null,
  lastSnapshotAt: 0,
};

function netReset() {
  NET_SIM.snapshots.length = 0;
  NET_SIM.recentInputs.length = 0;
  NET_SIM.lastSentKey = "";
  NET_SIM.predHistory.length = 0;
  NET_SIM.corrX = 0;
  NET_SIM.corrY = 0;
  NET_SIM.lastAck = 0;
  NET_SIM.serverOffsetMs = null;
  NET_SIM.lastSnapshotAt = 0;
}

let netDebug = null;

const APP_FLOW = {
  screen: DIRECT_GAME_START ? "game" : "menu",
  selectedMode: ONLINE_MODE ? "twoPlayer" : "onePlayer",
  menuChoice: 0,
  twoPlayerChoice: 0,
  roomCodeInput: "",
  roomCodeMode: "join",
  pauseMenuOpen: false,
  suppressNextClick: false,
};

const THEMES = [
  {
    id: "infiniteCastle",
    uiId: "infiniteCastle",
    button: "castle",
    src: "assets/backgrounds/infinite-castle.png",
    thumbnail: { x: 0.23, y: 0.28, zoom: 0.56 },
    swatch: ["#10272f", "#d28938", "#294348"],
    court: {
      outer: "rgba(28, 70, 72, 0.2)",
      base: "rgba(26, 96, 98, 0.52)",
      inner: "rgba(38, 136, 132, 0.46)",
      lane: "rgba(45, 150, 142, 0.28)",
      line: "#e6fff8",
      net: "#71e2ef",
    },
  },
  {
    id: "wisteriaMountain",
    uiId: "wisteriaMountain",
    button: "wisteria",
    src: "assets/backgrounds/wisteria-mountain-v2.png",
    thumbnail: { x: 0.5, y: 0.18, zoom: 0.58 },
    ui: {
      netPreserveAspect: true,
    },
    swatch: ["#2a2c78", "#9b65dd", "#f3d47b"],
    court: {
      outer: "rgba(62, 56, 128, 0.2)",
      base: "rgba(84, 75, 148, 0.5)",
      inner: "rgba(112, 89, 168, 0.42)",
      lane: "rgba(160, 111, 212, 0.24)",
      line: "#f1eaff",
      net: "#d6bcff",
    },
  },
  {
    id: "midnightTrain",
    uiId: "midnightTrain",
    button: "train",
    src: "assets/backgrounds/midnight-train-v2.png",
    thumbnail: { x: 0.22, y: 0.28, zoom: 0.6 },
    ui: {
      netPreserveAspect: true,
    },
    swatch: ["#0d1f42", "#d99438", "#b4232d"],
    court: {
      outer: "rgba(18, 31, 58, 0.22)",
      base: "rgba(49, 61, 78, 0.48)",
      inner: "rgba(70, 78, 92, 0.42)",
      lane: "rgba(165, 116, 58, 0.18)",
      line: "#f4e6c7",
      net: "#f0b36e",
    },
  },
  {
    id: "lanternDistrict",
    uiId: "lanternDistrict",
    button: "district",
    src: "assets/backgrounds/lantern-district-v2.png",
    thumbnail: { x: 0.5, y: 0.2, zoom: 0.58 },
    ui: {
      netPreserveAspect: true,
    },
    swatch: ["#5d1732", "#f0a33b", "#24184f"],
    court: {
      outer: "rgba(91, 22, 51, 0.22)",
      base: "rgba(106, 66, 68, 0.48)",
      inner: "rgba(126, 76, 78, 0.42)",
      lane: "rgba(236, 126, 56, 0.2)",
      line: "#ffe6bd",
      net: "#ff9f76",
    },
  },
];

const CHARACTER_SKINS = {
  taishoSwordsman: {
    hair: "#381923",
    hairHi: "#7f2e33",
    face: "#f0b990",
    eye: "#132a44",
    robeDark: "#172324",
    robeA: "#1e9c8d",
    robeB: "#123f42",
    pants: "#412536",
    accent: "#e74c53",
    blade: "#dce8e9",
    racket: "#e0a02d",
    grip: "#fa3b9a",
  },
  lightningRival: {
    hair: "#d59a39",
    hairHi: "#ffd168",
    face: "#f0b990",
    eye: "#493023",
    robeDark: "#211a18",
    robeA: "#e4a64d",
    robeB: "#8d612b",
    pants: "#3f495f",
    accent: "#f0d36c",
    blade: "#dce8e9",
    racket: "#e0a02d",
    grip: "#9b49d7",
  },
};

const CHARACTER_SLOT_COUNT = 24;
const CHARACTER_PAGE_SIZE = 8;
const BASE_CHARACTERS = [
  {
    id: "tanjiro",
    name: "TANJIRO",
    role: "BALANCED",
    unlocked: true,
    sprite: "assets/characters/player-chibi-small.png",
    portrait: "assets/characters/player-chibi.png",
  },
  {
    id: "zenitsu",
    name: "ZENITSU",
    role: "POWER",
    unlocked: true,
    sprite: "assets/characters/rival-chibi-small.png",
    portrait: "assets/characters/rival-chibi.png",
  },
  {
    id: "shinobu",
    name: "SHINOBU",
    role: "SPEED",
    unlocked: true,
    sprite: "assets/characters/shinobu-tennis-small.png",
    portrait: "assets/characters/shinobu-tennis.png",
  },
  {
    id: "nezuko",
    name: "NEZUKO",
    role: "BALANCED",
    unlocked: true,
    sprite: "assets/characters/bamboo-rose-tennis-small.png",
    portrait: "assets/characters/bamboo-rose-tennis.png",
  },
  {
    id: "mitsuri",
    name: "MITSURI",
    role: "POWER",
    unlocked: true,
    sprite: "assets/characters/sakura-power-tennis-small.png",
    portrait: "assets/characters/sakura-power-tennis.png",
  },
  {
    id: "inosuke",
    name: "INOSUKE",
    role: "ATTACK",
    unlocked: true,
    sprite: "assets/characters/wild-mountain-tennis-small.png",
    portrait: "assets/characters/wild-mountain-tennis.png",
  },
  {
    id: "kyojuro",
    name: "KYOJURO",
    role: "POWER",
    unlocked: true,
    sprite: "assets/characters/flame-captain-tennis-small.png",
    portrait: "assets/characters/flame-captain-tennis.png",
  },
  {
    id: "giyu",
    name: "GIYU",
    role: "CONTROL",
    unlocked: true,
    sprite: "assets/characters/water-mist-tennis-small.png",
    portrait: "assets/characters/water-mist-tennis.png",
  },
  {
    id: "muzan",
    name: "MUZAN",
    role: "BOSS",
    unlocked: true,
    sprite: "assets/characters/muzan-tennis-small.png",
    portrait: "assets/characters/muzan-tennis.png",
  },
  {
    id: "akaza",
    name: "AKAZA",
    role: "ATTACK",
    unlocked: true,
    sprite: "assets/characters/akaza-tennis-small.png",
    portrait: "assets/characters/akaza-tennis.png",
  },
  {
    id: "doma",
    name: "DOMA",
    role: "TRICK",
    unlocked: true,
    sprite: "assets/characters/doma-tennis-small.png",
    portrait: "assets/characters/doma-tennis.png",
  },
  {
    id: "kokushibo",
    name: "KOKUSHIBO",
    role: "MOON",
    unlocked: true,
    sprite: "assets/characters/kokushibo-tennis-small.png",
    portrait: "assets/characters/kokushibo-tennis.png",
  },
];

const CHARACTERS = [
  ...BASE_CHARACTERS,
  ...Array.from({ length: Math.max(0, CHARACTER_SLOT_COUNT - BASE_CHARACTERS.length) }, (_, index) => {
    const slotNumber = BASE_CHARACTERS.length + index + 1;
    const slotLabel = String(slotNumber).padStart(2, "0");
    return {
      id: `slot${slotLabel}`,
      name: "COMING SOON",
      role: "EMPTY",
      unlocked: false,
      sprite: "",
      portrait: "",
    };
  }),
];

const INITIAL_CHARACTER_INDEX = Math.max(
  0,
  CHARACTERS.findIndex((character) => character.unlocked && character.id === URL_PARAMS.get("character")),
);

const CHARACTER_SELECT = {
  selectedIndex: INITIAL_CHARACTER_INDEX,
  panelOpen: false,
  panelChoice: INITIAL_CHARACTER_INDEX,
  hoverIndex: -1,
  page: Math.floor(INITIAL_CHARACTER_INDEX / CHARACTER_PAGE_SIZE),
};

const state = {
  phase: "serveWait",
  pausedPhase: null,
  pausedMessage: "",
  pausedMessageSub: "",
  result: null,
  resultTime: 0,
  timer: TUNING.match.serveDelay,
  message: "RIVAL SERVE",
  messageSub: "",
  server: "ai",
  lastHit: "ai",
  pointWinner: null,
  rallyHits: 0,
  maxRally: 0,
  playerPoints: 0,
  aiPoints: 0,
  playerGames: 0,
  aiGames: 0,
  energy: 0,
  playerShotPressure: 0,
  shake: 0,
  themeIndex: 0,
};

const input = {
  left: false,
  right: false,
  up: false,
  down: false,
  hit: false,
  hitArmed: true,
  hitHold: 0,
  hitQueued: false,
  hitQueueTimer: 0,
  hitPulse: 0,
  specialPulse: 0,
  queuedSpecial: false,
  aim: 0,
  pointerId: null,
  stickPointerId: null,
  stick: { x: 0, y: 0 },
  mouseAim: null,
};

const player = makeActor(0, 9.9, "player");
const ai = makeActor(0, -9.9, "ai");
const ball = {
  x: 0,
  y: -9,
  z: 1.0,
  vx: 0,
  vy: 0,
  vz: 0,
  bounceCount: 0,
  inPlay: false,
  lastY: -9,
  trail: [],
};

let noiseTiles = null;
const UI_ASSET_VERSION = "ui-normalized-1";
const themeImages = THEMES.map((theme) => loadImage(theme.src));
const characterSprites = Object.fromEntries(
  CHARACTERS.filter((character) => character.sprite).map((character) => [character.id, loadImage(character.sprite)]),
);
const characterPortraits = Object.fromEntries(
  CHARACTERS.filter((character) => character.portrait).map((character) => [character.id, loadImage(character.portrait)]),
);
const actorSprites = {
  player: characterSprites.tanjiro,
  ai: characterSprites.zenitsu,
};
const equipmentSprites = {
  racket: loadImage("assets/equipment/pixel-racket.svg"),
};
const uiSpriteIds = [...new Set(THEMES.map((theme) => theme.uiId || theme.id))];
const uiSprites = Object.fromEntries(
  uiSpriteIds.map((id) => [
    id,
    {
      net: loadImage(`assets/ui/${id}/net.png?v=${UI_ASSET_VERSION}`),
      joystick: loadImage(`assets/ui/${id}/joystick-game.png?v=${UI_ASSET_VERSION}`),
      special: loadImage(`assets/ui/${id}/special-game.png?v=${UI_ASSET_VERSION}`),
      hit: loadImage(`assets/ui/${id}/hit-game.png?v=${UI_ASSET_VERSION}`),
    },
  ]),
);
const MENU_ASSET_PATHS = {
  background: "assets/menu/player-select-bg-kimetsu-v2.png",
  logo: "assets/menu/logo-pixel-tennis.png",
  onePlayer: "",
  twoPlayer: "",
};
const MENU_BUTTON_TEXT_OVERLAY = true;
const menuSprites = Object.fromEntries(
  Object.entries(MENU_ASSET_PATHS).map(([key, src]) => [key, src ? loadImage(src) : null]),
);
let accumulator = 0;
let lastTime = performance.now();

function makeActor(x, y, side) {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    side,
    cooldown: 0,
    swing: 0,
    targetX: x,
    targetY: y,
    reactionTimer: 0,
    predicted: { x, y },
    pose: 0,
    skin: side === "player" ? "taishoSwordsman" : "lightningRival",
    characterId: side === "player" ? "tanjiro" : "zenitsu",
  };
}

function loadImage(src) {
  const image = new Image();
  image.onerror = () => {
    // Surfaces a missing/un-committed asset loudly instead of silently degrading.
    console.warn(`[assets] Failed to load "${src}". Check the file exists and was committed (git add).`);
  };
  image.src = src;
  return image;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function chance(rate) {
  return Math.random() < rate;
}

function distance2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function keyCode(key) {
  return String(key || "").toLowerCase();
}

function currentTheme() {
  return THEMES[state.themeIndex] || THEMES[0];
}

function uiControlScale(theme, control) {
  const ui = theme.ui || {};
  return (ui.buttonScale || 1) * (ui[`${control}Scale`] || 1);
}

function uiControlOffset(theme, control) {
  const ui = theme.ui || {};
  return {
    x: ui[`${control}OffsetX`] || 0,
    y: ui[`${control}OffsetY`] || 0,
  };
}

function unlockedCharacters() {
  return CHARACTERS.filter((character) => character.unlocked);
}

function characterById(id) {
  return CHARACTERS.find((character) => character.id === id) || unlockedCharacters()[0] || CHARACTERS[0];
}

function characterIndexById(id) {
  const index = CHARACTERS.findIndex((character) => character.id === id);
  return index >= 0 ? index : 0;
}

function characterPageCount() {
  return Math.ceil(CHARACTERS.length / CHARACTER_PAGE_SIZE);
}

function characterPageForIndex(index) {
  return Math.floor(Math.max(0, index) / CHARACTER_PAGE_SIZE);
}

function setCharacterPanelPage(page) {
  const maxPage = Math.max(0, characterPageCount() - 1);
  const nextPage = Math.max(0, Math.min(maxPage, page));
  const start = nextPage * CHARACTER_PAGE_SIZE;
  const end = Math.min(CHARACTERS.length, start + CHARACTER_PAGE_SIZE);
  CHARACTER_SELECT.page = nextPage;
  CHARACTER_SELECT.hoverIndex = -1;
  if (CHARACTER_SELECT.panelChoice < start || CHARACTER_SELECT.panelChoice >= end) {
    CHARACTER_SELECT.panelChoice =
      CHARACTER_SELECT.selectedIndex >= start && CHARACTER_SELECT.selectedIndex < end ? CHARACTER_SELECT.selectedIndex : start;
  }
}

function openCharacterPanel() {
  CHARACTER_SELECT.panelOpen = true;
  CHARACTER_SELECT.panelChoice = CHARACTER_SELECT.selectedIndex;
  CHARACTER_SELECT.hoverIndex = -1;
  setCharacterPanelPage(characterPageForIndex(CHARACTER_SELECT.selectedIndex));
}

function moveCharacterPanelChoice(delta) {
  const next = Math.max(0, Math.min(CHARACTERS.length - 1, CHARACTER_SELECT.panelChoice + delta));
  CHARACTER_SELECT.panelChoice = next;
  CHARACTER_SELECT.hoverIndex = -1;
  setCharacterPanelPage(characterPageForIndex(next));
}

function selectedCharacter() {
  return CHARACTERS[CHARACTER_SELECT.selectedIndex] || unlockedCharacters()[0] || CHARACTERS[0];
}

function selectedCharacterId() {
  return selectedCharacter().id;
}

function setSelectedCharacterIndex(index) {
  const character = CHARACTERS[index];
  if (!character || !character.unlocked) return false;
  CHARACTER_SELECT.selectedIndex = index;
  CHARACTER_SELECT.panelChoice = index;
  CHARACTER_SELECT.hoverIndex = -1;
  CHARACTER_SELECT.page = characterPageForIndex(index);
  return true;
}

function cycleSelectedCharacter(direction) {
  const count = CHARACTERS.length;
  for (let step = 1; step <= count; step += 1) {
    const next = (CHARACTER_SELECT.selectedIndex + direction * step + count) % count;
    if (setSelectedCharacterIndex(next)) return true;
  }
  return false;
}

function chooseOpponentCharacterId(playerCharacterId) {
  const candidates = unlockedCharacters().filter((character) => character.id !== playerCharacterId);
  if (!candidates.length) return playerCharacterId;
  return candidates[(Math.random() * candidates.length) | 0].id;
}

function spriteForCharacterId(id) {
  const character = characterById(id);
  return characterSprites[character.id] || actorSprites.player;
}

function portraitForCharacterId(id) {
  const character = characterById(id);
  return characterPortraits[character.id] || spriteForCharacterId(character.id);
}

function isMenuOpen() {
  return APP_FLOW.screen === "menu";
}

function isShortcutsOpen() {
  return APP_FLOW.screen === "shortcuts";
}

function isTwoPlayerSetupOpen() {
  return APP_FLOW.screen === "twoPlayerSetup";
}

function isMirroredView() {
  return ONLINE.enabled && ONLINE.playerId === "p2";
}

function worldToViewPoint(x, y) {
  return isMirroredView() ? { x: -x, y: -y } : { x, y };
}

function viewToWorldPoint(x, y) {
  return isMirroredView() ? { x: -x, y: -y } : { x, y };
}

function viewDepthY(y) {
  return isMirroredView() ? -y : y;
}

function scoreView() {
  if (!ONLINE.enabled) {
    return {
      leftLabel: "PLAYER",
      rightLabel: "RIVAL",
      leftPoints: state.playerPoints,
      rightPoints: state.aiPoints,
      leftGames: state.playerGames,
      rightGames: state.aiGames,
    };
  }
  if (ONLINE.playerId === "p2") {
    return {
      leftLabel: "YOU",
      rightLabel: "OPP",
      leftPoints: state.aiPoints,
      rightPoints: state.playerPoints,
      leftGames: state.aiGames,
      rightGames: state.playerGames,
    };
  }
  if (ONLINE.playerId === "p1") {
    return {
      leftLabel: "YOU",
      rightLabel: "OPP",
      leftPoints: state.playerPoints,
      rightPoints: state.aiPoints,
      leftGames: state.playerGames,
      rightGames: state.aiGames,
    };
  }
  return {
    leftLabel: "P1",
    rightLabel: "P2",
    leftPoints: state.playerPoints,
    rightPoints: state.aiPoints,
    leftGames: state.playerGames,
    rightGames: state.aiGames,
  };
}

function setTheme(index) {
  state.themeIndex = clamp(index, 0, THEMES.length - 1);
  if (ONLINE.enabled) {
    sendOnline({ type: "theme", index: state.themeIndex });
  }
}

function onlineServerUrl() {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("server");
  if (explicit) return normalizeWebSocketUrl(explicit);
  if (location.protocol === "https:") {
    return `wss://${location.host}/ws`;
  }
  if (
    (location.hostname === "localhost" || location.hostname === "127.0.0.1") &&
    (!location.port || location.port === "4173")
  ) {
    return "ws://localhost:8787/ws";
  }
  if (location.protocol === "http:" && location.host) {
    return `ws://${location.host}/ws`;
  }
  return "";
}

function normalizeWebSocketUrl(value) {
  const text = String(value || "").trim();
  if (text.startsWith("wss://") || text.startsWith("ws://")) return text;
  if (text.startsWith("https://")) return `wss://${text.slice("https://".length)}`;
  if (text.startsWith("http://")) return `ws://${text.slice("http://".length)}`;
  return text;
}

function initOnlineMode() {
  if (!ONLINE.enabled) return;
  ONLINE.serverUrl = onlineServerUrl();
  ball.inPlay = false;
  state.phase = "waiting";
  state.message = ONLINE.serverUrl ? "CONNECTING" : "ONLINE SERVER REQUIRED";
  state.messageSub = ONLINE.serverUrl ? "ONLINE ROOM" : "ADD ?server=wss://.../ws";
  if (DEBUG_NET) {
    loadNetDebugModule(() => {
      if (ONLINE.serverUrl) connectOnline();
    });
  } else if (ONLINE.serverUrl) {
    connectOnline();
  }
}

function loadNetDebugModule(onReady) {
  const attach = () => {
    if (window.PixelTennisNetDebug && !netDebug) {
      netDebug = window.PixelTennisNetDebug.create({ maxMisses: 100 });
      window.PixelTennisDebug = netDebug;
    }
    onReady();
  };
  if (window.PixelTennisNetDebug) {
    attach();
    return;
  }
  const script = document.createElement("script");
  script.src = "./net-debug.js?v=net-debug-3";
  script.onload = attach;
  script.onerror = onReady;
  document.head.appendChild(script);
}

function connectOnline() {
  if (!ONLINE.enabled || !ONLINE.serverUrl) return;
  if (ONLINE.socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(ONLINE.socket.readyState)) return;
  ONLINE.status = "connecting";
  ONLINE.message = "CONNECTING";
  try {
    const socket = new WebSocket(ONLINE.serverUrl);
    ONLINE.socket = socket;
    socket.addEventListener("open", () => {
      if (ONLINE.socket !== socket) return;
      ONLINE.status = "connected";
      ONLINE.message = "";
      sendOnline({ type: "join", room: ONLINE.room, debug: DEBUG_NET, characterId: selectedCharacterId() });
      sendOnlinePing(performance.now(), true);
    });
    socket.addEventListener("message", (event) => {
      if (ONLINE.socket !== socket) return;
      handleOnlineMessage(event.data);
    });
    socket.addEventListener("close", () => {
      if (ONLINE.socket !== socket) return;
      ONLINE.status = "disconnected";
      ONLINE.message = "DISCONNECTED";
      ONLINE.reconnectAt = performance.now() + 1800;
    });
    socket.addEventListener("error", () => {
      if (ONLINE.socket !== socket) return;
      ONLINE.status = "error";
      ONLINE.message = "CONNECTION ERROR";
    });
  } catch (error) {
    ONLINE.status = "error";
    ONLINE.message = "CONNECTION ERROR";
    ONLINE.reconnectAt = performance.now() + 2200;
  }
}

function handleOnlineMessage(raw) {
  let packet;
  try {
    packet = JSON.parse(raw);
  } catch {
    return;
  }
  if (packet.type === "welcome") {
    ONLINE.room = packet.room;
    ONLINE.playerId = packet.playerId;
    ONLINE.role = packet.role;
    ONLINE.status = "connected";
    netReset();
    syncOnlineUrl();
    return;
  }
  if (packet.type === "state") {
    applyOnlineState(packet);
  } else if (packet.type === "pong") {
    const sentAt = Number(packet.sentAt);
    if (Number.isFinite(sentAt)) {
      ONLINE.rttMs = Math.max(0, performance.now() - sentAt);
    }
    ONLINE.lastPongAt = performance.now();
    if (netDebug) netDebug.handlePong(packet, performance.now());
  } else if (packet.type === "debug") {
    if (netDebug) netDebug.handleDebug(packet, ONLINE.playerId, performance.now());
  } else if (packet.type === "error") {
    ONLINE.message = packet.message || "ONLINE ERROR";
  }
}

function syncOnlineUrl() {
  if (!ONLINE.room) return;
  const params = new URLSearchParams(window.location.search);
  params.set("mode", "online");
  params.set("room", ONLINE.room);
  if (URL_PARAMS.get("server")) params.set("server", URL_PARAMS.get("server"));
  const next = `${location.pathname}?${params.toString()}`;
  history.replaceState(null, "", next);
}

function sendOnline(payload) {
  if (!ONLINE.enabled || !ONLINE.socket || ONLINE.socket.readyState !== WebSocket.OPEN) return false;
  ONLINE.socket.send(JSON.stringify(payload));
  return true;
}

function onlineInputPayload() {
  const local = {
    left: input.left || input.stick.x < -0.25,
    right: input.right || input.stick.x > 0.25,
    up: input.up || input.stick.y < -0.25,
    down: input.down || input.stick.y > 0.25,
    hit: input.hit || input.hitQueued,
    special: input.queuedSpecial,
    aim: clamp(input.aim, -1, 1),
    hitHold: clamp(input.hitHold, 0, 1.2),
    shotUp: input.up || input.stick.y < -0.25,
    shotDown: input.down || input.stick.y > 0.25,
    rttMs: ONLINE.rttMs === null ? null : Math.round(ONLINE.rttMs),
  };
  if (!isMirroredView()) return local;
  return {
    ...local,
    left: local.right,
    right: local.left,
    up: local.down,
    down: local.up,
    aim: -local.aim,
  };
}

function inputPayloadKey(payload) {
  return [
    payload.left, payload.right, payload.up, payload.down,
    payload.hit, payload.special, payload.shotUp, payload.shotDown,
    Math.round((payload.aim || 0) * 20),
    Math.round((payload.hitHold || 0) * 20),
  ].join(",");
}

function sendOnlineInput() {
  const now = performance.now();
  const payload = onlineInputPayload();
  const key = inputPayloadKey(payload);
  // Send immediately on any input change; otherwise throttle to a keepalive.
  const changed = key !== NET_SIM.lastSentKey;
  if (!changed && now - ONLINE.lastInputSent < NET_TUNE.inputResendMs) return;
  NET_SIM.inputSeq += 1;
  const sent = sendOnline({
    type: "input",
    seq: NET_SIM.inputSeq,
    input: payload,
    prev: NET_SIM.recentInputs.slice(-NET_TUNE.redundantInputs),
  });
  if (sent) {
    ONLINE.lastInputSent = now;
    ONLINE.lastInputAt = now;
    NET_SIM.lastSentKey = key;
    NET_SIM.recentInputs.push({ seq: NET_SIM.inputSeq, input: payload });
    if (NET_SIM.recentInputs.length > 6) NET_SIM.recentInputs.shift();
  } else {
    NET_SIM.inputSeq -= 1;
  }
}

function sendOnlinePing(now, force = false) {
  if (!force && now - ONLINE.lastPingAt < ONLINE_PING_MS) return;
  ONLINE.lastPingAt = now;
  sendOnline({ type: "ping", sentAt: now });
}

function updateOnline(dt) {
  state.shake = Math.max(0, state.shake - dt * 8);
  if (state.phase === "matchOver") {
    state.resultTime += dt;
  }
  updateInput(dt);
  sendOnlineInput();
  updateActorCooldowns(player, dt);
  updateActorCooldowns(ai, dt);
  netPredictLocal(dt);
  netSampleRemote();
  netSampleBall();
  const now = performance.now();
  sendOnlinePing(now);
  if ((ONLINE.status === "disconnected" || ONLINE.status === "error") && now > ONLINE.reconnectAt) {
    connectOnline();
  }
}

function netSnapshotTime(packet, receivedAt) {
  const serverTime = Number(packet.serverTime ?? packet.updatedAt);
  if (!Number.isFinite(serverTime) || serverTime <= 0) return receivedAt;
  const sampleOffset = receivedAt - serverTime;
  if (NET_SIM.serverOffsetMs === null || !Number.isFinite(NET_SIM.serverOffsetMs)) {
    NET_SIM.serverOffsetMs = sampleOffset;
  } else {
    const delta = sampleOffset - NET_SIM.serverOffsetMs;
    const blend = Math.abs(delta) > 250 ? 0.18 : 0.06;
    NET_SIM.serverOffsetMs += delta * blend;
  }
  const mappedAt = serverTime + NET_SIM.serverOffsetMs;
  if (!Number.isFinite(mappedAt)) return receivedAt;
  const at = Math.max(mappedAt, NET_SIM.lastSnapshotAt + 0.001);
  NET_SIM.lastSnapshotAt = at;
  return at;
}

function applyOnlineState(packet) {
  const receivedAt = performance.now();
  const snapshotAt = netSnapshotTime(packet, receivedAt);
  ONLINE.snapshotAt = receivedAt;
  if (netDebug) netDebug.handleState(packet, receivedAt);
  ONLINE.room = packet.room || ONLINE.room;
  state.phase = packet.phase || "waiting";
  state.timer = packet.timer ?? 0;
  state.message = packet.message || "";
  state.messageSub = packet.messageSub || (ONLINE.room ? `ROOM ${ONLINE.room}` : "");
  state.server = packet.server === "p1" ? "player" : "ai";
  state.lastHit = packet.lastHit === "p1" ? "player" : "ai";
  state.rallyHits = packet.rallyHits ?? 0;
  state.maxRally = packet.maxRally ?? 0;
  state.themeIndex = clamp(packet.themeIndex ?? 0, 0, THEMES.length - 1);

  const score = packet.score || {};
  state.playerPoints = score.playerPoints ?? 0;
  state.aiPoints = score.aiPoints ?? 0;
  state.playerGames = score.playerGames ?? 0;
  state.aiGames = score.aiGames ?? 0;

  const players = packet.players || {};
  NET_SIM.snapshots.push({
    at: snapshotAt,
    receivedAt,
    serverTime: Number(packet.serverTime ?? packet.updatedAt) || null,
    players,
    ball: packet.ball || null,
  });
  if (NET_SIM.snapshots.length > 16) NET_SIM.snapshots.shift();
  if (packet.ack && ONLINE.playerId && packet.ack[ONLINE.playerId] != null) {
    NET_SIM.lastAck = Number(packet.ack[ONLINE.playerId]) || 0;
  }

  const isPlaying = ONLINE.role === "player" && (ONLINE.playerId === "p1" || ONLINE.playerId === "p2");
  if (isPlaying) {
    const localId = ONLINE.playerId;
    const remoteId = localId === "p1" ? "p2" : "p1";
    const remoteActor = remoteId === "p1" ? player : ai;
    const localActor = localId === "p1" ? player : ai;
    // Remote actor position is owned by netSampleRemote; snapping here fights
    // interpolation whenever network packets arrive between render frames.
    if (NET_SIM.snapshots.length <= 1) {
      applyOnlineActor(remoteActor, players[remoteId], remoteId === "p1" ? 9.9 : -9.9);
    } else {
      applyOnlineActorMeta(remoteActor, players[remoteId]);
    }
    // Local actor: position is predicted locally; only reconcile against server.
    netReconcile(localActor, players[localId], localId);
  } else {
    applyOnlineActor(player, players.p1, 9.9);
    applyOnlineActor(ai, players.p2, -9.9);
  }
  const local = players[ONLINE.playerId] || players.p1;
  state.energy = local?.energy ?? 0;
  // Ball state is applied per-frame in netSampleBall (dead reckoning).

  if (packet.result) {
    const localIsP2 = ONLINE.playerId === "p2";
    const localGames = localIsP2 ? packet.result.aiGames : packet.result.playerGames;
    const otherGames = localIsP2 ? packet.result.playerGames : packet.result.aiGames;
    state.result = {
      winner: packet.result.winner === ONLINE.playerId ? "player" : "ai",
      playerGames: localGames,
      aiGames: otherGames,
      maxRally: packet.result.maxRally,
      themeIndex: state.themeIndex,
    };
    if (state.phase === "matchOver" && !state.resultTime) state.resultTime = 0.001;
  } else {
    state.result = null;
    state.resultTime = 0;
  }
}

function applyOnlineActor(actor, data, fallbackY) {
  if (!data) {
    actor.x = 0;
    actor.y = fallbackY;
    actor.vx = 0;
    actor.vy = 0;
    return;
  }
  actor.x = Number(data.x) || 0;
  actor.y = Number(data.y) || fallbackY;
  actor.vx = Number(data.vx) || 0;
  actor.vy = Number(data.vy) || 0;
  actor.cooldown = Number(data.cooldown) || 0;
  actor.energy = Number(data.energy) || 0;
  if (data.characterId) actor.characterId = characterById(data.characterId).id;
}

function applyOnlineActorMeta(actor, data) {
  if (!data) return;
  actor.cooldown = Number(data.cooldown) || 0;
  actor.energy = Number(data.energy) || 0;
  if (data.characterId) actor.characterId = characterById(data.characterId).id;
}

function netClampY(y, playerId) {
  return playerId === "p1"
    ? clamp(y, NET_PHYS.p1YMin, NET_PHYS.p1YMax)
    : clamp(y, NET_PHYS.p2YMin, NET_PHYS.p2YMax);
}

// Local player prediction: run the same movement model as the server so the
// local racket responds on the very next frame instead of after a round trip.
function netPredictLocal(dt) {
  if (ONLINE.role !== "player" || (ONLINE.playerId !== "p1" && ONLINE.playerId !== "p2")) return;
  if (state.phase === "waiting") return; // server is not simulating players yet
  const localId = ONLINE.playerId;
  const actor = localId === "p1" ? player : ai;
  const payload = onlineInputPayload(); // already in server coordinates
  let ix = (payload.right ? 1 : 0) - (payload.left ? 1 : 0);
  let iy = (payload.down ? 1 : 0) - (payload.up ? 1 : 0);
  const mag = Math.hypot(ix, iy);
  if (mag > 1) {
    ix /= mag;
    iy /= mag;
  }
  if (ix || iy) {
    actor.vx += ix * NET_PHYS.accel * dt;
    actor.vy += iy * NET_PHYS.accel * dt;
  } else {
    const v = Math.hypot(actor.vx, actor.vy);
    if (v > 0) {
      const nextV = Math.max(0, v - NET_PHYS.friction * dt);
      actor.vx *= nextV / v;
      actor.vy *= nextV / v;
    }
  }
  const speed = Math.hypot(actor.vx, actor.vy);
  if (speed > NET_PHYS.speed) {
    actor.vx = (actor.vx / speed) * NET_PHYS.speed;
    actor.vy = (actor.vy / speed) * NET_PHYS.speed;
  }
  actor.x = clamp(actor.x + actor.vx * dt, NET_PHYS.xMin, NET_PHYS.xMax);
  actor.y = netClampY(actor.y + actor.vy * dt, localId);

  // Bleed pending server correction into the predicted position.
  const k = 1 - Math.exp(-NET_TUNE.correctRate * dt);
  if (NET_SIM.corrX || NET_SIM.corrY) {
    actor.x = clamp(actor.x + NET_SIM.corrX * k, NET_PHYS.xMin, NET_PHYS.xMax);
    actor.y = netClampY(actor.y + NET_SIM.corrY * k, localId);
    NET_SIM.corrX *= 1 - k;
    NET_SIM.corrY *= 1 - k;
    if (Math.abs(NET_SIM.corrX) < 0.01) NET_SIM.corrX = 0;
    if (Math.abs(NET_SIM.corrY) < 0.01) NET_SIM.corrY = 0;
  }

  const now = performance.now();
  NET_SIM.predHistory.push({ t: now, x: actor.x, y: actor.y });
  while (NET_SIM.predHistory.length && NET_SIM.predHistory[0].t < now - 1200) {
    NET_SIM.predHistory.shift();
  }
}

// Compare the authoritative position against where we predicted ourselves to
// be roughly when the server sampled it, then queue a smooth correction.
function netReconcile(actor, data, localId) {
  if (!data) return;
  const sx = Number(data.x) || 0;
  const sy = Number(data.y) || 0;
  actor.cooldown = Number(data.cooldown) || 0;
  const history = NET_SIM.predHistory;
  if (!history.length) {
    actor.x = sx;
    actor.y = sy;
    actor.vx = Number(data.vx) || 0;
    actor.vy = Number(data.vy) || 0;
    return;
  }
  const lagMs = clamp(((ONLINE.rttMs ?? 140) / 2) + 10, 20, 280);
  const target = ONLINE.snapshotAt - lagMs;
  let past = history[0];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].t <= target) {
      past = history[i];
      break;
    }
  }
  const ex = sx - past.x;
  const ey = sy - past.y;
  if (Math.hypot(ex, ey) > NET_TUNE.snapDist) {
    actor.x = sx;
    actor.y = sy;
    actor.vx = Number(data.vx) || 0;
    actor.vy = Number(data.vy) || 0;
    NET_SIM.corrX = 0;
    NET_SIM.corrY = 0;
    NET_SIM.predHistory.length = 0;
  } else {
    NET_SIM.corrX = ex;
    NET_SIM.corrY = ey;
  }
}

// Remote player: render ~interpDelayMs in the past, lerping between the two
// snapshots that bracket the render time. Falls back to short extrapolation.
function netSampleRemote() {
  if (ONLINE.playerId !== "p1" && ONLINE.playerId !== "p2") return;
  const snaps = NET_SIM.snapshots;
  if (!snaps.length) return;
  const remoteId = ONLINE.playerId === "p1" ? "p2" : "p1";
  const actor = remoteId === "p1" ? player : ai;
  const renderT = performance.now() - NET_TUNE.interpDelayMs;
  let older = null;
  let newer = null;
  for (let i = snaps.length - 1; i >= 0; i -= 1) {
    if (snaps[i].at <= renderT) {
      older = snaps[i];
      newer = snaps[i + 1] || null;
      break;
    }
  }
  if (!older) {
    older = snaps[0];
    newer = null;
  }
  const a = older.players?.[remoteId];
  if (!a) return;
  if (newer && newer.players?.[remoteId]) {
    const b = newer.players[remoteId];
    const span = Math.max(1, newer.at - older.at);
    const t = clamp((renderT - older.at) / span, 0, 1);
    actor.x = lerp(Number(a.x) || 0, Number(b.x) || 0, t);
    actor.y = lerp(Number(a.y) || 0, Number(b.y) || 0, t);
    actor.vx = Number(b.vx) || 0;
    actor.vy = Number(b.vy) || 0;
  } else {
    const aheadS = clamp(renderT - older.at, 0, NET_TUNE.maxExtrapolateMs) / 1000;
    actor.x = clamp((Number(a.x) || 0) + (Number(a.vx) || 0) * aheadS, NET_PHYS.xMin, NET_PHYS.xMax);
    actor.y = netClampY((Number(a.y) || 0) + (Number(a.vy) || 0) * aheadS, remoteId);
    actor.vx = Number(a.vx) || 0;
    actor.vy = Number(a.vy) || 0;
  }
}

// Ball: dead-reckon forward from the newest snapshot using the same physics
// as the server, compensating snapshot age (~RTT/2 + broadcast gap).
function netSampleBall() {
  const snaps = NET_SIM.snapshots;
  if (!snaps.length) return;
  const latest = snaps[snaps.length - 1];
  const src = latest.ball;
  if (!src) return;
  ball.inPlay = !!src.inPlay;
  ball.bounceCount = src.bounceCount ?? 0;
  if (!ball.inPlay) {
    ball.x = Number(src.x) || 0;
    ball.y = Number(src.y) || 0;
    ball.z = Number(src.z) || 0;
    ball.vx = 0;
    ball.vy = 0;
    ball.vz = 0;
    ball.lastY = ball.y;
    ball.trail.length = 0;
    return;
  }
  let x = Number(src.x) || 0;
  let y = Number(src.y) || 0;
  let z = Number(src.z) || 0;
  let vx = Number(src.vx) || 0;
  let vy = Number(src.vy) || 0;
  let vz = Number(src.vz) || 0;
  let ageS = clamp(performance.now() - latest.at, 0, NET_TUNE.maxExtrapolateMs) / 1000;
  const step = 1 / 120;
  while (ageS > 0) {
    const dt = Math.min(step, ageS);
    ageS -= dt;
    vz -= NET_PHYS.gravity * dt;
    x += vx * dt;
    y += vy * dt;
    z += vz * dt;
    if (z <= 0) {
      z = 0;
      vz = Math.max(2.1, -vz * NET_PHYS.bounce);
      vx *= NET_PHYS.floorDrag;
      vy *= NET_PHYS.floorDrag;
    }
  }
  ball.lastY = ball.y;
  ball.x = x;
  ball.y = y;
  ball.z = z;
  ball.vx = vx;
  ball.vy = vy;
  ball.vz = vz;
  ball.trail.unshift({ x, y, z });
  if (ball.trail.length > 18) ball.trail.pop();
}

function controlLayout() {
  if (IS_PORTRAIT) {
    const actionSize = 42;
    const actionGap = 12;
    const actionY = 144;
    const actionRight = W - 32;
    const actionX = actionRight - actionSize * 3 - actionGap * 2;
    const themeX = 32;
    const controlY = H - 118;
    return {
      stick: { x: 86, y: controlY, radius: 58, knob: 34, hot: 82 },
      special: { x: W - 196, y: controlY, radius: 42, hot: 72 },
      racket: { x: W - 76, y: controlY, radius: 62, hot: 78 },
      energy: { x: W - 38, y: H - 292, width: 24, height: 202 },
      actions: {
        home: { x: actionX, y: actionY, width: actionSize, height: actionSize },
        reset: { x: actionX + actionSize + actionGap, y: actionY, width: actionSize, height: actionSize },
        pause: { x: actionX + (actionSize + actionGap) * 2, y: actionY, width: actionSize, height: actionSize },
      },
      themes: [
        { x: themeX, y: actionY, size: actionSize },
        { x: themeX + actionSize + actionGap, y: actionY, size: actionSize },
        { x: themeX + (actionSize + actionGap) * 2, y: actionY, size: actionSize },
        { x: themeX + (actionSize + actionGap) * 3, y: actionY, size: actionSize },
      ],
    };
  }
  const actionSize = 48;
  const actionGap = 14;
  const actionY = 116;
  const actionRight = W - 54;
  const actionX = actionRight - actionSize * 3 - actionGap * 2;
  const themeX = 54;
  const controlY = 612;
  return {
    stick: { x: 130, y: controlY, radius: 66, knob: 38, hot: 92 },
    special: { x: 660, y: controlY, radius: 48, hot: 78 },
    racket: { x: 824, y: controlY, radius: 72, hot: 88 },
    energy: { x: 902, y: 498, width: 28, height: 168 },
    actions: {
      home: { x: actionX, y: actionY, width: actionSize, height: actionSize },
      reset: { x: actionX + actionSize + actionGap, y: actionY, width: actionSize, height: actionSize },
      pause: { x: actionX + (actionSize + actionGap) * 2, y: actionY, width: actionSize, height: actionSize },
    },
    themes: [
      { x: themeX, y: actionY, size: actionSize },
      { x: themeX + actionSize + actionGap, y: actionY, size: actionSize },
      { x: themeX + (actionSize + actionGap) * 2, y: actionY, size: actionSize },
      { x: themeX + (actionSize + actionGap) * 3, y: actionY, size: actionSize },
    ],
  };
}

function modeSelectLayout() {
  const buttonWidth = IS_PORTRAIT ? Math.min(W - 86, 380) : 420;
  const buttonHeight = IS_PORTRAIT ? 86 : 74;
  const x = Math.round((W - buttonWidth) / 2);
  const y = IS_PORTRAIT ? 548 : 472;
  const gap = IS_PORTRAIT ? 24 : 18;
  const shortcutWidth = 128;
  const shortcutHeight = 30;
  return {
    titleY: IS_PORTRAIT ? 122 : 92,
    characterY: IS_PORTRAIT ? 332 : 286,
    character: {
      x: Math.round(W / 2 - 82),
      y: IS_PORTRAIT ? 226 : 190,
      width: 164,
      height: 190,
    },
    buttons: [
      {
        id: "onePlayer",
        x,
        y,
        width: buttonWidth,
        height: buttonHeight,
        label: "ONE PLAYER",
        subLabel: "SOLO MATCH",
        assetKey: "onePlayer",
      },
      {
        id: "twoPlayer",
        x,
        y: y + buttonHeight + gap,
        width: buttonWidth,
        height: buttonHeight,
        label: "TWO PLAYER",
        subLabel: "ONLINE ROOM",
        assetKey: "twoPlayer",
      },
    ],
    shortcuts: {
      x: Math.round(W / 2 - shortcutWidth / 2),
      y: y + buttonHeight * 2 + gap + (IS_PORTRAIT ? 34 : 30),
      width: shortcutWidth,
      height: shortcutHeight,
    },
  };
}

function shortcutsLayout() {
  const width = IS_PORTRAIT ? W - 70 : 480;
  const height = IS_PORTRAIT ? 518 : 432;
  const x = Math.round((W - width) / 2);
  const y = IS_PORTRAIT ? 206 : 162;
  return {
    box: { x, y, width, height },
    back: { x: x + 18, y: y + height - 58, width: 112, height: 38 },
  };
}

function pauseMenuLayout() {
  const width = IS_PORTRAIT ? W - 84 : 420;
  const height = IS_PORTRAIT ? 226 : 210;
  const x = Math.round((W - width) / 2);
  const y = IS_PORTRAIT ? 318 : 252;
  const buttonWidth = IS_PORTRAIT ? 176 : 168;
  const buttonHeight = 58;
  const gap = 22;
  const buttonY = y + height - 86;
  return {
    box: { x, y, width, height },
    continue: {
      x: Math.round(x + width / 2 - buttonWidth - gap / 2),
      y: buttonY,
      width: buttonWidth,
      height: buttonHeight,
    },
    home: {
      x: Math.round(x + width / 2 + gap / 2),
      y: buttonY,
      width: buttonWidth,
      height: buttonHeight,
    },
  };
}

function characterPanelLayout() {
  const width = IS_PORTRAIT ? W - 76 : 520;
  const height = IS_PORTRAIT ? 348 : 318;
  const x = Math.round((W - width) / 2);
  const y = IS_PORTRAIT ? 306 : 236;
  const slotSize = IS_PORTRAIT ? 70 : 62;
  const gap = IS_PORTRAIT ? 14 : 12;
  const gridWidth = slotSize * 4 + gap * 3;
  const startX = Math.round(x + (width - gridWidth) / 2);
  const startY = y + 86;
  const page = CHARACTER_SELECT.page;
  const pageCount = characterPageCount();
  const pageStart = page * CHARACTER_PAGE_SIZE;
  const pageCharacters = CHARACTERS.slice(pageStart, pageStart + CHARACTER_PAGE_SIZE);
  const slots = pageCharacters.map((character, offset) => {
    const index = pageStart + offset;
    const col = offset % 4;
    const row = Math.floor(offset / 4);
    return {
      id: character.id,
      index,
      x: startX + col * (slotSize + gap),
      y: startY + row * (slotSize + gap),
      width: slotSize,
      height: slotSize,
    };
  });
  return {
    box: { x, y, width, height },
    close: { x: x + width - 88, y: y + 18, width: 64, height: 34 },
    page,
    pageCount,
    pageLabel: { x: Math.round(x + width / 2), y: y + 70 },
    prev: { x: x + 28, y: y + height - 56, width: 56, height: 38, disabled: page <= 0 },
    next: { x: x + width - 84, y: y + height - 56, width: 56, height: 38, disabled: page >= pageCount - 1 },
    confirm: { x: Math.round(x + width / 2 - 92), y: y + height - 58, width: 184, height: 42 },
    slots,
  };
}

function twoPlayerSetupLayout() {
  const panelWidth = IS_PORTRAIT ? W - 72 : 470;
  const panelX = Math.round((W - panelWidth) / 2);
  const titleY = IS_PORTRAIT ? 112 : 84;
  const cardHeight = IS_PORTRAIT ? 74 : 66;
  const cardGap = IS_PORTRAIT ? 16 : 12;
  const firstCardY = IS_PORTRAIT ? 318 : 256;
  const inputY = firstCardY + cardHeight * 2 + cardGap * 2 + 10;
  const cardWidth = panelWidth - 24;
  return {
    titleY,
    back: { x: panelX + 8, y: IS_PORTRAIT ? 78 : 62, width: 76, height: 38 },
    cards: [
      {
        id: "create",
        x: panelX + 12,
        y: firstCardY,
        width: cardWidth,
        height: cardHeight,
        label: "CREATE ROOM",
        subLabel: "AUTO CODE",
      },
      {
        id: "join",
        x: panelX + 12,
        y: firstCardY + cardHeight + cardGap,
        width: cardWidth,
        height: cardHeight,
        label: "JOIN ROOM",
        subLabel: "FRIEND CODE",
      },
    ],
    input: {
      x: panelX + 12,
      y: inputY,
      width: cardWidth,
      height: 64,
    },
  };
}

function tryModeSelectClick(p) {
  const layout = modeSelectLayout();
  if (pointInRect(p, layout.character)) {
    openCharacterPanel();
    return true;
  }
  if (pointInRect(p, layout.shortcuts)) {
    openShortcuts();
    return true;
  }
  for (let i = 0; i < layout.buttons.length; i += 1) {
    const button = layout.buttons[i];
    if (pointInRect(p, button)) {
      APP_FLOW.menuChoice = i;
      startModeSelection(button.id);
      return true;
    }
  }
  return false;
}

function tryShortcutsClick(p) {
  const layout = shortcutsLayout();
  if (pointInRect(p, layout.back)) {
    returnToModeSelect();
    return true;
  }
  return pointInRect(p, layout.box);
}

function tryCharacterPanelClick(p) {
  if (!CHARACTER_SELECT.panelOpen) return false;
  const layout = characterPanelLayout();
  if (pointInRect(p, layout.close)) {
    CHARACTER_SELECT.panelOpen = false;
    return true;
  }
  if (pointInRect(p, layout.prev)) {
    if (!layout.prev.disabled) setCharacterPanelPage(layout.page - 1);
    return true;
  }
  if (pointInRect(p, layout.next)) {
    if (!layout.next.disabled) setCharacterPanelPage(layout.page + 1);
    return true;
  }
  if (pointInRect(p, layout.confirm)) {
    if (setSelectedCharacterIndex(CHARACTER_SELECT.panelChoice)) {
      CHARACTER_SELECT.panelOpen = false;
    }
    return true;
  }
  for (const slot of layout.slots) {
    if (pointInRect(p, slot)) {
      if (CHARACTERS[slot.index]?.unlocked) {
        CHARACTER_SELECT.panelChoice = slot.index;
      }
      return true;
    }
  }
  return pointInRect(p, layout.box);
}

function tryTwoPlayerSetupClick(p) {
  const layout = twoPlayerSetupLayout();
  if (pointInRect(p, layout.back)) {
    returnToModeSelect();
    return true;
  }
  for (let i = 0; i < layout.cards.length; i += 1) {
    const card = layout.cards[i];
    if (pointInRect(p, card)) {
      APP_FLOW.twoPlayerChoice = i;
      runTwoPlayerSetupChoice(card.id);
      return true;
    }
  }
  if (pointInRect(p, layout.input)) {
    if (APP_FLOW.twoPlayerChoice === 0) APP_FLOW.twoPlayerChoice = 1;
    APP_FLOW.roomCodeMode = "join";
    focusRoomCodeNativeInput(layout.input);
    return true;
  }
  return false;
}

function tryPauseMenuClick(p) {
  if (!APP_FLOW.pauseMenuOpen) return false;
  const layout = pauseMenuLayout();
  if (pointInRect(p, layout.continue)) {
    continueFromPauseMenu();
    return true;
  }
  if (pointInRect(p, layout.home)) {
    returnToModeSelect();
    return true;
  }
  return pointInRect(p, layout.box);
}

function tryHomeActionClick(p, controls) {
  if (pointInRect(p, controls.actions.home)) {
    returnToModeSelect();
    return true;
  }
  return false;
}

function updateMenuChoiceFromPointer(p) {
  const layout = modeSelectLayout();
  for (let i = 0; i < layout.buttons.length; i += 1) {
    if (pointInRect(p, layout.buttons[i])) {
      APP_FLOW.menuChoice = i;
      return;
    }
  }
}

function updateCharacterPanelChoiceFromPointer(p) {
  if (!CHARACTER_SELECT.panelOpen) return;
  const layout = characterPanelLayout();
  for (const slot of layout.slots) {
    if (pointInRect(p, slot)) {
      CHARACTER_SELECT.hoverIndex = slot.index;
      return;
    }
  }
  CHARACTER_SELECT.hoverIndex = -1;
}

function updateTwoPlayerChoiceFromPointer(p) {
  const layout = twoPlayerSetupLayout();
  for (let i = 0; i < layout.cards.length; i += 1) {
    if (pointInRect(p, layout.cards[i])) {
      APP_FLOW.twoPlayerChoice = i;
      return;
    }
  }
}

function startSelectedMenuMode() {
  const layout = modeSelectLayout();
  const choice = layout.buttons[APP_FLOW.menuChoice] || layout.buttons[0];
  startModeSelection(choice.id);
}

function startModeSelection(mode) {
  if (mode === "twoPlayer") {
    openTwoPlayerSetup();
    return;
  }
  startOnePlayerMode();
}

function openShortcuts() {
  APP_FLOW.screen = "shortcuts";
  APP_FLOW.pauseMenuOpen = false;
  CHARACTER_SELECT.panelOpen = false;
  clearGameplayInput();
}

function openTwoPlayerSetup() {
  APP_FLOW.screen = "twoPlayerSetup";
  APP_FLOW.selectedMode = "twoPlayer";
  APP_FLOW.pauseMenuOpen = false;
  APP_FLOW.twoPlayerChoice = 0;
  APP_FLOW.roomCodeMode = "join";
  clearGameplayInput();
}

function runSelectedTwoPlayerSetupChoice() {
  const layout = twoPlayerSetupLayout();
  const choiceIndex = APP_FLOW.roomCodeInput && APP_FLOW.twoPlayerChoice === 0 ? 1 : APP_FLOW.twoPlayerChoice;
  const choice = layout.cards[choiceIndex] || layout.cards[0];
  runTwoPlayerSetupChoice(choice.id);
}

function runTwoPlayerSetupChoice(id) {
  if (id === "create") {
    startTwoPlayerMode("");
    return;
  }
  APP_FLOW.roomCodeMode = "join";
  const code = normalizeRoomCodeInput(APP_FLOW.roomCodeInput);
  APP_FLOW.roomCodeInput = code;
  if (code) {
    startTwoPlayerMode(code);
  }
}

function normalizeRoomCodeInput(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function syncRoomCodeNativeValue() {
  if (!roomCodeNativeInput) return;
  const code = normalizeRoomCodeInput(APP_FLOW.roomCodeInput);
  if (roomCodeNativeInput.value !== code) roomCodeNativeInput.value = code;
}

function positionRoomCodeNativeInput(box) {
  if (!roomCodeNativeInput || !box) return;
  const rect = canvas.getBoundingClientRect();
  const left = rect.left + (box.x / W) * rect.width;
  const top = rect.top + (box.y / H) * rect.height;
  const width = (box.width / W) * rect.width;
  const height = (box.height / H) * rect.height;
  roomCodeNativeInput.style.left = `${Math.round(left)}px`;
  roomCodeNativeInput.style.top = `${Math.round(top)}px`;
  roomCodeNativeInput.style.width = `${Math.round(width)}px`;
  roomCodeNativeInput.style.height = `${Math.round(height)}px`;
}

function focusRoomCodeNativeInput(box) {
  if (!roomCodeNativeInput) return;
  APP_FLOW.roomCodeMode = "join";
  syncRoomCodeNativeValue();
  positionRoomCodeNativeInput(box);
  roomCodeNativeInput.classList.add("room-code-native-input--active");
  try {
    roomCodeNativeInput.focus({ preventScroll: true });
  } catch {
    roomCodeNativeInput.focus();
  }
  const end = roomCodeNativeInput.value.length;
  try {
    roomCodeNativeInput.setSelectionRange(end, end);
  } catch {
    // Some mobile keyboards do not expose selection APIs for every input mode.
  }
}

function blurRoomCodeNativeInput() {
  if (!roomCodeNativeInput) return;
  roomCodeNativeInput.classList.remove("room-code-native-input--active");
  roomCodeNativeInput.style.left = "0px";
  roomCodeNativeInput.style.top = "0px";
  roomCodeNativeInput.style.width = "1px";
  roomCodeNativeInput.style.height = "1px";
  if (document.activeElement === roomCodeNativeInput) roomCodeNativeInput.blur();
}

function appendRoomCodeInput(key) {
  if (!/^[a-z0-9]$/i.test(key)) return false;
  APP_FLOW.roomCodeInput = normalizeRoomCodeInput(`${APP_FLOW.roomCodeInput}${key}`);
  syncRoomCodeNativeValue();
  if (APP_FLOW.twoPlayerChoice === 0) APP_FLOW.twoPlayerChoice = 1;
  return true;
}

function trimRoomCodeInput() {
  APP_FLOW.roomCodeInput = APP_FLOW.roomCodeInput.slice(0, -1);
  syncRoomCodeNativeValue();
}

if (roomCodeNativeInput) {
  roomCodeNativeInput.addEventListener("input", () => {
    const code = normalizeRoomCodeInput(roomCodeNativeInput.value);
    APP_FLOW.roomCodeInput = code;
    if (roomCodeNativeInput.value !== code) roomCodeNativeInput.value = code;
    if (APP_FLOW.twoPlayerChoice === 0) APP_FLOW.twoPlayerChoice = 1;
    APP_FLOW.roomCodeMode = "join";
  });
  roomCodeNativeInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    const key = keyCode(event.key);
    if (!isTwoPlayerSetupOpen()) return;
    if (key === "enter") {
      event.preventDefault();
      runSelectedTwoPlayerSetupChoice();
    } else if (key === "escape") {
      event.preventDefault();
      returnToModeSelect();
    }
  });
  roomCodeNativeInput.addEventListener("blur", () => {
    roomCodeNativeInput.classList.remove("room-code-native-input--active");
  });
}

function startOnePlayerMode() {
  blurRoomCodeNativeInput();
  APP_FLOW.screen = "game";
  APP_FLOW.selectedMode = "onePlayer";
  APP_FLOW.pauseMenuOpen = false;
  player.characterId = selectedCharacterId();
  ai.characterId = chooseOpponentCharacterId(player.characterId);
  clearGameplayInput();
  resetMatch();
}

function startTwoPlayerMode(roomCode = "") {
  blurRoomCodeNativeInput();
  const normalizedRoomCode = normalizeRoomCodeInput(roomCode);
  APP_FLOW.selectedMode = "twoPlayer";
  APP_FLOW.pauseMenuOpen = false;
  player.characterId = selectedCharacterId();
  ai.characterId = "zenitsu";
  if (shouldRedirectToOnlineProduction()) {
    navigateToProductionOnline(normalizedRoomCode);
    return;
  }
  APP_FLOW.screen = "game";
  clearGameplayInput();
  setOnlineModeInUrl(normalizedRoomCode);
  ONLINE.enabled = true;
  ONLINE.status = "connecting";
  ONLINE.socket = null;
  ONLINE.serverUrl = "";
  ONLINE.room = normalizedRoomCode || new URLSearchParams(window.location.search).get("room") || "";
  ONLINE.playerId = null;
  ONLINE.role = null;
  ONLINE.lastInputSent = 0;
  ONLINE.lastInputAt = 0;
  ONLINE.lastPingAt = 0;
  ONLINE.lastPongAt = 0;
  ONLINE.rttMs = null;
  ONLINE.reconnectAt = 0;
  ONLINE.snapshotAt = 0;
  ONLINE.message = "";
  initOnlineMode();
}

function returnToModeSelect() {
  blurRoomCodeNativeInput();
  APP_FLOW.screen = "menu";
  APP_FLOW.pauseMenuOpen = false;
  APP_FLOW.selectedMode = "onePlayer";
  APP_FLOW.twoPlayerChoice = 0;
  APP_FLOW.roomCodeInput = "";
  APP_FLOW.roomCodeMode = "join";
  closeOnlineConnection();
  clearOnlineModeInUrl();
  clearGameplayInput();
  resetMatch();
}

function closeOnlineConnection() {
  const socket = ONLINE.socket;
  ONLINE.enabled = false;
  ONLINE.status = "off";
  ONLINE.socket = null;
  ONLINE.serverUrl = "";
  ONLINE.room = "";
  ONLINE.playerId = null;
  ONLINE.role = null;
  ONLINE.lastInputSent = 0;
  ONLINE.lastInputAt = 0;
  ONLINE.lastPingAt = 0;
  ONLINE.lastPongAt = 0;
  ONLINE.rttMs = null;
  ONLINE.reconnectAt = 0;
  ONLINE.snapshotAt = 0;
  ONLINE.message = "";
  if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
    socket.close();
  }
}

function shouldRedirectToOnlineProduction() {
  if (new URLSearchParams(window.location.search).get("server")) return false;
  return location.protocol === "file:" || location.hostname.endsWith("github.io");
}

function navigateToProductionOnline(roomCode = "") {
  const url = new URL(ONLINE_PRODUCTION_ORIGIN);
  url.searchParams.set("mode", "online");
  const code = normalizeRoomCodeInput(roomCode);
  if (code) url.searchParams.set("room", code);
  url.searchParams.set("character", selectedCharacterId());
  window.location.assign(url.toString());
}

function setOnlineModeInUrl(roomCode = "") {
  if (!window.history || !window.history.pushState) return;
  const url = new URL(window.location.href);
  url.searchParams.set("mode", "online");
  const code = normalizeRoomCodeInput(roomCode);
  if (code) url.searchParams.set("room", code);
  else url.searchParams.delete("room");
  url.searchParams.delete("previewResult");
  window.history.pushState(null, "", url);
}

function clearOnlineModeInUrl() {
  if (!window.history || !window.history.pushState) return;
  const url = new URL(window.location.href);
  url.searchParams.delete("mode");
  url.searchParams.delete("room");
  url.searchParams.delete("debug");
  url.searchParams.delete("character");
  url.searchParams.delete("previewResult");
  window.history.pushState(null, "", url);
}

function clearGameplayInput() {
  input.left = false;
  input.right = false;
  input.up = false;
  input.down = false;
  input.hit = false;
  input.hitArmed = true;
  input.hitHold = 0;
  input.hitQueued = false;
  input.hitQueueTimer = 0;
  input.hitPulse = 0;
  input.specialPulse = 0;
  input.queuedSpecial = false;
  input.aim = 0;
  input.pointerId = null;
  input.stickPointerId = null;
  input.stick.x = 0;
  input.stick.y = 0;
  input.mouseAim = null;
}

window.addEventListener("keydown", (event) => {
  const key = keyCode(event.key);
  if (["arrowleft", "arrowright", "arrowup", "arrowdown", " ", "enter", "backspace", "escape"].includes(key)) {
    event.preventDefault();
  }
  if (isShortcutsOpen()) {
    if (key === "escape" || key === "backspace" || key === "h" || key === " " || key === "enter") {
      returnToModeSelect();
    }
    return;
  }
  if (isMenuOpen()) {
    if (CHARACTER_SELECT.panelOpen) {
      if (key === "escape" || key === "c") {
        CHARACTER_SELECT.panelOpen = false;
      } else if (key === "arrowleft" || key === "a") {
        moveCharacterPanelChoice(-1);
      } else if (key === "arrowright" || key === "d") {
        moveCharacterPanelChoice(1);
      } else if (key === "arrowup" || key === "w") {
        moveCharacterPanelChoice(-4);
      } else if (key === "arrowdown" || key === "s") {
        moveCharacterPanelChoice(4);
      } else if (key === " " || key === "enter") {
        if (setSelectedCharacterIndex(CHARACTER_SELECT.panelChoice)) {
          CHARACTER_SELECT.panelOpen = false;
        }
      }
      return;
    }
    if (key === "arrowup" || key === "w") {
      APP_FLOW.menuChoice = Math.max(0, APP_FLOW.menuChoice - 1);
    } else if (key === "arrowdown" || key === "s") {
      APP_FLOW.menuChoice = Math.min(1, APP_FLOW.menuChoice + 1);
    } else if (key === "arrowleft" || key === "a") {
      cycleSelectedCharacter(-1);
    } else if (key === "arrowright" || key === "d") {
      cycleSelectedCharacter(1);
    } else if (key === "c") {
      openCharacterPanel();
    } else if (key === "h") {
      openShortcuts();
    } else if (key === "1") {
      APP_FLOW.menuChoice = 0;
      startModeSelection("onePlayer");
    } else if (key === "2") {
      APP_FLOW.menuChoice = 1;
      startModeSelection("twoPlayer");
    } else if (key === " " || key === "enter") {
      startSelectedMenuMode();
    }
    return;
  }
  if (isTwoPlayerSetupOpen()) {
    if (key === "escape" || key === "h") {
      returnToModeSelect();
    } else if (key === "arrowup" || key === "w") {
      APP_FLOW.twoPlayerChoice = Math.max(0, APP_FLOW.twoPlayerChoice - 1);
      if (APP_FLOW.twoPlayerChoice > 0) APP_FLOW.roomCodeMode = "join";
    } else if (key === "arrowdown" || key === "s") {
      APP_FLOW.twoPlayerChoice = Math.min(1, APP_FLOW.twoPlayerChoice + 1);
      if (APP_FLOW.twoPlayerChoice > 0) APP_FLOW.roomCodeMode = "join";
    } else if (key === "backspace") {
      if (APP_FLOW.roomCodeInput) trimRoomCodeInput();
      else returnToModeSelect();
    } else if (key === " " || key === "enter") {
      runSelectedTwoPlayerSetupChoice();
    } else if (appendRoomCodeInput(key)) {
      APP_FLOW.roomCodeMode = "join";
    }
    return;
  }
  if (APP_FLOW.pauseMenuOpen) {
    if (key === "escape" || key === "p" || key === " " || key === "enter") {
      continueFromPauseMenu();
    } else if (key === "h" || key === "m" || key === "backspace") {
      returnToModeSelect();
    }
    return;
  }
  if (state.phase === "matchOver") {
    if (key === "r") {
      replayResult();
    } else if (key === " " || key === "enter" || key === "c") {
      continueResult();
    }
    return;
  }
  if (key === "a" || key === "arrowleft") input.left = true;
  if (key === "d" || key === "arrowright") input.right = true;
  if (key === "w" || key === "arrowup") input.up = true;
  if (key === "s" || key === "arrowdown") input.down = true;
  if (key === "r") resetMatch();
  if (key === "p") togglePause();
  if (key === "1") setTheme(0);
  if (key === "2") setTheme(1);
  if (key === "3") setTheme(2);
  if (key === "4") setTheme(3);
  if (key === "e") {
    if (input.hitArmed) {
      queueSpecialHit();
      input.hitArmed = false;
    }
  }
  if (key === " " || key === "enter") {
    if (input.hitArmed) {
      queueHit({ hold: 0, special: false });
      input.hitArmed = false;
    }
  }
});

window.addEventListener("keyup", (event) => {
  const key = keyCode(event.key);
  if (key === "a" || key === "arrowleft") input.left = false;
  if (key === "d" || key === "arrowright") input.right = false;
  if (key === "w" || key === "arrowup") input.up = false;
  if (key === "s" || key === "arrowdown") input.down = false;
  if (key === " " || key === "enter" || key === "e") {
    input.hit = false;
    input.hitArmed = true;
  }
});

canvas.addEventListener("pointerdown", (event) => {
  const p = pointerToCanvas(event);
  if (isShortcutsOpen()) {
    if (tryShortcutsClick(p)) APP_FLOW.suppressNextClick = true;
    return;
  }
  if (isMenuOpen()) {
    if (tryCharacterPanelClick(p)) {
      APP_FLOW.suppressNextClick = true;
      return;
    }
    if (tryModeSelectClick(p)) APP_FLOW.suppressNextClick = true;
    return;
  }
  if (isTwoPlayerSetupOpen()) {
    if (tryTwoPlayerSetupClick(p)) APP_FLOW.suppressNextClick = true;
    return;
  }
  const controls = controlLayout();
  canvas.setPointerCapture(event.pointerId);
  if (tryPauseMenuClick(p)) {
    APP_FLOW.suppressNextClick = true;
    return;
  }
  if (tryHomeActionClick(p, controls)) {
    APP_FLOW.suppressNextClick = true;
    return;
  }
  if (state.phase === "matchOver") return;
  if (tryHudActionClick(p, controls)) {
    APP_FLOW.suppressNextClick = true;
    return;
  }
  if (tryThemeClick(p, controls)) {
    APP_FLOW.suppressNextClick = true;
    return;
  }
  if (distance2(p.x, p.y, controls.stick.x, controls.stick.y) < controls.stick.hot * controls.stick.hot) {
    input.stickPointerId = event.pointerId;
    setStickFromPointer(p);
    return;
  }
  const attackControl = attackControlAt(p, controls);
  if (attackControl === "special") {
    input.pointerId = event.pointerId;
    queueSpecialHit();
    APP_FLOW.suppressNextClick = true;
    return;
  }
  if (attackControl === "racket") {
    input.pointerId = event.pointerId;
    queueHit({ hold: 0, special: false });
    APP_FLOW.suppressNextClick = true;
    return;
  }
  input.mouseAim = screenToWorld(p.x, p.y);
});

canvas.addEventListener("click", (event) => {
  if (APP_FLOW.suppressNextClick) {
    APP_FLOW.suppressNextClick = false;
    return;
  }
  const p = pointerToCanvas(event);
  if (isShortcutsOpen()) {
    tryShortcutsClick(p);
    return;
  }
  if (isMenuOpen()) {
    if (tryCharacterPanelClick(p)) return;
    tryModeSelectClick(p);
    return;
  }
  if (isTwoPlayerSetupOpen()) {
    tryTwoPlayerSetupClick(p);
    return;
  }
  const controls = controlLayout();
  if (tryPauseMenuClick(p)) return;
  if (tryHomeActionClick(p, controls)) return;
  if (state.phase === "matchOver") {
    tryResultActionClick(p);
    return;
  }
  if (tryHudActionClick(p, controls)) return;
  if (tryThemeClick(p, controls)) return;
  const attackControl = attackControlAt(p, controls);
  if (attackControl === "special") {
    queueSpecialHit();
    releaseTapInput();
    return;
  }
  if (attackControl === "racket") {
    queueHit({ hold: 0, special: false });
    releaseTapInput();
  }
});

function tryResultActionClick(p) {
  const layout = resultLayout();
  if (pointInRect(p, layout.replay)) {
    replayResult();
    return true;
  }
  if (pointInRect(p, layout.continue)) {
    continueResult();
    return true;
  }
  return false;
}

function tryHudActionClick(p, controls) {
  if (pointInRect(p, controls.actions.reset)) {
    resetMatch();
    return true;
  }
  if (pointInRect(p, controls.actions.pause)) {
    togglePause();
    return true;
  }
  return false;
}

function tryThemeClick(p, controls) {
  for (let i = 0; i < controls.themes.length; i += 1) {
    const button = controls.themes[i];
    const cx = button.x + button.size / 2;
    const cy = button.y + button.size / 2;
    if (distance2(p.x, p.y, cx, cy) <= (button.size * 0.7) ** 2) {
      setTheme(i);
      return true;
    }
  }
  return false;
}

function pointInRect(p, rect) {
  return p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;
}

canvas.addEventListener("pointermove", (event) => {
  const p = pointerToCanvas(event);
  if (isShortcutsOpen()) return;
  if (isMenuOpen()) {
    updateCharacterPanelChoiceFromPointer(p);
    if (CHARACTER_SELECT.panelOpen) return;
    updateMenuChoiceFromPointer(p);
    return;
  }
  if (isTwoPlayerSetupOpen()) {
    updateTwoPlayerChoiceFromPointer(p);
    return;
  }
  if (event.pointerId === input.stickPointerId) {
    setStickFromPointer(p);
  } else {
    input.mouseAim = screenToWorld(p.x, p.y);
  }
});

canvas.addEventListener("pointerup", releasePointer);
canvas.addEventListener("pointercancel", releasePointer);

function releasePointer(event) {
  if (event.pointerId === input.stickPointerId) {
    input.stickPointerId = null;
    input.stick.x = 0;
    input.stick.y = 0;
  }
  if (event.pointerId === input.pointerId) {
    input.pointerId = null;
    input.hit = false;
    input.hitArmed = true;
  }
}

function releaseTapInput() {
  input.hit = false;
  input.hitArmed = true;
}

function attackControlAt(p, controls) {
  const special = controls.special;
  const racket = controls.racket;
  const inSpecial = distance2(p.x, p.y, special.x, special.y) <= special.hot * special.hot;
  const inRacket = distance2(p.x, p.y, racket.x, racket.y) <= racket.hot * racket.hot;
  const splitX = special.x + (racket.x - special.x) * 0.6;
  if (inSpecial && inRacket) {
    return p.x <= splitX ? "special" : "racket";
  }
  if (inSpecial) return "special";
  if (inRacket && p.x > splitX + 4) return "racket";
  return null;
}

function queueSpecialHit() {
  input.specialPulse = 0.34;
  if (state.energy < 100) return;
  queueHit({ hold: 0.95, special: true });
}

function queueHit({ hold = 0, special = false } = {}) {
  input.hit = true;
  input.hitHold = Math.max(input.hitHold, hold);
  input.hitQueued = true;
  input.hitQueueTimer = TUNING.player.hitBuffer;
  if (!special) input.hitPulse = 0.18;
  input.queuedSpecial = special;
  if (player.cooldown <= 0) {
    player.swing = Math.max(player.swing, 0.13);
  }
}

function pointerToCanvas(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * W,
    y: ((event.clientY - rect.top) / rect.height) * H,
  };
}

function setStickFromPointer(p) {
  const controls = controlLayout();
  const dx = p.x - controls.stick.x;
  const dy = p.y - controls.stick.y;
  const len = Math.hypot(dx, dy) || 1;
  const mag = Math.min(1, len / controls.stick.radius);
  input.stick.x = (dx / len) * mag;
  input.stick.y = (dy / len) * mag;
}

function resetMatch() {
  if (ONLINE.enabled) {
    sendOnline({ type: "action", action: "replay" });
    return;
  }
  APP_FLOW.pauseMenuOpen = false;
  state.phase = "serveWait";
  state.pausedPhase = null;
  state.pausedMessage = "";
  state.pausedMessageSub = "";
  state.result = null;
  state.resultTime = 0;
  state.timer = TUNING.match.serveDelay;
  state.message = "RIVAL SERVE";
  state.messageSub = "";
  state.server = "ai";
  state.lastHit = "ai";
  state.pointWinner = null;
  state.rallyHits = 0;
  state.maxRally = 0;
  state.playerPoints = 0;
  state.aiPoints = 0;
  state.playerGames = 0;
  state.aiGames = 0;
  state.energy = 0;
  state.playerShotPressure = 0;
  player.x = 0;
  player.y = 9.9;
  player.vx = 0;
  player.vy = 0;
  ai.x = 0;
  ai.y = -9.9;
  ai.vx = 0;
  ai.vy = 0;
  placeBallForServe();
}

function replayResult() {
  if (ONLINE.enabled) {
    sendOnline({ type: "action", action: "replay" });
    return;
  }
  resetMatch();
}

function continueResult() {
  if (ONLINE.enabled) {
    sendOnline({ type: "action", action: "continue" });
    return;
  }
  resetMatch();
}

function continueFromPauseMenu() {
  APP_FLOW.pauseMenuOpen = false;
  if (state.phase === "paused") {
    state.phase = state.pausedPhase || (ball.inPlay ? "rally" : "serveWait");
    state.message = state.pausedMessage;
    state.messageSub = state.pausedMessageSub;
    state.pausedPhase = null;
    state.pausedMessage = "";
    state.pausedMessageSub = "";
  }
}

function togglePause() {
  if (ONLINE.enabled) {
    APP_FLOW.pauseMenuOpen = !APP_FLOW.pauseMenuOpen;
    return;
  }
  if (state.phase === "paused") {
    continueFromPauseMenu();
  } else {
    APP_FLOW.pauseMenuOpen = true;
    state.pausedPhase = state.phase;
    state.pausedMessage = state.message;
    state.pausedMessageSub = state.messageSub;
    state.phase = "paused";
    state.message = "PAUSED";
    state.messageSub = "";
  }
}

function gameLoop(now) {
  let frame = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  accumulator += frame;

  while (accumulator >= TUNING.fixedDt) {
    update(TUNING.fixedDt);
    accumulator -= TUNING.fixedDt;
  }

  render();
  requestAnimationFrame(gameLoop);
}

function update(dt) {
  if (APP_FLOW.screen !== "game") return;
  if (ONLINE.enabled) {
    updateOnline(dt);
    return;
  }
  if (state.phase === "paused") return;

  state.shake = Math.max(0, state.shake - dt * 8);
  if (state.phase === "matchOver") {
    state.resultTime += dt;
    return;
  }

  updateInput(dt);
  updateActorCooldowns(player, dt);
  updateActorCooldowns(ai, dt);
  updatePlayer(dt);
  updateAi(dt);

  if (state.phase === "serveWait") {
    state.timer -= dt;
    state.message = `${state.server === "player" ? "PLAYER" : "RIVAL"} SERVE`;
    if (state.timer <= 0) {
      serve();
    }
  } else if (state.phase === "rally") {
    updateBall(dt);
    tryPlayerHit();
    tryAiHit(dt);
  } else if (state.phase === "pointOver") {
    state.timer -= dt;
    if (state.timer <= 0) {
      startNextPoint();
    }
  }
}

function updateInput(dt) {
  if (input.hit) {
    input.hitHold = Math.min(1.2, input.hitHold + dt);
  }
  if (input.hitQueued) {
    input.hitQueueTimer -= dt;
    if (input.hitQueueTimer <= 0) {
      input.hitQueued = false;
      input.queuedSpecial = false;
      if (!input.hit) input.hitHold = 0;
    }
  }
  input.hitPulse = Math.max(0, input.hitPulse - dt);
  input.specialPulse = Math.max(0, input.specialPulse - dt);
  const horizontal = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  input.aim = clamp(horizontal + input.stick.x, -1, 1);
}

function updateActorCooldowns(actor, dt) {
  actor.cooldown = Math.max(0, actor.cooldown - dt);
  actor.swing = Math.max(0, actor.swing - dt);
  actor.pose += dt;
}

function updatePlayer(dt) {
  let ix = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let iy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  ix += input.stick.x;
  iy += input.stick.y;
  const mag = Math.hypot(ix, iy);
  if (mag > 1) {
    ix /= mag;
    iy /= mag;
  }
  moveActor(player, ix, iy, TUNING.player.speed, TUNING.player.accel, TUNING.player.friction, dt);
  player.x = clamp(player.x, TUNING.player.xMin, TUNING.player.xMax);
  player.y = clamp(player.y, TUNING.player.yMin, TUNING.player.yMax);
}

function updateAi(dt) {
  if (state.phase !== "rally") return;
  ai.reactionTimer -= dt;
  if (ai.reactionTimer <= 0) {
    const pressure = aiPressureLevel();
    const trackingError = lerp(TUNING.ai.targetError * 1.25, TUNING.ai.targetError * 0.55, pressure);
    ai.predicted = predictLanding();
    ai.targetX = clamp(ai.predicted.x + rand(-trackingError, trackingError), -4.35, 4.35);
    ai.targetY = clamp(ai.predicted.y + rand(-trackingError * 0.34, trackingError * 0.34), -11.3, -1.35);
    ai.reactionTimer = Math.max(0.16, lerp(TUNING.ai.reaction + 0.06, TUNING.ai.reaction - 0.05, pressure));
  }
  const activeSide = ball.y < 0 || ball.vy < 0;
  const homeX = activeSide ? ai.targetX : lerp(ai.x, 0, 0.08);
  const homeY = activeSide ? ai.targetY : -8.7;
  const dx = homeX - ai.x;
  const dy = homeY - ai.y;
  const len = Math.hypot(dx, dy);
  moveActor(
    ai,
    len > 0.05 ? dx / len : 0,
    len > 0.05 ? dy / len : 0,
    TUNING.ai.speed,
    TUNING.ai.accel,
    TUNING.ai.friction,
    dt,
  );
  ai.x = clamp(ai.x, -4.55, 4.55);
  ai.y = clamp(ai.y, -11.55, -1.15);
}

function moveActor(actor, ix, iy, speed, accel, friction, dt) {
  if (ix || iy) {
    actor.vx += ix * accel * dt;
    actor.vy += iy * accel * dt;
  } else {
    const v = Math.hypot(actor.vx, actor.vy);
    if (v > 0) {
      const next = Math.max(0, v - friction * dt);
      actor.vx *= next / v;
      actor.vy *= next / v;
    }
  }
  const v = Math.hypot(actor.vx, actor.vy);
  if (v > speed) {
    actor.vx = (actor.vx / v) * speed;
    actor.vy = (actor.vy / v) * speed;
  }
  actor.x += actor.vx * dt;
  actor.y += actor.vy * dt;
}

function placeBallForServe() {
  const serverActor = state.server === "player" ? player : ai;
  ball.x = serverActor.x + (state.server === "player" ? -0.25 : 0.25);
  ball.y = state.server === "player" ? 10.2 : -10.2;
  ball.z = 1.0;
  ball.vx = 0;
  ball.vy = 0;
  ball.vz = 0;
  ball.bounceCount = 0;
  ball.inPlay = false;
  ball.lastY = ball.y;
  ball.trail.length = 0;
}

function serve() {
  placeBallForServe();
  ball.inPlay = true;
  state.phase = "rally";
  state.message = "";
  state.messageSub = "";
  state.rallyHits = 0;
  state.lastHit = state.server;
  state.playerShotPressure = 0;
  const target = state.server === "player"
    ? { x: rand(-2.7, 2.7), y: rand(-7.6, -5.1) }
    : { x: rand(-2.7, 2.7), y: rand(5.1, 7.6) };
  launchBallTo(target.x, target.y, TUNING.shots.serve, 1);
}

function updateBall(dt) {
  ball.lastY = ball.y;
  ball.vz -= TUNING.ball.gravity * dt;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.z += ball.vz * dt;

  ball.trail.unshift({ x: ball.x, y: ball.y, z: ball.z });
  if (ball.trail.length > 9) ball.trail.pop();

  if ((ball.lastY < 0 && ball.y >= 0) || (ball.lastY > 0 && ball.y <= 0)) {
    if (ball.z < TUNING.world.netHeight) {
      endPoint(opponentOf(state.lastHit), "NET");
      return;
    }
  }

  if (Math.abs(ball.x) > TUNING.world.xMax + 1.4 || Math.abs(ball.y) > TUNING.world.yMax + 1.6) {
    const winner = ball.bounceCount > 0 ? state.lastHit : opponentOf(state.lastHit);
    const reason = ball.bounceCount > 0 ? "DOUBLE BOUNCE" : "OUT";
    endPoint(winner, reason);
    return;
  }

  if (ball.z <= 0) {
    ball.z = 0;
    onBallBounce();
  }
}

function onBallBounce() {
  ball.bounceCount += 1;

  if (ball.bounceCount === 1) {
    const expectedSide = state.lastHit === "player" ? -1 : 1;
    const legal = isLegalBounce(expectedSide);
    if (!legal) {
      endPoint(opponentOf(state.lastHit), "OUT");
      return;
    }
  } else {
    endPoint(state.lastHit, "DOUBLE BOUNCE");
    return;
  }

  ball.vz = Math.max(2.1, -ball.vz * TUNING.ball.bounce);
  ball.vx *= TUNING.ball.floorDrag;
  ball.vy *= TUNING.ball.floorDrag;

  if (Math.hypot(ball.vx, ball.vy) < TUNING.ball.rollStopSpeed && ball.bounceCount > 0) {
    endPoint(state.lastHit, "DOUBLE BOUNCE");
  }
}

function isLegalBounce(expectedSide) {
  const sideOk = expectedSide < 0 ? ball.y < -0.08 : ball.y > 0.08;
  const xOk = Math.abs(ball.x) <= TUNING.world.singlesX + 0.04;
  const yOk = Math.abs(ball.y) <= TUNING.world.baselineY + 0.05;
  return sideOk && xOk && yOk;
}

function tryPlayerHit() {
  if ((!input.hit && !input.hitQueued) || player.cooldown > 0) return;
  if (!canActorHit(player, 1)) return;
  const quality = hitQuality(player);
  const useSpecial = input.queuedSpecial && state.energy >= 100;
  playerHit(quality, useSpecial);
}

function tryAiHit() {
  if (ai.cooldown > 0) return;
  if (!canActorHit(ai, -1)) return;
  const quality = hitQuality(ai);
  const failChance = aiFailChance(quality);
  if (chance(failChance)) {
    ai.swing = 0.16;
    ai.cooldown = TUNING.ai.hitCooldown;
    return;
  }
  aiHit(quality);
}

function canActorHit(actor, side) {
  if (!ball.inPlay) return false;
  if (state.lastHit === actor.side) return false;
  if (side > 0 && ball.y < 0.1) return false;
  if (side < 0 && ball.y > -0.1) return false;
  if (ball.z > TUNING.player.reachZ || ball.z < 0.02) return false;
  const dx = Math.abs(ball.x - actor.x);
  const dy = Math.abs(ball.y - actor.y);
  return dx <= TUNING.player.hitRadiusX && dy <= TUNING.player.hitRadiusY;
}

function hitQuality(actor) {
  const dx = Math.abs(ball.x - actor.x) / TUNING.player.hitRadiusX;
  const dy = Math.abs(ball.y - actor.y) / TUNING.player.hitRadiusY;
  const d = Math.hypot(dx, dy);
  if (d < TUNING.player.perfectRadius) return "perfect";
  if (d < TUNING.player.goodRadius) return "good";
  return "late";
}

function aiPressureLevel() {
  const rallyPressure = clamp((state.rallyHits - 2) / 8, 0, 1);
  const scorePressure = clamp(
    (state.playerGames - state.aiGames) * 0.16 + (state.playerPoints - state.aiPoints) * 0.035,
    -0.2,
    0.22,
  );
  return clamp(0.32 + rallyPressure * 0.48 + scorePressure, 0.18, 0.92);
}

function aiFailChance(quality) {
  const noTouchServe = state.rallyHits === 0 && state.lastHit === "player";
  const unforcedChance = noTouchServe ? 0 : TUNING.ai.failRate;
  const contactPenalty = quality === "late" ? 0.06 : quality === "good" ? 0.018 : 0;
  const pressureChance = state.playerShotPressure * 0.17;
  return clamp(unforcedChance + contactPenalty + pressureChance, 0, 0.24);
}

function playerHit(quality, useSpecial) {
  const shot = choosePlayerShot(useSpecial);
  const hasBounced = ball.bounceCount > 0;
  const aimX = choosePlayerTargetX(shot);
  const targetY = choosePlayerTargetY(shot);
  const errorScale = quality === "perfect" ? 0.36 : quality === "good" ? 0.82 : 1.5;
  const missesCourt = !useSpecial && chance(playerReturnMissChance(quality, shot, hasBounced));
  let targetX = clamp(aimX + rand(-shot.error, shot.error) * errorScale, -4.02, 4.02);
  let finalTargetY = clamp(targetY + rand(-shot.error, shot.error) * errorScale, -11.45, -1.35);
  if (missesCourt) {
    const miss = missedPlayerTarget(targetX, finalTargetY);
    targetX = miss.x;
    finalTargetY = miss.y;
  }
  state.lastHit = "player";
  trackRallyHit();
  state.playerShotPressure = missesCourt ? 0 : playerShotPressure(quality, shot, targetX, finalTargetY, hasBounced);
  ball.bounceCount = 0;
  launchBallTo(targetX, finalTargetY, shot, quality === "late" ? 0.92 : 1);
  player.swing = 0.18;
  player.cooldown = TUNING.player.hitCooldown;
  if (useSpecial) {
    state.energy = 0;
    state.shake = 1;
  } else {
    const bonus = quality === "perfect" ? 8 : quality === "good" ? 3 : 0;
    state.energy = clamp(state.energy + shot.energy + bonus, 0, 100);
  }
  input.hit = false;
  input.hitQueued = false;
  input.hitQueueTimer = 0;
  input.queuedSpecial = false;
}

function playerReturnMissChance(quality, shot, hasBounced) {
  if (shot.kind === "special") return 0;
  const qualityRisk = quality === "perfect" ? 0.008 : quality === "good" ? 0.035 : 0.16;
  const shotRisk = {
    normal: 0,
    power: 0.045,
    lob: 0.018,
    drop: 0.032,
  }[shot.kind] || 0;
  const bounceBonus = hasBounced ? -0.025 : 0.035;
  return clamp(qualityRisk + shotRisk + bounceBonus, 0.004, 0.28);
}

function missedPlayerTarget(targetX, targetY) {
  if (chance(0.58)) {
    const side = targetX === 0 ? (chance(0.5) ? 1 : -1) : Math.sign(targetX);
    return { x: side * rand(4.38, 4.95), y: targetY + rand(-0.35, 0.35) };
  }
  if (chance(0.62)) {
    return { x: targetX + rand(-0.28, 0.28), y: rand(-12.75, -12.05) };
  }
  return { x: targetX + rand(-0.2, 0.2), y: rand(0.22, 0.82) };
}

function playerShotPressure(quality, shot, targetX, targetY, hasBounced) {
  const qualityPressure = quality === "perfect" ? 0.66 : quality === "good" ? 0.42 : 0.16;
  const shotPressure = {
    normal: 0.04,
    power: 0.18,
    lob: 0.12,
    drop: 0.14,
    special: 0.34,
  }[shot.kind] || 0;
  const cornerPressure = clamp((Math.abs(targetX) - 1.45) / 2.7, 0, 1) * 0.14;
  const depthPressure = clamp((Math.abs(targetY) - 6.8) / 4.5, 0, 1) * 0.08;
  const settledBonus = hasBounced ? 0.05 : -0.03;
  return clamp(qualityPressure + shotPressure + cornerPressure + depthPressure + settledBonus, 0.08, 1);
}

function choosePlayerShot(useSpecial) {
  if (useSpecial) return TUNING.shots.special;
  if (input.up) return TUNING.shots.lob;
  if (input.down) return TUNING.shots.drop;
  const charge = clamp(input.hitHold / TUNING.player.chargeTime, 0, 1);
  if (charge > TUNING.player.powerThreshold) {
    return {
      ...TUNING.shots.power,
      time: lerp(TUNING.shots.normal.time, TUNING.shots.power.time, charge),
      error: lerp(TUNING.shots.normal.error, TUNING.shots.power.error, charge),
    };
  }
  return TUNING.shots.normal;
}

function choosePlayerTargetX(shot) {
  if (input.mouseAim && input.mouseAim.y < 0) {
    return clamp(input.mouseAim.x, -3.9, 3.9);
  }
  if (Math.abs(input.aim) > 0.15) return input.aim * 3.55;
  if (shot.kind === "drop") return clamp(ai.x * 0.7 + rand(-0.7, 0.7), -3.5, 3.5);
  return clamp(-ai.x * 0.52 + rand(-0.9, 0.9), -3.5, 3.5);
}

function choosePlayerTargetY(shot) {
  if (shot.kind === "drop") return rand(-5.0, -3.8);
  if (shot.kind === "lob") return rand(-11.2, -9.2);
  return rand(-7.8, -10.8);
}

function aiHit(quality) {
  const shot = chooseAiShot();
  const pressureError = quality === "perfect" ? 0.68 : quality === "good" ? 1 : 1.6;
  const targetX = clamp(chooseAiTargetX() + rand(-shot.error, shot.error) * pressureError, -3.95, 3.95);
  const targetY = clamp(chooseAiTargetY(shot) + rand(-shot.error, shot.error) * pressureError, 1.35, 11.45);
  state.lastHit = "ai";
  trackRallyHit();
  state.playerShotPressure = 0;
  ball.bounceCount = 0;
  launchBallTo(targetX, targetY, shot, quality === "late" ? 0.94 : 1);
  ai.swing = 0.18;
  ai.cooldown = TUNING.ai.hitCooldown;
}

function trackRallyHit() {
  state.rallyHits += 1;
  state.maxRally = Math.max(state.maxRally, state.rallyHits);
}

function chooseAiShot() {
  const roll = Math.random();
  const pressure = aiPressureLevel();
  const dropChance = lerp(0.04, 0.1, pressure);
  const lobChance = lerp(0.08, 0.15, pressure);
  const powerChance = state.rallyHits > 4 ? lerp(0.06, 0.18, pressure) : 0;
  if (roll < dropChance) return TUNING.shots.drop;
  if (roll < dropChance + lobChance) return TUNING.shots.lob;
  if (roll < dropChance + lobChance + powerChance) return TUNING.shots.power;
  return TUNING.shots.normal;
}

function chooseAiTargetX() {
  const pressure = aiPressureLevel();
  const openSide = player.x > 0 ? -1 : 1;
  return clamp(openSide * rand(0.95, lerp(2.25, 3.35, pressure)) + rand(-0.48, 0.48), -3.75, 3.75);
}

function chooseAiTargetY(shot) {
  const pressure = aiPressureLevel();
  if (shot.kind === "drop") return rand(3.7, lerp(4.7, 5.4, pressure));
  if (shot.kind === "lob") return rand(8.8, lerp(10.2, 11.1, pressure));
  return rand(7.0, lerp(9.2, 10.9, pressure));
}

function launchBallTo(targetX, targetY, shot, speedScale) {
  const t = Math.max(0.45, shot.time / speedScale);
  ball.vx = (targetX - ball.x) / t;
  ball.vy = (targetY - ball.y) / t;
  ball.vz = (0 - ball.z + 0.5 * TUNING.ball.gravity * t * t) / t;
}

function predictLanding() {
  const a = -0.5 * TUNING.ball.gravity;
  const b = ball.vz;
  const c = ball.z;
  const disc = Math.max(0, b * b - 4 * a * c);
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  const future = Math.max(0.1, t);
  return {
    x: clamp(ball.x + ball.vx * future, -4.65, 4.65),
    y: clamp(ball.y + ball.vy * future, -11.45, 11.45),
  };
}

function opponentOf(side) {
  return side === "player" ? "ai" : "player";
}

function endPoint(winner, reason) {
  ball.inPlay = false;
  state.phase = "pointOver";
  state.timer = TUNING.match.nextPointDelay;
  state.pointWinner = winner;
  state.message = reason;
  state.messageSub = `${winner === "player" ? "PLAYER" : "RIVAL"} POINT`;
  state.shake = reason === "NET" ? 0.35 : 0;
  if (winner === "player") {
    state.playerPoints += 1;
  } else {
    state.aiPoints += 1;
  }
  applyGameScore();
}

function applyGameScore() {
  if (state.playerPoints >= 4 || state.aiPoints >= 4) {
    const diff = state.playerPoints - state.aiPoints;
    if (Math.abs(diff) >= 2) {
      const winner = diff > 0 ? "player" : "ai";
      state.playerPoints = 0;
      state.aiPoints = 0;
      if (winner === "player") {
        state.playerGames += 1;
        state.message = "PLAYER GAME";
      } else {
        state.aiGames += 1;
        state.message = "RIVAL GAME";
      }
      state.messageSub = "CHANGE SERVER";
      state.server = opponentOf(state.server);
      state.timer = 1.65;
      if (state.playerGames >= TUNING.match.gamesToWin || state.aiGames >= TUNING.match.gamesToWin) {
        state.phase = "matchOver";
        state.timer = 0;
        state.resultTime = 0;
        state.result = {
          winner,
          playerGames: state.playerGames,
          aiGames: state.aiGames,
          maxRally: state.maxRally,
          themeIndex: state.themeIndex,
        };
        state.message = "";
        state.messageSub = "";
      }
    }
  }
}

function startNextPoint() {
  placeBallForServe();
  state.phase = "serveWait";
  state.timer = TUNING.match.serveDelay;
  state.message = `${state.server === "player" ? "PLAYER" : "RIVAL"} SERVE`;
  state.messageSub = "";
}

function pointText(me, other) {
  if (me >= 3 && other >= 3) {
    if (me === other) return "40";
    return me > other ? "AD" : "";
  }
  return scoreLabels[me] || "40";
}

function render() {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  if (isMenuOpen()) {
    drawModeSelectScreen();
    ctx.restore();
    return;
  }
  if (isShortcutsOpen()) {
    drawShortcutsScreen();
    ctx.restore();
    return;
  }
  if (isTwoPlayerSetupOpen()) {
    drawTwoPlayerSetupScreen();
    ctx.restore();
    return;
  }
  if (APP_FLOW.screen === "game" && state.shake > 0) {
    const s = state.shake * 5;
    ctx.translate(rand(-s, s), rand(-s, s));
  }
  drawBackground();
  drawCourt();
  drawWorldObjects();
  drawBallTrail();

  const drawables = [
    { y: viewDepthY(player.y), draw: () => drawActor(player) },
    { y: viewDepthY(ai.y), draw: () => drawActor(ai) },
    { y: viewDepthY(ball.y) + ball.z * 0.12, draw: drawBall },
  ].sort((a, b) => a.y - b.y);
  drawables.forEach((item) => item.draw());

  drawNet();
  drawHud();
  if (state.phase === "matchOver") {
    drawResultScreen();
  } else {
    drawControls();
    if (APP_FLOW.pauseMenuOpen) {
      drawPauseMenu();
    } else {
      drawOverlay();
      if (ONLINE.enabled) drawOnlineStatus();
    }
  }
  ctx.restore();
}

function drawBackground() {
  const image = themeImages[state.themeIndex];
  if (image && image.complete && image.naturalWidth) {
    drawCoverImage(image, 0, 0, W, H);
  } else {
    ctx.fillStyle = "#23351f";
    ctx.fillRect(0, 0, W, H);
    drawStaticNoise(noiseTiles.background);
  }
  ctx.fillStyle = "rgba(4, 8, 12, 0.06)";
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "rgba(8, 14, 18, 0.46)";
  ctx.fillRect(0, 0, W, IS_PORTRAIT ? 138 : 72);
  ctx.fillStyle = "rgba(4, 9, 12, 0.44)";
  ctx.fillRect(0, IS_PORTRAIT ? 126 : 62, W, 16);

  const frameX = IS_PORTRAIT ? 18 : 44;
  const frameY = IS_PORTRAIT ? 148 : 82;
  const frameH = IS_PORTRAIT ? H - frameY - 18 : 618;
  const frameW = W - frameX * 2;
  ctx.fillStyle = "rgba(0,0,0,0.14)";
  ctx.fillRect(frameX + 8, frameY, frameW - 16, frameH - 2);
  ctx.strokeStyle = "rgba(247, 190, 83, 0.82)";
  ctx.lineWidth = 10;
  ctx.strokeRect(frameX, frameY, frameW, frameH);
}

function drawCourt() {
  const theme = currentTheme();

  fillWorldQuad(-5.15, TUNING.world.yMin, 5.15, TUNING.world.yMax, theme.court.outer);
  fillWorldQuad(-5.0, -TUNING.world.baselineY, 5.0, TUNING.world.baselineY, theme.court.base);
  fillWorldQuad(-4.115, -TUNING.world.baselineY, 4.115, TUNING.world.baselineY, theme.court.inner);
  fillWorldQuad(-3.72, -TUNING.world.baselineY, 3.72, TUNING.world.baselineY, theme.court.lane);

  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = "rgba(4, 10, 12, 0.65)";
  ctx.lineWidth = 8;
  drawCourtLines();
  ctx.restore();
  ctx.strokeStyle = theme.court.line;
  ctx.lineWidth = 5;
  drawCourtLines();

  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 3;
  const p = worldToScreen(ball.x, ball.y);
  ctx.beginPath();
  ctx.ellipse(p.x, p.y + 18, 28, 10, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function drawCourtLines() {
  drawWorldLine(-TUNING.world.doublesX, -TUNING.world.baselineY, -TUNING.world.doublesX, TUNING.world.baselineY);
  drawWorldLine(TUNING.world.doublesX, -TUNING.world.baselineY, TUNING.world.doublesX, TUNING.world.baselineY);
  drawWorldLine(-TUNING.world.singlesX, -TUNING.world.baselineY, -TUNING.world.singlesX, TUNING.world.baselineY);
  drawWorldLine(TUNING.world.singlesX, -TUNING.world.baselineY, TUNING.world.singlesX, TUNING.world.baselineY);
  drawWorldLine(-TUNING.world.doublesX, -TUNING.world.baselineY, TUNING.world.doublesX, -TUNING.world.baselineY);
  drawWorldLine(-TUNING.world.doublesX, TUNING.world.baselineY, TUNING.world.doublesX, TUNING.world.baselineY);
  drawWorldLine(-TUNING.world.singlesX, -TUNING.world.serviceY, TUNING.world.singlesX, -TUNING.world.serviceY);
  drawWorldLine(-TUNING.world.singlesX, TUNING.world.serviceY, TUNING.world.singlesX, TUNING.world.serviceY);
  drawWorldLine(0, -TUNING.world.serviceY, 0, TUNING.world.serviceY);
  drawWorldLine(-0.18, -TUNING.world.baselineY, 0.18, -TUNING.world.baselineY);
  drawWorldLine(-0.18, TUNING.world.baselineY, 0.18, TUNING.world.baselineY);
}

function drawNet() {
  const theme = currentTheme();
  const ui = uiSprites[theme.uiId || theme.id];
  const a = worldToScreen(-5.25, 0);
  const b = worldToScreen(5.25, 0);
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const y = (a.y + b.y) / 2;
  const span = right - left;
  if (ui?.net?.complete && ui.net.naturalWidth) {
    const width = span + (IS_PORTRAIT ? 54 : 72);
    const height = theme.ui?.netPreserveAspect
      ? width * (ui.net.naturalHeight / ui.net.naturalWidth)
      : (IS_PORTRAIT ? 86 : 92) * (theme.ui?.netHeightScale || 1);
    ctx.drawImage(ui.net, left - (width - span) / 2, y - height / 2, width, height);
    return;
  }
  ctx.fillStyle = "rgba(8, 15, 18, 0.78)";
  ctx.fillRect(left - 7, y - 19, span + 14, 42);
  ctx.strokeStyle = "#071113";
  ctx.lineWidth = 5;
  ctx.strokeRect(left - 7, y - 19, span + 14, 42);
  ctx.strokeStyle = theme.court.net;
  ctx.lineWidth = 2;
  for (let x = left; x <= right; x += 12) {
    ctx.beginPath();
    ctx.moveTo(x, y - 18);
    ctx.lineTo(x + 2, y + 22);
    ctx.stroke();
  }
  for (let yy = y - 14; yy <= y + 17; yy += 9) {
    ctx.beginPath();
    ctx.moveTo(left - 5, yy);
    ctx.lineTo(right + 5, yy);
    ctx.stroke();
  }
  ctx.fillStyle = "#cfe9b5";
  ctx.fillRect(left - 12, y - 28, 12, 58);
  ctx.fillRect(right, y - 28, 12, 58);
  ctx.fillStyle = "#0f1714";
  ctx.fillRect(left - 9, y - 25, 6, 54);
  ctx.fillRect(right + 3, y - 25, 6, 54);
}

function drawWorldObjects() {
  if (!IS_PORTRAIT) {
    drawBench();
    drawBallCart();
    drawChair();
  }
  drawScoreBackboard();
}

function drawBench() {
  const p = worldToScreen(5.85, -4.9);
  ctx.save();
  ctx.translate(p.x, p.y);
  if (isMirroredView()) ctx.rotate(Math.PI);
  ctx.fillStyle = "#1b1812";
  ctx.fillRect(-4, -8, 56, 72);
  ctx.fillStyle = "#c07628";
  for (let i = 0; i < 4; i += 1) {
    ctx.fillRect(i * 12, -4, 8, 62);
    ctx.fillStyle = i % 2 ? "#d69638" : "#b76a24";
  }
  ctx.fillStyle = "#141719";
  ctx.fillRect(-6, 56, 60, 6);
  ctx.fillRect(3, 62, 7, 24);
  ctx.fillRect(38, 62, 7, 24);
  ctx.fillStyle = "#942723";
  ctx.fillRect(18, 72, 42, 18);
  ctx.fillStyle = "#1e2427";
  ctx.fillRect(24, 66, 28, 10);
  ctx.restore();
}

function drawBallCart() {
  const p = worldToScreen(5.7, 4.55);
  ctx.save();
  ctx.translate(p.x, p.y);
  if (isMirroredView()) ctx.rotate(Math.PI);
  ctx.fillStyle = "#15191b";
  ctx.fillRect(-20, -34, 55, 66);
  ctx.strokeStyle = "#91bec4";
  ctx.lineWidth = 4;
  ctx.strokeRect(-16, -28, 47, 50);
  ctx.fillStyle = "#d9ff36";
  for (let i = 0; i < 18; i += 1) {
    ctx.fillRect(-10 + (i % 5) * 8, -22 + Math.floor(i / 5) * 9, 6, 6);
  }
  ctx.fillStyle = "#0b0d0e";
  ctx.fillRect(-14, 26, 9, 9);
  ctx.fillRect(22, 26, 9, 9);
  ctx.restore();
}

function drawChair() {
  const p = worldToScreen(-5.8, 4.2);
  ctx.save();
  ctx.translate(p.x, p.y);
  if (isMirroredView()) ctx.rotate(Math.PI);
  ctx.strokeStyle = "#101417";
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(-30, 84);
  ctx.lineTo(-8, -20);
  ctx.lineTo(25, 84);
  ctx.moveTo(-18, 25);
  ctx.lineTo(17, 25);
  ctx.stroke();
  ctx.fillStyle = "#256a9d";
  ctx.fillRect(-25, -34, 46, 28);
  ctx.fillStyle = "#b7d8d9";
  ctx.fillRect(-30, -39, 56, 7);
  ctx.restore();
}

function drawScoreBackboard() {
  if (!SHOW_PROTOTYPE_BADGE) return;
  if (IS_PORTRAIT) {
    const width = 160;
    const x = (W - width) / 2;
    ctx.fillStyle = "rgba(8, 15, 18, 0.72)";
    ctx.fillRect(x, 136, width, 48);
    ctx.strokeStyle = "#5f7276";
    ctx.lineWidth = 3;
    ctx.strokeRect(x, 136, width, 48);
    drawPixelTextCentered("PIXEL TENNIS", W / 2, 156, 11, "#dcebee");
    drawPixelTextCentered("WEB PROTOTYPE", W / 2, 176, 9, "#b5e8ff");
    return;
  }
  const width = 288;
  const x = Math.round((W - width) / 2);
  ctx.fillStyle = "rgba(8, 15, 18, 0.72)";
  ctx.fillRect(x, 92, width, 66);
  ctx.strokeStyle = "#5f7276";
  ctx.lineWidth = 3;
  ctx.strokeRect(x, 92, width, 66);
  ctx.fillStyle = "#dcebee";
  drawPixelTextCentered("PIXEL TENNIS", W / 2, 116, 18, "#dcebee");
  drawPixelTextCentered("WEB PROTOTYPE", W / 2, 142, 14, "#b5e8ff");
}

function drawBallTrail() {
  for (let i = ball.trail.length - 1; i >= 0; i -= 1) {
    const t = ball.trail[i];
    const p = worldToScreen(t.x, t.y);
    const alpha = (1 - i / ball.trail.length) * 0.28;
    ctx.fillStyle = `rgba(216,255,47,${alpha})`;
    ctx.fillRect(Math.round(p.x - 4), Math.round(p.y - t.z * 15 - 4), 8, 8);
  }
}

function drawBall() {
  if (!ball.inPlay && state.phase !== "serveWait") return;
  const p = worldToScreen(ball.x, ball.y);
  const sx = Math.round(p.x);
  const sy = Math.round(p.y - ball.z * 15);
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.fillRect(Math.round(p.x - 8), Math.round(p.y + 8), 16, 5);
  ctx.fillStyle = "#dfff28";
  ctx.fillRect(sx - 6, sy - 6, 12, 12);
  ctx.fillStyle = "#f5ff8b";
  ctx.fillRect(sx - 3, sy - 5, 5, 3);
}

function drawActor(actor) {
  const p = worldToScreen(actor.x, actor.y);
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  const isPlayer = actor.side === "player";
  const dir = viewDepthY(actor.y) > 0 ? -1 : 1;
  const bob = Math.sin(actor.pose * 9) * (Math.hypot(actor.vx, actor.vy) > 0.5 ? 2 : 0);
  const sprite = spriteForCharacterId(actor.characterId);

  ctx.fillStyle = "rgba(0,0,0,0.32)";
  ctx.fillRect(x - 24, y + 20, 48, 8);

  ctx.save();
  ctx.translate(x, y + bob);
  if (sprite.complete && sprite.naturalWidth) {
    ctx.drawImage(sprite, -37, -92, 74, 111);
  } else {
    drawActorFallback(isPlayer);
    drawHeldRacket(actor, dir);
  }
  ctx.restore();
  if (ONLINE.enabled) drawOnlineActorTag(actor, x, y);
}

function drawOnlineActorTag(actor, x, y) {
  const isLocal = (ONLINE.playerId === "p1" && actor.side === "player") || (ONLINE.playerId === "p2" && actor.side === "ai");
  const label = isLocal ? "YOU" : actor.side === "player" ? "P1" : "P2";
  const color = isLocal ? "#fff27a" : "rgba(226,246,255,0.82)";
  const width = isLocal ? 42 : 30;
  ctx.save();
  ctx.fillStyle = isLocal ? "rgba(35, 24, 0, 0.74)" : "rgba(7, 12, 18, 0.54)";
  ctx.strokeStyle = isLocal ? "rgba(255, 225, 92, 0.88)" : "rgba(200, 236, 246, 0.32)";
  ctx.lineWidth = 2;
  ctx.fillRect(x - width / 2, y - 112, width, 22);
  ctx.strokeRect(x - width / 2, y - 112, width, 22);
  drawPixelTextCentered(label, x, y - 96, 13, color);
  if (isLocal) {
    ctx.strokeStyle = "rgba(255, 225, 92, 0.78)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(x, y + 26, 34, 12, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawActorFallback(isPlayer) {
  ctx.fillStyle = isPlayer ? "#1e9c8d" : "#d69b40";
  ctx.fillRect(-15, -45, 30, 40);
  ctx.fillStyle = "#f0b68d";
  ctx.fillRect(-10, -60, 20, 20);
  ctx.fillStyle = "#071011";
  ctx.fillRect(-12, -64, 24, 7);
}

function drawHeldRacket(actor, dir) {
  const racket = equipmentSprites.racket;
  const swingAmount = actor.swing > 0 ? 1 : 0;
  const px = dir * (swingAmount ? 32 : 29);
  const py = swingAmount ? -40 : -23;
  const size = swingAmount ? 38 : 32;
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(dir * (swingAmount ? -0.82 : -0.2));
  ctx.scale(dir, 1);
  if (racket.complete && racket.naturalWidth) {
    ctx.drawImage(racket, -size / 2, -size / 2, size, size);
  } else {
    ctx.fillStyle = "#ffd44f";
    ctx.fillRect(-12, -16, 24, 24);
    ctx.fillStyle = "#4b210d";
    ctx.fillRect(8, 7, 6, 18);
  }
  ctx.restore();
}

function drawHud() {
  const controls = controlLayout();
  const score = scoreView();
  if (IS_PORTRAIT) {
    const x = 18;
    const y = 18;
    const w = W - 36;
    const h = 116;
    ctx.fillStyle = "rgba(11, 16, 25, 0.62)";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "rgba(20, 45, 60, 0.34)";
    ctx.fillRect(x + 8, y + 10, w * 0.42, h - 20);
    ctx.fillStyle = "rgba(70, 20, 34, 0.34)";
    ctx.fillRect(x + w * 0.58, y + 10, w * 0.4 - 8, h - 20);
    ctx.strokeStyle = "rgba(207, 239, 230, 0.3)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    pixelText(score.leftLabel, x + 24, y + 30, 16, "#b9efff");
    pixelText(score.rightLabel, x + w - (score.rightLabel.length > 3 ? 64 : 48), y + 30, 16, "#ffc4d5");
    pixelText(pointText(score.leftPoints, score.rightPoints), x + 28, y + 76, 34, "#ffffff");
    pixelText(String(score.leftGames), x + 156, y + 76, 34, "#ffffff");
    pixelText(pointText(score.rightPoints, score.leftPoints), x + w - 178, y + 76, 34, "#ffffff");
    pixelText(String(score.rightGames), x + w - 48, y + 76, 34, "#ffffff");
    drawTinyBar(x + 88, y + 78, 56, 8, score.leftPoints / 4, "#fff25e");
    drawTinyBar(x + w - 160, y + 78, 72, 8, score.rightPoints / 4, "#fff25e");

    pixelText("RALLY", W / 2 - 24, y + 38, 11, "#bcd0d5");
    pixelText(String(state.rallyHits).padStart(2, "0"), W / 2 - 17, y + 66, 22, "#e7f7ff");
    drawHudActionButtons(controls);

    drawEnergyBar();
    return;
  }
  ctx.fillStyle = "rgba(11, 16, 25, 0.78)";
  ctx.fillRect(44, 18, 868, 90);
  ctx.fillStyle = "rgba(20, 45, 60, 0.45)";
  ctx.fillRect(52, 26, 406, 74);
  ctx.fillStyle = "rgba(70, 20, 34, 0.45)";
  ctx.fillRect(552, 26, 356, 74);
  ctx.strokeStyle = "rgba(207, 239, 230, 0.18)";
  ctx.lineWidth = 2;
  ctx.strokeRect(44, 18, 868, 90);

  pixelText(score.leftLabel, 84, 44, 18, "#b9efff");
  pixelText(score.rightLabel, score.rightLabel.length > 3 ? 812 : 840, 44, 18, "#ffc4d5");
  pixelText(pointText(score.leftPoints, score.rightPoints), 102, 78, 40, "#ffffff");
  pixelText(String(score.leftGames), 312, 78, 40, "#ffffff");
  pixelText(pointText(score.rightPoints, score.leftPoints), 610, 78, 40, "#ffffff");
  pixelText(String(score.rightGames), 836, 78, 40, "#ffffff");

  drawTinyBar(181, 83, 70, 10, score.leftPoints / 4, "#fff25e");
  drawTinyBar(570, 83, 112, 10, score.rightPoints / 4, "#fff25e");

  pixelText("RALLY", 446, 46, 12, "#bcd0d5");
  pixelText(String(state.rallyHits).padStart(2, "0"), 462, 68, 22, "#e7f7ff");

  drawHudActionButtons(controls);

  drawEnergyBar();
}

function drawHudActionButtons(controls) {
  const home = controls.actions.home;
  const reset = controls.actions.reset;
  const pause = controls.actions.pause;
  ctx.fillStyle = IS_PORTRAIT ? "rgba(12,19,24,0.54)" : "rgba(12,19,24,0.72)";
  ctx.fillRect(home.x, home.y, home.width, home.height);
  ctx.fillRect(reset.x, reset.y, reset.width, reset.height);
  ctx.fillRect(pause.x, pause.y, pause.width, pause.height);
  ctx.strokeStyle = "rgba(207, 239, 230, 0.22)";
  ctx.lineWidth = 2;
  ctx.strokeRect(home.x, home.y, home.width, home.height);
  ctx.strokeRect(reset.x, reset.y, reset.width, reset.height);
  ctx.strokeRect(pause.x, pause.y, pause.width, pause.height);
  pixelText("H", home.x + (IS_PORTRAIT ? 14 : 16), home.y + (IS_PORTRAIT ? 28 : 32), IS_PORTRAIT ? 19 : 22, "#f1f4ff");
  pixelText("R", reset.x + (IS_PORTRAIT ? 15 : 17), reset.y + (IS_PORTRAIT ? 28 : 32), IS_PORTRAIT ? 19 : 22, "#f1f4ff");
  pixelText("II", pause.x + (IS_PORTRAIT ? 12 : 14), pause.y + (IS_PORTRAIT ? 28 : 32), IS_PORTRAIT ? 17 : 20, "#f1f4ff");
}

function drawEnergyBar() {
  const controls = controlLayout();
  const amount = clamp(state.energy / 100, 0, 1);
  const center = controls.special;
  const radius = center.radius + (IS_PORTRAIT ? 12 : 13);
  const lineWidth = IS_PORTRAIT ? 8 : 9;
  const start = -Math.PI / 2;
  const end = start + Math.PI * 2 * amount;
  const pulse = state.energy >= 100 ? 0.5 + Math.sin(performance.now() * 0.008) * 0.5 : 0;

  ctx.save();
  ctx.lineCap = "butt";
  ctx.shadowBlur = state.energy >= 100 ? 18 + pulse * 8 : 0;
  ctx.shadowColor = "rgba(112, 246, 255, 0.78)";
  ctx.strokeStyle = "rgba(5, 12, 18, 0.72)";
  ctx.lineWidth = lineWidth + 5;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(155, 214, 226, 0.3)";
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.stroke();

  if (amount > 0) {
    const grad = ctx.createLinearGradient(center.x - radius, center.y + radius, center.x + radius, center.y - radius);
    grad.addColorStop(0, "#24d8ff");
    grad.addColorStop(0.55, "#7cf5ff");
    grad.addColorStop(1, state.energy >= 100 ? "#fff2a3" : "#5bffce");
    ctx.strokeStyle = grad;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, start, end);
    ctx.stroke();
  }

  const tickCount = 12;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.34)";
  ctx.lineWidth = 2;
  for (let i = 0; i < tickCount; i += 1) {
    const a = start + (Math.PI * 2 * i) / tickCount;
    const filled = i / tickCount <= amount;
    ctx.strokeStyle = filled ? "rgba(255, 244, 171, 0.86)" : "rgba(180, 226, 238, 0.25)";
    ctx.beginPath();
    ctx.moveTo(center.x + Math.cos(a) * (radius - 7), center.y + Math.sin(a) * (radius - 7));
    ctx.lineTo(center.x + Math.cos(a) * (radius + 3), center.y + Math.sin(a) * (radius + 3));
    ctx.stroke();
  }

  const label = state.energy >= 100 ? "READY" : "SP";
  const labelWidth = state.energy >= 100 ? 66 : 34;
  const labelX = center.x - labelWidth / 2;
  const labelY = center.y - radius - 30;
  ctx.fillStyle = state.energy >= 100 ? "rgba(60, 42, 6, 0.78)" : "rgba(6, 18, 24, 0.72)";
  ctx.strokeStyle = state.energy >= 100 ? "rgba(255, 232, 119, 0.9)" : "rgba(124, 245, 255, 0.48)";
  ctx.lineWidth = 2;
  ctx.fillRect(labelX, labelY, labelWidth, 22);
  ctx.strokeRect(labelX, labelY, labelWidth, 22);
  drawPixelTextCentered(label, center.x, labelY + 16, 12, state.energy >= 100 ? "#fff4a8" : "#c9f8ff");
  ctx.restore();
}

function drawControls() {
  const controls = controlLayout();
  const theme = currentTheme();
  const ui = uiSprites[theme.uiId || theme.id];
  drawThemeButtons(controls);

  if (ui?.joystick?.complete && ui.joystick.naturalWidth) {
    const width = controls.stick.radius * (IS_PORTRAIT ? 2.5 : 2.25) * uiControlScale(theme, "joystick");
    drawControlPlate(controls.stick.x, controls.stick.y, width / 2);
    drawCenteredImageFixedWidth(ui.joystick, controls.stick.x, controls.stick.y, width);
  } else {
    ctx.fillStyle = "rgba(18, 33, 45, 0.42)";
    ctx.strokeStyle = "rgba(187, 230, 247, 0.45)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(controls.stick.x, controls.stick.y, controls.stick.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  const knobX = controls.stick.x + input.stick.x * controls.stick.knob;
  const knobY = controls.stick.y + input.stick.y * controls.stick.knob;
  if (Math.abs(input.stick.x) > 0.02 || Math.abs(input.stick.y) > 0.02 || !ui?.joystick?.complete) {
    ctx.fillStyle = "rgba(218, 245, 255, 0.48)";
    ctx.beginPath();
    ctx.arc(knobX, knobY, IS_PORTRAIT ? 18 : 22, 0, Math.PI * 2);
    ctx.fill();
  }

  const specialReady = state.energy >= 100;
  const specialPressed = input.specialPulse > 0 || input.queuedSpecial;
  const specialPulse = specialPressed ? 1 : 0;
  if (ui?.special?.complete && ui.special.naturalWidth) {
    const width = (controls.special.radius * (IS_PORTRAIT ? 2.75 : 2.65) + specialPulse * 10) * uiControlScale(theme, "special");
    const offset = uiControlOffset(theme, "special");
    ctx.save();
    ctx.globalAlpha = specialReady ? 1 : 0.82;
    drawControlPlate(controls.special.x + offset.x, controls.special.y + offset.y, Math.min(width / 2, controls.special.radius + 10), 0.76);
    drawCenteredImageFixedWidth(ui.special, controls.special.x + offset.x, controls.special.y + offset.y, width);
    ctx.restore();
  } else {
    ctx.fillStyle = specialReady ? "rgba(21, 88, 105, 0.68)" : "rgba(21, 54, 69, 0.55)";
    ctx.strokeStyle = specialReady ? "rgba(103, 244, 255, 0.86)" : "rgba(107, 218, 255, 0.56)";
    ctx.beginPath();
    ctx.arc(controls.special.x, controls.special.y, controls.special.radius + specialPulse * 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#3ce7ff";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(controls.special.x, controls.special.y, IS_PORTRAIT ? 19 : 22, 0.5, 4.8);
    ctx.stroke();
  }
  if (specialPressed) {
    ctx.strokeStyle = specialReady ? "rgba(255,255,255,0.76)" : "rgba(255, 224, 112, 0.78)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(controls.special.x, controls.special.y, controls.special.radius + 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  const ready = state.energy >= 100;
  const pressed = input.hitPulse > 0 || (!input.queuedSpecial && (input.hit || input.hitQueued));
  const glow = ready ? 1 : 0.35;
  const pulse = pressed ? 1 : 0;
  const radius = controls.racket.radius + pulse * 6;
  if (ui?.hit?.complete && ui.hit.naturalWidth) {
    const width = radius * (IS_PORTRAIT ? 2.35 : 2.2) * uiControlScale(theme, "hit");
    ctx.save();
    ctx.globalAlpha = ready ? 1 : 0.94 + glow * 0.03;
    drawControlPlate(controls.racket.x, controls.racket.y, width / 2);
    drawCenteredImageFixedWidth(ui.hit, controls.racket.x, controls.racket.y, width);
    ctx.restore();
    if (pressed) {
      ctx.strokeStyle = "rgba(255,255,255,0.72)";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(controls.racket.x, controls.racket.y, radius - 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = `rgba(250, 156, 24, ${0.55 + glow * 0.22 + pulse * 0.12})`;
    ctx.strokeStyle = `rgba(255, 244, 135, ${0.5 + glow * 0.45})`;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(controls.racket.x, controls.racket.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (pressed) {
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(controls.racket.x, controls.racket.y, radius - 10, 0, Math.PI * 2);
      ctx.stroke();
    }
    drawRacketIcon(controls.racket.x, controls.racket.y, (IS_PORTRAIT ? 0.92 : 1.1) + pulse * 0.08);
  }
}

function drawThemeButtons(controls) {
  controls.themes.forEach((button, index) => {
    const theme = THEMES[index];
    const image = themeImages[index];
    const selected = index === state.themeIndex;
    const x = button.x;
    const y = button.y;
    const size = button.size;
    const inset = 5;
    ctx.fillStyle = selected ? "rgba(255, 235, 145, 0.94)" : "rgba(7, 12, 18, 0.76)";
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = "#111720";
    ctx.fillRect(x + 3, y + 3, size - 6, size - 6);
    if (image && image.complete && image.naturalWidth) {
      drawThemeThumbnail(image, x + inset, y + inset, size - inset * 2, theme.thumbnail);
      ctx.fillStyle = selected ? "rgba(255, 238, 150, 0.08)" : "rgba(0, 0, 0, 0.14)";
      ctx.fillRect(x + inset, y + inset, size - inset * 2, size - inset * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
      ctx.fillRect(x + inset + 3, y + inset + 3, size - inset * 2 - 6, 2);
    } else {
      ctx.fillStyle = theme.swatch[0];
      ctx.fillRect(x + inset, y + inset, size - inset * 2, size - inset * 2);
      ctx.fillStyle = theme.swatch[1];
      ctx.fillRect(x + inset, y + size - inset - 7, size - inset * 2, 7);
    }
    ctx.strokeStyle = selected ? "#fff1a8" : "rgba(178, 235, 245, 0.52)";
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeRect(x + 2, y + 2, size - 4, size - 4);
  });
}

function drawThemeThumbnail(image, x, y, size, thumbnail = {}) {
  const focusX = thumbnail.x ?? 0.5;
  const focusY = thumbnail.y ?? 0.5;
  const zoom = thumbnail.zoom ?? 1;
  const sourceSize = Math.max(1, Math.min(image.naturalWidth, image.naturalHeight) * zoom);
  const sx = Math.max(0, Math.min(image.naturalWidth - sourceSize, image.naturalWidth * focusX - sourceSize / 2));
  const sy = Math.max(0, Math.min(image.naturalHeight - sourceSize, image.naturalHeight * focusY - sourceSize / 2));
  ctx.drawImage(image, sx, sy, sourceSize, sourceSize, x, y, size, size);
}

function resultLayout() {
  if (IS_PORTRAIT) {
    return {
      stats: { x: 42, y: 612, width: W - 84, height: 150 },
      replay: { x: 62, y: 792, width: 188, height: 66 },
      continue: { x: W - 250, y: 792, width: 188, height: 66 },
    };
  }
  return {
    stats: { x: 280, y: 446, width: 400, height: 124 },
    replay: { x: 282, y: 600, width: 178, height: 62 },
    continue: { x: 500, y: 600, width: 178, height: 62 },
  };
}

function drawResultScreen() {
  const score = scoreView();
  const result = state.result || {
    winner: score.leftGames >= score.rightGames ? "player" : "ai",
    playerGames: score.leftGames,
    aiGames: score.rightGames,
    maxRally: state.maxRally,
  };
  const won = result.winner === "player";
  const layout = resultLayout();
  const t = state.resultTime;

  ctx.save();
  drawResultBackdrop(won, t);
  drawResultFrame(won, t);
  drawResultHeader(won, t);
  drawResultHero(won, t);
  drawResultStats(layout.stats, result, won);
  drawResultButton(layout.replay, "REPLAY", won, false);
  drawResultButton(layout.continue, "CONTINUE", won, true);
  ctx.restore();
}

function drawResultBackdrop(won, t) {
  ctx.save();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  if (won) {
    grad.addColorStop(0, "rgba(8, 13, 16, 0.78)");
    grad.addColorStop(0.42, "rgba(10, 39, 42, 0.82)");
    grad.addColorStop(1, "rgba(30, 15, 2, 0.94)");
  } else {
    grad.addColorStop(0, "rgba(15, 3, 22, 0.86)");
    grad.addColorStop(0.5, "rgba(31, 5, 24, 0.9)");
    grad.addColorStop(1, "rgba(3, 5, 17, 0.96)");
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const cx = W / 2;
  const cy = won ? 360 : 382;
  const rayCount = won ? 28 : 18;
  for (let i = 0; i < rayCount; i += 1) {
    const a = (i / rayCount) * Math.PI * 2 + t * (won ? 0.22 : -0.12);
    const spread = won ? 0.035 : 0.02;
    ctx.fillStyle = won ? "rgba(255, 211, 66, 0.08)" : "rgba(255, 42, 91, 0.07)";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a - spread) * 620, cy + Math.sin(a - spread) * 620);
    ctx.lineTo(cx + Math.cos(a + spread) * 620, cy + Math.sin(a + spread) * 620);
    ctx.closePath();
    ctx.fill();
  }

  drawResultParticles(won, t);
  if (!won) drawResultCracks(t);
  drawResultVignette(won);
  ctx.restore();
}

function drawResultVignette(won) {
  const radial = ctx.createRadialGradient(W / 2, H * 0.42, 80, W / 2, H * 0.42, H * 0.64);
  radial.addColorStop(0, won ? "rgba(255, 214, 58, 0.05)" : "rgba(255, 56, 105, 0.04)");
  radial.addColorStop(0.58, "rgba(0,0,0,0.08)");
  radial.addColorStop(1, "rgba(0,0,0,0.58)");
  ctx.fillStyle = radial;
  ctx.fillRect(0, 0, W, H);
}

function drawResultParticles(won, t) {
  const colors = won
    ? ["#ffe65e", "#55f4ff", "#ff7d42", "#fff4bc"]
    : ["#ff3868", "#8e62ff", "#58c9ff", "#ffd0dd"];
  for (let i = 0; i < 78; i += 1) {
    const n1 = pseudoRandom(i * 2 + (won ? 11 : 31));
    const n2 = pseudoRandom(i * 2 + 1 + (won ? 11 : 31));
    const drift = (t * (18 + (i % 7) * 3)) % (H + 80);
    const x = 18 + n1 * (W - 36);
    const y = ((n2 * H + (won ? drift : -drift)) % (H + 80)) - 40;
    const size = 2 + (i % 4);
    ctx.fillStyle = colors[i % colors.length];
    ctx.globalAlpha = won ? 0.72 : 0.55;
    ctx.fillRect(Math.round(x), Math.round(y), size, size);
  }
  ctx.globalAlpha = 1;
}

function drawResultCracks(t) {
  ctx.save();
  ctx.strokeStyle = "rgba(255, 172, 210, 0.56)";
  ctx.lineWidth = 2;
  const cracks = [
    [[34, 86], [94, 132], [122, 206], [178, 258]],
    [[W - 34, 72], [W - 98, 144], [W - 118, 224], [W - 190, 308]],
    [[32, H - 102], [96, H - 156], [122, H - 236]],
    [[W - 42, H - 96], [W - 122, H - 188], [W - 150, H - 292]],
  ];
  cracks.forEach((points, index) => {
    ctx.globalAlpha = 0.48 + Math.sin(t * 5 + index) * 0.12;
    ctx.beginPath();
    points.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
  ctx.restore();
}

function drawResultFrame(won, t) {
  const outer = won ? "#ffd75b" : "#ff3d72";
  const inner = won ? "rgba(93, 245, 255, 0.72)" : "rgba(141, 99, 255, 0.72)";
  ctx.save();
  ctx.strokeStyle = outer;
  ctx.lineWidth = 4;
  ctx.strokeRect(9, 9, W - 18, H - 18);
  ctx.strokeStyle = inner;
  ctx.lineWidth = 2;
  ctx.strokeRect(22, 25, W - 44, H - 50);
  const pulse = 6 + Math.sin(t * 4) * 2;
  [[34, 38], [W - 58, 38], [34, H - 64], [W - 58, H - 64]].forEach(([x, y]) => {
    ctx.strokeStyle = outer;
    ctx.strokeRect(x, y, 24, 24);
    ctx.fillStyle = inner;
    ctx.fillRect(x + pulse, y + pulse, 24 - pulse * 2, 24 - pulse * 2);
  });
  ctx.restore();
}

function drawResultHeader(won, t) {
  const title = won ? "WIN!!" : "DEFEAT";
  const sub = won ? "MATCH COMPLETE" : "MATCH LOST";
  const y = IS_PORTRAIT ? 118 : 104;
  ctx.save();
  ctx.shadowBlur = won ? 34 : 28;
  ctx.shadowColor = won ? "#ffd24a" : "#ff3868";
  drawImpactText(title, W / 2, y, won ? 82 : 70, won ? "#ffe88a" : "#ff5d83", won ? "#632900" : "#250014", won ? 8 : 7);
  ctx.shadowBlur = 0;
  ctx.fillStyle = won ? "rgba(4, 43, 40, 0.8)" : "rgba(58, 8, 34, 0.78)";
  ctx.strokeStyle = won ? "rgba(255, 224, 106, 0.84)" : "rgba(255, 73, 119, 0.84)";
  ctx.lineWidth = 2;
  ctx.fillRect(W / 2 - 126, y + 12, 252, 33);
  ctx.strokeRect(W / 2 - 126, y + 12, 252, 33);
  drawPixelTextCentered(sub, W / 2, y + 35, 18, won ? "#69f5ff" : "#9fd5ff");
  ctx.restore();
}

function drawResultHero(won, t) {
  const cx = W / 2;
  const cy = IS_PORTRAIT ? 380 : 326;
  ctx.save();
  ctx.translate(cx, cy);
  const ringPulse = Math.sin(t * 5) * 8;
  ctx.strokeStyle = won ? "rgba(92, 245, 255, 0.88)" : "rgba(255, 58, 103, 0.72)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(0, 0, (won ? 128 : 116) + ringPulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = won ? "rgba(255, 217, 71, 0.86)" : "rgba(112, 151, 255, 0.62)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, (won ? 94 : 86) - ringPulse * 0.35, 0, Math.PI * 2);
  ctx.stroke();
  if (won) {
    drawPhoenixBurst(t);
  } else {
    drawRivalSilhouette(t);
  }
  ctx.restore();

  const sprite = resultHeroSprite();
  if (sprite?.complete && sprite.naturalWidth) {
    const bob = Math.sin(t * 4) * (won ? 8 : 3);
    drawCenteredImageContain(sprite, cx, cy + 32 + bob, won ? 252 : 222, won ? 300 : 260);
  } else {
    drawFallbackResultHero(cx, cy + 68, won);
  }
  ctx.fillStyle = won ? "rgba(255, 218, 72, 0.56)" : "rgba(255, 54, 102, 0.54)";
  ctx.fillRect(cx - 70, cy + 150, 140, 10);
}

function resultHeroSprite() {
  if (ONLINE.enabled && ONLINE.playerId === "p2") return spriteForCharacterId(ai.characterId);
  return spriteForCharacterId(player.characterId);
}

function drawFallbackResultHero(cx, cy, won) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = won ? "#35a88e" : "#26384b";
  ctx.fillRect(-24, -72, 48, 70);
  ctx.fillStyle = "#f0b990";
  ctx.fillRect(-18, -106, 36, 32);
  ctx.fillStyle = "#7f2e33";
  ctx.fillRect(-24, -122, 48, 22);
  ctx.fillStyle = "#e0a02d";
  ctx.strokeStyle = "#4e1d0a";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.ellipse(42, -72, 18, 26, -0.45, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawPhoenixBurst(t) {
  ctx.save();
  ctx.strokeStyle = "rgba(255, 209, 52, 0.72)";
  ctx.lineWidth = 5;
  for (let side = -1; side <= 1; side += 2) {
    ctx.beginPath();
    ctx.moveTo(0, -24);
    ctx.bezierCurveTo(side * 58, -92, side * 130, -86 + Math.sin(t * 3) * 8, side * 166, -128);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.bezierCurveTo(side * 70, -40, side * 118, -20, side * 160, -54);
    ctx.stroke();
  }
  ctx.restore();
}

function drawRivalSilhouette(t) {
  ctx.save();
  ctx.globalAlpha = 0.42 + Math.sin(t * 2) * 0.08;
  ctx.fillStyle = "#07010d";
  ctx.beginPath();
  ctx.arc(0, -162, 44, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(-58, -126, 116, 86);
  ctx.fillStyle = "#9f54ff";
  ctx.fillRect(-21, -166, 13, 5);
  ctx.fillRect(9, -166, 13, 5);
  ctx.restore();
}

function drawResultStats(box, result, won) {
  const panel = won ? "rgba(7, 24, 28, 0.88)" : "rgba(12, 10, 24, 0.9)";
  const hi = won ? "rgba(28, 91, 86, 0.86)" : "rgba(82, 18, 48, 0.86)";
  const line = won ? "#ffe06a" : "#ff4977";
  const accent = won ? "#71f8ff" : "#7fc8ff";
  const score = `${result.playerGames} - ${result.aiGames}`;
  const maxRally = String(result.maxRally || 0).padStart(2, "0");
  const rank = resultRank(result);

  ctx.save();
  ctx.fillStyle = panel;
  ctx.shadowBlur = won ? 18 : 16;
  ctx.shadowColor = won ? "rgba(255, 212, 66, 0.7)" : "rgba(255, 50, 102, 0.72)";
  ctx.strokeStyle = line;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.width, box.height, 10);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = hi;
  ctx.fillRect(box.x + 12, box.y + 12, box.width - 24, 38);
  drawPixelTextCentered(won ? "MATCH WIN" : "MATCH LOST", box.x + box.width / 2, box.y + 39, 25, won ? "#ffeaa5" : "#ff9ab0");

  const colW = box.width / 3;
  drawStatCell(box.x + 24, box.y + 78, colW - 24, "SCORE", score, accent);
  drawStatCell(box.x + colW + 14, box.y + 78, colW - 24, "MAX RALLY", maxRally, accent);
  drawStatCell(box.x + colW * 2 + 10, box.y + 78, colW - 26, "RANK", rank, accent);
  ctx.restore();
}

function drawStatCell(x, y, width, label, value, accent) {
  pixelText(label, x, y, 12, accent);
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.fillRect(x, y + 9, width, 2);
  pixelText(value, x, y + 44, value.length > 3 ? 30 : 36, "#fffdf0");
}

function drawResultButton(box, label, won, primary) {
  const fill = primary
    ? (won ? "rgba(215, 76, 37, 0.92)" : "rgba(38, 94, 166, 0.92)")
    : (won ? "rgba(20, 126, 116, 0.9)" : "rgba(153, 27, 63, 0.9)");
  const line = won ? "#ffe779" : "#ff7da0";
  ctx.save();
  ctx.fillStyle = fill;
  ctx.strokeStyle = line;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.width, box.height, 10);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.fillRect(box.x + 8, box.y + 8, box.width - 16, 5);
  drawPixelTextCentered(label, box.x + box.width / 2, box.y + 42, label.length > 7 ? 22 : 24, "#fff8df");
  ctx.restore();
}

function resultRank(result) {
  const won = result.winner === "player";
  const margin = result.playerGames - result.aiGames;
  const rally = result.maxRally || 0;
  if (won && margin >= 2 && rally >= 18) return "SSS";
  if (won && rally >= 12) return "S";
  if (won) return "A";
  if (rally >= 14) return "B";
  return "C";
}

function drawImpactText(text, cx, y, size, fill, stroke, strokeWidth) {
  ctx.save();
  ctx.font = `900 ${size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke;
  ctx.lineWidth = strokeWidth;
  ctx.strokeText(text, cx, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, cx, y);
  ctx.restore();
}

function drawPixelTextCentered(text, cx, y, size, color) {
  ctx.save();
  ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  const width = ctx.measureText(text).width;
  ctx.restore();
  pixelText(text, cx - width / 2, y, size, color);
}

function pseudoRandom(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function drawOverlay() {
  if (!state.message) return;
  if (IS_PORTRAIT) {
    const boxW = Math.min(W - 72, state.messageSub ? 310 : 286);
    const boxH = state.messageSub ? 78 : 54;
    const boxX = (W - boxW) / 2;
    const boxY = 196;
    ctx.fillStyle = "rgba(9, 14, 20, 0.74)";
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeStyle = "rgba(207, 235, 245, 0.45)";
    ctx.lineWidth = 3;
    ctx.strokeRect(boxX, boxY, boxW, boxH);
    const size = state.message.length > 11 ? 22 : 26;
    const width = state.message.length * size * 0.62;
    pixelText(state.message, W / 2 - width / 2, boxY + 36, size, "#f4fbff");
    if (state.messageSub) {
      const subWidth = state.messageSub.length * 14 * 0.62;
      pixelText(state.messageSub, W / 2 - subWidth / 2, boxY + 62, 14, "#b9e4ff");
    }
    return;
  }
  ctx.fillStyle = "rgba(9, 14, 20, 0.74)";
  ctx.fillRect(322, 150, 316, state.messageSub ? 86 : 58);
  ctx.strokeStyle = "rgba(207, 235, 245, 0.45)";
  ctx.lineWidth = 3;
  ctx.strokeRect(322, 150, 316, state.messageSub ? 86 : 58);
  const size = state.message.length > 11 ? 24 : 29;
  const width = state.message.length * size * 0.62;
  pixelText(state.message, 480 - width / 2, 188, size, "#f4fbff");
  if (state.messageSub) {
    const subWidth = state.messageSub.length * 15 * 0.62;
    pixelText(state.messageSub, 480 - subWidth / 2, 218, 15, "#b9e4ff");
  }
}

function drawPauseMenu() {
  const layout = pauseMenuLayout();
  const box = layout.box;
  ctx.save();
  ctx.fillStyle = "rgba(2, 7, 11, 0.48)";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(5, 11, 18, 0.9)";
  ctx.strokeStyle = "rgba(255, 224, 112, 0.86)";
  ctx.lineWidth = 4;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  ctx.fillStyle = "rgba(28, 69, 78, 0.62)";
  ctx.fillRect(box.x + 12, box.y + 12, box.width - 24, 50);
  drawPixelTextCentered("PAUSED", box.x + box.width / 2, box.y + 46, 28, "#fff4b8");
  drawPixelTextCentered(ONLINE.enabled ? "ONLINE MATCH MENU" : "MATCH MENU", box.x + box.width / 2, box.y + 92, 15, "#9ff4ff");

  drawPauseMenuButton(layout.continue, "CONTINUE", true);
  drawPauseMenuButton(layout.home, "HOME", false);
  ctx.restore();
}

function drawPauseMenuButton(box, label, primary) {
  ctx.save();
  ctx.fillStyle = primary ? "rgba(26, 132, 120, 0.9)" : "rgba(38, 75, 104, 0.9)";
  ctx.strokeStyle = primary ? "#fff1a8" : "rgba(178, 235, 245, 0.78)";
  ctx.lineWidth = 4;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.fillRect(box.x + 8, box.y + 8, box.width - 16, 5);
  drawPixelTextCentered(label, box.x + box.width / 2, box.y + 38, label.length > 6 ? 20 : 23, "#fff8df");
  ctx.restore();
}

function drawOnlineStatus() {
  if (!ONLINE.enabled) return;
  const stale = ONLINE.snapshotAt > 0 && performance.now() - ONLINE.snapshotAt > 2200;
  const needsPanel = state.phase === "waiting" || ONLINE.status !== "connected" || stale || !ONLINE.playerId;
  if (needsPanel) {
    drawOnlineRoomPanel(stale);
  } else {
    drawOnlineBadge();
  }
  if (netDebug) {
    netDebug.draw(ctx, {
      W,
      H,
      isPortrait: IS_PORTRAIT,
      stale,
      online: ONLINE,
    });
  }
}

function drawModeSelectScreen() {
  const layout = modeSelectLayout();
  const background = menuSprites.background;
  const logo = menuSprites.logo;
  ctx.save();
  if (background && background.complete && background.naturalWidth) {
    drawCoverImage(background, 0, 0, W, H);
    ctx.fillStyle = "rgba(3, 8, 12, 0.26)";
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = "rgba(3, 8, 12, 0.68)";
    ctx.fillRect(0, 0, W, H);
  }
  ctx.fillStyle = "rgba(255, 232, 137, 0.1)";
  ctx.fillRect(36, 84, W - 72, 4);
  ctx.fillRect(36, H - 88, W - 72, 4);

  if (logo && logo.complete && logo.naturalWidth) {
    drawCenteredImageContain(logo, W / 2, layout.titleY + 8, W - 96, 150);
  } else {
    drawPixelTextCentered("PIXEL TENNIS", W / 2, layout.titleY, 34, "#fff6c4");
  }

  drawMenuSelectedCharacter(layout);
  layout.buttons.forEach((button, index) => {
    drawModeSelectButton(button, index === APP_FLOW.menuChoice, index);
  });
  drawShortcutButton(layout.shortcuts);
  if (CHARACTER_SELECT.panelOpen) drawCharacterSelectPanel();
  ctx.restore();
}

function drawShortcutButton(box) {
  ctx.save();
  const cx = box.x + box.width / 2;
  const y = box.y + 21;
  ctx.fillStyle = "rgba(143, 241, 255, 0.52)";
  ctx.fillRect(cx - 38, box.y + 25, 76, 2);
  ctx.fillStyle = "rgba(255, 241, 168, 0.78)";
  ctx.fillRect(cx - 52, box.y + 14, 6, 6);
  ctx.fillRect(cx + 46, box.y + 14, 6, 6);
  drawPixelTextCentered("KEYS", cx, y, 16, "#dff8ff");
  ctx.restore();
}

function drawShortcutsScreen() {
  const layout = shortcutsLayout();
  const box = layout.box;
  ctx.save();
  ctx.fillStyle = "rgba(1, 6, 10, 0.58)";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(5, 12, 18, 0.92)";
  ctx.strokeStyle = "rgba(255, 224, 112, 0.88)";
  ctx.lineWidth = 4;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  ctx.fillStyle = "rgba(32, 74, 83, 0.56)";
  ctx.fillRect(box.x + 14, box.y + 14, box.width - 28, 54);
  drawPixelTextCentered("KEYS", box.x + box.width / 2, box.y + 48, 27, "#fff4b8");

  const rows = [
    ["MOVE", "WASD / ARROW KEYS"],
    ["HIT", "SPACE / ENTER"],
    ["LOB", "HOLD UP + HIT"],
    ["DROP", "HOLD DOWN + HIT"],
    ["SPECIAL", "E WHEN ENERGY FULL"],
    ["THEME", "1 / 2 / 3 / 4"],
    ["PAUSE", "P"],
    ["RESTART", "R"],
    ["MENU", "H BUTTON OR PAUSE HOME"],
    ["CHARACTER", "C ON HOME SCREEN"],
    ["ROOM CODE", "TYPE CODE, ENTER JOIN"],
    ["BACK", "ESC / BACKSPACE"],
  ];
  const rowY = box.y + 102;
  const rowGap = IS_PORTRAIT ? 30 : 25;
  const keyX = box.x + 30;
  const valueX = box.x + (IS_PORTRAIT ? 152 : 168);
  rows.forEach(([key, value], index) => {
    const y = rowY + index * rowGap;
    ctx.fillStyle = index % 2 ? "rgba(255,255,255,0.035)" : "rgba(109, 232, 255, 0.045)";
    ctx.fillRect(box.x + 18, y - 18, box.width - 36, rowGap - 4);
    pixelText(key, keyX, y, 13, "#8ff1ff");
    pixelText(value, valueX, y, IS_PORTRAIT ? 12 : 13, "#f5fbff");
  });

  drawSmallPanelButton(layout.back, "BACK");
  ctx.restore();
}

function drawSmallPanelButton(box, label) {
  ctx.save();
  ctx.fillStyle = "rgba(25, 65, 83, 0.9)";
  ctx.strokeStyle = "rgba(178, 235, 245, 0.76)";
  ctx.lineWidth = 3;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  drawPixelTextCentered(label, box.x + box.width / 2, box.y + 26, 14, "#eaf9ff");
  ctx.restore();
}

function drawTwoPlayerSetupScreen() {
  const layout = twoPlayerSetupLayout();
  const background = menuSprites.background;
  const logo = menuSprites.logo;
  ctx.save();
  if (background && background.complete && background.naturalWidth) {
    drawCoverImage(background, 0, 0, W, H);
    ctx.fillStyle = "rgba(3, 8, 12, 0.38)";
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = "rgba(3, 8, 12, 0.78)";
    ctx.fillRect(0, 0, W, H);
  }

  if (logo && logo.complete && logo.naturalWidth) {
    drawCenteredImageContain(logo, W / 2, layout.titleY, W - 170, 96);
  } else {
    drawPixelTextCentered("PIXEL TENNIS", W / 2, layout.titleY, 30, "#fff6c4");
  }
  drawPixelTextCentered("ONLINE ROOM", W / 2, layout.titleY + 76, 17, "#9ff4ff");

  drawTwoPlayerBackButton(layout.back);
  const activeChoice = APP_FLOW.roomCodeInput && APP_FLOW.twoPlayerChoice === 0 ? 1 : APP_FLOW.twoPlayerChoice;
  layout.cards.forEach((card, index) => {
    drawTwoPlayerSetupCard(card, index === activeChoice, index);
  });
  drawRoomCodeInput(layout.input);
  if (roomCodeNativeInput?.classList.contains("room-code-native-input--active")) {
    syncRoomCodeNativeValue();
    positionRoomCodeNativeInput(layout.input);
  }
  ctx.restore();
}

function drawTwoPlayerBackButton(box) {
  ctx.save();
  ctx.fillStyle = "rgba(8, 20, 27, 0.78)";
  ctx.strokeStyle = "rgba(178, 235, 245, 0.58)";
  ctx.lineWidth = 3;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  drawPixelTextCentered("BACK", box.x + box.width / 2, box.y + 26, 14, "#eaf9ff");
  ctx.restore();
}

function drawTwoPlayerSetupCard(card, selected, index) {
  const fills = [
    ["rgba(24, 106, 97, 0.88)", "#fff1a8"],
    ["rgba(37, 75, 112, 0.88)", "#9ff4ff"],
  ];
  const [fill, accent] = fills[index] || fills[0];
  ctx.save();
  ctx.fillStyle = selected ? fill : "rgba(7, 18, 27, 0.86)";
  ctx.strokeStyle = selected ? accent : "rgba(178, 235, 245, 0.5)";
  ctx.lineWidth = selected ? 4 : 3;
  ctx.fillRect(card.x, card.y, card.width, card.height);
  ctx.strokeRect(card.x, card.y, card.width, card.height);
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  ctx.fillRect(card.x + 12, card.y + 10, card.width - 24, 4);
  if (selected) {
    ctx.fillStyle = accent;
    ctx.fillRect(card.x - 14, card.y + 22, 8, card.height - 44);
    ctx.fillRect(card.x + card.width + 6, card.y + 22, 8, card.height - 44);
  }
  drawPixelTextCentered(card.label, card.x + card.width / 2, card.y + 34, 23, selected ? "#fff8df" : "#eaf9ff");
  drawPixelTextCentered(card.subLabel, card.x + card.width / 2, card.y + 58, 12, selected ? accent : "#9bc9d7");
  ctx.restore();
}

function drawRoomCodeInput(box) {
  const code = APP_FLOW.roomCodeInput || "----";
  const activeLabel = "ROOM CODE";
  ctx.save();
  ctx.fillStyle = "rgba(4, 11, 17, 0.92)";
  ctx.strokeStyle = APP_FLOW.roomCodeInput ? "#fff1a8" : "rgba(178, 235, 245, 0.52)";
  ctx.lineWidth = 3;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  pixelText(activeLabel, box.x + 18, box.y + 23, 13, "#9ff4ff");
  drawPixelTextCentered(code, box.x + box.width / 2, box.y + 51, 25, APP_FLOW.roomCodeInput ? "#fff8df" : "#718996");
  ctx.restore();
}

function drawMenuSelectedCharacter(layout) {
  const character = selectedCharacter();
  const box = layout.character;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  ctx.save();
  ctx.fillStyle = "rgba(1, 7, 10, 0.34)";
  ctx.fillRect(cx - 54, box.y + box.height - 22, 108, 9);
  ctx.fillStyle = "rgba(143, 241, 255, 0.12)";
  ctx.fillRect(cx - 34, box.y + box.height - 17, 68, 3);
  drawMenuSprite(portraitForCharacterId(character.id), cx, cy - 10, 150, 190);
  drawPixelTextCentered("<", box.x + 8, cy + 12, 30, "#fff1a8");
  drawPixelTextCentered(">", box.x + box.width - 8, cy + 12, 30, "#fff1a8");
  drawPixelTextCentered(character.name, cx, box.y + box.height + 20, 20, "#fff8df");
  drawPixelTextCentered(character.role, cx, box.y + box.height + 40, 12, "#9ff4ff");
  ctx.restore();
}

function drawCharacterSelectPanel() {
  const layout = characterPanelLayout();
  const box = layout.box;
  ctx.save();
  ctx.fillStyle = "rgba(2, 7, 11, 0.58)";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(5, 12, 18, 0.9)";
  ctx.strokeStyle = "rgba(255, 224, 112, 0.86)";
  ctx.lineWidth = 4;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.fillStyle = "rgba(28, 69, 78, 0.56)";
  ctx.fillRect(box.x + 12, box.y + 12, box.width - 24, 48);
  drawPixelTextCentered("CHOOSE CHARACTER", box.x + box.width / 2, box.y + 43, 22, "#fff4b8");
  drawPixelTextCentered(`PAGE ${layout.page + 1}/${layout.pageCount}`, layout.pageLabel.x, layout.pageLabel.y, 12, "#9ff4ff");

  drawCharacterPanelButton(layout.close, "CLOSE", false);
  for (const slot of layout.slots) {
    drawCharacterSlot(slot);
  }
  drawCharacterPanelButton(layout.prev, "<", false, layout.prev.disabled);
  drawCharacterPanelButton(layout.next, ">", false, layout.next.disabled);
  drawCharacterPanelButton(layout.confirm, "CONFIRM", true, !CHARACTERS[CHARACTER_SELECT.panelChoice]?.unlocked);
  ctx.restore();
}

function drawCharacterSlot(slot) {
  const character = CHARACTERS[slot.index];
  const selected = slot.index === CHARACTER_SELECT.selectedIndex;
  const focused = slot.index === CHARACTER_SELECT.panelChoice;
  const hovered = slot.index === CHARACTER_SELECT.hoverIndex;
  ctx.save();
  ctx.fillStyle = character.unlocked ? "rgba(10, 28, 34, 0.88)" : "rgba(7, 12, 17, 0.78)";
  ctx.strokeStyle = focused ? "#fff1a8" : selected ? "rgba(255, 241, 168, 0.72)" : hovered ? "#9ff4ff" : "rgba(178, 235, 245, 0.38)";
  ctx.lineWidth = selected || focused || hovered ? 4 : 2;
  ctx.fillRect(slot.x, slot.y, slot.width, slot.height);
  ctx.strokeRect(slot.x, slot.y, slot.width, slot.height);
  if (character.unlocked) {
    drawMenuSprite(portraitForCharacterId(character.id), slot.x + slot.width / 2, slot.y + slot.height / 2 + 4, slot.width - 12, slot.height - 8);
  } else {
    ctx.fillStyle = "rgba(255, 255, 255, 0.035)";
    ctx.fillRect(slot.x + 12, slot.y + 12, slot.width - 24, slot.height - 24);
    ctx.fillStyle = "rgba(143, 241, 255, 0.12)";
    ctx.fillRect(slot.x + slot.width / 2 - 14, slot.y + slot.height / 2 - 2, 28, 4);
    ctx.fillRect(slot.x + slot.width / 2 - 2, slot.y + slot.height / 2 - 14, 4, 28);
  }
  if (!selected) {
    const label = String(slot.index + 1).padStart(2, "0");
    ctx.fillStyle = "rgba(6, 18, 24, 0.72)";
    ctx.fillRect(slot.x + 5, slot.y + 5, 24, 16);
    drawPixelTextCentered(label, slot.x + 17, slot.y + 17, 10, "#c9f8ff");
  }
  ctx.restore();
}

function drawCharacterPanelButton(box, label, primary, disabled = false) {
  ctx.save();
  ctx.globalAlpha = disabled ? 0.42 : 1;
  ctx.fillStyle = primary ? "rgba(26, 132, 120, 0.88)" : "rgba(8, 20, 27, 0.78)";
  ctx.strokeStyle = primary ? "#fff1a8" : "rgba(178, 235, 245, 0.58)";
  ctx.lineWidth = 3;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  drawPixelTextCentered(label, box.x + box.width / 2, box.y + (primary ? 29 : 23), primary ? 16 : 12, "#fff8df");
  ctx.restore();
}

function drawMenuPlayerPlate(cx, cy, color) {
  ctx.save();
  ctx.fillStyle = "rgba(1, 7, 10, 0.46)";
  ctx.fillRect(cx - 60, cy - 18, 120, 36);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.strokeRect(cx - 60, cy - 18, 120, 36);
  ctx.restore();
}

function drawMenuSprite(sprite, cx, cy, maxWidth, maxHeight) {
  if (sprite && sprite.complete && sprite.naturalWidth) {
    drawCenteredImageContain(sprite, cx, cy, maxWidth, maxHeight);
    return;
  }
  ctx.save();
  ctx.fillStyle = "#f1d06b";
  ctx.fillRect(cx - 24, cy - 52, 48, 86);
  ctx.fillStyle = "#2e483f";
  ctx.fillRect(cx - 18, cy - 70, 36, 32);
  ctx.restore();
}

function drawModeSelectButton(button, selected, index) {
  const sprite = menuSprites[button.assetKey];
  const usingSprite = sprite && sprite.complete && sprite.naturalWidth;
  if (usingSprite) {
    ctx.drawImage(sprite, button.x, button.y, button.width, button.height);
  } else {
    drawModeButtonPlaceholder(button, selected, index);
  }
  if (usingSprite && !MENU_BUTTON_TEXT_OVERLAY) return;
  const labelColor = selected ? "#fff9c9" : "#eaf9ff";
  const subColor = selected ? "#7cf4ff" : "#a9dce8";
  drawPixelTextCentered(button.label, button.x + button.width / 2, button.y + 42, 25, labelColor);
  drawPixelTextCentered(button.subLabel, button.x + button.width / 2, button.y + 68, 13, subColor);
}

function drawModeButtonPlaceholder(button, selected, index) {
  const theme = currentTheme();
  const accent = index === 0 ? theme.swatch[1] : theme.swatch[0];
  ctx.save();
  ctx.fillStyle = selected ? "rgba(23, 56, 63, 0.92)" : "rgba(7, 20, 27, 0.9)";
  ctx.fillRect(button.x, button.y, button.width, button.height);
  ctx.fillStyle = selected ? "rgba(255, 230, 128, 0.16)" : "rgba(255, 255, 255, 0.06)";
  ctx.fillRect(button.x + 8, button.y + 8, button.width - 16, button.height - 16);
  ctx.strokeStyle = selected ? "#fff1a8" : "rgba(178, 235, 245, 0.62)";
  ctx.lineWidth = selected ? 4 : 3;
  ctx.strokeRect(button.x, button.y, button.width, button.height);
  ctx.fillStyle = accent;
  ctx.fillRect(button.x, button.y, 12, button.height);
  ctx.fillRect(button.x + button.width - 12, button.y, 12, button.height);
  ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
  ctx.fillRect(button.x + 24, button.y + 16, button.width - 48, 4);
  if (selected) {
    ctx.fillStyle = "#fff1a8";
    ctx.fillRect(button.x - 16, button.y + 30, 8, 28);
    ctx.fillRect(button.x + button.width + 8, button.y + 30, 8, 28);
  }
  ctx.restore();
}

function drawOnlineRoomPanel(stale) {
  const box = IS_PORTRAIT
    ? { x: 42, y: 286, width: W - 84, height: 168 }
    : { x: 284, y: 252, width: 392, height: 146 };
  const title = ONLINE.room ? `ROOM ${ONLINE.room}` : "ONLINE ROOM";
  const status = onlineStatusText(stale);
  const role = onlineRoleText();
  ctx.save();
  ctx.fillStyle = "rgba(5, 10, 15, 0.82)";
  ctx.strokeStyle = "rgba(255, 219, 94, 0.82)";
  ctx.lineWidth = 3;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.fillStyle = "rgba(40, 75, 82, 0.48)";
  ctx.fillRect(box.x + 10, box.y + 10, box.width - 20, 42);
  drawPixelTextCentered(title, box.x + box.width / 2, box.y + 40, 24, "#fff3a8");
  drawPixelTextCentered(status, box.x + box.width / 2, box.y + 82, 18, "#e8fbff");
  drawPixelTextCentered(role, box.x + box.width / 2, box.y + 112, 15, "#9feaff");
  if (ONLINE.room) {
    drawPixelTextCentered("SHARE ROOM CODE WITH FRIEND", box.x + box.width / 2, box.y + 140, 13, "#ffdc72");
  } else if (!ONLINE.serverUrl) {
    drawPixelTextCentered("ADD SERVER PARAM TO URL", box.x + box.width / 2, box.y + 140, 13, "#ffdc72");
  }
  ctx.restore();
}

function drawOnlineBadge() {
  const label = `${String(ONLINE.playerId || "P?").toUpperCase()}${isMirroredView() ? " MIRROR" : " ONLINE"}`;
  const x = IS_PORTRAIT ? W - 146 : W - 176;
  const y = IS_PORTRAIT ? 18 : 22;
  const width = IS_PORTRAIT ? 128 : 150;
  ctx.save();
  ctx.fillStyle = "rgba(4, 14, 18, 0.64)";
  ctx.strokeStyle = "rgba(91, 240, 255, 0.54)";
  ctx.lineWidth = 2;
  ctx.fillRect(x, y, width, 30);
  ctx.strokeRect(x, y, width, 30);
  pixelText(label, x + 12, y + 21, 13, "#baf7ff");
  ctx.restore();
}

function onlineStatusText(stale) {
  if (!ONLINE.serverUrl) return "SERVER URL REQUIRED";
  if (stale) return "SYNCING...";
  if (ONLINE.status === "connected") {
    return state.phase === "waiting" ? state.message || "WAITING" : "CONNECTED";
  }
  if (ONLINE.status === "connecting") return "CONNECTING...";
  if (ONLINE.status === "disconnected") return "RECONNECTING...";
  if (ONLINE.status === "error") return "CONNECTION ERROR";
  return ONLINE.message || "ONLINE";
}

function onlineRoleText() {
  if (ONLINE.role === "spectator") return "SPECTATOR";
  if (ONLINE.playerId === "p1") return "YOU CONTROL P1 BOTTOM";
  if (ONLINE.playerId === "p2") return "MIRROR VIEW: P2 BOTTOM";
  return "JOINING ROOM";
}

function drawRacketIcon(x, y, scale) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.72);
  ctx.scale(scale, scale);
  ctx.strokeStyle = "#61260c";
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(0, 18);
  ctx.lineTo(0, 58);
  ctx.stroke();
  ctx.strokeStyle = "#4e1d0a";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(0, -14, 26, 34, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "#f8d15b";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.ellipse(0, -14, 20, 28, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "#7b3c13";
  ctx.lineWidth = 1;
  for (let i = -14; i <= 14; i += 7) {
    ctx.beginPath();
    ctx.moveTo(i, -38);
    ctx.lineTo(i, 10);
    ctx.stroke();
  }
  for (let i = -32; i <= 8; i += 8) {
    ctx.beginPath();
    ctx.moveTo(-18, i);
    ctx.lineTo(18, i);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTinyBar(x, y, width, height, amount, color) {
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, Math.round(width * clamp(amount, 0, 1)), height);
}

function pixelText(text, x, y, size, color) {
  ctx.save();
  ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillText(text, Math.round(x + 2), Math.round(y + 2));
  ctx.fillStyle = color;
  ctx.fillText(text, Math.round(x), Math.round(y));
  ctx.restore();
}

function makeNoiseTiles(x, y, width, height, colors, size, count) {
  return Array.from({ length: count }, () => {
    const px = x + Math.random() * width;
    const py = y + Math.random() * height;
    return {
      x: Math.round(px / size) * size,
      y: Math.round(py / size) * size,
      size,
      color: colors[(Math.random() * colors.length) | 0],
    };
  });
}

function drawStaticNoise(tiles) {
  for (const tile of tiles) {
    ctx.fillStyle = tile.color;
    ctx.fillRect(tile.x, tile.y, tile.size, tile.size);
  }
}

function drawCoverImage(image, x, y, width, height) {
  const imageRatio = image.naturalWidth / image.naturalHeight;
  const targetRatio = width / height;
  let sx = 0;
  let sy = 0;
  let sw = image.naturalWidth;
  let sh = image.naturalHeight;
  if (imageRatio > targetRatio) {
    sw = image.naturalHeight * targetRatio;
    sx = (image.naturalWidth - sw) / 2;
  } else {
    sh = image.naturalWidth / targetRatio;
    sy = (image.naturalHeight - sh) / 2;
  }
  ctx.drawImage(image, sx, sy, sw, sh, x, y, width, height);
}

function drawCenteredImageFixedWidth(image, cx, cy, width) {
  const height = width * (image.naturalHeight / image.naturalWidth);
  ctx.drawImage(image, cx - width / 2, cy - height / 2, width, height);
}

function drawControlPlate(cx, cy, radius, alpha = 0.88) {
  ctx.save();
  ctx.fillStyle = `rgba(2, 11, 14, ${alpha})`;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawCenteredImageContain(image, cx, cy, maxWidth, maxHeight) {
  const ratio = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
  const width = image.naturalWidth * ratio;
  const height = image.naturalHeight * ratio;
  ctx.drawImage(image, cx - width / 2, cy - height / 2, width, height);
}

function createNoiseTiles() {
  const grassTop = worldToScreen(0, TUNING.world.yMin).y;
  const grassBottom = worldToScreen(0, TUNING.world.yMax).y;
  const courtTop = worldToScreen(0, -TUNING.world.baselineY).y;
  const courtBottom = worldToScreen(0, TUNING.world.baselineY).y;
  const grassX = IS_PORTRAIT ? 38 : 155;
  const grassW = IS_PORTRAIT ? W - 76 : 690;
  const courtX = IS_PORTRAIT ? Math.round(W / 2 - 160) : 220;
  const courtW = IS_PORTRAIT ? 320 : 520;
  return {
    background: makeNoiseTiles(0, 0, W, H, ["#2f4b2b", "#456f39", "#1d301e"], 8, 260),
    grass: makeNoiseTiles(grassX, grassTop, grassW, grassBottom - grassTop, ["#5b8a54", "#76a165", "#346b41"], 7, 180),
    court: makeNoiseTiles(
      courtX,
      courtTop,
      courtW,
      courtBottom - courtTop,
      ["rgba(255,255,255,0.035)", "rgba(0,0,0,0.04)"],
      5,
      180,
    ),
  };
}

function fillWorldQuad(x1, y1, x2, y2, color) {
  const a = worldToScreen(x1, y1);
  const b = worldToScreen(x2, y1);
  const c = worldToScreen(x2, y2);
  const d = worldToScreen(x1, y2);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
  ctx.lineTo(d.x, d.y);
  ctx.closePath();
  ctx.fill();
}

function drawWorldLine(x1, y1, x2, y2) {
  ctx.beginPath();
  const steps = 18;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const p = worldToScreen(lerp(x1, x2, t), lerp(y1, y2, t));
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function worldToScreen(x, y) {
  const view = worldToViewPoint(x, y);
  const yNorm = (view.y - TUNING.world.yMin) / (TUNING.world.yMax - TUNING.world.yMin);
  const sy = lerp(COURT.top, COURT.bottom, yNorm);
  const perspective = 1 + view.y * 0.012;
  const sx = COURT.cx + view.x * COURT.baseScaleX * perspective;
  return { x: sx, y: sy };
}

function screenToWorld(x, y) {
  const yNorm = clamp((y - COURT.top) / (COURT.bottom - COURT.top), 0, 1);
  const wy = lerp(TUNING.world.yMin, TUNING.world.yMax, yNorm);
  const perspective = 1 + wy * 0.012;
  const wx = (x - COURT.cx) / (COURT.baseScaleX * perspective);
  return viewToWorldPoint(wx, wy);
}

function previewResult(winner = "player") {
  const playerWon = winner !== "ai";
  ball.inPlay = false;
  state.phase = "matchOver";
  state.resultTime = 0;
  state.message = "";
  state.messageSub = "";
  state.maxRally = Math.max(state.maxRally, playerWon ? 28 : 21);
  state.playerGames = playerWon ? TUNING.match.gamesToWin : Math.max(0, TUNING.match.gamesToWin - 1);
  state.aiGames = playerWon ? Math.max(0, TUNING.match.gamesToWin - 1) : TUNING.match.gamesToWin;
  state.result = {
    winner: playerWon ? "player" : "ai",
    playerGames: state.playerGames,
    aiGames: state.aiGames,
    maxRally: state.maxRally,
    themeIndex: state.themeIndex,
  };
}

window.PixelTennis = {
  TUNING,
  reset: resetMatch,
  snapshot() {
    const score = scoreView();
    const playerScreen = worldToScreen(player.x, player.y);
    const aiScreen = worldToScreen(ai.x, ai.y);
    const ballScreen = worldToScreen(ball.x, ball.y);
    return {
      app: {
        screen: APP_FLOW.screen,
        selectedMode: APP_FLOW.selectedMode,
        menuChoice: APP_FLOW.menuChoice,
        twoPlayerChoice: APP_FLOW.twoPlayerChoice,
        roomCodeInput: APP_FLOW.roomCodeInput,
        roomCodeMode: APP_FLOW.roomCodeMode,
        pauseMenuOpen: APP_FLOW.pauseMenuOpen,
      },
      characters: {
        selected: selectedCharacterId(),
        panelOpen: CHARACTER_SELECT.panelOpen,
        page: CHARACTER_SELECT.page,
        pageCount: characterPageCount(),
        slotCount: CHARACTERS.length,
        player: player.characterId,
        ai: ai.characterId,
      },
      phase: state.phase,
      message: state.message,
      rallyHits: state.rallyHits,
      maxRally: state.maxRally,
      result: state.result,
      score: {
        playerPoints: state.playerPoints,
        aiPoints: state.aiPoints,
        playerGames: state.playerGames,
        aiGames: state.aiGames,
      },
      energy: state.energy,
      playerShotPressure: state.playerShotPressure,
      player: { x: player.x, y: player.y },
      ai: { x: ai.x, y: ai.y },
      ball: { x: ball.x, y: ball.y, z: ball.z, inPlay: ball.inPlay },
      view: {
        mirrored: isMirroredView(),
        score,
        playerScreen,
        aiScreen,
        ballScreen,
      },
      online: ONLINE.enabled
        ? {
            status: ONLINE.status,
            room: ONLINE.room,
            playerId: ONLINE.playerId,
            role: ONLINE.role,
            serverUrl: ONLINE.serverUrl,
            snapshotAgeMs: ONLINE.snapshotAt ? Math.round(performance.now() - ONLINE.snapshotAt) : null,
            rttMs: ONLINE.rttMs === null ? null : Math.round(ONLINE.rttMs),
            debug: netDebug ? netDebug.summary() : null,
          }
        : null,
    };
  },
  previewResult,
};

noiseTiles = createNoiseTiles();
placeBallForServe();
initOnlineMode();
const previewWinner = URL_PARAMS.get("previewResult");
if (!ONLINE.enabled && (previewWinner === "player" || previewWinner === "ai")) {
  previewResult(previewWinner);
}
requestAnimationFrame(gameLoop);
