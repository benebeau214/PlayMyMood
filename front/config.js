// Supabase 클라이언트 설정.
// SUPABASE_ANON_KEY에는 브라우저에 노출돼도 되는 "공개 키"를 넣습니다.
// (Supabase 새 형식의 publishable 키 sb_publishable_... — 예전 anon key를 대체하는 공개 키)
window.PMM_CONFIG = {
  SUPABASE_URL: "https://ekkdbblqpgtsfnzkzmwa.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_Q4726RzJ10JGCuyOperOWA_9bNytKXb",
  // 테스트용: true면 로그인 버튼이 Spotify 대신 익명 로그인을 함
  // (Supabase에서 Anonymous sign-ins 활성화 필요). 배포/실사용 전 false로.
  // 실제 재생(Web Playback SDK) 테스트는 익명 로그인으론 안 되므로 false로 둠 — 진짜
  // Spotify 계정으로 로그인해야 provider_token(재생용 access token)이 생김.
  DEV_MODE: false,
  // 에이전트 서비스(service/main.py) 주소. 로그 저장 후 AI 필드 채우기용.
  // 서비스를 안 켜놨으면 호출은 조용히 실패하고 로그 저장 자체는 정상 동작.
  AGENT_SERVICE_URL: "http://localhost:8000",
  // 로그인 시 요청하는 scope.
  // - streaming: Web Playback SDK로 이 브라우저 탭을 재생 기기로 등록
  // - user-modify-playback-state: 그 기기에 실제로 play/pause/skip 명령 전송 (이게 없으면
  //   SDK 연결(ready)까지는 되는데 재생 API 호출이 403으로 조용히 실패함)
  // NOTE: 로그인하는 Spotify 계정이 Premium이 아니면 재생 자체가 불가(account_error).
  //       DEV_MODE 익명 로그인은 실제 Spotify 토큰이 없어서 재생 자체가 항상 비활성.
  //       scope를 바꾼 뒤에는 기존 로그인 세션에 새 scope가 없으므로 반드시 재로그인 필요.
  SPOTIFY_SCOPES: "streaming user-read-email user-read-private user-modify-playback-state",
};
