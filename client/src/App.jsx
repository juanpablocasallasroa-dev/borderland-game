import { useEffect, useState, useRef, useCallback } from "react";
import { io } from "socket.io-client";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";
const socket = io(BACKEND_URL, {
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: Infinity,
  timeout: 20000
});

// ============================================
// SOUND MANAGER
// ============================================
const sounds = {};
const soundFiles = [
  "join", "tick", "round-start", "select", "confirm",
  "urgent", "reveal", "number-drop", "calculate",
  "multiply", "win", "point", "elimination",
  "new-rule", "victory", "intro-music"
];

let audioUnlocked = false;
let globalMuted = false;

function loadSounds() {
  soundFiles.forEach(name => {
    try {
      const audio = new Audio(`/sounds/${name}.mp3`);
      audio.preload = "auto";
      audio.load();
      sounds[name] = audio;
    } catch (e) {
      console.warn(`Error cargando: ${name}.mp3`);
    }
  });
}

function unlockAudio() {
  if (audioUnlocked) return;
  Object.values(sounds).forEach(audio => {
    try {
      const vol = audio.volume;
      audio.volume = 0;
      const p = audio.play();
      if (p) {
        p.then(() => {
          audio.pause();
          audio.currentTime = 0;
          audio.volume = vol;
        }).catch(() => {});
      }
    } catch (e) {}
  });

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
    ctx.resume();
  } catch (e) {}

  audioUnlocked = true;
}

function playSound(name, { loop = false, volume = 0.7 } = {}) {
  if (globalMuted) return;
  try {
    const original = sounds[name];
    if (!original) return;

    if (loop) {
      original.currentTime = 0;
      original.loop = true;
      original.volume = Math.max(0, Math.min(1, volume));
      original.play().catch(() => {});
    } else {
      const clone = original.cloneNode(true);
      clone.volume = Math.max(0, Math.min(1, volume));
      clone.loop = false;
      clone.play().catch(() => {});
      clone.addEventListener("ended", () => {
        clone.src = "";
      });
    }
  } catch (e) {}
}

function stopSound(name) {
  try {
    const s = sounds[name];
    if (!s) return;
    s.pause();
    s.currentTime = 0;
    s.loop = false;
  } catch (e) {}
}

function stopAllSounds() {
  soundFiles.forEach(name => stopSound(name));
}

// ============================================
// TUTORIAL SLIDES
// ============================================
const TUTORIAL_SLIDES = [
  {
    title: "♦ KING OF DIAMONDS ♦",
    lines: ["Bienvenidos al juego", "del Rey de Diamantes"],
    icon: "♦",
    bg: "radial-gradient(ellipse at center, #2a0000 0%, #000 70%)"
  },
  {
    title: "TU DISPOSITIVO ES TU ARMA",
    lines: ["Frente a ustedes hay una pantalla", "Desde sus dispositivos controlarán el juego", "Cada uno elegirá un número en SECRETO", "Nadie puede ver la elección de los demás"],
    icon: "📱",
    bg: "radial-gradient(ellipse at center, #0a1a2a 0%, #000 70%)"
  },
  {
    title: "ELIGE UN NÚMERO",
    lines: ["En cada ronda tendrás 30 segundos", "para elegir un número del 0 al 100", "", "Una vez confirmado", "NO hay vuelta atrás"],
    icon: "🔢",
    bg: "radial-gradient(ellipse at center, #1a1a0a 0%, #000 70%)"
  },
  {
    title: "EL CÁLCULO",
    lines: ["Se suman todos los números elegidos", "Se dividen entre la cantidad de jugadores", "", "PROMEDIO  ×  0.8  =  RESULTADO"],
    icon: "🧮",
    bg: "radial-gradient(ellipse at center, #0a2a1a 0%, #000 70%)"
  },
  {
    title: "¿QUIÉN SE SALVA?",
    lines: ["El jugador cuyo número esté", "MÁS CERCA del resultado", "→  SE SALVA", "", "El resto  →  SUMA +1 PUNTO"],
    icon: "🎯",
    bg: "radial-gradient(ellipse at center, #0a1a0a 0%, #000 70%)"
  },
  {
    title: "⚠ ELIMINACIÓN ⚠",
    lines: ["Si llegas a 10 puntos", "serás ELIMINADO del juego", "", "No hay segunda oportunidad", "No hay misericordia"],
    icon: "💀",
    bg: "radial-gradient(ellipse at center, #2a0a0a 0%, #000 70%)"
  },
  {
    title: "NUEVAS REGLAS",
    lines: ["Cada vez que un jugador es eliminado", "se activa una NUEVA REGLA", "que afecta a TODOS los jugadores", "", "Las reglas se ACUMULAN", "El juego se vuelve más difícil"],
    icon: "⛓️",
    bg: "radial-gradient(ellipse at center, #1a0a2a 0%, #000 70%)"
  },
  {
    title: "EL ÚLTIMO EN PIE GANA",
    lines: ["Sobrevive", "Adapta tu estrategia", "No llegues a 10", "", "♦ QUE COMIENCE EL JUEGO ♦"],
    icon: "👑",
    bg: "radial-gradient(ellipse at center, #2a1a00 0%, #000 70%)"
  }
];

