# ADR — Architecture Decision Records

이 디렉터리는 **"왜 이렇게 정했는가"**를 시간순으로 기록하는 **불변(append-only)** 결정 로그다.
"지금 어떻게 동작하는가"는 [`../spec/`](../spec/)에 있다. 둘의 관계는 [`../README.md`](../README.md) 참조.

## 핵심 규칙

1. **append-only** — 한번 `Accepted`된 ADR의 맥락·결정 본문은 **고치지 않는다**.
2. 결정이 바뀌면 → **새 ADR**을 쓰고, 옛 ADR의 상태만 `Superseded`(+`superseded_by: NNNN`)로 바꾼다.
   (옛 결정을 지우면 "왜 바뀌었는지"의 역사가 사라진다. 그게 ADR의 존재 이유다.)
3. ADR은 **롤백하지 않는다** (스펙만 git으로 롤백). 되돌림도 supersede로 기록한다.
4. 번호는 `0001`부터 **독립적으로 증가**시킨다. `0000`은 템플릿(빌드 스캔에서 제외).

## 새 ADR 작성법

```powershell
Copy-Item docs/adr/0000-template.md docs/adr/0003-새-결정-제목.md
# 1) YAML frontmatter 채움(id·status·관계·tags)  2) 본문 산문 작성  3) 관련 스펙과 양방향 연결
pwsh docs/build.ps1   # (또는 bash docs/build.sh) → index.json·docs.html·INDEX.md 재생성
```

상태/날짜/관계는 **frontmatter가 단일 진실원**이다(본문 중복 금지 → 드리프트 방지).

## 상태(status) 값

`proposed` → `accepted` → (`superseded`(+`superseded_by: NNNN`) | `deprecated`) / `rejected`

## 인덱스

자동 생성된 [`../INDEX.md`](../INDEX.md)(목차) 또는 [`../docs.html`](../docs.html)(브라우징)를 본다.
에이전트는 [`../index.json`](../index.json)로 상태·의존 그래프를 질의한다. **이 표는 직접 관리하지 않는다.**
