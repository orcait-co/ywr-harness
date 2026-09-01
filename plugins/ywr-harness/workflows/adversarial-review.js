// 적대 코드리뷰 표준 워크플로 (ADR #50, 티어 #104) — 렌즈 파인더 + 시맨틱 중복제거 + 심각도 게이트 검증.
// 호출: Workflow({name: 'ywr-harness:adversarial-review', args: {scope: '<리뷰 대상+하우스 컨텍스트 블록>',
//   tier?: 'small', root?: '<레포 루트>', lenses?: [{key, prompt}], lensExtra?: '<하우스 앵글>',
//   shards?: 'auto' | n | [[files…], …]  (scope.files 필요 — 렌즈별 파인더를 파일 샤드로 분할, ADR 0070)}})
//
// 이 파일의 ADR 번호는 별도 표기가 없으면 ywrlabs/ywr-platform 의 것이다 — 이 워크플로가 자란 곳이고
// 근거 기록이 거기 있다. 렌즈 기본값은 레포 무관하게 일반화돼 있고, 하우스 고유 앵글(테넌시 격리
// 구현·클린룸 명명·특정 결정 경계 등)은 args.lensExtra 로 호출자가 주입한다 — 정본에 특정 레포의
// 어휘를 굽지 않기 위한 것이다(ywr-harness ADR 0010 경계 질문: 다른 레포에서도 똑같이 참인가?).
// tier 'small'(ADR #104: ≤150 diff 라인·≤5 파일·크리티컬 표면 무접촉 — RLS/수치코어/인가/
// 마이그레이션/훅·CI 제외) = 병합 2렌즈·렌즈당 6건. 그 외 = 풀 3렌즈. skeptic 게이트는 동일.
// 워커 모델은 전역 CLAUDE.md 규칙대로 sonnet 고정 · effort 는 상한 high(세션 effort 상속 금지,
// 2026-07-13 — xhigh/max 딥워크 누수 차단). 대량 팬아웃 전 카나리아로 한도 확인(증발 재발 방지).
// 슬라이스당 1회가 기본(ywr-harness ADR 0028): 확정 지적의 수정 diff 는 재호출 대상이 아니다 —
// 게이트 재실행 + 지적별 수정 대조로 닫는다. 새 메커니즘급 수정만 1회 한정 재리뷰(마감에 기준 명기).
export const meta = {
  name: 'adversarial-review',
  description: '적대 코드리뷰 표준 — 렌즈 티어(풀3·small2)·시맨틱 dedupe·심각도 게이트(h/m=2·low=1·nit=0 skeptic)',
  whenToUse: '슬라이스 마감 게이트 리뷰 — 슬라이스당 1회. args.scope 에 대상 파일 목록 + 하우스 불변식 + 이미 통과한 게이트를 넣는다(diff 슬라이스는 git diff 주입). 소형 비크리티컬 diff 는 args.tier:"small". 레포의 결정론 린트 게이트를 먼저 돌리고 통과 결과를 게이트 블록에 포함할 것. 하우스 고유 렌즈 앵글은 args.lensExtra 로 주입한다. 이 리뷰의 확정 지적을 고친 수정 diff 는 재호출 대상이 아니다 — 게이트 재실행 + 지적별 수정 대조로 닫고, 수정이 패치가 아니라 새 메커니즘일 때만 1회 한정 재리뷰.',
  phases: [
    { title: 'Canary', detail: '한도/게이트웨이 확인 1개 (sonnet · reviewer 에이전트)', model: 'sonnet' },
    { title: 'Find', detail: '렌즈 병렬 — 풀 3 · small 2 (sonnet·effort medium · reviewer 에이전트)', model: 'sonnet' },
    { title: 'Dedupe', detail: 'file:line 키 + >12건이면 haiku 그룹핑(effort low · 기본 서브에이전트)', model: 'haiku' },
    { title: 'Verify', detail: 'high/med=2 · low=1 skeptic(effort low · reviewer 에이전트) · nit=생략', model: 'sonnet' },
  ],
}

