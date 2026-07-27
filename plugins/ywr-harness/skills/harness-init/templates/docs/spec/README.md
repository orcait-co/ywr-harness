# SPEC — 기술 스펙 (Living Documents)

이 디렉터리는 **"시스템이 지금 어떻게 동작하는가/해야 하는가"**를 적는 **살아있는** 문서다.
**"왜 그렇게 정했는가"**는 [`../adr/`](../adr/)에 있다. 둘의 관계는 [`../README.md`](../README.md) 참조.

## ADR과의 차이 (한 줄 규칙)

> **스펙은 갱신하고, ADR은 고치지 않는다. 스펙이 "왜?"를 물으면 ADR 번호로 가리켜라.**

| | ADR | 스펙 |
|---|---|---|
| 답 | 왜 (point-in-time, 불변) | 지금 어떻게 (living, 가변) |
| 수정 | append-only | 자유 갱신 (git이 이력·롤백 담당) |
| 롤백 | 안 함 (supersede) | `git revert` / `git checkout <commit> -- docs/spec/...` |

## 새 스펙 작성법

```powershell
Copy-Item docs/spec/0000-template.md docs/spec/0003-기능이름.md
# 1) frontmatter 채움(based_on_adr로 결정 연결)  2) 본문 작성  3) 해당 ADR의 related_spec에 역등록
pwsh docs/build.ps1   # (또는 bash docs/build.sh) → index.json·docs.html·INDEX.md 재생성
```

## 인덱스

자동 생성된 [`../INDEX.md`](../INDEX.md) / [`../docs.html`](../docs.html) 참조.
에이전트는 [`../index.json`](../index.json)로 질의한다. **이 표는 직접 관리하지 않는다.**
