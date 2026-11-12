import path from "node:path";
import { rutaPermitida } from "./rutas.js";
import { tachar } from "./log.js";

export const PERMISO_TIMEOUT_MS = 5 * 60 * 1000;

/** Herramientas que solo leen. Dentro de las carpetas permitidas se aprueban solas. */
const SOLO_LECTURA = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
/** Herramientas de escritura de archivos: ruta verificada y aprobacion humana. */
const ESCRITURA = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Herramientas internas sin efecto sobre el mundo exterior. */
const INTERNAS = new Set(["TodoWrite", "ToolSearch"]);
/** Herramientas que traen contenido de afuera al turno. */
const TRAEN_CONTENIDO_EXTERNO = new Set(["WebFetch", "WebSearch"]);
const SHELL = new Set(["Bash", "PowerShell"]);

const CLAVES_RUTA = ["file_path", "path", "notebook_path", "directory"];

export interface ContextoPermiso {
  carpetas: string[];
  /** Carpeta de trabajo de la tarea: las rutas relativas se resuelven contra ella. */
  cwd: string;
  /** El turno ya incluye contenido externo (web, MCP, descargas). */
  contenidoExterno: boolean;
}

export type Decision =
  | { accion: "permitir" }
  | { accion: "preguntar"; resumen: string }
  | { accion: "denegar"; motivo: string };

export function esHerramientaDeLectura(nombre: string): boolean {
  return SOLO_LECTURA.has(nombre);
}

/** true si usar esta herramienta mete contenido de afuera en la conversacion. */
export function traeContenidoExterno(nombre: string, input: Record<string, unknown>): boolean {
  if (TRAEN_CONTENIDO_EXTERNO.has(nombre) || nombre.startsWith("mcp__")) return true;
  if (SHELL.has(nombre)) {
    const cmd = typeof input.command === "string" ? input.command : "";
    return /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|git\s+clone|npm\s+i(nstall)?|pip\s+install)\b/i.test(cmd);
  }
  return false;
}

function rutasDe(input: Record<string, unknown>): string[] {
  const rutas: string[] = [];
  for (const k of CLAVES_RUTA) {
    const v = input[k];
    if (typeof v === "string" && v !== "") rutas.push(v);
  }
  // Glob: el patron puede ser absoluto o escapar con "..".
  const pat = input.pattern;
  if (typeof pat === "string" && (path.isAbsolute(pat) || /(^|[\\/])\.\.([\\/]|$)/.test(pat))) rutas.push(pat);
  return rutas;
}

function recortar(s: string, max = 200): string {
  const limpio = tachar(s).replace(/\s+/g, " ").trim();
  return limpio.length > max ? limpio.slice(0, max - 1) + "..." : limpio;
}

/** Texto corto para el cartel de permiso. Puede incluir el comando: el humano debe verlo para decidir. */
export function resumirHerramienta(nombre: string, input: Record<string, unknown>, cwd: string): string {
  const ruta = rutasDe(input)[0];
  const rel = ruta ? path.relative(cwd, path.resolve(cwd, ruta)) || "." : "";
  if (ESCRITURA.has(nombre)) return `${nombre === "Write" ? "Crear o sobrescribir" : "Modificar"} el archivo ${rel}`;
  if (SHELL.has(nombre)) return `Ejecutar un comando: ${recortar(String(input.command ?? ""))}`;
  if (nombre === "WebFetch") return `Abrir la direccion ${recortar(String(input.url ?? ""), 120)}`;
  if (nombre === "WebSearch") return `Buscar en internet: ${recortar(String(input.query ?? ""), 120)}`;
  if (nombre.startsWith("mcp__")) return `Usar la herramienta externa ${nombre}`;
  if (rel) return `Usar ${nombre} sobre ${rel}`;
  return `Usar la herramienta ${nombre}`;
}

/** Descripcion para el evento `herramienta`: nunca lleva comandos, URLs ni contenido. */
export function describirUso(nombre: string, input: Record<string, unknown>, cwd: string): string {
  const ruta = rutasDe(input)[0];
  if (ruta) return path.relative(cwd, path.resolve(cwd, ruta)) || ".";
  return "";
}

/**
 * Politica de permisos del motor. La usan tanto el hook PreToolUse (que corre siempre,
 * incluso si una regla permitiera la herramienta) como el callback canUseTool.
 */
export function evaluarHerramienta(nombre: string, input: Record<string, unknown>, ctx: ContextoPermiso): Decision {
  if (ctx.carpetas.length === 0) return { accion: "denegar", motivo: "No hay carpetas permitidas configuradas." };

  // Toda ruta que la herramienta nombre debe caer dentro de las carpetas permitidas.
  for (const r of rutasDe(input)) {
    if (!rutaPermitida(r, ctx.carpetas, ctx.cwd)) {
      return { accion: "denegar", motivo: "Esa ruta esta fuera de las carpetas permitidas." };
    }
  }
  if (SOLO_LECTURA.has(nombre)) {
    // Una lectura sin ruta explicita opera sobre el cwd, que ya esta validado.
    return { accion: "permitir" };
  }
  if (INTERNAS.has(nombre)) return { accion: "permitir" };
  // Todo lo demas (escribir, borrar, shell, red, MCP, desconocidas) pide permiso al humano,
  // haya o no contenido externo en el turno: no existe ninguna regla que lo apruebe solo.
  return { accion: "preguntar", resumen: resumirHerramienta(nombre, input, ctx.cwd) };
}

export interface PedidoPermiso {
  id: string;
  herramienta: string;
  resumen: string;
}

/** Permisos en espera de la respuesta de la web, con timeout que equivale a denegar. */
export class SolicitudesPermiso {
  private pendientes = new Map<string, (aprobado: boolean) => void>();
  private contador = 0;

  constructor(private timeoutMs: number = PERMISO_TIMEOUT_MS) {}

  nuevoId(): string {
    this.contador += 1;
    return `p${this.contador}-${Date.now().toString(36)}`;
  }

  /** Emite el pedido y espera. Devuelve false si se deniega, vence el tiempo o se cancela. */
  pedir(emitir: (p: PedidoPermiso) => void, datos: Omit<PedidoPermiso, "id">, signal?: AbortSignal): Promise<boolean> {
    const id = this.nuevoId();
    return new Promise<boolean>((resolve) => {
      let hecho = false;
      const cerrar = (valor: boolean): void => {
        if (hecho) return;
        hecho = true;
        clearTimeout(timer);
        this.pendientes.delete(id);
        signal?.removeEventListener("abort", alAbortar);
        resolve(valor);
      };
      const alAbortar = (): void => cerrar(false);
      const timer = setTimeout(() => cerrar(false), this.timeoutMs);
      this.pendientes.set(id, cerrar);
      if (signal?.aborted) return cerrar(false);
      signal?.addEventListener("abort", alAbortar, { once: true });
      emitir({ id, ...datos });
    });
  }

  /** Devuelve true si el id existia (y estaba pendiente). */
  responder(id: string, aprobado: boolean): boolean {
    const f = this.pendientes.get(id);
    if (!f) return false;
    f(aprobado);
    return true;
  }

  cancelarTodas(): void {
    for (const f of [...this.pendientes.values()]) f(false);
  }

  get cantidad(): number {
    return this.pendientes.size;
  }
}
