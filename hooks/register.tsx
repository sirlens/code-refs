import { atom, read, update } from 'claude-code'
import type { Register, RenderChildren } from 'claude-code'

import type { Recent, RefSel, Resolution, Tab, Touch, View } from '../types'
import {
  definitionHits,
  forkPrompt,
  parseForkAnswer,
  orderByContext,
  diffHunks,
  diffPage,
  fromHref,
  hasCodeLinks,
  stripCodeLinks,
  isSafeRelative,
  normPath,
  parsePorcelain,
  pathsInCommand,
  changedBetween,
  resolveCandidates,
  rewriteRefs,
  sliceWindow,
  symFromHref,
  toRelative,
} from './lib'
import type { Ask, Hit, Ref, Resolver } from './lib'

const PANE = 'code-refs'
const ENABLED_KEY = 'enabled'
const MAX_CANDIDATES = 50

const EMPTY_VIEW: View = { tab: 'code', ref: null, pending: null, missing: null, selected: null, offset: 0, symbol: null }

// Si cambian los campos de View, subir la etiqueta: rechaza lo que guardo una version anterior.
const view = atom({ plugin: 'code-refs', key: 'view' } as const, EMPTY_VIEW, { shape: 'view-3' })
const resolved = atom({ plugin: 'code-refs', key: 'resolved' } as const, [] as Resolution[], { shape: 'resolved-1' })
const edited = atom({ plugin: 'code-refs', key: 'edited' } as const, [] as string[], {
  shape: 'edited-1',
})
const last = atom({ plugin: 'code-refs', key: 'last' } as const, [] as Touch[], { shape: 'last-1' })
// Numero de mensaje del usuario y los archivos modificados en el mas reciente que modifico algo.
const turnNo = atom({ plugin: 'code-refs', key: 'turnNo' } as const, 0, { shape: 'turn-1' })
const recent = atom({ plugin: 'code-refs', key: 'recent' } as const, { turn: 0, files: [] } as Recent, {
  shape: 'recent-1',
})
const recentReads = atom({ plugin: 'code-refs', key: 'recentReads' } as const, { turn: 0, files: [] } as Recent, {
  shape: 'recent-1',
})
// Si la regla ya viaja en la conversacion: se vuelve a mandar tras compactar, /clear o activar.
const ruleSent = atom({ plugin: 'code-refs', key: 'ruleSent' } as const, false, { shape: 'rule-1' })

// Regla para el agente; viaja como contexto oculto del mensaje, solo con el mod encendido.
const AGENT_RULE = [
  'code-refs is on. Every code symbol you write in backticks in prose (class, method, field, function,',
  'variable) must be a markdown link to its definition: label = the symbol in backticks, target =',
  '`code:<repo-relative path>:<line>` (a range `<start>-<end>` is allowed). Example:',
  '[`line.calculate()`](code:lib/a/document_expense_line.dart:460). The target is hidden from the reader, so',
  'do not repeat the path. Before you answer, look up the definition of every symbol you mention whose',
  'location you have not verified in this conversation (CodeGraph or grep); never leave a symbol in backticks',
  'without its link. If after looking you still cannot locate it, write it without backticks. Point at the',
  'definition unless you mean a call site. Link every mention, repeated ones included. Never inside fenced code',
  'blocks. Symbols you leave unlinked are flagged to the user as not looked up.',
].join(' ')

type Sh = {
  session: { cwd: () => Promise<string> }
  process: { run: (argv: string[], init?: { cwd?: string }) => Promise<{ exitCode: number; stdout: string }> }
}

// ---- git (solo lectura) --------------------------------------------------

async function git($: Sh, root: string, argv: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await $.process.run(['git', ...argv], { cwd: root })
    return { ok: r.exitCode === 0, out: r.stdout }
  } catch {
    return { ok: false, out: '' }
  }
}

// Raiz del repo: la del cwd de la sesion; si no es repo, el propio cwd.
let rootCache: { cwd: string; root: string } | null = null
async function getRoot($: Sh): Promise<string> {
  const cwd = await $.session.cwd()
  if (rootCache && rootCache.cwd === cwd) return rootCache.root
  const r = await git($, cwd, ['rev-parse', '--show-toplevel'])
  const root = r.ok && r.out.trim() ? normPath(r.out.trim()) : normPath(cwd)
  rootCache = { cwd, root }
  return root
}

