/* =====================================================
   ZeroZero Quiz — app.js VERSÃO CORRIGIDA
   Bugs corrigidos:
   1. Saques agora sincronizam em tempo real (onValue listener)
   2. Status "pago/rejeitado" aparece imediatamente no app
   3. Perguntas lidas correctamente do Firebase (campo resposta)
   4. Energia persiste correctamente entre sessões
   5. Splash desaparece mesmo se Firebase demorar
   6. Histórico sempre busca dados frescos do Firebase
   ===================================================== */

// ===== CONSTANTES =====
const PONTOS_POR_ACERTO  = 10;
const ENERGIA_MAX        = 5;
const PERGUNTAS_POR_JOGO = 5;
const TEMPO_POR_PERGUNTA = 10;
const PONTOS_PARA_KZ     = 500;
const KZ_POR_LOTE        = 50;
const LIMITE_SAQUE_DIA   = 100;
const SAQUE_MIN_KZ       = 50;
const AD_ENERGIA         = 1;
const AD_PONTOS          = 20;
const RECHARGE_MS        = 60 * 60 * 1000; // 1 hora por energia

// ===== ESTADO GLOBAL =====
let currentScreen   = 'splash';
let currentUser     = null;
let currentUserId   = null;
let quizState       = null;
let timerInterval   = null;
let adCallback      = null;
let adTimerInt      = null;
let todasPerguntas  = [];
let saquesListener  = null; // ← listener realtime de saques (FIX PRINCIPAL)
let userListener    = null; // ← listener realtime do perfil

// ===== EFEITOS SONOROS =====
class EfeitosSonoros {
  constructor() { this.audioCtx = null; }
  init() {
    try {
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    } catch(e) {}
  }
  _play(freq1, freq2, dur) {
    try {
      this.init();
      const now  = this.audioCtx.currentTime;
      const osc  = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.connect(gain); gain.connect(this.audioCtx.destination);
      osc.frequency.setValueAtTime(freq1, now);
      if (freq2) osc.frequency.exponentialRampToValueAtTime(freq2, now + dur * 0.6);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + dur);
      osc.start(); osc.stop(now + dur);
    } catch(e) {}
  }
  acerto()  { this._play(523.25, 1046.50, 0.3); }
  erro()    { this._play(392.00, 220.00,  0.4); }
  timeout() { this._play(220.00, 180.00,  0.5); }
}
const efeitos = new EfeitosSonoros();
document.addEventListener('click', () => efeitos.init(), { once: true });

// ===== MISSOES =====
const MISSOES_BASE = [
  { id:'m1', icone:'🎯', titulo:'Joga 3 vezes',           tipo:'jogos',    meta:3,  recompensa:30 },
  { id:'m2', icone:'✅', titulo:'Acerta 10 perguntas',     tipo:'acertos',  meta:10, recompensa:50 },
  { id:'m3', icone:'📺', titulo:'Assiste 2 anúncios',      tipo:'anuncios', meta:2,  recompensa:20 },
  { id:'m4', icone:'🏆', titulo:'Faz 50 pontos num jogo',  tipo:'maxpts',   meta:50, recompensa:40 },
];

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  // Splash de segurança — desaparece em 4s mesmo se Firebase demorar
  setTimeout(() => {
    if (currentScreen === 'splash') showScreen('login');
  }, 4000);

  aguardarFirebase();
});

function aguardarFirebase() {
  if (!window.onAuthStateChanged || !window.db) {
    setTimeout(aguardarFirebase, 200);
    return;
  }
  window.onAuthStateChanged(window.auth, async (user) => {
    if (user) {
      currentUserId = user.uid;
      await carregarDadosUsuario(user.uid);
      await carregarPerguntas();
      iniciarListeners(user.uid); // ← iniciar listeners realtime
      setInterval(() => { if (currentUser) checkEnergyRecharge(); }, 60000);
      showScreen('home');
    } else {
      pararListeners();
      showScreen('login');
    }
  });
}

// ══════════════════════════════════════════
//  LISTENERS REALTIME — FIX PRINCIPAL DOS SAQUES
// ══════════════════════════════════════════

