const DESIGN_WIDTH = 402;
const DESIGN_HEIGHT = 874;

// 키보드가 뜰 때 innerHeight가 줄어드는 것을 무시하기 위한 기준값(키보드 없을 때의 크기).
let baseViewportWidth = window.innerWidth || DESIGN_WIDTH;
let baseViewportHeight = window.innerHeight || DESIGN_HEIGHT;

// 현재 화면 id. record-home만 cover(꽉 채움), 나머지는 contain(안 잘림)으로 스케일한다.
let currentScreenId = "login-screen";

function updateAppScale() {
  const viewportWidth = window.innerWidth || DESIGN_WIDTH;
  let viewportHeight = window.innerHeight || DESIGN_HEIGHT;
  const root = document.documentElement.style;

  // 너비는 그대로인데 높이만 줄었으면 = 키보드가 올라온 것.
  // 이때 앱을 다시 축소하지 않도록 "키보드 없을 때 높이"를 그대로 사용한다.
  // (그래야 폴라로이드/입력창이 안 흔들리고, 키보드는 앱 위에 겹쳐진다)
  if (viewportWidth === baseViewportWidth && viewportHeight < baseViewportHeight) {
    viewportHeight = baseViewportHeight;
  } else {
    baseViewportWidth = viewportWidth;
    baseViewportHeight = viewportHeight;
  }

  const fit = Math.min(viewportWidth / DESIGN_WIDTH, viewportHeight / DESIGN_HEIGHT);
  const isMobile = viewportWidth <= 600;
  // 모든 화면은 화면을 잘라내지 않는 contain(fit) 방식으로 맞춘다.
  // 화면이 딱 맞지 않을 때는 옆 여백이 배경색으로 채워지도록 한다.
  let scale;
  if (!isMobile) {
    scale = Math.min(fit, 1);
  } else {
    scale = fit;
  }
  root.setProperty("--app-scale-x", String(scale));
  root.setProperty("--app-scale-y", String(scale));

  root.setProperty("--app-width", `${DESIGN_WIDTH}px`);
  root.setProperty("--app-height", `${DESIGN_HEIGHT}px`);

  // record-home 데스크를 여백까지 이어지게 하기 위한 "벽/책상 경계선"의 화면상 y좌표.
  // (프레임은 화면 중앙에 scale로 축소돼 있고, 그 안 벽 높이는 163px)
  const WALL_HEIGHT = 163;
  const frameTop = (viewportHeight - DESIGN_HEIGHT * scale) / 2;
  root.setProperty("--desk-split", `${Math.round(frameTop + WALL_HEIGHT * scale)}px`);
}

updateAppScale();
window.addEventListener("resize", updateAppScale);
window.addEventListener("orientationchange", updateAppScale);
const screens = [
  "login-screen",
  "name-screen",
  "era-screen",
  "genre-screen",
  "hit-screen",
  "welcome-screen",
  "record-home-screen",
  "archive-screen",
  "archive-month-screen",
  "archive-playlist-detail-screen",
  "playlist-player-screen",
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
const logs = [];
let pendingDeleteLog = null;
// 트랙 "•••" 로그 팝업용: 화면에 마지막으로 그려진 트랙 목록의 실제 사진/캡션/날짜.
// (오늘/아카이브 어느 날짜를 보고 있든 항상 그 화면이 채운 값을 그대로 씀)
let currentTrackLogs = [];
let archiveMonthCounts = Array(12).fill(0);
// 화면에서 왼쪽부터 보이는 LP 1~31번의 색상. 
const ARCHIVE_LP_COLORS = [
  "#F44D07", "#F8F5E6", "#72261C", "#CBE5FE",
  "#B4CAE0", "#F44D07", "#72261C", "#F8F5E6",
  "#44654A", "#26422B", "#EDD569", "#FFF6CB",
  "#F44D07", "#CBE5FE", "#72261C", "#F44D07",
  "#E17A4F", "#F8F5E6",
  "#26422B", "#E05959", "#72261C", "#F44D07",
  "#CBE5FE", "#72261C", "#F8F5E6", "#F44D07",
  "#F8F5E6", "#AFC1D2", "#CBE5FE", "#26422B",
  "#FFF3BD",
];
const ARCHIVE_LP_SIDE_COLORS = {
  18: "#E3E0D2",
  19: "#3F6846",
};
let activeMonthPlaylists = [];
let activeArchiveMonth = getCurrentMonthNumber();
let activeArchiveYear = getCurrentYearNumber();
let activeArchivePlaylistIndex = 0;
let archiveCarouselFrame = null;
let archiveDetailCarouselFrame = null;
let archiveDetailRenderToken = 0;
let archiveMonthSwipeStart = null;
let activePlayerDate = null;
let pendingNote = "";
let completeTimer = null;
let playlistTimer = null;
let hasTodayPlaylist = false;
let playerEntryMode = "archive";
let isPlayerPlaying = false;

// --- Spotify Web Playback SDK 상태 ---
let spotifyPlayer = null;
let spotifyDeviceId = null;
let spotifyReady = false;
let spotifyPlaybackStarted = false;
let spotifyIsPremium = null;
let currentTrackUris = [];
let currentTrackSpotifyUrls = [];
let currentTrackIndex = 0;
let currentTrackPlaybackIndexes = [];
let currentPlaybackLogs = [];
let pendingPlaybackIndex = null;
let pendingPlayerStartLogIndex = null;
let pendingPlayerAutoPlay = false;
let playerStatusTimer = null;
const pendingLogProcessingTasks = new Set();

const appShell = document.querySelector(".app-shell");
const polaroidList = document.getElementById("polaroid-list");
const playlistButton = document.getElementById("playlist-button");
const deleteLogModal = document.getElementById("delete-log-modal");
const deleteLogMessage = document.getElementById("delete-log-message");
const deleteLogConfirm = document.querySelector(".delete-log-confirm");
const recordNoteInput = document.getElementById("record-note");
const noteCharacterCount = document.querySelector(".note-character-count");
const hitSlider = document.getElementById("hit-slider");
const hitSliderWrap = document.querySelector(".hit-slider-wrap");
const cameraVideo = document.getElementById("camera-video");
const cameraCanvas = document.getElementById("camera-canvas");
const cameraPreview = document.querySelector(".camera-preview");
const cameraFlashOverlay = document.querySelector(".camera-flash-overlay");
const zoomSlider = document.getElementById("zoom-slider");
const zoomControl = document.querySelector(".zoom-control");
const zoomLabels = document.querySelectorAll(".zoom-labels span");
const notePhoto = document.querySelector(".note-photo");
const flashButton = document.querySelector(".flash-button");
const emotionPhotoPreview = document.querySelector(".emotion-photo-preview");
const emotionCaptionPreview = document.querySelector(".emotion-caption-preview");
const emotionStaff = document.querySelector(".emotion-staff");
const emotionDoneButton = document.querySelector(".emotion-done-button");
const playlistTitleInput = document.getElementById("playlist-title");
const playlistIntroInput = document.querySelector(".playlist-intro-input");
const archiveMonthTitle = document.getElementById("archive-month-title");
const archiveMonthScreen = document.getElementById("archive-month-screen");
const archiveMonthCarousel = document.getElementById("archive-month-carousel");
const archiveMonthPlaylistTitle = document.getElementById("archive-month-playlist-title");
const archiveMonthPlaylistDesc = document.getElementById("archive-month-playlist-desc");
const archiveDetailTitle = document.getElementById("archive-detail-title");
const archiveDetailCarousel = document.getElementById("archive-detail-carousel");
const archiveDetailName = document.getElementById("archive-detail-name");
const trackLogModal = document.getElementById("track-log-modal");
const trackLogDate = document.getElementById("track-log-date");
const trackLogPhoto = document.getElementById("track-log-photo");
const trackLogCaption = document.getElementById("track-log-caption");
const playerNavButton = document.querySelector(".player-nav-button");
const playerDate = document.getElementById("player-date");
const playerStatus = document.getElementById("player-status");
const playerTitle = document.getElementById("player-title");
const playerLogPhoto = document.getElementById("player-log-photo");
const playerLogCaption = document.getElementById("player-log-caption");
const playerRecordBoard = document.querySelector(".player-record-board");
const playerPlayButton = document.querySelector(".player-play");
let cameraStream = null;
let cameraFacingMode = "environment";
let activeCameraIsFront = false;
let flashEnabled = false;
let capturedPhotoDataUrl = "";
let isRetakingPhoto = false;
const MAX_CAPTION_LENGTH = 48;
const MAX_EMOTION_SELECTIONS = 9;
let selectedMoodNotes = [];
let selectedMoodEmotions = [];

// --- Supabase / Spotify 로그인 ---
const PMM = window.PMM_CONFIG || {};
const supabaseConfigured =
  Boolean(window.supabase) &&
  Boolean(PMM.SUPABASE_URL) &&
  Boolean(PMM.SUPABASE_ANON_KEY) &&
  !PMM.SUPABASE_ANON_KEY.startsWith("PASTE_");
const sb = supabaseConfigured
  ? window.supabase.createClient(PMM.SUPABASE_URL, PMM.SUPABASE_ANON_KEY)
  : null;

async function loginWithSpotify() {
  // Supabase 미설정(예: anon key 미입력) 시엔 프로토타입처럼 화면만 넘긴다.
  if (!sb) {
    console.warn("Supabase 미설정: 프로토타입 모드로 다음 화면으로 넘어갑니다. config.js에 anon key를 넣으세요.");
    showScreen(currentIndex + 1);
    return;
  }
  // 테스트용: DEV_MODE면 Spotify 대신 익명 로그인으로 즉시 세션 생성.
  if (PMM.DEV_MODE) {
    const { error } = await sb.auth.signInAnonymously();
    // 로그인 안 하고 온보딩 페이지 확인하고 싶을 때
    //  showScreen(screens.indexOf("name-screen"));
    //  return;
    if (error) {
      console.error("익명 로그인 실패:", error.message);
      alert("익명 로그인 실패: " + error.message + "\n(Supabase → Authentication에서 Anonymous sign-ins를 켜야 해요)");
      return;
    }
    // 익명 로그인은 실제 Spotify 토큰이 없어서 initSpotifyPlayerIfPossible()가 조용히 스킵됨.
    initSpotifyPlayerIfPossible();
    showScreen(screens.indexOf("name-screen"));
    return;
  }
  const { error } = await sb.auth.signInWithOAuth({
    provider: "spotify",
    options: {
      scopes: PMM.SPOTIFY_SCOPES,
      redirectTo: window.location.origin + window.location.pathname,
    },
  });
  if (error) {
    console.error("Spotify 로그인 실패:", error.message);
    alert("Spotify 로그인에 실패했어요: " + error.message);
  }
  // 성공 시 브라우저가 Spotify로 리다이렉트되고, 돌아오면 initAuth()가 세션을 감지한다.
}

async function logout() {
  if (spotifyPlayer) {
    spotifyPlayer.disconnect();
    spotifyPlayer = null;
  }
  spotifyDeviceId = null;
  spotifyReady = false;
  spotifyPlaybackStarted = false;
  spotifyIsPremium = null;
  currentTrackUris = [];
  currentTrackSpotifyUrls = [];
  currentTrackPlaybackIndexes = [];
  currentPlaybackLogs = [];
  pendingPlaybackIndex = null;
  pendingPlayerStartLogIndex = null;
  pendingPlayerAutoPlay = false;
  currentTrackLogs = [];
  hasTodayPlaylist = false;
  logs.length = 0;
  activeMonthPlaylists = [];
  activeArchivePlaylistIndex = 0;
  activePlayerDate = null;
  pendingNote = "";
  capturedPhotoDataUrl = "";
  selectedMoodNotes = [];
  selectedMoodEmotions = [];
  if (sb) await sb.auth.signOut();
  showScreen(screens.indexOf("login-screen"));
}

async function initAuth() {
  if (!sb) return;
  // OAuth 리다이렉트로 돌아오면 supabase-js가 URL에서 세션을 자동 복원한다(detectSessionInUrl 기본값).
  const { data } = await sb.auth.getSession();
  if (data.session) {
    initSpotifyPlayerIfPossible();
    const { data: profile } = await sb
      .from("profiles")
      .select("onboarding_completed_at")
      .eq("id", data.session.user.id)
      .maybeSingle();
    showScreen(screens.indexOf(profile?.onboarding_completed_at ? "record-home-screen" : "name-screen"));
  }
}

// --- Spotify Web Playback SDK ---
function showPlayerStatus(message, type = "info", timeout = 7000) {
  if (!playerStatus) return;
  if (playerStatusTimer) clearTimeout(playerStatusTimer);
  playerStatus.textContent = message;
  playerStatus.dataset.type = type;
  playerStatus.hidden = false;
  playerStatusTimer = timeout
    ? setTimeout(() => {
        playerStatus.hidden = true;
        playerStatusTimer = null;
      }, timeout)
    : null;
}

function activateSpotifyForMobileGesture() {
  if (!spotifyPlayer?.activateElement) return;
  spotifyPlayer.activateElement().catch((error) => {
    console.warn("Spotify 모바일 미디어 활성화 실패:", error);
    showPlayerStatus("모바일 재생 권한을 활성화하지 못했어요. 재생 버튼을 다시 눌러주세요.", "error");
  });
}

function trackIdFromSpotifyUrl(url) {
  const match = (url || "").match(/track[/:]([A-Za-z0-9]+)/);
  return match ? match[1] : null;
}

async function getSpotifyAccessToken() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.provider_token || null;
}