// effort 상한 high(2026-07-13): 세션 상속 금지 — xhigh/max 딥워크 세션의 effort 가 워커로
// 누수되는 것을 차단. 세션이 high 미만이어도 워커는 high 로 뜬다(스크립트에서 세션 effort
// 조회 불가 → 명시 고정이 유일한 상한 수단). 더 낮춰야 할 스테이지는 opts 로 override.
// agentType(ywr-harness ADR 0069, 2026-09-02 실측): 기본 워크플로 서브에이전트의 프리픽스는
// 요청당 ~36k 토큰이고 그 절반이 파인더/스켑틱이 한 번도 부르지 않는 도구 스키마다(Artifact·
// Workflow·Agent·Edit·Write·PowerShell …). 도구 허용목록을 가진 플러그인 에이전트로 띄우면 그
// 스키마가 프리픽스에서 빠진다 — 워커 요청마다 다시 읽히는 값이라 요청 수만큼 곱해진다(small 티어
// 59 요청 실측: 요청당 캐시 읽기 −29%, 총 컨텍스트 토큰 −26%). 이름은 네임스페이스 형(fact 1) — bare 이름은
// 해석되지 않는다.
// opts.effort 가 에이전트 정의의 effort 핀을 덮어쓰는 것은 실측됨(정의 medium · 호출 low → low).
const REVIEWER = 'ywr-harness:reviewer'
const work = (prompt, opts = {}) => agent(prompt, { model: 'sonnet', effort: 'high', agentType: REVIEWER, ...opts })

// args 는 객체가 정석. 문자열이면 JSON 인코딩 → 파싱, 비JSON 평문 → scope 블록 자체로 수용
// (2026-07-08 회고: 스킬 경유 호출이 "scope: ..." 평문을 넘겨 JSON.parse 즉사 — 어떤 형태든 죽지 않게).
const _args = (() => {
  if (typeof args !== 'string') return args || {}
  try {
    const parsed = JSON.parse(args)
    return typeof parsed === 'object' && parsed !== null ? parsed : { scope: String(parsed) }
  } catch {
    return { scope: args }
  }
})()
if (!_args.scope) throw new Error("args.scope 필요 — 리뷰 대상 파일 목록 + 하우스 컨텍스트 블록")
// 스코프는 문자열 블록 또는 구조화 객체({files, invariants, ...}) — 객체는 직렬화해 프롬프트에 주입.
// (2026-07-02 회고: 객체를 템플릿에 그대로 넣으면 "[object Object]" 로 스코프가 증발 → 파인더 드리프트 근원)
const SCOPE = typeof _args.scope === 'string' ? _args.scope : JSON.stringify(_args.scope, null, 2)
// scope.files 가 주어지면 스코프 밖 확정 지적을 별도 버킷으로 분리(게이트 대상 아님·후속 후보 — 버리지 않는다).
const SCOPE_FILES = (typeof _args.scope === 'object' && Array.isArray(_args.scope.files))
  ? _args.scope.files.map(s => String(s).replace(/\\/g, '/'))
  : null

