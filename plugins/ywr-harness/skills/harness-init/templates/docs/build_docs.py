#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
docs-as-code 생성기 — docs/adr/*.md + docs/spec/*.md (YAML frontmatter + 본문)에서
세 표면(surface)을 한 번에 생성한다:

  - docs/index.json   : 에이전트/기계가 로드하는 구조화 메타 + 의존 그래프
  - docs/INDEX.md     : 사람/에이전트용 경량 자동 목차
  - docs/docs.html    : 사람용 단일 브라우징 HTML (상태 배지 · 메타 패널 · 교차링크)

설계 원칙:
  - 진실원은 docs/adr, docs/spec 의 개별 .md (frontmatter + 본문).
    상태/날짜/관계는 frontmatter가 단일 출처 → 산출물(위 3개)은 직접 편집 금지.
  - 외부 의존성 없음(파이썬 표준 라이브러리만). frontmatter는 본 파일의 미니 파서로 처리.
  - 0000-template.md 는 스캔에서 제외.

사용:
  python docs/build_docs.py [YYYY-MM-DD]   (또는 pwsh docs/build.ps1 / bash docs/build.sh)
  python docs/build_docs.py --customer [--version <라벨>]   (고객 배포용 표면만 생성)

브랜딩(선택):
  환경변수 DOCS_SITE_TITLE 로 상단 제목을 바꾼다. 미설정 시 "Docs · ADR & Spec".

고객 배포 표면 (ADR 0005):
  frontmatter `audience: customer` 인 문서만(화이트리스트) 골라 단일 자기완결
  docs/customer.html 을 만든다(이메일 첨부용). 기본값은 internal — 내부 문서는
  절대 이 표면에 섞이지 않는다. 제목은 DOCS_CUSTOMER_TITLE(미설정 시
  DOCS_SITE_TITLE + " — 고객 배포판"). --version 은 헤더 버전 스탬프에만 쓰인다.

요구사항: Python 3.9+ (표준 라이브러리만, 외부 의존성 0). CI 러너는 3.12 로 고정한다.

Copyright (c) 2026 YWR Labs Inc. All rights reserved.
Author: Hyungjun Kim (John Kim) <johnkim@ywrlabs.com>
"""
import datetime
import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
ADR_DIR = os.path.join(ROOT, "adr")
SPEC_DIR = os.path.join(ROOT, "spec")
OUT_JSON = os.path.join(ROOT, "index.json")
OUT_INDEX_MD = os.path.join(ROOT, "INDEX.md")
OUT_HTML = os.path.join(ROOT, "docs.html")
OUT_ARTIFACT = os.path.join(ROOT, "docs.artifact.html")
OUT_CUSTOMER = os.path.join(ROOT, "customer.html")

SCHEMA_VERSION = "docs-as-code/1"
SITE_TITLE = os.environ.get("DOCS_SITE_TITLE", "Docs · ADR & Spec")
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
            i += 1
            buf = []
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
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
            t = ["<table>", "<thead><tr>%s</tr></thead>" % "".join("<th>%s</th>" % inline(c) for c in header), "<tbody>"]
            for row in rows:
                t.append("<tr>%s</tr>" % "".join("<td>%s</td>" % inline(c) for c in row))
            t += ["</tbody>", "</table>"]
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
                items.append(inline(re.sub(r"^\s*[-*]\s+", "", lines[i]).rstrip()))
                i += 1
            out.append("<ul>\n%s\n</ul>" % "\n".join("<li>%s</li>" % it for it in items))
            continue
        if re.match(r"^\s*\d+\.\s+", line):
            items = []
            while i < n and re.match(r"^\s*\d+\.\s+", lines[i]):
                items.append(inline(re.sub(r"^\s*\d+\.\s+", "", lines[i]).rstrip()))
                i += 1
            out.append("<ol>\n%s\n</ol>" % "\n".join("<li>%s</li>" % it for it in items))
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
            buf.append(inline(cur.strip()) + ("<br>" if cur.endswith("  ") else ""))
            i += 1
        out.append("<p>%s</p>" % " ".join(buf))
    return "\n".join(out)


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
        body_lines = body.split("\n")
        k = 0
        while k < len(body_lines) and body_lines[k].strip() == "":
            k += 1
        if k < len(body_lines) and re.match(r"^#\s+", body_lines[k]):
            del body_lines[k]
        meta["_body_html"] = convert_body(body_lines)
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
.body table{border-collapse:collapse;width:100%;margin:14px 0;font-size:13px;display:block;overflow-x:auto;border:1px solid var(--line);border-radius:10px}
.body th,.body td{border-bottom:1px solid var(--line-soft);border-right:1px solid var(--line-soft);padding:8px 12px;text-align:left;vertical-align:top}
.body th{background:var(--surface-2);color:var(--ink);font-weight:640;white-space:nowrap}
.body tr:last-child td{border-bottom:0}.body td:last-child,.body th:last-child{border-right:0}
.body pre{background:#0b0d13;border:1px solid var(--line);color:#cdd3e8;padding:15px 17px;border-radius:10px;overflow-x:auto;font:12.5px/1.6 var(--mono)}
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
               'stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>')

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

    with open(OUT_JSON, "w", encoding="utf-8", newline="\n") as f:
        json.dump(build_json(adrs, specs, fm_digest()), f, ensure_ascii=False, indent=2)
    with open(OUT_INDEX_MD, "w", encoding="utf-8", newline="\n") as f:
        f.write(build_index_md(adrs, specs))
    with open(OUT_HTML, "w", encoding="utf-8", newline="\n") as f:
        f.write(build_html(adrs, specs))
    with open(OUT_ARTIFACT, "w", encoding="utf-8", newline="\n") as f:
        f.write(build_artifact(adrs, specs))

    print("[OK] 생성 완료 (ADR %d · SPEC %d)" % (len(adrs), len(specs)))
    print("     - index.json        (에이전트/기계)")
    print("     - INDEX.md           (경량 목차)")
    print("     - docs.html          (사람용 브라우징)")
    print("     - docs.artifact.html (claude.ai Artifact 발행용)")


if __name__ == "__main__":
    main()
