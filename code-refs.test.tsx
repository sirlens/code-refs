import { expect, test } from 'claude-code/testing'

import {
  definitionHits,
  diffHunks,
  diffPage,
  isDefinition,
  symFromHref,
  symbolName,
  parseCodeTarget,
  stripCodeLinks,
  orderByContext,
  changedBetween,
  pathsInCommand,
  forkPrompt,
  parseForkAnswer,
  fromHref,
  parsePorcelain,
  parseRef,
  resolveCandidates,
  rewriteRefs,
  sliceWindow,
  toHref,
} from './hooks/lib'

// ---- parseo de referencias ------------------------------------------------------

test('parsea archivo:linea, rangos y HEAD:', () => {
  expect(parseRef('modal_document_expense_line.dart:145')).toEqual({
    path: 'modal_document_expense_line.dart', start: 145, end: 145, head: false,
  })
  expect(parseRef('expense_detail_section.dart:77-81')).toEqual({
    path: 'expense_detail_section.dart', start: 77, end: 81, head: false,
  })
  expect(parseRef('HEAD:expense_form_tab.dart:122')).toEqual({
    path: 'expense_form_tab.dart', start: 122, end: 122, head: true,
  })
  expect(parseRef('lib/a/b.ts:3:9')?.path).toBe('lib/a/b.ts')
  expect(parseRef('sin_linea.dart')).toBeUndefined()
  expect(parseRef('x.exe:3')).toBeUndefined()
})

test('reescribe en prosa, con backticks y puntuacion final', () => {
  const r = rewriteRefs('Ver `modal.dart:145`, y tambien lib/x/y.ts:10-12. Luego (HEAD:a.dart:9).')
  expect(r.refs.map(x => [x.path, x.start, x.end, x.head])).toEqual([
    ['modal.dart', 145, 145, false],
    ['lib/x/y.ts', 10, 12, false],
    ['a.dart', 9, 9, true],
  ])
  // La puntuacion queda fuera del link y los backticks dentro del texto del link.
  expect(r.text).toContain('[`modal.dart:145`](https://code-refs.invalid/open?')
  expect(r.text).toMatch(/\[lib\/x\/y\.ts:10-12\]\([^)]*\)\. Luego/)
  expect(r.text).toMatch(/\(\[HEAD:a\.dart:9\]\([^)]*\)\)\./)
  expect(r.hrefs).toHaveLength(3)
  expect(fromHref(r.hrefs[1] as string)).toEqual({ path: 'lib/x/y.ts', start: 10, end: 12, head: false })
})

test('no toca bloques cercados ni codigo con mas texto', () => {
  const src = 'Antes\n```dart\nfoo.dart:12\n```\nDespues `ver foo.dart:12 ahora`\n~~~\nbar.ts:1\n~~~'
  const r = rewriteRefs(src)
  expect(r.refs).toHaveLength(0)
  expect(r.text).toBe(src)
})

test('no enlaza urls ni versiones, y el href viaja ida y vuelta', () => {
  expect(rewriteRefs('http://host/a/b.ts:3 y v1.2.json').refs).toHaveLength(0)
  const ref = { path: 'lib/(grp)/[id].tsx', start: 3, end: 9, head: true }
  expect(fromHref(toHref(ref))).toEqual(ref)
})

// ---- resolucion de archivos ---------------------------------------------------

const FILES = ['lib/a/modal.dart', 'lib/b/modal.dart', 'lib/a/unico.dart', 'lib/c/x/unico.dart.bak']

test('resuelve un candidato, varios o ninguno', () => {
  expect(resolveCandidates(FILES, 'unico.dart')).toEqual(['lib/a/unico.dart'])
  expect(resolveCandidates(FILES, 'modal.dart')).toEqual(['lib/a/modal.dart', 'lib/b/modal.dart'])
  expect(resolveCandidates(FILES, 'b/modal.dart')).toEqual(['lib/b/modal.dart'])
  expect(resolveCandidates(FILES, 'lib/a/modal.dart')).toEqual(['lib/a/modal.dart'])
  expect(resolveCandidates(FILES, 'nada.dart')).toEqual([])
})

