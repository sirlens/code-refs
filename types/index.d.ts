// Contrato de estado de code-refs: lo que el panel dibuja y lo que se registro en la sesion.
export type RefSel = {
  path: string
  start: number
  end: number
  head: boolean
}

export type Tab = 'code' | 'changes' | 'last'

export type View = {
  tab: Tab
  /** Referencia ya resuelta a un archivo. */
  ref: RefSel | null
  /** Varios candidatos (archivo homonimo o definicion de un simbolo): cada uno es pulsable. */
  pending: { name: string; items: RefSel[] } | null
  /** Nombre o simbolo que no se encontro. */
  missing: string | null
  /** Archivo elegido en Changes / Last. */
  selected: string | null
  /** Desplazamiento de la pagina actual (lineas); se reinicia al navegar. */
  offset: number
  /** Simbolo sin link exacto que se esta mostrando: el panel ofrece pedir al agente que lo ubique. */
  symbol: string | null
  /** Respuesta del subagente al que se le pidio ubicar un simbolo; se muestra en el panel. */
  answer: Answer | null
}

/**
 * Pedido a un subagente para ubicar `symbol`: `asking` mientras corre; luego su texto y,
 * si respondio con un link `code:`, la referencia que abre.
 */
export type Answer = { symbol: string; status: 'asking' | 'done' | 'failed'; text: string; ref: RefSel | null }

/**
 * Simbolo que el agente dejo sin link, ya resuelto al terminar su respuesta. `lines` son las
 * lineas donde aparece (asi se reconoce en el mensaje dibujado); `ref` su definicion, o null
 * si nadie la eligio; `none` si el repo no tiene ninguna definicion (se marca con `?` para pedirle al agente que lo ubique).
 */
export type Resolution = { name: string; lines: string[]; ref: RefSel | null; none?: true }

/** Archivos modificados en el mensaje `turn` del usuario: el mas reciente que modifico algo. */
export type Recent = { turn: number; files: string[] }

/** Archivo tocado en el ultimo turno: E = editado, R = solo leido. */
export type Touch = { path: string; kind: 'E' | 'R' }

declare module 'claude-code' {
  interface PluginState {
    'code-refs': {
      view: Shaped<View>
      /** Archivos modificados en esta sesion: por Edit/Write/NotebookEdit o detectados por git al cerrar el turno. */
      edited: Shaped<string[]>
      /** Archivos tocados desde el ultimo mensaje del usuario. */
      last: Shaped<Touch[]>
      /** Si la regla de links ya se adjunto en esta conversacion. */
      ruleSent: Shaped<boolean>
      /** Mensajes del usuario enviados en la sesion. */
      turnNo: Shaped<number>
      /** Lo que muestra la pestana Last. */
      recent: Shaped<Recent>
      /** Lo leido en el mensaje mas reciente que leyo algo (segunda seccion de Last). */
      recentReads: Shaped<Recent>
      /** Simbolos sin link resueltos al terminar cada respuesta. */
      resolved: Shaped<Resolution[]>
      /** Subagentes que ubican un simbolo: id del agente -> simbolo pedido. */
      asking: Shaped<Record<string, string>>
    }
  }
}
