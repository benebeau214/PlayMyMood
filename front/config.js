// Supabase 클라이언트 설정.
const isLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);

window.PMM_CONFIG = {
  SUPABASE_URL: "https://ekkdbblqpgtsfnzkzmwa.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_Q4726RzJ10JGCuyOperOWA_9bNytKXb",
  // 테스트용: true면 로그인 버튼이 Spotify 대신 익명 로그인을 함
  DEV_MODE: false,
  // 에이전트 서비스(service/main.py) 주소. 로그 저장 후 AI 필드 채우기용.
  AGENT_SERVICE_URL: isLocalhost
    ? "http://127.0.0.1:8000"
    : "https://playmymood.onrender.com",
  // 로그인 시 요청하는 scope.
  SPOTIFY_SCOPES: "streaming user-read-email user-read-private user-modify-playback-state",
};
