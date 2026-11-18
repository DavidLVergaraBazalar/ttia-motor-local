import fs from "node:fs";
import path from "node:path";

/**
 * Hook PermissionRequest de Claude Code (v0.8.0): cada diálogo de permiso que Claude Code le mostraría a la persona en la
 * terminal de un carril llega también a THE TOWN IA como «Aprobar / Rechazar». Decide quien responda primero.
 *
 * Probado con Claude Code 2.1.327 (18-nov, `claude -p` en una carpeta de prueba y lectura del código):
 * - PermissionRequest se dispara SOLO cuando se mostraría el diálogo: lo que está en allow no llega, y lo que está en
 *   deny se niega antes (tampoco llega). Así lo negado sigue negado y las lecturas permitidas no generan nada.
 * - La entrada trae tool_name, tool_input (la llamada exacta), cwd, transcript_path, session_id y, si la pide un
 *   subagente, agent_id y agent_type. No trae tool_use_id.
 * - Responder `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` deja correr
 *   ESA llamada tal cual (sin updatedInput); `behavior: "deny"` con `message` la niega; salir con 0 sin nada no opina.
 * - En la sesión interactiva el hook corre EN PARALELO con el diálogo de la terminal: si la persona contesta ahí antes,
 *   la respuesta del hook se ignora. En `claude -p` (sin diálogo) el hook decide antes de negar.
 *
 * Reglas: la aprobación vale para una sola llamada exacta (el servidor compara la entrada carácter por carácter al
 * gastarla), vence a los 30 minutos, la aprueba solo la persona con su sesión web. Sin carril, sin token, sin red,
 * servidor caído, vencida o cualquier error: no opina (decide la terminal; en `claude -p`, se niega). Nunca allow por
 * defecto.
 */

