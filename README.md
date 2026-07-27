# ywr-harness (배포본)

`ywr-harness` Claude Code 플러그인의 **배포 전용 레포**입니다. 여기에는 플러그인 산출물만 들어
있고, 정본(canon)과 그 히스토리·결정 기록은 YWR Labs 가 별도로 보관합니다.

## 설치

마켓플레이스는 관리 설정으로 **자동 등록**되므로 등록 명령은 필요 없습니다. 설치만 각자 하면 됩니다.

```
claude plugin install ywr-harness@ywrlabs
```

설치는 강제되지 않습니다 — 원하지 않으면 안 해도 되고, `claude plugin disable ywr-harness` 로
언제든 끌 수 있습니다.

### 전제조건

- `orcait-co` GitHub 조직 멤버 (조직 멤버면 이 레포 접근은 자동입니다)
- GitHub 이 받아주는 SSH 키 — `ssh-agent` 에 올려두거나 패스프레이즈 없는 기본 키가 디스크에
  있으면 됩니다. HTTPS 는 동작하지 않습니다: 마켓플레이스 자동 갱신은 git 크리덴셜 헬퍼를
  끈 상태로 돌기 때문입니다.
- `pwsh` 7 · `node` · `python` 3.9+ (게이트 스크립트와 훅이 씁니다)

### 등록이 안 된 것처럼 보일 때

마켓플레이스 등록은 세션 시작 시 **비동기로** 진행됩니다. 아주 짧게 끝나는 헤드리스 실행
(`claude -p "..."`)은 clone 이 끝나기 전에 종료해서 아무것도 등록하지 않습니다. 대화형 세션을
한 번 띄우면 해결됩니다.

## 이 레포에 PR 을 보내지 마세요

**생성된 산출물**이라 다음 릴리스에서 통째로 덮어씁니다. 결함·요청은 이슈나 PR 이 아니라
johnkim@ywrlabs.com 으로 주세요. 수정은 정본에서 이뤄지고 버전으로 배포됩니다.

급하게 막혔을 때의 정식 탈출구는 포크가 아니라 `claude plugin disable ywr-harness` 입니다.

## 버전

`.claude-plugin/marketplace.json` 의 항목 버전이 진실원입니다.

## 라이선스

**`LICENSE` 를 읽어 주세요.** 저작권은 YWR Labs Inc. 에 있고, 사용은 **orcait-co 내부 사용으로
한정**됩니다. 조직 외부 재배포·공개·제3자 서비스 제공은 서면 허가가 필요합니다.