// Lista de archivos cacheada; se refresca cuando una busqueda no encuentra nada.
let filesCache: { root: string; files: string[] } | null = null
async function listFiles($: Sh, root: string, refresh: boolean): Promise<string[]> {
  if (!refresh && filesCache && filesCache.root === root) return filesCache.files
  const r = await git($, root, ['ls-files', '--cached', '--others', '--exclude-standard'])
  const files = r.out.split('\n').map(s => s.trim()).filter(Boolean)
  filesCache = { root, files }
  return files
}

// ---- navegacion -------------------------------------------------------------

// `update` lleva el `$` completo; aqui basta con tiparlo suelto.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function setView($: any, next: Partial<View>) {
  // Una referencia nueva se abre centrada en su rango (offset -1 = centrar al dibujar);
  // cualquier otra navegacion empieza arriba.
  await update($, view, (v: View) => ({ ...v, offset: next.ref ? -1 : 0, ...next }))
  void pinWindow($)
}

// Deja la ventana del motor sobre la cabecera (salta la fila de relleno de arriba); a partir
// de ahi el scroll de la persona solo mueve el contenido.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pinWindow($: any) {
  try {
    await $.clock.sleep(80)
    await $.ui.scroll({ to: { key: 'hdr' }, in: PANE, block: 'start' })
  } catch {
    // Panel cerrado o aun sin dibujar: no hay nada que colocar.
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function showResult($: any, name: string, items: RefSel[], symbol: string | null = null) {
  const base = { tab: 'code' as const, selected: null, symbol }
  if (items.length === 0) {
    await setView($, { ...base, ref: null, pending: null, missing: name })
  } else if (items.length === 1) {
    await setView($, { ...base, ref: items[0] ?? null, pending: null, missing: null })
  } else {
    await setView($, { ...base, ref: null, missing: null, pending: { name, items: items.slice(0, MAX_CANDIDATES) } })
  }
  await bringToFront($)
}

// Con varios paneles el motor muestra uno y deja el resto como pestanas; solo `focus` trae
// este al frente, y lo rechaza si otro panel tiene el teclado. Ahi se avisa con un toast
// para que el clic nunca parezca no haber hecho nada.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bringToFront($: any) {
  await $.ui.open({ id: PANE, title: 'Code refs', focus: true })
  try {
    const panes: Array<{ id: string; isShown: boolean }> = await $.ui.panes()
    if (panes.some(p => p.id === PANE && !p.isShown)) {
      $.ui.toast('Code refs actualizado: cambia a su pestana para verlo')
    }
  } catch {
    // Sin lista de paneles no hay a quien avisar; el panel ya quedo actualizado.
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openRef($: any, ref: Ref) {
  const root = await getRoot($)
  const name = toRelative(ref.path, root)
  let cands = resolveCandidates(await listFiles($, root, false), name)
  if (cands.length === 0) cands = resolveCandidates(await listFiles($, root, true), name)
  await showResult($, name, cands.map(path => ({ path, start: ref.start, end: ref.end, head: ref.head })))
}

// Fuera de la busqueda de simbolos: documentacion, specs y traducciones.
const NOT_CODE = [
  ':(exclude)*.md', ':(exclude)*.arb', ':(exclude)*.json', ':(exclude)*.txt',
  ':(exclude).specify/**', ':(exclude)openspec/**', ':(exclude)specs/**', ':(exclude)docs/**',
]

// Referencias archivo:linea vistas en las respuestas de la sesion; solo ordenan candidatos.
// Se repuebla sola al redibujar los mensajes tras una recarga.
const seenRefs: Ref[] = []

function remember(refs: readonly Ref[]) {
  for (const r of refs) {
    if (r.head || seenRefs.some(s => s.path === r.path && s.start === r.start && s.end === r.end)) continue
    seenRefs.push(r)
    if (seenRefs.length > 300) seenRefs.shift()
  }
}

// Un simbolo sin link exacto nunca se resuelve adivinando: con una sola definicion en el repo
// se abre; con varias se listan todas, primero las que el contexto senala (rango citado en el
// mismo bloque, archivo citado, referencias de la sesion, archivos leidos en el turno).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openSymbol($: any, name: string, ctx: Ref[]) {
  const found = await findDefs($, name, ctx)
  const hits = found.defs.length ? found.defs : found.uses
  await showResult($, `${name}()`, hits.map(toSel), name)
}

const toSel = (h: Hit): RefSel => ({ path: h.path, start: h.line, end: h.line, head: false })

// Definiciones de un simbolo ordenadas por contexto, y sus apariciones por si no hay ninguna.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findDefs($: any, name: string, ctx: readonly Ref[]): Promise<{ defs: Hit[]; uses: Hit[] }> {
  const root = await getRoot($)
  const r = await git($, root, ['grep', '-n', '-I', '-w', '--untracked', '--no-color', '-e', name, '--', '.', ...NOT_CODE])
  const turnFiles = (await read($, last)).map(t => ({ path: toRelative(t.path, root), start: 0, end: -1, head: false }))
  const defs = orderByContext(definitionHits(r.out, name), [ctx, seenRefs, turnFiles])
  const uses = r.out
    .split('\n')
    .map(l => /^(.+?):(\d+):/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => ({ path: normPath(m[1] ?? ''), line: Number(m[2]) }))
  return { defs, uses }
}