async function refreshSpotifyPremiumStatus(token = null) {
  const accessToken = token || await getSpotifyAccessToken();
  if (!accessToken) {
    spotifyIsPremium = false;
    return spotifyIsPremium;
  }
  try {
    const response = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      if (response.status === 401) {
        spotifyIsPremium = null;
        showPlayerStatus("Spotify 로그인이 만료됐어요. 로그아웃한 뒤 Spotify로 다시 로그인해주세요.", "error", 0);
      } else {
        showPlayerStatus(`Spotify 계정 확인에 실패했어요. (${response.status})`, "error");
      }
      return spotifyIsPremium;
    }
    const profile = await response.json();
    spotifyIsPremium = profile.product === "premium";
    return spotifyIsPremium;
  } catch (error) {
    console.warn("Spotify 계정 등급 확인 실패:", error);
    return spotifyIsPremium;
  }
}

function openTrackInSpotify(index) {
  const url = currentTrackSpotifyUrls[index];
  if (!url) {
    console.warn("Spotify로 이동할 곡 URL이 없습니다.");
    return;
  }
  window.location.assign(url);
}

window.onSpotifyWebPlaybackSDKReady = () => {
  spotifyReady = true;
  initSpotifyPlayerIfPossible();
};

async function initSpotifyPlayerIfPossible() {
  if (!spotifyReady || spotifyPlayer || !window.Spotify) return;
  const token = await getSpotifyAccessToken();
  // DEV_MODE 익명 로그인 등 실제 Spotify OAuth 토큰이 없으면 재생 기능은 조용히 비활성.
  if (!token) return;
  await refreshSpotifyPremiumStatus(token);
  // 무료 계정은 Web Playback SDK 대신 곡 클릭 시 Spotify 곡 페이지로 이동한다.
  if (spotifyIsPremium === false) return;

  spotifyPlayer = new window.Spotify.Player({
    name: "Play My Mood",
    getOAuthToken: async (callback) => {
      // 주의: Supabase는 자체 세션(JWT) 갱신 시 provider_token(스포티파이 access token)을
      // 함께 갱신해주지 않는다. 토큰은 로그인 직후 ~1시간 동안만 유효하며, 만료되면
      // 재생을 위해 다시 로그인해야 한다(서버 쪽 refresh 프록시는 아직 없음).
      const freshToken = await getSpotifyAccessToken();
      callback(freshToken || token);
    },
    volume: 0.8,
  });

  spotifyPlayer.addListener("ready", ({ device_id }) => {
    spotifyDeviceId = device_id;
    console.log("Spotify 플레이어 준비 완료, device_id =", device_id);
    showPlayerStatus("Spotify 연결 완료. 재생 버튼을 눌러주세요.", "info", 3000);
    if (pendingPlaybackIndex !== null && currentTrackUris.length) {
      const startIndex = pendingPlaybackIndex;
      pendingPlaybackIndex = null;
      startSpotifyPlaybackAt(startIndex);
    }
  });
  spotifyPlayer.addListener("not_ready", () => {
    spotifyDeviceId = null;
    showPlayerStatus("Spotify 연결이 끊겼어요. 오른쪽 위 새로고침 버튼을 눌러주세요.", "error", 0);
  });
  spotifyPlayer.addListener("initialization_error", ({ message }) => {
    console.error("Spotify 초기화 실패:", message);
    showPlayerStatus(`이 모바일 브라우저에서 Spotify 재생을 초기화하지 못했어요. ${message}`, "error", 0);
  });
  spotifyPlayer.addListener("authentication_error", ({ message }) => {
    console.error("Spotify 인증 실패:", message);
    showPlayerStatus("Spotify 로그인이 만료됐어요. 로그아웃한 뒤 다시 로그인해주세요.", "error", 0);
  });
  spotifyPlayer.addListener("account_error", ({ message }) => {
    spotifyIsPremium = false;
    console.error("Spotify 계정 오류(Premium 계정이 아니면 재생 불가):", message);
    showPlayerStatus("앱 안에서 재생하려면 Spotify Premium 계정이 필요해요.", "error", 0);
    if (pendingPlaybackIndex !== null) {
      const fallbackIndex = pendingPlaybackIndex;
      pendingPlaybackIndex = null;
      openTrackInSpotify(fallbackIndex);
    }
  });
  spotifyPlayer.addListener("autoplay_failed", () => {
    console.warn("Spotify 자동 재생이 모바일 브라우저에서 차단됨");
    showPlayerStatus("모바일 브라우저가 자동 재생을 막았어요. 아래 재생 버튼을 한 번 더 눌러주세요.", "error", 0);
    setPlayerPlaying(false);
  });
  spotifyPlayer.addListener("playback_error", ({ message }) => {
    console.error("Spotify 재생 오류:", message, "새로고침을 눌러주세요");
    showPlayerStatus(`Spotify 재생 오류: ${message} 새로고침을 눌러주세요`, "error", 0);
    setPlayerPlaying(false);
  });
  spotifyPlayer.addListener("player_state_changed", (state) => {
    if (!state) return;
    const currentUri = state.track_window?.current_track?.uri;
    const playingIndex = currentTrackUris.indexOf(currentUri);
    if (playingIndex >= 0 && !state.paused) {
      currentTrackIndex = playingIndex;
      // 기기 이전 중 전달되는 이전 곡의 paused 상태가 사용자가 방금 고른
      // 폴라로이드를 다시 덮어쓰지 않게, 실제 재생 상태에서만 동기화한다.
      syncPlayerLogToPlaybackIndex(playingIndex);
      document.querySelectorAll("#playlist-player-screen .player-track").forEach((row) => {
        row.classList.toggle("current", Number(row.dataset.playbackIndex) === playingIndex);
      });
    }
    const reachedPlaylistEnd =
      state.paused &&
      state.position === 0 &&
      currentTrackIndex === currentTrackUris.length - 1 &&
      !(state.track_window?.next_tracks?.length);
    if (!state.paused) spotifyPlaybackStarted = true;
    else if (reachedPlaylistEnd) spotifyPlaybackStarted = false;
    setPlayerPlaying(!state.paused);
  });

  const connected = await spotifyPlayer.connect();
  if (!connected) {
    showPlayerStatus("Spotify 재생 기기에 연결하지 못했어요. 새로고침 버튼을 눌러 다시 연결해주세요.", "error", 0);
  }
}

async function transferPlaybackToThisDevice(token) {
  // 재생 전에 Spotify Connect가 이 기기를 "활성 기기"로 인식하도록 명시적으로 이전 요청.
  // (핸드폰/데스크톱 앱 등 다른 기기가 이미 활성 상태면 곧바로 play를 걸었을 때
  //  "Restriction violated" 403이 나는 경우가 있어서 이 단계가 필요함)
  const response = await fetch("https://api.spotify.com/v1/me/player", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ device_ids: [spotifyDeviceId], play: false }),
  });
  if (response.ok) {
    console.log(`[기기 이전] 성공 (status=${response.status})`);
  } else {
    const body = await response.text().catch(() => "");
    console.warn(`[기기 이전] 실패 (status=${response.status}): ${body}`);
  }
  return response.ok;
}

async function playSpotifyTrackAt(index, attemptedIndexes = new Set()) {
  if (!spotifyDeviceId) {
    console.warn("재생 불가: Spotify 기기(device_id)가 아직 준비되지 않음 (ready 이벤트 대기 중이거나 Premium 계정이 아닐 수 있음)");
    showPlayerStatus("Spotify 재생 기기가 아직 준비되지 않았어요. 새로고침 버튼을 누른 뒤 다시 시도해주세요.", "error", 0);
    return;
  }
  if (!currentTrackUris.length) {
    console.warn("재생 불가: 이 날짜에 Spotify 트랙 URI가 없음 (tracks.spotify_url이 비어있을 수 있음)");
    showPlayerStatus("이 플레이리스트에 재생 가능한 Spotify 곡 주소가 없어요.", "error", 0);
    return;
  }
  const token = await getSpotifyAccessToken();
  if (!token) {
    console.warn("재생 불가: Spotify access token 없음 (DEV_MODE 익명 로그인이거나 세션에 provider_token이 없음)");
    showPlayerStatus("Spotify 로그인 정보가 없어요. 로그아웃한 뒤 다시 로그인해주세요.", "error", 0);
    return;
  }
  currentTrackIndex = ((index % currentTrackUris.length) + currentTrackUris.length) % currentTrackUris.length;
  attemptedIndexes.add(currentTrackIndex);
  const uris = currentTrackUris.slice(currentTrackIndex);
  console.log("[재생 시도] uris =", uris);
  await transferPlaybackToThisDevice(token);
  await new Promise((resolve) => setTimeout(resolve, 300));

  // ready 직후엔 Spotify 서버가 아직 이 device_id를 재생 가능 기기로 인식하기 전이라
  // 404(Device not found)가 잠깐 날 수 있다 — 짧게 텀을 두고 몇 번 재시도.
  const delays = [0, 400, 800, 1500];
  let lastError = null;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const response = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyDeviceId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      // 선택한 곡부터 마지막 곡까지 한 번에 전달해 Spotify가 자동으로 다음 곡을 재생하게 한다.
      body: JSON.stringify({ uris }),
    });
    if (response.ok) {
      console.log("[재생 성공]");
      showPlayerStatus("재생을 시작했어요.", "info", 2500);
      return;
    }
    const body = await response.text().catch(() => "");
    lastError = { status: response.status, body };
    if (response.status !== 404) break; // 404(기기 미등록)만 재시도, 그 외 에러는 바로 표시.
  }
  console.error(
    `Spotify 재생 API 실패 (status=${lastError.status}): ${lastError.body}` +
      (lastError.status === 403
        ? " → 현재 곡 또는 재생 기기에 Spotify 제한이 적용됐을 수 있음"
        : lastError.status === 404
          ? " → device_id가 계속 인식되지 않음. 탭을 새로고침해서 SDK를 다시 연결해보세요"
          : ""),
  );
  const isRestrictionViolation =
    lastError.status === 403 && /restriction violated/i.test(lastError.body || "");
  if (isRestrictionViolation && attemptedIndexes.size < currentTrackUris.length) {
    let nextIndex = (currentTrackIndex + 1) % currentTrackUris.length;
    while (attemptedIndexes.has(nextIndex)) {
      nextIndex = (nextIndex + 1) % currentTrackUris.length;
    }
    showPlayerStatus(
      "이 곡은 현재 계정에서 재생할 수 없어 다음 곡으로 넘어갈게요.",
      "error",
      3000,
    );
    setPlayerPlaying(false);
    return playSpotifyTrackAt(nextIndex, attemptedIndexes);
  }
  const failureMessage =
    lastError.status === 401
      ? "Spotify 로그인이 만료됐어요. 로그아웃한 뒤 다시 로그인해주세요."
      : isRestrictionViolation
        ? "이 플레이리스트에서 현재 계정으로 재생 가능한 곡을 찾지 못했어요."
        : lastError.status === 403
          ? "Spotify가 이 재생 요청을 허용하지 않았어요. 계정과 기기 상태를 확인해주세요."
        : lastError.status === 404
          ? "Spotify가 이 모바일 기기를 찾지 못했어요. 새로고침 버튼을 누른 뒤 다시 시도해주세요."
          : lastError.status === 429
            ? "Spotify 요청이 너무 많아요. 잠시 후 다시 시도해주세요."
            : `Spotify 재생 요청에 실패했어요. (${lastError.status})`;
  showPlayerStatus(failureMessage, "error", 0);
  setPlayerPlaying(false);
}

async function startSpotifyPlaybackAt(index = 0) {
  if (!currentTrackUris.length) return;
  const normalizedIndex = Math.max(0, Math.min(index, currentTrackUris.length - 1));
  if (spotifyIsPremium === null) await refreshSpotifyPremiumStatus();
  if (spotifyIsPremium === false) {
    openTrackInSpotify(normalizedIndex);
    return;
  }
  if (!spotifyDeviceId) {
    pendingPlaybackIndex = normalizedIndex;
    initSpotifyPlayerIfPossible();
    console.warn("Spotify 플레이어 준비 후 재생을 시작합니다.");
    showPlayerStatus("Spotify 재생 기기에 연결하는 중이에요. 준비되면 재생을 다시 시도합니다.", "info", 5000);
    return;
  }
  pendingPlaybackIndex = null;
  spotifyPlaybackStarted = true;
  setPlayerPlaying(true);
  playSpotifyTrackAt(normalizedIndex).catch((error) => {
    console.error("Spotify 재생 처리 실패:", error);
    showPlayerStatus(`Spotify 재생 처리 중 오류가 발생했어요: ${error.message || error}`, "error", 0);
    spotifyPlaybackStarted = false;
    setPlayerPlaying(false);
  });
}

