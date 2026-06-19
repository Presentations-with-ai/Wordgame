const TG = window.Telegram?.WebApp;
try { TG?.ready(); TG?.expand(); } catch (e) {}

const TARGET_SCORE = 1000;
const ANSWERS_PER_ROUND = 6;
const MAX_CACHED_PARTS = 2;
const BASE_MANIFEST = "manifest.json";
const ALL_CATEGORY = "all";
let winTimer = null;

let MANIFEST = null;
let partCache = new Map();
let cacheOrder = [];

let state = {
  score: 0,
  round: 0,
  used: new Set(),
  current: null,
  currentPart: null,
  selectedIndex: null,
  questionDone: false,
  allShown: false,
  totalOpened: 0,
  loading: false,
  category: ALL_CATEGORY,
  hostAnswersVisible: false,
  awardedScore: 0
};

const $ = (id) => document.getElementById(id);
const els = {
  startScreen: $("startScreen"), gameScreen: $("gameScreen"), winScreen: $("winScreen"),
  startBtn: $("startBtn"), restartBtn: $("restartBtn"), themeBtn: $("themeBtn"), changeCategoryBtn: $("changeCategoryBtn"),
  score: $("score"), round: $("round"), loadedPart: $("loadedPart"), categoryStat: $("categoryStat"),
  progressBar: $("progressBar"), progressText: $("progressText"), categoryGrid: $("categoryGrid"),
  questionId: $("questionId"), categoryPill: $("categoryPill"), questionText: $("questionText"), board: $("board"), answerList: $("answerList"),
  nextBtn: $("nextBtn"), shuffleBtn: $("shuffleBtn"), showAllBtn: $("showAllBtn"), hostToggleBtn: $("hostToggleBtn"), undoBtn: $("undoBtn"),
  message: $("message"), finalText: $("finalText"), baseInfo: $("baseInfo")
};

function show(el){ el?.classList.remove("hidden"); }
function hide(el){ el?.classList.add("hidden"); }
function setMessage(text = "", cls = ""){
  if(!els.message) return;
  els.message.textContent = text;
  els.message.className = "message " + cls;
  if(text) show(els.message); else hide(els.message);
}
function switchScreen(name){
  hide(els.startScreen); hide(els.gameScreen); hide(els.winScreen);
  if(name === "start") show(els.startScreen);
  if(name === "game") show(els.gameScreen);
  if(name === "win") show(els.winScreen);
}
function setControlsDisabled(disabled){
  [els.nextBtn, els.shuffleBtn, els.changeCategoryBtn, els.hostToggleBtn].forEach(btn => { if(btn) btn.disabled = disabled; });
  updateUndoButton();
}
function formatNum(n){ return Number(n || 0).toLocaleString("ru-RU"); }
function categoryById(id){ return (MANIFEST?.categories || []).find(c => c.id === id); }
function categoryLabel(id){
  if(id === ALL_CATEGORY) return "Все";
  const c = categoryById(id);
  return c ? `${c.emoji || ""} ${c.label}`.trim() : id;
}
function shortCategoryLabel(id){
  if(id === ALL_CATEGORY) return "Все";
  const c = categoryById(id);
  return c ? c.label.split(" ")[0] : id;
}

function categoryCount(cat){
  if(!MANIFEST) return 0;
  if(cat.id === ALL_CATEGORY) return MANIFEST.totalQuestions || MANIFEST.parts?.reduce((sum, p) => sum + Number(p.count || 0), 0) || 0;
  return Number(cat.count || 0);
}

function countText(n){
  return `${formatNum(n)} вопросов`;
}

function updateUndoButton(){
  if(!els.undoBtn) return;
  els.undoBtn.disabled = !(state.current && state.questionDone && state.selectedIndex !== null && !state.loading);
}

async function loadManifest(){
  try {
    const res = await fetch(BASE_MANIFEST, { cache: "no-store" });
    if(!res.ok) throw new Error("manifest");
    const data = await res.json();
    if(!data || !Array.isArray(data.parts) || !data.parts.length) throw new Error("manifest");
    MANIFEST = data;
    renderCategories();
    els.startBtn.disabled = false;
    els.startBtn.textContent = "Начать";
    els.baseInfo.textContent = "";
    updateTop();
  } catch (err) {
    els.startBtn.disabled = true;
    els.startBtn.textContent = "Ошибка базы";
    els.baseInfo.textContent = "manifest.json не найден";
  }
}