// ---- simbolos que el agente dejo sin link ---------------------------------------

const MAX_ASKS = 15
const MAX_ASK_CANDIDATES = 40

// Al terminar una respuesta: cada simbolo sin link se busca en git; con una sola definicion
// queda resuelto, sin ninguna se marca como no-codigo, y los ambiguos se le preguntan juntos al
// modelo, que solo elige de la lista real. Lo que nadie elige queda marcado con `?`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveReply($: any, answer: string) {
  const rw = rewriteRefs(answer)
  const known = await read($, resolved)
  const pending = new Map<string, string[]>()
  for (const { name, line } of rw.symLines) {
    if (known.some(k => k.name === name && k.lines.includes(line))) continue
    pending.set(name, [...(pending.get(name) ?? []), line])
  }
  if (pending.size === 0) return
  const ctx = rw.refs.filter(r => !r.head).slice(0, 20)
  const found: Resolution[] = []
  const asks: Ask[] = []
  for (const [name, lines] of [...pending].slice(0, MAX_ASKS)) {
    const { defs } = await findDefs($, name, ctx)
    if (defs.length === 0) found.push({ name, lines, ref: null, none: true })
    else if (defs.length === 1) found.push({ name, lines, ref: toSel(defs[0] as Hit) })
    else asks.push({ name, cands: defs.slice(0, MAX_ASK_CANDIDATES) })
  }
  if (asks.length) {
    const reply = await $.model.fork({ prompt: forkPrompt(asks) }).catch(() => ({ isAnswered: false }))
    const picks = reply.isAnswered ? parseForkAnswer(String(reply.text), asks) : new Map<string, Hit | null>()
    for (const a of asks) {
      const hit = picks.get(a.name)
      found.push({ name: a.name, lines: pending.get(a.name) ?? [], ref: hit ? toSel(hit) : null })
    }
  }
  await update($, resolved, (list: Resolution[]) => [...list, ...found].slice(-500))
}