test('ventana de contexto y parseo de git', () => {
  const content = Array.from({ length: 100 }, (_, i) => `l${i + 1}`).join('\n') + '\n'
  const w = sliceWindow(content, 50, 52)
  expect(w.first).toBe(35)
  expect(w.cited).toEqual(['l50', 'l51', 'l52'])
  expect(w.before).toHaveLength(15)
  expect(w.after).toHaveLength(15)
  expect(sliceWindow(content, 98, 500).after).toEqual([])

  expect(parsePorcelain(' M a.dart\0?? b.dart\0R  new.dart\0old.dart\0')).toEqual([
    { path: 'a.dart', status: ' M' },
    { path: 'b.dart', status: '??' },
    { path: 'new.dart', status: 'R ' },
  ])
  expect(diffHunks('diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')).toMatch(/^@@/)
  expect(diffHunks('Binary files differ')).toBe('')
})

// ---- hooks: apagado = intacto; encendido = links; panel -------------------------

const MSG = {
  plugin: 'code-refs',
  component: 'AssistantMessage',
  props: { text: 'Mira modal.dart:145 por favor', isFirstOfReply: true },
} as const

test('apagado: el mensaje queda como lo dibuja el motor', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...MSG, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  await ui.unmount()
})

test('encendido: la referencia es un link de un Markdown', async ($, on) => {
  on('store.get', () => ({ value: true }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...MSG, surface: 'terminal' })
  const md = await ui.find({ type: 'Markdown' })

  expect(md?.text).toContain('[modal.dart:145](https://code-refs.invalid/open?')
  await ui.unmount()
})

test('sin referencias el mensaje tampoco se toca', async ($, on) => {
  on('store.get', () => ({ value: true }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({
    ...MSG,
    props: { text: 'nada que enlazar', isFirstOfReply: false },
    surface: 'terminal',
  })

  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

const PANE = {
  plugin: 'code-refs',
  component: 'Pane',
  requestId: 'code-refs',
  props: {
    title: 'Code refs',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const RUN = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// Estado en memoria que hace de motor: lo que escribe el mod lo lee el panel.
function wire(on: (...a: any[]) => unknown, files: string, opens?: unknown[], grepOut = '') {
  const held = new Map<string, unknown>()
  const calls: string[][] = []
  on('store.get', () => ({ value: true }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.open', (_: unknown, e: unknown) => (opens?.push(e), { value: { isPlaced: true } }))
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: held.get(e.key) as never, version: 1 } }))
  on('state.set', (_: unknown, e: { key: string; value: unknown }) => {
    held.set(e.key, e.value)

    return { value: { isSet: true, version: 2 } }
  })
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    calls.push([...e.argv])
    if (e.argv.includes('rev-parse')) return RUN('/repo\n')
    if (e.argv.includes('ls-files')) return RUN(files)
    if (e.argv.includes('grep') && grepOut) return RUN(grepOut)

    return RUN('', 1)
  })

  return calls
}

async function pressRef(ui: any, text: string) {
  const md = await ui.find({ type: 'Markdown' })
  const href = /\((https:\/\/code-refs\.invalid\/open\?[^)]*)\)/.exec(md.text)?.[1]
  await ui.press({ key: 'msg', link: { href } })
}

test('pulsar una referencia trae el panel al frente', async ($, on) => {
  const opens: Array<{ focus?: boolean }> = []
  wire(on as never, 'lib/a/modal.dart\n', opens)
  const toasts: string[] = []
  on('ui.panes', () => ({ value: [{ id: 'code-refs', title: 'Code refs', isShown: true, isFocused: true, isPlaced: true }] }))
  on('ui.toast', (_: unknown, e: { text: string }) => (toasts.push(e.text), { value: undefined }))
  const msg = await $.ui.mount({ ...MSG, surface: 'terminal' })
  await pressRef(msg, 'x')

  expect(opens.at(-1)?.focus).toBe(true)
  expect(toasts).toHaveLength(0)
  await msg.unmount()
})

test('si otro panel tiene el teclado y code-refs queda detras, avisa con un toast', async ($, on) => {
  wire(on as never, 'lib/a/modal.dart\n')
  const toasts: string[] = []
  on('ui.panes', () => ({ value: [{ id: 'code-refs', title: 'Code refs', isShown: false, isFocused: false, isPlaced: true }] }))
  on('ui.toast', (_: unknown, e: { text: string }) => (toasts.push(e.text), { value: undefined }))
  const msg = await $.ui.mount({ ...MSG, surface: 'terminal' })
  await pressRef(msg, 'x')

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('Code refs')
  await msg.unmount()
})

test('pulsar un nombre con varios archivos lista candidatos pulsables', async ($, on) => {
  const calls = wire(on as never, 'lib/a/modal.dart\nlib/b/modal.dart\n')
  const msg = await $.ui.mount({ ...MSG, surface: 'terminal' })
  await pressRef(msg, 'x')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.findAll({ type: 'Button', key: 'cand-0' })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Button', key: 'cand-1' })).toHaveLength(1)
  expect(await ui.find({ type: 'Button', key: 'close' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'tab-changes' })).toBeDefined()
  // Solo git de lectura.
  for (const argv of calls) expect(['rev-parse', 'ls-files', 'show', 'status', 'diff']).toContain(argv[1] as string)
  await ui.unmount()
  await msg.unmount()
})

test('pulsar un nombre inexistente muestra "no encontrado"', async ($, on) => {
  wire(on as never, 'lib/a/otro.dart\n')
  const msg = await $.ui.mount({ ...MSG, surface: 'terminal' })
  await pressRef(msg, 'x')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No encontrado: modal\.dart/ }))?.text).toContain('modal.dart')
  await ui.unmount()
  await msg.unmount()
})