function renderCategories(){
  els.categoryGrid.innerHTML = "";
  els.categoryGrid.appendChild(makeCategoryButton({id: ALL_CATEGORY, label: "Все категории", emoji: "🎲"}));
  (MANIFEST.categories || []).forEach(cat => els.categoryGrid.appendChild(makeCategoryButton(cat)));
}

function makeCategoryButton(cat){
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "categoryBtn" + (state.category === cat.id ? " active" : "");
  btn.innerHTML = `<span class="emoji">${escapeHtml(cat.emoji || "•")}</span><span class="catText"><span class="catName">${escapeHtml(cat.label)}</span><span class="catCount">${countText(categoryCount(cat))}</span></span>`;
  btn.addEventListener("click", () => {
    state.category = cat.id;
    document.querySelectorAll(".categoryBtn").forEach(x => x.classList.remove("active"));
    btn.classList.add("active");
    updateTop();
  });
  return btn;
}

function updateTop(){
  els.score.textContent = state.score;
  els.round.textContent = state.round;
  if(els.loadedPart) els.loadedPart.textContent = state.currentPart ? String(state.currentPart).padStart(2, "0") : "—";
  els.categoryStat.textContent = shortCategoryLabel(state.category);
  const pct = Math.min(100, Math.round((state.score / TARGET_SCORE) * 100));
  els.progressBar.style.width = pct + "%";
  els.progressText.textContent = `${state.score} / ${TARGET_SCORE}`;
  if(els.categoryPill) els.categoryPill.textContent = state.current?.categoryLabel || categoryLabel(state.category);
  updateUndoButton();
  try {
    TG?.MainButton?.setText(`${state.score}/${TARGET_SCORE}`);
    if(state.current) TG?.MainButton?.show();
  } catch(e) {}
}

function randomItem(arr){ return arr[Math.floor(Math.random() * arr.length)]; }

async function loadPart(partMeta){
  const partKey = String(partMeta.part);
  if(partCache.has(partKey)) return partCache.get(partKey);

  setControlsDisabled(true);
  if(els.loadedPart) els.loadedPart.textContent = String(partMeta.part).padStart(2, "0");
  setMessage("Загрузка...");

  const res = await fetch(partMeta.url, { cache: "force-cache" });
  if(!res.ok) throw new Error(`Не удалось загрузить ${partMeta.url}`);
  const raw = await res.json();
  const questions = Array.isArray(raw) ? raw : (raw.questions || raw.q || []);
  if(!Array.isArray(questions) || !questions.length) throw new Error(`Пустой файл ${partMeta.url}`);

  partCache.set(partKey, questions);
  cacheOrder.push(partKey);
  while(cacheOrder.length > MAX_CACHED_PARTS){
    const oldKey = cacheOrder.shift();
    partCache.delete(oldKey);
  }
  setControlsDisabled(false);
  return questions;
}

function normalizeQuestion(q){
  const answersRaw = q.a || q.answers || [];
  const answers = answersRaw.slice(0, ANSWERS_PER_ROUND).map((item) => {
    if(Array.isArray(item)) return { text: item[0], score: Number(item[1] || 0) };
    return { text: item.text || item.word || "—", score: Number(item.score || item.points || 0) };
  });
  const catId = q.c || q.category || ALL_CATEGORY;
  return {
    id: q.id || q.i,
    category: catId,
    categoryLabel: categoryLabel(catId),
    question: q.q || q.question || "Вопрос",
    answers
  };
}

function eligibleParts(){
  if(!MANIFEST) return [];
  if(state.category === ALL_CATEGORY) return MANIFEST.parts;
  const parts = MANIFEST.parts.filter(p => Number(p.categoryCounts?.[state.category] || 0) > 0);
  return parts.length ? parts : MANIFEST.parts;
}