// ============================================
// APP COMPONENT
// ============================================
function App() {
  const [gameState, setGameState] = useState(null);
  const [photos, setPhotos] = useState({});
  const [name, setName] = useState("");
  const [photoPreview, setPhotoPreview] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [joined, setJoined] = useState(false);
  const [number, setNumber] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [resultsStep, setResultsStep] = useState(0);
  const [submitProgress, setSubmitProgress] = useState(null);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(true);
  const [tutorialSlide, setTutorialSlide] = useState(0);
  const [tutorialDone, setTutorialDone] = useState(false);
  const [muted, setMuted] = useState(false);
  const errorTimeout = useRef(null);
  const prevPhase = useRef(null);
  const prevTimer = useRef(null);

  // Toggle mute
  const toggleMute = () => {
    const newMuted = !muted;
    setMuted(newMuted);
    globalMuted = newMuted;
    if (newMuted) {
      stopAllSounds();
    }
  };

  // Load sounds + unlock
  useEffect(() => {
    loadSounds();

    const unlock = () => {
      unlockAudio();
      document.removeEventListener("click", unlock);
      document.removeEventListener("touchstart", unlock);
      document.removeEventListener("keydown", unlock);
    };

    document.addEventListener("click", unlock);
    document.addEventListener("touchstart", unlock);
    document.addEventListener("keydown", unlock);

    return () => {
      document.removeEventListener("click", unlock);
      document.removeEventListener("touchstart", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, []);

  // ============================================
  // SOCKET LISTENERS
  // ============================================
  useEffect(() => {
    socket.on("gameState", (state) => setGameState(state));
    socket.on("playerPhotos", (photosMap) => setPhotos(photosMap));
    socket.on("submitProgress", (progress) => setSubmitProgress(progress));
    socket.on("error", ({ message }) => showError(message));
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("reconnect", () => setConnected(true));

    return () => {
      socket.off("gameState");
      socket.off("playerPhotos");
      socket.off("submitProgress");
      socket.off("error");
      socket.off("connect");
      socket.off("disconnect");
      socket.off("reconnect");
    };
  }, []);

  // ============================================
  // SOUND TRIGGERS
  // ============================================
  useEffect(() => {
    if (!gameState) return;
    const phase = gameState.phase;
    const prev = prevPhase.current;
    prevPhase.current = phase;

    if (prev !== phase) {
      stopAllSounds();

      if (phase === "tutorial") {
        playSound("intro-music", { loop: true, volume: 0.4 });
      }
      if (phase === "round") {
        playSound("round-start", { volume: 0.5 });
      }
      if (phase === "new-rule") {
        playSound("new-rule", { volume: 0.6 });
      }
      if (phase === "finished") {
        playSound("victory", { volume: 0.8 });
      }
    }

    if (phase === "countdown" || phase === "round") {
      const timer = gameState.timer;
      if (timer !== prevTimer.current) {
        prevTimer.current = timer;
        if (phase === "countdown") {
          playSound("tick", { volume: 0.4 });
        }
        if (phase === "round" && timer <= 10 && timer > 0) {
          playSound("urgent", { volume: 0.3 });
        }
      }
    }
  }, [gameState?.phase, gameState?.timer]);

  // Reset on new round
  useEffect(() => {
    if (gameState?.phase === "round") {
      setSubmitted(false);
      setNumber(null);
      setSubmitProgress(null);
    }
  }, [gameState?.phase, gameState?.round]);

  // Tutorial auto-advance
  useEffect(() => {
    if (gameState?.phase === "tutorial") {
      setTutorialSlide(0);
      setTutorialDone(false);

      let currentSlide = 0;
      const interval = setInterval(() => {
        currentSlide++;
        if (currentSlide >= TUTORIAL_SLIDES.length) {
          clearInterval(interval);
          setTutorialDone(true);
        } else {
          setTutorialSlide(currentSlide);
        }
      }, 8000);

      return () => clearInterval(interval);
    }
  }, [gameState?.phase]);

  // Results animation
  useEffect(() => {
    if (gameState?.phase === "results") {
      setResultsStep(0);

      const timers = [
        setTimeout(() => { setResultsStep(1); playSound("reveal", { volume: 0.5 }); }, 2500),
        setTimeout(() => { setResultsStep(2); playSound("number-drop", { volume: 0.5 }); }, 4500),
        setTimeout(() => { setResultsStep(3); playSound("calculate", { volume: 0.5 }); }, 6500),
        setTimeout(() => { setResultsStep(4); playSound("multiply", { volume: 0.5 }); }, 8000),
        setTimeout(() => {
          setResultsStep(5);
          playSound("win", { volume: 0.6 });
          setTimeout(() => playSound("point", { volume: 0.4 }), 500);
        }, 9500),
        setTimeout(() => { setResultsStep(6); }, 11500),
        setTimeout(() => {
          setResultsStep(7);
          if (gameState.eliminatedThisRound?.length > 0) {
            playSound("elimination", { volume: 0.8 });
          }
        }, 13500),
      ];

      return () => timers.forEach(clearTimeout);
    }
  }, [gameState?.phase, gameState?.round]);

  // ============================================
  // HELPERS
  // ============================================
  const showError = useCallback((msg) => {
    setError(msg);
    if (errorTimeout.current) clearTimeout(errorTimeout.current);
    errorTimeout.current = setTimeout(() => setError(null), 3000);
  }, []);

  const me = gameState?.players?.find(p => p.id === socket.id);

  // ============================================
  // HANDLERS
  // ============================================
  const handlePhotoSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showError("Foto muy grande (máx 5MB)");
      return;
    }

    // Comprimir imagen para móviles
    const reader = new FileReader();
    reader.onloadend = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const maxSize = 400;
        let w = img.width;
        let h = img.height;

        if (w > h) {
          if (w > maxSize) { h = h * maxSize / w; w = maxSize; }
        } else {
          if (h > maxSize) { w = w * maxSize / h; h = maxSize; }
        }

        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);

        const compressed = canvas.toDataURL("image/jpeg", 0.7);
        setPhotoPreview(compressed);
        setPhotoFile(compressed);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };

  const handleJoin = () => {
    if (!name.trim()) { showError("Escribe tu nombre"); return; }
    if (!photoFile) { showError("Sube una foto"); return; }
    socket.emit("joinGame", { name: name.trim(), photo: photoFile });
    setJoined(true);
    playSound("join", { volume: 0.5 });
  };

  const handleSubmit = () => {
    if (number === null) { showError("Selecciona un número"); return; }
    socket.emit("submitNumber", number);
    setSubmitted(true);
    playSound("confirm", { volume: 0.5 });
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter") handleJoin();
  };

  const handleNumberSelect = (n) => {
    setNumber(n);
    playSound("select", { volume: 0.2 });
  };

  // ============================================
  // MUTE BUTTON (shown on all screens)
  // ============================================
  const MuteButton = () => (
    <button
      className="mute-btn"
      onClick={toggleMute}
      title={muted ? "Activar sonido" : "Silenciar"}
    >
      {muted ? "🔇" : "🔊"}
    </button>
  );

  // ============================================
  // RENDER: Connection
  // ============================================
  if (!connected) {
    return (
      <div className="screen" style={{ background: "#000" }}>
        <div className="reconnecting-text">RECONECTANDO...</div>
      </div>
    );
  }

  if (!gameState) {
    return (
      <div className="screen" style={{ background: "#000" }}>
        <div className="connecting-text">CONECTANDO...</div>
      </div>
    );
  }

  // ============================================
  // RENDER: Registration
  // ============================================
  if (!joined) {
    return (
      <div className="screen register-screen">
        <MuteButton />
        {error && <div className="error-toast">{error}</div>}
        <h1>BORDERLAND</h1>
        <div className="subtitle">King of Diamonds</div>
        <div className="register-form">
          <label className="photo-upload">
            {photoPreview ? (
              <img src={photoPreview} alt="preview" />
            ) : (
              <span className="placeholder">📷</span>
            )}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handlePhotoSelect}
            />
          </label>
          <div className="photo-buttons">
            <label className="btn photo-btn">
              📷 CÁMARA
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handlePhotoSelect}
                style={{ display: "none" }}
              />
            </label>
            <label className="btn photo-btn">
              🖼️ GALERÍA
              <input
                type="file"
                accept="image/*"
                onChange={handlePhotoSelect}
                style={{ display: "none" }}
              />
            </label>
          </div>
          <input
            type="text" placeholder="TU NOMBRE" value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyPress={handleKeyPress} maxLength={15} autoFocus
          />
          <button className="btn" onClick={handleJoin} disabled={!name.trim() || !photoFile}>
            ENTRAR
          </button>
        </div>
      </div>
    );
  }

  // ============================================
  // RENDER: Lobby
  // ============================================
  if (gameState.phase === "lobby") {
    return (
      <div className="screen lobby-screen">
        <MuteButton />
        {error && <div className="error-toast">{error}</div>}
        <h1>SALA DE ESPERA</h1>
        <div className="player-count">
          {gameState.players.length} / {gameState.config?.MAX_PLAYERS || 9} JUGADORES
        </div>
        <div className="players-grid">
          {gameState.players.map((p, i) => (
            <div key={p.id} className="player-card" style={{ animationDelay: `${i * 0.1}s` }}>
              {photos[p.id] ? (
                <img src={photos[p.id]} alt={p.name} className={`avatar ${p.host ? "host" : ""}`} />
              ) : (
                <div className={`avatar ${p.host ? "host" : ""}`}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center",
                    backgroundColor: "#1a1a1a", fontSize: "1.5rem" }}>👤</div>
              )}
              <span className="player-name">{p.name}</span>
              {p.host && <span className="host-badge">♦ HOST</span>}
            </div>
          ))}
        </div>
        {me?.host ? (
          <button className="btn" onClick={() => socket.emit("startGame")}
            disabled={gameState.players.length < (gameState.config?.MIN_PLAYERS_TO_START || 2)}>
            INICIAR PARTIDA
          </button>
        ) : (
          <div className="waiting-text">Esperando al host...</div>
        )}
      </div>
    );
  }

  // ============================================
  // RENDER: Tutorial
  // ============================================
  if (gameState.phase === "tutorial") {
    const slide = TUTORIAL_SLIDES[tutorialSlide];

    return (
      <div className="screen tutorial-screen" style={{ background: slide.bg }}>
        <MuteButton />
        <div className="tutorial-progress">
          {TUTORIAL_SLIDES.map((_, i) => (
            <div key={i} className={`tutorial-dot ${i <= tutorialSlide ? "active" : ""}`} />
          ))}
        </div>

        <div className="tutorial-content" key={tutorialSlide}>
          <div className="tutorial-icon">{slide.icon}</div>
          <h1 className="tutorial-title">{slide.title}</h1>
          <div className="tutorial-lines">
            {slide.lines.map((line, i) => (
              <p key={i} className="tutorial-line" style={{ animationDelay: `${i * 0.4}s` }}>
                {line}
              </p>
            ))}
          </div>
        </div>

        {tutorialDone && me?.host && (
          <button className="btn tutorial-start-btn" onClick={() => {
            stopSound("intro-music");
            socket.emit("tutorialFinished");
          }}>
            ♦ COMENZAR ♦
          </button>
        )}

        {tutorialDone && !me?.host && (
          <div className="waiting-text">El host iniciará el juego...</div>
        )}

        <div className="tutorial-slide-counter">
          {tutorialSlide + 1} / {TUTORIAL_SLIDES.length}
        </div>
      </div>
    );
  }

  // ============================================
  // RENDER: Countdown
  // ============================================
  if (gameState.phase === "countdown") {
    return (
      <div className="screen countdown-screen">
        <MuteButton />
        <div className="round-indicator">RONDA {gameState.round}</div>
        <div className="countdown-number">{gameState.timer}</div>

        {gameState.activeRules?.length > 0 && (
          <div className="active-rules-bar">
            {gameState.activeRules.map((rule, i) => (
              <span key={i} className="active-rule-chip" title={rule.description}>
                {rule.icon}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ============================================
  // RENDER: Round
  // ============================================
  if (gameState.phase === "round") {
    const allNumbers = Array.from({ length: 101 }, (_, i) => i);
    const isBlind = gameState.activeRules?.some(r => r.id === "blind_number");
    const isReducedRange = gameState.activeRules?.some(r => r.id === "reduced_range");
    const isNoRepeat = gameState.activeRules?.some(r => r.id === "no_repeat");
    const myPreviousNumber = gameState.previousNumbers?.[socket.id];

    return (
      <div className="screen round-screen">
        <MuteButton />
        {error && <div className="error-toast">{error}</div>}

        <div className="round-header">
          <div className="round-indicator">RONDA {gameState.round}</div>
          <div className={`round-timer ${gameState.timer <= 10 ? "urgent" : ""}`}>
            {gameState.timer}
          </div>
          {!isBlind && submitProgress && (
            <div className="submit-progress">
              {submitProgress.submitted}/{submitProgress.total} ENVIADOS
            </div>
          )}
        </div>

        {gameState.activeRules?.length > 0 && (
          <div className="active-rules-reminder">
            {gameState.activeRules.map((rule, i) => (
              <span key={i} className="rule-reminder-chip" title={rule.description}>
                {rule.icon} {rule.name}
              </span>
            ))}
          </div>
        )}

        {isReducedRange && !submitted && (
          <div className="rule-warning">⚠ Solo números del 1 al 50</div>
        )}
        {isNoRepeat && myPreviousNumber !== undefined && !submitted && (
          <div className="rule-warning">🚫 No puedes repetir el {myPreviousNumber}</div>
        )}

        {!submitted ? (
          <>
            <div className="selected-display">
              {number !== null ? `SELECCIONADO: ${number}` : "ELIGE UN NÚMERO"}
            </div>
            <div className="number-grid">
              {allNumbers.map(n => {
                const isOutOfRange = isReducedRange && (n < 1 || n > 50);
                const isRepeated = isNoRepeat && n === myPreviousNumber;

                return (
                  <div
                    key={n}
                    className={`number-cell ${number === n ? "selected" : ""} ${isOutOfRange ? "out-of-range" : ""} ${isRepeated ? "repeated" : ""}`}
                    onClick={() => handleNumberSelect(n)}
                  >
                    {n}
                  </div>
                );
              })}
            </div>
            <button className="btn" onClick={handleSubmit} disabled={number === null}>
              CONFIRMAR {number !== null ? `[${number}]` : ""}
            </button>
          </>
        ) : (
          <div className="submitted-message">
            <div className="check">✓</div>
            <p>Número enviado</p>
            <p style={{ color: "#333", fontSize: "0.75rem" }}>Esperando a los demás...</p>
          </div>
        )}
      </div>
    );
  }

  // ============================================
  // RENDER: Results
  // ============================================
  if (gameState.phase === "results") {
    const isElimination = gameState.eliminatedThisRound?.length > 0;

    const roundPlayers = gameState.players.filter(p =>
      p.alive || gameState.eliminatedThisRound?.includes(p.id)
    );

    return (
      <div className={`results-screen ${resultsStep >= 5 ? "flash" : ""}`}>
        <MuteButton />
        <div className="results-round-label">
          RONDA {gameState.round} — RESULTADOS
        </div>

        {resultsStep >= 3 && (
          <div className="results-line" style={{ maxWidth: "600px", marginBottom: "50px" }} />
        )}

        <div className="results-players">
          {roundPlayers.map((p, index) => {
            const isWinner = p.id === gameState.winnerId;
            const isLoser = !isWinner;
            const isElim = gameState.eliminatedThisRound?.includes(p.id);
            const isFurthest = p.id === gameState.furthestPlayerId;
            const revealDelay = index * 0.2;
            const numberDelay = index * 0.15;

            return (
              <div
                key={p.id}
                className={`result-player ${
                  isWinner && resultsStep >= 5 ? "winner" : ""
                } ${isWinner && resultsStep >= 6 ? "winner-loop" : ""} ${
                  isLoser && resultsStep >= 5 ? "loser" : ""
                } ${isElim && resultsStep >= 7 ? "eliminated" : ""}`}
              >
                {isWinner && resultsStep >= 5 && (
                  <div className="win-label">★ WIN ★</div>
                )}

                {resultsStep >= 2 && (
                  <div className="result-number" style={{ "--number-delay": `${numberDelay}s` }}>
                    {gameState.numbers[p.id] ?? "—"}
                  </div>
                )}

                <div className="photo-container" style={{ "--reveal-delay": `${revealDelay}s` }}>
                  {photos[p.id] ? (
                    <img src={photos[p.id]} alt={p.name} className="result-photo" />
                  ) : (
                    <div className="result-photo" style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      backgroundColor: "#1a2a33", fontSize: "2rem"
                    }}>👤</div>
                  )}
                </div>

                {resultsStep >= 1 && resultsStep < 2 && (
                  <div className="result-name" style={{ "--reveal-delay": `${revealDelay}s` }}>
                    {p.name}
                  </div>
                )}

                {resultsStep >= 6 && (
                  <div className="result-lives">
                    <span className="lives-number">{p.lives}</span>
                    {isLoser && (
                      <span className="plus-one">
                        +{isFurthest && gameState.activeRules?.some(r => r.id === "double_punishment") ? "2" : "1"}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {resultsStep >= 3 && (
          <div className="results-calculation">
            <div className="calc-box">{gameState.average?.toFixed(2)}</div>
            {resultsStep >= 4 && (
              <div className="calc-multiplier">
                × {gameState.activeRules?.some(r => r.id === "sudden_death") ? "0.5" : "0.8"}
              </div>
            )}
            {resultsStep >= 4 && <div className="calc-equals">=</div>}
            {resultsStep >= 5 && (
              <div className="calc-box">{gameState.target?.toFixed(2)}</div>
            )}
          </div>
        )}

        {resultsStep >= 7 && isElimination && (
          <div className="elimination-banner pulse">
            ☠ {gameState.eliminatedThisRound.map(id => {
              const p = gameState.players.find(pl => pl.id === id);
              return p?.name?.toUpperCase();
            }).filter(Boolean).join(" · ")} — ELIMINAD{gameState.eliminatedThisRound.length > 1 ? "OS" : "O"} ☠
          </div>
        )}
      </div>
    );
  }

  // ============================================
  // RENDER: New Rule
  // ============================================
  if (gameState.phase === "new-rule") {
    const rule = gameState.activeRules?.[gameState.activeRules.length - 1];
    if (!rule) return null;

    return (
      <div className="screen new-rule-screen">
        <MuteButton />
        <div className="new-rule-header">NUEVA REGLA</div>

        <div className="new-rule-card">
          <div className="new-rule-icon">{rule.icon}</div>
          <h1 className="new-rule-name">{rule.name}</h1>
          <div className="new-rule-divider" />
          <p className="new-rule-description">{rule.description}</p>
        </div>

        <div className="active-rules-count">
          Reglas activas: {gameState.activeRules.length}
        </div>

        {gameState.activeRules.length > 1 && (
          <div className="all-active-rules">
            {gameState.activeRules.slice(0, -1).map((r, i) => (
              <span key={i} className="mini-rule-chip">{r.icon} {r.name}</span>
            ))}
          </div>
        )}

        {me?.host && (
          <button className="btn" onClick={() => socket.emit("nextRule")} style={{ marginTop: "30px" }}>
            CONTINUAR
          </button>
        )}

        {!me?.host && (
          <div className="waiting-text">El host continuará...</div>
        )}
      </div>
    );
  }

  // ============================================
  // RENDER: Finished
  // ============================================
  if (gameState.phase === "finished") {
    const winner = gameState.players.find(p => p.alive);
    const eliminated = gameState.players
      .filter(p => !p.alive)
      .sort((a, b) => a.lives - b.lives);

    return (
      <div className="screen finished-screen">
        <MuteButton />
        <h1>SUPERVIVIENTE</h1>
        {winner && (
          <div className="winner-display">
            {photos[winner.id] ? (
              <img src={photos[winner.id]} alt={winner.name} />
            ) : (
              <div style={{
                width: 150, height: 200, backgroundColor: "#1a1a1a",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "3rem", border: "3px solid #8B0000"
              }}>👑</div>
            )}
            <h2>{winner.name}</h2>
          </div>
        )}
        {eliminated.length > 0 && (
          <div className="final-standings">
            <h3>Eliminados</h3>
            {eliminated.map((p, i) => (
              <div key={p.id} className="standing-row">
                <span style={{ color: "#555" }}>#{i + 2}</span>
                {photos[p.id] ? (
                  <img src={photos[p.id]} alt={p.name} />
                ) : <span>👤</span>}
                <span>{p.name}</span>
                <span style={{ color: "#8B0000" }}>✖ {p.lives}</span>
              </div>
            ))}
          </div>
        )}
        {me?.host && (
          <button className="btn btn-danger" onClick={() => socket.emit("resetGame")}
            style={{ marginTop: "40px" }}>NUEVA PARTIDA</button>
        )}
      </div>
    );
  }

  return null;
}

export default App;
