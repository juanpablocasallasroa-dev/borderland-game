require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();

const ALLOWED_ORIGIN = process.env.FRONTEND_URL || "https://borderland-game-five.vercel.app";

app.use(cors({ origin: ALLOWED_ORIGIN }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN },
  maxHttpBufferSize: 10e6,
  pingTimeout: 30000,
  pingInterval: 10000
});

const CONFIG = {
  MAX_PLAYERS: 9,
  COUNTDOWN_SECONDS: 5,
  ROUND_SECONDS: 30,
  RESULTS_DURATION: 16000,
  MULTIPLIER: 0.8,
  MAX_LIVES: 10,
  MIN_PLAYERS_TO_START: 2,
  TUTORIAL_SLIDES: 8
};

const RULES_POOL = [
  {
    id: "exact_number",
    name: "NÚMERO EXACTO",
    description: "Si un jugador elige el número exacto del resultado, el resto suma +2 puntos",
    icon: "🎯"
  },
  {
    id: "duplicate_number",
    name: "NÚMERO DUPLICADO",
    description: "Si dos o más jugadores eligen el mismo número, ambos suman +1 punto extra",
    icon: "👥"
  },
  {
    id: "reduced_range",
    name: "RANGO REDUCIDO",
    description: "Solo se pueden elegir números entre 1 y 50. Fuera del rango = +2 puntos automáticos",
    icon: "📏"
  },
  {
    id: "inverted_number",
    name: "NÚMERO INVERTIDO",
    description: "Tu número se transforma: se usa (100 - tu número) para el cálculo",
    icon: "🔄"
  },
  {
    id: "reduced_time",
    name: "TIEMPO REDUCIDO",
    description: "Las rondas pasan de 30 segundos a 15 segundos",
    icon: "⏱️"
  },
  {
    id: "double_punishment",
    name: "DOBLE CASTIGO",
    description: "El jugador MÁS LEJANO al resultado suma +2 en vez de +1",
    icon: "💀"
  },
  {
    id: "blind_number",
    name: "NÚMERO CIEGO",
    description: "No puedes ver cuántos jugadores han enviado su número",
    icon: "🙈"
  },
  {
    id: "no_repeat",
    name: "PROHIBIDO REPETIR",
    description: "No puedes elegir el mismo número que elegiste en la ronda anterior. Si lo haces, sumas +2",
    icon: "🚫"
  },
  {
    id: "sudden_death",
    name: "MUERTE SÚBITA",
    description: "El multiplicador cambia de ×0.8 a ×0.5",
    icon: "⚡"
  }
];

const FINAL_RULE = {
  id: "zero_vs_hundred",
  name: "CERO VS CIEN",
  description: "Si un jugador elige 0 y el otro elige 100, el que eligió 0 gana automáticamente la ronda",
  icon: "🆚"
};

let game = createFreshGame();
const playerPhotos = {};

function createFreshGame() {
  return {
    phase: "lobby",
    round: 1,
    timer: 0,
    players: [],
    numbers: {},
    average: null,
    target: null,
    winnerId: null,
    config: { ...CONFIG },
    roundHistory: [],
    eliminatedThisRound: [],
    activeRules: [],
    pendingRules: [],
    shuffledRules: [],
    previousNumbers: {},
    currentRuleIndex: 0,
    tutorialSlide: 0,
    furthestPlayerId: null
  };
}

function getAlivePlayers() {
  return game.players.filter(p => p.alive);
}

function getPublicGameState() {
  return {
    ...game,
    players: game.players.map(p => ({ ...p, photo: undefined }))
  };
}

function getPlayerPhotosMap() {
  const map = {};
  game.players.forEach(p => {
    map[p.id] = playerPhotos[p.id] || null;
  });
  return map;
}

function broadcastState() {
  io.emit("gameState", getPublicGameState());
}

function reassignHost() {
  if (game.players.length > 0 && !game.players.some(p => p.host)) {
    const firstAlive = game.players.find(p => p.alive) || game.players[0];
    if (firstAlive) firstAlive.host = true;
  }
}

function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function isRuleActive(ruleId) {
  return game.activeRules.some(r => r.id === ruleId);
}

