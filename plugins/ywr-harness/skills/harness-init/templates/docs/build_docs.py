#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
docs-as-code 생성기 — docs/adr/*.md + docs/spec/*.md (YAML frontmatter + 본문)에서
네 표면(surface)을 한 번에 생성한다:

  - docs/index.json         : 에이전트/기계가 로드하는 구조화 메타 + 의존 그래프
  - docs/INDEX.md           : 사람/에이전트용 경량 자동 목차
  - docs/docs.html          : 사람용 단일 브라우징 HTML (상태 배지 · 메타 패널 · 교차링크)
  - docs/docs.artifact.html : claude.ai Artifact 발행용 fragment (호스트가 문서 골격을 감싼다)

설계 원칙:
  - 진실원은 docs/adr, docs/spec 의 개별 .md (frontmatter + 본문).
    상태/날짜/관계는 frontmatter가 단일 출처 → 산출물(위 4개)은 직접 편집 금지.
  - 외부 의존성 없음(파이썬 표준 라이브러리만). frontmatter는 본 파일의 미니 파서로 처리.
  - 0000-template.md 는 스캔에서 제외.

사용:
  python docs/build_docs.py [YYYY-MM-DD]   (또는 pwsh docs/build.ps1 / bash docs/build.sh)
  python docs/build_docs.py --customer [--version <라벨>]   (고객 배포용 표면만 생성)

브랜딩(선택):
  상단 제목의 정식 소스는 .harness.json 의 docs.site_title 선언이다(ADR 0050) — 레포별 값은
  선언 파일에 산다(ADR 0010). 환경변수 DOCS_SITE_TITLE 은 1회성 오버라이드로만 남는다:
  env 전용이던 시절 harness-init 재실행·CI 재빌드가 커밋된 타이틀을 기본값으로 되돌렸다(이슈
  #43). 둘 다 없으면 "Docs · ADR & Spec".

고객 배포 표면 (ADR 0005):
  frontmatter `audience: customer` 인 문서만(화이트리스트) 골라 단일 자기완결
  docs/customer.html 을 만든다(이메일 첨부용). 기본값은 internal — 내부 문서는
  절대 이 표면에 섞이지 않는다. 제목은 DOCS_CUSTOMER_TITLE(미설정 시
  DOCS_SITE_TITLE + " — 고객 배포판"). --version 은 헤더 버전 스탬프에만 쓰인다.

고객 코퍼스 표면 (ADR 0060):
  `.harness.json` 의 `docs.customer` 가 선언되면(null이 아니면), `docs/customer/<Program>/
  {spec.md, user-guide.md, release-notes.md}` 프로그램 단위 코퍼스에서 repo 전체를 아우르는
  단일 `docs/customer.artifact.html`(+ 선택 `docs/PROJECTS.md`)을 함께 생성한다. 선언은
  `scripts/harness/harness_config.py` (벤더 사본)의 `customer_decl()` 만이 검증한다 — 이
  빌더는 그 리더를 import 하며, 선언은 있는데 리더를 import 할 수 없으면 조용히 4-표면
  빌드로 돌아가지 않고 즉시 실패한다(ADR 0060 — "고객 표면이 조용히 stale해지는" 결함군).
  위 audience 화이트리스트 표면(docs/customer.html)과는 완전히 별개다.

요구사항: Python 3.9+ (표준 라이브러리만, 외부 의존성 0). CI 러너는 3.12 로 고정한다.

Copyright (c) 2026 YWR Labs Inc. All rights reserved.
Author: Hyungjun Kim (John Kim) <johnkim@ywrlabs.com>
"""
import datetime
import functools
import hashlib
import html as _html
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

ROOT = os.path.dirname(os.path.abspath(__file__))
ADR_DIR = os.path.join(ROOT, "adr")
SPEC_DIR = os.path.join(ROOT, "spec")
OUT_JSON = os.path.join(ROOT, "index.json")
OUT_INDEX_MD = os.path.join(ROOT, "INDEX.md")
OUT_HTML = os.path.join(ROOT, "docs.html")
OUT_ARTIFACT = os.path.join(ROOT, "docs.artifact.html")
OUT_CUSTOMER = os.path.join(ROOT, "customer.html")
OUT_CUSTOMER_ARTIFACT = os.path.join(ROOT, "customer.artifact.html")
OUT_PROJECTS = os.path.join(ROOT, "PROJECTS.md")

SCHEMA_VERSION = "docs-as-code/1"


@functools.lru_cache(maxsize=1)
def _find_declaration():
    """`.harness.json` 을 ROOT 에서 위로 걸어 올라가며 찾는다 — (repo_root, raw_dict_or_None).

    _resolve_site_title (ADR 0050) 과 _load_customer_decl (ADR 0060) 이 공유하는 단일 워크다:
    두 개의 워크 구현은 pjems 포크가 겪은 바로 그 발산 실패 모드다. 레포 경계(디렉토리에
    .git)에서 멈춘다 — 계속 오르면 무관한 상위 트리의 선언을 조용히 입는다(리뷰 2026-08-12,
    medium). 읽기 실패·비-object 값은 stderr 로 보고하고 (root, None) 을 돌려준다 — 조용한
    리버트가 이 함수가 없애려는 결함이므로, 보고는 하되 호출자의 판단(빌드 진행 여부)은
    막지 않는다. 프로세스 안에서 한 번만 걷도록 캐시한다(같은 경고가 사이트 타이틀 해석과
    고객 선언 로드 양쪽에서 중복 출력되는 것도 막는다) — 파일시스템 상태는 한 프로세스
    실행 동안 불변이라는 가정 위에서만 안전하다.
    """
    d = ROOT
    while True:
        decl_path = os.path.join(d, ".harness.json")
        if os.path.isfile(decl_path):
            break
        # .git 은 디렉토리(일반)일 수도 파일(worktree/submodule)일 수도 있어 exists 로 본다.
        if os.path.exists(os.path.join(d, ".git")):
            return d, None
        parent = os.path.dirname(d)
        if parent == d:
            return d, None
        d = parent
    try:
        with open(decl_path, encoding="utf-8") as f:
            decl = json.load(f)
    except (OSError, ValueError) as e:
        print("warn: .harness.json unreadable (%s)" % type(e).__name__, file=sys.stderr)
        return d, None
    if not isinstance(decl, dict):
        return d, None
    return d, decl


def _resolve_site_title():
    """사이트 타이틀 해석 (ADR 0050): env 오버라이드 → .harness.json docs.site_title → 기본값.

    선언이 정식 소스다 — env 전용이던 시절, 레포별 값을 알 수 없는 호출자(harness-init 재실행,
    CI)가 커밋된 docs.html/<title> 을 기본값으로 되돌렸다(이슈 #43). DOCS_SITE_TITLE 은 1회성
    오버라이드로만 남는다. 검증은 게이트 계층의 일이고, 여기서 읽는 값은 이스케이프를 거쳐 HTML
    로만 가는 표시용 문자열이다(ADR 0012의 free-string 기준)."""
    env = os.environ.get("DOCS_SITE_TITLE")
    if env:
        return env
    _root, decl = _find_declaration()
    if decl is None:
        return "Docs · ADR & Spec"
    docs = decl.get("docs") if isinstance(decl, dict) else None
    title = docs.get("site_title") if isinstance(docs, dict) else None
    if isinstance(title, str) and title.strip():
        return title.strip()
    if title is not None and not isinstance(title, str):
        print("warn: .harness.json docs.site_title is not a string -- default site title used",
              file=sys.stderr)
    return "Docs · ADR & Spec"


SITE_TITLE = _resolve_site_title()
COPYRIGHT = "© 2026 YWR Labs Inc. All rights reserved."

FILE_RE = re.compile(r"^\d{4}-.*\.md$")

STATUS_LABEL = {
    "proposed": "Proposed", "accepted": "Accepted", "rejected": "Rejected",
    "deprecated": "Deprecated", "superseded": "Superseded",
    "draft": "Draft", "active": "Active",
}


# ---------------------------------------------------------------- frontmatter
def split_frontmatter(text):
    """frontmatter 블록 추출 — (block | None, rest) 반환.

    규칙(CRLF 정규화 · 선두 HTML 주석 스킵 · 여는 '---' 줄 · 닫는 줄은 strip() == '---')은
    fm_digest() 와 scripts/harness/verify_map.py 의 재계산 사본이 공유하는 계약이다(ADR 0043):
    여기를 바꾸면 그쪽도 함께 바꾸고, 페어링 셀프테스트(build-docs.selftest.ps1)로 고정할 것.
    """
    text = text.replace("\r\n", "\n")
    # 선두 HTML 주석 + 그 뒤 frontmatter → 주석 스킵(흔한 온보딩 함정 방지)
    lead = re.match(r"\s*<!--.*?-->\s*", text, re.DOTALL)
    if lead and text[lead.end():].startswith("---\n"):
        text = text[lead.end():]
    if not text.startswith("---\n"):
        return None, text
    lines = text.split("\n")
    # 닫는 펜스는 '정확히 --- 인 줄'로 매칭한다(----  같은 오타에 끌려가지 않도록).
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            return "\n".join(lines[1:idx]), "\n".join(lines[idx + 1:])
    return None, text


def parse_frontmatter(text):
    """파일 선두의 --- ... --- YAML 서브셋을 dict로. (meta, body) 반환.

    템플릿 복사본이 frontmatter 앞에 설명용 <!-- ... --> 주석을 남겨도 동작하도록,
    블록 추출 규칙은 split_frontmatter 가 단독 소유한다.
    """
    block, rest = split_frontmatter(text)
    if block is None:
        return {}, rest
    meta = {}
    for line in block.split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9_]+)\s*:\s*(.*)$", line)
        if not m:
            continue
        meta[m.group(1)] = _parse_value(m.group(2).strip())
    return meta, rest


def _parse_value(v):
    # 따옴표로 시작하면 인용 문자열로 보존 (예: id "0001")
    if v.startswith('"') or v.startswith("'"):
        q = v[0]
        end = v.find(q, 1)
        if end != -1:
            return v[1:end]
        return v.strip(q)
    # 인라인 주석 컷 — 공백 뒤의 '#'만 주석으로 본다(값에 포함된 '#'은 보존: URL#frag 등)
    cm = re.search(r"\s#", v)
    if cm:
        v = v[:cm.start()].strip()
    if v == "" or v.lower() == "null" or v.lower() == "~":
        return None
    if v.startswith("[") and v.endswith("]"):
        inner = v[1:-1].strip()
        if not inner:
            return []
        out = []
        for item in inner.split(","):
            item = item.strip()
            if item == "":
                continue
            quoted = item[:1] in ('"', "'")
            item = item.strip('"').strip("'")
            # 따옴표 없는 순수 정수만 int로 (따옴표가 있으면 id 문자열로 보존: "0001")
            out.append(int(item) if (not quoted and re.fullmatch(r"-?\d+", item)) else item)
        return out
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    return v


# --------------------------------------------------------------- md -> html
def esc(text):
    # 본문·속성값 양쪽에서 안전하도록 따옴표까지 이스케이프(속성 breakout 방지)
    return (str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


def inline(text):
    codes = []

    def stash(m):
        codes.append(m.group(1))
        return "\x00%d\x00" % (len(codes) - 1)

    def _link(m):
        href = m.group(2)
        # 신뢰 못 할 스킴은 무력화 (이미 esc 통과한 텍스트라 따옴표는 안전)
        if re.match(r"\s*javascript:", href, re.I):
            href = "#"
        return '<a href="%s">%s</a>' % (href, m.group(1))

    text = re.sub(r"`([^`]+)`", stash, text)
    text = esc(text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", _link, text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", text)
    text = re.sub(r"\x00(\d+)\x00", lambda m: "<code>%s</code>" % esc(codes[int(m.group(1))]), text)
    return text


def _diff_line(line):
    """```diff 펜스 한 줄 → 클래스 부착 (+추가 / -삭제 / @@헝크; +++/--- 헤더 제외). 릴리즈
    노트의 소스 변경 표시(client-pjems 포크에서 상향, ADR 0060)."""
    e = esc(line)
    if line.startswith("+") and not line.startswith("+++"):
        return '<span class="d-add">%s</span>' % e
    if line.startswith("-") and not line.startswith("---"):
        return '<span class="d-del">%s</span>' % e
    if line.startswith("@@"):
        return '<span class="d-hunk">%s</span>' % e
    return e


def _is_list_continuation(line):
    """목록 항목의 하드랩 계속줄: 들여쓰기로 시작하고 새 구조(마커·펜스·표·헤딩·
    인용·수평선)를 열지 않는 줄. 마커 없는 계속줄이 목록을 닫고 별도 <p>로 떨어져
    문장이 잘려 보이던 사고의 방지책(client-pjems 포크에서 상향, ADR 0060)."""
    if not re.match(r"^[ \t]+\S", line):
        return False
    s = line.strip()
    if re.match(r"^[-*]\s+", s) or re.match(r"^\d+\.\s+", s):
        return False
    if s.startswith(("```", ">", "#", "|")) or re.match(r"^-{3,}$", s):
        return False
    return True


def is_table_sep(line):
    return bool(re.match(r"^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$", line)) and "-" in line


def split_row(line):
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def convert_body(lines):
    out = []
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        stripped = line.strip()
        if stripped == "":
            i += 1
            continue
        if stripped.startswith("<!--"):  # HTML 주석 블록은 통째로 건너뛴다(렌더 안 함)
            while i < n and "-->" not in lines[i]:
                i += 1
            i += 1
            continue
        if re.match(r"^-{3,}$", stripped):
            out.append("<hr>")
            i += 1
            continue
        if stripped.startswith("```"):
            lang = stripped[3:].strip().lower()
            i += 1
            buf = []
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            if lang == "diff":
                out.append('<pre class="diff">%s</pre>' % "\n".join(_diff_line(l) for l in buf))
            else:
                out.append("<pre>%s</pre>" % esc("\n".join(buf)))
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            level = len(m.group(1))
            out.append("<h%d>%s</h%d>" % (level, inline(m.group(2).strip()), level))
            i += 1
            continue
        if "|" in line and i + 1 < n and is_table_sep(lines[i + 1]):
            header = split_row(line)
            i += 2
            rows = []
            while i < n and "|" in lines[i] and lines[i].strip() != "":
                rows.append(split_row(lines[i]))
                i += 1
            # 표는 스크롤 래퍼로 감싼다: <table display:block> 방식은 테두리 박스만
            # 100% 폭이 되고 행은 콘텐츠 폭에서 끝나 우측이 잘려 보인다(client-pjems
            # 포크에서 상향, ADR 0060).
            t = ['<div class="tblwrap"><table>',
                 "<thead><tr>%s</tr></thead>" % "".join("<th>%s</th>" % inline(c) for c in header), "<tbody>"]
            for row in rows:
                t.append("<tr>%s</tr>" % "".join("<td>%s</td>" % inline(c) for c in row))
            t += ["</tbody>", "</table></div>"]
            out.append("\n".join(t))
            continue
        if stripped.startswith(">"):
            raw = []
            while i < n and lines[i].strip().startswith(">"):
                raw.append(lines[i])
                i += 1
            inner = [re.sub(r"^\s*>\s?", "", r) for r in raw]
            buf = [inline(x.rstrip()) for x in inner if x.strip() != ""]
            out.append("<blockquote>%s</blockquote>" % "<br>\n".join(buf))
            continue
        if re.match(r"^\s*[-*]\s+", line):
            items = []
            while i < n and re.match(r"^\s*[-*]\s+", lines[i]):
                item = re.sub(r"^\s*[-*]\s+", "", lines[i]).rstrip()
                i += 1
                while i < n and _is_list_continuation(lines[i]):
                    item += " " + lines[i].strip()
                    i += 1
                items.append(inline(item))
            out.append("<ul>\n%s\n</ul>" % "\n".join("<li>%s</li>" % it for it in items))
            continue
        if re.match(r"^\s*\d+\.\s+", line):
            # 소스의 시작 번호를 보존한다(start 속성).
            start = int(re.match(r"^\s*(\d+)\.", line).group(1))
            items = []
            while i < n and re.match(r"^\s*\d+\.\s+", lines[i]):
                item = re.sub(r"^\s*\d+\.\s+", "", lines[i]).rstrip()
                i += 1
                while i < n and _is_list_continuation(lines[i]):
                    item += " " + lines[i].strip()
                    i += 1
                items.append(inline(item))
            attr = ' start="%d"' % start if start != 1 else ""
            out.append("<ol%s>\n%s\n</ol>" % (attr, "\n".join("<li>%s</li>" % it for it in items)))
            continue
        buf = []
        while i < n:
            cur = lines[i]
            cs = cur.strip()
            if cs == "" or cs.startswith("<!--") or re.match(r"^-{3,}$", cs) \
               or cs.startswith(">") or cs.startswith("```") \
               or re.match(r"^#{1,6}\s+", cur) or re.match(r"^\s*[-*]\s+", cur) \
               or re.match(r"^\s*\d+\.\s+", cur) \
               or ("|" in cur and i + 1 < n and is_table_sep(lines[i + 1])):
                break
            buf.append((cur.strip(), cur.endswith("  ")))
            i += 1
        # inline()은 하드랩 병합 후에 적용한다 — 줄을 각각 inline()하면 줄 경계를
        # 가로지르는 **굵게**/`코드` 스팬이 매칭되지 않아 마크다운 문자가 리터럴로
        # 노출된다. 두 칸 공백 하드브레이크는 유지(client-pjems 포크에서 상향, ADR 0060).
        chunks, curch = [], []
        for text, hard_break in buf:
            curch.append(text)
            if hard_break:
                chunks.append(" ".join(curch))
                curch = []
        if curch:
            chunks.append(" ".join(curch))
        out.append("<p>%s</p>" % "<br>".join(inline(c) for c in chunks))
    return "\n".join(out)


