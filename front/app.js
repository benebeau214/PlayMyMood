const DESIGN_WIDTH = 393;
const DESIGN_HEIGHT = 852;

function updateAppScale() {
  const viewportWidth = window.innerWidth || DESIGN_WIDTH;
  const viewportHeight = window.innerHeight || DESIGN_HEIGHT;
  const scale = Math.min(viewportWidth / DESIGN_WIDTH, viewportHeight / DESIGN_HEIGHT, 1.15);
  document.documentElement.style.setProperty("--app-scale", String(scale));
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
  "cover-screen",
  "finish-screen",
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
// 트랙 "•••" 로그 팝업용: 화면에 마지막으로 그려진 트랙 목록의 실제 사진/캡션/날짜.
// (오늘/아카이브 어느 날짜를 보고 있든 항상 그 화면이 채운 값을 그대로 씀)
let currentTrackLogs = [];
let archiveMonthCounts = Array(12).fill(0);
let activeMonthPlaylists = [];
let activeArchiveMonth = getCurrentMonthNumber();
let activeArchiveYear = getCurrentYearNumber();
let activeArchivePlaylistIndex = 0;
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
let currentTrackUris = [];
let currentTrackIndex = 0;

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
const zoomControl = document.querySelector(".zoom-control");
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
const trackLogModal = document.getElementById("track-log-modal");
const trackLogDate = document.getElementById("track-log-date");
const trackLogPhoto = document.getElementById("track-log-photo");
const trackLogCaption = document.getElementById("track-log-caption");
const playerNavButton = document.querySelector(".player-nav-button");
const playerDate = document.getElementById("player-date");
const playerTitle = document.getElementById("player-title");
const playerLogPhoto = document.getElementById("player-log-photo");
const playerLogCaption = document.getElementById("player-log-caption");
const playerRecordBoard = document.querySelector(".player-record-board");
const playerPlayButton = document.querySelector(".player-play");
let cameraStream = null;
let cameraFacingMode = "environment";
let flashEnabled = false;
let capturedPhotoDataUrl = "";
const MAX_EMOTION_SELECTIONS = 9;
let selectedMoodNotes = [];

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
  currentTrackUris = [];
  currentTrackLogs = [];
  hasTodayPlaylist = false;
  logs.length = 0;
  activeMonthPlaylists = [];
  activeArchivePlaylistIndex = 0;
  activePlayerDate = null;
  pendingNote = "";
  capturedPhotoDataUrl = "";
  selectedMoodNotes = [];
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
function trackIdFromSpotifyUrl(url) {
  const match = (url || "").match(/track[/:]([A-Za-z0-9]+)/);
  return match ? match[1] : null;
}

async function getSpotifyAccessToken() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.provider_token || null;
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
  });
  spotifyPlayer.addListener("not_ready", () => {
    spotifyDeviceId = null;
  });
  spotifyPlayer.addListener("initialization_error", ({ message }) =>
    console.error("Spotify 초기화 실패:", message),
  );
  spotifyPlayer.addListener("authentication_error", ({ message }) =>
    console.error("Spotify 인증 실패:", message),
  );
  spotifyPlayer.addListener("account_error", ({ message }) =>
    console.error("Spotify 계정 오류(Premium 계정이 아니면 재생 불가):", message),
  );
  spotifyPlayer.addListener("player_state_changed", (state) => {
    if (!state) return;
    setPlayerPlaying(!state.paused);
  });

  await spotifyPlayer.connect();
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