function getCurrentMultiplier() {
  return isRuleActive("sudden_death") ? 0.5 : CONFIG.MULTIPLIER;
}

function getCurrentRoundTime() {
  return isRuleActive("reduced_time") ? 15 : CONFIG.ROUND_SECONDS;
}

let activeInterval = null;
let resultsTimeout = null;

function clearAllTimers() {
  if (activeInterval) { clearInterval(activeInterval); activeInterval = null; }
  if (resultsTimeout) { clearTimeout(resultsTimeout); resultsTimeout = null; }
}

function startCountdown() {
  clearAllTimers();
  game.phase = "countdown";
  game.timer = CONFIG.COUNTDOWN_SECONDS;
  game.numbers = {};
  game.average = null;
  game.target = null;
  game.winnerId = null;
  game.eliminatedThisRound = [];
  game.furthestPlayerId = null;
  broadcastState();

  activeInterval = setInterval(() => {
    game.timer--;
    if (game.timer <= 0) {
      clearInterval(activeInterval);
      activeInterval = null;
      startRound();
    } else {
      broadcastState();
    }
  }, 1000);
}

function startRound() {
  game.phase = "round";
  game.timer = getCurrentRoundTime();
  broadcastState();

  activeInterval = setInterval(() => {
    game.timer--;
    if (game.timer <= 0) {
      clearInterval(activeInterval);
      activeInterval = null;
      endRound();
    } else {
      broadcastState();
    }
  }, 1000);
}

function endRound() {
  const alivePlayers = getAlivePlayers();
  alivePlayers.forEach(p => {
    if (game.numbers[p.id] === undefined) {
      game.numbers[p.id] = Math.floor(Math.random() * 101);
    }
  });

  game.phase = "results";
  calculateResults();
  broadcastState();

  resultsTimeout = setTimeout(() => {
    afterResults();
  }, CONFIG.RESULTS_DURATION);
}