def _strip_leading_h1(body_lines):
    """본문 선두의 H1(문서 제목 중복) 한 줄을 제거한다. frontmatter가 title의 단일
    출처이므로, 렌더러가 이미 별도로 제목을 그리는 표면(내부·고객 모두) 본문에 남아있는
    중복 H1을 무시해야 한다. collect() 와 collect_customer_docs() 가 공유한다."""
    k = 0
    while k < len(body_lines) and body_lines[k].strip() == "":
        k += 1
    if k < len(body_lines) and re.match(r"^#\s+", body_lines[k]):
        del body_lines[k]
    return body_lines


# --------------------------------------------------------------- collection
def collect(directory):
    entries = []
    # id -> filename. 중복은 같은 kind(디렉토리) 안에서만 충돌이다 — graph 키가 adr:/spec:
    # 접두라 kind 간 같은 번호는 합법이고, collect 는 디렉토리 단위로 불리므로 여기 두면 된다.
    seen = {}
    if not os.path.isdir(directory):
        return entries
    for fn in sorted(os.listdir(directory)):
        if not FILE_RE.match(fn) or fn.startswith("0000-"):
            continue
        path = os.path.join(directory, fn)
        # 읽기 실패(권한·디렉토리가 문서명 형상·비 UTF-8)는 트레이스백이 아니라 결정론적 명명
        # 거부다 — 중복 id 거부와 같은 원칙(리뷰 2026-08-10 low). 빌더는 깨진 코퍼스를 조용히
        # 우회하지 않는다; fm_digest 쪽의 관용(replace·None)은 자문 재계산용이라 역할이 다르다.
        try:
            with open(path, "r", encoding="utf-8") as f:
                meta, body = parse_frontmatter(f.read())
        except (OSError, UnicodeDecodeError) as e:
            sys.exit("[오류] 읽을 수 없는 문서: %s (%s) — 권한/인코딩/이름만 문서인 디렉토리를 "
                     "확인하세요. 깨진 코퍼스로는 빌드하지 않습니다." % (fn, type(e).__name__))
        # id는 항상 문자열로 정규화한다. 따옴표 없이 0001로 적으면 int 1로 파싱되어
        # DOM id·딕셔너리 키 생성에서 깨지므로(숫자면 4자리 0 패딩).
        if isinstance(meta.get("id"), int):
            meta["id"] = "%04d" % meta["id"]
        elif meta.get("id") is not None:
            meta["id"] = str(meta["id"])
        if not meta.get("id"):
            print("  [경고] frontmatter id 없음, 건너뜀: %s" % fn)
            continue
        # 중복 id 는 결정론적 빌드 실패다(ADR 0043). 병렬 브랜치가 각자 '다음 번호'를 잡으면
        # 양쪽 PR 은 각자의 드리프트 게이트를 통과하고, 병합된 코퍼스에서만 충돌이 드러난다 —
        # 조용히 진행하면 graph 딕셔너리가 한쪽 링크를 덮어쓴 index 가 커밋된다.
        if meta["id"] in seen:
            sys.exit("[오류] id 중복: %s 와 %s 가 같은 id '%s' 를 선언합니다 — 병렬 브랜치가 "
                     "각자 '다음 번호'를 잡은 병합의 전형입니다(ADR 0043). 한쪽을 다음 빈 번호로 "
                     "옮기고 참조(related_*, based_on_adr, supersedes)를 갱신한 뒤 재빌드하세요."
                     % (seen[meta["id"]], fn, meta["id"]))
        seen[meta["id"]] = fn
        # audience 없으면 internal(기본, 안전한 쪽). customer 표면은 이 값이
        # 정확히 "customer" 인 문서만 화이트리스트로 골라간다(ADR 0005).
        if meta.get("audience") != "customer":
            meta["audience"] = "internal"
        meta["_file"] = fn
        meta["_relpath"] = os.path.relpath(path, ROOT).replace("\\", "/")
        # 본문 선두의 H1(문서 제목 중복)은 제거 — HTML 뷰어의 doc-h 가 이미 제목을 표시.
        meta["_body_html"] = convert_body(_strip_leading_h1(body.split("\n")))
        entries.append(meta)
    return entries


# --------------------------------------------------------------- json + index
def fm_digest():
    """코퍼스 frontmatter 의 결정론적 다이제스트 — index.json 의 `fm_digest` 스탬프(ADR 0043).

    파일 규칙은 collect() 와 동일(NNNN-*.md, 0000- 제외, 정렬 순회)하고 블록 규칙은
    split_frontmatter 와 동일하다. 본문만의 수정은 다이제스트를 바꾸지 않는다 — append-only
    ADR 부록이 index 재빌드를 요구하면 안 된다는, 리트로 BUILD 체크와 같은 원칙.
    scripts/harness/verify_map.py 가 같은 규칙으로 재계산해 스테일 신호를 만든다: 두 구현은
    페어링 셀프테스트(build-docs.selftest.ps1)로 고정된다 — 한쪽만 바꾸면 그 테스트가 깨진다.
    위치 계약: adr/·spec/ 은 이 파일(그리고 이 파일이 쓰는 index.json)의 형제 디렉토리다 —
    verify_map 은 선언된 index 경로의 부모에서 코퍼스를 유도한다(docs/ 하드코딩 금지,
    리뷰 2026-08-10 high).
    """
    h = hashlib.sha256()
    for kind, directory in (("adr", ADR_DIR), ("spec", SPEC_DIR)):
        if not os.path.isdir(directory):
            continue
        for fn in sorted(os.listdir(directory)):
            if not FILE_RE.match(fn) or fn.startswith("0000-"):
                continue
            try:
                with open(os.path.join(directory, fn), "r", encoding="utf-8", errors="replace") as f:
                    block, _ = split_frontmatter(f.read())
            except OSError:
                block = None
            h.update(("%s/%s\0%s\0" % (kind, fn, block or "")).encode("utf-8"))
    return h.hexdigest()


def build_json(adrs, specs, digest=None):
    def strip(e):
        d = {k: v for k, v in e.items() if not k.startswith("_")}
        d["path"] = e.get("_relpath")
        return d
    graph = {}
    for e in adrs:
        graph["adr:" + e["id"]] = {
            "related_adr": e.get("related_adr") or [],
            "related_spec": e.get("related_spec") or [],
            "superseded_by": e.get("superseded_by"),
        }
    for e in specs:
        graph["spec:" + e["id"]] = {"based_on_adr": e.get("based_on_adr") or []}
    out = {
        "schema": SCHEMA_VERSION,
        "counts": {"adr": len(adrs), "spec": len(specs)},
        "adr": [strip(e) for e in adrs],
        "spec": [strip(e) for e in specs],
        "graph": graph,
    }
    # 스키마는 docs-as-code/1 그대로 — 추가 키이고 모든 소비자가 .get 으로 읽는다(ADR 0043).
    if digest:
        out["fm_digest"] = digest
    return out