function iniciarListeners(uid) {
  pararListeners(); // limpar anteriores se existirem

  // ── Listener 1: Perfil do utilizador (pontos, energia, etc.)
  const userRef = window.firebase.ref(window.db, `users/${uid}`);
  userListener = window.firebase.onValue(userRef, (snap) => {
    if (!snap.exists()) return;
    const dados = snap.val();
    const energiaAnterior = currentUser?.energia;
    currentUser = { id: uid, ...dados };

    // Notificar se ganhou energia
    if (energiaAnterior !== undefined && dados.energia > energiaAnterior) {
      showToast('⚡ Energia recuperada!', 'success');
    }
    // Re-renderizar ecrã actual se necessário
    if (currentScreen === 'home')    renderHome(false); // false = não re-buscar do Firebase
    if (currentScreen === 'wallet')  renderWalletDados();
  });

  // ── Listener 2: Saques do utilizador — actualiza em tempo real
  const saquesRef = window.firebase.ref(window.db, `saques`);
  const saquesQuery = window.firebase.query(
    saquesRef,
    window.firebase.orderByChild('userId'),
    window.firebase.equalTo(uid)
  );

  saquesListener = window.firebase.onValue(saquesQuery, (snap) => {
    const saques = [];
    snap.forEach((child) => {
      saques.push({ _id: child.key, ...child.val() });
    });
    // Ordenar por timestamp decrescente
    saques.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

    // Detectar mudanças de status e notificar utilizador
    const anterior = currentUser?._saques || [];
    saques.forEach(s => {
      const ant = anterior.find(a => a._id === s._id);
      if (ant && ant.status !== s.status) {
        if (s.status === 'pago')       showToast(`✅ Saque de ${s.valor} Kz foi pago!`, 'success');
        if (s.status === 'rejeitado')  showToast(`❌ Saque de ${s.valor} Kz foi rejeitado.`, 'error');
      }
    });

    // Guardar no objecto local para re-render
    if (currentUser) {
      currentUser._saques = saques;
    }

    // Actualizar ecrã da carteira se estiver aberto
    if (currentScreen === 'wallet') renderHistoricoSaques(saques);
  });
}

function pararListeners() {
  // Firebase Realtime Database: o retorno de onValue é a função unsubscribe
  if (saquesListener) { saquesListener(); saquesListener = null; }
  if (userListener)   { userListener();   userListener   = null; }
}

// ══════════════════════════════════════════
//  DADOS
// ══════════════════════════════════════════

async function carregarDadosUsuario(uid) {
  const userRef  = window.firebase.ref(window.db, `users/${uid}`);
  const snapshot = await window.firebase.get(userRef);
  if (snapshot.exists()) {
    currentUser = { id: uid, ...snapshot.val() };
  } else {
    // Novo utilizador sem dados — criar estrutura base
    currentUser = {
      nome: 'Jogador', email: '', pontos: 0, saldo: 0, nivel: 1, xp: 0,
      jogos: 0, acertos: 0, energia: ENERGIA_MAX, energia_ts: Date.now(),
      criado: new Date().toISOString(),
      hoje: { jogos:0, acertos:0, anuncios:0, maxpts:0, data: todayStr() },
    };
    await salvarUsuario();
  }
  await checkEnergyRecharge();
}

async function carregarPerguntas() {
  try {
    const perguntasRef = window.firebase.ref(window.db, 'perguntas');
    const snapshot     = await window.firebase.get(perguntasRef);
    if (snapshot.exists()) {
      const data = snapshot.val();
      todasPerguntas = Object.values(data).map(p => ({
        ...p,
        // FIX: garantir que respostaIndex existe (campo pode chamar-se 'resposta' ou 'respostaIndex')
        respostaIndex: p.respostaIndex !== undefined ? p.respostaIndex : (p.resposta !== undefined ? p.resposta : 0),
        // FIX: garantir que texto existe (pode chamar-se 'texto' ou 'pergunta')
        texto: p.texto || p.pergunta || '',
        categoria: p.categoria || 'Geral',
      }));
    }
  } catch(e) {
    console.error('Erro ao carregar perguntas:', e);
  }
}

