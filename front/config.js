// Supabase 클라이언트 설정.
// SUPABASE_ANON_KEY에는 브라우저에 노출돼도 되는 "공개 키"를 넣습니다.
// (Supabase 새 형식의 publishable 키 sb_publishable_... — 예전 anon key를 대체하는 공개 키)
window.PMM_CONFIG = {
  SUPABASE_URL: "https://ekkdbblqpgtsfnzkzmwa.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_Q4726RzJ10JGCuyOperOWA_9bNytKXb",
  // Web Playback SDK 재생에 필요한 scope (로그인 시 요청)
  SPOTIFY_SCOPES: "streaming user-read-email user-read-private",
};
