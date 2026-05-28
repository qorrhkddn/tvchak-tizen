# TVChak Tizen (TizenBrew module)

Samsung Tizen TV용 TVChak 클라이언트 — TizenBrew의 application 모듈로 동작한다.

검색·상세 페이지 파싱·스트림 추출·Referer 헤더 주입 등 까다로운 부분은
모두 NAS의 **백엔드 프록시 서버**가 처리하고, TV 앱은 그 JSON API만 호출한다.

## 구성

```
package.json    TizenBrew 모듈 매니페스트
app/
  index.html    SPA 진입
  style.css     TV 1920×1080 다크 테마
  app.js        설정/홈/상세/플레이어 + 리모컨 + localStorage
```

화면:
- **설정** — 첫 진입 시 NAS 주소(`http://<NAS_IP>:7777`) 입력 (가상 키보드)
- **홈** — 탭: 영화 / 드라마 / 예능 / 애니 / 검색 / 이어보기 / 즐겨찾기
- **상세** — 에피소드 카드 그리드, 회차별 시청 진행도 표시, 즐겨찾기 토글
- **플레이어** — 풀스크린 `<video>`, ◀▶ 10초 시킹, 위치 자동 저장(5초마다)

## 백엔드(NAS) 셋업

백엔드(시놀로지 등 Docker)는 별도 비공개 리포지토리에서 관리한다.
TV 모듈만 단독 사용은 불가능 — 동일 LAN에 백엔드가 떠 있어야 한다.

백엔드가 제공해야 하는 엔드포인트:

| 경로 | 용도 |
|---|---|
| `GET /api/categories` | 카테고리 목록 |
| `GET /api/mainpage?cat=&page=` | 카테고리별 카드 목록 |
| `GET /api/search?q=` | 검색 결과 |
| `GET /api/detail?u=` | 에피소드 목록 |
| `GET /api/extract?u=` | 스트림 URL + `proxy_url` 반환 |
| `GET /api/domain` / `POST /api/domain/refresh` | 시드 도메인 조회/갱신 |
| `GET /proxy?u=&ref=` | Referer 주입 미디어 중계 |
| `GET /healthz` | 헬스체크 |

응답에는 가능하면 `*_proxy_url` 필드를 같이 포함해서 TV 측이 Referer/CORS를
신경 쓸 일이 없게 한다.

## TV에 설치

### 사전 조건
- Samsung Tizen TV (2017년 이후, Tizen 3.0+)
- 이미 TV에 [TizenBrew](https://github.com/reisxd/TizenBrew)가 설치되어 있어야 한다

### 모듈 등록
TizenBrew Installer 또는 TizenBrew UI의 **Add Module** 항목에서 아래 식별자를 입력:

```
gh/qorrhkddn/tvchak-tizen
```

내부 동작: TizenBrew는 jsDelivr를 통해 `https://cdn.jsdelivr.net/gh/qorrhkddn/tvchak-tizen/package.json`을 받고, 같은 경로 아래 `app/index.html`을 진입점으로 띄운다.

### 첫 실행
앱 진입 → 설정 화면에서 NAS 주소 입력 → 저장 → 사용 시작.

설정값은 TV의 localStorage에 저장된다.

## 리모컨 매핑

| 키 | 동작 |
|---|---|
| 방향키 | 포커스 이동 (플레이어에서는 ◀▶가 10초 시킹) |
| OK | 선택 / 플레이어에서 재생·정지 |
| Return | 이전 화면 |
| ▶ / ⏸ / ⏯ | 플레이어 토글 |
| ⏹ | 플레이어 종료 |
| 빨강 | 설정·검색에서 백스페이스 |
| 노랑 | 검색에서 공백, 설정에서 슬래시 |
| 파랑 | 설정에서 콜론(`:`) |
| 초록 | 설정에서 저장 / 검색에서 검색 실행 |

## 캐시 새로고침

jsDelivr는 같은 경로를 캐싱한다. 코드 수정 후 TV에서 강제 갱신하려면
git 태그 또는 commit SHA로 명시:

```
gh/qorrhkddn/tvchak-tizen@<sha>
```

또는 TizenBrew에서 모듈 제거 후 재등록.

## 라이선스

MIT