async function playSpotifyTrackAt(index) {
  if (!spotifyDeviceId) {
    console.warn("재생 불가: Spotify 기기(device_id)가 아직 준비되지 않음 (ready 이벤트 대기 중이거나 Premium 계정이 아닐 수 있음)");
    return;
  }
  if (!currentTrackUris.length) {
    console.warn("재생 불가: 이 날짜에 Spotify 트랙 URI가 없음 (tracks.spotify_url이 비어있을 수 있음)");
    return;
  }
  const token = await getSpotifyAccessToken();
  if (!token) {
    console.warn("재생 불가: Spotify access token 없음 (DEV_MODE 익명 로그인이거나 세션에 provider_token이 없음)");
    return;
  }
  currentTrackIndex = ((index % currentTrackUris.length) + currentTrackUris.length) % currentTrackUris.length;
  const uri = currentTrackUris[currentTrackIndex];
  console.log("[재생 시도] uri =", uri);
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
      body: JSON.stringify({ uris: [uri] }),
    });
    if (response.ok) {
      console.log("[재생 성공]");
      return;
    }
    const body = await response.text().catch(() => "");
    lastError = { status: response.status, body };
    if (response.status !== 404) break; // 404(기기 미등록)만 재시도, 그 외 에러는 바로 표시.
  }
  console.error(
    `Spotify 재생 API 실패 (status=${lastError.status}): ${lastError.body}` +
      (lastError.status === 403
        ? " → scope에 user-modify-playback-state가 없거나 계정이 Premium이 아닐 수 있음"
        : lastError.status === 404
          ? " → device_id가 계속 인식되지 않음. 탭을 새로고침해서 SDK를 다시 연결해보세요"
          : ""),
  );
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

function readSelectedCoverIndex() {
  const cards = Array.from(document.querySelectorAll("#cover-screen .blank-card"));
  return cards.findIndex((card) => card.classList.contains("selected"));
}