def build_index_md(adrs, specs):
    L = ["# docs 인덱스 (자동 생성 — 직접 편집 금지)", "",
         "> `python docs/build_docs.py` 로 재생성. 진실원은 adr/·spec/ 의 .md frontmatter.", ""]
    L.append("## ADR (%d)" % len(adrs))
    L.append("")
    L.append("| # | 제목 | 상태 | 날짜 | 관련 스펙 |")
    L.append("|---|---|---|---|---|")
    for e in adrs:
        spec = ", ".join((e.get("related_spec") or [])) or "—"
        L.append("| [%s](%s) | %s | %s | %s | %s |" % (
            e["id"], e["_relpath"], e.get("title", ""),
            STATUS_LABEL.get(e.get("status"), e.get("status") or "—"),
            e.get("date") or "—", spec))
    L += ["", "## SPEC (%d)" % len(specs), "",
          "| # | 스펙 | 상태 | 근거 ADR |", "|---|---|---|---|"]
    for e in specs:
        based = ", ".join("#%s" % a for a in (e.get("based_on_adr") or [])) or "—"
        L.append("| [%s](%s) | %s | %s | %s |" % (
            e["id"], e["_relpath"], e.get("title", ""),
            STATUS_LABEL.get(e.get("status"), e.get("status") or "—"), based))
    return "\n".join(L) + "\n"


# --------------------------------------------------------------- html
CSS = """
:root{
  --bg:#0f1117;--surface:#171a23;--surface-2:#1e222e;--line:#2a2f3d;--line-soft:#222633;
  --ink:#e8eaf0;--ink-soft:#a8aec1;--ink-dim:#6f7589;--accent:#6d8bff;--accent-soft:#243056;
  --ok-bg:#143222;--ok:#5fd29a;--warn-bg:#3a3015;--warn:#e8b54a;--bad-bg:#3a1d1f;--bad:#f08a8a;
  --radius:12px;--mono:'SFMono-Regular',ui-monospace,'Cascadia Code',Consolas,monospace;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font:15px/1.68 -apple-system,'Segoe UI',Roboto,'Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}

/* ── 상단 바 + 탭 ───────────────────────────────────── */
header.app{position:sticky;top:0;z-index:20;background:rgba(15,17,23,.86);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.app-in{max-width:1280px;margin:0 auto;padding:16px 28px 0}
.app-title{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
.app-title h1{margin:0;font-size:19px;font-weight:680;letter-spacing:-.01em}
.app-title .sub{color:var(--ink-dim);font-size:12.5px}
footer.cpy{max-width:1280px;margin:0 auto;padding:0 28px 32px;color:var(--ink-dim);font-size:12px}
.app-title .sub code{color:var(--ink-soft)}
.tabs{display:flex;gap:4px;margin-top:14px}
.tab{appearance:none;border:0;background:none;color:var(--ink-soft);font:inherit;font-size:14px;font-weight:560;padding:9px 16px;border-radius:8px 8px 0 0;cursor:pointer;border-bottom:2px solid transparent;display:flex;align-items:center;gap:7px}
.tab:hover{color:var(--ink);background:var(--surface)}
.tab[aria-selected=true]{color:var(--ink);border-bottom-color:var(--accent)}
.tab .ct{font-size:11px;font-weight:700;color:var(--ink-dim);background:var(--surface-2);border-radius:999px;padding:1px 8px}
.tab[aria-selected=true] .ct{color:var(--accent);background:var(--accent-soft)}

main{max-width:1280px;margin:0 auto;padding:24px 28px 64px}
.tabpanel{display:none}.tabpanel.on{display:block}

/* ── 문서 뷰(2-pane) ─────────────────────────────────── */
.docview{display:grid;grid-template-columns:300px 1fr;gap:26px;align-items:start}
.doclist{position:sticky;top:120px;max-height:calc(100vh - 144px);overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:4px}
.search{position:relative}
.search input{width:100%;background:var(--surface);border:1px solid var(--line);color:var(--ink);border-radius:9px;padding:9px 12px 9px 32px;font:inherit;font-size:13.5px}
.search input:focus{outline:none;border-color:var(--accent)}
.search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--ink-dim)}
.docitem{text-align:left;appearance:none;cursor:pointer;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:11px 13px;color:var(--ink);display:flex;flex-direction:column;gap:5px;transition:border-color .12s,background .12s}
.docitem:hover{border-color:#3a4256}
.docitem[aria-current=true]{border-color:var(--accent);background:var(--accent-soft)}
.docitem .di-top{display:flex;align-items:center;gap:8px}
.docitem .di-id{font:600 11.5px/1 var(--mono);color:var(--ink-dim)}
.docitem .di-title{font-size:13.5px;font-weight:560;line-height:1.4}
.docitem.hidden{display:none}

.docmain{min-width:0}
.doc{display:none;animation:fade .18s ease}.doc.on{display:block}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.doc-h{font-size:23px;line-height:1.3;margin:0 0 4px;font-weight:700;letter-spacing:-.015em}
.doc-kicker{font:600 12px/1 var(--mono);letter-spacing:.06em;color:var(--accent);text-transform:uppercase;margin-bottom:10px}

/* ── 메타 패널 ───────────────────────────────────────── */
.meta{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px 22px;font-size:13px;color:var(--ink-soft);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px 20px;margin:14px 0 8px}
.meta span{display:block}.meta b{display:block;color:var(--ink-dim);font-weight:600;font-size:11px;letter-spacing:.05em;text-transform:uppercase;margin-bottom:2px}
.tags{margin:10px 0 22px}
.tag{display:inline-block;background:var(--surface-2);color:var(--ink-soft);border:1px solid var(--line-soft);border-radius:7px;padding:2px 9px;font-size:12px;margin:0 5px 5px 0}
.badge{display:inline-block;padding:2px 11px;border-radius:999px;font-size:11.5px;font-weight:700;letter-spacing:.02em}
.s-accepted,.s-active{background:var(--ok-bg);color:var(--ok)}
.s-proposed,.s-draft{background:var(--warn-bg);color:var(--warn)}
.s-superseded,.s-deprecated,.s-rejected{background:var(--bad-bg);color:var(--bad)}
.s-unknown{background:var(--surface-2);color:var(--ink-soft)}

/* ── 본문 마크다운 ───────────────────────────────────── */
.body{font-size:14.5px}
.body h1{font-size:19px;margin:30px 0 10px}.body h2{font-size:17px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line-soft)}
.body h3{font-size:15px;margin:20px 0 6px}.body h4{font-size:13.5px;color:var(--ink-soft);margin:16px 0 4px}
.body p{margin:9px 0}.body ul,.body ol{margin:9px 0;padding-left:22px}.body li{margin:3px 0}
.body .tblwrap{margin:14px 0;overflow-x:auto;border:1px solid var(--line);border-radius:10px}
.body table{border-collapse:collapse;width:100%;font-size:13px}
.body th,.body td{border-bottom:1px solid var(--line-soft);border-right:1px solid var(--line-soft);padding:8px 12px;text-align:left;vertical-align:top}
.body th{background:var(--surface-2);color:var(--ink);font-weight:640;white-space:nowrap}
.body tr:last-child td{border-bottom:0}.body td:last-child,.body th:last-child{border-right:0}
.body pre{background:#0b0d13;border:1px solid var(--line);color:#cdd3e8;padding:15px 17px;border-radius:10px;overflow-x:auto;font:12.5px/1.6 var(--mono)}
.body pre .d-add{color:var(--ok)}.body pre .d-del{color:var(--bad)}.body pre .d-hunk{color:var(--accent)}
.body code{background:var(--surface-2);color:#cdd3e8;padding:1.5px 6px;border-radius:5px;font:.88em var(--mono)}
.body pre code{background:none;padding:0}
.body blockquote{margin:12px 0;padding:10px 16px;border-left:3px solid var(--accent);background:var(--surface);border-radius:0 8px 8px 0;color:var(--ink-soft)}
.body hr{border:0;border-top:1px solid var(--line-soft);margin:22px 0}
.body strong{color:var(--ink);font-weight:680}

/* ── 개요 대시보드 ───────────────────────────────────── */
.ov-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin:6px 0 28px}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px}
.stat .n{font-size:30px;font-weight:740;letter-spacing:-.02em}.stat .l{color:var(--ink-dim);font-size:12.5px;margin-top:2px}
.ov-sec{font-size:13px;font-weight:640;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.06em;margin:26px 0 12px}
.ov-table{width:100%;border-collapse:collapse;font-size:13.5px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.ov-table th,.ov-table td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--line-soft)}
.ov-table th{background:var(--surface-2);color:var(--ink-soft);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.ov-table tr:last-child td{border-bottom:0}
.ov-table tr.clickable{cursor:pointer}.ov-table tr.clickable:hover td{background:var(--surface-2)}
.ov-table .lnk{color:var(--accent);font:600 12.5px/1 var(--mono)}
.rel{color:var(--ink-dim);font-size:12.5px}.rel a{font-family:var(--mono);font-size:12px}

@media(max-width:860px){
  .docview{grid-template-columns:1fr}
  .doclist{position:static;max-height:none;flex-direction:row;flex-wrap:wrap;overflow:visible}
  .doclist .search{flex-basis:100%}.docitem{flex:1 1 200px}
}
@media print{
  header.app{position:static}.tabs,.doclist,.tab{display:none}
  .tabpanel{display:block!important}.doc{display:block!important;page-break-after:always}
  body{background:#fff;color:#000}
}
"""


def badge(status):
    label = STATUS_LABEL.get(status, status or "?")
    return '<span class="badge s-%s">%s</span>' % (esc(status or "unknown"), esc(label))


def link_adr(num, by_id):
    sid = "%04d" % num if isinstance(num, int) else str(num)
    if sid in by_id:
        return '<a href="#adr-%s">#%s</a>' % (esc(sid), esc(str(num)))
    return "#%s" % esc(str(num))


def link_spec(sid, spec_ids):
    sid = str(sid)
    if sid in spec_ids:
        return '<a href="#spec-%s">spec %s</a>' % (esc(sid), esc(sid))
    return "spec %s" % esc(sid)


def meta_panel(e, adr_ids, spec_ids, customer=False):
    rows = ['<b>상태</b> %s' % badge(e.get("status"))]
    if e.get("date"):
        rows.append("<b>날짜</b> %s" % esc(str(e["date"])))
    if e.get("updated"):
        rows.append("<b>갱신</b> %s" % esc(str(e["updated"])))
    # 고객 표면(customer=True)에는 deciders(내부 인사 정보)와 내부 문서를 가리키는
    # 상호참조 메타데이터 행 전부(관련/근거 ADR·스펙, supersede, 구현 경로)를 렌더링하지
    # 않는다 — 내부 참조 번호는 고객에게 무의미하고 내부 구조를 노출한다(ADR 0005).
    if not customer:
        if e.get("deciders"):
            rows.append("<b>결정자</b> %s" % ", ".join(esc(str(x)) for x in e["deciders"]))
        if e.get("related_adr"):
            rows.append("<b>관련 ADR</b> %s" % ", ".join(link_adr(a, adr_ids) for a in e["related_adr"]))
        if e.get("based_on_adr"):
            rows.append("<b>근거 ADR</b> %s" % ", ".join(link_adr(a, adr_ids) for a in e["based_on_adr"]))
        if e.get("related_spec"):
            rows.append("<b>관련 스펙</b> %s" % ", ".join(link_spec(s, spec_ids) for s in e["related_spec"]))
        if e.get("supersedes"):
            rows.append("<b>대체함</b> %s" % ", ".join(link_adr(a, adr_ids) for a in e["supersedes"]))
        if e.get("superseded_by"):
            rows.append("<b>대체됨</b> %s" % link_adr(e["superseded_by"], adr_ids))
        if e.get("implements_in"):
            rows.append("<b>구현</b> %s" % ", ".join("<code>%s</code>" % esc(p) for p in e["implements_in"]))
    panel = '<div class="meta">%s</div>' % "".join("<span>%s</span>" % r for r in rows)
    if e.get("tags"):
        panel += '<div class="tags">%s</div>' % "".join(
            '<span class="tag">%s</span>' % esc(str(t)) for t in e["tags"])
    return panel


SEARCH_ICON = ('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
               'stroke-width="2" aria-hidden="true" focusable="false">'
               '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>')