// 동적 파인더 분할(ywr-harness ADR 0070): scope.files 가 있으면 렌즈별 파인더를 파일 샤드로 나눈다.
// 벽시계 시간은 가장 느린 파인더의 순차 왕복 수가 정한다(2026-09-02 실측: 바쁜 파인더 27요청·326s, 형제
// 파인더는 2요청) — 담당 파일을 줄이면 그 왕복이 줄고, 대가는 파인더 수만큼의 프리픽스(reviewer ~16k)다.
// args.shards: 미지정/1 = 분할 없음 · 'auto' = ceil(files/SHARD_FILES), 최대 MAX_SHARDS · 정수 n = n 등분
// (연속 구간 — 호출자의 파일 순서가 결합 단위다: 같이 바뀐 파일은 붙여 적을 것) · 배열의 배열 = 호출자가
// 명시한 그룹(결합된 파일을 같은 샤드에). scope.files 없이 분할을 요구하면 예외 — 문자열 스코프는 나눌 수
// 없고, 조용히 1개로 강등하면 "나눴다"고 읽힌다(빈 집합은 통과가 아니다).
const SHARD_FILES = 4, MAX_SHARDS = 4
const SHARD_NOTES = []   // 분할 결정이 호출자 요청과 달라진 점 — log 로 노출한다(무음 강등 금지)
const SHARDS = (() => {
  const s = _args.shards
  if (s === undefined || s === null || s === 1) return [null]
  if (!SCOPE_FILES) throw new Error('args.shards 는 scope.files(배열)가 있을 때만 유효하다 — 문자열 스코프는 분할할 수 없다')
  if (Array.isArray(s)) {
    // 명시 그룹은 scope.files 의 정확한 분할이어야 한다(리뷰 2026-09-02, high): 빠진 파일은 어느 파인더도
    // 맡지 않은 채 stats 가 완전 커버리지로 읽히고, 스코프 밖 파일은 "스코프 파일만 읽어라"와 모순되는
    // 프롬프트가 되며, 중복 배정은 같은 결함을 두 번 스켑틱에 보내는 비용이다. 셋 다 예외 — 이름을 적어서.
    const groups = s.map(g => (Array.isArray(g) ? g.map(x => String(x).replace(/\\/g, '/')).filter(Boolean) : [])).filter(g => g.length)
    if (groups.length < 2) throw new Error('args.shards 배열은 비어있지 않은 파일 그룹 2개 이상이어야 한다')
    const flat = groups.flat(), seen = new Set(), dup = []
    for (const f of flat) { if (seen.has(f)) dup.push(f); seen.add(f) }
    const extra = flat.filter(f => !SCOPE_FILES.includes(f)), missing = SCOPE_FILES.filter(f => !seen.has(f))
    if (dup.length || extra.length || missing.length) {
      throw new Error(`args.shards 그룹이 scope.files 의 분할이 아니다 — 중복: [${[...new Set(dup)].join(', ')}] · 스코프 밖: [${extra.join(', ')}] · 미배정: [${missing.join(', ')}]`)
    }
    return groups
  }
  const n = s === 'auto' ? Math.min(MAX_SHARDS, Math.ceil(SCOPE_FILES.length / SHARD_FILES)) : Number(s)
  if (!Number.isInteger(n) || n < 1) throw new Error(`args.shards 값이 유효하지 않다: ${JSON.stringify(s)}`)
  if (n === 1 || SCOPE_FILES.length < 2) {
    if (n > 1) SHARD_NOTES.push(`파일 ${SCOPE_FILES.length}개는 나눌 수 없어 분할 없음(요청 ${n})`)
    return [null]
  }
  // 균등 분할(리뷰 2026-09-02, medium): ceil 크기의 연속 슬라이스는 뒤 그룹이 비어 요청보다 적은 샤드를
  // 조용히 내놓았다(4파일·3샤드 → 2/2/0). 나머지를 앞에서부터 하나씩 얹어 k 개를 정확히 채운다.
  const k = Math.min(n, SCOPE_FILES.length)
  if (k < n) SHARD_NOTES.push(`샤드 ${n} 요청 → 파일 ${SCOPE_FILES.length}개라 ${k}개`)
  const base = Math.floor(SCOPE_FILES.length / k), rem = SCOPE_FILES.length % k
  const out = []
  for (let i = 0, at = 0; i < k; i++) { const size = base + (i < rem ? 1 : 0); out.push(SCOPE_FILES.slice(at, at + size)); at += size }
  return out
})()
const SHARDED = SHARDS[0] !== null
// 레포 루트는 파인더/검증자 프롬프트의 정보성 한 줄에만 쓰인다. 특정 레포의 절대경로를 기본값으로
// 굽는 것은 정본에서 결함이다(다른 레포에서 거짓인 지식) — 주어지지 않으면 그 줄을 아예 빼고,
// 에이전트는 세션 cwd 를 쓴다. 워크플로 스크립트에는 Node API 가 없어 cwd 조회로 대체할 수도 없다.
const ROOT = _args.root ? String(_args.root) : null
const ROOT_LINE = ROOT ? `(레포 루트: ${ROOT})` : ''
const ROOT_LINE_PLAIN = ROOT ? `레포 루트: ${ROOT}\n` : ''

// 페이즈별 출력 토큰 계측(ADR 0086, 상한 표기로 교정 ADR 0129) — budget.spent() 는 메인 루프와
// 공유 풀이라 워크플로 단독 비용이 아니다: 실행 중 오케스트레이터가 낸 출력이 그대로 랩에 얹힌다
// (감사에서 카나리아 랩이 4,077 로 기록된 사례 — 실제 카나리아 응답은 한 단어다).
// **SubagentStop 원장(ADR 0112)으로 대체할 수 없다**: 그 이벤트 입력에는 토큰/시간 필드가 아예
// 없고(0112 결정 2, doc-verified) 원장은 who/what/when 만 적는다. 그래서 여기서 하는 일은
// 정확도를 올리는 게 아니라 **정확한 척하지 않게 만드는 것**이다:
//   1) 이름을 upper bound 로 — exact 로 읽히는 이름이 결함이었다.
//   2) 오염을 정량화 — 카나리아 응답은 한 단어 고정이므로 그 랩의 초과분이 메인 루프 유입의
//      하한 추정치다. 0 이면 그 창에서는 유입이 없었다는 뜻이고, 크면 그 런의 모든 랩을 의심한다.
//   3) 에이전트 수를 함께 — 이건 워크플로가 정확히 안다(공유 풀이 아니다). 토큰 상한의 분모.
const CANARY_EXPECTED_OUT = 8   // "ok" 한 단어 + 오버헤드의 넉넉한 상한
const _t0 = budget.spent()
let _mark = _t0
const outTokens = {}
const agentsPerPhase = {}
const countAgents = (name, n) => { agentsPerPhase[name] = (agentsPerPhase[name] || 0) + n }
const lap = (name) => { const s = budget.spent(); outTokens[name] = s - _mark; _mark = s }

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['high', 'medium', 'low', 'nit'] },
          claim: { type: 'string', description: '무엇이 왜 잘못인가 — 구체적 실패 시나리오 포함' },
          evidence: { type: 'string', description: '코드 근거(인용/라인)' },
        },
        required: ['title', 'file', 'severity', 'claim', 'evidence'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean', description: 'true=지적이 틀렸거나 실제 위험 아님' },
    reason: { type: 'string' },
  },
  required: ['refuted', 'reason'],
}