// Busca un simbolo en lo ya resuelto por el nombre y la linea donde aparece en el mensaje.
function resolverFrom(list: readonly Resolution[]): Resolver {
  return (name, line) => {
    const hit = [...list].reverse().find(r => r.name === name && r.lines.includes(line))
    if (!hit) return undefined
    if (hit.none) return { none: true }
    return hit.ref ? { ref: hit.ref } : undefined
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function askAgent($: any, name: string) {
  await $.prompt.submit({
    text: `Ubica la definicion de \`${name}\` que mencionaste en tu respuesta anterior y respondeme con su link code: exacto.`,
  })
}

async function isOn($: { store: { get: (k: string) => Promise<unknown> } }): Promise<boolean> {
  try {
    return (await $.store.get(ENABLED_KEY)) === true
  } catch {
    return false
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function record($: any, p: string | undefined, kind: 'E' | 'R') {
  if (!p) return
  const n = normPath(p)
  // El primer archivo de un mensaje nuevo reemplaza la lista; los siguientes se suman. Un
  // mensaje que no toca nada no la cambia, asi Last sigue mostrando el anterior que si lo hizo.
  const turn = await read($, turnNo)
  const add = (r: Recent): Recent =>
    r.turn === turn ? { turn, files: r.files.includes(n) ? r.files : [...r.files, n].slice(-300) } : { turn, files: [n] }
  if (kind === 'R') await update($, recentReads, add)
  if (kind === 'E') {
    await update($, edited, (list: string[]) => (list.includes(n) ? list : [...list, n].slice(-500)))
    await update($, recent, add)
  }
  await update($, last, (list: Touch[]) => {
    const prev = list.find(t => t.path === n)
    if (prev && (prev.kind === 'E' || kind === 'R')) return list
    return [...list.filter(t => t.path !== n), { path: n, kind }].slice(-300)
  })
}

// Foto de git al enviar un mensaje: archivos con cambios y su hash. Al terminar el turno se
// compara con otra foto, asi cuenta todo lo modificado (Edit, sed, scripts, subagentes).
let snapshot: { turn: number; hashes: Map<string, string> } | null = null

async function dirtyHashes($: Sh, root: string): Promise<Map<string, string>> {
  const st = await git($, root, ['status', '--porcelain', '-z', '-uall'])
  const changes = parsePorcelain(st.out)
  const hashes = new Map<string, string>()
  for (const c of changes) if (c.status.includes('D')) hashes.set(c.path, 'deleted')
  const present = changes.filter(c => !c.status.includes('D')).map(c => c.path)
  // Por tandas, para no pasar listas enormes en un solo comando.
  for (let i = 0; i < present.length; i += 200) {
    const chunk = present.slice(i, i + 200)
    const r = await git($, root, ['hash-object', '--', ...chunk])
    const lines = r.ok ? r.out.split('\n') : []
    chunk.forEach((p, k) => hashes.set(p, lines[k]?.trim() || 'unknown'))
  }
  return hashes
}

// ---- modulo -------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'code-refs',
      description: 'Activa/desactiva links de codigo en las respuestas (sin argumento alterna; on, off, open)',
    })
    // Tras /clear, compactar o reanudar, la regla anterior puede ya no estar en la conversacion.
    await update($, ruleSent, () => false)

    return next(e)
  })

  on('command.run', { command: 'code-refs' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const was = await isOn($)
    const want = arg === 'on' ? true : arg === 'off' ? false : arg === 'open' ? true : !was

    await $.store.set(ENABLED_KEY, want)
    await update($, ruleSent, () => false)
    if (!want) {
      await $.ui.close({ id: PANE })

      return { text: 'desactivado. Las respuestas se muestran sin tocar.' }
    }
    await $.ui.open({ id: PANE, title: 'Code refs' })
    void pinWindow($)

    return {
      text: 'activado. Pulsa un archivo:linea o un `simbolo()` de una respuesta; ✕ cierra el panel, /code-refs off desactiva.',
    }
  })

  // Un mensaje nuevo del usuario abre un "ultimo turno" vacio y, con el mod encendido, lleva
  // la regla de links una sola vez (no gasta contexto en cada mensaje).
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    await update($, last, () => [] as Touch[])
    await update($, turnNo, (n: number) => n + 1)
    try {
      snapshot = { turn: await read($, turnNo), hashes: await dirtyHashes($, await getRoot($)) }
    } catch {
      snapshot = null
    }
    if (!(await isOn($)) || (await read($, ruleSent))) return next(e)

    const done = await next({ ...e, context: [...(e.context ?? []), AGENT_RULE] })
    if (done.drop === undefined && done.context?.includes(AGENT_RULE)) await update($, ruleSent, () => true)

    return done
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    await update($, ruleSent, () => false)

    return done
  })

  // Registro de lo que toca el asistente (tras la ejecucion).
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await record($, e.file_path, 'E')

    return ran
  })
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await record($, e.file_path, 'E')

    return ran
  })
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await record($, e.notebook_path, 'E')

    return ran
  })
  // Lo leido por shell: archivos del repo nombrados en el comando.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    try {
      const root = await getRoot($)
      for (const p of pathsInCommand(e.command, await listFiles($, root, false), root)) await record($, `${root}/${p}`, 'R')
    } catch {
      // Sin repo o sin git: no hay nada que registrar.
    }

    return ran
  })

  // Fin del turno principal: lo que cambio en git desde la foto del mensaje es lo modificado.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // En segundo plano: el turno termina ya y los links se completan al resolverse.
    if (e.agentId === undefined && e.reason === 'answer' && (await isOn($))) {
      void resolveReply($, e.answer).catch(() => undefined)
    }
    const start = snapshot
    if (e.agentId !== undefined || !start || start.turn !== (await read($, turnNo))) return done
    try {
      const root = await getRoot($)
      for (const p of changedBetween(start.hashes, await dirtyHashes($, root))) await record($, `${root}/${p}`, 'E')
    } catch {
      // Sin repo o sin git: quedan solo los cambios hechos con las herramientas de archivos.
    }

    return done
  })

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await record($, e.file_path, 'R')

    return ran
  })

  // Mensajes del asistente: referencias y simbolos pasan a ser links. Apagado => intacto,
  // salvo los links `code:` ya escritos, que quedan como su etiqueta.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.text
    if (typeof text !== 'string') return next(e)
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const frame = (md: RenderChildren) => (
      <Box flexDirection="row">
        <Text>{e.props.isFirstOfReply ? '● ' : '  '}</Text>
        <Box flexGrow={1} flexShrink={1}>
          {md}
        </Box>
      </Box>
    )

    if (!(await isOn($))) {
      return hasCodeLinks(text) ? frame(<Markdown key="msg" text={stripCodeLinks(text)} />) : next(e)
    }
    const rewritten = rewriteRefs(text, resolverFrom(await read($, resolved)))
    remember(rewritten.refs)
    if (rewritten.hrefs.length === 0) return next(e)

    const onLinkPress = (link: { href: string }) => {
      const ref = fromHref(link.href)
      if (ref) return void openRef($, ref)
      const sym = symFromHref(link.href)
      if (sym) void openSymbol($, sym.name, sym.ctx)
    }

    return frame(
      <Markdown key="msg" text={rewritten.text} pressableLinks={rewritten.hrefs} onLinkPress={onLinkPress} />,
    )
  })

  // El panel: cabecera fija (pestanas y, si hay, la linea de contexto) y debajo una ventana
  // de contenido del alto justo. El motor no tiene contenedores con scroll propio, asi que
  // el mod recorta las filas visibles y redirige a esa ventana el scroll del motor.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const v = await read($, view)
    const root = await getRoot($)
    const fit = budget(e)

    const tab = (id: Tab, label: string) => (
      <Button
        key={`tab-${id}`}
        variant={v.tab === id ? 'primary' : 'secondary'}
        onPress={() => setView($, { tab: id, selected: null })}
      >
        {label}
      </Button>
    )
    const header = (
      <Box key="hdr" flexDirection="row" flexShrink={0} height={1}>
        {tab('code', 'Code')}
        <Text> </Text>
        {tab('changes', 'Changes')}
        <Text> </Text>
        {tab('last', 'Last')}
        <Text> </Text>
        <Button key="close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })}>
          ✕
        </Button>
      </Box>
    )

    const el = { Box, Text, Button, Code }
    let body: Body
    if (v.tab === 'code') {
      body = await codeBody($, el, v, root, fit.cols)
    } else if (v.selected) {
      body = await fileDiffBody($, el, v, root, fit.cols)
    } else if (v.tab === 'changes') {
      const sessionFiles = (await read($, edited)).map(p => toRelative(p, root))
      body = await changesBody($, el, sessionFiles, root, fit.cols)
    } else {
      const now = await read($, turnNo)
      const rel = (r: Recent) => ({ files: r.files.map(p => toRelative(p, root)), ago: now - r.turn })
      body = lastBody($, el, rel(await read($, recent)), rel(await read($, recentReads)), fit.cols)
    }

    // Filas de la ventana: las del panel menos la cabecera y la linea de contexto.
    const H = Math.max(1, fit.rows - 1 - (body.top ? 1 : 0))
    const maxOff = Math.max(0, body.total - H)
    const auto = body.center === undefined ? 0 : body.center - Math.floor(H / 2)
    const off = Math.min(maxOff, Math.max(0, v.offset < 0 ? auto : v.offset))
    geom = { H, maxOff, off }
    const drawn = body.draw(off, off + H)

    // Una fila vacia arriba y otra abajo dan al motor filas que desplazar: asi entrega las
    // teclas de scroll, que el hook de `ui.scroll` aplica a la ventana sin mover la cabecera.
    return (
      <Box flexDirection="column">
        <Box key="pad-top" height={1} />
        {header}
        {body.top}
        <Box key="window" flexDirection="column" height={H} overflow="hidden">
          {drawn}
        </Box>
        <Box key="pad-bottom" height={1} />
      </Box>
    )
  })

  // Scroll de la persona sobre el panel (rueda, flechas, AvPag/RePag, Inicio/Fin): mueve solo
  // la ventana de contenido. El del propio mod (colocar la ventana del motor) pasa tal cual.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person' || !geom) return next(e)
    const g = geom
    const isPage = Math.abs(e.by) >= e.bodyRows && Math.abs(e.by) < e.contentRows
    const isEdge = Math.abs(e.by) >= e.contentRows
    const step = isEdge ? Math.sign(e.by) * (g.maxOff + 1) : isPage ? Math.sign(e.by) * g.H : e.pointer ? e.by * 3 : e.by
    await update($, view, (x: View) => {
      const from = x.offset < 0 ? g.off : x.offset
      return { ...x, offset: Math.min(g.maxOff, Math.max(0, from + step)) }
    })

    return { deny: 'code-refs desplaza solo el contenido del panel' }
  })
}