async function pickQuestion(){
  if(!MANIFEST) throw new Error("База не загружена");
  const parts = eligibleParts();
  for(let attempt = 0; attempt < 30; attempt++){
    const partMeta = randomItem(parts);
    const questions = await loadPart(partMeta);
    let pool = questions;
    if(state.category !== ALL_CATEGORY){
      pool = questions.filter(q => (q.c || q.category) === state.category);
      if(!pool.length) continue;
    }
    const q = normalizeQuestion(randomItem(pool));
    const usedKey = `${q.category}:${q.id}`;
    if(!q.id || !state.used.has(usedKey)){
      if(q.id) state.used.add(usedKey);
      return { ...q, part: partMeta.part };
    }
  }
  const partMeta = randomItem(parts);
  const questions = await loadPart(partMeta);
  const pool = state.category === ALL_CATEGORY ? questions : questions.filter(q => (q.c || q.category) === state.category);
  const q = normalizeQuestion(randomItem(pool.length ? pool : questions));
  if(q.id) state.used.add(`${q.category}:${q.id}`);
  return { ...q, part: partMeta.part };
}

async function newQuestion(){
  if(state.loading) return;
  state.loading = true;
  setControlsDisabled(true);
  els.questionId.textContent = "#—";
  els.categoryPill.textContent = categoryLabel(state.category);
  els.questionText.textContent = "Загрузка...";
  els.board.innerHTML = "";
  els.answerList.innerHTML = "";
  state.hostAnswersVisible = false;
  updateHostPanel();
  try {
    state.current = await pickQuestion();
    state.currentPart = state.current.part;
    state.round += 1;
    state.selectedIndex = null;
    state.questionDone = false;
    state.allShown = false;
    state.awardedScore = 0;
    els.questionId.textContent = `#${state.current.id ?? state.round}`;
    els.categoryPill.textContent = state.current.categoryLabel;
    els.questionText.textContent = state.current.question;
    renderBoard();
    renderAnswerList();
    setMessage("");
  } catch (err) {
    els.questionText.textContent = "Ошибка базы";
    setMessage(err.message || "Не удалось загрузить вопрос", "bad");
  } finally {
    state.loading = false;
    setControlsDisabled(false);
    updateTop();
  }
}

async function startGame(){
  state = {
    score: 0,
    round: 0,
    used: new Set(),
    current: null,
    currentPart: null,
    selectedIndex: null,
    questionDone: false,
    allShown: false,
    totalOpened: 0,
    loading: false,
    category: state.category || ALL_CATEGORY,
    hostAnswersVisible: false,
    awardedScore: 0
  };
  switchScreen("game");
  await newQuestion();
}

function win(){
  els.finalText.textContent = `Счёт: ${state.score}. Вопросов: ${state.round}.`;
  switchScreen("win");
  try { TG?.HapticFeedback?.notificationOccurred("success"); } catch(e) {}
}

function shouldShowAnswer(){ return state.questionDone || state.allShown; }

function renderBoard(){
  els.board.innerHTML = "";
  if(!state.current) return;
  const answers = state.current.answers.slice(0, ANSWERS_PER_ROUND);
  answers.forEach((answer, index) => {
    const opened = shouldShowAnswer();
    const selected = state.selectedIndex === index;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "answerTile" + (opened ? " opened" : "") + (selected ? " selected" : "") + (state.questionDone ? " locked" : "");
    btn.dataset.answerIndex = String(index);
    btn.disabled = false;
    btn.innerHTML = opened
      ? `<span class="num">${index + 1}</span><span class="word">${escapeHtml(answer.text)}</span><span class="points">${answer.score}</span>`
      : `<span class="num">${index + 1}</span><span class="mask"></span><span class="points">${answer.score}</span>`;

    // Нажатие на плитку сразу выбирает вариант и раскрывает все ответы.
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      revealAnswer(index);
    });

    els.board.appendChild(btn);
  });
}

function renderAnswerList(){
  els.answerList.innerHTML = "";
  if(!state.current) return;
  state.current.answers.slice(0, ANSWERS_PER_ROUND).forEach((answer, index) => {
    const selected = state.selectedIndex === index;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "answerListBtn" + (selected ? " selected" : "") + (state.questionDone ? " locked" : "");
    btn.dataset.answerIndex = String(index);
    btn.setAttribute("aria-pressed", selected ? "true" : "false");
    btn.innerHTML = `<span>${index + 1}. ${escapeHtml(answer.text)}</span><b>${answer.score}</b>`;

    // Прямой обработчик, чтобы на телефоне клик точно раскрывал ответ.
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      revealAnswer(index);
    });

    els.answerList.appendChild(btn);
  });
  updateHostPanel();
}