test('un solo archivo se muestra con el rango citado', async ($, on) => {
  const calls = wire(on as never, 'lib/a/modal.dart\n')
  on('fs.read', () => ({ value: Array.from({ length: 200 }, (_, i) => `l${i + 1}`).join('\n') }))
  const msg = await $.ui.mount({ ...MSG, surface: 'terminal' })
  await pressRef(msg, 'x')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /lib\/a\/modal\.dart:145/ })).toBeDefined()
  const code = await ui.findAll({ type: 'Code' })
  expect(code).toHaveLength(3)
  expect(calls.length).toBeGreaterThan(0)
  await ui.unmount()
  await msg.unmount()
})

// ---- simbolos ------------------------------------------------------------------------

test('un span de codigo con un simbolo se enlaza por su ultimo identificador', () => {
  expect(symbolName('controller.state.document?.calculate()')).toBe('calculate')
  expect(symbolName('line.calculate()')).toBe('calculate')
  expect(symbolName('editExpense')).toBe('editExpense')
  expect(symbolName('line.lineTotal')).toBe('lineTotal')
  expect(symbolName('_dirty = true')).toBeUndefined()
  expect(symbolName('true')).toBeUndefined()
  expect(symbolName('a')).toBeUndefined()
  const r = rewriteRefs('En `editExpense`, antes de `controller.state.document?.calculate()` y `x.dart:4`.')
  expect(r.syms).toEqual(['editExpense', 'calculate'])
  expect(r.refs).toHaveLength(1)
  expect(r.text).toContain('[`controller.state.document?.calculate()`](https://code-refs.invalid/open?y=calculate&c=x.dart%3A4-4)')
  expect(symFromHref(r.hrefs.find(h => h.includes('y=')) as string)).toEqual({
    name: 'editExpense',
    ctx: [{ path: 'x.dart', start: 4, end: 4, head: false }],
  })
})

test('distingue definiciones de llamadas', () => {
  expect(isDefinition('  void calculate() {', 'calculate')).toBe(true)
  expect(isDefinition('  Future<void> calculate({bool x = false}) async {', 'calculate')).toBe(true)
  expect(isDefinition('  double get lineTotal => a * b;', 'lineTotal')).toBe(true)
  expect(isDefinition('class DocumentExpense {', 'DocumentExpense')).toBe(true)
  expect(isDefinition('    line.calculate();', 'calculate')).toBe(false)
  expect(isDefinition('    calculate();', 'calculate')).toBe(false)
  expect(isDefinition('    return calculate();', 'calculate')).toBe(false)
  expect(isDefinition('    final t = calculate();', 'calculate')).toBe(false)
  expect(isDefinition('  // void calculate() {', 'calculate')).toBe(false)
  const hits = definitionHits(
    'lib/a.g.dart:3:  void calculate() {\nlib/b.dart:10:  void calculate() {\nlib/c.dart:5:    x.calculate();\n',
    'calculate',
  )
  expect(hits).toEqual([{ path: 'lib/b.dart', line: 10 }, { path: 'lib/a.g.dart', line: 3 }])
})

