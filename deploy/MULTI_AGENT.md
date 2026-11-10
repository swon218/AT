# ATLAS 분석 그래프

## 실행 구조

`ai_agent.graph.ResearchGraph`가 운영 `/run`과 관리자 평가의 공통 진입점이다. `prepare → orchestrator → specialist → review → orchestrator / END`를 LangGraph StateGraph로 구성한다. 총괄이 `delegate_research`의 구조화된 입력으로 담당을 선택한다. 단어별 라우팅은 운영 경로에 없다. 모델과 OpenAI Responses 어댑터는 기존 운영 설정을 사용한다.

LangGraph 1.2.20과 전이 의존성을 기존 uv 해시 잠금파일에 고정했다. Python 3.10에서 기존 OpenAI 3.40.0, Pydantic 2.14.1과 함께 검사한다. StateGraph의 Send와 reducer를 사용한다. 병렬 결과 목록은 합산하고, 검토 단계에서 담당 이름 순으로 근거를 병합한다. 같은 콘텐츠 ID의 서로 다른 근거는 덮어쓰지 않고 실패한다. LangSmith tracing은 실행 범위에서 명시적으로 비활성화한다.

공식 문서는 [Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api), [Orchestrator-worker](https://docs.langchain.com/oss/python/langgraph/workflows-agents), [고정 버전](https://pypi.org/project/langgraph/1.2.20/)을 확인했다.

## 역할과 권한

| 담당 | 실행 가능한 도구 |
| --- | --- |
| 총괄 | delegate_research |
| 뉴스 조사 | resolve_symbol, get_market_context, get_stock_news, get_news_details |
| 일봉 분석 | resolve_symbol, get_market_context, get_stock_indicators, screen_stocks, screen_rsi |
| 알림 설계 | resolve_symbol, get_alert_editor, propose_alert, get_alert_status |

`roles.py`가 실행 권한의 원본이며, 관리자 화면의 `shared/agentArchitecture.json`과 일치하는지 테스트한다. 전문 담당은 다른 담당을 생성하거나 위임할 수 없다. 실행 전에 역할별 도구 이름과 기존 인자 스키마를 검증한다. 전문 담당에는 배정 목표·검증된 공개 종목·관련 근거만 전달하고, 회원별 편집 상태는 알림 담당에게만 제공한다.

Market Data Agent와 Fundamental Research Agent는 향후 도구 연결 후 추가 대상이다. 호출 가능한 등록 목록에는 포함하지 않는다.

## 제한과 부분 결과

기존 `AI_ROUNDS`, `AI_TOOL_CALLS`, `AI_TOKENS`, `AI_MAX_USD`, `AI_SECONDS`, `AI_EXTERNAL_REQUESTS`를 요청 전체에 적용한다. 기본값은 모델 8회, 도구 12회, 토큰 40,000, 추정 $0.25, 120초, 외부 요청 8회다. 위임 함수도 도구 호출 수에 포함한다. 최대 병렬 담당은 2개이며 추가 조사 배치는 2회까지다. 전문 담당은 배치당 최대 6회와 전체 모델 예산 중 먼저 도달하는 제한에서 종료한다. 전문 담당 시간은 전체 제한의 75%와 70초 중 작은 값이다.

모델 호출 직전에 입력 바이트 기반 보수적 토큰 상한과 출력 상한·비용을 예약한다. 모든 분기는 같은 asyncio 이벤트 루프의 await 없는 예약·정산을 공유한다. 외부 요청·종목·기사 한도도 요청별 Budget을 공유한다. 공개 종목 식별과 시장 맥락의 동일 요청은 실행 중 중복을 줄인다. 모델 사용량 누락·타임아웃은 unknown으로 유지하고 불명확한 호출의 상한을 uncertain_* 필드에 보존한다. 새 호출과 자동 재시도는 중단한다. 그래프 노드 retry_policy도 1회로 제한한다.

실패한 담당이 있어도 다른 담당의 실제 근거·범위는 보존한다. 구조화된 보고서에는 배정 입력, 상태, 검증된 findings, 근거·출처, 기준일·조회 시각, 누락·오류 코드, 사용자 확인, 담당별 시간·사용량이 포함된다. 총괄의 최종 주장도 기존 근거 ID·원문 발췌·숫자 검증을 통과해야 한다.

## 영속 상태와 승인

Supabase의 기존 요청·단계·답변·대화와 관심종목 확인 RPC가 영속 상태의 원본이다. 공개 단계는 기존 model/tool/validation 종류에 담당·구조·상태·사용량을 추가하여 저장한다. 최종 답변의 execution에도 담당별 요약을 저장한다. 비공개 내부 추론·모델 reasoning 항목은 저장하지 않는다.

LangGraph 체크포인트와 새 thread_id·재개 API는 추가하지 않았다. 실행 중 그래프 상태만 요청 메모리에 두고, 프로세스 재시작 시 기존 Supabase lease/unknown 경로로 정산한다. 진행 중 유료 호출을 자동 재실행하지 않는다. 동일 요청의 재전송은 Node의 소유권·질문·room 검증과 기존 DB 예약으로 중복 실행을 차단한다. 확인 대기는 기존 DB 카드로 종료되어 HTTP·모델 호출을 유지하지 않는다.

관심종목 예/아니요·20개 한도·중복 클릭·초안 revision과 최종 저장은 기존 DB RPC 및 Node presenter를 그대로 사용한다. 알림 담당이 성공적으로 만든 구조화 결과는 review에서 기존 서버 작성 확인 카드/초안으로 연결한다. 알림 저장·취소·카카오 발송·주문 도구는 추가하지 않는다.

## 평가와 기존 기록

관리자 worker도 동일한 ResearchGraph를 실행한다. 코드 검증은 고정 모델 응답과 격리 DB·뉴스를 사용한다. 실제 모델 품질 평가는 기존의 별도 유료 동의 절차를 유지한다. 아키텍처 버전·모든 역할 프롬프트 hash·위임 및 도구 schema hash·코드 SHA·고정 데이터 hash·동일 모델과 예산을 기록한다.

단일 구조 기준선은 도입 직전 커밋 `0ec1780`과 기존 평가 이력이다. 비교 화면은 같은 사례 revision·평가 모드·데이터 hash·기준 시각·모델·요청 예산인 결과만 직접 비교한다. 구조·프롬프트·코드 변경은 각각의 당시 metadata에 남긴다. 과거 운영 확인 JSON과 평가 이력은 갱신하지 않는다. 실제 모델 기준선과 새 구조를 새로 유료 실행하지 않았으므로 품질 향상 수치는 제시하지 않는다.

## 정리와 DB

전체 도구를 한 프롬프트로 제공하던 `ai_agent/runner.py`를 삭제했다. 현재 사용 중인 답변 검증·렌더링은 `answers.py`로 분리하고 운영·평가가 재사용한다. 기존 Runner 테스트는 같은 운영 그래프와 역할별 fixture로 이동했다. 지표 계산, 일봉 DB 읽기, 뉴스 범위, 인증·회원 권한·사용량 예약·알림 승인 코드는 재사용한다.

신규 SQL·마이그레이션·테이블·체크포인트 저장소·정리 SQL은 필요하지 않다. 기존 model/tool/validation 이벤트 JSON과 answer JSON 범위에 저장하므로 SQL을 재실행하지 않는다. 운영 DB에는 적용하지 않았다.

배포는 `MULTI_AGENT_HERMES.md`를 따른다.