/** Herramientas que ya son una pregunta a la persona (o no se pueden aprobar sin ella): no se mandan a la web. */
export const SIN_WEB = new Set(["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]);
export const ENTRADA_MAX = 20_000;     // igual que permisos_cc.ENTRADA_MAX del servidor
const HERRAMIENTA_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const CARRIL_RE = /^[A-Z0-9][A-Z0-9_-]{0,23}$/;
/** El hook espera hasta 29,5 min (la aprobación vence a los 30): el `timeout` del settings es mayor (TIMEOUT_HOOK_S). */
export const ESPERA_MAX_MS = 29.5 * 60_000;
export const TIMEOUT_HOOK_S = 1860;
/** Cada cuánto mira la web: 5 s los primeros 2 min y luego 10 s (el MCP admite 120 llamadas por minuto y por token, y el
 *  servidor deja 5 permisos abiertos por PC: 5 x 12 = 60 en el peor minuto). */
export function intervaloMs(transcurridoMs: number): number {
  return transcurridoMs < 120_000 ? 5_000 : 10_000;
}
const ERRORES_SEGUIDOS_MAX = 5;

export interface Pedido {
  carril: string;
  herramienta: string;
  /** tool_input en JSON, tal como llegó: es lo que la persona ve y lo que el servidor compara al gastarlo. */
  entrada: string;
  carpeta?: string;
  motivo?: string;
  subagente?: string;
}

function texto(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** Arma el pedido con lo que manda Claude Code. null (con el motivo) = no se manda a la web. */
export function armarPedido(entrada: unknown, env: NodeJS.ProcessEnv): { pedido: Pedido | null; motivo: string } {
  const e = entrada && typeof entrada === "object" ? (entrada as Record<string, unknown>) : {};
  const carril = (env.TTIA_CARRIL ?? "").trim().toUpperCase();
  if (!carril) return { pedido: null, motivo: "sin TTIA_CARRIL: no es la sesión de un carril" };
  if (!CARRIL_RE.test(carril)) return { pedido: null, motivo: "TTIA_CARRIL no válido" };
  const herramienta = typeof e.tool_name === "string" ? e.tool_name : "";
  if (!HERRAMIENTA_RE.test(herramienta)) return { pedido: null, motivo: "herramienta no reconocida" };
  if (SIN_WEB.has(herramienta)) return { pedido: null, motivo: `${herramienta} se responde en la terminal` };
  const input = e.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { pedido: null, motivo: "sin tool_input" };
  const json = JSON.stringify(input);
  if (json.length > ENTRADA_MAX) return { pedido: null, motivo: `la llamada pasa de ${ENTRADA_MAX} caracteres` };
  const pedido: Pedido = { carril, herramienta, entrada: json };
  const carpeta = texto(e.cwd, 500);
  const motivo = texto((input as Record<string, unknown>).description, 500);
  const subagente = texto(e.agent_type, 120);
  if (carpeta) pedido.carpeta = carpeta;
  if (motivo) pedido.motivo = motivo;
  if (subagente) pedido.subagente = subagente;
  return { pedido, motivo: "ok" };
}

/** JSON con las claves ordenadas (para comparar dos tool_input sin importar el orden). */
export function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonico((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** En un transcript (JSONL de Claude Code): los id de los tool_use de ESA llamada y los tool_use_id que ya tienen
 *  resultado. Líneas rotas o de otro formato se saltan. */
export function llamadasEnTranscript(jsonl: string, herramienta: string, input: unknown): { usos: string[]; conResultado: Set<string> } {
  const buscado = canonico(input);
  const usos: string[] = [];
  const conResultado = new Set<string>();
  for (const linea of jsonl.split(/\r?\n/)) {
    if (!linea.includes("tool_")) continue;
    let fila: unknown;
    try {
      fila = JSON.parse(linea);
    } catch {
      continue;
    }
    const contenido = (fila as { message?: { content?: unknown } })?.message?.content;
    if (!Array.isArray(contenido)) continue;
    for (const c of contenido as Array<Record<string, unknown>>) {
      if (c?.type === "tool_use" && c.name === herramienta && typeof c.id === "string" && canonico(c.input) === buscado) usos.push(c.id);
      if (c?.type === "tool_result" && typeof c.tool_use_id === "string") conResultado.add(c.tool_use_id);
    }
  }
  return { usos, conResultado };
}

/** El transcript donde queda la llamada: el de la sesión o, si la pidió un subagente, el suyo
 *  (`<carpeta>/<session_id>/subagents/agent-<agent_id>.jsonl`, visto con 2.1.327). */
export function rutaTranscript(entrada: Record<string, unknown>): string | null {
  const t = typeof entrada.transcript_path === "string" ? entrada.transcript_path : "";
  if (!t) return null;
  const agente = typeof entrada.agent_id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(entrada.agent_id) ? entrada.agent_id : "";
  const sesion = typeof entrada.session_id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(entrada.session_id) ? entrada.session_id : "";
  if (!agente) return t;
  if (!sesion) return null;
  return path.join(path.dirname(t), sesion, "subagents", `agent-${agente}.jsonl`);
}

const COLA_BYTES = 4 * 1024 * 1024;

function leerCola(archivo: string): string {
  const fd = fs.openSync(archivo, "r");
  try {
    const tam = fs.fstatSync(fd).size;
    const desde = Math.max(0, tam - COLA_BYTES);
    const buf = Buffer.alloc(tam - desde);
    fs.readSync(fd, buf, 0, buf.length, desde);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * ¿La persona ya respondió en la terminal? Mira el transcript: la primera vez que encuentra ESA llamada sin resultado la
 * anota; cuando todas las anotadas tienen resultado (corrió o se negó), ya se respondió. Si no encuentra nada, no
 * opina (la tarjeta queda hasta que venza). Nunca lanza.
 */
export function vigiaTranscript(archivo: string | null, herramienta: string, input: unknown, leer: (a: string) => string = leerCola): () => boolean {
  let anotadas: string[] | null = null;
  return () => {
    if (!archivo) return false;
    try {
      if (!fs.existsSync(archivo)) return false;
      const { usos, conResultado } = llamadasEnTranscript(leer(archivo), herramienta, input);
      if (!anotadas) {
        const abiertas = usos.filter((id) => !conResultado.has(id));
        if (abiertas.length) anotadas = abiertas;
        return false;
      }
      return anotadas.every((id) => conResultado.has(id));
    } catch {
      return false;
    }
  };
}

export type Resultado = { accion: "allow" | "deny" | "local"; motivo: string };

export interface DepsPermiso {
  /** Llama una herramienta del MCP de THE TOWN IA y devuelve su texto. */
  llamar: (herramienta: string, args: Record<string, unknown>) => Promise<string>;
  dormir: (ms: number) => Promise<void>;
  ahora: () => number;
  /** true si la persona ya respondió en la terminal (vigiaTranscript). */
  respondidaEnTerminal: () => boolean;
}

async function cancelar(deps: DepsPermiso, id: string): Promise<void> {
  try {
    await deps.llamar("cancelar_permiso", { aprobacion_id: id });
  } catch {
    /* si no se puede, la tarjeta vence sola a los 30 min */
  }
}

/** Pide el permiso y espera la decisión de la web. Nunca lanza; ante cualquier duda, «local». */
export async function pedirYEsperar(pedido: Pedido, deps: DepsPermiso, esperaMaxMs = ESPERA_MAX_MS): Promise<Resultado> {
  const inicio = deps.ahora();
  let r: string;
  try {
    r = await deps.llamar("pedir_permiso", { ...pedido });
  } catch (e) {
    return { accion: "local", motivo: `no pude avisar a THE TOWN IA (${e instanceof Error ? e.message.slice(0, 120) : "error"})` };
  }
  if (!r.startsWith("PEDIDO ")) return { accion: "local", motivo: r.slice(0, 200) };
  let id = "";
  let vence = Number.NaN;
  try {
    const d = JSON.parse(r.slice(7)) as { aprobacion_id?: unknown; vence_en?: unknown };
    id = typeof d.aprobacion_id === "string" ? d.aprobacion_id : "";
    vence = Date.parse(String(d.vence_en ?? ""));
  } catch {
    /* respuesta rara */
  }
  if (!id) return { accion: "local", motivo: "respuesta inesperada de THE TOWN IA" };
  const limite = Math.min(inicio + esperaMaxMs, Number.isNaN(vence) ? Infinity : vence);
  let errores = 0;
  for (;;) {
    await deps.dormir(intervaloMs(deps.ahora() - inicio));
    if (deps.respondidaEnTerminal()) {
      await cancelar(deps, id);
      return { accion: "local", motivo: "la persona respondió en la terminal" };
    }
    if (deps.ahora() >= limite) {
      await cancelar(deps, id);
      return { accion: "local", motivo: "nadie respondió en THE TOWN IA a tiempo" };
    }
    let estado: string;
    try {
      estado = (await deps.llamar("ver_permiso", { aprobacion_id: id })).trim();
      errores = 0;
    } catch {
      if (++errores >= ERRORES_SEGUIDOS_MAX) {
        await cancelar(deps, id);
        return { accion: "local", motivo: "se perdió la conexión con THE TOWN IA" };
      }
      continue;
    }
    if (estado === "PENDIENTE") continue;
    if (estado === "APROBADA") {
      try {
        const g = await deps.llamar("gastar_permiso", { aprobacion_id: id, herramienta: pedido.herramienta, entrada: pedido.entrada });
        if (g.startsWith("PERMITIDO")) return { accion: "allow", motivo: "aprobado en THE TOWN IA" };
        return { accion: "local", motivo: g.slice(0, 200) };
      } catch {
        return { accion: "local", motivo: "no pude gastar la aprobación" };
      }
    }
    if (estado === "RECHAZADA") {
      return { accion: "deny", motivo: "La persona lo rechazó en THE TOWN IA. No lo intentes de otra forma: sigue sin eso o pregúntale con preguntar." };
    }
    return { accion: "local", motivo: `permiso ${estado.toLowerCase().slice(0, 40)}` };   // VENCIDA, CANCELADA, USADA, DESCONOCIDA
  }
}

/** Lo que Claude Code entiende como decisión del hook PermissionRequest. */
export function salidaPermiso(r: Resultado): string | null {
  if (r.accion === "allow") return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  if (r.accion === "deny") {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: r.motivo } } });
  }
  return null;   // local: no opina, decide la terminal
}

/** Corre el hook: lee stdin, manda el permiso y espera. Siempre sale con 0 (un hook PermissionRequest no bloquea con 2). */
export async function correrHookPermiso(
  llamar: (token: string, herramienta: string, args: Record<string, unknown>) => Promise<unknown>,
  token: () => string | null,
  leer: () => Promise<string>,
  escribir: (s: string) => void,
  escribirError: (s: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  dormir: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ahora: () => number = Date.now,
): Promise<number> {
  let entrada: Record<string, unknown> = {};
  try {
    const v = JSON.parse((await leer()) || "{}") as unknown;
    if (v && typeof v === "object") entrada = v as Record<string, unknown>;
  } catch {
    return 0;
  }
  const { pedido, motivo } = armarPedido(entrada, env);
  if (!pedido) return 0;
  const t = token();
  if (!t) {
    escribirError(`THE TOWN IA: permiso solo en la terminal (${motivo === "ok" ? "esta PC no tiene token" : motivo}).`);
    return 0;
  }
  const r = await pedirYEsperar(pedido, {
    llamar: async (h, a) => {
      const x = await llamar(t, h, a);
      return typeof x === "string" ? x : JSON.stringify(x ?? "");
    },
    dormir,
    ahora,
    respondidaEnTerminal: vigiaTranscript(rutaTranscript(entrada), pedido.herramienta, entrada.tool_input),
  });
  const s = salidaPermiso(r);
  if (s) escribir(s);
  else escribirError(`THE TOWN IA: ${r.motivo}`);
  return 0;
}

/** La entrada del settings: matcher para todas las herramientas; el hook mismo deja fuera SIN_WEB. */
export function hookPermisoSettings(node: string, cli: string): { matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> } {
  return { matcher: "*", hooks: [{ type: "command", command: `"${node}" "${cli}" hook permiso`, timeout: TIMEOUT_HOOK_S }] };
}