// ---- medidas ---------------------------------------------------------------------

// Lo que el ultimo dibujo del panel midio; el hook de scroll lo lee para acotar el paso.
let geom: { H: number; maxOff: number; off: number } | null = null

// Filas y columnas del panel. Inline (pantalla principal) el marco crece con el arbol: si
// supera la terminal, lo que sube al scroll ya no se puede borrar y queda una cabecera
// duplicada sin vida. Por eso inline se acota a la pantalla.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function budget(e: any): { rows: number; cols: number } {
  const p = e.props ?? {}
  const bodyRows = Number(p.scroll?.bodyRows) || 30
  const cols = Number(p.bodyColumns) || 80
  if (p.placement !== 'inline') return { rows: Math.max(4, bodyRows), cols }
  const screen = Number(e.viewport?.rows) || 40
  return { rows: Math.max(8, Math.min(bodyRows, screen - 16)), cols }
}

// Corta cada linea al ancho: una linea que se parte suma filas y rompe la ventana.
function clip(lines: readonly string[], width: number): string {
  const w = Math.max(10, width)
  return lines.map(l => (l.length > w ? l.slice(0, w - 1) + '…' : l)).join('\n')
}

/**
 * Un contenido del panel: `top` es una linea fija bajo las pestanas; `total` las filas del
 * contenido; `draw(from, to)` dibuja exactamente esas filas; `center` la fila a centrar al abrir.
 */
