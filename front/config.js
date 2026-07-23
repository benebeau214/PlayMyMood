// Supabase 클라이언트 설정.
// SUPABASE_ANON_KEY에는 브라우저에 노출돼도 되는 "공개 키"를 넣습니다.
// (Supabase 새 형식의 publishable 키 sb_publishable_... — 예전 anon key를 대체하는 공개 키)
window.PMM_CONFIG = {
  SUPABASE_URL: "https://ekkdbblqpgtsfnzkzmwa.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_Q4726RzJ10JGCuyOperOWA_9bNytKXb",
  // 테스트용: true면 로그인 버튼이 Spotify 대신 익명 로그인을 함
  // (Supabase에서 Anonymous sign-ins 활성화 필요). 배포/실사용 전 false로.
  DEV_MODE: true,
  // 에이전트 서비스(service/main.py) 주소. 로그 저장 후 AI 필드 채우기용.
  // 서비스를 안 켜놨으면 호출은 조용히 실패하고 로그 저장 자체는 정상 동작.
  AGENT_SERVICE_URL: "http://localhost:8000",
  // 로그인 시 요청하는 scope.
  // NOTE: 재생(Web Playback SDK)을 붙일 때 "streaming"을 다시 추가해야 함.
  //       단, "streaming"은 앱 소유자 계정이 Premium이어야 허용됨(아니면 로그인 시 403).
  //       지금은 소유자 Premium 없이 로그인/온보딩부터 테스트하려고 streaming을 뺐음.
  SPOTIFY_SCOPES: "user-read-email user-read-private",
};