test('una pagina del diff conserva cabeceras validas aunque corte un hunk', () => {
  const hunks = '@@ -10,4 +10,4 @@ class A\n a\n-b\n+B\n c\n d\n@@ -50,1 +50,2 @@\n x\n+y\n'
  const p = diffPage(hunks, 2, 3)
  expect(p.total).toBe(7)
  expect(p.text.split('\n')).toEqual(['@@ -12,2 +11,3 @@ class A', '+B', ' c', ' d'])
  const q = diffPage(hunks, 4, 3)
  expect(q.text.split('\n')).toEqual(['@@ -13,1 +13,1 @@ class A', ' d', '@@ -50,1 +50,2 @@', ' x', '+y'])
})

// ---- pestana Last y medidas ---------------------------------------------------------

test('Last muestra lo modificado en el mensaje mas reciente que modifico algo', async ($, on) => {
  wire(on as never, 'lib/a/modal.dart\n')
  on('tool.call', () => ({ result: { isError: false, text: 'ok' } }))
  on('prompt.submit', (_: unknown, e: { text: string; context?: readonly string[] }) => ({ text: e.text, context: e.context }))
  const edit = (f: string) => $.tool.call({ tool: 'Edit', file_path: `/repo/lib/${f}`, old_string: 'a', new_string: 'b' } as never)
  const lastRows = async () => {
    const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await first.press({ key: 'tab-last' })
    await first.unmount()
    // El estado del mock no avisa de cambios: se vuelve a montar para leerlo.
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const keys = (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.key)).filter(k => /^(last|read)-/.test(k))
    const heads = (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text)).filter(t => /^(Modificados|Leidos)/.test(t))
    await ui.unmount()
    return { keys, heads }
  }

  // Mensaje 1: dos archivos modificados y uno leido, cada uno en su seccion.
  await $.prompt.submit({ text: 'uno', wait: false } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/lib/r.dart' } as never)
  await edit('e.dart')
  await edit('f.dart')
  expect(await lastRows()).toEqual({
    keys: ['last-lib/e.dart', 'last-lib/f.dart', 'read-lib/r.dart'],
    heads: ['Modificados en tu ultimo mensaje', 'Leidos en tu ultimo mensaje'],
  })

  // Mensaje 2: sin cambios; Last sigue mostrando los del mensaje 1.
  await $.prompt.submit({ text: 'dos', wait: false } as never)
  expect(await lastRows()).toEqual({
    keys: ['last-lib/e.dart', 'last-lib/f.dart', 'read-lib/r.dart'],
    heads: ['Modificados en tu mensaje anterior', 'Leidos en tu mensaje anterior'],
  })

  // Mensaje 3: un cambio nuevo reemplaza la lista.
  await $.prompt.submit({ text: 'tres', wait: false } as never)
  await edit('g.dart')
  expect(await lastRows()).toEqual({
    keys: ['last-lib/g.dart', 'read-lib/r.dart'],
    heads: ['Modificados en tu ultimo mensaje', 'Leidos hace 2 mensajes'],
  })
})

test('inline el panel no pasa de la pantalla', async ($, on) => {
  wire(on as never, 'lib/a/modal.dart\n')
  on('fs.read', () => ({ value: Array.from({ length: 400 }, (_, i) => `l${i + 1}`).join('\n') }))
  const msg = await $.ui.mount({ ...MSG, surface: 'terminal' })
  await pressRef(msg, 'x')

  const ui = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, placement: 'inline', scroll: { offset: 0, bodyRows: 200 } },
    viewport: { columns: 120, rows: 30 },
    surface: 'terminal',
  } as never)
  const lines = (await ui.findAll({ type: 'Code' })).map((c: any) => String(c.props?.source ?? c.source).split('\n').length)
  // 30 filas de pantalla - 16 de margen = 14; menos cabecera, titulo y los 2 bordes del recuadro.
  expect(lines.reduce((a: number, b: number) => a + b, 0)).toBeLessThanOrEqual(10)
  expect(await ui.find({ type: 'Button', key: 'page-down' })).toBeUndefined()
  await ui.unmount()
  await msg.unmount()
})

