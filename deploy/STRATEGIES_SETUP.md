# 전략 저장 배포 (커밋 제목: 1022)

## 1. Supabase에서 실행할 작업

ATLAS 로그인에 사용하는 **동일한 Supabase 프로젝트**의 SQL Editor에서
[`STRATEGIES_SUPABASE.sql`](./STRATEGIES_SUPABASE.sql) 전체를 복사해 실행합니다.

- `public.strategies` 테이블을 추가합니다. 기존 `profiles`, `user_integrations`, `auth.users` 데이터는 변경하지 않습니다.
- `user_id`는 `auth.users.id`를 참조합니다. 회원 탈퇴로 Auth 사용자가 삭제되면 해당 전략도 삭제됩니다.
- 로그인한 사용자는 본인 전략만 조회·추가·수정·삭제할 수 있습니다. 비로그인은 접근할 수 없습니다.
- 같은 사용자에게 대소문자만 다른 동일 이름의 전략은 허용하지 않습니다. 다른 사용자는 같은 이름을 쓸 수 있습니다.
- 수정 시 서버가 `revision`과 `updated_at`을 갱신합니다. 오래된 버전으로 수정·삭제하면 클라이언트가 충돌을 알립니다.
- 같은 SQL을 다시 실행해도 기존 전략은 지우지 않습니다. 이미 별도로 만든 `strategies` 테이블이 있다면 먼저 스키마 충돌을 확인해야 합니다.

실행 후 Table Editor에서 `strategies`와 RLS 활성화를 확인하세요. SQL Editor에서 실행하는 관리자 조회는 일반 사용자 RLS 검증이 아닙니다. 아래 사용자 화면 확인도 수행하세요.

```sql
select to_regclass('public.strategies') as strategies_table;
select relrowsecurity from pg_class
where oid = 'public.strategies'::regclass;
select policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'strategies';
```

## 2. 웹 배포와 사용 확인

GitHub `main` 푸시 후 Vercel 자동 배포가 완료되면 새로고침하세요.
기존 로그인에 쓰는 `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`를 그대로 사용합니다.
브라우저에 `service_role` 키를 추가하지 않습니다. Realtime publication 설정도 필요 없습니다.

1. 로그인 후 실험실에서 지표와 전략 이름을 입력하고 저장합니다.
2. 주식 주문 → 지표 설정 → 저장 전략에서 같은 전략을 선택합니다.
3. 지표 값을 수정해 저장한 뒤 실험실에서 **다시 불러오기**로 확인합니다.
4. 새로고침 후에도 저장 목록이 유지되는지 확인합니다.
5. 다른 이름으로 복사 저장하고, 그 복사본을 삭제해 두 탭 목록에서 함께 사라지는지 확인합니다.
6. 로그아웃 및 다른 계정 로그인 시 이전 사용자의 목록과 편집 내용이 보이지 않는지 확인합니다.

저장 항목: 전략 이름, 지표 조합·수치·색상, 매수·매도 조건과 AND/OR 방식,
초기 자금·수수료·매도세·슬리피지. 조건을 아직 정하지 않은 지표 조합도 저장할 수 있습니다.
종목 코드와 조회 시작·종료일은 전략에 저장하지 않으며 불러올 때 현재 화면의 값을 유지합니다.
전략 저장만으로 실제 주문이나 자동매매가 실행되지는 않습니다.

두 탭은 저장 목록을 즉시 공유합니다. 편집 중인 초안은 탭마다 별도로 유지합니다.
다른 브라우저/기기에서 변경한 경우 창에 다시 포커스하거나 **목록 새로고침**으로 가져옵니다.
이미 불러온 전략은 자동으로 덮어쓰지 않으며 **다시 불러오기**로 최신 내용을 선택합니다.
저장하지 않은 초안은 페이지 새로고침·계정 변경 시 사라집니다.

SQL 실행 전에는 테이블 준비 안내가 표시됩니다. 이때 저장은 실패하며 기존 지표 편집은 가능합니다.
Supabase Data API에서 `public` 스키마가 노출되어 있어야 합니다(기존 profiles 사용 설정과 동일).

## 3. VPS

**이번 기능에 필수 VPS 작업은 없습니다.** 인증된 브라우저가 Supabase Data API를 직접 사용하고
DB의 RLS가 소유권을 강제합니다. 서버 API·환경변수·SQLite·Python·systemd는 추가하거나 바꾸지 않습니다.

VPS의 Git 체크아웃도 맞추고 싶은 경우에만 아래를 Hermes에게 전달하세요.

```text
이번 1022 변경은 Supabase 전략 저장 SQL과 프런트엔드 연결이다.
VPS 런타임 변경은 필요 없고 /opt/atlas의 Git 코드만 최신 main과 동기화해줘.

1. 실행 사용자 atlas의 권한으로 /opt/atlas의 현재 브랜치, HEAD와 작업 트리 상태를 확인해줘.
2. main 브랜치이고 작업 트리가 clean일 때만 git pull --ff-only origin main을 실행해줘.
   로컬 수정 또는 다른 브랜치가 있거나 fast-forward가 불가능하면 덮어쓰거나 reset하지 말고 상황을 보고해줘.
3. 커밋 제목 1022가 포함되었는지 확인하고 적용된 HEAD와 Git 상태를 보고해줘.

이번에는 npm 설치/빌드나 atlas-api 재시작을 할 필요가 없어.
atlas.env, lab.sqlite, 수집 서비스·타이머, 증권사 설정을 변경하지 말고 추가 수집도 실행하지 마.
Supabase SQL은 내가 SQL Editor에서 별도로 실행할 예정이니 VPS에서 실행하지 마.
```

## 로컬 검증

```text
npm ci
npm run test:strategies
npm run test:server
npm run build
```

전략 테스트는 PGlite의 실제 PostgreSQL 엔진에서 SQL 재실행, RLS, 컬럼 권한,
동시 수정/삭제 충돌, 사용자 삭제의 연쇄 삭제를 검증합니다. 운영 DB에는 연결하지 않습니다.
RLS와 컬럼 권한 기준: [Supabase 공식 RLS 문서](https://supabase.com/docs/guides/database/postgres/row-level-security),
[컬럼 권한 문서](https://supabase.com/docs/guides/database/postgres/column-level-security).
