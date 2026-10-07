# 비밀번호 재설정 설정

## 적용 내용

로그인 창의 **비밀번호를 잊으셨나요?** → 가입 이메일 입력 → 메일 링크 클릭 → 새 비밀번호와 확인 입력 → 변경 완료.

Supabase Auth의 `resetPasswordForEmail`과 `updateUser`를 사용한다. 기존 `auth.users` 계정의 비밀번호만 변경하며 사용자 ID, `profiles`, `user_integrations`, `strategies` 데이터는 유지된다. 비밀번호를 테이블에 직접 저장하거나 기존 비밀번호를 조회하지 않는다.

**SQL 실행, 테이블 추가, RLS 변경, VPS 수정·재시작은 필요 없다.** GitHub `main`에 연결된 프런트엔드 배포가 완료되어야 한다. 기존 Supabase 프런트엔드 환경변수를 그대로 사용한다.

## Supabase에서 직접 확인할 설정

1. **Authentication → URL Configuration**에서 **Site URL**을 실제 운영 프런트엔드 주소로 설정한다.
2. **Redirect URLs**에 다음 주소를 추가하고 저장한다. `https://실제서비스주소`는 브라우저에서 사용하는 정확한 도메인으로 바꾼다. VPS API 주소를 넣지 않는다.

   ```text
   https://실제서비스주소/?auth=reset-password
   ```

   로컬 개발에서도 확인하려면 다음을 추가한다. 다른 주소로 접속한다면 그 주소도 별도 등록한다.

   ```text
   http://127.0.0.1:5173/?auth=reset-password
   http://localhost:5173/?auth=reset-password
   ```

3. **Authentication → Email → Templates → Reset Password**에서 링크가 `{{ .ConfirmationURL }}`를 사용하는지 확인한다. 기본 템플릿이면 수정할 필요 없다. `{{ .SiteURL }}`만 연결하거나 운영 페이지에 직접 연결하면 메일 인증을 거치지 않으므로 재설정이 작동하지 않는다. 예시:

   ```html
   <h2>ATLAS 비밀번호 재설정</h2>
   <p>아래 버튼을 눌러 새 비밀번호를 설정해 주세요.</p>
   <p><a href="{{ .ConfirmationURL }}">비밀번호 재설정</a></p>
   <p>요청한 적이 없다면 이 메일을 무시해 주세요.</p>
   ```

4. **Authentication → Email → SMTP Settings**에서 메일 발송 설정을 확인한다. 프로젝트에 Custom SMTP가 이미 설정되어 있으면 그대로 사용한다. 없다면 일반 회원에게 메일을 보내기 위해 SMTP 제공업체의 발신 이메일, 서버 호스트, 포트, 사용자명, 비밀번호를 등록한다. SMTP 비밀번호는 Supabase 설정 화면에만 입력한다.

Supabase 기본 메일 서비스는 프로젝트 팀에 등록된 이메일만 발송할 수 있고 현재 시간당 2통 제한이 있다. 일반 회원 대상으로 운영하려면 Custom SMTP가 필요하다. 콘솔 버전에 따라 Email Templates / SMTP Settings 메뉴 위치가 조금 다를 수 있다.

## 배포 후 실제 확인

1. 테스트 계정으로 ‘비밀번호 찾기’를 요청하고 받은편지함·스팸함을 확인한다.
2. 메일 링크를 열어 ‘새 비밀번호 설정’이 표시되는지 확인한다. 다른 브라우저에서도 링크를 열 수 있다.
3. 비밀번호 확인을 다르게 입력하면 변경되지 않는지 확인한다. 일치하는 새 비밀번호를 입력해 완료한다.
4. 로그아웃 후 새 비밀번호로 로그인되는지 확인한다. 기존 비밀번호로는 로그인되지 않아야 한다. 기존 닉네임·전략·연동 설정이 그대로인지 확인한다.
5. 이미 사용한 링크나 만료된 링크를 열면 오류와 새 링크 요청 버튼이 나오는지 확인한다. 메일 보안 스캐너가 먼저 링크를 사용하는 경우에도 새 메일을 요청한다.

변경 완료 후 현재 인증 세션은 유지된다. 화면에 성공 문구가 나와도 실제 이메일 수신을 보장하는 것은 아니므로 위 확인을 수행한다. 요청 화면은 가입 여부를 노출하지 않는다.

## 공식 문서

- [Supabase 비밀번호 재설정 API](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail)
- [Redirect URLs 설정](https://supabase.com/docs/guides/auth/redirect-urls)
- [Custom SMTP 설정과 기본 서비스 제한](https://supabase.com/docs/guides/auth/auth-smtp)

## 로컬 검증

```powershell
node --test tests/passwordRecovery.test.js
npm run build
```

로컬 검증은 링크 판별, 인증 초기화 실패, 기존 로그인 세션이 있는 만료 링크, URL 정리 등을 확인한다. 7개 테스트와 프로덕션 빌드가 통과했으며 브라우저에서 로그인 → 비밀번호 찾기, 만료 링크 오류 → 새 링크 요청 → 로그인 복귀를 확인했다. 운영 SMTP 발송과 실제 계정 비밀번호 변경은 Supabase 설정 후 별도 확인해야 한다.