test('el contexto del mensaje pone primero la definicion citada', () => {
  const hits = [
    { path: 'lib/doc/document_expense.dart', line: 899 },
    { path: 'lib/doc/lines/document_expense_line.dart', line: 460 },
    { path: 'lib/doc/lines/document_expense_line_detail.dart', line: 80 },
  ]
  const r = rewriteRefs('`line.calculate()` vive en document_expense_line.dart:460-469.')
  const link = symFromHref(r.hrefs.find(h => h.includes('y=')) as string)
  expect(orderByContext(hits, [link?.ctx ?? []])[0]).toEqual({ path: 'lib/doc/lines/document_expense_line.dart', line: 460 })
  // Sin contexto que coincida, quedan todas y en el orden original.
  expect(orderByContext(hits, [[]])).toEqual(hits)
  // Archivo citado sin rango que contenga la linea: ese archivo va primero.
  expect(orderByContext(hits, [[{ path: 'document_expense.dart', start: 10, end: 12, head: false }]])[0]).toEqual({
    path: 'lib/doc/document_expense.dart',
    line: 899,
  })
})

test('un campo cuenta como definicion; un parametro con nombre no', () => {
  expect(isDefinition('  double? lineTotal;', 'lineTotal')).toBe(true)
  expect(isDefinition('  late final String code = x;', 'code')).toBe(true)
  expect(isDefinition('    double? lineTotal,', 'lineTotal')).toBe(false)
  expect(isDefinition('    this.lineTotal,', 'lineTotal')).toBe(false)
  expect(isDefinition('    lineTotal = a * b;', 'lineTotal')).toBe(false)
  expect(isDefinition('    return lineTotal;', 'lineTotal')).toBe(false)
  expect(isDefinition('    if (a == lineTotal) {', 'lineTotal')).toBe(false)
})

// ---- links explicitos del agente (code:) ------------------------------------------

test('un link code: del agente se resuelve a su destino exacto', () => {
  expect(parseCodeTarget('lib/a/line.dart:460')).toEqual({ path: 'lib/a/line.dart', start: 460, end: 460, head: false })
  expect(parseCodeTarget('lib/a/line.dart:460-469')?.end).toBe(469)
  expect(parseCodeTarget('lib/a/line.dart')?.start).toBe(1)
  const r = rewriteRefs('Antes de [`line.calculate()`](code:lib/a/line.dart:460) va `otro()`.')
  expect(r.refs).toEqual([{ path: 'lib/a/line.dart', start: 460, end: 460, head: false }])
  // La etiqueta queda igual y el destino pasa a ser un link del mod; no se busca como simbolo.
  expect(r.text).toContain('[`line.calculate()`](https://code-refs.invalid/open?p=lib%2Fa%2Fline.dart&s=460&e=460&h=0)')
  expect(r.syms).toEqual(['otro'])
  expect(r.text).not.toContain('code:')
})

test('dentro de un bloque cercado el link code: no se toca', () => {
  const src = '```md\n[`x()`](code:a.dart:1)\n```'
  expect(rewriteRefs(src).text).toBe(src)
})

test('apagado: los links code: quedan como su etiqueta', async ($, on) => {
  expect(stripCodeLinks('ver [`a.b()`](code:lib/x.dart:3) ya')).toBe('ver `a.b()` ya')
  on('store.get', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({
    ...MSG,
    props: { text: 'ver [`a.b()`](code:lib/x.dart:3) ya', isFirstOfReply: true },
    surface: 'terminal',
  })
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('ver `a.b()` ya')
  await ui.unmount()
})

// ---- regla para el agente: contexto oculto, una sola vez, solo encendido ------------

function wireSubmit(on: (...a: any[]) => unknown, enabled: boolean) {
  const held = new Map<string, unknown>()
  const seen: (readonly string[] | undefined)[] = []
  on('store.get', () => ({ value: enabled }))
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: held.get(e.key) as never, version: 1 } }))
  on('state.set', (_: unknown, e: { key: string; value: unknown }) => {
    held.set(e.key, e.value)

    return { value: { isSet: true, version: 2 } }
  })
  on('prompt.submit', (_: unknown, e: { text: string; context?: readonly string[] }) => {
    seen.push(e.context)

    return { text: e.text, context: e.context }
  })

  return seen
}

test('encendido: la regla viaja oculta en el primer mensaje y no se repite', async ($, on) => {
  const seen = wireSubmit(on as never, true)
  await $.prompt.submit({ text: 'hola', wait: false } as never)
  await $.prompt.submit({ text: 'otra', wait: false } as never)
  expect(seen[0]?.some(c => c.includes('code:<repo-relative path>:<line>'))).toBe(true)
  expect(seen[1] ?? []).toHaveLength(0)
})