type Body = {
  top?: RenderChildren
  total: number
  center?: number
  draw: (from: number, to: number) => RenderChildren
}

// ---- cuerpos del panel -------------------------------------------------------------

// Elementos de la superficie; se pasan sueltos para no depender de una superficie concreta.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type El = Record<'Box' | 'Text' | 'Button' | 'Code', any>

async function readFileText($: Sh, root: string, sel: RefSel): Promise<{ ok: boolean; text: string }> {
  if (!isSafeRelative(sel.path)) return { ok: false, text: 'Ruta fuera del repositorio.' }
  if (sel.head) {
    const r = await git($, root, ['show', `HEAD:${sel.path}`])

    return r.ok ? { ok: true, text: r.out } : { ok: false, text: `HEAD:${sel.path} no existe en HEAD.` }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = await ($ as any).fs.read(`${root}/${sel.path}`)

    return { ok: true, text: String(text) }
  } catch {
    return { ok: false, text: `No se pudo leer ${sel.path}.` }
  }
}

// Una sola linea de texto, sin desplazamiento posible.
function staticBody(node: RenderChildren): Body {
  return { total: 1, draw: from => (from === 0 ? node : null) }
}

// Filas visibles de un tramo [a, b) dentro de la ventana [from, to).
const span = (a: number, b: number, from: number, to: number): [number, number] => [Math.max(a, from), Math.min(b, to)]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function codeBody($: any, el: El, v: View, root: string, cols: number): Promise<Body> {
  const { Box, Text, Button, Code } = el
  // Un simbolo que el agente no ubico: se le puede pedir que lo busque y responda exacto.
  const sym = v.symbol
  const ask = (label: string) => (
    <Box key="top" flexDirection="row">
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">{label}</Text>
      </Box>
      {sym && (
        <Button key="ask-agent" onPress={() => void askAgent($, sym)}>
          Pedir al agente
        </Button>
      )}
    </Box>
  )
  if (v.missing) return { ...staticBody(<Text color="red">No encontrado: {v.missing}</Text>), top: sym ? ask('') : undefined }
  if (v.pending) {
    const p = v.pending
    const items = p.items

    return {
      top: ask(`${items.length} candidatos para ${p.name}: elige uno`),
      total: items.length,
      draw: (from, to) =>
        items.slice(from, to).map((c, i) => (
          <Button key={`cand-${from + i}`} plain dimColor onPress={() => setView($, { pending: null, ref: c })}>
            {clip([`${c.path}:${c.start}`], cols - 2)}
          </Button>
        )),
    }
  }
  if (!v.ref) return staticBody(<Text dimColor>Pulsa una referencia archivo:linea o un `simbolo()` de una respuesta.</Text>)

  const sel = v.ref
  const file = await readFileText($, root, sel)
  const title = `${sel.head ? 'HEAD:' : ''}${sel.path}:${sel.start}${sel.end !== sel.start ? '-' + sel.end : ''}`
  const top = <Text key="top" bold wrap="truncate-start">{title}</Text>
  if (!file.ok) return { ...staticBody(<Text color="red">{file.text}</Text>), top }

  // Todo el archivo como filas: antes, borde, citadas, borde, despues.
  const w = sliceWindow(file.text, sel.start, sel.end, 1_000_000)
  const B = w.before.length
  const C = w.cited.length
  const A = w.after.length
  const bt = B
  const bb = B + 1 + C
  const lang = { path: sel.path }
  const width = cols - 8

  return {
    top,
    total: B + C + A + 2,
    center: B + 1 + Math.floor(C / 2),
    draw: (from, to) => {
      const vis = (r: number) => r >= from && r < to
      const [bs, be] = span(0, B, from, to)
      const [as, ae] = span(B + C + 2, B + C + A + 2, from, to)
      let [cs, ce] = span(B + 1, B + 1 + C, from, to)
      // El recuadro siempre dibuja sus dos bordes: si uno queda fuera de la ventana, se
      // cede una linea citada de ese lado para no pasarse de alto.
      if (ce > cs && !vis(bt)) cs++
      if (ce > cs && !vis(bb)) ce--
      const box = ce > cs

      return (
        <Box key="code" flexDirection="column">
          {be > bs && <Code source={clip(w.before.slice(bs, be), width)} startLine={w.first + bs} {...lang} />}
          {box && (
            <Box key="cited" flexDirection="column" borderStyle="round" borderColor="yellow">
              <Code source={clip(w.cited.slice(cs - B - 1, ce - B - 1), width - 2)} startLine={w.first + cs - 1} {...lang} />
            </Box>
          )}
          {ae > as && <Code source={clip(w.after.slice(as - B - C - 2, ae - B - C - 2), width)} startLine={w.first + as - 2} {...lang} />}
        </Box>
      )
    },
  }
}