// --- 온보딩 값 수집 → Supabase 저장 ---
const ERA_VALUES = ["2020s", "2010s", "2000s", "pre_2000s"];

function readSelectedEra() {
  const cards = Array.from(document.querySelectorAll("#era-screen .era-card"));
  const index = cards.findIndex((card) => card.classList.contains("selected"));
  return ERA_VALUES[index] ?? ERA_VALUES[0];
}

function readSelectedGenres() {
  const cards = Array.from(document.querySelectorAll("#genre-screen .genre-card.selected"));
  return cards
    .map((card) => {
      const genreClass = Array.from(card.classList).find(
        (name) => name.startsWith("genre-") && name !== "genre-card",
      );
      return genreClass ? genreClass.replace("genre-", "") : null;
    })
    .filter(Boolean);
}

function readFamePreference() {
  const value = Number(hitSlider?.value ?? 30);
  return Math.round(value) / 100; // 0.00 ~ 1.00
}

async function saveOnboarding() {
  if (!sb) return;
  const { data: sessionData } = await sb.auth.getSession();
  const user = sessionData.session?.user;
  const spotifyAccessToken = sessionData.session?.provider_token || null;
  if (!user) {
    console.warn("온보딩 저장 건너뜀: 로그인 세션 없음");
    return;
  }

  const { error: prefError } = await sb.from("user_preferences").upsert(
    {
      user_id: user.id,
      era: readSelectedEra(),
      genres: readSelectedGenres(),
      fame_preference: readFamePreference(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (prefError) {
    console.error("온보딩 저장 실패(user_preferences):", prefError.message);
    return;
  }

  const { error: profileError } = await sb
    .from("profiles")
    .update({ onboarding_completed_at: new Date().toISOString() })
    .eq("id", user.id);
  if (profileError) {
    console.error("온보딩 완료 표시 실패(profiles):", profileError.message);
  } else {
    console.log("온보딩 저장 완료 ✓");
  }
}

// --- 기록(로그) 저장 → Supabase ---
const EMOTION_VALUES = [
  "행복한", "신나는", "설레는", "기쁜", "뿌듯한", "감동한", "편안한", "후련한",
  "만족한", "짜릿한", "안도감", "그리운", "아련한", "뭉클한", "우울한", "외로운",
  "속상한", "허무한", "피곤한", "짜증난", "화난", "불안한", "괴로운",
];

const EMOTION_NOTE_ASSETS = {
  "기쁜": "./assets/emotions/emotion-joy.png",
  "신나는": "./assets/emotions/emotion-excited.png",
  "행복한": "./assets/emotions/emotion-happy.png",
  "설레는": "./assets/emotions/emotion-flutter.png",
  "뿌듯한": "./assets/emotions/emotion-proud.png",
  "감동한": "./assets/emotions/emotion-touched.png",
  "편안한": "./assets/emotions/emotion-comfortable.png",
  "짜릿한": "./assets/emotions/emotion-relieved.png",
  "만족한": "./assets/emotions/emotion-satisfied.png",
  "화난": "./assets/emotions/emotion-angry.png",
  "짜증난": "./assets/emotions/emotion-annoyed.png",
  "우울한": "./assets/emotions/emotion-depressed.png",
  "불안한": "./assets/emotions/emotion-anxious.png",
  "괴로운": "./assets/emotions/emotion-distressed.png",
  "피곤한": "./assets/emotions/emotion-tired.png",
  "속상한": "./assets/emotions/emotion-hurt.png",
};

function emotionNoteSources(emotions = []) {
  if (!Array.isArray(emotions)) return [];
  return emotions
    .map((emotion) => EMOTION_NOTE_ASSETS[emotion])
    .filter(Boolean)
    .slice(0, MAX_EMOTION_SELECTIONS);
}

function mostSelectedEmotions(dayLogs = [], limit = 4) {
  const counts = new Map();
  let selectionOrder = 0;
  for (const log of dayLogs) {
    const emotions = Array.isArray(log?.emotions) ? log.emotions : [];
    for (const emotion of emotions) {
      if (!EMOTION_NOTE_ASSETS[emotion]) continue;
      const current = counts.get(emotion);
      if (current) current.count += 1;
      else counts.set(emotion, { emotion, count: 1, firstSelected: selectionOrder });
      selectionOrder += 1;
    }
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count || left.firstSelected - right.firstSelected)
    .slice(0, limit);
}

function renderPlayerMoodNotes(dayLogs = []) {
  const hero = document.querySelector("#playlist-player-screen .player-hero");
  if (!hero) return;
  hero.querySelectorAll(".player-note").forEach((note) => note.remove());
  mostSelectedEmotions(dayLogs, 4).forEach(({ emotion, count }, index) => {
    const note = document.createElement("img");
    note.className = `player-note player-note-${index + 1}`;
    note.src = EMOTION_NOTE_ASSETS[emotion];
    note.alt = `${emotion} 감정${count > 1 ? ` ${count}회 선택` : ""}`;
    hero.append(note);
  });
}

function readSelectedEmotions() {
  return selectedMoodEmotions
    .filter((emotion) => EMOTION_VALUES.includes(emotion))
    .slice(0, MAX_EMOTION_SELECTIONS);
}

function dataUrlToBlob(dataUrl) {
  const [meta, base64] = dataUrl.split(",");
  const mime = meta.match(/data:(.*?);/)?.[1] || "image/jpeg";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

async function saveLog({ photo, caption, emotions }) {
  if (!sb) return;
  const { data: sessionData } = await sb.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) {
    console.warn("로그 저장 건너뜀: 로그인 세션 없음");
    return;
  }

  // 사진을 Storage(playmymood 버킷, <user_id>/logs/...)에 업로드.
  if (!photo) {
    console.error("로그 저장 실패: 사진이 없음 (photo_path는 필수)");
    return;
  }
  const path = `${user.id}/logs/${crypto.randomUUID()}.jpg`;
  const { error: uploadError } = await sb.storage
    .from("playmymood")
    .upload(path, dataUrlToBlob(photo), { contentType: "image/jpeg", upsert: false });
  if (uploadError) {
    console.error("사진 업로드 실패:", uploadError.message);
    return;
  }

  const { data: inserted, error: insertError } = await sb
    .from("daily_logs")
    .insert({
      user_id: user.id,
      photo_path: path,
      caption: caption || null,
      emotions,
    })
    .select("id")
    .single();
  if (insertError) {
    console.error("로그 저장 실패(daily_logs):", insertError.message);
    return;
  }
  console.log("로그 저장 완료 ✓");

  // 스티커와 감정 분석이 끝날 때까지 이 저장 작업을 완료 상태로 보지 않는다.
  // 플레이리스트 생성 화면은 아래 요청이 끝난 뒤 최신 sticker_path를 다시 조회한다.
  if (PMM.AGENT_SERVICE_URL && inserted?.id) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180000);
    try {
      const response = await fetch(`${PMM.AGENT_SERVICE_URL}/process-log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ log_id: inserted.id }),
        signal: controller.signal,
      });
      if (response.ok) console.log("에이전트 처리 완료 (situation/스티커 등 채워짐)");
      else console.warn("에이전트 서비스 응답 오류:", response.status);
    } catch (error) {
      console.warn(
        error?.name === "AbortError"
          ? "에이전트 처리가 3분을 넘어 대기를 종료했어요."
          : "에이전트 서비스 호출 실패 (서비스가 안 켜져 있을 수 있음)",
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// --- 플레이리스트 생성 + 편집 화면 렌더 ---
function trackLogProcessing(task) {
  const trackedTask = Promise.resolve(task);
  pendingLogProcessingTasks.add(trackedTask);
  trackedTask.then(
    () => pendingLogProcessingTasks.delete(trackedTask),
    () => pendingLogProcessingTasks.delete(trackedTask),
  );
  return trackedTask;
}

async function waitForPendingLogProcessing() {
  while (pendingLogProcessingTasks.size > 0) {
    await Promise.allSettled([...pendingLogProcessingTasks]);
  }
}

function todayKstDate() {
  // en-CA 로케일 → "YYYY-MM-DD" (daily_logs.log_date 형식)
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function signedUrl(path) {
  // 비공개 버킷이라 조회 시 서명 URL 생성.
  if (!sb || !path) return null;
  const { data } = await sb.storage.from("playmymood").createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

async function ensurePlaylistRow(userId, date) {
  // playlists 행을 미리 만들어둔다(title/description은 나중에 편집 화면에서 채움).
  // upsert는 지정한 컬럼만 갱신하므로 이미 title이 있는 행을 재생성해도 덮어쓰지 않는다.
  const { error } = await sb.from("playlists").upsert(
    {
      user_id: userId,
      playlist_date: date,
      status: "ready",
      generated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,playlist_date" },
  );
  if (error) console.error("playlists 저장 실패:", error.message);
}

async function generatePlaylist() {
  if (!sb) {
    showScreen(screens.indexOf("playlist-edit-screen"));
    return;
  }
  const { data: sessionData } = await sb.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) {
    showScreen(screens.indexOf("playlist-edit-screen"));
    return;
  }

  showScreen(screens.indexOf("playlist-loading-screen"));

  const date = todayKstDate();
  await waitForPendingLogProcessing();
  await ensurePlaylistRow(user.id, date);

  // 서비스에 그날 로그별 추천 곡 생성 요청 (완료까지 대기 — mood_music_agent가 로그마다 돎).
  if (PMM.AGENT_SERVICE_URL) {
    try {
      await fetch(`${PMM.AGENT_SERVICE_URL}/generate-playlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user_id: user.id,
          date,
          spotify_access_token: spotifyAccessToken,
        }),
      });
    } catch (error) {
      console.warn("플리 생성 서비스 호출 실패:", error);
    }
  }

  await renderPlaylistEdit(user.id, date);
  hasTodayPlaylist = true;
  updateTodayPlaylistButton();
  showScreen(screens.indexOf("playlist-edit-screen"));
}

async function renderPlaylistEdit(userId, date = todayKstDate()) {
  if (!sb) return;

  // 이전에 입력해둔 제목/소개(있으면) 미리 채우기.
  const { data: playlistRow } = await sb
    .from("playlists")
    .select("title, description")
    .eq("user_id", userId)
    .eq("playlist_date", date)
    .maybeSingle();
  if (playlistTitleInput && playlistRow?.title) playlistTitleInput.value = playlistRow.title;
  if (playlistIntroInput && playlistRow?.description) playlistIntroInput.value = playlistRow.description;

  const { data: logRows, error } = await sb
    .from("daily_logs")
    .select("id, caption, photo_path, sticker_path, logged_at, emotions, tracks(title, artists)")
    .eq("user_id", userId)
    .eq("log_date", date)
    .order("logged_at");
  if (error) {
    console.error("플리 편집 로드 실패:", error.message);
    return;
  }
  // 플레이리스트 화면에는 실제 추천 트랙이 생성된 로그만 포함한다.
  // 플레이리스트 생성 후 새로 추가된 로그는 tracks가 없으므로 오늘의 기록에만 남는다.
  const dayLogs = (logRows || []).filter((log) => (
    Array.isArray(log.tracks) ? log.tracks.length > 0 : Boolean(log.tracks)
  ));

  const dateEl = document.querySelector("#playlist-edit-screen .playlist-date");
  if (dateEl) dateEl.textContent = formatToday();

  // 트랙 행: 로그 사진(썸네일) + 추천 곡(제목/가수)
  const list = document.querySelector("#playlist-edit-screen .playlist-list");
  currentTrackLogs = [];
  if (list) {
    list.querySelectorAll(".track-row").forEach((row) => row.remove());
    for (let index = 0; index < dayLogs.length; index += 1) {
      const log = dayLogs[index];
      const track = Array.isArray(log.tracks) ? log.tracks[0] : log.tracks;

      const row = document.createElement("div");
      row.className = "track-row";

      const thumb = document.createElement("span");
      thumb.className = "track-thumb";
      const photoUrl = await signedUrl(log.photo_path);
      if (photoUrl) {
        thumb.style.backgroundImage = `url("${photoUrl}")`;
        thumb.style.backgroundSize = "cover";
        thumb.style.backgroundPosition = "center";
      }
      currentTrackLogs[index] = {
        caption: log.caption,
        photo: photoUrl,
        date: formatDisplayDate(date),
        time: formatDisplayTime(log.logged_at),
        moodNotes: emotionNoteSources(log.emotions),
      };

      const info = document.createElement("span");
      const title = track?.title || "추천 곡 준비중";
      const artist = (track?.artists && track.artists[0]) || "";
      info.innerHTML = `${title}<br />${artist}`;

      const more = document.createElement("button");
      more.type = "button";
      more.dataset.action = "open-track-log";
      more.dataset.trackIndex = String(index);
      more.setAttribute("aria-label", "노래 로그 보기");
      more.textContent = "•••";

      row.append(thumb, info, more);
      list.append(row);
    }
  }

  // 케이스 위에 그날 스티커들 오버레이
  await renderStickerCover(document.querySelector("#playlist-edit-screen .cover-square"), dayLogs);
}

