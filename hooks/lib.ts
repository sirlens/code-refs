// Logica pura de code-refs: sin `$`, sin efectos. Se prueba directamente.

const EXTENSIONS = [
  'dart', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'yaml', 'yml', 'md', 'arb', 'py', 'kt', 'kts',
  'swift', 'gradle', 'java', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'ps1', 'sql',
  'xml', 'html', 'css', 'scss', 'toml', 'lock', 'plist', 'txt', 'cmake', 'properties',
]

const EXT_ALT = [...EXTENSIONS].sort((a, b) => b.length - a.length).join('|')
const NAME = String.raw`[\w@~+.-]+`
const PATH = String.raw`(?:${NAME}[\\/])*${NAME}\.(?:${EXT_ALT})`
// [HEAD:]ruta.ext:linea[-linea][:columna], sin letra/punto/barra delante ni letra detras.
const REF_BODY = String.raw`(?:(HEAD):)?(${PATH}):(\d+)(?:-(\d+))?(?::\d+)?(?![\w])`
const PLAIN_REF = new RegExp(String.raw`(?<![\w./\\@-])` + REF_BODY, 'g')
const WHOLE_REF = new RegExp('^' + REF_BODY + '$')

export type Ref = { path: string; start: number; end: number; head: boolean }

const HOST = 'https://code-refs.invalid/open'

function mkRef(head: string | undefined, path: string, a: string, b: string | undefined): Ref {
  const start = Number(a)
  const end = b ? Number(b) : start
  return { path, start: Math.min(start, end), end: Math.max(start, end), head: head === 'HEAD' }
}

export function toHref(r: Ref): string {
  const esc = (s: string) => encodeURIComponent(s).replace(/\(/g, '%28').replace(/\)/g, '%29')
  return `${HOST}?p=${esc(r.path)}&s=${r.start}&e=${r.end}&h=${r.head ? 1 : 0}`
}

export function fromHref(href: string): Ref | undefined {
  if (!href.startsWith(HOST + '?')) return undefined
  const q = new URLSearchParams(href.slice(HOST.length + 1))
  const path = q.get('p')
  const start = Number(q.get('s'))
  const end = Number(q.get('e'))
  if (!path || !Number.isFinite(start) || !Number.isFinite(end)) return undefined
  return { path, start, end, head: q.get('h') === '1' }
}