// ══════════════════════════════════════════
//  NAVEGAÇÃO
// ══════════════════════════════════════════

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.style.display = 'none';
  });
  const target = document.getElementById('screen-' + name);
  if (!target) return;
  target.style.display = 'block';
  requestAnimationFrame(() => target.classList.add('active'));
  currentScreen = name;
  if (name === 'home')      renderHome(true);
  if (name === 'missions')  renderMissions();
  if (name === 'ranking')   renderRanking();
  if (name === 'wallet')    renderWallet();
}

// ══════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════

async function doRegister() {
  const nome  = document.getElementById('reg-nome').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const senha = document.getElementById('reg-pass').value;
  const errEl = document.getElementById('reg-error');
  errEl.textContent = '';
  if (!nome || !email || !senha) { errEl.textContent = 'Preenche todos os campos.'; return; }
  if (senha.length < 6)          { errEl.textContent = 'Senha deve ter pelo menos 6 caracteres.'; return; }

  const btn = document.querySelector('#screen-register .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'A criar conta...'; }

  try {
    const cred = await window.createUserWithEmailAndPassword(window.auth, email, senha);
    const uid  = cred.user.uid;
    const userData = {
      nome, email, pontos: 0, saldo: 0, nivel: 1, xp: 0,
      jogos: 0, acertos: 0, energia: ENERGIA_MAX, energia_ts: Date.now(),
      criado: new Date().toISOString(),
      hoje: { jogos:0, acertos:0, anuncios:0, maxpts:0, data: todayStr() },
    };
    await window.firebase.set(window.firebase.ref(window.db, `users/${uid}`), userData);
    showToast('Conta criada! 🎉', 'success');
    showScreen('login');
  } catch (e) {
    if (e.code === 'auth/email-already-in-use') errEl.textContent = 'Este email já está registado.';
    else errEl.textContent = 'Erro: ' + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Criar Conta'; }
  }
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const senha = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  if (!email || !senha) { errEl.textContent = 'Preenche todos os campos.'; return; }

  const btn = document.querySelector('#screen-login .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'A entrar...'; }

  try {
    const cred = await window.signInWithEmailAndPassword(window.auth, email, senha);
    currentUserId = cred.user.uid;
    await carregarDadosUsuario(currentUserId);
    await carregarPerguntas();
    iniciarListeners(currentUserId);
    showScreen('home');
    showToast('Bem-vindo, ' + currentUser.nome + '! 🎉', 'gold');
  } catch (e) {
    errEl.textContent = 'Email ou senha incorretos.';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
  }
}

function doLogout() {
  pararListeners();
  window.auth.signOut();
  currentUser   = null;
  currentUserId = null;
  quizState     = null;
  showScreen('login');
}

// ══════════════════════════════════════════
//  HOME
// ══════════════════════════════════════════

async function renderHome(buscarFirebase = true) {
  if (!currentUser || !currentUserId) return;
  // Só re-busca do Firebase quando explicitamente pedido (evita loops com o listener)
  if (buscarFirebase) {
    const userRef  = window.firebase.ref(window.db, `users/${currentUserId}`);
    const snapshot = await window.firebase.get(userRef);
    if (snapshot.exists()) currentUser = { id: currentUserId, ...snapshot.val() };
  }
  checkEnergyRecharge();
  resetDailyIfNeeded();

  const nome = currentUser.nome || 'Jogador';
  document.getElementById('home-name').textContent   = nome;
  document.getElementById('home-avatar').textContent = nome[0].toUpperCase();
  document.getElementById('home-level').textContent  = 'Nível ' + (currentUser.nivel || 1);
  document.getElementById('home-pontos').textContent = currentUser.pontos || 0;

  const saldoEmKz = calcularKz(currentUser.pontos || 0);
  document.getElementById('home-saldo').textContent   = saldoEmKz;
  document.getElementById('home-energia').textContent = currentUser.energia !== undefined ? currentUser.energia : ENERGIA_MAX;

  const hoje  = currentUser.hoje || { jogos: 0 };
  const jogos = hoje.jogos || 0;
  document.getElementById('prog-jogos').textContent          = jogos + ' / 5';
  document.getElementById('prog-jogos-bar').style.width      = Math.min(jogos / 5 * 100, 100) + '%';
  document.getElementById('home-missions-badge').textContent = pendingMissions() + ' disponíveis';
}

function calcularKz(pontos) {
  return Math.floor((pontos / PONTOS_PARA_KZ) * KZ_POR_LOTE);
}

function pendingMissions() {
  if (!currentUser) return 0;
  const hoje = currentUser.hoje || {};
  return MISSOES_BASE.filter(m => (hoje[m.tipo] || 0) < m.meta).length;
}

// ══════════════════════════════════════════
//  QUIZ
// ══════════════════════════════════════════

async function startQuiz() {
  if (!currentUser) return;
  const energia = currentUser.energia !== undefined ? currentUser.energia : ENERGIA_MAX;
  if (energia <= 0) { showToast('Sem energia! Assiste um anúncio. ⚡', 'error'); return; }
  if (todasPerguntas.length === 0) {
    showToast('A carregar perguntas...', 'error');
    await carregarPerguntas();
    if (todasPerguntas.length === 0) { showToast('Sem perguntas disponíveis. Aguarda.', 'error'); return; }
  }
  currentUser.energia = energia - 1;
  await salvarUsuario();
  const shuffled = [...todasPerguntas].sort(() => Math.random() - 0.5);
  quizState = { perguntas: shuffled.slice(0, PERGUNTAS_POR_JOGO), atual:0, acertos:0, pontos:0, respondido:false };
  showScreen('quiz');
  renderQuestion();
}

function renderQuestion() {
  if (!quizState) return;
  clearInterval(timerInterval);
  const q = quizState.perguntas[quizState.atual];
  document.getElementById('quiz-num').textContent        = (quizState.atual + 1) + '/' + PERGUNTAS_POR_JOGO;
  document.getElementById('quiz-score-live').textContent = quizState.pontos + ' pts';
  document.getElementById('q-category').textContent      = q.categoria || 'Geral';
  document.getElementById('q-text').textContent          = q.texto || q.pergunta || '';
  quizState.respondido = false;

  const cont   = document.getElementById('options-container');
  cont.innerHTML = '';
  const letras = ['A','B','C','D'];
  (q.opcoes || []).forEach((op, i) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.innerHTML = `<span class="opt-letter">${letras[i]}</span><span>${op}</span>`;
    btn.onclick   = () => answerQuestion(i, btn);
    cont.appendChild(btn);
  });

  let tempo = TEMPO_POR_PERGUNTA;
  updateTimerDisplay(tempo);
  timerInterval = setInterval(() => {
    tempo--;
    updateTimerDisplay(tempo);
    if (tempo <= 0) { clearInterval(timerInterval); if (!quizState.respondido) timeoutQuestion(); }
  }, 1000);
}

function updateTimerDisplay(t) {
  const circle = document.getElementById('timer-circle');
  const text   = document.getElementById('timer-num');
  if (!circle || !text) return;
  const offset = 283 * (1 - t / TEMPO_POR_PERGUNTA);
  circle.style.strokeDashoffset = offset;
  circle.style.stroke = t > 4 ? '#f5c842' : '#e74c3c';
  text.textContent    = t;
  text.style.color    = t > 4 ? '#eef0f7'  : '#e74c3c';
}

function answerQuestion(idx, btn) {
  if (quizState.respondido) return;
  clearInterval(timerInterval);
  quizState.respondido = true;
  const q       = quizState.perguntas[quizState.atual];
  const correct = q.respostaIndex === idx;
  correct ? efeitos.acerto() : efeitos.erro();
  const btns = document.querySelectorAll('.option-btn');
  btns.forEach(b => b.disabled = true);
  // Mostrar sempre a resposta correcta
  if (btns[q.respostaIndex]) btns[q.respostaIndex].classList.add('correct');
  if (correct) {
    btn.classList.add('correct');
    quizState.acertos++;
    quizState.pontos += PONTOS_POR_ACERTO;
    document.getElementById('quiz-score-live').textContent = quizState.pontos + ' pts';
    showToast('+' + PONTOS_POR_ACERTO + ' pontos! ✅', 'success');
  } else {
    btn.classList.add('wrong');
    showToast('Errado! Resposta: ' + (q.opcoes[q.respostaIndex] || '?'), 'error');
  }
  setTimeout(() => nextQuestion(), 1500);
}

function timeoutQuestion() {
  quizState.respondido = true;
  efeitos.timeout();
  const q    = quizState.perguntas[quizState.atual];
  const btns = document.querySelectorAll('.option-btn');
  btns.forEach(b => b.disabled = true);
  if (btns[q.respostaIndex]) btns[q.respostaIndex].classList.add('correct');
  showToast('Tempo esgotado! Resposta: ' + (q.opcoes[q.respostaIndex] || '?'), 'error');
  setTimeout(() => nextQuestion(), 1500);
}

function nextQuestion() {
  quizState.atual++;
  if (quizState.atual >= PERGUNTAS_POR_JOGO) endQuiz();
  else renderQuestion();
}

async function endQuiz() {
  clearInterval(timerInterval);
  const { acertos, pontos } = quizState;
  const kzGanho = calcularKz(pontos);

  // Actualizar dados do utilizador
  currentUser.pontos  = (currentUser.pontos  || 0) + pontos;
  currentUser.jogos   = (currentUser.jogos   || 0) + 1;
  currentUser.acertos = (currentUser.acertos || 0) + acertos;
  currentUser.xp      = (currentUser.xp      || 0) + pontos;
  currentUser.nivel   = Math.max(1, Math.floor(currentUser.xp / 200) + 1);

  resetDailyIfNeeded();
  currentUser.hoje.jogos++;
  currentUser.hoje.acertos += acertos;
  if (pontos > (currentUser.hoje.maxpts || 0)) currentUser.hoje.maxpts = pontos;

  await salvarUsuario();

  // Verificar missões
  verificarMissoesAuto();

  // Ecrã de resultado
  const pct = acertos / PERGUNTAS_POR_JOGO;
  document.getElementById('result-emoji').textContent = pct >= 0.8 ? '🎉' : pct >= 0.4 ? '👍' : '💪';
  document.getElementById('result-title').textContent = pct >= 0.8 ? 'Excelente!' : pct >= 0.4 ? 'Bom jogo!' : 'Continua a treinar!';
  document.getElementById('result-sub').textContent   = acertos + ' de ' + PERGUNTAS_POR_JOGO + ' certas';
  document.getElementById('res-acertos').textContent  = acertos;
  document.getElementById('res-pts').textContent      = '+' + pontos;
  document.getElementById('res-kz').textContent       = '+' + kzGanho;
  showScreen('result');
}

function exitQuiz() {
  clearInterval(timerInterval);
  quizState = null;
  showScreen('home');
}

// ══════════════════════════════════════════
//  MISSÕES
// ══════════════════════════════════════════

function renderMissions() {
  resetDailyIfNeeded();
  const hoje = currentUser.hoje || {};
  const list = document.getElementById('missions-list');
  list.innerHTML = '';
  MISSOES_BASE.forEach(m => {
    const prog = hoje[m.tipo] || 0;
    const done = prog >= m.meta;
    const pct  = Math.min(prog / m.meta * 100, 100);
    const mKey = m.id + '_' + todayStr();
    const jaResgatou = currentUser.missoes && currentUser.missoes[mKey];
    const div  = document.createElement('div');
    div.className = 'mission-item' + (done ? ' done' : '');
    div.innerHTML = `
      <span class="m-icon">${m.icone}</span>
      <div class="m-info">
        <div class="m-title">${m.titulo}</div>
        <div class="m-progress">${prog} / ${m.meta}</div>
        <div class="m-reward">+${m.recompensa} pts</div>
        <div class="progress-bar-wrap" style="margin-top:6px">
          <div class="progress-bar-fill" style="width:${pct}%"></div>
        </div>
      </div>
      <button class="m-btn" ${(jaResgatou || !done) ? 'disabled' : ''}
        onclick="claimMission('${m.id}',${m.recompensa},'${m.tipo}',${m.meta})">
        ${jaResgatou ? '✓ Feito' : done ? 'Resgatar' : 'Em curso'}
      </button>`;
    list.appendChild(div);
  });
  updateMissionsReset();
}

function claimMission(id, pts, tipo, meta) {
  resetDailyIfNeeded();
  const hoje = currentUser.hoje || {};
  if ((hoje[tipo] || 0) < meta) { showToast('Missão ainda não completa! ⏳', 'error'); return; }
  if (!currentUser.missoes) currentUser.missoes = {};
  const mKey = id + '_' + todayStr();
  if (currentUser.missoes[mKey]) { showToast('Já resgataste esta missão hoje!', 'error'); return; }
  currentUser.missoes[mKey] = true;
  currentUser.pontos = (currentUser.pontos || 0) + pts;
  salvarUsuario();
  showToast('+' + pts + ' pontos! 🎉', 'gold');
  renderMissions();
}

// Verificação automática após jogo
function verificarMissoesAuto() {
  resetDailyIfNeeded();
  const hoje = currentUser.hoje || {};
  MISSOES_BASE.forEach(m => {
    const prog = hoje[m.tipo] || 0;
    const mKey = m.id + '_' + todayStr();
    const jaResgatou = currentUser.missoes?.[mKey];
    if (prog >= m.meta && !jaResgatou) {
      showToast(`🎯 Missão desbloqueada: ${m.titulo}! Vai às missões resgatar.`, 'gold');
    }
  });
}

function updateMissionsReset() {
  const now = new Date(), midnight = new Date();
  midnight.setHours(24,0,0,0);
  const diff = midnight - now;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const el = document.getElementById('missions-reset');
  if (el) el.textContent = `Reset: ${h}h ${m}m`;
}

// ══════════════════════════════════════════
//  ANÚNCIOS
// ══════════════════════════════════════════

function watchAd(type) {
  adCallback = type;
  document.getElementById('ad-modal').style.display = 'flex';
  let sec = 5;
  const timerEl   = document.getElementById('ad-timer');
  const closeBtn  = document.getElementById('ad-close-btn');
  const countdown = document.getElementById('ad-countdown');
  closeBtn.disabled = true;
  timerEl.textContent = sec;
  if (countdown) countdown.innerHTML = `Aguarda <span id="ad-timer">${sec}</span>s`;
  clearInterval(adTimerInt);
  adTimerInt = setInterval(() => {
    sec--;
    const el = document.getElementById('ad-timer');
    if (el) el.textContent = sec;
    if (sec <= 0) {
      clearInterval(adTimerInt);
      closeBtn.disabled = false;
      if (countdown) countdown.innerHTML = '✅ Podes fechar';
    }
  }, 1000);
}

function closeAd() {
  clearInterval(adTimerInt);
  document.getElementById('ad-modal').style.display = 'none';
  const energia = currentUser.energia || 0;
  if (adCallback === 'energia' || adCallback === 'bonus') {
    if (energia < ENERGIA_MAX) {
      currentUser.energia = Math.min(energia + AD_ENERGIA, ENERGIA_MAX);
      showToast('+' + AD_ENERGIA + ' energia! ⚡', 'success');
    } else {
      currentUser.pontos = (currentUser.pontos || 0) + AD_PONTOS;
      showToast('Energia cheia! +' + AD_PONTOS + ' pontos 🎁', 'gold');
    }
    resetDailyIfNeeded();
    currentUser.hoje.anuncios = (currentUser.hoje.anuncios || 0) + 1;
    salvarUsuario();
    if (currentScreen === 'home') renderHome(false);
  }
  adCallback = null;
}

// ══════════════════════════════════════════
//  RANKING
// ══════════════════════════════════════════

async function renderRanking() {
  const top3El = document.getElementById('ranking-top3');
  const listEl = document.getElementById('ranking-list');
  if (top3El) top3El.innerHTML = '<div style="text-align:center;padding:20px;color:#8a90a8">A carregar...</div>';
  if (listEl) listEl.innerHTML = '';
  try {
    const usersRef = window.firebase.ref(window.db, 'users');
    const snapshot = await window.firebase.get(usersRef);
    const users = [];
    snapshot.forEach(child => users.push({ id: child.key, ...child.val() }));
    const sorted = users.sort((a, b) => (b.pontos || 0) - (a.pontos || 0));
    if (top3El) top3El.innerHTML = '';
    const classes = ['second','first','third'], medals = ['🥈','🥇','🥉'], order = [1,0,2];
    const top3 = sorted.slice(0, 3);
    order.forEach((pos, vi) => {
      const u = top3[pos]; if (!u) return;
      const card = document.createElement('div');
      card.className = 'top3-card ' + classes[vi];
      card.innerHTML = `
        <div class="t3-medal">${medals[vi]}</div>
        <div class="t3-avatar">${(u.nome||'U')[0].toUpperCase()}</div>
        <div class="t3-name">${(u.nome||'Usuário').split(' ')[0]}</div>
        <div class="t3-pts">${(u.pontos||0).toLocaleString()} pts</div>`;
      if (top3El) top3El.appendChild(card);
    });
    sorted.slice(3, 30).forEach((u, i) => {
      const isMe = u.id === currentUserId;
      const item = document.createElement('div');
      item.className = 'rank-item' + (isMe ? ' me' : '');
      item.innerHTML = `
        <span class="rank-pos">${i + 4}</span>
        <div class="rank-avatar">${(u.nome||'U')[0].toUpperCase()}</div>
        <span class="rank-name">${u.nome||'Usuário'}${isMe ? ' (Tu)' : ''}</span>
        <span class="rank-pts">${(u.pontos||0).toLocaleString()}</span>`;
      if (listEl) listEl.appendChild(item);
    });
    if (sorted.length === 0 && listEl)
      listEl.innerHTML = '<p style="text-align:center;color:#8a90a8;padding:24px">Ainda não há jogadores.</p>';
  } catch(e) {
    if (listEl) listEl.innerHTML = '<p style="text-align:center;color:#e74c3c;padding:24px">Erro ao carregar ranking.</p>';
  }
}

// ══════════════════════════════════════════
//  CARTEIRA — SAQUES (FIX COMPLETO)
// ══════════════════════════════════════════

function renderWallet() {
  renderWalletDados();
  // O histórico é gerido pelo listener onValue — mas buscar na primeira vez
  const saques = currentUser?._saques || [];
  renderHistoricoSaques(saques);
}

function renderWalletDados() {
  if (!currentUser) return;
  document.getElementById('wallet-pontos').textContent = (currentUser.pontos || 0).toLocaleString();
  const kz = calcularKz(currentUser.pontos || 0);
  document.getElementById('wallet-kz').textContent = kz + ' Kz';
}

// Renderizar histórico de saques — chamado pelo listener realtime
function renderHistoricoSaques(saques) {
  const histEl = document.getElementById('wallet-history');
  if (!histEl) return;
  if (!saques || saques.length === 0) {
    histEl.innerHTML = '<p style="text-align:center;color:#8a90a8;padding:16px">Nenhum saque ainda.</p>';
    return;
  }
  histEl.innerHTML = saques.map(s => {
    let statusClass = '', statusText = '';
    if (s.status === 'pendente')   { statusClass = 'pendente'; statusText = '⏳ Pendente'; }
    else if (s.status === 'pago')  { statusClass = 'pago';     statusText = '✅ Pago'; }
    else                           { statusClass = 'rejeitado';statusText = '❌ Rejeitado'; }
    const data = s.data || (s.timestamp ? s.timestamp.split('T')[0] : '—');
    return `
      <div class="history-item">
        <div class="hi-left">
          <span class="hi-method">${s.metodo || 'Unitel Money'}</span>
          <span class="hi-date">${s.telefone || ''} · ${data}</span>
        </div>
        <div class="hi-right">
          <span class="hi-val">${s.valor || 0} Kz</span>
          <span class="hi-status ${statusClass}">${statusText}</span>
        </div>
      </div>`;
  }).join('');
}

async function requestWithdraw() {
  if (!currentUser) return;
  const method = document.getElementById('w-method').value;
  const phone  = document.getElementById('w-phone').value.trim();
  const amount = parseInt(document.getElementById('w-amount').value);
  const errEl  = document.getElementById('w-error');
  if (errEl) errEl.textContent = '';

  // Validações
  if (!phone)              { if (errEl) errEl.textContent = 'Insere o número de telefone.'; return; }
  if (!amount || isNaN(amount)) { if (errEl) errEl.textContent = 'Insere um valor válido.'; return; }
  if (amount < SAQUE_MIN_KZ)    { if (errEl) errEl.textContent = `Valor mínimo é ${SAQUE_MIN_KZ} Kz.`; return; }
  if (amount > LIMITE_SAQUE_DIA){ if (errEl) errEl.textContent = `Limite diário é ${LIMITE_SAQUE_DIA} Kz.`; return; }

  const kzDisp = calcularKz(currentUser.pontos || 0);
  if (amount > kzDisp) { if (errEl) errEl.textContent = `Saldo insuficiente. Tens ${kzDisp} Kz.`; return; }

  // Verificar limite diário nos saques reais do Firebase
  const today    = todayStr();
  const saques   = currentUser._saques || [];
  const totalHoje = saques
    .filter(s => (s.data || '').startsWith(today) && s.status !== 'rejeitado')
    .reduce((a, s) => a + (s.valor || 0), 0);
  if (totalHoje + amount > LIMITE_SAQUE_DIA) {
    if (errEl) errEl.textContent = `Limite diário atingido. Já sacaste ${totalHoje} Kz hoje.`;
    return;
  }

  const btn = document.querySelector('#screen-wallet .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'A processar...'; }

  try {
    const metodoNome = method === 'unitel' ? 'Unitel Money' : method === 'africell' ? 'Africell Money' : 'Multicaixa Express';
    const ptsCusto   = Math.ceil(amount / KZ_POR_LOTE * PONTOS_PARA_KZ);
    const saqueId    = Date.now().toString();

    // 1. Criar o saque no nó separado /saques/ (para o admin gerir)
    const saqueData = {
      userId:    currentUserId,
      userName:  currentUser.nome,
      userEmail: currentUser.email || '',
      telefone:  phone,
      valor:     amount,
      metodo:    metodoNome,
      status:    'pendente',
      data:      today,
      timestamp: new Date().toISOString(),
    };
    await window.firebase.set(
      window.firebase.ref(window.db, `saques/${saqueId}`),
      saqueData
    );

    // 2. Debitar pontos do utilizador
    currentUser.pontos = Math.max(0, (currentUser.pontos || 0) - ptsCusto);
    await salvarUsuario();

    // Limpar campos
    document.getElementById('w-phone').value  = '';
    document.getElementById('w-amount').value = '';
    showToast('Saque solicitado! Aguarda aprovação. ⏳', 'info');
    renderWalletDados();
    // O histórico vai actualizar automaticamente pelo listener onValue

  } catch(e) {
    if (errEl) errEl.textContent = 'Erro ao processar saque. Tenta novamente.';
    console.error('Erro saque:', e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Solicitar Saque'; }
  }
}

// ══════════════════════════════════════════
//  ENERGIA
// ══════════════════════════════════════════

async function checkEnergyRecharge() {
  if (!currentUser) return;
  const energia   = currentUser.energia !== undefined ? currentUser.energia : ENERGIA_MAX;
  if (energia >= ENERGIA_MAX) return;
  const now       = Date.now();
  const lastTime  = currentUser.energia_ts || now;
  const diff      = now - lastTime;
  const recharges = Math.floor(diff / RECHARGE_MS);
  if (recharges > 0) {
    const nova = Math.min(energia + recharges, ENERGIA_MAX);
    if (nova !== energia) {
      currentUser.energia    = nova;
      currentUser.energia_ts = now;
      await salvarUsuario();
      if (currentScreen === 'home') renderHome(false);
    }
  }
}

// ══════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════

function resetDailyIfNeeded() {
  if (!currentUser) return;
  const today = todayStr();
  if (!currentUser.hoje || currentUser.hoje.data !== today) {
    currentUser.hoje = { jogos:0, acertos:0, anuncios:0, maxpts:0, data: today };
  }
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

async function salvarUsuario() {
  if (!currentUserId || !currentUser) return;
  const { id, _saques, ...dados } = currentUser; // não guardar campos internos
  try {
    await window.firebase.update(
      window.firebase.ref(window.db, `users/${currentUserId}`),
      dados
    );
  } catch(e) {
    console.error('Erro ao salvar utilizador:', e);
  }
}

let toastTimeout;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className   = 'toast show ' + type;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove('show'), 3000);
}