test('apagado: ningun mensaje lleva la regla', async ($, on) => {
  const seen = wireSubmit(on as never, false)
  await $.prompt.submit({ text: 'hola', wait: false } as never)
  expect(seen[0] ?? []).toHaveLength(0)
})

test('acoplado: sin botones de pagina y el rango citado lleva su key para centrarlo', async ($, on) => {
  wire(on as never, 'lib/a/modal.dart\n')
  on('fs.read', () => ({ value: Array.from({ length: 400 }, (_, i) => `l${i + 1}`).join('\n') }))
  on('clock.sleep', () => ({ value: undefined }))
  const scrolls: unknown[] = []
  on('ui.scroll', (_: unknown, e: unknown) => {
    scrolls.push(e)

    return { value: undefined }
  })
  const msg = await $.ui.mount({ ...MSG, surface: 'terminal' })
  await pressRef(msg, 'x')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'page-up' })).toBeUndefined()
  expect(await ui.find({ type: 'Box', key: 'cited' })).toBeDefined()
  // Solo se dibujan las filas de la ventana: 30 - pestanas - titulo = 28, contando los 2
  // bordes del recuadro; la cabecera y el titulo quedan fijos aparte.
  const codes = await ui.findAll({ type: 'Code' })
  const lines = codes.map((c: any) => String(c.props?.source ?? c.source).split('\n').length)
  expect(lines.reduce((a: number, b: number) => a + b, 0) + 2).toBe(28)
  expect(await ui.find({ type: 'Button', key: 'tab-code' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /lib\/a\/modal\.dart:145/ })).toBeDefined()
  await ui.unmount()
  await msg.unmount()
})

test('un link code: dentro de una tabla se convierte igual que en prosa', () => {
  const src = '| | [`line.calculate()`](code:lib/a/document_expense_line.dart:460-469) | [`_publishTotal`](code:lib/b/x.dart:183-190) |\n|---|---|---|\n| a | b | c |'
  const r = rewriteRefs(src)
  expect(r.text).not.toContain('code:')
  expect(r.text).toContain('[`line.calculate()`](https://code-refs.invalid/open?p=lib%2Fa%2Fdocument_expense_line.dart&s=460&e=469&h=0)')
  expect(r.hrefs).toHaveLength(2)
})

test('una mencion sin link nunca abre sola si hay varias definiciones: lista con la citada primero', async ($, on) => {
  const held = new Map<string, unknown>()
  on('store.get', () => ({ value: true }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.sleep', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: undefined }))
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: held.get(e.key) as never, version: 1 } }))
  on('state.set', (_: unknown, e: { key: string; value: unknown }) => {
    held.set(e.key, e.value)

    return { value: { isSet: true, version: 2 } }
  })
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    if (e.argv.includes('rev-parse')) return RUN('/repo\n')
    if (e.argv.includes('grep')) {
      return RUN('lib/doc/document_expense.dart:899:  void calculate() {\nlib/doc/lines/document_expense_line.dart:460:  void calculate() {\n')
    }
    if (e.argv.includes('ls-files')) return RUN('lib/doc/lines/document_expense_line.dart\nlib/doc/document_expense.dart\n')

    return RUN('', 1)
  })

  // Trozo 1: la tabla con el link exacto.
  const table = await $.ui.mount({
    ...MSG,
    props: { text: '| | [`line.calculate()`](code:lib/doc/lines/document_expense_line.dart:460-469) |\n|---|---|', isFirstOfReply: true },
    surface: 'terminal',
  })
  // Trozo 2: la frase de abajo, sola, sin referencias.
  const prose = await $.ui.mount({
    ...MSG,
    props: { text: 'Por eso se reemplaza por `line.calculate()` y listo.', isFirstOfReply: false },
    surface: 'terminal',
  })
  const md = await prose.find({ type: 'Markdown' })
  const href = /\((https:\/\/code-refs\.invalid\/open\?y=[^)]*)\)/.exec(String(md?.text))?.[1]
  await prose.press({ key: 'msg', link: { href } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const cands = (await ui.findAll({ type: 'Button' })).filter((b: any) => String(b.key).startsWith('cand-'))
  expect(cands).toHaveLength(2)
  expect(JSON.stringify(cands[0])).toContain('document_expense_line.dart:460')
  await ui.unmount()
  await prose.unmount()
  await table.unmount()
})

