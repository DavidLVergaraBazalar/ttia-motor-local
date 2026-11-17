import { llamarMcp } from "./despachador.js";

/**
 * Hook PreToolUse de Claude Code para las aprobaciones de THE TOWN IA (v0.6).
 *
 * Antes de un comando peligroso (push, merge, crear un PR, subir a Play o a YouTube), Claude Code corre este hook. El
 * hook llama `gastar_aprobacion` con el comando EXACTO: si THE TOWN IA tiene una aprobación aprobada, sin vencer, de
 * esta persona y esta PC para ese mismo comando, la gasta (una sola vez) y el comando corre; si no, lo bloquea. Así una
 * aprobación de A nunca sirve para B, y el texto de un encargo o de un chat no puede aprobar nada.
 *
 * Falla cerrado: sin token, sin red o con una respuesta rara, el comando peligroso se bloquea. Los comandos que no son
 * peligrosos pasan sin consultar a nadie.
 *
 * Entrada (stdin, la de Claude Code): {"tool_name": "Bash" | "PowerShell", "tool_input": {"command": "..."}}.
 * Salida: código 0 = sigue; código 2 = bloqueado (el motivo va por stderr y Claude Code se lo muestra a la sesión).
 */

/** Cada patrón se prueba contra cada tramo del comando (separado por &&, ||, ;, | o salto de línea). */
export const PATRONES_PELIGROSOS: RegExp[] = [
  /^git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*push\b/i,
  /^gh\s+pr\s+(?:merge|create)\b/i,
  /^gh\s+api\b.*\/merges?\b/i,
  /^fastlane\s+(?:supply|deliver|upload_to_play_store|pilot)\b/i,
  /^(?:\S*[\\/])?(?:youtube-?upload(?:er)?|ytupload)\b/i,
  /^(?:py|python3?)(?:\s+-3)?\s+\S*(?:subir|publicar)[_-]?(?:a[_-]?)?(?:play|youtube)\S*\b/i,
  /^gcloud\b.*\bandroidpublisher\b/i,
];

const SEPARADORES = /\s*(?:&&|\|\||;|\||\r?\n)\s*/;

/** ¿Algún tramo del comando es peligroso? */
export function esPeligroso(comando: string, patrones: RegExp[] = PATRONES_PELIGROSOS): boolean {
  return comando
    .split(SEPARADORES)
    .map((t) => t.trim().replace(/^(?:\(|\{)\s*/, ""))
    .filter(Boolean)
    .some((t) => patrones.some((p) => p.test(t)));
}

export interface Decision {
  permitir: boolean;
  motivo: string;
}

export interface DepsHook {
  token: () => string | null;
  /** Llama una herramienta del MCP de THE TOWN IA y devuelve su resultado (texto o JSON). */
  llamar: (token: string, herramienta: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** Decide sobre la entrada de Claude Code. Nunca lanza: ante cualquier duda, bloquea el comando peligroso. */
export async function decidir(entrada: unknown, deps: DepsHook): Promise<Decision> {
  const e = entrada && typeof entrada === "object" ? (entrada as Record<string, unknown>) : {};
  const herramienta = typeof e.tool_name === "string" ? e.tool_name : "";
  const input = e.tool_input && typeof e.tool_input === "object" ? (e.tool_input as Record<string, unknown>) : {};
  const comando = typeof input.command === "string" ? input.command : "";
  if (!["Bash", "PowerShell"].includes(herramienta) || !comando || !esPeligroso(comando)) {
    return { permitir: true, motivo: "no es un comando que necesite aprobación" };
  }
  const token = deps.token();
  if (!token) {
    return { permitir: false, motivo: "BLOQUEADO: este comando necesita una aprobación de THE TOWN IA y esta PC no tiene token (motor-local token set)." };
  }
  try {
    const r = await deps.llamar(token, "gastar_aprobacion", { comando });
    const texto = typeof r === "string" ? r : JSON.stringify(r ?? "");
    if (texto.startsWith("PERMITIDO")) return { permitir: true, motivo: texto.slice(0, 200) };
    return {
      permitir: false,
      motivo: `${texto.startsWith("BLOQUEADO") ? texto.slice(0, 200) : "BLOQUEADO: respuesta inesperada de THE TOWN IA."} ` +
        "Pide la aprobación con pedir_aprobacion pasando este comando exacto, espera a que la persona la apruebe en THE TOWN IA " +
        "y vuelve a correrlo tal cual.",
    };
  } catch (err) {
    return { permitir: false, motivo: `BLOQUEADO: no pude consultar THE TOWN IA (${err instanceof Error ? err.message.slice(0, 120) : "error"}).` };
  }
}

/** Corre el hook: lee stdin, decide y devuelve el código de salida (0 sigue, 2 bloquea). */
export async function correrHook(url: string, token: () => string | null, leer: () => Promise<string>,
                                 escribirError: (s: string) => void): Promise<number> {
  let entrada: unknown = {};
  try {
    entrada = JSON.parse((await leer()) || "{}");
  } catch {
    escribirError("BLOQUEADO: el hook no pudo leer lo que mandó Claude Code.");
    return 2;
  }
  const d = await decidir(entrada, { token, llamar: (t, h, a) => llamarMcp(url, t, h, a, 15_000) });
  if (d.permitir) return 0;
  escribirError(d.motivo);
  return 2;
}

/** El bloque para .claude/settings.json (se muestra; no se escribe solo). Llama a node directo: motor.cmd hace pause. */
export function bloqueSettings(node: string, cli: string): string {
  const cmd = `"${node}" "${cli}" hook aprobacion`;
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash|PowerShell", hooks: [{ type: "command", command: cmd, timeout: 30 }] }] } }, null, 2);
}

/** Lee todo stdin (para el hook). */
export function leerStdin(): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => resolve(s));
    process.stdin.on("error", () => resolve(s));
  });
}