function createSeededRandom(seed) {
  let state = 0;
  for (let index = 0; index < seed.length; index += 1) {
    state = (Math.imul(state, 31) + seed.charCodeAt(index)) | 0;
  }
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    return (state >>> 0) / 4294967296;
  };
}

function createStickerLayout(stickerPaths) {
  const count = stickerPaths.length;
  if (count === 0) return [];

  const padding = 5;
  const gap = 4;
  const maxRotation = 14;
  const maxRotationRadians = maxRotation * Math.PI / 180;
  const maxRotatedScale = Math.cos(maxRotationRadians) + Math.sin(maxRotationRadians);
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const cellWidth = (100 - padding * 2) / columns;
  const cellHeight = (100 - padding * 2) / rows;
  const maxWidth = Math.min(38, (Math.min(cellWidth, cellHeight) - gap) / maxRotatedScale);
  const random = createSeededRandom(`${count}:${stickerPaths.join("\u0000")}`);
  const slots = Array.from({ length: columns * rows }, (_, index) => ({
    column: index % columns,
    row: Math.floor(index / columns),
  }));

  for (let index = slots.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [slots[index], slots[swapIndex]] = [slots[swapIndex], slots[index]];
  }

  return stickerPaths.map((_, index) => {
    const slot = slots[index];
    const rotation = -maxRotation + random() * maxRotation * 2;
    const width = maxWidth * (0.9 + random() * 0.1);
    const radians = rotation * Math.PI / 180;
    const rotatedSide = width * (Math.abs(Math.cos(radians)) + Math.abs(Math.sin(radians)));
    const horizontalSlack = Math.max(0, cellWidth - rotatedSide - gap);
    const verticalSlack = Math.max(0, cellHeight - rotatedSide - gap);
    const centerX = padding
      + (slot.column + 0.5) * cellWidth
      + (random() - 0.5) * horizontalSlack;
    const centerY = padding
      + (slot.row + 0.5) * cellHeight
      + (random() - 0.5) * verticalSlack;

    return {
      left: centerX - width / 2,
      top: centerY - width / 2,
      width,
      rotation,
    };
  });
}

// 그날 로그들의 sticker_path를 케이스 위에 고르게 분산해 그린다.
// (플리 편집·완료 화면과 아카이브 커버에서 공용으로 사용)
async function renderStickerCover(coverEl, dayLogs) {
  if (!coverEl) return;
  coverEl.querySelectorAll(".cover-sticker").forEach((sticker) => sticker.remove());
  // 재사용처들은 스타일시트에서 이미 position:absolute라 자식 절대배치 기준이 된다.
  // 여기서 relative로 덮어쓰면 <span>(inline 기본값)의 width/height가 무시돼 찌그러짐.
  coverEl.style.overflow = "hidden";
  const stickers = [];
  for (const log of dayLogs) {
    if (!log.sticker_path) continue;
    const url = await signedUrl(log.sticker_path);
    if (!url) continue;
    stickers.push({ path: log.sticker_path, url });
  }

  const layout = createStickerLayout(stickers.map((sticker) => sticker.path));
  stickers.forEach((sticker, index) => {
    const placement = layout[index];
    const image = document.createElement("img");
    image.className = "cover-sticker";
    image.src = sticker.url;
    image.alt = "";
    image.style.position = "absolute";
    image.style.left = `${placement.left}%`;
    image.style.top = `${placement.top}%`;
    image.style.width = `${placement.width}%`;
    image.style.aspectRatio = "1 / 1";
    image.style.objectFit = "contain";
    image.style.transform = `rotate(${placement.rotation}deg)`;
    coverEl.append(image);
  });
}

async function renderLatestStickerCover(coverEl, userId, date) {
  if (!sb || !coverEl || !userId || !date) return;
  const { data, error } = await sb
    .from("daily_logs")
    .select("sticker_path")
    .eq("user_id", userId)
    .eq("log_date", date)
    .order("logged_at");
  if (error) {
    console.error("스티커 커버 새로고침 실패:", error.message);
    return;
  }
  await renderStickerCover(coverEl, data || []);
}

function formatDisplayDate(isoDate) {
  return (isoDate || "").replaceAll("-", ".");
}

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

function formatCurrentTime() {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}

function updateRecordDates() {
  const today = formatToday();
  for (const dateElement of document.querySelectorAll(".record-date, .playlist-date")) {
    dateElement.textContent = today;
  }
}

function getNearestZoomLabel(value) {
  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const label of zoomLabels) {
    const distance = Math.abs(Number(label.dataset.zoom) - value);
    if (distance < nearestDistance) {
      nearest = label;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function updateCameraPreviewTransform() {
  const zoom = Number(zoomSlider?.value || 1);
  cameraPreview?.classList.toggle("front-camera", activeCameraIsFront);
  if (cameraVideo) {
    cameraVideo.style.setProperty("--camera-mirror-x", activeCameraIsFront ? "-1" : "1");
    cameraVideo.style.setProperty("--camera-zoom", String(zoom));
  }
}

function syncActualCameraFacingMode() {
  const track = cameraStream?.getVideoTracks?.()[0];
  if (!track) return;
  const settings = track.getSettings?.() || {};
  const actualFacingMode = String(settings.facingMode || "").toLowerCase();
  const trackLabel = String(track.label || "").toLowerCase();
  if (actualFacingMode === "user") {
    cameraFacingMode = "user";
    activeCameraIsFront = true;
  } else if (actualFacingMode === "environment") {
    cameraFacingMode = "environment";
    activeCameraIsFront = false;
  } else if (/front|user|facetime/.test(trackLabel)) {
    cameraFacingMode = "user";
    activeCameraIsFront = true;
  } else if (/back|rear|environment/.test(trackLabel)) {
    cameraFacingMode = "environment";
    activeCameraIsFront = false;
  }
  updateCameraPreviewTransform();
}

function applyZoom() {
  updateCameraPreviewTransform();
  if (!zoomSlider) return;
  const zoom = Number(zoomSlider.value || 1);
  const activeLabel = getNearestZoomLabel(zoom);
  for (const label of zoomLabels) {
    label.classList.toggle("active", label === activeLabel);
  }
}

function snapZoomToClosestLabel(clientX) {
  if (!zoomSlider || !zoomControl || !zoomLabels.length) return;
  const rect = zoomControl.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const index = Math.round(ratio * (zoomLabels.length - 1));
  const label = zoomLabels[index];
  zoomSlider.value = label.dataset.zoom;
  applyZoom();
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
  // 스트림을 기다리는 동안에도 전면/후면 방향을 즉시 미리보기에 반영한다.
  activeCameraIsFront = cameraFacingMode === "user";
  updateCameraPreviewTransform();
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cameraFacingMode, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    });
    cameraVideo.srcObject = cameraStream;
    cameraPreview?.classList.add("has-stream");
    await cameraVideo.play();
    syncActualCameraFacingMode();
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
  notePhoto.style.backgroundImage = "none";
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

  // Reproduce the preview's `object-fit: cover` and CSS zoom on the canvas.
  // Cropping the source into a square here used to save areas that were not
  // visible in the 402 × 402 preview.
  const previewWidth = cameraPreview?.clientWidth || DESIGN_WIDTH;
  const previewHeight = cameraPreview?.clientHeight || 402;
  cameraCanvas.width = 1080;
  cameraCanvas.height = Math.round(cameraCanvas.width * (previewHeight / previewWidth));

  const context = cameraCanvas.getContext("2d");
  if (!context) return false;

  const coverScale = Math.max(
    cameraCanvas.width / sourceWidth,
    cameraCanvas.height / sourceHeight,
  );
  const renderedScale = coverScale * zoom;
  const renderedWidth = sourceWidth * renderedScale;
  const renderedHeight = sourceHeight * renderedScale;
  const renderedX = (cameraCanvas.width - renderedWidth) / 2;
  const renderedY = (cameraCanvas.height - renderedHeight) / 2;

  context.fillStyle = "#e9e9e9";
  context.fillRect(0, 0, cameraCanvas.width, cameraCanvas.height);
  if (activeCameraIsFront) {
    // 전면 미리보기와 저장 결과가 동일하도록 캔버스 전체를 중심 기준으로 좌우반전한다.
    context.save();
    context.translate(cameraCanvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(cameraVideo, renderedX, renderedY, renderedWidth, renderedHeight);
    context.restore();
  } else {
    // 후면 카메라는 기존 방향과 크롭을 그대로 유지한다.
    context.drawImage(cameraVideo, renderedX, renderedY, renderedWidth, renderedHeight);
  }
  capturedPhotoDataUrl = cameraCanvas.toDataURL("image/jpeg", 0.9);
  updateCapturedPhotoPreview();
  return true;
}

function capturePhoto() {
  if (flashEnabled) flashPreview();
  const captured = captureCurrentFrame();
  if (!captured) return;
  isRetakingPhoto = false;
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
    emotionCaptionPreview.textContent = pendingNote || "";
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

function getCurrentYearNumber() {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
  }).format(new Date()));
}

function updateArchiveYearLabel() {
  const label = document.getElementById("archive-year-label");
  if (label) label.textContent = String(activeArchiveYear);
}

async function currentUserId() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.user?.id || null;
}

async function loadArchiveMonthCounts() {
  archiveMonthCounts = Array(12).fill(0);
  const userId = await currentUserId();
  if (!userId) return;
  const year = activeArchiveYear;
  const { data, error } = await sb
    .from("playlists")
    .select("playlist_date")
    .eq("user_id", userId)
    .not("title", "is", null)
    .gte("playlist_date", `${year}-01-01`)
    .lte("playlist_date", `${year}-12-31`);
  if (error) {
    console.error("아카이브 개수 조회 실패:", error.message);
    return;
  }
  for (const row of data || []) {
    const month = Number(row.playlist_date.slice(5, 7));
    archiveMonthCounts[month - 1] += 1;
  }
}

function renderArchiveShelves() {
  const shelves = document.querySelectorAll(".archive-shelf");
  shelves.forEach((shelf, monthIndex) => {
    shelf.replaceChildren();
    const count = archiveMonthCounts[monthIndex] || 0;
    shelf.classList.toggle("empty", count === 0);
    const lpWidth = 7;
    const lpHeight = 120;
    const leaningAngle = 7;
    const uprightStep = lpWidth;
    // 7도 회전된 LP의 수직 폭이 정확히 맞닿도록 수평 간격을 보정한다.
    const leaningRadians = (leaningAngle * Math.PI) / 180;
    const leaningGap = lpWidth / Math.cos(leaningRadians);
    // 기울어진 LP의 윗부분이 직립 LP에 닿되 파고들지 않는 최소 여유.
    const leaningClearance = lpHeight * Math.sin(leaningRadians);
    // 직립 LP는 시안처럼 좌우 책장 그림자 위에 일부 겹치고,
    // 중앙의 비스듬한 묶음은 기존 중심 좌표를 유지한다.
    const uprightSideInset = 10;
    const displayCount = Math.min(count, 31);
    for (let index = 0; index < displayCount; index += 1) {
      const lp = document.createElement("span");
      const visualPosition = index + 1;
      lp.className = "archive-lp";
      lp.style.setProperty("--lp-color", ARCHIVE_LP_COLORS[index]);
      lp.style.setProperty(
        "--lp-side-color",
        ARCHIVE_LP_SIDE_COLORS[visualPosition] || ARCHIVE_LP_COLORS[index],
      );

      if (index < 12) {
        // 1~12장: 왼쪽부터 오른쪽으로 직립.
        lp.classList.add("archive-lp-left-upright");
        lp.style.left = `${uprightSideInset + index * uprightStep}px`;
      } else if (index < 18) {
        // 13~18장: 왼쪽 직립 묶음 다음에서 왼쪽 방향으로 기대어 쌓임.
        const leaningIndex = index - 12;
        lp.classList.add("archive-lp-left-leaning");
        lp.style.left = `${
          uprightSideInset
          + 12 * uprightStep
          + leaningClearance
          + leaningIndex * leaningGap
        }px`;
        if (index === Math.min(displayCount, 18) - 1) {
          lp.classList.add("archive-lp-left-edge");
        }
      } else if (index < 22) {
        // 화면 왼쪽부터 19~22장: 오른쪽 직립 묶음에 기대는 비스듬한 LP.
        const leaningIndex = index - 18;
        const leaningCount = Math.min(Math.max(displayCount - 18, 0), 4);
        const rightUprightCount = Math.max(displayCount - 22, 0);
        lp.classList.add("archive-lp-right-leaning");
        lp.style.right = `${
          uprightSideInset
          + rightUprightCount * uprightStep
          + leaningClearance
          + (leaningCount - 1 - leaningIndex) * leaningGap
        }px`;
        if (index === 18) {
          lp.classList.add("archive-lp-right-edge");
        }
      } else {
        // 화면 왼쪽부터 23~30장: 똑바로 선 오른쪽 묶음.
        // 테스트용 31번째 장도 가장 오른쪽에 같은 방식으로 이어진다.
        lp.classList.add("archive-lp-right-upright");
        lp.style.right = `${
          uprightSideInset + (displayCount - 1 - index) * uprightStep
        }px`;
      }

      lp.style.zIndex = String(index + 10);
      shelf.append(lp);
    }
  });
}