test('ordenar por contexto no descarta candidatos', () => {
  const hits = [
    { path: 'lib/doc/document_expense.dart', line: 899 },
    { path: 'lib/doc/lines/document_expense_line.dart', line: 460 },
    { path: 'lib/doc/lines/document_expense_line_detail.dart', line: 80 },
  ]
  const cited = [{ path: 'document_expense_line.dart', start: 460, end: 469, head: false }]
  const read = [{ path: 'lib/doc/document_expense.dart', start: 0, end: -1, head: false }]
  expect(orderByContext(hits, [cited, read]).map(h => h.line)).toEqual([460, 899, 80])
  expect(orderByContext(hits, [])).toHaveLength(3)
})

// ---- lo tocado fuera de las herramientas de archivos ------------------------------

test('la foto de git detecta archivos nuevos, editados y revertidos', () => {
  const before = new Map([['a.dart', 'h1'], ['b.dart', 'h2'], ['c.dart', 'h3']])
  const after = new Map([['a.dart', 'h1'], ['b.dart', 'h9'], ['d.dart', 'h4']])
  expect(changedBetween(before, after).sort()).toEqual(['b.dart', 'c.dart', 'd.dart'])
})

test('los archivos nombrados en un comando de shell cuentan como leidos', () => {
  const files = ['lib/a/modal.dart', 'lib/b/modal.dart', 'lib/a/unico.dart', 'docs/x.md']
  expect(pathsInCommand('grep -n "calc" lib/a/modal.dart && cat unico.dart', files, '/repo')).toEqual([
    'lib/a/modal.dart',
    'lib/a/unico.dart',
  ])
  // Ambiguo (dos modal.dart), una url y un archivo fuera del repo: no cuentan.
  expect(pathsInCommand('cat modal.dart; curl https://x.io/a.json; cat /otro/z.ts', files, '/repo')).toEqual([])
  expect(pathsInCommand('sed -n 1,20p /repo/docs/x.md', files, '/repo')).toEqual(['docs/x.md'])
})

test('la busqueda de simbolos incluye archivos nuevos que git aun no rastrea', async ($, on) => {
  const calls = wire(on as never, 'lib/w/app_numeric_field.dart\n')
  const msg = await $.ui.mount({
    ...MSG,
    props: { text: 'Pasar a `AppNumericField` luego.', isFirstOfReply: true },
    surface: 'terminal',
  })
  const md = await msg.find({ type: 'Markdown' })
  const href = /\((https:\/\/code-refs\.invalid\/open\?y=[^)]*)\)/.exec(String(md?.text))?.[1]
  await msg.press({ key: 'msg', link: { href } })
  const grep = calls.find(a => a[1] === 'grep')
  expect(grep).toContain('--untracked')
  await msg.unmount()
})

// ---- simbolos sin link: deteccion y resolucion --------------------------------

test('HEAD no es un simbolo de codigo', () => {
  expect(symbolName('HEAD')).toBeUndefined()
})

test('cada simbolo sin link se reporta con la linea donde aparece', () => {
  const r = rewriteRefs('El campo `cardNameSupplier` va al pie.\nYa enlazado: [`calc()`](code:lib/a.dart:3).')
  expect(r.symLines).toEqual([{ name: 'cardNameSupplier', line: 'El campo `cardNameSupplier` va al pie.' }])
})