// Un archivo elegido en Changes o Last: su diff contra HEAD, o el archivo si es nuevo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fileDiffBody($: any, el: El, v: View, root: string, cols: number): Promise<Body> {
  const { Box, Text, Button, Code } = el
  const path = v.selected ?? ''
  const top = (
    <Box key="top" flexDirection="row" flexShrink={0} height={1}>
      <Button key="back" onPress={() => setView($, { selected: null })}>
        ←
      </Button>
      <Text bold wrap="truncate-start">{` ${path}`}</Text>
    </Box>
  )
  if (!isSafeRelative(path)) return { ...staticBody(<Text color="red">Ruta fuera del repositorio.</Text>), top }

  const width = cols - 14
  const st = await git($, root, ['status', '--porcelain', '-z', '-uall', '--', path])
  const isUntracked = parsePorcelain(st.out).some(c => c.status === '??')

  if (isUntracked) {
    const f = await readFileText($, root, { path, start: 1, end: 1, head: false })
    if (!f.ok) return { ...staticBody(<Text color="red">{f.text}</Text>), top }
    const all = f.text.replace(/\r\n/g, '\n').split('\n')

    return {
      top,
      total: all.length,
      draw: (from, to) => <Code source={clip(all.slice(from, to), width)} startLine={from + 1} path={path} />,
    }
  }

  const d = await git($, root, ['diff', 'HEAD', '--', path])
  const hunks = diffHunks(d.out)
  if (!hunks) {
    return { ...staticBody(<Text dimColor>{d.out.trim() ? 'Diff binario o sin hunks.' : 'Sin diferencias contra HEAD.'}</Text>), top }
  }
  const total = diffPage(hunks, 0, 1).total

  return {
    top,
    total,
    draw: (from, to) => {
      // Cada pagina lleva sus cabeceras @@ reescritas; ocupan fila, asi que se recorta al alto.
      const rows = diffPage(hunks, from, to - from).text.split('\n').slice(0, to - from)
      return <Code source={clip(rows, width)} format="diff" path={path} />
    },
  }
}