async function refreshArchiveShelves() {
  await loadArchiveMonthCounts();
  renderArchiveShelves();
}

function formatArchiveMonth(month) {
  const year = activeArchiveYear;
  return `${year}.${String(month).padStart(2, "0")}`;
}

function selectArchivePlaylist(index) {
  if (!activeMonthPlaylists.length) return;
  const nextIndex = Math.max(0, Math.min(index, activeMonthPlaylists.length - 1));
  const playlist = activeMonthPlaylists[nextIndex];
  activeArchivePlaylistIndex = nextIndex;
  if (archiveMonthPlaylistTitle) {
    archiveMonthPlaylistTitle.textContent = playlist.title || "제목 없는 플리";
  }
  if (archiveMonthPlaylistDesc) {
    archiveMonthPlaylistDesc.textContent = playlist.description || "짧은 소개글이 아직 없어요.";
  }
  archiveMonthCarousel?.querySelectorAll(".archive-album-card").forEach((card, cardIndex) => {
    card.setAttribute("aria-current", cardIndex === nextIndex ? "true" : "false");
  });
}

function centerArchivePlaylistCard(index, behavior = "auto") {
  if (!archiveMonthCarousel) return;
  const cards = Array.from(archiveMonthCarousel.querySelectorAll(".archive-album-card"));
  const card = cards[index];
  if (!card) return;
  const left = card.offsetLeft + card.offsetWidth / 2 - archiveMonthCarousel.clientWidth / 2;
  archiveMonthCarousel.scrollTo({ left, behavior });
}

function syncArchivePlaylistToCarousel() {
  if (!archiveMonthCarousel || !activeMonthPlaylists.length) return;
  const cards = Array.from(archiveMonthCarousel.querySelectorAll(".archive-album-card"));
  if (!cards.length) return;
  const carouselCenter = archiveMonthCarousel.scrollLeft + archiveMonthCarousel.clientWidth / 2;
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  cards.forEach((card, index) => {
    const cardCenter = card.offsetLeft + card.offsetWidth / 2;
    const distance = Math.abs(cardCenter - carouselCenter);
    if (distance < closestDistance) {
      closestIndex = index;
      closestDistance = distance;
    }
  });
  selectArchivePlaylist(closestIndex);
}

async function renderArchiveMonthView(month = activeArchiveMonth) {
  activeArchiveMonth = month;
  activeArchivePlaylistIndex = 0;
  if (archiveMonthTitle) archiveMonthTitle.textContent = formatArchiveMonth(month);
  archiveMonthCarousel?.replaceChildren();
  activeMonthPlaylists = [];

  const userId = await currentUserId();
  if (!userId) return;

  const year = activeArchiveYear;
  const monthStr = String(month).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();
  const { data, error } = await sb
    .from("playlists")
    .select("id, playlist_date, title, description")
    .eq("user_id", userId)
    .not("title", "is", null)
    .gte("playlist_date", `${year}-${monthStr}-01`)
    .lte("playlist_date", `${year}-${monthStr}-${String(lastDay).padStart(2, "0")}`)
    .order("playlist_date");
  if (error) {
    console.error("월별 플리 조회 실패:", error.message);
    return;
  }
  activeMonthPlaylists = data || [];

  if (!activeMonthPlaylists.length) {
    const empty = document.createElement("p");
    empty.className = "archive-empty-message";
    empty.textContent = "아직 만든 플리가 없어요";
    archiveMonthCarousel?.append(empty);
    if (archiveMonthPlaylistTitle) archiveMonthPlaylistTitle.textContent = "";
    if (archiveMonthPlaylistDesc) archiveMonthPlaylistDesc.textContent = "";
    return;
  }

  activeMonthPlaylists.forEach((playlist, index) => {
    const card = document.createElement("button");
    card.className = "archive-album-card";
    card.type = "button";
    card.dataset.action = "open-archive-detail";
    card.dataset.index = String(index);
    card.innerHTML = `<span class="archive-album-date">${formatDisplayDate(playlist.playlist_date)}</span><span class="archive-album-cover"></span>`;
    archiveMonthCarousel?.append(card);
  });

  const today = todayKstDate();
  const todayIndex = activeMonthPlaylists.findIndex((playlist) => playlist.playlist_date === today);
  const initialIndex = todayIndex >= 0 ? todayIndex : activeMonthPlaylists.length - 1;
  selectArchivePlaylist(initialIndex);
  requestAnimationFrame(() => {
    centerArchivePlaylistCard(initialIndex);
  });

  // 상세 화면과 동일하게 그날의 모든 스티커를 카드별 커버에 배치한다.
  const cards = archiveMonthCarousel ? Array.from(archiveMonthCarousel.querySelectorAll(".archive-album-card")) : [];
  await Promise.all(
    activeMonthPlaylists.map(async (playlist, index) => {
      const coverEl = cards[index]?.querySelector(".archive-album-cover");
      if (!coverEl) return;
      await renderLatestStickerCover(coverEl, userId, playlist.playlist_date);
    }),
  );
}

function getActiveArchivePlaylistRow() {
  return activeMonthPlaylists[activeArchivePlaylistIndex] || null;
}

function selectArchiveDetailPlaylist(index) {
  if (!activeMonthPlaylists.length) return;
  activeArchivePlaylistIndex = Math.max(0, Math.min(index, activeMonthPlaylists.length - 1));
  archiveDetailCarousel?.querySelectorAll(".archive-detail-cover-card").forEach((card, cardIndex) => {
    card.setAttribute("aria-current", cardIndex === activeArchivePlaylistIndex ? "true" : "false");
  });
}

function centerArchiveDetailCard(index, behavior = "auto") {
  if (!archiveDetailCarousel) return;
  const cards = Array.from(archiveDetailCarousel.querySelectorAll(".archive-detail-cover-card"));
  const card = cards[index];
  if (!card) return;
  const left = card.offsetLeft + card.offsetWidth / 2 - archiveDetailCarousel.clientWidth / 2;
  archiveDetailCarousel.scrollTo({ left, behavior });
}

function syncArchiveDetailToCarousel() {
  if (!archiveDetailCarousel || !activeMonthPlaylists.length) return;
  const cards = Array.from(archiveDetailCarousel.querySelectorAll(".archive-detail-cover-card"));
  if (!cards.length) return;
  const carouselCenter = archiveDetailCarousel.scrollLeft + archiveDetailCarousel.clientWidth / 2;
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  cards.forEach((card, index) => {
    const cardCenter = card.offsetLeft + card.offsetWidth / 2;
    const distance = Math.abs(cardCenter - carouselCenter);
    if (distance < closestDistance) {
      closestIndex = index;
      closestDistance = distance;
    }
  });
  if (closestIndex !== activeArchivePlaylistIndex) {
    renderArchivePlaylistDetail(closestIndex, { rebuildCarousel: false, center: false });
  }
}

function buildArchiveDetailCarousel() {
  if (!archiveDetailCarousel) return;
  archiveDetailCarousel.replaceChildren();
  activeMonthPlaylists.forEach((playlist, index) => {
    const card = document.createElement("button");
    card.className = "archive-detail-cover-card";
    card.type = "button";
    card.dataset.archiveIndex = String(index);
    card.setAttribute("aria-label", `${formatDisplayDate(playlist.playlist_date)} 플레이리스트`);

    const date = document.createElement("span");
    date.className = "archive-detail-date";
    date.textContent = formatDisplayDate(playlist.playlist_date);

    const cover = document.createElement("span");
    cover.className = "archive-detail-cover";
    const square = document.createElement("span");
    square.className = "archive-detail-square";
    const record = document.createElement("img");
    record.className = "archive-detail-record";
    record.src = "./assets/playlist/playlist-record.png";
    record.alt = "";

    cover.append(square, record);
    card.append(date, cover);
    archiveDetailCarousel.append(card);
  });
  selectArchiveDetailPlaylist(activeArchivePlaylistIndex);
}

async function hydrateArchiveDetailCovers(userId) {
  if (!sb || !archiveDetailCarousel || !userId) return;
  const cards = Array.from(archiveDetailCarousel.querySelectorAll(".archive-detail-cover-card"));
  await Promise.all(
    activeMonthPlaylists.map(async (playlist, index) => {
      const card = cards[index];
      const square = card?.querySelector(".archive-detail-square");
      if (!square) return;
      const { data, error } = await sb
        .from("daily_logs")
        .select("sticker_path")
        .eq("user_id", userId)
        .eq("log_date", playlist.playlist_date)
        .order("logged_at");
      if (error) {
        console.error("상세 캐러셀 커버 로드 실패:", error.message);
        return;
      }
      if (card.isConnected) await renderStickerCover(square, data || []);
    }),
  );
}

async function renderArchivePlaylistDetail(index = activeArchivePlaylistIndex, options = {}) {
  if (!activeMonthPlaylists.length) return;
  selectArchiveDetailPlaylist(index);
  const renderToken = ++archiveDetailRenderToken;
  const playlist = getActiveArchivePlaylistRow();
  if (archiveDetailTitle) archiveDetailTitle.textContent = formatArchiveMonth(activeArchiveMonth);

  const tracksSection = document.querySelector("#archive-playlist-detail-screen .archive-detail-tracks");
  tracksSection?.querySelectorAll(".archive-detail-track").forEach((row) => row.remove());

  if (!playlist) {
    if (archiveDetailName) archiveDetailName.textContent = "";
    return;
  }
  if (archiveDetailName) archiveDetailName.textContent = playlist.title || "제목 없는 플리";

  const userId = await currentUserId();
  if (!userId) return;

  const cardCount = archiveDetailCarousel?.querySelectorAll(".archive-detail-cover-card").length || 0;
  if (options.rebuildCarousel !== false || cardCount !== activeMonthPlaylists.length) {
    buildArchiveDetailCarousel();
    hydrateArchiveDetailCovers(userId).catch((error) =>
      console.error("상세 캐러셀 커버 표시 실패:", error),
    );
  } else {
    selectArchiveDetailPlaylist(activeArchivePlaylistIndex);
  }
  if (options.center !== false) {
    requestAnimationFrame(() => centerArchiveDetailCard(activeArchivePlaylistIndex));
  }

  const { data: dayLogs, error } = await sb
    .from("daily_logs")
    .select("id, caption, photo_path, sticker_path, logged_at, emotions, tracks(title, artists, spotify_url)")
    .eq("user_id", userId)
    .eq("log_date", playlist.playlist_date)
    .order("logged_at");
  if (error) {
    console.error("아카이브 상세 로드 실패:", error.message);
    return;
  }
  if (renderToken !== archiveDetailRenderToken) return;

  const activeCard = archiveDetailCarousel?.querySelector(
    `.archive-detail-cover-card[data-archive-index="${activeArchivePlaylistIndex}"]`,
  );
  await renderStickerCover(activeCard?.querySelector(".archive-detail-square"), dayLogs || []);
  if (renderToken !== archiveDetailRenderToken) return;

  const nextTrackLogs = [];
  const trackRows = [];
  if (tracksSection) {
    for (let index = 0; index < (dayLogs || []).length; index += 1) {
      const log = dayLogs[index];
      const track = Array.isArray(log.tracks) ? log.tracks[0] : log.tracks;
      const row = document.createElement("div");
      row.className = "archive-detail-track";
      row.dataset.action = "play-archive-track";
      row.dataset.trackIndex = String(index);
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      const thumb = document.createElement("span");
      const photoUrl = await signedUrl(log.photo_path);
      if (renderToken !== archiveDetailRenderToken) return;
      if (photoUrl) {
        thumb.style.backgroundImage = `url("${photoUrl}")`;
        thumb.style.backgroundSize = "cover";
        thumb.style.backgroundPosition = "center";
      }
      const info = document.createElement("p");
      const title = track?.title || "추천 곡 준비중";
      const artist = (track?.artists && track.artists[0]) || "";
      info.innerHTML = `${title}<br />${artist}`;
      nextTrackLogs[index] = {
        caption: log.caption,
        photo: photoUrl,
        date: formatDisplayDate(playlist.playlist_date),
        time: formatDisplayTime(log.logged_at),
        moodNotes: emotionNoteSources(log.emotions),
      };

      const more = document.createElement("button");
      more.type = "button";
      more.className = "archive-track-more";
      more.dataset.action = "open-track-log";
      more.dataset.trackIndex = String(index);
      more.setAttribute("aria-label", `${title} 로그 보기`);
      more.textContent = "•••";

      row.append(thumb, info, more);
      trackRows.push(row);
    }
    if (renderToken !== archiveDetailRenderToken) return;
    currentTrackLogs = nextTrackLogs;
    tracksSection.append(...trackRows);
  }
}

