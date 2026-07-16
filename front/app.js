const screens = [
  "login-screen",
  "name-screen",
  "era-screen",
  "genre-screen",
  "hit-screen",
  "cover-screen",
  "finish-screen",
  "record-home-screen",
  "archive-screen",
  "archive-month-screen",
  "archive-playlist-detail-screen",
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
const logs = [];
const archivePlaylistCounts = Array(12).fill(0);
const archivePlaylists = Array.from({ length: 12 }, () => []);
let activeArchiveMonth = getCurrentMonthNumber();
let activeArchivePlaylistIndex = 0;
let pendingNote = "";
let completeTimer = null;
let playlistTimer = null;

const polaroidList = document.getElementById("polaroid-list");
const playlistButton = document.getElementById("playlist-button");
const recordNoteInput = document.getElementById("record-note");
const hitSlider = document.getElementById("hit-slider");
const hitSliderWrap = document.querySelector(".hit-slider-wrap");
const cameraVideo = document.getElementById("camera-video");
const cameraCanvas = document.getElementById("camera-canvas");
const cameraPreview = document.querySelector(".camera-preview");
const cameraFlashOverlay = document.querySelector(".camera-flash-overlay");
const zoomSlider = document.getElementById("zoom-slider");
const zoomLabels = document.querySelectorAll(".zoom-labels span");
const notePhoto = document.querySelector(".note-photo");
const flashButton = document.querySelector(".flash-button");
const emotionPhotoPreview = document.querySelector(".emotion-photo-preview");
const emotionCaptionPreview = document.querySelector(".emotion-caption-preview");
const emotionStaff = document.querySelector(".emotion-staff");
const playlistTitleInput = document.getElementById("playlist-title");
const playlistIntroInput = document.querySelector(".playlist-intro-input");
const archiveMonthTitle = document.getElementById("archive-month-title");
const archiveMonthCarousel = document.getElementById("archive-month-carousel");
const archiveMonthPlaylistTitle = document.getElementById("archive-month-playlist-title");
const archiveMonthPlaylistDesc = document.getElementById("archive-month-playlist-desc");
const archiveDetailTitle = document.getElementById("archive-detail-title");
const archiveDetailDate = document.getElementById("archive-detail-date");
const archiveDetailName = document.getElementById("archive-detail-name");
let cameraStream = null;
let cameraFacingMode = "environment";
let flashEnabled = false;
let capturedPhotoDataUrl = "";
let staffNoteCount = 0;



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
  for (const dateElement of document.querySelectorAll(".record-date, .playlist-date")) {
    dateElement.textContent = today;
  }
}

function applyZoom() {
  if (!zoomSlider) return;
  const zoom = Number(zoomSlider.value || 1);
  if (cameraVideo) cameraVideo.style.transform = `scale(${zoom})`;
  for (const label of zoomLabels) {
    label.classList.toggle("active", Number(label.dataset.zoom) === zoom);
  }
}

function stopCamera() {
  if (!cameraStream) return;
  for (const track of cameraStream.getTracks()) track.stop();
  cameraStream = null;
  if (cameraVideo) cameraVideo.srcObject = null;
  cameraPreview?.classList.remove("has-stream");
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia || !cameraVideo) return;
  stopCamera();
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cameraFacingMode, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    });
    cameraVideo.srcObject = cameraStream;
    cameraPreview?.classList.add("has-stream");
    await cameraVideo.play();
    applyZoom();
  } catch (error) {
    cameraPreview?.classList.remove("has-stream");
  }
}

async function applyTorch() {
  const track = cameraStream?.getVideoTracks?.()[0];
  if (!track) return;
  const capabilities = track.getCapabilities?.();
  if (!capabilities?.torch) return;
  try {
    await track.applyConstraints({ advanced: [{ torch: flashEnabled }] });
  } catch (error) {
    // Torch is optional across browsers/devices.
  }
}

function flashPreview() {
  cameraFlashOverlay?.classList.remove("flash");
  void cameraFlashOverlay?.offsetWidth;
  cameraFlashOverlay?.classList.add("flash");
}