// 렌즈(ADR #50 §1 + #104 보강) — 파인더는 스코프 파일만 읽는다(탐색 금지).
// #104 파일럿 보강 절: 프레임워크 수명주기 함정 + 삭제라인 불변식 재확립 감사 —
// A/B 파일럿에서 하우스 렌즈가 놓친 두 앵글 클래스(스테일 리마운트 버그가 이 클래스였다).
const PITFALL_CLAUSE =
  '프레임워크 수명주기 함정(마운트-1회 파싱 vs 클라이언트 내비게이션, 리마운트/키 가정, stale closure, 이펙트 의존성)과 diff 가 삭제/교체한 라인이 지키던 불변식이 새 코드 어디서 재확립되는지(재확립 부재 = 지적)를 함께 검증하라.'

// 기본 렌즈는 레포 무관하게 일반화한다 — 특정 레포의 어휘(스키마 종류·격리 구현·명명 규칙)를
// 정본에 굽으면 다른 레포에서 거짓인 지시가 된다. 하우스 어휘는 args.lensExtra 로 붙는다.
const DEFAULT_FULL = [
  {
    key: 'correctness-security',
    prompt: `정확성·보안 렌즈: 데이터 접근 계층을 스키마/모델 정의와 대조, 테넌시·인가 경로·식별자 주입 표면·입력 검증, 실패모드(멱등·동시성·트랜잭션 경계·오류 삼킴·상태코드 구분)를 검증하라. ${PITFALL_CLAUSE}`,
  },
  {
    key: 'boundary-docs',
    prompt: '경계·문서 렌즈: 결정 기록(ADR)과 구현의 드리프트, 스펙 서술 정합, 새 의존성 유입, 결정론 계산과 LLM 판단의 경계를 검증하라.',
  },
  {
    key: 'ui-tests',
    prompt: 'UI·테스트 렌즈: 프론트 상태 경합/stale·오류 피드백·타입 정합(생성물 대조)·프레임워크 규약, 그리고 테스트/E2E 의 단정 강도·동어반복·정리 누수·커버리지 공백(오류경로·경계값)을 검증하라.',
  },
]

// small 티어(ADR #104) — 병합 2렌즈. skeptic 게이트·dedupe 는 풀과 동일.
const DEFAULT_SMALL = [
  {
    key: 'correctness-pitfalls',
    prompt: `정확성·보안 통합 렌즈: 입력 검증·인가 경로·실패모드(멱등·동시성·오류 삼킴), 상태 경합/stale. ${PITFALL_CLAUSE}`,
  },
  {
    key: 'boundary-ui-tests',
    prompt: '경계·문서·UI·테스트 통합 렌즈: ADR/스펙 드리프트·새 의존성·결정론 vs LLM 경계, 그리고 테스트/스모크의 단정 강도·커버리지 공백(신설 표면의 회귀 게이트 부재 포함)을 검증하라.',
  },
]

const TIER = _args.tier === 'small' ? 'small' : 'full'
// 렌즈 결정 순서: args.lenses 전면 override > 티어 기본값. 어느 쪽이든 args.lensExtra 가 모든 렌즈
// 프롬프트 끝에 붙는다. 앵글 하나를 추가하려고 렌즈 전체를 재정의하게 만들면 정본의 기본값 개선이
// 그 레포에 영원히 도달하지 못한다 — 로컬 포크와 같은 결과다(ywr-harness ADR 0010).
const _base = (Array.isArray(_args.lenses) && _args.lenses.length)
  ? _args.lenses.filter(l => l && l.key && l.prompt)
  : (TIER === 'small' ? DEFAULT_SMALL : DEFAULT_FULL)
