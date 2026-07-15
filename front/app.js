const screens = [
  "login-screen",
  "name-screen",
  "era-screen",
  "genre-screen",
  "hit-screen",
  "cover-screen",
  "finish-screen",
  "record-home-screen",
  "record-page-screen",
  "capture-screen",
  "note-screen",
  "emotion-screen",
  "record-complete-screen",
  "playlist-loading-screen",
  "playlist-edit-screen",
  "playlist-complete-screen",
];

let currentIndex = 0;
let logCount = 0;
let pendingNote = "";
let completeTimer = null;
let playlistTimer = null;

const polaroidList = document.getElementById("polaroid-list");
const playlistButton = document.getElementById("playlist-button");
const recordNoteInput = document.getElementById("record-note");
const hitSlider = document.getElementById("hit-slider");
const hitSliderWrap = document.querySelector(".hit-slider-wrap");



function formatToday() {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}.${values.month}.${values.day}`;
}

function updateRecordDates() {
  const today = formatToday();
  for (const dateElement of document.querySelectorAll(".record-date")) {
    dateElement.textContent = today;
  }
}
function updateHitSlider() {
  if (!hitSlider) return;
  const min = Number(hitSlider.min || 0);
  const max = Number(hitSlider.max || 100);
  const value = Number(hitSlider.value || 0);
  const percent = ((value - min) / (max - min)) * 100;
  hitSlider.style.setProperty("--hit-value", `${percent}%`);
  hitSliderWrap?.style.setProperty("--hit-value", `${percent}%`);
}
function showScreen(index) {
  if (completeTimer) {
    clearTimeout(completeTimer);
    completeTimer = null;
  }
  if (playlistTimer) {
    clearTimeout(playlistTimer);
    playlistTimer = null;
  }

  currentIndex = Math.max(0, Math.min(index, screens.length - 1));
  for (const id of screens) {
    document.getElementById(id).classList.toggle("active", id === screens[currentIndex]);
  }

  const currentScreen = screens[currentIndex];
  if (currentScreen === "finish-screen") {
    completeTimer = setTimeout(() => {
      showScreen(screens.indexOf("record-home-screen"));
    }, 3000);
  }  if (currentScreen === "record-page-screen") {
    renderPolaroids();
  }
  if (currentScreen === "record-complete-screen") {
    completeTimer = setTimeout(() => {
      showScreen(screens.indexOf("record-home-screen"));
    }, 2000);
  }
  if (currentScreen === "playlist-loading-screen") {
    playlistTimer = setTimeout(() => {
      showScreen(screens.indexOf("playlist-edit-screen"));
    }, 3000);
  }
}

function selectCard(card) {
  const grid = card.closest(".card-grid") || card.parentElement;
  if (!grid) return;
  const isMultiSelect = grid.getAttribute("aria-multiselectable") === "true";

  if (isMultiSelect) {
    card.classList.toggle("selected");
    card.setAttribute("aria-selected", String(card.classList.contains("selected")));
    return;
  }

  for (const item of grid.querySelectorAll(".choice-card")) {
    item.classList.remove("selected");
    item.setAttribute("aria-selected", "false");
  }
  card.classList.add("selected");
  card.setAttribute("aria-selected", "true");
}

function selectEmotion(button) {
  for (const item of document.querySelectorAll(".emotion-choice")) {
    item.classList.remove("selected");
    item.setAttribute("aria-selected", "false");
  }
  button.classList.add("selected");
  button.setAttribute("aria-selected", "true");
}

function polaroidPosition(index) {
  const row = Math.floor(index / 4);
  const layouts = [
    { left: -18, top: 10, rotate: -15 },
    { left: 180, top: 118, rotate: -12 },
    { left: -9, top: 338, rotate: 5 },
    { left: 168, top: 438, rotate: -12 },
  ];
  const base = layouts[index % layouts.length];
  return {
    left: base.left,
    top: base.top + row * 720,
    rotate: base.rotate,
  };
}

function makePolaroid({ index, add = false }) {
  const pos = polaroidPosition(index);
  const card = document.createElement("button");
  card.type = "button";
  card.className = add ? "polaroid add-polaroid" : "polaroid log-polaroid";
  card.style.left = `${pos.left}px`;
  card.style.top = `${pos.top}px`;
  card.style.transform = `rotate(${pos.rotate}deg)`;

  const image = document.createElement("div");
  image.className = "polaroid-image";

  const caption = document.createElement("div");
  caption.className = "polaroid-caption";

  if (add) {
    card.dataset.action = "add-log";
    image.innerHTML = '<span class="add-mark">+</span><span class="add-text">기록하기</span>';
    caption.textContent = "";
  } else if (logCount === 0) {
    image.textContent = "";
    caption.textContent = "";
  } else {
    image.textContent = "";
    caption.textContent = pendingNote || "오늘 감정과 상황을 기록했어요";
  }

  const time = document.createElement("span");
  time.className = "polaroid-time";
  time.textContent = "";

  card.append(image, caption, time);
  return card;
}

function renderPolaroids() {
  polaroidList.replaceChildren();
  const board = document.createElement("div");
  board.className = "polaroid-board";

  const displayCount = logCount === 0 ? 3 : logCount;
  const totalCards = displayCount + 1;
  for (let index = 0; index < displayCount; index += 1) {
    board.appendChild(makePolaroid({ index }));
  }
  board.appendChild(makePolaroid({ index: displayCount, add: true }));

  const rows = Math.ceil(totalCards / 4);
  board.style.minHeight = `${Math.max(760, rows * 720 + 120)}px`;
  polaroidList.appendChild(board);
  playlistButton.classList.toggle("visible", logCount >= 4);
}

recordNoteInput?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  pendingNote = event.target.value.trim();
  showScreen(screens.indexOf("emotion-screen"));
});


hitSlider?.addEventListener("input", updateHitSlider);
updateHitSlider();
updateRecordDates();
document.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  const action = target.dataset.action;

  if (action === "spotify-login" || action === "next") {
    showScreen(currentIndex + 1);
    return;
  }

  if (action === "open-records") {
    showScreen(screens.indexOf("record-page-screen"));
    return;
  }

  if (action === "add-log") {
    showScreen(screens.indexOf("capture-screen"));
    return;
  }

  if (action === "capture-photo") {
    showScreen(screens.indexOf("note-screen"));
    recordNoteInput.focus();
    return;
  }

  if (action === "save-log") {
    logCount += 1;
    recordNoteInput.value = "";
    showScreen(screens.indexOf("record-complete-screen"));
    return;
  }

  if (action === "complete-playlist") {
    showScreen(screens.indexOf("playlist-complete-screen"));
    return;
  }

  if (action === "go-record-home") {
    showScreen(screens.indexOf("record-home-screen"));
    return;
  }

  if (target.id === "playlist-button") {
    showScreen(screens.indexOf("playlist-loading-screen"));
    return;
  }

  if (action === "back") {
    showScreen(currentIndex - 1);
    return;
  }

  if (target.classList.contains("choice-card")) {
    selectCard(target);
    return;
  }

  if (target.classList.contains("emotion-choice")) {
    selectEmotion(target);
  }
});

renderPolaroids();