JS = r"""
(function(){
  var tabs=[].slice.call(document.querySelectorAll('.tab'));
  var panels=[].slice.call(document.querySelectorAll('.tabpanel'));
  function showTab(name){
    tabs.forEach(function(t){t.setAttribute('aria-selected', String(t.dataset.tab===name));});
    panels.forEach(function(p){p.classList.toggle('on', p.dataset.tab===name);});
  }
  function ensureDefault(kind){
    var main=document.querySelector('.docmain[data-kind="'+kind+'"]');
    if(main && !main.querySelector('.doc.on')){
      var first=main.querySelector('.doc');
      if(first){first.classList.add('on'); mark(first.id);}
    }
  }
  function mark(target){
    document.querySelectorAll('.docitem').forEach(function(b){
      b.setAttribute('aria-current', String(b.dataset.target===target));});
  }
  function showDoc(target){
    var kind=target.split('-')[0];
    showTab(kind);
    document.querySelectorAll('.doc').forEach(function(d){d.classList.toggle('on', d.id===target);});
    mark(target);
    var it=document.querySelector('.docitem[data-target="'+target+'"]');
    if(it) it.scrollIntoView({block:'nearest'});
    window.scrollTo({top:0,behavior:'smooth'});
  }
  tabs.forEach(function(t){t.addEventListener('click',function(){
    showTab(t.dataset.tab); ensureDefault(t.dataset.tab);
    history.replaceState(null,'','#tab-'+t.dataset.tab);
  });});
  document.querySelectorAll('[data-target]').forEach(function(el){
    el.addEventListener('click',function(ev){
      if(el.tagName==='A') ev.preventDefault();
      var t=el.dataset.target; if(t){showDoc(t); history.replaceState(null,'','#'+t);}
    });
  });
  document.querySelectorAll('.search input').forEach(function(inp){
    inp.addEventListener('input',function(){
      var q=inp.value.toLowerCase(), list=inp.closest('.doclist');
      list.querySelectorAll('.docitem').forEach(function(it){
        it.classList.toggle('hidden', !!q && it.dataset.search.indexOf(q)===-1);});
    });
  });
  function fromHash(){
    var h=(location.hash||'').slice(1);
    if(h.indexOf('tab-')===0){showTab(h.slice(4));}
    else if(h && document.getElementById(h)){showDoc(h);}
    else {showTab('overview');}
    ['adr','spec'].forEach(ensureDefault);
  }
  window.addEventListener('hashchange',fromHash);
  fromHash();
})();
"""


def doc_item(e, kind):
    search = (str(e.get("title", "")) + " " + e["id"] + " "
              + " ".join(map(str, e.get("tags") or []))).lower()
    return (
        '<button class="docitem" data-target="%s-%s" data-search="%s">'
        '<div class="di-top"><span class="di-id">%s</span>%s</div>'
        '<div class="di-title">%s</div></button>'
    ) % (kind, esc(e["id"]), esc(search), esc(e["id"].lstrip("0") or "0"),
         badge(e.get("status")), esc(e.get("title", "")))


def doc_article(e, kind, adr_ids, spec_ids, customer=False):
    kicker = "ADR · 왜 그렇게 정했나" if kind == "adr" else "SPEC · 지금 어떻게"
    return (
        '<article class="doc" id="%s-%s">'
        '<div class="doc-kicker">%s</div>'
        '<h2 class="doc-h">%s · %s</h2>'
        '%s<div class="body">%s</div></article>'
    ) % (kind, esc(e["id"]), kicker, esc(e["id"]), esc(e.get("title", "")),
         meta_panel(e, adr_ids, spec_ids, customer=customer), e["_body_html"])


def pane(kind, label, entries, adr_ids, spec_ids, customer=False):
    items = "".join(doc_item(e, kind) for e in entries)
    articles = "".join(doc_article(e, kind, adr_ids, spec_ids, customer=customer) for e in entries)
    return (
        '<div class="tabpanel" data-tab="%s"><div class="docview">'
        '<aside class="doclist"><div class="search">%s'
        '<input type="search" placeholder="%s 검색 (제목·태그·번호)" aria-label="검색"></div>%s</aside>'
        '<div class="docmain" data-kind="%s">%s</div></div></div>'
    ) % (kind, SEARCH_ICON, label, items, kind, articles)


def overview(adrs, specs, customer=False):
    def row(e, kind):
        # 관계 열도 내부 상호참조 — 고객 표면에서는 렌더링하지 않는다(meta_panel과 동일 원칙).
        if customer:
            relations = "—"
        elif kind == "adr":
            rel = []
            if e.get("related_spec"):
                rel.append("spec " + ", ".join(map(str, e["related_spec"])))
            if e.get("related_adr"):
                rel.append("adr #" + ", #".join(map(str, e["related_adr"])))
            relations = " · ".join(rel) or "—"
        else:
            relations = ("근거 adr #" + ", #".join(map(str, e["based_on_adr"]))) if e.get("based_on_adr") else "—"
        return (
            '<tr class="clickable" data-target="%s-%s"><td><span class="lnk">%s %s</span></td>'
            '<td>%s</td><td>%s</td><td>%s</td><td class="rel">%s</td></tr>'
        ) % (kind, esc(e["id"]), kind.upper(), esc(e["id"]), esc(e.get("title", "")),
             badge(e.get("status")), esc(str(e.get("date") or e.get("updated") or "—")),
             esc(relations))

    rows = "".join(row(e, "adr") for e in adrs) + "".join(row(e, "spec") for e in specs)
    accepted = sum(1 for e in adrs if e.get("status") == "accepted")
    return (
        '<div class="tabpanel on" data-tab="overview">'
        '<div class="ov-grid">'
        '<div class="stat"><div class="n">%d</div><div class="l">결정 (ADR)</div></div>'
        '<div class="stat"><div class="n">%d</div><div class="l">스펙 (Spec)</div></div>'
        '<div class="stat"><div class="n">%d</div><div class="l">Accepted ADR</div></div>'
        '<div class="stat"><div class="n">%d</div><div class="l">총 문서</div></div>'
        '</div>'
        '<div class="ov-sec">전체 문서 — 행 클릭 시 해당 문서로 이동</div>'
        '<table class="ov-table"><thead><tr><th>문서</th><th>제목</th><th>상태</th>'
        '<th>날짜</th><th>관계</th></tr></thead><tbody>%s</tbody></table>'
        '<div class="ov-sec">규칙 — ADR은 <b>왜</b>(불변, append-only) · Spec은 <b>지금 어떻게</b>(living). '
        'frontmatter가 단일 진실원, 기계질의는 <code>index.json</code>.</div>'
        '</div>'
    ) % (len(adrs), len(specs), accepted, len(adrs) + len(specs), rows)


def build_shell(adrs, specs, site_title=None, customer=False, version_stamp=None):
    """헤더 + 본문(<header>…</header><main>…</main>) — 래퍼 무관 공통 마크업.

    site_title/version_stamp 는 고객 배포 표면(--customer)에서만 쓴다(기본 빌드는
    SITE_TITLE 그대로, 스탬프 없음). customer=True 면 meta_panel·overview 가
    deciders 및 내부 상호참조 메타데이터 행 전부를 렌더링하지 않는다.
    """
    title = site_title or SITE_TITLE
    adr_ids = {e["id"] for e in adrs}
    spec_ids = {e["id"] for e in specs}
    tabs = (
        '<button class="tab" data-tab="overview" aria-selected="true">개요</button>'
        '<button class="tab" data-tab="adr">ADR<span class="ct">%d</span></button>'
        '<button class="tab" data-tab="spec">SPEC<span class="ct">%d</span></button>'
    ) % (len(adrs), len(specs))
    body = (
        overview(adrs, specs, customer=customer)
        + pane("adr", "ADR", adrs, adr_ids, spec_ids, customer=customer)
        + pane("spec", "SPEC", specs, adr_ids, spec_ids, customer=customer)
    )
    sub = '<span class="sub">%s</span>' % esc(version_stamp) if version_stamp else ""
    return (
        '<header class="app"><div class="app-in">'
        '<div class="app-title"><h1>%s</h1>%s'
        '</div><div class="tabs">%s</div></div></header>'
        '<main>%s</main>'
        '<footer class="cpy">%s</footer>'
    ) % (esc(title), sub, tabs, body, esc(COPYRIGHT))


def build_html(adrs, specs):
    """사람용 standalone 문서 (GitHub Pages 호스팅)."""
    return (
        '<!doctype html><html lang="ko"><head>'
        '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>%s</title><style>%s</style></head><body>'
        '%s<script>%s</script></body></html>'
    ) % (esc(SITE_TITLE), CSS, build_shell(adrs, specs), JS)


def build_customer(adrs, specs, version):
    """고객 배포용 단일 자기완결 HTML(docs/customer.html) — 이메일 첨부 배포 (ADR 0005).

    화이트리스트(audience: customer 인 문서만)로 골라, 내부 문서가 섞여 들어올
    가능성을 원천 차단한다(기본값이 internal이므로 누락이면 자동 제외되는 방향).
    0건이면 빈 파일 발송 사고를 막기 위해 에러 후 exit 1.
    """
    c_adrs = [e for e in adrs if e.get("audience") == "customer"]
    c_specs = [e for e in specs if e.get("audience") == "customer"]
    if not c_adrs and not c_specs:
        sys.exit("[오류] audience: customer 문서가 없습니다 — 빈 파일 발송을 막기 위해 중단합니다.")

    title = os.environ.get("DOCS_CUSTOMER_TITLE") or (SITE_TITLE + " — 고객 배포판")
    today = datetime.date.today().isoformat()
    stamp = "%s · %s" % (version, today) if version else today

    html = (
        '<!doctype html><html lang="ko"><head>'
        '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>%s</title><style>%s</style></head><body>'
        '%s<script>%s</script></body></html>'
    ) % (esc(title), CSS, build_shell(c_adrs, c_specs, site_title=title, customer=True, version_stamp=stamp), JS)

    with open(OUT_CUSTOMER, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)

    date_compact = today.replace("-", "")
    fname = "customer-%s-%s.html" % (version, date_compact) if version else "customer-%s.html" % date_compact
    print("[OK] 고객 배포 표면 생성 (ADR %d · SPEC %d, audience: customer 화이트리스트)" % (len(c_adrs), len(c_specs)))
    print("     - docs/customer.html")
    print("     첨부 파일명 제안: %s" % fname)


def build_artifact(adrs, specs):
    """claude.ai Artifact용 fragment — 호스트가 <!doctype>/<html>/<head>/<body>를
    감싸므로 그 태그들은 넣지 않는다. <title>/<meta>는 갤러리 라벨용으로 남긴다."""
    return (
        '<title>%s</title>'
        '<meta name="description" content="ADR(결정)·Spec(스펙) 브라우징 — 소스(.md)에서 자동 생성">'
        '<style>%s</style>'
        '%s<script>%s</script>'
    ) % (esc(SITE_TITLE), CSS, build_shell(adrs, specs), JS)


# ============================================================================
# 고객 코퍼스 표면 (ADR 0060) — client-pjems build_docs.py 포크의 상향.
#
# `.harness.json` 의 `docs.customer` 가 선언되면(null이 아니면) `docs/customer/<Program>/
# {spec.md, user-guide.md, release-notes.md}` 프로그램 단위 코퍼스에서 repo 전체를 아우르는
# 단일 `docs/customer.artifact.html`(+ 선택 `docs/PROJECTS.md`)을 생성한다. 선언은
# `scripts/harness/harness_config.py`(벤더 사본)의 `customer_decl()` 만이 검증한다 — 두 번째
# 검증기를 이 파일 안에 두지 않는다(ADR 0060 옵션 F 거부 — 그것이 정확히 포크가 겪은
# 발산이다). 위 audience 화이트리스트 표면(build_customer, docs/customer.html)과는 완전히
# 별개다.
# ============================================================================

CUSTOMER_FILES = ("spec.md", "user-guide.md", "release-notes.md")
RECENT_GROUP_LABEL = "최근 업데이트"
# 기본 배지 어휘(FUT/UAT/PROD)의 css 클래스는 'rs-' + tag.lower() 로 그대로 나온다 — 포크의
# rs-fut/rs-uat/rs-prod 와 바이트 동일. 커스텀(비-기본) 태그에만 rs-mid/rs-fin 보조 클래스를
# 덧붙여 최종 단계와 중간 단계를 구분한다(CSS 쪽 참고).
_KNOWN_STAGE_CLASSES = {"rs-fut", "rs-uat", "rs-prod"}


def _declared(cfg, key, fallback):
    """UI 표시 기본값은 declarer가 그 키를 아예 쓰지 않은 경우에만 채운다 — 명시적 ""는
    의도된 공백으로 남는다(ADR 0060; harness_config.customer_decl 의 `declared` 계약)."""
    return cfg[key] if key in cfg["declared"] else fallback