if (!_base.length) throw new Error('args.lenses 가 주어졌으나 {key, prompt} 를 갖춘 항목이 없다 — 렌즈 0개는 리뷰가 아니다(빈 집합은 통과가 아니다)')
const HOUSE = _args.lensExtra ? ' ' + String(_args.lensExtra) : ''
const LENSES = _base.map(l => ({ key: String(l.key), prompt: String(l.prompt) + HOUSE }))
const FIND_CAP = TIER === 'small' ? 6 : 8

phase('Canary')
const canary = await work('아래 단어로만 답하라: ok', { label: 'canary', phase: 'Canary', effort: 'low' })
if (canary === null) throw new Error('카나리아 실패(한도/게이트웨이) — 팬아웃 중단')
countAgents('canary', 1)
lap('canary')

// 인용 검증 절(ADR 0115): high effort 의 우위는 "더 생각해서"가 아니라 "원본을 다시 읽어서"
// 나왔다 — A/B 실측(wf_2a26a277 high vs wf_a54aedab medium)에서 medium 이 놓친 3건이 전부
// 스코프 텍스트 밖 왕복이 필요한 인용 결함이었다. 그 왕복을 프롬프트로 명시 요구한다.
// 조회 묶기 + 로컬 우선(ywr-harness ADR 0070, 2026-09-02 실측): 바쁜 파인더 27요청 중 도구 호출 35개, 병렬
// 묶음은 5요청뿐 — 왕복 하나가 컨텍스트 전체를 다시 읽고 요청당 ~6초다. 벽시계와 캐시 읽기 둘 다 왕복 수에
// 비례하므로 독립 조회는 한 턴에 낸다. 인용 검증의 Bash 20회 중 다수는 레포 안에 원본이 있는데도 원격을
// 받은 것 — 스코프가 로컬 경로를 지목하면 그 Read 가 조회다.
// 샤드 파인더에게 "스코프 파일 전부"는 담당 절과 모순된다(리뷰 2026-09-02, medium) — 담당 파일 전부로 바꿔 말한다.
const parallelClause = (u) =>
  `조회는 묶어서 내라: 서로 독립인 Read·Grep·curl 은 한 턴에 병렬 도구 호출로 — 새 턴(왕복)은 앞 결과에 따라 다음 조회가 달라질 때만. ${u.shard ? '담당 파일 전부' : '스코프 파일 전부'}는 첫 턴에 한 번에 읽어라. `
const CITATION_CLAUSE =
  '인용 검증(스코프 밖 탐색 금지의 명시적 예외): 스코프의 주장이 외부 레퍼런스(공식 문서·다른 ADR/spec·생성물·설정 스키마)를 인용하거나 그에 의존하면 그 원본을 실제로 조회해 대조하라. 스코프가 근거의 로컬 경로(레포 안 ADR·spec·생성물·스키마)를 지목했으면 그 파일을 Read 하는 것이 조회다 — 원격 조회는 로컬 원본이 없을 때만. 열거/표는 행 수를 세고, 인용문은 전문을 확인한다 — 잘린 열거(한 행 누락)와 한정절이 빠진 인용은 그 자체로 지적 대상이다. 조회 수단을 근거에 적어라. ' +
  '**부재 주장에는 더 강한 근거가 필요하다(ADR 0129)**: "그 필드/행/변수가 원본에 없다"를 렌더링 조회(WebFetch 등)만으로 적지 마라 — 큰 페이지는 조용히 잘린 뷰로 돌아온다. 실측 2026-07-26: 332,870 바이트짜리 공식 env-vars 페이지에서 실재하는 변수 하나를 WebFetch 가 서로 다른 프롬프트 3회 모두 "not found" 로 답했고, 같은 URL 을 `curl` 로 받아 로컬 grep 하면 263행에 있었다. 부재는 raw 원본을 받아(가능하면 `.md` URL) 로컬에서 grep 한 뒤에만 주장하고 그 명령을 근거에 적어라. 확인하지 못했으면 "없다"가 아니라 "확인 실패"로 적어라 — 존재 주장보다 부재 주장이 더 비싸다.'