function updateHostPanel(){
  if(!els.answerList || !els.hostToggleBtn) return;
  if(state.hostAnswersVisible) {
    show(els.answerList);
    els.hostToggleBtn.textContent = "Скрыть ответы";
  } else {
    hide(els.answerList);
    els.hostToggleBtn.textContent = "Ответы ведущего";
  }
}

function toggleHostAnswers(){
  if(!state.current || state.loading) return;
  state.hostAnswersVisible = !state.hostAnswersVisible;
  updateHostPanel();
}

function revealAnswer(index){
  if(!state.current || state.questionDone || state.loading) return;
  index = Number(index);
  if(!Number.isInteger(index)) return;
  const answer = state.current.answers[index];
  if(!answer) return;

  state.selectedIndex = index;
  state.questionDone = true;
  state.allShown = true;
  state.hostAnswersVisible = true;
  state.awardedScore = Number(answer.score || 0);
  state.score += state.awardedScore;
  state.totalOpened += 1;

  renderBoard();
  renderAnswerList();
  updateHostPanel();
  updateTop();
  setMessage(`Открыт ответ: ${answer.text} · +${answer.score}`, "good");
  try { TG?.HapticFeedback?.impactOccurred("medium"); } catch(e) {}

  // После клика ведущего главный блок с открытыми ответами сразу попадает в область экрана.
  try { els.board?.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch(e) {}

  updateUndoButton();
  if(state.score >= TARGET_SCORE) {
    clearTimeout(winTimer);
    winTimer = setTimeout(win, 650);
  }
}

function undoChoice(){
  if(!state.current || !state.questionDone || state.selectedIndex === null || state.loading) return;
  clearTimeout(winTimer);
  state.score = Math.max(0, state.score - Number(state.awardedScore || 0));
  state.selectedIndex = null;
  state.questionDone = false;
  state.allShown = false;
  state.awardedScore = 0;
  state.hostAnswersVisible = true;
  renderBoard();
  renderAnswerList();
  updateTop();
  updateUndoButton();
  setMessage("Выбор отменён");
}

function showAllAnswers(){
  if(!state.current || state.questionDone || state.loading) return;
  state.allShown = true;
  renderBoard();
  setMessage("Открыто без баллов");
}

// Дополнительная страховка для мобильных браузеров и Telegram WebApp:
// если прямой обработчик кнопки не сработал, ловим клик на контейнере.
function answerClickDelegate(event){
  const btn = event.target?.closest?.("[data-answer-index]");
  if(!btn) return;
  event.preventDefault();
  event.stopPropagation();
  revealAnswer(Number(btn.dataset.answerIndex));
}

function answerTouchDelegate(event){
  const btn = event.target?.closest?.("[data-answer-index]");
  if(!btn) return;
  event.preventDefault();
  event.stopPropagation();
  revealAnswer(Number(btn.dataset.answerIndex));
}

function escapeHtml(value){
  return String(value ?? "").replace(/[&<>"]/g, (m) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;"}[m]));
}

// Клики по вариантам: работает и на обычном браузере, и в Telegram WebApp.
// Один общий обработчик + прямые обработчики на кнопках дают защиту от мобильных багов.
els.board?.addEventListener("click", answerClickDelegate);
els.answerList?.addEventListener("click", answerClickDelegate);
els.board?.addEventListener("touchend", answerTouchDelegate, { passive: false });
els.answerList?.addEventListener("touchend", answerTouchDelegate, { passive: false });
els.startBtn.disabled = true;
els.startBtn.addEventListener("click", startGame);
els.restartBtn.addEventListener("click", () => { switchScreen("start"); renderCategories(); updateTop(); });
els.nextBtn.addEventListener("click", newQuestion);
els.shuffleBtn.addEventListener("click", newQuestion);
els.showAllBtn?.addEventListener("click", showAllAnswers);
els.hostToggleBtn?.addEventListener("click", toggleHostAnswers);
els.undoBtn?.addEventListener("click", undoChoice);
els.changeCategoryBtn.addEventListener("click", () => { switchScreen("start"); renderCategories(); updateTop(); });
els.themeBtn.addEventListener("click", () => {
  document.body.classList.toggle("dark");
  localStorage.setItem("game-theme", document.body.classList.contains("dark") ? "dark" : "light");
});

if(localStorage.getItem("game-theme") === "dark") document.body.classList.add("dark");
loadManifest();