const SYM_SPAN = /^[A-Za-z_$][\w$]*(?:!?\??\.[A-Za-z_$][\w$]*|\(\)|!)*(?:\([^()`]*\))?;?$/
const NOT_SYMBOLS = new Set([
  'true', 'false', 'null', 'undefined', 'this', 'super', 'void', 'var', 'final', 'const', 'late', 'return',
  'async', 'await', 'new', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'int', 'double', 'num',
  'bool', 'string', 'String', 'dynamic', 'Object', 'List', 'Map', 'Set', 'Future', 'Stream', 'HEAD',
])

/** Nombre a buscar de un span de codigo: el ultimo identificador antes de los parentesis. */
export function symbolName(span: string): string | undefined {
  if (!SYM_SPAN.test(span)) return undefined
  const ids = span.replace(/\([^()]*\)/g, '').match(/[A-Za-z_$][\w$]*/g)
  const name = ids?.[ids.length - 1]
  if (!name || name.length < 3 || NOT_SYMBOLS.has(name)) return undefined
  return name
}

/** Link de un simbolo: su nombre y las referencias archivo:linea del mismo mensaje (contexto). */
export function toSymHref(name: string, ctx: readonly Ref[] = []): string {
  const c = ctx.map(r => `${r.path}:${r.start}-${r.end}`).join(';')
  return `${HOST}?y=${encodeURIComponent(name)}${c ? '&c=' + encodeURIComponent(c) : ''}`
}

export type SymLink = { name: string; ctx: Ref[] }

export function symFromHref(href: string): SymLink | undefined {
  if (!href.startsWith(HOST + '?')) return undefined
  const q = new URLSearchParams(href.slice(HOST.length + 1))
  const name = q.get('y')
  if (!name) return undefined
  const ctx: Ref[] = []
  for (const item of (q.get('c') ?? '').split(';')) {
    const m = /^(.+):(\d+)-(\d+)$/.exec(item)
    if (m) ctx.push({ path: m[1] ?? '', start: Number(m[2]), end: Number(m[3]), head: false })
  }
  return { name, ctx }
}

const sameFile = (hit: string, ref: string) => hit === ref || hit.endsWith('/' + ref)

const escRe = (s: string) => s.replace(/[$.*+?^()[\]{}|\\]/g, '\\$&')
const CALL_WORDS = new Set([
  'return', 'await', 'if', 'while', 'for', 'switch', 'throw', 'new', 'else', 'case', 'yield', 'assert',
  'print', 'debugPrint', 'expect', 'catch', 'when',
])

const FIELD_MODS = String.raw`(?:(?:final|late|static|const|var|external|abstract|covariant|readonly|private|public|protected)\s+)*`

/** Heuristica: la linea declara `name` (clase, getter, campo, metodo o funcion) y no solo lo usa. */
export function isDefinition(line: string, name: string): boolean {
  const n = escRe(name)
  const t = line.trim()
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
  if (new RegExp(String.raw`\b(?:class|enum|mixin|extension|typedef|interface|type|struct|trait|object)\s+${n}\b`).test(t)) return true
  if (new RegExp(String.raw`\b(?:get|set)\s+${n}\b`).test(t)) return true
  if (new RegExp(String.raw`\b(?:function|def|fun|func|fn)\s+${n}\b`).test(t)) return true
  // Campo: `double? lineTotal;`, `final x = ...` (no un parametro con nombre `double? x,`).
  const field = new RegExp(String.raw`^${FIELD_MODS}([\w$<>?,\[\] .]*[\w$>?\]])\s+${n}\s*(?:;|=(?!=))`).exec(t)
  const type = field?.[1] ?? ''
  if (field && !CALL_WORDS.has(type.split(/\s+/)[0] ?? '') && !type.includes('(')) return true
  const m = new RegExp(String.raw`^(.*?)(?<![\w$.])${n}\s*(?:<[^()]*>)?\s*\(`).exec(t)
  if (!m) return false
  const prefix = (m[1] ?? '').trim()
  if (/[=.(,:?!&|+\-*/]$/.test(prefix) || /[=(]/.test(prefix)) return false
  const first = prefix.split(/\s+/)[0] ?? ''
  if (CALL_WORDS.has(first)) return false
  // Una llamada suelta (`foo();`) no tiene tipo delante.
  if (prefix === '' && t.endsWith(';')) return false
  return true
}

export type Hit = { path: string; line: number }

/** Parsea `git grep -n` (ruta:linea:contenido) y deja solo las definiciones. */
export function definitionHits(out: string, name: string): Hit[] {
  const hits: Hit[] = []
  for (const raw of out.split('\n')) {
    const m = /^(.+?):(\d+):(.*)$/.exec(raw)
    if (!m || !isDefinition(m[3] ?? '', name)) continue
    hits.push({ path: normPath(m[1] ?? ''), line: Number(m[2]) })
  }
  const generated = (p: string) => /\.(g|freezed|gr|config|mocks)\.dart$|objectbox\.g\./.test(p) ? 1 : 0
  return hits.sort((a, b) => generated(a.path) - generated(b.path) || a.path.localeCompare(b.path))
}

const escLabel = (s: string) => s.replace(/([[\]\\])/g, '\\$1')

/** Parsea un texto que es exactamente una referencia (sin backticks). */
export function parseRef(text: string): Ref | undefined {
  const m = text.match(WHOLE_REF)
  return m ? mkRef(m[1], m[2] ?? '', m[3] ?? '0', m[4]) : undefined
}

/** Un simbolo que el agente dejo sin link `code:` y la linea (recortada) donde aparece. */
export type SymLine = { name: string; line: string }

/** Lo que se sabe de un simbolo sin link: su destino, o `none` si el repo no tiene definicion (se marca con `?`). */
export type SymStatus = { ref?: Ref; none?: boolean }
export type Resolver = (name: string, line: string) => SymStatus | undefined

export type Rewrite = {
  text: string
  refs: Ref[]
  syms: string[]
  hrefs: string[]
  /** Simbolos sin link `code:`, con su linea: lo que el agente no ubico. */
  symLines: SymLine[]
  /** Con resolucion: los que siguen sin destino y llevan la marca `?`. */
  unresolved: string[]
}

type Acc = { refs: Ref[]; syms: string[]; links: string[]; symLines: SymLine[]; unresolved: string[] }

// Los links de simbolos quedan como marcas hasta conocer todas las referencias del mensaje.
const SYM_MARK = (i: number) => `\u0000${i}\u0000`
// Los links explicitos del agente, ya resueltos, se apartan para que nada mas los toque.
const LINK_MARK = (i: number) => `\u0001${i}\u0001`

/** Link explicito del agente: [etiqueta](code:ruta[:linea[-linea]]). */
const CODE_LINK = /\[((?:[^\]\n\\]|\\.)+)\]\(code:([^)\s]+)\)/g

/** Destino de un link `code:`; sin linea apunta al inicio del archivo. */
export function parseCodeTarget(target: string): Ref | undefined {
  const m = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(target.trim())
  if (!m || !m[1]) return undefined
  return mkRef(undefined, normPath(m[1]), m[2] ?? '1', m[3])
}

/** Con el mod apagado: los links `code:` quedan como su etiqueta, sin la ruta. */
export function stripCodeLinks(text: string): string {
  return text.replace(CODE_LINK, (_: string, label: string) => label)
}

/**
 * Ordena candidatos sin descartar ninguno: primero los que caen en un rango citado, luego los
 * de un archivo citado, recorriendo los contextos en orden de confianza; el resto al final.
 */
export function orderByContext(hits: readonly Hit[], contexts: readonly (readonly Ref[])[]): Hit[] {
  const tier = (h: Hit): number => {
    for (let i = 0; i < contexts.length; i++) {
      const ctx = contexts[i] ?? []
      if (ctx.some(r => sameFile(h.path, r.path) && h.line >= r.start - 2 && h.line <= r.end)) return i * 2
      if (ctx.some(r => sameFile(h.path, r.path))) return i * 2 + 1
    }
    return contexts.length * 2
  }
  return hits
    .map((h, i) => ({ h, i, t: tier(h) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(x => x.h)
}

export function hasCodeLinks(text: string): boolean {
  CODE_LINK.lastIndex = 0
  const found = CODE_LINK.test(text)
  CODE_LINK.lastIndex = 0
  return found
}

function rewriteProse(prose: string, acc: Acc, resolve?: Resolver): string {
  return prose
    .split('\n')
    .map(line => rewriteLine(line, acc, resolve))
    .join('\n')
}

function rewriteLine(line: string, acc: Acc, resolve?: Resolver): string {
  const { refs, syms, links } = acc
  const key = line.trim()
  const withMarks = line.replace(CODE_LINK, (whole: string, label: string, target: string) => {
    const ref = parseCodeTarget(target)
    if (!ref) return label
    refs.push(ref)
    links.push(`[${label}](${toHref(ref)})`)
    return LINK_MARK(links.length - 1)
  })
  return withMarks
    .split(/(`[^`\n]*`)/)
    .map(part => {
      if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
        const inner = part.slice(1, -1)
        const ref = parseRef(inner)
        if (ref) {
          refs.push(ref)
          return `[\`${escLabel(inner)}\`](${toHref(ref)})`
        }
        const sym = symbolName(inner)
        if (!sym) return part
        acc.symLines.push({ name: sym, line: key })
        const st = resolve?.(sym, key)
        if (st?.ref) {
          refs.push(st.ref)
          return `[\`${escLabel(inner)}\`](${toHref(st.ref)})`
        }
        syms.push(sym)
        // La marca solo existe con resolucion: el agente no lo ubico y nadie lo resolvio aun.
        if (resolve) acc.unresolved.push(sym)
        return `[\`${escLabel(inner)}\`${resolve ? '?' : ''}](${SYM_MARK(syms.length - 1)})`
      }
      return part.replace(PLAIN_REF, (whole: string, head: string | undefined, path: string, a: string, b: string | undefined) => {
        const ref = mkRef(head, path, a, b)
        refs.push(ref)
        return `[${escLabel(whole)}](${toHref(ref)})`
      })
    })
    .join('')
}