function updateCapturedPhotoPreview() {
  if (!notePhoto || !capturedPhotoDataUrl) return;
  notePhoto.classList.add("has-photo");
  notePhoto.style.backgroundImage = `url("${capturedPhotoDataUrl}")`;
  notePhoto.style.backgroundSize = "cover";
  notePhoto.style.backgroundPosition = "center";
  let image = notePhoto.querySelector("img");
  if (!image) {
    image = document.createElement("img");
    image.alt = "촬영한 사진";
    notePhoto.replaceChildren(image);
  }
  image.src = capturedPhotoDataUrl;
}

function captureCurrentFrame() {
  if (!cameraVideo || !cameraCanvas || cameraVideo.readyState < 2) return false;
  const zoom = Number(zoomSlider?.value || 1);
  const sourceWidth = cameraVideo.videoWidth;
  const sourceHeight = cameraVideo.videoHeight;
  if (!sourceWidth || !sourceHeight) return false;
  const cropWidth = sourceWidth / zoom;
  const cropHeight = sourceHeight / zoom;
  const sourceX = (sourceWidth - cropWidth) / 2;
  const sourceY = (sourceHeight - cropHeight) / 2;
  cameraCanvas.width = 1080;
  cameraCanvas.height = 1080;
  const context = cameraCanvas.getContext("2d");
  context.drawImage(cameraVideo, sourceX, sourceY, cropWidth, cropHeight, 0, 0, cameraCanvas.width, cameraCanvas.height);
  capturedPhotoDataUrl = cameraCanvas.toDataURL("image/jpeg", 0.9);
  updateCapturedPhotoPreview();
  return true;
}

function capturePhoto() {
  if (flashEnabled) flashPreview();
  const captured = captureCurrentFrame();
  if (!captured) return;
  showScreen(screens.indexOf("note-screen"));
  requestAnimationFrame(updateCapturedPhotoPreview);
  recordNoteInput?.focus();
}
function updateEmotionPreview() {
  if (emotionPhotoPreview) {
    emotionPhotoPreview.replaceChildren();
    if (capturedPhotoDataUrl) {
      const image = document.createElement("img");
      image.src = capturedPhotoDataUrl;
      image.alt = "촬영한 사진";
      emotionPhotoPreview.append(image);
    }
  }

  if (emotionCaptionPreview) {
    emotionCaptionPreview.textContent = pendingNote || "오늘 감정과 상황을 기록했어요";
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


function getCurrentMonthNumber() {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    month: "numeric",
  }).format(new Date()));
}

function renderArchiveShelves() {
  const shelves = document.querySelectorAll(".archive-shelf");
  shelves.forEach((shelf, monthIndex) => {
    shelf.replaceChildren();
    const count = archivePlaylistCounts[monthIndex] || 0;
    for (let index = 0; index < count; index += 1) {
      const lp = document.createElement("span");
      lp.className = `archive-lp archive-lp-${(index % 6) + 1}`;
      lp.style.left = `${18 + index * 24}px`;
      lp.style.zIndex = String(index + 1);
      shelf.append(lp);
    }
  });
}

function addPlaylistToArchive() {
  const month = getCurrentMonthNumber();
  archivePlaylists[month - 1].push(createArchivePlaylist());
  archivePlaylistCounts[month - 1] = archivePlaylists[month - 1].length;
  renderArchiveShelves();
}

function formatArchiveMonth(month) {
  const year = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
  }).format(new Date());
  return `${year}.${String(month).padStart(2, "0")}`;
}

function createArchivePlaylist() {
  const title = playlistTitleInput?.value.trim() || "제목 없는 플리";
  const desc = playlistIntroInput?.value.trim() || "짧은 소개글이 아직 없어요.";
  return {
    date: formatToday(),
    title,
    desc,
  };
}