// 샤드 절: 담당 파일 밖의 결함도 버리지 않는다 — 두 파일의 조합에서만 드러나는 결함(ywr-harness fact 36 의
// 부류)은 분할의 대표 실패 모양이므로, 참조 읽기는 허용하고 dedupe 가 형제 파인더의 중복을 합친다.
const shardLine = (u) => u.shard
  ? `\n담당 파일(샤드 ${u.si + 1}/${u.sn}): ${u.shard.join(', ')}\n나머지 스코프 파일은 형제 파인더가 맡는다 — 담당 파일과 상호작용하는 참조 파일은 읽어도 되지만, 지적은 담당 파일 기준으로 낸다. 두 파일의 조합에서만 드러나는 결함이 의심되면 severity 를 낮추지 말고 그대로 보고하라 — 파일과 라인을 정확히 적어라(같은 file:line 의 중복만 dedupe 가 합친다).\n`
  : ''

const findPrompt = (u) => `너는 이 레포의 적대적 코드리뷰어다.
${SCOPE}
${ROOT_LINE}${shardLine(u)}
${u.lens.prompt}

규칙: 위 스코프에 명시된 파일만 Read 하라(그 밖 탐색 금지 — 스키마/규약 대조에 필요한 참조 파일, 그리고 아래 인용 검증은 예외). ${parallelClause(u)}${CITATION_CLAUSE} 스타일 취향 제외, 실제 버그/위험/규칙위반만. 이미 통과한 게이트와 모순되는 주장 금지(단 게이트가 못 잡는 결함은 가능 — 왜 못 잡는지 명시). 각 지적은 구체적 실패 시나리오 필수. 확신 없으면 severity 를 낮춰라. 최대 ${FIND_CAP}건.`

// 파인더 단위 = 렌즈 × 샤드. 분할이 없으면 라벨은 종전과 같다(`find:<key>`); 분할되면 `find:<key>#<i>`.
const UNITS = LENSES.flatMap(l => SHARDS.map((shard, si) => ({ lens: l, shard, si, sn: SHARDS.length })))
const unitKey = (u) => (u.shard ? `${u.lens.key}#${u.si + 1}` : u.lens.key)

// find effort medium(ADR 0129 — 0115 결정 1 supersede). 0115 는 medium 을 실측으로 기각했지만
// 그때 잃은 3건이 전부 "스코프 텍스트 밖 왕복이 필요한" 인용 결함이었고, 같은 슬라이스가 그
// 왕복을 요구하는 CITATION_CLAUSE 를 넣었다. 절을 켠 채 재측정(wf_0674e5fa, 같은 recipe 재구성본):
// 인용 2건(D2 열거 절단·D3 한정절 누락)이 둘 다 복구됐고 D1 은 부분→완전, 출력은 high 대비
// −34%(find −31%). 남은 격차는 스코프 목록 밖 파일 발견 1건뿐인데, 그건 effort 가 아니라
// 프롬프트가 금지한 행위를 high 가 가끔 어겨서 나온 것이라 스코프 목록을 넓히는 쪽이 옳다.
const spawnFinders = (units) => {
  countAgents('find', units.length)   // 재시도분도 누적된다 — 스폰한 만큼이 비용이다
  return parallel(units.map(u => () =>
    work(findPrompt(u), { label: `find:${unitKey(u)}`, phase: 'Find', schema: FINDINGS, effort: 'medium' })))
}

phase('Find')
if (SHARDED) log(`[${TIER}] 파인더 분할: 렌즈 ${LENSES.length} × 샤드 ${SHARDS.length} = ${UNITS.length} (샤드 크기 ${SHARDS.map(s => s.length).join('/')})${SHARD_NOTES.length ? ' — ' + SHARD_NOTES.join('; ') : ''}`)
else if (SHARD_NOTES.length) log(`[${TIER}] 파인더 분할 없음 — ${SHARD_NOTES.join('; ')}`)
const found = await spawnFinders(UNITS)