def _load_customer_decl():
    """`docs.customer` 를 로드·검증한다. 선언이 없으면(부재/null) None — 4-표면 빌드는 그대로
    진행한다. 선언은 있는데 벤더 리더를 import 할 수 없거나 선언이 malformed 면 즉시 exit 1 —
    고객 표면이 조용히 stale해지는 것이 이 리더가 막으려는 결함이다(ADR 0060)."""
    root, raw = _find_declaration()
    docs = raw.get("docs") if isinstance(raw, dict) else None
    if not isinstance(docs, dict) or docs.get("customer") is None:
        return None
    hc_dir = os.path.join(root, "scripts", "harness")
    reader_path = os.path.join(hc_dir, "harness_config.py")
    sys.path.insert(0, hc_dir)
    try:
        import harness_config as hc
    except ImportError as e:
        sys.exit(
            "[오류] .harness.json 의 docs.customer 가 선언됐지만 scripts/harness/harness_config.py "
            "를 import 할 수 없습니다 (%s) — 고객 표면은 이 리더 없이 빌드하지 않습니다. "
            "/ywr-harness:harness-init 로 툴체인을 다시 배치하세요." % reader_path)
    # import 성공 ≠ 맞는 리더. ADR 0060 이전에 배치된 벤더 사본은 존재하지만 `customer_decl` 도
    # `cfg["customer"]` 도 모른다 — pjems 가 선언을 먼저 채우고 init 을 나중에 돌리는 순서가
    # 정확히 이 상태이고, 여기서 KeyError 트레이스백으로 죽는 것은 "파일·경로를 지목한 exit"
    # 불변식 위반이다(리뷰 2026-08-27 high, 구버전 리더로 재현). 리더 자체의 예외도 같은 급.
    stale = ("[오류] scripts/harness/harness_config.py 가 구버전입니다(docs.customer 를 모르는 "
             "리더: %s) — 고객 표면은 이 리더로 빌드하지 않습니다. /ywr-harness:harness-init 을 "
             "먼저 재실행해 빌더와 리더를 함께 갱신한 뒤 다시 빌드하세요." % reader_path)
    if not hasattr(hc, "load") or not hasattr(hc, "customer_decl"):
        sys.exit(stale)
    try:
        cfg, warns = hc.load(Path(root))
    except Exception as e:  # 리더의 어떤 예외도 트레이스백 대신 지목된 exit 로
        sys.exit("[오류] scripts/harness/harness_config.py 의 load() 가 실패했습니다: %s (%s) — "
                 "고객 표면을 빌드할 수 없습니다." % (reader_path, "%s: %s" % (type(e).__name__, e)))
    for w in warns:
        print("warn: %s" % w, file=sys.stderr)
    if not isinstance(cfg, dict) or "customer" not in cfg:
        sys.exit(stale)
    cust = cfg["customer"]
    if cust is None:
        return None
    if cust.get("malformed"):
        sys.exit(
            "[오류] docs.customer 선언이 사용 불가(%s) — 고객 표면을 빌드할 수 없습니다. "
            "경고를 보고 선언을 고치세요." % cust["malformed"])
    return cust


def collect_customer_docs(cfg, root):
    """docs.customer.dir 아래 프로그램 디렉터리를 스캔 → 프로그램별 dict 리스트.

    코퍼스 계약(ADR 0060, 고정): 각 서브디렉터리가 프로그램이고, spec.md·user-guide.md·
    release-notes.md 셋 다 있어야 한다(누락은 세 이름을 모두 나열하는 즉시 실패). 각
    frontmatter의 program 은 디렉터리명과 일치해야 하고, title·updated 는 필수. spec.md 는
    프로그램 레코드(정본)이며 declared chip_field(비어있지 않을 때)와 required_frontmatter
    의 모든 키를 추가로 가져야 한다. '.'·'_' 로 시작하는 디렉터리와 디렉터리가 아닌 항목은
    조용히 건너뛴다."""
    rel_dir = cfg["dir"]
    directory = os.path.join(root, rel_dir)
    if not os.path.isdir(directory):
        sys.exit("[오류] docs.customer.dir '%s' 가 없습니다 — 고객 코퍼스 디렉터리가 필요합니다."
                  % rel_dir)
    group_field = cfg["group_field"]
    project_field = cfg["project_field"]
    chip_field = cfg["chip_field"]
    required_fm = cfg["required_frontmatter"]
    programs = []
    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        if not os.path.isdir(path):
            continue
        if name.startswith(".") or name.startswith("_"):
            continue
        docs = {}
        for fname in CUSTOMER_FILES:
            fpath = os.path.join(path, fname)
            if not os.path.isfile(fpath):
                sys.exit(
                    "[오류] %s/%s/%s 없음 — 프로그램 디렉터리마다 %s 가 모두 있어야 합니다."
                    % (rel_dir, name, fname, " · ".join(CUSTOMER_FILES)))
            with open(fpath, "r", encoding="utf-8") as f:
                meta, body = parse_frontmatter(f.read())
            if str(meta.get("program") or "") != name:
                sys.exit(
                    "[오류] %s/%s/%s frontmatter의 program(%r)이 디렉터리명(%r)과 다릅니다."
                    % (rel_dir, name, fname, meta.get("program"), name))
            if not meta.get("title"):
                sys.exit("[오류] %s/%s/%s frontmatter에 title 이 없습니다." % (rel_dir, name, fname))
            if not meta.get("updated"):
                sys.exit("[오류] %s/%s/%s frontmatter에 updated 가 없습니다." % (rel_dir, name, fname))
            docs[fname] = {"meta": meta,
                            "html": convert_body(_strip_leading_h1(body.split("\n")))}
        spec_meta = docs["spec.md"]["meta"]
        missing = []
        if chip_field and not spec_meta.get(chip_field):
            missing.append(chip_field)
        for key in required_fm:
            if not spec_meta.get(key):
                missing.append(key)
        if missing:
            sys.exit(
                "[오류] %s/%s/spec.md frontmatter에 다음 키가 없습니다: %s"
                % (rel_dir, name, ", ".join(missing)))
        release_html = _mark_release_status(docs["release-notes.md"]["html"], cfg["release_stages"])
        programs.append({
            "program": name,
            "title": spec_meta.get("title"),
            "updated": spec_meta.get("updated"),
            "chip": str(spec_meta.get(chip_field)) if chip_field and spec_meta.get(chip_field) else "",
            "group_value": str(spec_meta.get(group_field)) if spec_meta.get(group_field) else "",
            "menu_name": str(spec_meta.get("menu_name")) if spec_meta.get("menu_name") else "",
            "project": str(spec_meta.get(project_field)) if spec_meta.get(project_field) else "",
            "release_html": release_html,
            # 릴리즈 노트 항목 수 = 본문 H2 개수. 0이면 릴리즈 노트 탭 목록에서 제외된다.
            "release_entries": docs["release-notes.md"]["html"].count("<h2>"),
            "spec_html": docs["spec.md"]["html"],
            "guide_html": docs["user-guide.md"]["html"],
        })
    return programs


def _mark_release_status(html_text, stages):
    """릴리즈 노트 H2 말미의 `[TAG]` 토큰을 declared release_stages 배지로 치환한다.
    기본 어휘(FUT/UAT/PROD)는 css 클래스가 'rs-'+tag.lower() 그대로 나와 client-pjems 포크와
    바이트 동일; 커스텀 태그만 rs-mid/rs-fin 보조 클래스가 덧붙는다."""
    if not stages:
        return html_text
    by_tag = {s["tag"]: s["label"] for s in stages}
    final_tag = stages[-1]["tag"]
    tags_re = "|".join(re.escape(s["tag"]) for s in stages)

    def rep(m):
        tag = m.group(2)
        label = by_tag.get(tag, tag)
        base = "rs-" + tag.lower()
        cls = base if base in _KNOWN_STAGE_CLASSES else (
            base + (" rs-fin" if tag == final_tag else " rs-mid"))
        return '<h2>%s <span class="relstat %s">%s</span></h2>' % (
            m.group(1).rstrip(), cls, esc(label))
    return re.sub(r"<h2>(.*?)\s*\[(%s)\]</h2>" % tags_re, rep, html_text)


def _dedupe_release_badges(html_text):
    """기사 본문 표시용 배지 정리: 배포가 프로그램 단위라 상태는 문서 안에서 단조다(위=최신
    → 아래로 갈수록 과거). 같은 상태의 반복 배지는 정보량이 없으므로, 맨 위 태그 엔트리와
    상태가 바뀌는 경계에서만 남긴다. 원본 release_html(_latest_release 가 피드 카드용으로
    파싱)은 그대로 두고 렌더링 단계만 걸러낸다."""
    last = None

    def rep(m):
        nonlocal last
        cls = m.group(2)
        if cls == last:
            return "<h2>%s</h2>" % m.group(1).rstrip()
        last = cls
        return m.group(0)
    return re.sub(
        r'<h2>(.*?)\s*<span class="relstat ([\w -]+)">[^<]*</span></h2>', rep, html_text)


def _release_posture(p, stages):
    """프로그램 단위 리스트 칩: 최상단 배지 → final stage 면 완료, 그 외는 진행 중, 배지
    엔트리 없음(테스트 불요 변경뿐)이면 무칩. 배포가 프로그램 단위라 문서 최상단 배지
    엔트리 = 프로그램의 현재 상태라는 _dedupe_release_badges 와 같은 모델."""
    if not stages:
        return ""
    final_tag = stages[-1]["tag"]
    stats = re.findall(r'class="relstat ([\w -]+)"', p["release_html"])
    if not stats:
        return ""
    top_class = stats[0].split()[0]  # '_mark_release_status' 가 항상 base 클래스를 먼저 둔다
    if top_class == "rs-" + final_tag.lower():
        return '<span class="relstat rs-prod">완료</span>'
    return '<span class="relstat rs-going">진행 중</span>'


def _latest_release(p):
    """릴리즈 노트 최신 엔트리 (date, title, badge_html) — 없으면 None. 피드·최근 그룹의
    공용 날짜 기준(항상 '가장 최신 변경'의 날짜). 날짜만 비교한다 — 문자열 전체 max 는 같은
    날짜 엔트리끼리 제목 코드포인트로 동점을 깨서 임의 엔트리를 뽑는다. 같은 날짜는 문서
    위쪽 = 최신(누적 이력 관례)이 대표."""
    heads = re.findall(
        r'<h2>([^<]+?)\s*(?:<span class="relstat ([\w -]+)">([^<]+)</span>)?</h2>',
        p["release_html"])
    if not heads:
        return None
    best_date = max(h[0][:10] for h in heads)
    latest = next(h for h in heads if h[0][:10] == best_date)
    # H2 캡처 텍스트는 HTML 이스케이프된 엔티티(&quot; 등)를 담고 있다 — 피드 카드에서
    # esc()로 다시 이스케이프하면 이중 표시되므로 여기서 원문으로 되돌린다.
    text = _html.unescape(latest[0])
    date, _, title = text.partition(" — ")
    badge_html = ('<span class="relstat %s">%s</span>' % (latest[1], esc(latest[2]))
                  if latest[1] else "")
    return date.strip(), (title.strip() or text.strip()), badge_html


def _group_key(group_value):
    if not group_value:
        return None
    try:
        return int(str(group_value).split(",")[0].strip().split(".")[0])
    except ValueError:
        return None


def _customer_group(p, cfg):
    top = _group_key(p.get("group_value"))
    for g in cfg["groups"]:
        if top is not None and top in g["keys"]:
            return g["label"]
    if top is not None:
        return _declared(cfg, "other_label", "기타")
    return _declared(cfg, "unkeyed_label", "기타 (분류 없음)")


def customer_sidebar_groups(programs, cfg):
    """(label, [program]) 순서 리스트 — 최근 업데이트 핀 그룹 + declared groups 순서.
    최근 그룹 = 릴리즈 이력 프로그램을 최신 변경일 내림차순으로, 상한 8개."""
    out = []
    recent = [(r[0], p) for p in programs for r in [_latest_release(p)] if r]
    recent = [p for _, p in sorted(recent, key=lambda e: e[0], reverse=True)][:8]
    if recent:
        out.append((RECENT_GROUP_LABEL, recent))
    grouped = {}
    for p in programs:
        grouped.setdefault(_customer_group(p, cfg), []).append(p)
    order = [g["label"] for g in cfg["groups"]]
    order += [_declared(cfg, "other_label", "기타"), _declared(cfg, "unkeyed_label", "기타 (분류 없음)")]
    seen = set()
    for label in order:
        if label in seen or label not in grouped:
            continue
        seen.add(label)
        out.append((label, grouped[label]))
    return out


def _chip_text(cfg, p, file_form=False):
    """칩 텍스트. HTML 칩은 frontmatter 값 그대로(포크와 바이트 동일); `chip_suffix` 는
    PROJECTS.md 의 파일형 표기(예: `xgglbsrp.p`)에만 붙는다 — 포크가 그렇게 했고, 접미사가
    화면 칩까지 번지면 pjems 350개 칩이 전부 달라진다(e2e 측정 2026-08-27)."""
    if not p["chip"]:
        return ""
    return p["chip"] + (cfg["chip_suffix"] if file_form else "")


def _group_chip(p):
    """부가 정보 칩(메뉴/분류 번호 + 이름) — 값이 확인된 프로그램만."""
    label = " ".join(x for x in (p.get("group_value"), p.get("menu_name")) if x)
    if not label:
        return ""
    return '<span class="chip">%s</span>' % esc(label)