async function saveOnboarding() {
  if (!sb) return;
  const { data: sessionData } = await sb.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) {
    console.warn("온보딩 저장 건너뜀: 로그인 세션 없음");
    return;
  }

  const coverIndex = readSelectedCoverIndex();
  let coverStyleId = null;
  if (coverIndex >= 0) {
    const { data: coverStyle } = await sb
      .from("cover_styles")
      .select("id")
      .eq("code", `style_${coverIndex + 1}`)
      .maybeSingle();
    coverStyleId = coverStyle?.id ?? null;
  }

  const { error: prefError } = await sb.from("user_preferences").upsert(
    {
      user_id: user.id,
      era: readSelectedEra(),
      genres: readSelectedGenres(),
      fame_preference: readFamePreference(),
      cover_style_id: coverStyleId,
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

function readSelectedEmotions() {
  const buttons = Array.from(document.querySelectorAll("#emotion-screen .emotion-choice.selected"));
  const labels = buttons
    .map((button) => button.querySelector("span")?.textContent?.trim())
    .filter((label) => EMOTION_VALUES.includes(label));
  const unique = [...new Set(labels)].slice(0, MAX_EMOTION_SELECTIONS);
  if (unique.length === 0) {
    // 감정 버튼이 아직 플레이스홀더("기쁨" 등)라 유효한 라벨이 없으면 테스트용 기본값으로 저장.
    // index.html의 emotion-choice <span>을 실제 감정(행복한/신나는/…)으로 채우면 그대로 저장됨.
    console.warn("유효한 감정 라벨 없음 → 기본값 ['기쁜']으로 저장 (감정 버튼 라벨을 실제 값으로 채워야 함)");
    return ["기쁜"];
  }
  return unique;
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

  // 에이전트 서비스에 처리 요청(백그라운드). 서비스가 꺼져 있어도 로그 저장엔 영향 없음.
  if (PMM.AGENT_SERVICE_URL && inserted?.id) {
    fetch(`${PMM.AGENT_SERVICE_URL}/process-log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ log_id: inserted.id }),
    })
      .then((res) => {
        if (res.ok) console.log("에이전트 처리 요청 보냄 (situation/스티커 등 채워짐)");
        else console.warn("에이전트 서비스 응답 오류:", res.status);
      })
      .catch(() => console.warn("에이전트 서비스 호출 실패 (서비스가 안 켜져 있을 수 있음)"));
  }
}

// --- 플레이리스트 생성 + 편집 화면 렌더 ---
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
  await ensurePlaylistRow(user.id, date);

  // 서비스에 그날 로그별 추천 곡 생성 요청 (완료까지 대기 — mood_music_agent가 로그마다 돎).
  if (PMM.AGENT_SERVICE_URL) {
    try {
      await fetch(`${PMM.AGENT_SERVICE_URL}/generate-playlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: user.id, date }),
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
    .select("id, caption, photo_path, sticker_path, logged_at, tracks(title, artists)")
    .eq("user_id", userId)
    .eq("log_date", date)
    .order("logged_at");
  if (error) {
    console.error("플리 편집 로드 실패:", error.message);
    return;
  }
  const dayLogs = logRows || [];

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

  // 커버(핑크 사각형)에 그날 스티커들 오버레이
  await renderStickerCover(document.querySelector("#playlist-edit-screen .cover-square"), dayLogs);
}

// 그날 로그들의 sticker_path를 정사각형 커버 위에 겹쳐 그린다.
// (오늘 플리 편집 화면 / 아카이브 상세 화면에서 공용으로 사용)
async function renderStickerCover(coverEl, dayLogs) {
  if (!coverEl) return;
  coverEl.querySelectorAll(".cover-sticker").forEach((sticker) => sticker.remove());
  // position은 건드리지 않는다 — 두 재사용처(.cover-square div, .archive-detail-square span)
  // 모두 스타일시트에서 이미 position:absolute라 그 자체로 자식 절대배치 기준이 된다.
  // 여기서 relative로 덮어쓰면 <span>(inline 기본값)의 width/height가 무시돼 찌그러짐.
  coverEl.style.overflow = "hidden";
  const positions = [
    { left: "6%", top: "8%" },
    { left: "52%", top: "6%" },
    { left: "12%", top: "48%" },
    { left: "54%", top: "50%" },
    { left: "32%", top: "28%" },
  ];
  let placed = 0;
  for (const log of dayLogs) {
    if (!log.sticker_path) continue;
    const url = await signedUrl(log.sticker_path);
    if (!url) continue;
    const image = document.createElement("img");
    image.className = "cover-sticker";
    image.src = url;
    image.alt = "";
    const pos = positions[placed % positions.length];
    image.style.position = "absolute";
    image.style.left = pos.left;
    image.style.top = pos.top;
    image.style.width = "40%";
    coverEl.append(image);
    placed += 1;
  }
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

function applyZoom() {
  if (!zoomSlider) return;
  const zoom = Number(zoomSlider.value || 1);
  if (cameraVideo) cameraVideo.style.transform = `scale(${zoom})`;
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
    // 왼쪽부터 딱 붙여서 전부 직립으로 쌓는다. (마지막 1장 기울이는 건 잠시 보류)
    const lpWidth = 13;
    for (let index = 0; index < count; index += 1) {
      const lp = document.createElement("span");
      lp.className = `archive-lp archive-lp-color-${(index % 6) + 1}`;
      lp.style.left = `${index * lpWidth}px`;
      lp.style.zIndex = String(index + 1);
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

async function firstStickerUrlForDate(userId, date) {
  const { data, error } = await sb
    .from("daily_logs")
    .select("sticker_path")
    .eq("user_id", userId)
    .eq("log_date", date)
    .not("sticker_path", "is", null)
    .order("logged_at")
    .limit(1)
    .maybeSingle();
  if (error || !data?.sticker_path) return null;
  return signedUrl(data.sticker_path);
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

  const first = activeMonthPlaylists[0];
  if (archiveMonthPlaylistTitle) archiveMonthPlaylistTitle.textContent = first.title || "제목 없는 플리";
  if (archiveMonthPlaylistDesc) archiveMonthPlaylistDesc.textContent = first.description || "짧은 소개글이 아직 없어요.";
  requestAnimationFrame(() => {
    archiveMonthCarousel?.scrollTo({ left: 0, behavior: "auto" });
  });

  // 카드별 커버(그날 첫 스티커)를 비동기로 채운다.
  const cards = archiveMonthCarousel ? Array.from(archiveMonthCarousel.querySelectorAll(".archive-album-card")) : [];
  for (let index = 0; index < activeMonthPlaylists.length; index += 1) {
    const coverEl = cards[index]?.querySelector(".archive-album-cover");
    if (!coverEl) continue;
    const stickerUrl = await firstStickerUrlForDate(userId, activeMonthPlaylists[index].playlist_date);
    if (stickerUrl) {
      coverEl.style.backgroundImage = `url("${stickerUrl}")`;
      coverEl.style.backgroundSize = "cover";
      coverEl.style.backgroundPosition = "center";
    }
  }
}

function getActiveArchivePlaylistRow() {
  return activeMonthPlaylists[activeArchivePlaylistIndex] || null;
}

async function renderArchivePlaylistDetail(index = activeArchivePlaylistIndex) {
  activeArchivePlaylistIndex = index;
  const playlist = getActiveArchivePlaylistRow();
  if (archiveDetailTitle) archiveDetailTitle.textContent = formatArchiveMonth(activeArchiveMonth);

  const tracksSection = document.querySelector("#archive-playlist-detail-screen .archive-detail-tracks");
  tracksSection?.querySelectorAll(".archive-detail-track").forEach((row) => row.remove());

  if (!playlist) {
    if (archiveDetailDate) archiveDetailDate.textContent = "";
    if (archiveDetailName) archiveDetailName.textContent = "";
    return;
  }
  if (archiveDetailDate) archiveDetailDate.textContent = formatDisplayDate(playlist.playlist_date);
  if (archiveDetailName) archiveDetailName.textContent = playlist.title || "제목 없는 플리";

  const userId = await currentUserId();
  if (!userId) return;

  const { data: dayLogs, error } = await sb
    .from("daily_logs")
    .select("id, photo_path, sticker_path, tracks(title, artists, spotify_url)")
    .eq("user_id", userId)
    .eq("log_date", playlist.playlist_date)
    .order("logged_at");
  if (error) {
    console.error("아카이브 상세 로드 실패:", error.message);
    return;
  }

  await renderStickerCover(document.querySelector("#archive-playlist-detail-screen .archive-detail-square"), dayLogs || []);

  if (tracksSection) {
    for (const log of dayLogs || []) {
      const track = Array.isArray(log.tracks) ? log.tracks[0] : log.tracks;
      const row = document.createElement("div");
      row.className = "archive-detail-track";
      const thumb = document.createElement("span");
      const photoUrl = await signedUrl(log.photo_path);
      if (photoUrl) {
        thumb.style.backgroundImage = `url("${photoUrl}")`;
        thumb.style.backgroundSize = "cover";
        thumb.style.backgroundPosition = "center";
      }
      const info = document.createElement("p");
      const title = track?.title || "추천 곡 준비중";
      const artist = (track?.artists && track.artists[0]) || "";
      info.innerHTML = `${title}<br />${artist}`;
      row.append(thumb, info);
      tracksSection.append(row);
    }
  }
}

function setPlayerPlaying(isPlaying) {
  isPlayerPlaying = isPlaying;
  playerRecordBoard?.classList.toggle("is-playing", isPlayerPlaying);
  playerPlayButton?.classList.toggle("is-playing", isPlayerPlaying);
  playerPlayButton?.setAttribute("aria-label", isPlayerPlaying ? "일시정지" : "재생");
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
}

async function renderPlayerTracks(date = activePlayerDate || todayKstDate()) {
  currentTrackUris = [];
  const userId = await currentUserId();
  if (!userId) return;
  const { data: logRows, error } = await sb
    .from("daily_logs")
    .select("id, caption, photo_path, logged_at, tracks(title, artists, spotify_url)")
    .eq("user_id", userId)
    .eq("log_date", date)
    .order("logged_at");
  if (error) {
    console.error("플레이어 트랙 로드 실패:", error.message);
    return;
  }
  const dayLogs = logRows || [];

  // 대표 로그 사진/캡션을 실제 저장 데이터로(새로고침해도 유지되게)
  const first = dayLogs[0];
  if (playerLogPhoto) playerLogPhoto.replaceChildren();
  if (playerLogPhoto) playerLogPhoto.classList.remove("has-photo");
  if (playerLogCaption) playerLogCaption.textContent = first?.caption || "아직 이 노래와 연결된 로그가 없어요";
  if (first) {
    if (playerLogPhoto) {
      const url = await signedUrl(first.photo_path);
      if (url) {
        playerLogPhoto.replaceChildren();
        playerLogPhoto.classList.add("has-photo");
        const image = document.createElement("img");
        image.src = url;
        image.alt = "대표 로그 사진";
        playerLogPhoto.append(image);
      }
    }
  }

  // 트랙 목록: 로그 사진 + 추천 곡(제목/가수)
  const list = document.querySelector("#playlist-player-screen .player-track-list");
  if (!list) return;
  list.querySelectorAll(".player-track").forEach((row) => row.remove());
  currentTrackLogs = [];
  for (let index = 0; index < dayLogs.length; index += 1) {
    const log = dayLogs[index];
    const track = Array.isArray(log.tracks) ? log.tracks[0] : log.tracks;

    const trackId = trackIdFromSpotifyUrl(track?.spotify_url);
    if (trackId) currentTrackUris.push(`spotify:track:${trackId}`);

    const button = document.createElement("button");
    button.className = "player-track";
    button.type = "button";
    button.dataset.action = "open-track-log";
    button.dataset.trackIndex = String(index);

    const thumb = document.createElement("span");
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
    };

    const strong = document.createElement("strong");
    const title = track?.title || "추천 곡 준비중";
    const artist = (track?.artists && track.artists[0]) || "";
    strong.innerHTML = `${title}<br />${artist}`;

    button.append(thumb, strong);
    list.append(button);
  }
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
  const fallbackNotes = [
    "./assets/music-note-orange.png",
    "./assets/music-note-yellow.png",
    "./assets/music-note-orange.png",
    "./assets/music-note-yellow.png",
  ];
  const noteSources = notes.length ? notes : fallbackNotes;
  noteSources.slice(0, MAX_EMOTION_SELECTIONS).forEach((src, index) => {
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
  if (trackLogCaption) trackLogCaption.textContent = log.caption || "오늘 감정과 상황을 기록했어요";
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
    const note = document.createElement("img");
    note.className = `staff-note dynamic-staff-note note-${index + 1}`;
    note.src = noteSrc;
    note.alt = "";
    note.style.left = `${position.left}px`;
    note.style.top = `${position.top}px`;
    emotionStaff.append(note);
  });
}

function resetEmotionStaff() {
  selectedMoodNotes = [];
  emotionStaff?.querySelectorAll(".staff-note").forEach((note) => note.remove());
  for (const item of document.querySelectorAll(".emotion-choice")) {
    item.classList.remove("selected");
    item.setAttribute("aria-selected", "false");
  }
}

function updateSelectedMoodNotes() {
  selectedMoodNotes = [...document.querySelectorAll(".emotion-choice.selected img")]
    .map((source) => source.getAttribute("src") || source.src)
    .slice(0, MAX_EMOTION_SELECTIONS);
  renderEmotionStaff(selectedMoodNotes);
}

function selectEmotion(button) {
  const isSelected = button.classList.contains("selected");
  const selectedCount = document.querySelectorAll(".emotion-choice.selected").length;
  if (!isSelected && selectedCount >= MAX_EMOTION_SELECTIONS) return;

  button.classList.toggle("selected", !isSelected);
  button.setAttribute("aria-selected", String(!isSelected));
  updateSelectedMoodNotes();
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
    .select("caption, photo_path, logged_at")
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
      caption: row.caption,
      photo: await signedUrl(row.photo_path),
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

  const rows = Math.ceil(totalCards / 4);
  board.style.minHeight = `${Math.max(760, rows * 720 + 120)}px`;
  polaroidList.classList.toggle("scrollable", logs.length >= 4);
  polaroidList.appendChild(board);
  playlistButton.classList.add("visible");
  updateTodayPlaylistButton();
}

recordNoteInput?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  pendingNote = event.target.value.trim();
  showScreen(screens.indexOf("emotion-screen"));
});


hitSlider?.addEventListener("input", updateHitSlider);
zoomSlider?.addEventListener("input", applyZoom);
zoomControl?.addEventListener("click", (event) => snapZoomToClosestLabel(event.clientX));
if (zoomSlider) zoomSlider.value = "1";
updateHitSlider();
updateRecordDates();
applyZoom();
document.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  const action = target.dataset.action;

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
    playerEntryMode = target.dataset.playerEntry || "archive";
    activePlayerDate =
      playerEntryMode === "home" ? todayKstDate() : getActiveArchivePlaylistRow()?.playlist_date || todayKstDate();
    showScreen(screens.indexOf("playlist-player-screen"));
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
    // Supabase 저장 (사진 업로드 + daily_logs insert). 값이 아래에서 초기화되기 전에 넘긴다.
    saveLog({
      photo: capturedPhotoDataUrl,
      caption: pendingNote,
      emotions: readSelectedEmotions(),
    });
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
    console.log(
      `[재생버튼] spotifyDeviceId=${spotifyDeviceId} currentTrackUris.length=${currentTrackUris.length} spotifyPlaybackStarted=${spotifyPlaybackStarted} isPlayerPlaying=${isPlayerPlaying}`,
    );
    if (spotifyDeviceId && currentTrackUris.length) {
      // 실제 Spotify 응답(player_state_changed)을 기다리지 않고 우선 눈에 보이는 반응부터 준다.
      // 이후 상태가 다르면 player_state_changed 리스너가 다시 맞춰준다.
      setPlayerPlaying(!isPlayerPlaying);
      if (!spotifyPlaybackStarted) {
        spotifyPlaybackStarted = true;
        playSpotifyTrackAt(currentTrackIndex);
      } else {
        spotifyPlayer?.togglePlay().catch((err) => console.error("togglePlay 실패:", err));
      }
    } else {
      // Spotify 재생 준비가 안 된 경우(익명 로그인/토큰 만료/트랙 없음 등)엔 LP 애니메이션만 토글.
      setPlayerPlaying(!isPlayerPlaying);
    }
    return;
  }

  if (action === "player-prev" || action === "player-next") {
    if (!currentTrackUris.length) return;
    const delta = action === "player-prev" ? -1 : 1;
    currentTrackIndex = (currentTrackIndex + delta + currentTrackUris.length) % currentTrackUris.length;
    console.log(`[${action}] spotifyDeviceId=${spotifyDeviceId} newIndex=${currentTrackIndex}`);
    if (spotifyDeviceId) {
      spotifyPlaybackStarted = true;
      setPlayerPlaying(true);
      playSpotifyTrackAt(currentTrackIndex);
    }
    return;
  }

  if (action === "player-nav") {
    setPlayerPlaying(false);
    spotifyPlayer?.pause();
    showScreen(screens.indexOf(playerEntryMode === "home" ? "record-home-screen" : "archive-playlist-detail-screen"));
    return;
  }

  if (action === "back") {
    const currentScreen = screens[currentIndex];
    if (currentScreen === "record-page-screen") {
      showScreen(screens.indexOf("record-home-screen"));
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

































