function renderArchiveMonthView(month = activeArchiveMonth) {
  activeArchiveMonth = month;
  const playlists = archivePlaylists[month - 1] || [];
  if (archiveMonthTitle) archiveMonthTitle.textContent = formatArchiveMonth(month);
  archiveMonthCarousel?.replaceChildren();

  if (!playlists.length) {
    const empty = document.createElement("p");
    empty.className = "archive-empty-message";
    empty.textContent = "아직 만든 플리가 없어요";
    archiveMonthCarousel?.append(empty);
    if (archiveMonthPlaylistTitle) archiveMonthPlaylistTitle.textContent = "";
    if (archiveMonthPlaylistDesc) archiveMonthPlaylistDesc.textContent = "";
    return;
  }

  playlists.forEach((playlist, index) => {
    const card = document.createElement("button");
    card.className = "archive-album-card";
    card.type = "button";
    card.dataset.action = "open-archive-detail";
    card.dataset.index = String(index);
    card.innerHTML = `<span class="archive-album-date">${playlist.date}</span><span class="archive-album-cover"></span>`;
    archiveMonthCarousel?.append(card);
  });

  const first = playlists[0];
  if (archiveMonthPlaylistTitle) archiveMonthPlaylistTitle.textContent = first.title;
  if (archiveMonthPlaylistDesc) archiveMonthPlaylistDesc.textContent = first.desc;
  requestAnimationFrame(() => {
    archiveMonthCarousel?.scrollTo({ left: 0, behavior: "auto" });
  });
}