def build_projects_md(programs, cfg):
    """docs/PROJECTS.md — project_field 값 → 고객 명세 매핑. GENERATED: 출처는 spec.md
    frontmatter 의 project_field 필드뿐이며 손으로 고치지 않는다. 태그 없는 명세는 여기
    나타나지 않는다."""
    by_proj = {}
    for p in programs:
        if p.get("project"):
            by_proj.setdefault(p["project"], []).append(p)
    lines = [
        "# PROJECTS — project → customer specs",
        "",
        "> GENERATED by `pwsh docs/build.ps1` — do not hand-edit. Source of",
        "> truth = `%s/<Program>/spec.md` frontmatter `%s`." % (cfg["dir"], cfg["project_field"]),
        "> A spec without the field is simply not listed here.",
        "",
    ]
    if not by_proj:
        lines += ["(no project-tagged specs yet)", ""]
    for proj in sorted(by_proj):
        lines.append("## #%s" % proj)
        lines.append("")
        for p in sorted(by_proj[proj], key=lambda x: x["program"]):
            if cfg["chip_field"]:
                lines.append("- %s (`%s`) — %s" % (p["program"], _chip_text(cfg, p, file_form=True), p["title"]))
            else:
                lines.append("- %s — %s" % (p["program"], p["title"]))
        lines.append("")
    return "\n".join(lines)


# ----------------------------------------------------- customer artifact theme (ADR 0060)
CUSTOMER_CSS = """
:root{
  --bg:#f5f7f5;--surface:#ffffff;--surface-2:#f0f4f1;--ink:#1b2420;--ink-soft:#57635c;--ink-dim:#65706a;
  --line:#dce3de;--line-soft:#e7ece8;--accent:#1e6b4f;--accent-ink:#175540;--accent-soft:#e7f1ec;
  --code-bg:#eef2ef;--th-bg:#f0f4f1;--radius:12px;
  --ok:#2e7d4f;--ok-soft:#e4f1e9;--warn:#b07a1e;--warn-soft:#f7eeda;--crit:#b3452e;--crit-soft:#f8e7e2;
  --mono:'Cascadia Code',Consolas,'D2Coding',ui-monospace,monospace;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#121815;--surface:#1a221d;--surface-2:#1f2922;--ink:#e5ebe6;--ink-soft:#9cab9f;--ink-dim:#7c8b80;
    --line:#2a352e;--line-soft:#233029;--accent:#55b389;--accent-ink:#7cc9a5;--accent-soft:#1c3329;
    --code-bg:#212b25;--th-bg:#1f2922;
    --ok:#5cb885;--ok-soft:#17301f;--warn:#d8a44a;--warn-soft:#332812;--crit:#dd7a5f;--crit-soft:#391d15;
  }
}
:root[data-theme="dark"]{
  --bg:#121815;--surface:#1a221d;--surface-2:#1f2922;--ink:#e5ebe6;--ink-soft:#9cab9f;--ink-dim:#7c8b80;
  --line:#2a352e;--line-soft:#233029;--accent:#55b389;--accent-ink:#7cc9a5;--accent-soft:#1c3329;
  --code-bg:#212b25;--th-bg:#1f2922;
  --ok:#5cb885;--ok-soft:#17301f;--warn:#d8a44a;--warn-soft:#332812;--crit:#dd7a5f;--crit-soft:#391d15;
}
:root[data-theme="light"]{
  --bg:#f5f7f5;--surface:#ffffff;--surface-2:#f0f4f1;--ink:#1b2420;--ink-soft:#57635c;--ink-dim:#65706a;
  --line:#dce3de;--line-soft:#e7ece8;--accent:#1e6b4f;--accent-ink:#175540;--accent-soft:#e7f1ec;
  --code-bg:#eef2ef;--th-bg:#f0f4f1;
  --ok:#2e7d4f;--ok-soft:#e4f1e9;--warn:#b07a1e;--warn-soft:#f7eeda;--crit:#b3452e;--crit-soft:#f8e7e2;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15.5px/1.7 -apple-system,'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR','Segoe UI',sans-serif;
  -webkit-font-smoothing:antialiased}
a{color:var(--accent-ink)}
code{font-family:var(--mono);font-size:.88em;background:var(--code-bg);
  border:1px solid var(--line);border-radius:5px;padding:1px 6px;
  white-space:pre-wrap;overflow-wrap:break-word;word-break:break-all}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

header.cust-app{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--line)}
.cust-in{max-width:1280px;margin:0 auto;padding:16px 28px 0}
.eyebrow{font-size:12px;font-weight:600;letter-spacing:.08em;color:var(--accent-ink);text-transform:uppercase}
.toptabs{display:flex;gap:6px;margin-top:4px}
.toptab{appearance:none;border:0;background:none;color:var(--ink-dim);font:inherit;font-size:20px;
  font-weight:700;letter-spacing:-.02em;padding:8px 14px 12px;cursor:pointer;
  border-bottom:3px solid transparent;border-radius:10px 10px 0 0;
  display:flex;align-items:center;gap:10px}
.toptab:hover{color:var(--ink);background:var(--surface-2)}
.toptab[aria-selected=true]{color:var(--ink);border-bottom-color:var(--accent)}
.toppanel{display:none}.toppanel.on{display:block}
.chip{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--accent-ink);
  background:var(--accent-soft);border:1px solid var(--line);border-radius:999px;padding:2px 11px;letter-spacing:0;
  white-space:nowrap}
.chip.mono{font-family:var(--mono)}

main.cust-main{max-width:1280px;margin:0 auto;padding:24px 28px 64px}
.docview{display:grid;grid-template-columns:300px 1fr;gap:26px;align-items:start}
.doclist{position:sticky;top:104px;max-height:calc(100vh - 128px);overflow:auto;
  display:flex;flex-direction:column;gap:8px;padding-right:6px;
  scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.doclist::-webkit-scrollbar{width:8px}
.doclist::-webkit-scrollbar-track{background:transparent}
.doclist::-webkit-scrollbar-thumb{background:var(--line);border-radius:999px}
.doclist::-webkit-scrollbar-thumb:hover{background:var(--accent)}
.search{position:sticky;top:0;z-index:2;background:var(--bg);padding-bottom:2px}
.search input{width:100%;background:var(--surface);border:1px solid var(--line);color:var(--ink);
  border-radius:9px;padding:9px 12px 9px 32px;font:inherit;font-size:13.5px}
.search input:focus{outline:none;border-color:var(--accent)}
.search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--ink-dim)}
.proglist{display:flex;flex-direction:column;gap:4px}
.pgroup{margin:0}
.pgroup.hidden{display:none}
.pghead{appearance:none;border:0;background:none;width:100%;cursor:pointer;display:flex;
  align-items:center;gap:8px;font:inherit;font-size:12px;font-weight:700;letter-spacing:.04em;
  color:var(--ink-soft);padding:7px 6px;border-radius:8px;text-align:left}
.pghead:hover{background:var(--surface-2);color:var(--ink)}
.pgarrow{font-size:10px;color:var(--ink-dim);transition:transform .12s}
.pghead[aria-expanded="true"] .pgarrow{transform:rotate(90deg)}
.pgcount{margin-left:auto;font-size:11px;font-weight:600;color:var(--ink-dim);
  background:var(--surface-2);border-radius:999px;padding:1px 8px}
.pgitems{display:none}
.pgitems.on{display:flex;flex-direction:column;gap:8px;margin:6px 0 4px}
.proglist.offmode{display:none}
.relflat{display:none;flex-direction:column;gap:14px}
.relflat.on{display:flex}
.relmonth{display:flex;flex-direction:column;gap:8px}
.relmonth.hidden{display:none}
.rm-head{font-size:12px;font-weight:700;letter-spacing:.04em;color:var(--ink-soft);
  padding:2px 6px;border-bottom:1px solid var(--line)}
.relitem{text-align:left;appearance:none;cursor:pointer;background:var(--surface);
  border:1px solid var(--line);border-radius:10px;padding:11px 13px;color:var(--ink);
  display:flex;flex-direction:column;gap:6px;font:inherit;transition:border-color .12s,background .12s}
.relitem:hover{border-color:var(--accent)}
.relitem[aria-current=true]{border-color:var(--accent);background:var(--accent-soft)}
.relitem.hidden{display:none}
.ri-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ri-date{font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--accent-ink)}
.ri-title{font-size:13.5px;font-weight:600;line-height:1.4}
.relstat{display:inline-block;font-size:11px;font-weight:700;line-height:1;
  padding:4px 9px;border-radius:999px;white-space:nowrap;vertical-align:2px}
.rs-fut{background:#e8862d;color:#241300}
.rs-uat{background:#f2c94c;color:#2b2100}
.rs-prod{background:var(--ok);color:var(--bg)}
.rs-going{background:#f2c94c;color:#2b2100}
/* 커스텀(비-기본) release_stages 태그 전용 보조 클래스 — 중간 단계는 웜톤, 최종 단계는 초록 */
.rs-mid{background:#f2c94c;color:#2b2100}
.rs-fin{background:var(--ok);color:var(--bg)}
.body h2 .relstat{margin-left:8px;font-size:12px}
.ri-sub{font-size:12px;color:var(--ink-soft);line-height:1.4}
.progitem{text-align:left;appearance:none;cursor:pointer;background:var(--surface);border:1px solid var(--line);
  border-radius:10px;padding:11px 13px;color:var(--ink);display:flex;flex-direction:column;gap:6px;
  font:inherit;transition:border-color .12s,background .12s}
.progitem:hover{border-color:var(--accent)}
.progitem[aria-current=true]{border-color:var(--accent);background:var(--accent-soft)}
.progitem.hidden{display:none}
.pi-title{font-size:13.5px;font-weight:600;line-height:1.4}
.pi-meta{display:flex;align-items:center;flex-wrap:nowrap;gap:6px;min-width:0}
.pi-meta .chip{flex:0 0 auto}
.chip.clip{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.pi-proj{min-width:0;display:flex}
.pi-proj .chip.clip{max-width:100%}
.pi-meta .chip,.pi-proj .chip{color:var(--ink)}
.pi-date{font-size:11.5px;color:var(--ink-dim);white-space:nowrap;align-self:flex-end}

.docmain{min-width:0}
.prog{display:none}.prog.on{display:block}
.prog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;
  position:sticky;top:var(--headh,64px);z-index:5;background:var(--bg);
  padding:10px 0 8px;margin-bottom:6px;border-bottom:1px solid var(--line-soft)}
.prog-head h2{flex:1 1 auto;min-width:0}
.prog-head .ptabs{flex-shrink:0;margin-top:4px}
.prog-head h2{margin:0;font-size:20px;font-weight:700;letter-spacing:-.015em;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ptabs{display:flex;gap:4px}
.ptab{appearance:none;border:0;background:none;color:var(--ink-soft);font:inherit;font-size:14px;
  font-weight:600;padding:8px 14px;border-radius:8px 8px 0 0;cursor:pointer;border-bottom:2px solid transparent}
.ptab:hover{color:var(--ink);background:var(--surface-2)}
.ptab[aria-selected=true]{color:var(--accent-ink);border-bottom-color:var(--accent)}
.tabpanel{display:none;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
  padding:26px 30px;margin-top:14px}
.tabpanel.on{display:block}

.body p{margin:12px 0}
.body ul,.body ol{margin:12px 0;padding-left:24px}
.body li{margin:6px 0}
.body li::marker{color:var(--accent-ink)}
.body h1,.body h2,.body h3,.body h4{color:var(--ink);letter-spacing:-.01em}
.body h2{font-size:17px;margin:24px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--line-soft)}
.body h3{font-size:15px;margin:18px 0 6px}
.body .tblwrap{margin:14px 0;overflow-x:auto;border:1px solid var(--line);border-radius:10px}
.body table{border-collapse:collapse;width:100%;margin:0;font-size:13.5px}
.body th,.body td{border-bottom:1px solid var(--line-soft);border-right:1px solid var(--line-soft);
  padding:9px 13px;text-align:left;vertical-align:top}
.body th{background:var(--th-bg);color:var(--ink-soft);font-weight:650;white-space:nowrap}
.body tr:last-child td{border-bottom:0}.body td:last-child,.body th:last-child{border-right:0}
.body blockquote{display:flex;gap:12px;background:var(--accent-soft);border:1px solid var(--line);
  border-left:3px solid var(--accent);border-radius:0 10px 10px 0;padding:14px 18px;margin:16px 0;
  font-size:14.5px;color:var(--ink)}
.body pre{background:var(--code-bg);border:1px solid var(--line);color:var(--ink);padding:15px 17px;
  border-radius:10px;overflow-x:auto;font:12.5px/1.6 var(--mono)}
.body pre .d-add{color:var(--ok)}.body pre .d-del{color:var(--crit)}.body pre .d-hunk{color:var(--accent-ink)}
.body strong{color:var(--ink);font-weight:700}

footer.cust-foot{max-width:1280px;margin:0 auto;padding:0 28px 40px;display:flex;
  justify-content:space-between;gap:16px;flex-wrap:wrap;color:var(--ink-dim);font-size:13px}
footer.cust-foot b{color:var(--ink-soft);font-weight:650}

@media(max-width:860px){
  .docview{grid-template-columns:1fr}
  .doclist{position:static;max-height:40vh;order:-1}
  .docmain{order:0}
  .prog-head{flex-wrap:wrap}
}
.prog-head .chip{white-space:normal;word-break:keep-all}
.noresult{padding:14px 6px;font-size:13px;color:var(--ink-dim);text-align:center}
.noresult[hidden]{display:none}
.projtag{margin-top:26px;padding-top:14px;border-top:1px solid var(--line-soft)}
.proj-chip{appearance:none;cursor:pointer;font:600 12.5px/1 var(--mono);
  color:var(--accent-ink);background:var(--accent-soft);border:1px solid var(--line);
  border-radius:999px;padding:6px 12px;word-break:keep-all}
.proj-chip:hover{border-color:var(--accent)}
"""