function setPlayerPlaying(isPlaying) {
  isPlayerPlaying = isPlaying;
  playerRecordBoard?.classList.toggle("is-playing", isPlayerPlaying);
  playerPlayButton?.classList.toggle("is-playing", isPlayerPlaying);
  playerPlayButton?.setAttribute("aria-label", isPlayerPlaying ? "일시정지" : "재생");
}

function renderPlayerLogData(log) {
  // 클릭 시점의 실제 플레이어 DOM을 다시 조회한다. 썸네일과 동일한 signed URL을
  // background-image에 직접 적용해 이전 <img>가 남거나 다른 화면 참조가 섞이지 않게 한다.
  const photoElement = document.querySelector("#playlist-player-screen #player-log-photo");
  const captionElement = document.querySelector("#playlist-player-screen #player-log-caption");
  if (photoElement) {
    photoElement.replaceChildren();
    photoElement.classList.toggle("has-photo", Boolean(log?.photo));
    photoElement.style.backgroundImage = log?.photo ? `url("${log.photo}")` : "none";
    photoElement.style.backgroundSize = "cover";
    photoElement.style.backgroundPosition = "center";
    photoElement.dataset.logPhoto = log?.photo || "";
  }
  if (captionElement) {
    captionElement.textContent = log ? log.caption || "" : "아직 이 노래와 연결된 로그가 없어요";
  }
}

function renderPlayerLogPolaroid(logIndex = 0) {
  renderPlayerLogData(currentTrackLogs[logIndex]);
}

function syncPlayerLogToPlaybackIndex(playbackIndex) {
  const log = currentPlaybackLogs[playbackIndex];
  if (log) renderPlayerLogData(log);
}

function activatePlayerTrack(logIndex, playbackIndex, selectedLog = currentTrackLogs[logIndex]) {
  // 모바일 브라우저는 재생 호출 전에 사용자 탭 경로에서 미디어 요소를 활성화해야 한다.
  activateSpotifyForMobileGesture();
  if (Number.isInteger(logIndex) && logIndex >= 0) {
    // 행이 생성될 때 캡처한 로그 객체를 직접 사용한다. 다른 비동기 화면이
    // currentTrackLogs를 갱신하더라도 사용자가 누른 사진/캡션이 정확히 표시된다.
    renderPlayerLogData(selectedLog);
    document.querySelectorAll("#playlist-player-screen .player-track").forEach((row) => {
      row.classList.toggle("current", Number(row.dataset.trackIndex) === logIndex);
    });
  }
  if (Number.isInteger(playbackIndex) && playbackIndex >= 0) {
    startSpotifyPlaybackAt(playbackIndex);
  } else {
    console.warn("재생할 Spotify 트랙 URL이 없습니다.");
  }
}

async function renderPlaylistPlayer() {
  const isHomeEntry = playerEntryMode === "home";
  if (playerNavButton) {
    playerNavButton.classList.toggle("home-mode", isHomeEntry);
    playerNavButton.textContent = isHomeEntry ? "" : "←";
    playerNavButton.setAttribute("aria-label", isHomeEntry ? "홈으로 돌아가기" : "뒤로");
  }
  // 이전에 재생 중이던 게 있으면 멈춰서, 리셋되는 UI 상태(재생 안 함)와 실제 재생 상태를 맞춘다.
  spotifyPlayer?.pause().catch(() => {});
  spotifyPlaybackStarted = false;
  pendingPlaybackIndex = null;
  currentTrackIndex = 0;
  setPlayerPlaying(false);

  const date = activePlayerDate || todayKstDate();
  if (playerDate) playerDate.textContent = formatDisplayDate(date);
  if (playerTitle) playerTitle.textContent = "";

  const userId = await currentUserId();
  if (userId) {
    const { data: playlistRow } = await sb
      .from("playlists")
      .select("title")
      .eq("user_id", userId)
      .eq("playlist_date", date)
      .maybeSingle();
    if (playerTitle) playerTitle.textContent = playlistRow?.title || "제목 없는 플리";
  }

  await renderPlayerTracks(date);
  if (pendingPlayerAutoPlay) {
    const requestedLogIndex = pendingPlayerStartLogIndex ?? 0;
    const requestedPlaybackIndex = currentTrackPlaybackIndexes[requestedLogIndex];
    pendingPlayerAutoPlay = false;
    pendingPlayerStartLogIndex = null;
    startSpotifyPlaybackAt(requestedPlaybackIndex >= 0 ? requestedPlaybackIndex : 0);
  }
}

async function refreshPlaylistPlayer(button) {
  if (button?.disabled) return;
  // 첫 await 전에 호출해야 iOS가 이 탭을 실제 사용자 미디어 동작으로 인정한다.
  activateSpotifyForMobileGesture();
  if (button) {
    button.disabled = true;
    button.classList.add("refreshing");
  }
  pendingPlayerAutoPlay = false;
  pendingPlayerStartLogIndex = null;
  showPlayerStatus("플레이리스트와 Spotify 재생 기기를 다시 연결하는 중이에요.", "info", 0);
  try {
    await renderPlaylistPlayer();
    const token = await getSpotifyAccessToken();
    if (!token) {
      showPlayerStatus("Spotify 로그인 정보가 없거나 만료됐어요. 로그아웃한 뒤 다시 로그인해주세요.", "error", 0);
      return;
    }
    const premium = await refreshSpotifyPremiumStatus(token);
    if (premium === false) {
      showPlayerStatus("앱 안에서 재생하려면 Spotify Premium 계정이 필요해요.", "error", 0);
      return;
    }
    if (premium !== true) return;

    if (spotifyPlayer) {
      spotifyDeviceId = null;
      spotifyPlaybackStarted = false;
      spotifyPlayer.disconnect();
      const connected = await spotifyPlayer.connect();
      if (!connected) {
        showPlayerStatus("Spotify 기기 재연결에 실패했어요. 로그아웃 후 다시 로그인해보세요.", "error", 0);
      } else {
        showPlayerStatus("Spotify 기기를 다시 연결하고 있어요. 연결 완료 후 재생 버튼을 눌러주세요.", "info", 5000);
      }
    } else {
      await initSpotifyPlayerIfPossible();
      if (!spotifyPlayer) {
        showPlayerStatus("Spotify 재생기를 만들지 못했어요. 브라우저 지원 또는 로그인 상태를 확인해주세요.", "error", 0);
      } else {
        showPlayerStatus("Spotify 연결을 시작했어요. 연결 완료 후 재생 버튼을 눌러주세요.", "info", 5000);
      }
    }
  } catch (error) {
    console.error("플레이리스트 새로고침 실패:", error);
    showPlayerStatus(`새로고침에 실패했어요: ${error.message || error}`, "error", 0);
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove("refreshing");
    }
  }
}

async function renderPlayerTracks(date = activePlayerDate || todayKstDate()) {
  currentTrackUris = [];
  currentTrackSpotifyUrls = [];
  currentTrackPlaybackIndexes = [];
  currentPlaybackLogs = [];
  const userId = await currentUserId();
  if (!userId) return;
  const { data: logRows, error } = await sb
    .from("daily_logs")
    .select("id, caption, photo_path, logged_at, emotions, tracks(title, artists, spotify_url)")
    .eq("user_id", userId)
    .eq("log_date", date)
    .order("logged_at");
  if (error) {
    console.error("플레이어 트랙 로드 실패:", error.message);
    return;
  }
  const dayLogs = logRows || [];
  renderPlayerMoodNotes(dayLogs);

  // 트랙별 로그를 채우기 전에는 이전 화면의 대표 사진이 남지 않게 비운다.
  if (playerLogPhoto) playerLogPhoto.replaceChildren();
  if (playerLogPhoto) playerLogPhoto.classList.remove("has-photo");
  if (playerLogCaption) playerLogCaption.textContent = "";

  // 트랙 목록: 로그 사진 + 추천 곡(제목/가수)
  const list = document.querySelector("#playlist-player-screen .player-track-list");
  if (!list) return;
  list.querySelectorAll(".player-track").forEach((row) => row.remove());
  currentTrackLogs = [];
  for (let index = 0; index < dayLogs.length; index += 1) {
    const log = dayLogs[index];
    const track = Array.isArray(log.tracks) ? log.tracks[0] : log.tracks;

    const trackId = trackIdFromSpotifyUrl(track?.spotify_url);
    const playbackIndex = trackId ? currentTrackUris.push(`spotify:track:${trackId}`) - 1 : -1;
    if (playbackIndex >= 0) {
      currentTrackSpotifyUrls[playbackIndex] =
        track.spotify_url || `https://open.spotify.com/track/${trackId}`;
    }
    currentTrackPlaybackIndexes[index] = playbackIndex;

    const row = document.createElement("div");
    row.className = "player-track";
    row.dataset.action = "play-player-track";
    row.dataset.trackIndex = String(index);
    row.dataset.playbackIndex = String(playbackIndex);
    row.setAttribute("role", "button");
    row.tabIndex = 0;

    const thumb = document.createElement("span");
    const photoUrl = await signedUrl(log.photo_path);
    if (photoUrl) {
      thumb.style.backgroundImage = `url("${photoUrl}")`;
      thumb.style.backgroundSize = "cover";
      thumb.style.backgroundPosition = "center";
    }
    const trackLog = {
      caption: log.caption,
      photo: photoUrl,
      date: formatDisplayDate(date),
      time: formatDisplayTime(log.logged_at),
      moodNotes: emotionNoteSources(log.emotions),
    };
    currentTrackLogs[index] = trackLog;
    if (playbackIndex >= 0) currentPlaybackLogs[playbackIndex] = trackLog;
    row.addEventListener("click", (event) => {
      if (event.target.closest(".player-track-more")) return;
      event.stopPropagation();
      activatePlayerTrack(index, playbackIndex, trackLog);
    });

    const strong = document.createElement("strong");
    const title = track?.title || "추천 곡 준비중";
    const artist = (track?.artists && track.artists[0]) || "";
    strong.innerHTML = `${title}<br />${artist}`;

    const more = document.createElement("button");
    more.type = "button";
    more.className = "player-track-more";
    more.dataset.action = "open-track-log";
    more.dataset.trackIndex = String(index);
    more.setAttribute("aria-label", `${title} 로그 보기`);
    more.textContent = "•••";

    row.append(thumb, strong, more);
    list.append(row);
  }
  renderPlayerLogPolaroid(0);
}

function getTrackLog(index) {
  return (
    currentTrackLogs[index] ||
    logs[index] || {
      caption: "아직 이 노래와 연결된 로그가 없어요",
      photo: "",
      date: formatToday(),
      time: "16:00",
    }
  );
}

