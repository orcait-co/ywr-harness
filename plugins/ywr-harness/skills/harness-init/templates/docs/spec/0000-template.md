<!--
  스펙(Spec)은 "지금 시스템이 어떻게 동작하는가/해야 하는가"를 적는 살아있는(living) 문서다.
  - ADR과 반대로 자유롭게 갱신한다(git 히스토리가 변경 추적·롤백을 담당).
  - "왜 이렇게 정했나"는 적지 않는다 → frontmatter based_on_adr로 가리킨다.
  - 새 스펙: 이 파일을 docs/spec/NNNN-kebab-이름.md 로 복사 → frontmatter 채움 → 빌드 실행.
  - 상태/근거 ADR/구현위치는 frontmatter가 단일 진실원이다(본문 중복 금지).
-->
---
id: "NNNN"                 # 4자리 (예: "0002"), spec은 0001부터 독립 번호
type: spec
title: "<기능/컴포넌트 이름>"
status: draft              # draft | active | deprecated
updated: YYYY-MM-DD
based_on_adr: [ ]          # 이 스펙을 정당화하는 ADR 번호 (예: [1, 2])
implements_in: [ ]         # 구현 파일 경로 (예: ["docs/build_docs.py"]), 구현 후 채움
tags: [ ]                  # 검색/필터 메타
---

# SPEC NNNN. <기능/컴포넌트 이름>

## 1. 목적 (Purpose)

<!-- 이 컴포넌트가 무엇을 보장/제공하는가. 1~2문장. -->

## 2. 범위 (Scope)

<!-- 포함 / 비포함 경계. "이건 다루지 않음"을 명시. -->

## 3. 동작 명세 (Behavior)

<!-- 현재형으로. 구현이 따라야 할 규칙·흐름·계약. 표/순서도/의사코드 환영. -->

## 4. 인터페이스 / 데이터 (Interface & Data)

<!-- 명령/스크립트 시그니처, 스키마, 환경변수, 설정 키 등. 구현과 1:1로 맞춘다. -->

## 5. 검증 (Verification)

<!-- 이 스펙을 만족하는지 확인하는 방법 — CI 체크, 수동 점검 항목. -->

## 6. 변경 이력 메모 (Change Notes)

<!-- 큰 변경의 사람용 한 줄 요약(정밀 이력은 git). 예: "2026-07-01 Pages 배포 추가(#2)" -->