CUSTOMER_JS = r"""
(function(){
  var apphead=document.querySelector('header.cust-app');
  function setHeadH(){
    if(apphead){ document.documentElement.style.setProperty('--headh', apphead.offsetHeight+'px'); }
  }
  setHeadH(); window.addEventListener('resize', setHeadH);
  var toptabs=[].slice.call(document.querySelectorAll('.toptab'));
  var toppanels=[].slice.call(document.querySelectorAll('.toppanel'));
  function showTop(id){
    toptabs.forEach(function(t){t.setAttribute('aria-selected', String(t.dataset.top===id));});
    toppanels.forEach(function(p){p.classList.toggle('on', p.dataset.top===id);});
  }
  toptabs.forEach(function(t){
    t.addEventListener('click', function(){
      showTop(t.dataset.top);
      history.replaceState(null,'','#top-'+t.dataset.top);
    });
  });
  var progs=[].slice.call(document.querySelectorAll('.prog'));
  var items=[].slice.call(document.querySelectorAll('.progitem'));
  var inp=document.querySelector('.search input');
  var mode=(function(){
    var t=document.querySelector('.prog.on .ptab[aria-selected="true"]');
    return t ? t.dataset.tab : 'spec';
  })();
  var groups=[].slice.call(document.querySelectorAll('.pgroup'));
  function setOpen(g, open){
    var b=g.querySelector('.pghead');
    if(b){ b.setAttribute('aria-expanded', String(open)); }
    var it=g.querySelector('.pgitems');
    if(it){ it.classList.toggle('on', open); }
  }
  groups.forEach(function(g){
    var b=g.querySelector('.pghead');
    if(b){ b.addEventListener('click', function(){
      setOpen(g, b.getAttribute('aria-expanded')!=='true');
    }); }
  });
  var relflat=document.querySelector('.relflat');
  var relitems=[].slice.call(document.querySelectorAll('.relitem'));
  var proglist=document.querySelector('.proglist');
  var noresult=document.querySelector('.noresult');
  function applyFilter(){
    var q=(inp && inp.value || '').toLowerCase().replace(/\s+/g,'');
    function hit(hay){ return hay.replace(/\s+/g,'').indexOf(q)!==-1; }
    var rel=(mode==='release');
    if(proglist){ proglist.classList.toggle('offmode', rel); }
    if(relflat){ relflat.classList.toggle('on', rel); }
    if(inp){ inp.placeholder = rel ? '릴리즈 노트 검색 (날짜·변경·프로그램·프로젝트)'
                                   : '프로그램 검색 (제목·코드·분류·#프로젝트)'; }
    if(rel){
      relitems.forEach(function(it){
        it.classList.toggle('hidden', !!q && !hit(it.dataset.search));
      });
      [].slice.call(document.querySelectorAll('.relmonth')).forEach(function(mn){
        mn.classList.toggle('hidden', mn.querySelectorAll('.relitem:not(.hidden)').length===0);
      });
      if(noresult){ noresult.hidden = relitems.some(function(it){return !it.classList.contains('hidden');}); }
      return;
    }
    items.forEach(function(it){
      it.classList.toggle('hidden', !!q && !hit(it.dataset.search));
    });
    if(noresult){ noresult.hidden = items.some(function(it){return !it.classList.contains('hidden');}); }
    groups.forEach(function(g){
      var vis=g.querySelectorAll('.progitem:not(.hidden)').length;
      g.classList.toggle('hidden', vis===0);
      var c=g.querySelector('.pgcount'); if(c){ c.textContent=vis; }
      if(q && vis>0){ setOpen(g, true); }
    });
  }
  [].slice.call(document.querySelectorAll('.proj-chip')).forEach(function(b){
    b.addEventListener('click', function(){
      if(inp){ inp.value=b.dataset.q; applyFilter(); inp.focus(); }
    });
  });
  function showProg(id){
    progs.forEach(function(p){p.classList.toggle('on', p.id==='prog-'+id);});
    items.forEach(function(it){
      var cur=it.dataset.prog===id;
      it.setAttribute('aria-current', String(cur));
      if(cur){ var g=it.closest('.pgroup'); if(g){ setOpen(g, true); } }
    });
    relitems.forEach(function(it){ it.setAttribute('aria-current','false'); });
  }
  relitems.forEach(function(it){
    it.addEventListener('click', function(){
      showProg(it.dataset.prog);
      it.setAttribute('aria-current','true');
      var art=document.getElementById('prog-'+it.dataset.prog);
      if(art) mode=setTab(art, 'release');
      applyFilter();
      history.replaceState(null,'','#'+it.dataset.prog);
    });
  });
  function setTab(art, tab){
    var btn=art.querySelector('.ptab[data-tab="'+tab+'"]') || art.querySelector('.ptab');
    tab=btn.dataset.tab;
    art.querySelectorAll('.ptab').forEach(function(b){b.setAttribute('aria-selected', String(b===btn));});
    art.querySelectorAll('.tabpanel').forEach(function(p){p.classList.toggle('on', p.dataset.tab===tab);});
    return tab;
  }
  document.querySelectorAll('.ptab').forEach(function(t){
    t.addEventListener('click', function(){
      mode=setTab(t.closest('.prog'), t.dataset.tab);
      applyFilter();
    });
  });
  items.forEach(function(it){
    it.addEventListener('click', function(){
      showProg(it.dataset.prog);
      var art=document.getElementById('prog-'+it.dataset.prog);
      if(art) mode=setTab(art, mode);
      applyFilter();
      history.replaceState(null,'','#'+it.dataset.prog);
      it.scrollIntoView({block:'nearest'});
    });
  });
  document.querySelectorAll('.etab').forEach(function(t){
    t.addEventListener('click', function(){
      document.querySelectorAll('.etab').forEach(function(b){b.setAttribute('aria-selected', String(b===t));});
      document.querySelectorAll('.epanel').forEach(function(p){p.classList.toggle('on', p.dataset.env===t.dataset.env);});
    });
  });
  document.addEventListener('keydown', function(ev){
    if(ev.key!=='ArrowLeft' && ev.key!=='ArrowRight') return;
    var t=ev.target;
    if(!t || !t.classList) return;
    var sel = t.classList.contains('toptab') ? '.toptab'
            : t.classList.contains('ptab') ? '.ptab'
            : t.classList.contains('etab') ? '.etab' : null;
    if(!sel) return;
    var scope = sel==='.ptab' ? t.parentElement : document;
    var tabs=[].slice.call(scope.querySelectorAll(sel));
    var i=tabs.indexOf(t);
    if(i<0) return;
    ev.preventDefault();
    var n=tabs[(i+(ev.key==='ArrowRight'?1:tabs.length-1))%tabs.length];
    n.focus(); n.click();
  });
  if(inp){ inp.addEventListener('input', applyFilter); }
  function fromHash(){
    var h=(location.hash||'').slice(1);
    if(h.indexOf('top-')===0){showTop(h.slice(4));}
    else if(h && document.getElementById('prog-'+h)){
      showTop('docs'); showProg(h);
      var t=document.querySelector('#prog-'+h+' .ptab[aria-selected="true"]');
      if(t){ mode=t.dataset.tab; }
      applyFilter();
    }
  }
  window.addEventListener('hashchange', fromHash);
  fromHash();
  applyFilter();
})();
"""


def customer_doc_item(cfg, p, first=False):
    fields = [str(p.get(k) or "") for k in ("title", "program", "chip", "group_value", "menu_name")]
    if p.get("project"):
        # '#' 포함으로 넣어 '#이름'과 맨이름 검색이 모두 부분일치한다.
        fields.append("#" + p["project"])
    search = " ".join(fields).lower()
    chip_text = _chip_text(cfg, p)
    chips = '<span class="chip mono">%s</span>' % esc(chip_text) if chip_text else ""
    group_short = p.get("group_value") or p.get("menu_name") or ""
    if group_short:
        chips += '<span class="chip clip">%s</span>' % esc(group_short)
    group_full = " ".join(x for x in (p.get("group_value"), p.get("menu_name")) if x)
    tooltip = " · ".join(x for x in (chip_text, group_full) if x)
    proj_row = ""
    if p.get("project"):
        proj_row = ('<div class="pi-proj" title="#%s"><span class="chip clip">#%s</span></div>'
                    % (esc(p["project"]), esc(p["project"])))
    return (
        '<button type="button" class="progitem" data-prog="%s" data-search="%s"'
        ' data-hasrel="%s" aria-current="%s">'
        '<div class="pi-title">%s</div>'
        '<div class="pi-meta" title="%s">%s</div>%s'
        '<div class="pi-date">%s</div>'
        '</button>'
    ) % (esc(p["program"]), esc(search), "1" if p["release_entries"] > 0 else "0",
         "true" if first else "false", esc(p.get("title") or ""),
         esc(tooltip), chips, proj_row, esc(str(p.get("updated") or "")))


def customer_program_article(cfg, p, first=False):
    """프로그램 기사 — 탭 순서 릴리즈 노트·명세·사용자 가이드. 릴리즈 노트 탭은 모든
    프로그램에 고정 노출된다 — 이력이 없으면 안내 문구(release-notes.md 본문)가 그대로
    보인다. 기본 선택 탭은 이력이 있으면 릴리즈 노트, 없으면 명세."""
    has_rel = p["release_entries"] > 0
    tabs = [("release", "릴리즈 노트"), ("spec", "명세"), ("guide", "사용자 가이드")]
    default = "release" if has_rel else "spec"
    spec_html = p["spec_html"]
    if p.get("project"):
        spec_html += (
            '<div class="projtag"><button type="button" class="proj-chip" data-q="#%s">'
            '#%s</button></div>' % (esc(p["project"]), esc(p["project"])))
    html_map = {"release": _dedupe_release_badges(p["release_html"]),
                "spec": spec_html, "guide": p["guide_html"]}
    tab_btns = "".join(
        '<button type="button" class="ptab" role="tab" data-tab="%s" aria-selected="%s">%s</button>'
        % (k, "true" if k == default else "false", label) for k, label in tabs)
    panes = "".join(
        '<div class="tabpanel%s" role="tabpanel" data-tab="%s"><div class="body">%s</div></div>'
        % (" on" if k == default else "", k, html_map[k]) for k, _ in tabs)
    chip_text = _chip_text(cfg, p)
    chip_html = '<span class="chip mono">%s</span>' % esc(chip_text) if chip_text else ""
    return (
        '<article class="prog%s" id="prog-%s">'
        '<div class="prog-head"><h2>%s %s%s</h2>'
        '<div class="ptabs" role="tablist">%s</div></div>%s</article>'
    ) % (" on" if first else "", esc(p["program"]), esc(p.get("title") or ""),
         chip_html, _group_chip(p), tab_btns, panes)