// 파인더 실패는 렌즈 커버리지 축소다 — 무음 강등 금지(REVIEW.md #4 "coverage caps 를
// 조용히 truncate 하지 않는다"). 2026-07-25 실측: 렌즈 2개가 ECONNRESET/ENOTFOUND 로
// 죽었는데 워크플로가 확정 0건으로 정상 종료해 "깨끗한 리뷰"와 구분되지 않았다.
// 1회 재시도(전송 전 canary 는 이미 통과했으므로 일시 단절 가정) → 그래도 죽으면 반환값에 노출.
const deadIdx = found.map((r, i) => (r ? -1 : i)).filter(i => i >= 0)
if (deadIdx.length) {
  log(`[경고] 파인더 ${deadIdx.length}/${UNITS.length} 실패(${deadIdx.map(i => unitKey(UNITS[i])).join(', ')}) — 1회 재시도`)
  const retry = await spawnFinders(deadIdx.map(i => UNITS[i]))
  deadIdx.forEach((i, k) => { if (retry[k]) found[i] = retry[k] })
}
// dead_finders = 죽은 파인더 단위(`lens#shard`) · dead_lenses = 모든 샤드가 죽어 그 렌즈의 시야가 통째로 빠진
// 렌즈(리뷰 2026-09-02, medium: 이름이 렌즈 의미를 약속하는 필드에 단위 키를 넣으면 소비자가 오독한다).
const deadFinders = UNITS.filter((_, i) => !found[i]).map(unitKey)
const deadLenses = LENSES.filter(l => UNITS.every((u, i) => u.lens !== l || !found[i])).map(l => l.key)
if (deadFinders.length === UNITS.length) {
  throw new Error(`모든 파인더 실패(${deadFinders.join(', ')}) — 리뷰 무효, 게이트 통과로 읽지 말 것`)
}
if (deadFinders.length) {
  log(`[경고] 재시도 후에도 파인더 실패: ${deadFinders.join(', ')} — 커버리지 축소 상태로 진행(stats.dead_finders / dead_lenses 로 반환)`)
}

// filter(Boolean) 후 인덱스로 렌즈를 붙이면 죽은 렌즈가 있을 때 라벨이 당겨져 오귀속된다
// (렌즈 0 사망 시 렌즈 1 의 지적이 렌즈 0 이름으로 기록) — 원본 배열 인덱스를 유지한다.
const all = found.flatMap((r, i) => (r ? r.findings.map(f => ({ ...f, lens: unitKey(UNITS[i]) })) : []))
lap('find')

// 1차 dedupe: file:line 키(라인 없으면 file+제목 앞 30자) — 심각도 최고 대표만 유지(ADR #50 §2).
const rank = { high: 3, medium: 2, low: 1, nit: 0 }
const byKey = new Map()
for (const f of all) {
  const k = f.line ? `${f.file}:${f.line}` : `${f.file}|${(f.title || '').slice(0, 30)}`
  const prev = byKey.get(k)
  if (!prev || rank[f.severity] > rank[prev.severity]) byKey.set(k, f)
}
let deduped = [...byKey.values()]

// 2차(선택): 12건 초과면 haiku 그룹핑 — 같은 근원의 다른 라인/제목 병합.
if (deduped.length > 12) {
  phase('Dedupe')
  const listing = deduped.map((f, i) => `${i}. [${f.severity}] ${f.file}:${f.line ?? '?'} ${f.title}`).join('\n')
  const groups = await agent(
    `아래 코드리뷰 지적 목록에서 **같은 근원 결함**을 가리키는 항목들을 그룹으로 묶어라(같은 함수의 동일 원인, 동일 패턴의 중복 보고). 서로 다른 결함은 절대 묶지 마라. 그룹은 인덱스 배열의 배열로.\n${listing}`,
    { label: 'dedupe:haiku', phase: 'Dedupe', model: 'haiku', effort: 'low', schema: {
      type: 'object',
      properties: { groups: { type: 'array', items: { type: 'array', items: { type: 'integer' } } } },
      required: ['groups'],
    } },
  )
  countAgents('dedupe', 1)
  if (groups && Array.isArray(groups.groups)) {
    const drop = new Set()
    for (const g of groups.groups) {
      const valid = g.filter(i => Number.isInteger(i) && i >= 0 && i < deduped.length)
      if (valid.length < 2) continue
      const rep = valid.reduce((a, b) => (rank[deduped[a].severity] >= rank[deduped[b].severity] ? a : b))
      for (const i of valid) if (i !== rep) drop.add(i)
    }
    deduped = deduped.filter((_, i) => !drop.has(i))
  }
}
lap('dedupe') // haiku 그룹핑 미실행이면 0
log(`[${TIER}] 파인더 ${found.filter(Boolean).length}/${UNITS.length} — 원지적 ${all.length} → 중복제거 후 ${deduped.length}`)