function calculateResults() {
  const alivePlayers = getAlivePlayers();
  const multiplier = getCurrentMultiplier();

  if (isRuleActive("zero_vs_hundred") && alivePlayers.length === 2) {
    const p1 = alivePlayers[0];
    const p2 = alivePlayers[1];
    const n1 = game.numbers[p1.id];
    const n2 = game.numbers[p2.id];

    if ((n1 === 0 && n2 === 100) || (n1 === 100 && n2 === 0)) {
      const zeroPlayer = n1 === 0 ? p1 : p2;
      const hundredPlayer = n1 === 100 ? p1 : p2;

      game.average = 50;
      game.target = 50 * multiplier;
      game.winnerId = zeroPlayer.id;

      hundredPlayer.lives += 1;
      if (hundredPlayer.lives >= CONFIG.MAX_LIVES) {
        hundredPlayer.alive = false;
        game.eliminatedThisRound.push(hundredPlayer.id);
      }

      game.previousNumbers = { ...game.numbers };
      game.roundHistory.push({
        round: game.round,
        numbers: { ...game.numbers },
        average: game.average,
        target: game.target,
        winnerId: game.winnerId,
        specialRule: "zero_vs_hundred"
      });
      return;
    }
  }

  let effectiveNumbers = {};
  alivePlayers.forEach(p => {
    let num = game.numbers[p.id];
    if (isRuleActive("inverted_number")) {
      num = 100 - num;
    }
    effectiveNumbers[p.id] = num;
  });

  const values = Object.values(effectiveNumbers);
  if (values.length === 0) return;

  const sum = values.reduce((a, b) => a + b, 0);
  const avg = sum / values.length;
  const target = avg * multiplier;

  game.average = Math.round(avg * 100) / 100;
  game.target = Math.round(target * 100) / 100;

  let playerDistances = alivePlayers
    .map(p => ({
      id: p.id,
      number: effectiveNumbers[p.id],
      originalNumber: game.numbers[p.id],
      diff: Math.abs(effectiveNumbers[p.id] - target)
    }))
    .sort((a, b) => a.diff - b.diff);

  const minDiff = playerDistances[0].diff;
  const winners = playerDistances.filter(p => Math.abs(p.diff - minDiff) < 0.0001);
  const winner = winners.sort((a, b) => a.number - b.number)[0];
  game.winnerId = winner.id;

  const maxDiff = playerDistances[playerDistances.length - 1].diff;
  const furthest = playerDistances.filter(p => Math.abs(p.diff - maxDiff) < 0.0001);
  game.furthestPlayerId = furthest.sort((a, b) => b.number - a.number)[0].id;

  let exactMatchPlayerId = null;
  const roundedTarget = Math.round(target);
  if (isRuleActive("exact_number")) {
    alivePlayers.forEach(p => {
      if (game.numbers[p.id] === roundedTarget) {
        exactMatchPlayerId = p.id;
      }
    });
  }

  let duplicatedPlayerIds = [];
  if (isRuleActive("duplicate_number")) {
    const numberCount = {};
    alivePlayers.forEach(p => {
      const num = game.numbers[p.id];
      if (!numberCount[num]) numberCount[num] = [];
      numberCount[num].push(p.id);
    });
    Object.values(numberCount).forEach(ids => {
      if (ids.length >= 2) duplicatedPlayerIds.push(...ids);
    });
  }

  let repeatedPlayerIds = [];
  if (isRuleActive("no_repeat")) {
    alivePlayers.forEach(p => {
      if (game.previousNumbers[p.id] !== undefined &&
          game.numbers[p.id] === game.previousNumbers[p.id]) {
        repeatedPlayerIds.push(p.id);
      }
    });
  }

  let outOfRangePlayerIds = [];
  if (isRuleActive("reduced_range")) {
    alivePlayers.forEach(p => {
      const num = game.numbers[p.id];
      if (num < 1 || num > 50) outOfRangePlayerIds.push(p.id);
    });
  }

  alivePlayers.forEach(p => {
    if (p.id === winner.id) {
      if (exactMatchPlayerId && exactMatchPlayerId !== p.id) p.lives += 2;
      if (duplicatedPlayerIds.includes(p.id)) p.lives += 1;
      if (repeatedPlayerIds.includes(p.id)) p.lives += 2;
      if (outOfRangePlayerIds.includes(p.id)) p.lives += 2;
    } else {
      p.lives += 1;
      if (isRuleActive("double_punishment") && p.id === game.furthestPlayerId) p.lives += 1;
      if (exactMatchPlayerId && exactMatchPlayerId !== p.id) p.lives += 2;
      if (duplicatedPlayerIds.includes(p.id)) p.lives += 1;
      if (repeatedPlayerIds.includes(p.id)) p.lives += 2;
      if (outOfRangePlayerIds.includes(p.id)) p.lives += 2;
    }

    if (p.lives >= CONFIG.MAX_LIVES && p.alive) {
      p.alive = false;
      game.eliminatedThisRound.push(p.id);
    }
  });

  game.previousNumbers = { ...game.numbers };
  game.roundHistory.push({
    round: game.round,
    numbers: { ...game.numbers },
    effectiveNumbers: { ...effectiveNumbers },
    average: game.average,
    target: game.target,
    winnerId: game.winnerId,
    furthestPlayerId: game.furthestPlayerId,
    exactMatchPlayerId,
    duplicatedPlayerIds,
    repeatedPlayerIds,
    outOfRangePlayerIds,
    eliminated: [...game.eliminatedThisRound]
  });
}

function afterResults() {
  if (game.eliminatedThisRound.length > 0) {
    game.pendingRules = [];
    game.eliminatedThisRound.forEach(() => {
      const alivePlayers = getAlivePlayers();
      if (alivePlayers.length === 2 && !isRuleActive("zero_vs_hundred")) {
        game.pendingRules.push(FINAL_RULE);
      } else if (game.shuffledRules.length > 0) {
        game.pendingRules.push(game.shuffledRules.shift());
      }
    });

    if (game.pendingRules.length > 0) {
      game.currentRuleIndex = 0;
      showNextRule();
    } else {
      checkGameEnd();
    }
  } else {
    checkGameEnd();
  }
}

function showNextRule() {
  if (game.currentRuleIndex >= game.pendingRules.length) {
    checkGameEnd();
    return;
  }
  const rule = game.pendingRules[game.currentRuleIndex];
  game.activeRules.push(rule);
  game.phase = "new-rule";
  broadcastState();
}