function formatDisplayTime(isoTimestamp) {
  if (!isoTimestamp) return "16:00";
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(isoTimestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}

function renderTrackLogStaff(notes = []) {
  const staff = document.querySelector(".track-log-staff");
  if (!staff) return;
  staff.querySelectorAll(".note").forEach((note) => note.remove());
  notes.slice(0, MAX_EMOTION_SELECTIONS).forEach((src, index) => {
    const position = getEmotionStaffPosition(index);
    const note = document.createElement("img");
    note.className = `note note-${index + 1}`;
    note.src = src;
    note.alt = "";
    note.style.left = `${position.left}px`;
    note.style.top = `${position.top}px`;
    staff.append(note);
  });
}

function openTrackLog(index) {
  const log = getTrackLog(index);
  if (trackLogDate) trackLogDate.textContent = `${log.date || formatToday()} ${log.time || "16:00"}`;
  if (trackLogCaption) trackLogCaption.textContent = log.caption || "";
  renderTrackLogStaff(log.moodNotes || []);
  if (trackLogPhoto) {
    trackLogPhoto.replaceChildren();
    trackLogPhoto.classList.toggle("has-photo", Boolean(log.photo));
    if (log.photo) {
      const image = document.createElement("img");
      image.src = log.photo;
      image.alt = "연결된 로그 사진";
      trackLogPhoto.append(image);
    }
  }
  const isPlayerScreen = screens[currentIndex] === "playlist-player-screen";
  trackLogModal?.classList.toggle("player-log-modal", isPlayerScreen);
  document.querySelector(".app-shell")?.append(trackLogModal);
  trackLogModal?.removeAttribute("hidden");
  trackLogModal?.classList.add("open");
}

function closeTrackLog() {
  trackLogModal?.classList.remove("open", "player-log-modal");
  trackLogModal?.setAttribute("hidden", "");
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
  // 화면별 스케일(record-home만 cover, 나머지 contain)을 위해 현재 화면을 기록하고 다시 계산.
  currentScreenId = currentScreen;
  updateAppScale();
  document.querySelector(".app-shell")?.classList.toggle(
    "record-home-background",
    currentScreen === "record-home-screen",
  );
  // record-home일 때 프레임 밖 여백도 책상(위=크림 벽, 아래=브라운 책상)으로 채운다.
  document.body.classList.toggle("record-home-bleed", currentScreen === "record-home-screen");
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
    updateArchiveYearLabel();
    refreshArchiveShelves();
    scrollArchiveToCurrentMonth();
  }
  if (currentScreen === "archive-month-screen") {
    renderArchiveMonthView(activeArchiveMonth);
  }
  if (currentScreen === "archive-playlist-detail-screen") {
    renderArchivePlaylistDetail(activeArchivePlaylistIndex);
  }
  if (currentScreen === "playlist-player-screen") {
    renderPlaylistPlayer();
  }
  if (currentScreen === "record-page-screen") {
    renderPolaroids();
  }
  if (currentScreen === "record-complete-screen") {
    completeTimer = setTimeout(() => {
      showScreen(screens.indexOf("record-page-screen"));
    }, 2000);
  }
  // playlist-loading-screen 전환은 generatePlaylist()가 직접 제어한다(서비스 응답 후 편집 화면으로).
  // sb 미설정(프로토타입) 시에만 옛 타이머로 자동 진행.
  if (currentScreen === "playlist-loading-screen" && !sb) {
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


function getEmotionStaffPosition(index) {
  const positions = [
    { left: -6, top: -8 },
    { left: 34, top: 30 },
    { left: 74, top: 8 },
    { left: 114, top: 42 },
    { left: 154, top: 20 },
    { left: 194, top: -7 },
    { left: 234, top: 31 },
    { left: 274, top: 10 },
    { left: 314, top: 41 },
  ];
  return positions[index] || positions[positions.length - 1];
}

function renderEmotionStaff(noteSources = selectedMoodNotes) {
  if (!emotionStaff) return;
  emotionStaff.querySelectorAll(".staff-note").forEach((note) => note.remove());
  noteSources.slice(0, MAX_EMOTION_SELECTIONS).forEach((noteSrc, index) => {
    const position = getEmotionStaffPosition(index);
    const emotion = selectedMoodEmotions[index] || "선택한";
    const note = document.createElement("img");
    note.className = `staff-note dynamic-staff-note note-${index + 1}`;
    note.src = noteSrc;
    note.alt = `${emotion} 감정 선택 취소`;
    note.dataset.selectionIndex = String(index);
    note.setAttribute("role", "button");
    note.setAttribute("tabindex", "0");
    note.style.left = `${position.left}px`;
    note.style.top = `${position.top}px`;
    emotionStaff.append(note);
  });
}

function resetEmotionStaff() {
  selectedMoodNotes = [];
  selectedMoodEmotions = [];
  if (emotionDoneButton) emotionDoneButton.disabled = true;
  emotionStaff?.querySelectorAll(".staff-note").forEach((note) => note.remove());
  for (const item of document.querySelectorAll(".emotion-choice")) {
    item.classList.remove("selected");
    item.setAttribute("aria-selected", "false");
    delete item.dataset.selectionCount;
  }
}

function updateEmotionChoiceStates() {
  for (const button of document.querySelectorAll(".emotion-choice")) {
    const count = selectedMoodEmotions.filter((emotion) => emotion === button.dataset.emotion).length;
    button.classList.toggle("selected", count > 0);
    button.setAttribute("aria-selected", String(count > 0));
    if (count > 0) button.dataset.selectionCount = String(count);
    else delete button.dataset.selectionCount;
  }
  if (emotionDoneButton) emotionDoneButton.disabled = readSelectedEmotions().length === 0;
}

function selectEmotion(button) {
  if (selectedMoodNotes.length >= MAX_EMOTION_SELECTIONS) return;

  const noteSource = button.querySelector("img")?.getAttribute("src");
  const emotion = button.dataset.emotion;
  if (!noteSource || !EMOTION_VALUES.includes(emotion)) return;

  selectedMoodNotes.push(noteSource);
  selectedMoodEmotions.push(emotion);
  updateEmotionChoiceStates();
  renderEmotionStaff();
}

function removeSelectedEmotion(index) {
  if (!Number.isInteger(index) || index < 0 || index >= selectedMoodNotes.length) return;
  selectedMoodNotes.splice(index, 1);
  selectedMoodEmotions.splice(index, 1);
  updateEmotionChoiceStates();
  renderEmotionStaff();
}

function polaroidPosition(index) {
  const group = Math.floor(index / 4);
  const layouts = [
    { left: 25, top: 45, rotate: 10 },
    { left: 145, top: 180, rotate: -7 },
    { left: 25, top: 385, rotate: 6 },
    { left: 145, top: 520, rotate: -7 },
  ];
  const layout = layouts[index % layouts.length];
  return {
    left: layout.left,
    top: layout.top + group * 675,
    rotate: layout.rotate,
  };
}

function makePolaroid({ index, add = false, log = null }) {
  const pos = polaroidPosition(index);
  const card = document.createElement(add ? "button" : "article");
  if (add) {
    card.type = "button";
  } else {
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.dataset.action = "select-log-polaroid";
  }
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
    card.dataset.logId = log.id || "";
    card.dataset.logIndex = String(index);
    card.setAttribute("aria-label", log.caption ? `기록: ${log.caption}` : "기록 사진");
    if (log.photo) {
      const photo = document.createElement("img");
      photo.src = log.photo;
      photo.alt = "기록 사진";
      image.append(photo);
    }
    caption.textContent = log.caption || "";
  } else {
    image.innerHTML = '<span class="placeholder-text">지금 순간을<br />기록해보세요</span>';
    caption.textContent = "";
  }

  const time = document.createElement("span");
  time.className = "polaroid-time";
  time.textContent = "";

  card.append(image, caption, time);
  if (!add && log) {
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "polaroid-delete-button";
    deleteButton.dataset.action = "request-delete-log";
    deleteButton.dataset.logId = log.id || "";
    deleteButton.dataset.logIndex = String(index);
    deleteButton.setAttribute("aria-label", "이 기록 삭제");
    deleteButton.textContent = "삭제";
    card.append(deleteButton);
  }
  return card;
}

function bringPolaroidToFront(card) {
  const board = card?.closest(".polaroid-board");
  if (!board || !card.classList.contains("log-polaroid")) return;
  const cards = [...board.querySelectorAll(".polaroid")];
  cards.forEach((item, index) => {
    const isFront = item === card;
    item.classList.toggle("is-front", isFront);
    item.style.zIndex = String(isFront ? cards.length + 1 : index + 1);
  });
}

function showDeleteLogModal(message, { confirmable = false } = {}) {
  if (!deleteLogModal || !deleteLogMessage || !deleteLogConfirm) return;
  deleteLogMessage.textContent = message;
  deleteLogConfirm.hidden = !confirmable;
  deleteLogModal.hidden = false;
  const focusTarget = confirmable
    ? deleteLogConfirm
    : deleteLogModal.querySelector(".delete-log-close");
  requestAnimationFrame(() => focusTarget?.focus());
}

function closeDeleteLogModal() {
  if (!deleteLogModal) return;
  deleteLogModal.hidden = true;
  pendingDeleteLog = null;
}

async function playlistUsesLog(log) {
  if (!sb || !log?.logDate) return false;
  const userId = await currentUserId();
  if (!userId) throw new Error("로그인 정보를 확인할 수 없습니다.");
  const { data: playlist, error: playlistError } = await sb
    .from("playlists")
    .select("id")
    .eq("user_id", userId)
    .eq("playlist_date", log.logDate)
    .limit(1)
    .maybeSingle();
  if (playlistError) throw playlistError;
  if (!playlist?.id || !log.id) return false;

  // 플레이리스트가 같은 날짜에 있더라도, 이 로그의 추천 트랙이 생성되지 않았다면
  // 플레이리스트 만들기에 사용된 로그가 아니다.
  const { data: track, error: trackError } = await sb
    .from("tracks")
    .select("id")
    .eq("log_id", log.id)
    .limit(1)
    .maybeSingle();
  if (trackError) throw trackError;
  return Boolean(track?.id);
}

async function requestLogDeletion(logId, logIndex) {
  const index = Number(logIndex);
  const log = logs.find((item) => item.id && item.id === logId)
    || (Number.isInteger(index) ? logs[index] : null);
  if (!log) {
    showDeleteLogModal("삭제할 기록을 찾지 못했습니다.");
    return;
  }

  try {
    if (await playlistUsesLog(log)) {
      showDeleteLogModal("이미 플레이리스트에 사용된 기록은 삭제할 수 없습니다.");
      return;
    }
  } catch (error) {
    console.error("로그 삭제 가능 여부 확인 실패:", error.message);
    showDeleteLogModal("삭제 가능 여부를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    return;
  }

  pendingDeleteLog = log;
  showDeleteLogModal("기록을 삭제하시겠습니까?", { confirmable: true });
}

async function confirmPendingLogDeletion() {
  const log = pendingDeleteLog;
  if (!log) {
    closeDeleteLogModal();
    return;
  }

  if (!sb || !log.id) {
    const localIndex = logs.indexOf(log);
    if (localIndex >= 0) logs.splice(localIndex, 1);
    closeDeleteLogModal();
    await renderPolaroids();
    return;
  }

  try {
    // 확인 모달이 열린 뒤 플레이리스트가 만들어졌을 가능성까지 다시 검사한다.
    if (await playlistUsesLog(log)) {
      pendingDeleteLog = null;
      showDeleteLogModal("이미 플레이리스트에 사용된 기록은 삭제할 수 없습니다.");
      return;
    }

    const userId = await currentUserId();
    if (!userId) throw new Error("로그인 정보를 확인할 수 없습니다.");
    const { error: deleteError } = await sb
      .from("daily_logs")
      .delete()
      .eq("id", log.id)
      .eq("user_id", userId);
    if (deleteError) throw deleteError;

    const storagePaths = [log.photoPath, log.stickerPath].filter(Boolean);
    if (storagePaths.length) {
      const { error: storageError } = await sb.storage
        .from("playmymood")
        .remove(storagePaths);
      if (storageError) {
        console.warn("삭제된 기록의 Storage 파일 정리 실패:", storageError.message);
      }
    }

    closeDeleteLogModal();
    await renderPolaroids();
  } catch (error) {
    console.error("기록 삭제 실패:", error.message);
    showDeleteLogModal("기록을 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
}

async function finalizeTodayPlaylist() {
  // "플레이리스트 만들기" 완료 버튼: 입력한 제목/소개를 오늘 playlists 행에 저장.
  hasTodayPlaylist = true;
  updateTodayPlaylistButton();
  const userId = await currentUserId();
  if (userId) {
    const title = playlistTitleInput?.value.trim() || "제목 없는 플리";
    const description = playlistIntroInput?.value.trim() || null;
    const { error } = await sb
      .from("playlists")
      .update({ title, description })
      .eq("user_id", userId)
      .eq("playlist_date", todayKstDate());
    if (error) console.error("플리 제목 저장 실패:", error.message);
    await waitForPendingLogProcessing();
    await renderLatestStickerCover(
      document.querySelector("#playlist-complete-screen .complete-cover"),
      userId,
      todayKstDate(),
    );
  }
  showScreen(screens.indexOf("playlist-complete-screen"));
}

function updateTodayPlaylistButton() {
  if (!playlistButton) return;
  playlistButton.textContent = hasTodayPlaylist ? "오늘의 플리 들으러 가기" : "플레이리스트 만들기";
}

async function loadTodayLogsIntoLocalCache() {
  // 새로고침/재로그인 등으로 세션이 새로 시작돼도 오늘 찍은 사진·캡션이 그대로 보이도록
  // 로컬 캐시(logs)를 Supabase daily_logs로 채운다.
  const userId = await currentUserId();
  if (!userId) return;
  const date = todayKstDate();
  const { data, error } = await sb
    .from("daily_logs")
    .select("id, caption, photo_path, sticker_path, logged_at, log_date")
    .eq("user_id", userId)
    .eq("log_date", date)
    .order("logged_at");
  if (error) {
    console.error("오늘의 기록 로드 실패:", error.message);
    return;
  }
  logs.length = 0;
  for (const row of data || []) {
    logs.push({
      id: row.id,
      caption: row.caption,
      photo: await signedUrl(row.photo_path),
      photoPath: row.photo_path,
      stickerPath: row.sticker_path,
      logDate: row.log_date || date,
      date: formatDisplayDate(date),
      time: formatDisplayTime(row.logged_at),
    });
  }
}

async function renderPolaroids() {
  await loadTodayLogsIntoLocalCache();
  polaroidList.replaceChildren();
  const board = document.createElement("div");
  board.className = "polaroid-board";

  const displayCount = Math.max(1, logs.length);
  const addIndex = displayCount;
  const totalCards = addIndex + 1;

  for (let index = 0; index < displayCount; index += 1) {
    board.appendChild(makePolaroid({ index, log: logs[index] || null }));
  }
  board.appendChild(makePolaroid({ index: addIndex, add: true }));

  const lastPosition = polaroidPosition(totalCards - 1);
  const boardHeight = Math.max(760, lastPosition.top + 315);
  board.style.minHeight = `${boardHeight}px`;
  polaroidList.classList.toggle("scrollable", boardHeight > 760);
  polaroidList.appendChild(board);
  playlistButton.classList.add("visible");
  updateTodayPlaylistButton();
}

function updateCaptionCharacterCount() {
  if (!recordNoteInput || !noteCharacterCount) return;
  const limitedValue = recordNoteInput.value.slice(0, MAX_CAPTION_LENGTH);
  if (recordNoteInput.value !== limitedValue) recordNoteInput.value = limitedValue;
  noteCharacterCount.textContent = `(${limitedValue.length}/${MAX_CAPTION_LENGTH})`;
}

function syncCaptionKeyboardLayout() {
  const isMobile = window.matchMedia("(max-width: 600px)").matches;
  const isCaptionFocused = document.activeElement === recordNoteInput;
  appShell?.classList.toggle("caption-keyboard-open", isMobile && isCaptionFocused);
  if (isMobile && isCaptionFocused) updateAppScale();
}

function finishCaptionEntry() {
  if (!recordNoteInput) return;
  pendingNote = recordNoteInput.value.trim().slice(0, MAX_CAPTION_LENGTH);
  recordNoteInput.blur();
  showScreen(screens.indexOf("emotion-screen"));
}

recordNoteInput?.addEventListener("input", updateCaptionCharacterCount);
recordNoteInput?.addEventListener("focus", syncCaptionKeyboardLayout);
recordNoteInput?.addEventListener("blur", syncCaptionKeyboardLayout);
recordNoteInput?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  finishCaptionEntry();
});
updateCaptionCharacterCount();
window.visualViewport?.addEventListener("resize", syncCaptionKeyboardLayout);
window.visualViewport?.addEventListener("scroll", syncCaptionKeyboardLayout);

archiveMonthCarousel?.addEventListener("scroll", () => {
  if (archiveMonthCarousel.scrollTop !== 0) archiveMonthCarousel.scrollTop = 0;
  if (archiveCarouselFrame !== null) cancelAnimationFrame(archiveCarouselFrame);
  archiveCarouselFrame = requestAnimationFrame(() => {
    archiveCarouselFrame = null;
    syncArchivePlaylistToCarousel();
  });
});

archiveDetailCarousel?.addEventListener("scroll", () => {
  if (archiveDetailCarousel.scrollTop !== 0) archiveDetailCarousel.scrollTop = 0;
  if (archiveDetailCarouselFrame !== null) cancelAnimationFrame(archiveDetailCarouselFrame);
  archiveDetailCarouselFrame = requestAnimationFrame(() => {
    archiveDetailCarouselFrame = null;
    syncArchiveDetailToCarousel();
  });
});

archiveMonthScreen?.addEventListener(
  "touchstart",
  (event) => {
    const touch = event.changedTouches[0];
    const swipeArea = event.target.closest(".archive-month-carousel, .archive-month-copy");
    const touchedCard = event.target.closest(".archive-album-card");
    if (!touch || !swipeArea || (touchedCard && touchedCard.getAttribute("aria-current") !== "true")) {
      archiveMonthSwipeStart = null;
      return;
    }
    archiveMonthSwipeStart = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
    };
  },
  { passive: true },
);

archiveMonthScreen?.addEventListener(
  "touchend",
  (event) => {
    if (!archiveMonthSwipeStart) return;
    const touch = event.changedTouches[0];
    const start = archiveMonthSwipeStart;
    archiveMonthSwipeStart = null;
    if (!touch || !activeMonthPlaylists.length) return;
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const isQuickEnough = Date.now() - start.time < 1000;
    const isUpwardSwipe = deltaY <= -55 && Math.abs(deltaY) > Math.abs(deltaX) * 1.2;
    if (!isQuickEnough || !isUpwardSwipe) return;
    showScreen(screens.indexOf("archive-playlist-detail-screen"));
  },
  { passive: true },
);

archiveMonthScreen?.addEventListener("touchcancel", () => {
  archiveMonthSwipeStart = null;
});

document.addEventListener("keydown", (event) => {
  if (event.target.closest?.("button")) return;
  const polaroid = event.target.closest?.(".log-polaroid[data-action='select-log-polaroid']");
  if (polaroid && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    bringPolaroidToFront(polaroid);
    return;
  }
  const row = event.target.closest?.(".archive-detail-track[data-action], .player-track[data-action]");
  if (!row || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  row.click();
});

hitSlider?.addEventListener("input", updateHitSlider);
zoomSlider?.addEventListener("input", applyZoom);
zoomControl?.addEventListener("click", (event) => snapZoomToClosestLabel(event.clientX));
emotionStaff?.addEventListener("click", (event) => {
  const note = event.target.closest(".staff-note[data-selection-index]");
  if (!note) return;
  removeSelectedEmotion(Number(note.dataset.selectionIndex));
});
emotionStaff?.addEventListener("keydown", (event) => {
  const note = event.target.closest(".staff-note[data-selection-index]");
  if (!note || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  removeSelectedEmotion(Number(note.dataset.selectionIndex));
});
if (zoomSlider) zoomSlider.value = "1";
updateHitSlider();
updateRecordDates();
applyZoom();
document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action], button");
  if (!target) return;
  const action = target.dataset.action;

  if (target.classList.contains("log-polaroid")) {
    bringPolaroidToFront(target);
    return;
  }

  if (target.classList.contains("archive-detail-cover-card")) {
    centerArchiveDetailCard(Number(target.dataset.archiveIndex || 0), "smooth");
    return;
  }

  if (action === "request-delete-log") {
    requestLogDeletion(target.dataset.logId || "", target.dataset.logIndex);
    return;
  }

  if (action === "close-delete-log") {
    closeDeleteLogModal();
    return;
  }

  if (action === "confirm-delete-log") {
    confirmPendingLogDeletion();
    return;
  }

  if (action === "spotify-login") {
    loginWithSpotify();
    return;
  }

  if (action === "next") {
    showScreen(currentIndex + 1);
    return;
  }

  if (action === "start-onboarding") {
    // 온보딩 마지막 화면 "시작하기" → 선택값(연대/장르/유명도)을 Supabase에 저장하고 홈으로.
    saveOnboarding();
    showScreen(screens.indexOf("record-home-screen"));
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

  if (action === "prev-archive-year" || action === "next-archive-year") {
    activeArchiveYear += action === "prev-archive-year" ? -1 : 1;
    updateArchiveYearLabel();
    refreshArchiveShelves();
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

  if (action === "open-playlist-player") {
    if (target.dataset.autoplay === "true") activateSpotifyForMobileGesture();
    playerEntryMode = target.dataset.playerEntry || "archive";
    activePlayerDate =
      playerEntryMode === "home" ? todayKstDate() : getActiveArchivePlaylistRow()?.playlist_date || todayKstDate();
    pendingPlayerAutoPlay = target.dataset.autoplay === "true";
    pendingPlayerStartLogIndex = pendingPlayerAutoPlay ? 0 : null;
    showScreen(screens.indexOf("playlist-player-screen"));
    return;
  }

  if (action === "play-archive-track") {
    activateSpotifyForMobileGesture();
    playerEntryMode = "archive";
    activePlayerDate = getActiveArchivePlaylistRow()?.playlist_date || todayKstDate();
    pendingPlayerStartLogIndex = Number(target.dataset.trackIndex || 0);
    pendingPlayerAutoPlay = true;
    showScreen(screens.indexOf("playlist-player-screen"));
    return;
  }

  if (action === "play-player-track") {
    const logIndex = Number(target.dataset.trackIndex);
    const playbackIndex = Number(target.dataset.playbackIndex);
    activatePlayerTrack(logIndex, playbackIndex);
    return;
  }

  if (action === "open-track-log") {
    openTrackLog(Number(target.dataset.trackIndex || 0));
    return;
  }

  if (action === "close-track-log") {
    closeTrackLog();
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

  if (action === "finish-caption") {
    finishCaptionEntry();
    return;
  }

  if (action === "retake-photo") {
    pendingNote = "";
    if (recordNoteInput) recordNoteInput.value = "";
    updateCaptionCharacterCount();
    isRetakingPhoto = true;
    showScreen(screens.indexOf("capture-screen"));
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
    activeCameraIsFront = cameraFacingMode === "user";
    updateCameraPreviewTransform();
    startCamera();
    return;
  }
  if (action === "save-log") {
    const emotions = readSelectedEmotions();
    if (emotions.length === 0) {
      alert("감정 이모지를 1개 이상 선택해 주세요.");
      return;
    }
    // Supabase 저장 (사진 업로드 + daily_logs insert). 값이 아래에서 초기화되기 전에 넘긴다.
    trackLogProcessing(
      saveLog({
        photo: capturedPhotoDataUrl,
        caption: pendingNote,
        emotions,
      }),
    );
    logs.push({
      caption: pendingNote,
      photo: capturedPhotoDataUrl,
      date: formatToday(),
      time: formatCurrentTime(),
      moodNotes: [...selectedMoodNotes],
    });
    pendingNote = "";
    capturedPhotoDataUrl = "";
    recordNoteInput.value = "";
    updateCaptionCharacterCount();
    showScreen(screens.indexOf("record-complete-screen"));
    return;
  }

  if (action === "complete-playlist") {
    finalizeTodayPlaylist();
    return;
  }

  if (action === "go-record-home") {
    showScreen(screens.indexOf("record-home-screen"));
    return;
  }

  if (action === "logout") {
    logout();
    return;
  }

  if (target.id === "playlist-button") {
    if (hasTodayPlaylist) {
      playerEntryMode = "home";
      activePlayerDate = todayKstDate();
      showScreen(screens.indexOf("playlist-player-screen"));
    } else {
      generatePlaylist();
    }
    return;
  }

  if (action === "toggle-player-play") {
    activateSpotifyForMobileGesture();
    console.log(
      `[재생버튼] spotifyDeviceId=${spotifyDeviceId} currentTrackUris.length=${currentTrackUris.length} spotifyPlaybackStarted=${spotifyPlaybackStarted} isPlayerPlaying=${isPlayerPlaying}`,
    );
    if (currentTrackUris.length) {
      if (!spotifyPlaybackStarted) {
        // 하단 버튼의 첫 재생은 항상 전체 목록의 첫 곡부터 시작한다.
        startSpotifyPlaybackAt(0);
      } else if (spotifyPlayer) {
        setPlayerPlaying(!isPlayerPlaying);
        spotifyPlayer?.togglePlay().catch((err) => {
          console.error("togglePlay 실패:", err);
          showPlayerStatus(`재생 상태를 바꾸지 못했어요: ${err.message || err}`, "error", 0);
          setPlayerPlaying(false);
        });
      }
    } else {
      console.warn("재생할 Spotify 트랙이 없습니다.");
      showPlayerStatus("이 플레이리스트에는 재생 가능한 Spotify 곡이 없어요.", "error", 0);
    }
    return;
  }

  if (action === "refresh-player") {
    refreshPlaylistPlayer(target);
    return;
  }

  if (action === "player-prev" || action === "player-next") {
    if (!currentTrackUris.length) return;
    const delta = action === "player-prev" ? -1 : 1;
    currentTrackIndex = (currentTrackIndex + delta + currentTrackUris.length) % currentTrackUris.length;
    console.log(`[${action}] spotifyDeviceId=${spotifyDeviceId} newIndex=${currentTrackIndex}`);
    if (spotifyDeviceId) {
      startSpotifyPlaybackAt(currentTrackIndex);
    }
    return;
  }

  if (action === "player-nav") {
    setPlayerPlaying(false);
    spotifyPlayer?.pause();
    if (playerEntryMode === "home") {
      showScreen(screens.indexOf("record-home-screen"));
    } else {
      // 앨범 상태(archive-playlist-detail)와 플레이어는 같은 화면(스와이프로 펼친 것)이므로,
      // 뒤로가기는 둘 다 책장(archive-screen)으로 바로 간다.
      showScreen(screens.indexOf("archive-screen"));
    }
    return;
  }

  if (action === "back") {
    const currentScreen = screens[currentIndex];
    if (currentScreen === "capture-screen" && isRetakingPhoto) {
      isRetakingPhoto = false;
      showScreen(screens.indexOf("record-page-screen"));
      return;
    }
    if (currentScreen === "record-page-screen") {
      showScreen(screens.indexOf("record-home-screen"));
      return;
    }
    // 앨범 상세(플레이어와 같은 화면)에서 뒤로가기는 책장(archive-screen)으로.
    if (currentScreen === "archive-playlist-detail-screen") {
      showScreen(screens.indexOf("archive-screen"));
      return;
    }
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
initAuth();

// 아카이브 상세에서 위로 스와이프 → 플레이어로 (LP가 커버 뒤에서 나오고 리스트가 올라오는 모션).
(function setupArchiveSwipeUp() {
  const detail = document.getElementById("archive-playlist-detail-screen");
  if (!detail) return;
  let startX = null;
  let startY = null;
  detail.addEventListener(
    "touchstart",
    (event) => {
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
    },
    { passive: true },
  );
  detail.addEventListener(
    "touchend",
    (event) => {
      if (startY === null) return;
      const dy = startY - event.changedTouches[0].clientY; // 위로 스와이프하면 양수
      const dx = Math.abs(startX - event.changedTouches[0].clientX);
      if (dy > 60 && dy > dx) {
        playerEntryMode = "archive";
        showScreen(screens.indexOf("playlist-player-screen"));
      }
      startX = null;
      startY = null;
    },
    { passive: true },
  );
})();