// 심각도 게이트(ADR #50 §3): high/medium=2 skeptic · low=1 · nit=0(오케스트레이터 판정).
phase('Verify')
const nits = deduped.filter(f => f.severity === 'nit')
const toVerify = deduped.filter(f => f.severity !== 'nit')
const verified = await parallel(toVerify.map(f => () => {
  const n = rank[f.severity] >= 2 ? 2 : 1
  countAgents('verify', n)
  return parallel(Array.from({ length: n }, (_, v) => () =>
    work(`너는 회의적 검증자 #${v + 1}이다. 아래 지적을 **반증**하라 — 실제 파일을 읽고 실패 시나리오가 재현 가능한지(코드 경로·가드·테스트) 추적. 확실히 틀렸거나 실제 위험이 없으면 refuted=true, 애매하면 refuted=false(보수적 유지).
${ROOT_LINE_PLAIN}지적: [${f.severity}] ${f.title}
파일: ${f.file}${f.line ? ':' + f.line : ''}
주장: ${f.claim}
근거: ${f.evidence}
${v === 1 ? '추가 관점: 이 지적이 맞다면 스코프에 명시된 기존 통과 게이트를 왜 통과했는지 설명 가능해야 한다 — 설명이 없으면 반증 근거다.' : ''}`,
      { label: `verify:${(f.title || '').slice(0, 24)}`, phase: 'Verify', schema: VERDICT, effort: 'low' })
  )).then(votes => ({ ...f, votes: votes.filter(Boolean) }))
}))

lap('verify')
const kept = verified.filter(Boolean).filter(f => f.votes.every(v => !v.refuted))
const rejected = verified.filter(Boolean).length - kept.length
outTokens.total = budget.spent() - _t0
// 카나리아는 한 단어를 답한다 — 그 랩의 초과분은 이 창에서 메인 루프가 낸 출력이다(하한 추정).
const bleed = Math.max(0, (outTokens.canary || 0) - CANARY_EXPECTED_OUT)
log(`출력 토큰(상한·메인 루프와 공유 풀): canary ${outTokens.canary} · find ${outTokens.find} · dedupe ${outTokens.dedupe} · verify ${outTokens.verify} · 합계 ${outTokens.total}`)
log(`에이전트(정확): ${Object.entries(agentsPerPhase).map(([k, v]) => `${k} ${v}`).join(' · ')}${bleed ? ` — 메인 루프 유입 ≥${bleed} 추정(카나리아 랩 초과분): 이 런의 토큰 값은 전부 의심할 것` : ' — 카나리아 창에서는 유입 미검출(이후 페이즈의 청결을 뜻하지는 않는다)'}`)

// 스코프 버킷 분리(2026-07-02 회고): 확정 지적 중 스코프 파일 밖은 out_of_scope_confirmed 로 —
// 슬라이스 게이트(h/m 수정 의무)는 confirmed 에만 적용, 밖은 후속 슬라이스 후보로 보고.
const isInScope = f => {
  if (!SCOPE_FILES) return true
  const p = String(f.file || '').replace(/\\/g, '/')
  return SCOPE_FILES.some(s => p === s || p.endsWith('/' + s) || s.endsWith('/' + p))
}
const confirmedAll = kept.map(({ votes, ...f }) => ({ ...f, verify_reasons: votes.map(v => v.reason.slice(0, 200)) }))

return {
  confirmed: confirmedAll.filter(isInScope),
  out_of_scope_confirmed: SCOPE_FILES ? confirmedAll.filter(f => !isInScope(f)) : [],
  nits_unverified: nits, // skeptic 생략 — 오케스트레이터가 직접 판정(ADR #50 §3)
  rejected_count: rejected,
  // lenses/dead_lenses 는 반환값 노출이 목적이다(ADR 0115): 오케스트레이터가 log 를 못 봐도
  // 커버리지 축소를 알 수 있어야 한다. dead_lenses 가 비어있지 않으면 게이트는 부분 커버리지다.
  // output_tokens 라는 이름이 exact 로 읽히던 것이 결함이었다(ADR 0129) — 이름과 basis 로
  // 상한임을 구조적으로 못 박고, 공유 풀이 아닌 유일한 정확값(에이전트 수)을 옆에 둔다.
  stats: {
    tier: TIER, lenses: LENSES.length, shards: SHARDED ? SHARDS.length : 1, finders: UNITS.length,
    dead_lenses: deadLenses, dead_finders: deadFinders, raw: all.length,
    deduped: deduped.length, verified: toVerify.length, nit_passthrough: nits.length,
    output_tokens_upper_bound: outTokens,
    agents_per_phase: agentsPerPhase,
    main_loop_bleed_estimate: bleed,
    telemetry_basis: 'budget.spent() is shared with the main loop, so every output_tokens_upper_bound figure is an UPPER BOUND, not this workflow\'s spend. SubagentStop cannot replace it — that event carries no token or duration fields (doc-verified). agents_per_phase is exact. main_loop_bleed_estimate is a FLOOR measured in the canary window ONLY (the canary answers with one word, so its lap\'s excess came from the main loop): a large value invalidates this run\'s token figures, but a zero does NOT prove the find/dedupe/verify laps are clean.',
  },
}