function checkGameEnd() {
  const alivePlayers = getAlivePlayers();
  if (alivePlayers.length <= 1) {
    game.phase = "finished";
    clearAllTimers();
    broadcastState();
    return;
  }
  game.round++;
  startCountdown();
}

io.on("connection", (socket) => {
  console.log(`Conectado: ${socket.id}`);

  socket.emit("gameState", getPublicGameState());
  socket.emit("playerPhotos", getPlayerPhotosMap());

  socket.on("joinGame", ({ name, photo }) => {
    if (game.phase !== "lobby") {
      socket.emit("error", { message: "La partida ya comenzó" });
      return;
    }
    if (game.players.find(p => p.id === socket.id)) return;
    if (game.players.length >= CONFIG.MAX_PLAYERS) {
      socket.emit("error", { message: "Sala llena" });
      return;
    }
    if (!name || name.trim().length === 0) {
      socket.emit("error", { message: "Nombre requerido" });
      return;
    }

    const isHost = game.players.length === 0;
    game.players.push({
      id: socket.id,
      name: name.trim().substring(0, 15),
      lives: 0,
      host: isHost,
      alive: true
    });

    if (photo) playerPhotos[socket.id] = photo;
    broadcastState();
    io.emit("playerPhotos", getPlayerPhotosMap());
  });

  socket.on("startGame", () => {
    if (game.phase !== "lobby") return;
    const player = game.players.find(p => p.id === socket.id);
    if (!player || !player.host) return;
    if (game.players.length < CONFIG.MIN_PLAYERS_TO_START) {
      socket.emit("error", { message: `Mínimo ${CONFIG.MIN_PLAYERS_TO_START} jugadores` });
      return;
    }
    game.shuffledRules = shuffleArray([...RULES_POOL]);
    game.phase = "tutorial";
    game.tutorialSlide = 0;
    broadcastState();
  });

  socket.on("tutorialFinished", () => {
    if (game.phase !== "tutorial") return;
    const player = game.players.find(p => p.id === socket.id);
    if (!player || !player.host) return;
    startCountdown();
  });

  socket.on("submitNumber", (number) => {
    if (game.phase !== "round") return;
    const player = game.players.find(p => p.id === socket.id);
    if (!player || !player.alive) return;
    if (game.numbers[socket.id] !== undefined) return;

    const parsed = Number(number);
    if (isNaN(parsed) || parsed < 0 || parsed > 100 || !Number.isInteger(parsed)) return;

    game.numbers[socket.id] = parsed;

    if (!isRuleActive("blind_number")) {
      const aliveCount = getAlivePlayers().length;
      const submittedCount = Object.keys(game.numbers).length;
      io.emit("submitProgress", { submitted: submittedCount, total: aliveCount });
    }

    const aliveCount = getAlivePlayers().length;
    const submittedCount = Object.keys(game.numbers).length;
    if (submittedCount >= aliveCount) {
      clearAllTimers();
      endRound();
    }
  });

  socket.on("nextRule", () => {
    if (game.phase !== "new-rule") return;
    const player = game.players.find(p => p.id === socket.id);
    if (!player || !player.host) return;
    game.currentRuleIndex++;
    showNextRule();
  });

  socket.on("resetGame", () => {
    const player = game.players.find(p => p.id === socket.id);
    if (!player || !player.host) return;
    clearAllTimers();
    const currentPlayers = game.players.map(p => ({
      ...p,
      lives: 0,
      alive: true
    }));
    game = createFreshGame();
    game.players = currentPlayers;
    broadcastState();
  });

  socket.on("disconnect", () => {
    console.log(`Desconectado: ${socket.id}`);
    game.players = game.players.filter(p => p.id !== socket.id);
    delete playerPhotos[socket.id];
    delete game.numbers[socket.id];
    reassignHost();

    if (game.phase !== "lobby" && game.phase !== "finished" && game.phase !== "tutorial") {
      const alivePlayers = getAlivePlayers();
      if (alivePlayers.length <= 1) {
        clearAllTimers();
        game.phase = "finished";
      }
    }

    broadcastState();
    io.emit("playerPhotos", getPlayerPhotosMap());
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