test('con resolucion: exacto se enlaza al destino, sin definicion queda como codigo, sin resolver lleva marca', () => {
  const ref = { path: 'lib/doc.dart', start: 40, end: 40, head: false }
  const text = 'Usa `exacto`, `noEsCodigo` y `pendiente`.'
  const r = rewriteRefs(text, name =>
    name === 'exacto' ? { ref } : name === 'noEsCodigo' ? { none: true } : undefined,
  )
  expect(r.text).toContain(`[\`exacto\`](${toHref(ref)})`)
  expect(r.text).toContain('`noEsCodigo`')
  expect(r.text).not.toMatch(/\[`noEsCodigo`\]/)
  expect(r.text).toMatch(/\[`pendiente`\?\]\(https:\/\/code-refs\.invalid\/open\?y=pendiente/)
  expect(r.unresolved).toEqual(['pendiente'])
})

test('la consulta al modelo solo admite candidatos de la lista', () => {
  const asks = [
    { name: 'cardNameSupplier', cands: [{ path: 'lib/a.dart', line: 4 }, { path: 'lib/doc.dart', line: 40 }] },
    { name: 'otro', cands: [{ path: 'lib/x.dart', line: 1 }, { path: 'lib/y.dart', line: 2 }] },
  ]
  const prompt = forkPrompt(asks)
  expect(prompt).toContain('cardNameSupplier')
  expect(prompt).toContain('2. lib/doc.dart:40')
  const got = parseForkAnswer('cardNameSupplier: 2\notro: 0\ninventado: 1', asks)
  expect(got.get('cardNameSupplier')).toEqual({ path: 'lib/doc.dart', line: 40 })
  expect(got.get('otro')).toBeNull()
  expect(got.has('inventado')).toBe(false)
  // Un numero fuera de rango no elige nada.
  expect(parseForkAnswer('otro: 7', asks).get('otro')).toBeNull()
})

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 5))
}

test('al terminar la respuesta, un simbolo ambiguo sin link se resuelve con el modelo y abre exacto', async ($, on) => {
  const grep = 'lib/a/approval.dart:4:  String? cardNameSupplier;\nlib/b/doc.dart:40:  String? cardNameSupplier;\n'
  wire(on as never, 'lib/a/approval.dart\nlib/b/doc.dart\n', undefined, grep)
  const prompts: string[] = []
  on('model.fork', (_: unknown, e: { prompt: string }) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: 'cardNameSupplier: 2', usage: {} } }
  })
  const answer = 'El campo `cardNameSupplier` va al pie.'
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' } as never)
  await settle()

  expect(prompts).toHaveLength(1)
  const msg = await $.ui.mount({ ...MSG, props: { text: answer, isFirstOfReply: true }, surface: 'terminal' })
  const md = await msg.find({ type: 'Markdown' })
  expect(String(md?.text)).toContain(toHref({ path: 'lib/b/doc.dart', start: 40, end: 40, head: false }))
  await msg.unmount()
})

test('un simbolo con una sola definicion se resuelve sin consultar al modelo', async ($, on) => {
  wire(on as never, 'lib/b/doc.dart\n', undefined, 'lib/b/doc.dart:40:class DocUnico {\n')
  let forks = 0
  on('model.fork', () => (forks++, { value: { isAnswered: true, text: '', usage: {} } }))
  const answer = 'Mira `DocUnico`.'
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' } as never)
  await settle()

  expect(forks).toBe(0)
  const msg = await $.ui.mount({ ...MSG, props: { text: answer, isFirstOfReply: true }, surface: 'terminal' })
  const md = await msg.find({ type: 'Markdown' })
  expect(String(md?.text)).toContain(toHref({ path: 'lib/b/doc.dart', start: 40, end: 40, head: false }))
  await msg.unmount()
})

test('si el modelo no elige, el panel ofrece pedirle al agente que lo ubique', async ($, on) => {
  const grep = 'lib/a/approval.dart:4:  String? cardNameSupplier;\nlib/b/doc.dart:40:  String? cardNameSupplier;\n'
  wire(on as never, 'lib/a/approval.dart\nlib/b/doc.dart\n', undefined, grep)
  on('model.fork', () => ({ value: { isAnswered: true, text: 'cardNameSupplier: 0', usage: {} } }))
  const sent: string[] = []
  on('prompt.submit', (_: unknown, e: { text: string }) => (sent.push(e.text), { text: e.text }))
  const answer = 'El campo `cardNameSupplier` va al pie.'
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' } as never)
  await settle()

  const msg = await $.ui.mount({ ...MSG, props: { text: answer, isFirstOfReply: true }, surface: 'terminal' })
  const md = await msg.find({ type: 'Markdown' })
  expect(String(md?.text)).toContain('`cardNameSupplier`?')
  const href = /\((https:\/\/code-refs\.invalid\/open\?y=[^)]*)\)/.exec(String(md?.text))?.[1]
  await msg.press({ key: 'msg', link: { href } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'ask-agent' })
  await settle()
  expect(sent.at(-1)).toContain('cardNameSupplier')
  await ui.unmount()
  await msg.unmount()
})