def _load_panels(cfg, root):
    """docs.customer.panels[] 를 로드한다 — 각 항목은 저장소-상대 파이썬 모듈 경로 +
    탭 라벨(ADR 0060 슬라이스 4). 모듈은 render_panel(repo_root) -> str 을 노출해야 하고,
    선택적으로 <style> 안에 이어붙일 모듈 속성 CSS(str)를 가질 수 있다. 경로 검증은
    harness_config.py 의 panels 검증(오케스트레이터가 병행 작업)에 위임한다 — 이 함수는
    이미 검증된 값만 받는다는 전제 위에서, 파일 부재/로드 실패만 여기서 명명한다."""
    panels = []
    for i, decl in enumerate(cfg.get("panels", []) or []):
        mod_rel = decl.get("module") if isinstance(decl, dict) else None
        label = (decl.get("label") if isinstance(decl, dict) else None) or ("패널 %d" % (i + 1))
        if not mod_rel:
            sys.exit("[오류] docs.customer.panels[%d] 에 module 이 없습니다." % i)
        mod_path = os.path.join(root, str(mod_rel))
        if not os.path.isfile(mod_path):
            sys.exit("[오류] docs.customer.panels 모듈을 찾을 수 없습니다: %s" % mod_path)
        try:
            spec = importlib.util.spec_from_file_location("_cust_panel_%d" % i, mod_path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
        except Exception as e:
            sys.exit("[오류] 패널 모듈을 import 할 수 없습니다: %s (%s)" % (mod_path, e))
        if not hasattr(mod, "render_panel"):
            sys.exit("[오류] 패널 모듈에 render_panel(repo_root) 함수가 없습니다: %s" % mod_path)
        # 렌더 호출도 import 와 같은 보호 아래 — 고객사가 직접 쓰는 확장 코드의 흔한 실수(파일
        # 부재·타입 오류)가 트레이스백이 아니라 모듈을 지목한 exit 로 끝나야 한다(리뷰
        # 2026-08-27 medium). 반환 타입도 계약의 일부다: str 이 아니면 fragment 로 붙일 수 없다.
        try:
            html_frag = mod.render_panel(root)
        except Exception as e:
            sys.exit("[오류] 패널 모듈의 render_panel() 이 실패했습니다: %s (%s: %s)"
                     % (mod_path, type(e).__name__, e))
        if not isinstance(html_frag, str):
            sys.exit("[오류] 패널 모듈의 render_panel() 은 HTML 문자열(str)을 반환해야 합니다: %s "
                     "(반환 타입 %s)" % (mod_path, type(html_frag).__name__))
        css = getattr(mod, "CSS", "") or ""
        if not isinstance(css, str):
            sys.exit("[오류] 패널 모듈의 CSS 는 문자열이어야 합니다: %s (타입 %s)"
                     % (mod_path, type(css).__name__))
        slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or ("panel-%d" % i)
        panels.append({"id": slug, "label": label, "html": html_frag, "css": css})
    return panels


def build_customer_artifact(programs, cfg, panels):
    """docs/customer.artifact.html — claude.ai Artifact fragment(호스트가 <!doctype>/<html>/
    <head>/<body>를 감싼다; build_artifact 와 같은 계약). 내부 문서(ADR/spec)·리포지토리
    경로·내부 상호참조는 이 표면에 절대 렌더링하지 않는다(고객 표면, ADR 0005와 동일 원칙).
    시계 없음(ADR 0060): 빌드 시각 대신 코퍼스의 최신 updated 값을 '문서 생성일'로 쓴다 —
    같은 코퍼스는 언제 빌드해도 같은 바이트를 낸다."""
    title = _declared(cfg, "title", SITE_TITLE + " — 고객 문서")
    eyebrow = _declared(cfg, "eyebrow", "고객 문서")
    description = _declared(cfg, "description", "프로그램별 릴리즈 노트·명세·사용자 가이드")
    contact_row = ""
    if "contact" in cfg["declared"]:
        contact_row = '<span><b>문의처</b> — %s</span>' % esc(cfg["contact"])
    count = len(programs)
    rel_count = sum(1 for p in programs if p["release_entries"] > 0)

    relitems = []
    for p in programs:
        r = _latest_release(p)
        if r:
            relitems.append((r[0], r[1], _release_posture(p, cfg["release_stages"]), p))
    relitems.sort(key=lambda e: e[0], reverse=True)
    months = {}
    for idx, (date, rtitle, badge_html, p) in enumerate(relitems):
        months.setdefault(date[:7], []).append((idx, date, rtitle, badge_html, p))
    relflat = "".join(
        '<div class="relmonth"><div class="rm-head">%s</div>%s</div>' % (
            esc("%d년 %d월" % (int(ym[:4]), int(ym[5:7])) if len(ym) >= 7 and ym[:4].isdigit()
                else (ym or "날짜 미상")),
            "".join(
                '<button type="button" class="relitem" data-prog="%s" data-ri="%d" data-search="%s">'
                '<div class="ri-top"><span class="ri-date">%s</span><span class="chip mono">%s</span></div>'
                '<div class="ri-title">%s</div><div class="ri-sub">%s%s</div></button>' % (
                    esc(p["program"]), idx,
                    esc((date + " " + rtitle + " " + _chip_text(cfg, p) + " "
                         + str(p.get("title") or "")
                         + (" " + re.sub(r"<[^>]+>", "", badge_html) if badge_html else "")
                         + ((" #" + p["project"]) if p.get("project") else "")).lower()),
                    esc(date), esc(_chip_text(cfg, p)),
                    esc(str(p.get("title") or "")), esc(rtitle),
                    (" " + badge_html) if badge_html else "")
                for idx, date, rtitle, badge_html, p in entries))
        for ym, entries in sorted(months.items(), reverse=True))
    first_id = programs[0]["program"] if programs else ""
    items = "".join(
        '<section class="pgroup"><button type="button" class="pghead" aria-expanded="%s">'
        '<span class="pgarrow">▸</span>%s<span class="pgcount">%d</span></button>'
        '<div class="pgitems%s">%s</div></section>' % (
            "true" if opened else "false", esc(label), len(members),
            " on" if opened else "",
            "".join(customer_doc_item(cfg, p, first=(p["program"] == first_id)) for p in members))
        for label, members in customer_sidebar_groups(programs, cfg)
        for opened in [label == RECENT_GROUP_LABEL])
    articles = "".join(customer_program_article(cfg, p, first=(i == 0)) for i, p in enumerate(programs))
    max_updated = max((str(p.get("updated") or "") for p in programs), default="")

    top_tabs = ['<button type="button" class="toptab" role="tab" data-top="docs" aria-selected="true">'
                '문서 모음 <span class="chip">명세 %d건</span><span class="chip">릴리즈 노트 %d건</span></button>'
                % (count, rel_count)]
    top_panels = ['<div class="toppanel on" data-top="docs"><div class="docview">'
                  '<aside class="doclist"><div class="search">%s'
                  '<input type="search" placeholder="프로그램 검색 (제목·코드·분류·#프로젝트)" aria-label="프로그램 검색"></div>'
                  '<div class="proglist">%s</div>'
                  '<div class="relflat">%s</div>'
                  '<div class="noresult" hidden>검색 결과가 없습니다</div></aside>'
                  '<div class="docmain">%s</div>'
                  '</div></div>' % (SEARCH_ICON, items, relflat, articles)]
    extra_css = ""
    for pl in panels:
        top_tabs.append(
            '<button type="button" class="toptab" role="tab" data-top="%s" aria-selected="false">%s</button>'
            % (esc(pl["id"]), esc(pl["label"])))
        top_panels.append('<div class="toppanel" data-top="%s">%s</div>' % (esc(pl["id"]), pl["html"]))
        if pl["css"]:
            extra_css += pl["css"]

    body = (
        '<header class="cust-app"><div class="cust-in">'
        '<div class="eyebrow">%s</div>'
        '<div class="toptabs" role="tablist">%s</div>'
        '</div></header>'
        '<main class="cust-main">%s</main>'
        '<footer class="cust-foot">%s<span>문서 생성일 %s</span></footer>'
    ) % (esc(eyebrow), "".join(top_tabs), "".join(top_panels), contact_row, esc(max_updated))

    return (
        '<title>%s</title>'
        '<meta name="description" content="%s">'
        '<style>%s%s</style>'
        '%s<script>%s</script>'
    ) % (esc(title), esc(description), CUSTOMER_CSS, extra_css, body, CUSTOMER_JS)


def _selfcheck_release_helpers():
    """빌드 시 결정론 회귀 게이트: 배지/동점 로직은 client-pjems 포크에서 조용히 회귀한
    전력이 있어(GLPrint 카드 UAT 칩 실종) 합성 픽스처로 계약을 고정한다. main() 에서는
    호출하지 않는다 — 셀프테스트가 `python -c "import build_docs; build_docs.
    _selfcheck_release_helpers()"` 로 직접 부른다(모듈 import 자체는 SITE_TITLE 계산 외에
    부작용이 없어야 한다)."""
    stages = [{"tag": "FUT", "label": "FUT"}, {"tag": "UAT", "label": "UAT"},
              {"tag": "PROD", "label": "COMPLETE"}]
    raw = (
        '## 2026-08-14 — A-first [UAT]\n'
        '## 2026-08-14 — Z-second\n'
        '## 2026-08-03 — old [PROD]\n'
    )
    fx = {"release_html": _mark_release_status(convert_body(raw.split("\n")), stages)}
    r = _latest_release(fx)
    # 옛 버그: 문자열 전체 max 가 같은 날짜에서 Z-second 를 뽑았다 — 문서 위쪽 우선.
    assert r and r[0] == "2026-08-14" and r[1] == "A-first", \
        "_latest_release tie-break regression: %r" % (r,)
    assert "진행 중" in _release_posture(fx, stages), "posture: 활성 최상단 배지는 진행 중"
    empty_fx = {"release_html": _mark_release_status(
        convert_body("## 2026-08-01 — x\n".split("\n")), stages)}
    assert _release_posture(empty_fx, stages) == "", "posture: 배지 없는 문서는 무칩"
    prod_fx = {"release_html": _mark_release_status(
        convert_body("## 2026-08-01 — x [PROD]\n".split("\n")), stages)}
    assert "완료" in _release_posture(prod_fx, stages), "posture: 최상단 PROD 는 완료"
    assert '<span class="relstat rs-fut">FUT</span>' in fx["release_html"], \
        "기본 어휘의 배지 클래스는 rs-fut (포크와 바이트 동일)"


# --------------------------------------------------------------- main
def main():
    # 단순 sys.argv 스캔 — argparse 불필요(플래그 2종 + 값 1개뿐, 파일 전체가 stdlib 미니멀 스타일).
    argv = sys.argv[1:]
    customer_mode = "--customer" in argv
    version = None
    if "--version" in argv:
        vi = argv.index("--version")
        if vi + 1 < len(argv):
            version = argv[vi + 1]

    adrs = collect(ADR_DIR)
    specs = collect(SPEC_DIR)
    if not adrs and not specs:
        sys.exit("adr/·spec/ 에서 frontmatter 포함 .md 를 찾지 못했습니다.")

    if customer_mode:
        build_customer(adrs, specs, version)
        return

    # 모든 표면을 메모리에서 먼저 만든다 — 고객 표면의 거부(exit 1)가 4-표면만 새로 쓰인 반쪽
    # 산출물을 남기면, 종료 코드를 보지 않는 호출자는 "내부 문서 최신 · 고객 문서 stale" 을
    # 그대로 커밋한다(리뷰 2026-08-27 medium). 검증을 전부 통과한 뒤에만 파일을 쓴다.
    outputs = [
        (OUT_JSON, json.dumps(build_json(adrs, specs, fm_digest()), ensure_ascii=False, indent=2)),
        (OUT_INDEX_MD, build_index_md(adrs, specs)),
        (OUT_HTML, build_html(adrs, specs)),
        (OUT_ARTIFACT, build_artifact(adrs, specs)),
    ]

    # 고객 코퍼스 표면 (ADR 0060) — 선언됐을 때만, 4-표면 빌드 위에 추가로.
    cust = _load_customer_decl()
    cust_count = 0
    if cust is not None:
        root, _raw = _find_declaration()
        programs = collect_customer_docs(cust, root)
        panels = _load_panels(cust, root)
        outputs.append((OUT_CUSTOMER_ARTIFACT, build_customer_artifact(programs, cust, panels)))
        if cust.get("projects_md"):
            outputs.append((OUT_PROJECTS, build_projects_md(programs, cust)))
        cust_count = len(programs)

    for path, text in outputs:
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)

    suffix = " · 고객 프로그램 %d" % cust_count if cust is not None else ""
    print("[OK] 생성 완료 (ADR %d · SPEC %d%s)" % (len(adrs), len(specs), suffix))
    print("     - index.json        (에이전트/기계)")
    print("     - INDEX.md           (경량 목차)")
    print("     - docs.html          (사람용 브라우징)")
    print("     - docs.artifact.html (claude.ai Artifact 발행용)")
    if cust is not None:
        print("     - customer.artifact.html (claude.ai Artifact 발행용 — 고객, %d개 프로그램)" % cust_count)
        if cust.get("projects_md"):
            print("     - PROJECTS.md        (프로젝트 -> 고객 명세 매핑)")


if __name__ == "__main__":
    main()
