<!--
  이 파일은 ADR 표준 템플릿이다. 새 ADR을 만들 때:
  1) 이 파일을 docs/adr/NNNN-kebab-제목.md 로 복사 (NNNN = 다음 4자리 번호, 0 패딩)
  2) 아래 YAML frontmatter(--- 사이)를 채운다  ← 기계(에이전트/index.json)가 읽는 부분
  3) 본문 주석을 지우고 산문을 채운다              ← 사람이 읽는 부분
  4) `pwsh docs/build.ps1` (또는 `bash docs/build.sh`) 실행 → index.json·docs.html·INDEX.md 재생성
  규칙:
  - ADR은 append-only. 한번 accepted된 ADR의 결정/맥락은 고치지 않는다.
    결정이 바뀌면 새 ADR을 쓰고, 이 ADR의 status를 'superseded' + superseded_by: NNNN 으로만 바꾼다.
  - "왜"를 적는 문서다. "지금 어떻게 동작하나"는 docs/spec/ 에 적는다.
  - 상태/날짜/관계는 frontmatter가 단일 진실원이다. 본문에 중복 기재하지 않는다(드리프트 방지).
-->
---
id: "NNNN"                  # 4자리, 0 패딩 (예: "0007"). ADR은 0001부터 독립 번호
type: adr
title: "<결정 제목 — 명사구로>"
status: proposed           # proposed | accepted | rejected | deprecated | superseded
date: YYYY-MM-DD           # 결정/상태변경 절대일자
deciders: [ ]              # 결정 참여자 (예: [DevOps Lead])
supersedes: []             # 이 ADR이 대체하는 옛 ADR 번호들 (예: [3])
superseded_by: null        # 이 ADR을 대체한 새 ADR 번호 (예: 9)
related_adr: [ ]           # 의존/연관 결정 번호 (예: [1, 2])
related_spec: [ ]          # 이 결정이 구현되는 docs/spec id (예: ["0001"])
tags: [ ]                  # 검색/필터 메타 (예: [ci, docs])
---

# NNNN. <결정 제목 — 명사구로>

## 맥락 (Context)

<!--
  왜 이 결정이 필요했나. 해결하려는 문제, 제약(비용/규제/인력), 강제 요인(forces)을
  사실 위주로. 의견이 아니라 상황을 적는다.
-->

## 검토한 선택지 (Options Considered)

<!-- 진지하게 비교한 대안들. 채택 안 한 것도 적어야 "왜 안 했나"가 남는다. -->

| 선택지 | 장점 | 단점 | 판정 |
|---|---|---|---|
| **A. <선택안>** | | | ✅ 채택 |
| B. <대안> | | | ❌ |
| C. <대안> | | | ❌ |

## 결정 (Decision)

<!--
  무엇을 하기로 했나. 단정형 한 문장으로 시작.
  "우리는 ___ 한다." 그 다음 핵심 구성/파라미터를 불릿으로.
-->

## 근거 (Rationale)

<!-- 위 선택지 중 A를 고른 결정적 이유 1~3개. 비용·운영부담·표준화 등 -->

## 결과 (Consequences)

**긍정**
-

**부정 / 트레이드오프**
-

**후속 작업 / 트리거**
- <!-- 이 결정이 만든 TODO, 또는 "X 조건이 되면 재검토" 같은 재평가 트리거 -->

## 미해결 (Open Questions)

<!-- 이 결정에 딸린 미결 항목. 없으면 "없음". -->