function renderArchivePlaylistDetail(index = activeArchivePlaylistIndex) {
  const playlists = archivePlaylists[activeArchiveMonth - 1] || [];
  const playlist = playlists[index] || playlists[0] || createArchivePlaylist();
  activeArchivePlaylistIndex = index;
  if (archiveDetailTitle) archiveDetailTitle.textContent = formatArchiveMonth(activeArchiveMonth);
  if (archiveDetailDate) archiveDetailDate.textContent = playlist.date;
  if (archiveDetailName) archiveDetailName.textContent = playlist.title;
}
function scrollArchiveToCurrentMonth() {
  const archiveScroll = document.querySelector(".archive-scroll");
  if (!archiveScroll) return;

  const month = getCurrentMonthNumber();
  const monthSection = document.querySelectorAll(".archive-month")[month - 1];
  if (!monthSection) return;

  requestAnimationFrame(() => {
    const targetTop = monthSection.offsetTop - (archiveScroll.clientHeight - monthSection.offsetHeight) / 2;
    archiveScroll.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
  });
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
  }
  if (currentScreen === "capture-screen") {
    startCamera();
  } else {
    stopCamera();
  }
  if (currentScreen === "note-screen") {
    updateCapturedPhotoPreview();
  }
  if (currentScreen === "emotion-screen") {
    updateEmotionPreview();
    resetEmotionStaff();
  }
  if (currentScreen === "archive-screen") {
    renderArchiveShelves();
    scrollArchiveToCurrentMonth();
  }
  if (currentScreen === "archive-month-screen") {
    renderArchiveMonthView(activeArchiveMonth);
  }
  if (currentScreen === "archive-playlist-detail-screen") {
    renderArchivePlaylistDetail(activeArchivePlaylistIndex);
  }
  if (currentScreen === "record-page-screen") {
    renderPolaroids();
  }
  if (currentScreen === "record-complete-screen") {
    completeTimer = setTimeout(() => {
      showScreen(screens.indexOf("record-page-screen"));
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


function resetEmotionStaff() {
  staffNoteCount = 0;
  emotionStaff?.querySelectorAll(".staff-note").forEach((note) => note.remove());
}

function addEmotionStaffNote(button) {
  if (!emotionStaff) return;
  const source = button.querySelector("img");
  if (!source) return;

  const positions = [
    { left: 4, top: -8 },
    { left: 73, top: 31 },
    { left: 139, top: 15 },
    { left: 203, top: 43 },
    { left: 273, top: -8 },
    { left: 325, top: 30 },
    { left: 349, top: 12 },
    { left: 362, top: 43 },
  ];
  const position = positions[staffNoteCount % positions.length];
  const note = document.createElement("img");
  note.className = "staff-note dynamic-staff-note";
  note.src = source.src;
  note.alt = "";
  note.style.left = `${position.left}px`;
  note.style.top = `${position.top}px`;
  emotionStaff.append(note);
  staffNoteCount += 1;
}
function selectEmotion(button) {
  for (const item of document.querySelectorAll(".emotion-choice")) {
    item.classList.remove("selected");
    item.setAttribute("aria-selected", "false");
  }
  button.classList.add("selected");
  button.setAttribute("aria-selected", "true");
  addEmotionStaffNote(button);
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

function makePolaroid({ index, add = false, log = null }) {
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
  } else if (log) {
    if (log.photo) {
      const photo = document.createElement("img");
      photo.src = log.photo;
      photo.alt = "기록 사진";
      image.append(photo);
    }
    caption.textContent = log.caption || "오늘 감정과 상황을 기록했어요";
  } else {
    image.innerHTML = '<span class="placeholder-text">지금 순간을<br />기록해보세요</span>';
    caption.textContent = "";
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

  const minimumSlotsBeforeAdd = 3;
  const displayCount = Math.max(minimumSlotsBeforeAdd, logs.length);
  const addIndex = displayCount;
  const totalCards = addIndex + 1;

  for (let index = 0; index < displayCount; index += 1) {
    board.appendChild(makePolaroid({ index, log: logs[index] || null }));
  }
  board.appendChild(makePolaroid({ index: addIndex, add: true }));

  const rows = Math.ceil(totalCards / 4);
  board.style.minHeight = `${Math.max(760, rows * 720 + 120)}px`;
  polaroidList.classList.toggle("scrollable", logs.length >= 4);
  polaroidList.appendChild(board);
  playlistButton.classList.add("visible");
}

recordNoteInput?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  pendingNote = event.target.value.trim();
  showScreen(screens.indexOf("emotion-screen"));
});


hitSlider?.addEventListener("input", updateHitSlider);
zoomSlider?.addEventListener("input", applyZoom);
updateHitSlider();
updateRecordDates();
applyZoom();
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

  if (action === "open-archive") {
    showScreen(screens.indexOf("archive-screen"));
    return;
  }

  if (action === "open-archive-month") {
    activeArchiveMonth = Number(target.dataset.month || target.closest(".archive-month")?.dataset.month || getCurrentMonthNumber());
    activeArchivePlaylistIndex = 0;
    showScreen(screens.indexOf("archive-month-screen"));
    return;
  }

  if (action === "open-archive-detail") {
    activeArchivePlaylistIndex = Number(target.closest("[data-index]")?.dataset.index || 0);
    showScreen(screens.indexOf("archive-playlist-detail-screen"));
    return;
  }

  if (action === "add-log") {
    showScreen(screens.indexOf("capture-screen"));
    return;
  }

  if (action === "capture-photo") {
    capturePhoto();
    return;
  }


  if (action === "toggle-flash") {
    flashEnabled = !flashEnabled;
    flashButton?.classList.toggle("active", flashEnabled);
    applyTorch();
    return;
  }

  if (action === "switch-camera") {
    cameraFacingMode = cameraFacingMode === "environment" ? "user" : "environment";
    startCamera();
    return;
  }
  if (action === "save-log") {
    logs.push({
      caption: pendingNote,
      photo: capturedPhotoDataUrl,
    });
    logCount = logs.length;
    pendingNote = "";
    capturedPhotoDataUrl = "";
    recordNoteInput.value = "";
    showScreen(screens.indexOf("record-complete-screen"));
    return;
  }

  if (action === "complete-playlist") {
    addPlaylistToArchive();
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

  const choiceCard = target.closest(".choice-card");
  if (choiceCard) {
    selectCard(choiceCard);
    return;
  }

  const emotionChoice = target.closest(".emotion-choice");
  if (emotionChoice) {
    selectEmotion(emotionChoice);
  }
});

renderPolaroids();









