/** Reescribe las referencias en links; deja intacto todo lo demas y los bloques cercados. */
export function rewriteRefs(text: string, resolve?: Resolver): Rewrite {
  const acc: Acc = { refs: [], syms: [], links: [], symLines: [], unresolved: [] }
  const { refs, syms, links } = acc
  const out: string[] = []
  let fence: string | null = null
  let buf: string[] = []
  const flush = () => {
    if (buf.length) out.push(rewriteProse(buf.join('\n'), acc, resolve))
    buf = []
  }
  for (const line of text.split('\n')) {
    const f = line.match(/^\s*(```+|~~~+)/)
    if (fence === null && f) {
      flush()
      fence = f[1]?.[0] ?? null
      out.push(line)
    } else if (fence !== null) {
      out.push(line)
      if (f && f[1]?.[0] === fence) fence = null
    } else {
      buf.push(line)
    }
  }
  flush()
  const ctx = refs.filter(r => !r.head).slice(0, 20)
  const symHrefs = syms.map(name => toSymHref(name, ctx))
  const joined = out
    .join('\n')
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => symHrefs[Number(i)] ?? '')
    .replace(/\u0001(\d+)\u0001/g, (_, i: string) => links[Number(i)] ?? '')
  const hrefs = [...new Set([...refs.map(toHref), ...symHrefs])].slice(0, 256)
  return { text: joined, refs, syms, hrefs, symLines: acc.symLines, unresolved: acc.unresolved }
}

export type Ask = { name: string; cands: readonly Hit[] }

/**
 * Pregunta al modelo, que conoce la conversacion, cual de las definiciones reales quiso decir
 * en su respuesta. Solo puede elegir un numero de la lista, asi nunca inventa una ruta.
 */
export function forkPrompt(asks: readonly Ask[]): string {
  const blocks = asks.map(a => [`${a.name}:`, ...a.cands.map((c, i) => `  ${i + 1}. ${c.path}:${c.line}`)].join('\n'))
  return [
    '[code-refs] Your last reply mentioned these code symbols without a code: link. For each one, pick the',
    'candidate that is the definition you meant, by its number, or 0 if none of them is it or you are not sure.',
    'You have no tools here: answer straight away, one line per symbol, exactly `name: number`, nothing else.',
    '',
    ...blocks,
  ].join('\n')
}

/** Lee `nombre: numero`; ignora nombres que no se preguntaron y numeros fuera de la lista. */
export function parseForkAnswer(text: string, asks: readonly Ask[]): Map<string, Hit | null> {
  const out = new Map<string, Hit | null>()
  for (const raw of text.split('\n')) {
    const m = /^\s*`?([A-Za-z_$][\w$]*)`?\s*[:=]\s*(\d+)\s*$/.exec(raw)
    const ask = m ? asks.find(a => a.name === m[1]) : undefined
    if (!m || !ask) continue
    const n = Number(m[2])
    out.set(ask.name, n >= 1 && n <= ask.cands.length ? (ask.cands[n - 1] ?? null) : null)
  }
  return out
}

export function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Ruta relativa a la raiz si `p` es absoluta y cae dentro; si no, la misma normalizada. */
export function toRelative(p: string, root: string): string {
  const n = normPath(p)
  const r = normPath(root).replace(/\/+$/, '')
  if (n.toLowerCase().startsWith(r.toLowerCase() + '/')) return n.slice(r.length + 1)
  return n
}

export function isSafeRelative(p: string): boolean {
  return !!p && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split('/').includes('..')
}

/** Candidatos entre `files` (rutas del repo) para una referencia (ruta o nombre suelto). */
export function resolveCandidates(files: readonly string[], name: string): string[] {
  const n = normPath(name)
  if (files.includes(n)) return [n]
  return files.filter(f => f === n || f.endsWith('/' + n))
}

export type Window = { first: number; before: string[]; cited: string[]; after: string[]; total: number }

/**
 * Lineas citadas con `context` lineas de contexto a cada lado. `maxCited` corta un rango
 * largo; `shift` desplaza la ventana completa (paginacion), sin salirse del archivo.
 */
export function sliceWindow(
  content: string,
  start: number,
  end: number,
  context = 15,
  maxCited = Infinity,
  shift = 0,
): Window {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const total = lines.length
  const s = Math.min(Math.max(1, start), Math.max(1, total))
  const e = Math.min(Math.max(s, end), total, s + Math.max(1, maxCited) - 1)
  let first = Math.max(1, s - context)
  let last = Math.min(total, e + context)
  if (shift !== 0) {
    const size = last - first + 1
    first = Math.min(Math.max(1, first + shift), Math.max(1, total - size + 1))
    last = Math.min(total, first + size - 1)
    return {
      first,
      before: lines.slice(first - 1, Math.min(Math.max(first - 1, s - 1), last)),
      cited: lines.slice(Math.max(first - 1, s - 1), Math.min(e, last)),
      after: lines.slice(Math.max(first - 1, e), last),
      total,
    }
  }
  return {
    first,
    before: lines.slice(first - 1, s - 1),
    cited: lines.slice(s - 1, e),
    after: lines.slice(e, last),
    total,
  }
}

export type Change = { path: string; status: string }

/** Parsea `git status --porcelain -z`. */
export function parsePorcelain(out: string): Change[] {
  const parts = out.split('\0')
  const res: Change[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? ''
    if (p.length < 4) continue
    const status = p.slice(0, 2)
    res.push({ path: p.slice(3), status })
    if (status.startsWith('R') || status.startsWith('C')) i++ // la entrada siguiente es el origen
  }
  return res
}

/** Del diff completo, solo los hunks (desde el primer @@). Vacio si no hay. */
export function diffHunks(diff: string): string {
  const i = diff.search(/^@@ /m)
  return i < 0 ? '' : diff.slice(i)
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/**
 * Una pagina de `size` lineas del cuerpo de los hunks a partir de `offset` (sin contar las
 * cabeceras @@). Cada trozo lleva su cabecera reescrita con los conteos reales de la pagina,
 * asi el diff sigue siendo valido aunque corte un hunk por la mitad.
 */
export function diffPage(hunks: string, offset: number, size: number): { text: string; total: number } {
  type Row = { o: number; n: number; text: string; tail: string }
  const rows: Row[] = []
  let o = 0
  let n = 0
  let tail = ''
  for (const line of hunks.replace(/\r\n/g, '\n').split('\n')) {
    const h = HUNK.exec(line)
    if (h) {
      o = Number(h[1])
      n = Number(h[2])
      tail = h[3] ?? ''
      // Marca de inicio de hunk: fuerza una cabecera nueva aunque sea contiguo.
      rows.push({ o: -1, n: -1, text: '', tail })
      continue
    }
    if (line === '' || line.startsWith('\\')) continue
    rows.push({ o, n, text: line, tail })
    if (line[0] !== '+') o++
    if (line[0] !== '-') n++
  }
  const body = rows.filter(r => r.o >= 0)
  const total = body.length
  const from = Math.min(Math.max(0, offset), Math.max(0, total - 1))
  const page = body.slice(from, from + Math.max(1, size))
  const out: string[] = []
  let i = 0
  while (i < page.length) {
    const start = page[i] as Row
    let j = i
    let co = 0
    let cn = 0
    while (j < page.length) {
      const r = page[j] as Row
      if (j > i) {
        const prev = page[j - 1] as Row
        const nextO = prev.o + (prev.text[0] !== '+' ? 1 : 0)
        const nextN = prev.n + (prev.text[0] !== '-' ? 1 : 0)
        if (r.o !== nextO || r.n !== nextN) break
      }
      if (r.text[0] !== '+') co++
      if (r.text[0] !== '-') cn++
      j++
    }
    out.push(`@@ -${start.o},${co} +${start.n},${cn} @@${start.tail}`)
    for (let k = i; k < j; k++) out.push((page[k] as Row).text)
    i = j
  }
  return { text: out.join('\n'), total }
}

/** Archivos que cambiaron entre dos fotos de git (ruta -> hash): nuevos, editados o revertidos. */
export function changedBetween(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const out = new Set<string>()
  for (const [p, h] of after) if (before.get(p) !== h) out.add(p)
  for (const p of before.keys()) if (!after.has(p)) out.add(p)
  return [...out]
}

/**
 * Archivos del repo nombrados en un comando de shell (`grep -n x lib/a.dart`, `cat "b.ts"`):
 * solo los que resuelven a un unico archivo de `files`. Asi se cuenta lo leido por Bash.
 */
export function pathsInCommand(command: string, files: readonly string[], root: string): string[] {
  const out = new Set<string>()
  for (const raw of command.match(/[\w@~+.\/\:-]+\.[A-Za-z0-9]{1,10}\b/g) ?? []) {
    if (/^[a-z]+:\/\//i.test(raw)) continue
    const rel = toRelative(raw.replace(/^\.\//, ''), root)
    const cands = resolveCandidates(files, rel)
    if (cands.length === 1 && cands[0]) out.add(cands[0])
    if (out.size >= 30) break
  }
  return [...out]
}
