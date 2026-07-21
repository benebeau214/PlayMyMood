# backend

PlayMyMood의 Supabase 백엔드(스키마 마이그레이션, RLS, Storage 설정). `agent/`, `front/`,
`test/`와는 독립적이고 서로 수정하지 않습니다. 스키마 설계 원본은 [`../docs/erd.md`](../docs/erd.md).

## 준비물

- Node.js / npm (이미 설치돼 있으면 생략)
- Supabase 계정 + 원격 프로젝트(이미 생성됨: `ekkdbblqpgtsfnzkzmwa`)

## 셋업

```bash
npm install
npx supabase init          # 최초 1회, supabase/config.toml 생성
npx supabase login          # 브라우저 OAuth, 각자 본인 터미널에서 직접 실행
npx supabase link --project-ref ekkdbblqpgtsfnzkzmwa
```

`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`는 Supabase 대시보드 → Project Settings →
API에서 확인해서 `.env`에 채워 넣으세요(`.env`는 gitignore 처리돼 있습니다).

## 마이그레이션

```bash
npx supabase migration new <이름>     # 새 마이그레이션 파일 생성
npx supabase db push --dry-run         # 적용될 SQL 미리 확인
npx supabase db push                   # 실제 원격 DB에 적용
npx supabase db diff                   # 로컬/원격 스키마 diff 확인
```

## 폴더 구조

```
backend/
  package.json           # supabase CLI 버전 고정
  .env.example / .env
  supabase/
    config.toml
    migrations/           # 순서대로 적용되는 SQL 마이그레이션
```