type Row = { key: string; label: string; open: () => unknown }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowList(el: El, rows: Row[], note: string, cols: number): Body {
  const { Text, Button } = el
  if (rows.length === 0) return { ...staticBody(<Text dimColor>Nada todavia.</Text>), top: <Text key="top" dimColor wrap="truncate-end">{note}</Text> }

  return {
    top: <Text key="top" dimColor wrap="truncate-end">{note}</Text>,
    total: rows.length,
    draw: (from, to) =>
      rows.slice(from, to).map(r => (
        <Button key={r.key} plain onPress={r.open}>
          {clip([r.label], cols - 2)}
        </Button>
      )),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function changesBody($: any, el: El, sessionFiles: string[], root: string, cols: number): Promise<Body> {
  const st = await git($, root, ['status', '--porcelain', '-z', '-uall'])
  const changes = parsePorcelain(st.out)
  const byPath = new Map<string, string>(changes.map(c => [c.path, c.status]))
  for (const p of sessionFiles) if (!byPath.has(p)) byPath.set(p, '  ')
  const sessionSet = new Set(sessionFiles)
  // Primero lo editado en la sesion, luego el resto.
  const rows = [...byPath.entries()]
    .sort((a, b) => Number(sessionSet.has(b[0])) - Number(sessionSet.has(a[0])) || a[0].localeCompare(b[0]))
    .map(([p, status]) => ({
      key: `chg-${p}`,
      label: `${sessionSet.has(p) ? '●' : ' '} ${status.trim() || '·'} ${p}`,
      open: () => setView($, { selected: p }),
    }))

  return rowList(el, rows, '● = editado por el asistente en esta sesion', cols)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lastBody($: any, el: El, mod: Section, reads: Section, cols: number): Body {
  // Dos secciones: lo modificado (abre su diff) y lo leido (abre el archivo), cada una del
  // mensaje mas reciente que modifico o leyo algo. Un archivo modificado no se repite abajo.
  const { Text, Button } = el
  const readOnly = reads.files.filter(p => !mod.files.includes(p))
  const items: ({ head: string } | Row)[] = [
    { head: mod.files.length ? `Modificados ${when(mod.ago)}` : 'Modificados: nada todavia' },
    ...mod.files.map(p => ({ key: `last-${p}`, label: `✎ ${p}`, open: () => setView($, { selected: p }) })),
    { head: readOnly.length ? `Leidos ${when(reads.ago)}` : 'Leidos: nada todavia' },
    ...readOnly.map(p => ({
      key: `read-${p}`,
      label: `· ${p}`,
      open: () => setView($, { tab: 'code', selected: null, pending: null, missing: null, ref: { path: p, start: 1, end: 1, head: false } }),
    })),
  ]

  return {
    total: items.length,
    draw: (from, to) =>
      items.slice(from, to).map((it, i) =>
        'head' in it ? (
          <Text key={`head-${from + i}`} bold wrap="truncate-end">{it.head}</Text>
        ) : (
          <Button key={it.key} plain onPress={it.open}>
            {clip([it.label], cols - 2)}
          </Button>
        ),
      ),
  }
}

type Section = { files: string[]; ago: number }

const when = (ago: number) => (ago <= 0 ? 'en tu ultimo mensaje' : ago === 1 ? 'en tu mensaje anterior' : `hace ${ago} mensajes`)
