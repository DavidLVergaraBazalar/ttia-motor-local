import { llamarMcp } from "./despachador.js";
import { hookPermisoSettings } from "./permiso.js";

/**
 * Hook PreToolUse de Claude Code para las aprobaciones de THE TOWN IA (v0.6).
 *
 * IMPORTANTE (revisión del 17-nov): este hook NO es la frontera. La frontera son los permisos del carril: lo peligroso
 * (push, merge, `gh pr create`, `gh api` que escribe, `aplicar.py --escribir`, `desplegar.py`) va en `ask` o en
 * `deny`, NUNCA en `allow`. Una sesión sola que choca con `ask` se queda esperando (y en `claude -p` se niega). Lo que
 * hace el hook es subir el caso normal a `allow` cuando hay aprobación: si THE TOWN IA tiene una aprobación aprobada,
 * sin vencer, de esta persona y esta PC para ese comando EXACTO, la gasta (una sola vez) y responde por stdout
 * `permissionDecision: "allow"`. Si no la hay, bloquea (código 2) con el motivo. Si el hook falla, no está o tarda,
 * Claude Code sigue con la regla del settings (`ask`): nada peligroso corre sin aprobación.
 *
 * Los patrones de abajo reconocen las formas comunes (comillas, opciones globales, envoltorios, `bash -c`…) para que
 * el caso normal gaste su aprobación; un comando raro que no reconozcan cae en `ask`, no en `allow`.
 *
 * Entrada (stdin, la de Claude Code): {"tool_name": "Bash" | "PowerShell", "tool_input": {"command": "..."}}.
 */

const SEPARADORES = /\s*(?:&&|\|\||;|\||\r?\n)\s*/;
const ENVOLTORIOS = new Set(["env", "command", "time", "nohup", "exec", "builtin", "sudo"]);
const SHELLS = new Set(["bash", "sh", "zsh", "cmd", "powershell", "pwsh"]);
const METODOS_QUE_ESCRIBEN = new Set(["PUT", "POST", "PATCH", "DELETE"]);

/** Tokens de un tramo de comando, respetando comillas simples y dobles (suficiente para reconocer, no para ejecutar). */
export function tokens(tramo: string): string[] {
  const salida: string[] = [];
  let actual = "";
  let comilla: string | null = null;
  let hay = false;
  for (const ch of tramo) {
    if (comilla) {
      if (ch === comilla) comilla = null;
      else actual += ch;
    } else if (ch === "'" || ch === '"') {
      comilla = ch;
      hay = true;
    } else if (/\s/.test(ch)) {
      if (hay || actual) salida.push(actual);
      actual = "";
      hay = false;
    } else {
      actual += ch;
      hay = true;
    }
  }
  if (hay || actual) salida.push(actual);
  return salida;
}

/** «C:\Program Files\Git\bin\git.exe» -> «git». */
function base(t: string): string {
  return (t.split(/[\\/]/).pop() ?? t).replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

const ASIGNACION = /^[A-Za-z_][A-Za-z0-9_]*=/;

function quitarEnvoltorios(ts: string[]): string[] {
  let i = 0;
  while (i < ts.length) {
    const t = ts[i] as string;
    if (ASIGNACION.test(t)) { i++; continue; }   // VAR=valor git push
    if (ENVOLTORIOS.has(base(t))) {
      i++;
      while (i < ts.length && ((ts[i] as string).startsWith("-") || ASIGNACION.test(ts[i] as string))) i++;
      continue;
    }
    break;
  }
  return ts.slice(i);
}

function esGitPeligroso(ts: string[]): boolean {
  let i = 1;
  while (i < ts.length) {
    const t = ts[i] as string;
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(t)) { i += 2; continue; }
    if (t.startsWith("-")) { i++; continue; }   // --no-pager, -P, --git-dir=..., --exec-path...
    return t === "push";
  }
  return false;
}

function metodoDe(resto: string[], porDefecto: string, banderas: string[]): string {
  let metodo = porDefecto;
  resto.forEach((t, k) => {
    if (banderas.includes(t)) metodo = (resto[k + 1] ?? metodo).toUpperCase();
    else {
      const m = /^(?:-X|--method=|--request=)([A-Za-z]+)$/.exec(t);
      if (m) metodo = (m[1] as string).toUpperCase();
    }
  });
  return metodo;
}

function esGhPeligroso(ts: string[]): boolean {
  let i = 1;
  while (i < ts.length) {
    const t = ts[i] as string;
    if (t === "-R" || t === "--repo" || t === "--hostname") { i += 2; continue; }
    if (t.startsWith("-")) { i++; continue; }
    break;
  }
  const sub = ts[i];
  if (sub === "pr") return ["merge", "create"].includes(ts[i + 1] ?? "");
  if (sub !== "api") return false;
  const resto = ts.slice(i + 1);
  const conCampos = resto.some((t) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(t));
  const metodo = metodoDe(resto, conCampos ? "POST" : "GET", ["-X", "--method"]);   // con campos, gh api manda POST
  const texto = resto.join(" ");
  if (/mergePullRequest/i.test(texto)) return true;
  return METODOS_QUE_ESCRIBEN.has(metodo) && /\/(?:merges?|pulls?)\b|graphql/i.test(texto);
}

function esCurlPeligroso(ts: string[]): boolean {
  const texto = ts.join(" ");
  if (!/api\.github\.com/i.test(texto) || !/\/(?:merges?|pulls?)\b|graphql/i.test(texto)) return false;
  if (/mergePullRequest/i.test(texto)) return true;
  const conDatos = ts.some((t) => /^(-d|--data\S*|-F|--form|-Body)$/i.test(t));
  return METODOS_QUE_ESCRIBEN.has(metodoDe(ts, conDatos ? "POST" : "GET", ["-X", "--request", "-Method"]));
}

const PATRONES_SUELTOS: RegExp[] = [
  /^fastlane\s+(?:supply|deliver|upload_to_play_store|pilot)\b/i,
  /^(?:youtube-?upload(?:er)?|ytupload)\b/i,
  /\b(?:subir|publicar)[_-]?(?:a[_-]?)?(?:play|youtube)\S*\.py\b/i,
  /^gcloud\b.*\bandroidpublisher\b/i,
  /\baplicar\.py\b.*--escribir\b/i,
  /\bdesplegar\.py\b/i,
];

const BANDERA_SHELL = /^(?:-c|\/c|\/k|-command|-encodedcommand)$/i;

/** ¿Es peligroso este tramo (ya sin separadores)? Abre `bash -c "..."`, `cmd /c ...` y `powershell -Command ...`. */
function tramoPeligroso(tramo: string, profundidad: number): boolean {
  const ts = quitarEnvoltorios(tokens(tramo.trim().replace(/^[({]\s*/, "")));
  if (!ts.length) return false;
  const cmd = base(ts[0] as string);
  if (SHELLS.has(cmd)) {
    const k = ts.findIndex((t, j) => j > 0 && BANDERA_SHELL.test(t));
    if (k > 0) {
      if (/^-encodedcommand$/i.test(ts[k] as string) || profundidad >= 3) return true;   // no se puede leer: se trata como peligroso
      return esPeligroso(ts.slice(k + 1).join(" "), profundidad + 1);
    }
  }
  if (cmd === "git") return esGitPeligroso(ts);
  if (cmd === "gh") return esGhPeligroso(ts);
  if (["curl", "invoke-restmethod", "invoke-webrequest", "irm", "iwr"].includes(cmd)) return esCurlPeligroso(ts);
  const plano = [cmd, ...ts.slice(1)].join(" ");
  return PATRONES_SUELTOS.some((p) => p.test(plano));
}

/** ¿Algún tramo del comando es de los que necesitan aprobación? (Reconoce el caso normal; no es la frontera.) */
export function esPeligroso(comando: string, profundidad = 0): boolean {
  return comando.split(SEPARADORES).filter((t) => t.trim()).some((t) => tramoPeligroso(t, profundidad));
}

export interface Decision {
  /** "allow": hay aprobación (se responde permissionDecision allow). "bloquear": código 2. "seguir": no opina. */
  accion: "allow" | "bloquear" | "seguir";
  motivo: string;
}

export interface DepsHook {
  token: () => string | null;
  /** Llama una herramienta del MCP de THE TOWN IA y devuelve su resultado (texto o JSON). */
  llamar: (token: string, herramienta: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** Decide sobre la entrada de Claude Code. Nunca lanza. */
export async function decidir(entrada: unknown, deps: DepsHook): Promise<Decision> {
  const e = entrada && typeof entrada === "object" ? (entrada as Record<string, unknown>) : {};
  const herramienta = typeof e.tool_name === "string" ? e.tool_name : "";
  const input = e.tool_input && typeof e.tool_input === "object" ? (e.tool_input as Record<string, unknown>) : {};
  const comando = typeof input.command === "string" ? input.command : "";
  if (!["Bash", "PowerShell"].includes(herramienta) || !comando || !esPeligroso(comando)) {
    return { accion: "seguir", motivo: "no es un comando que necesite aprobación" };   // decide el settings
  }
  const token = deps.token();
  if (!token) {
    return { accion: "bloquear", motivo: "BLOQUEADO: este comando necesita una aprobación de THE TOWN IA y esta PC no tiene token (motor-local token set)." };
  }
  try {
    const r = await deps.llamar(token, "gastar_aprobacion", { comando });
    const texto = typeof r === "string" ? r : JSON.stringify(r ?? "");
    if (texto.startsWith("PERMITIDO")) return { accion: "allow", motivo: texto.slice(0, 200) };
    return {
      accion: "bloquear",
      motivo: `${texto.startsWith("BLOQUEADO") ? texto.slice(0, 200) : "BLOQUEADO: respuesta inesperada de THE TOWN IA."} ` +
        "Pide la aprobación con pedir_aprobacion pasando este comando exacto, espera a que la persona la apruebe en THE TOWN IA " +
        "y vuelve a correrlo tal cual. No lo reescribas para esquivar este control.",
    };
  } catch (err) {
    return { accion: "bloquear", motivo: `BLOQUEADO: no pude consultar THE TOWN IA (${err instanceof Error ? err.message.slice(0, 120) : "error"}).` };
  }
}

/** La salida que Claude Code entiende como «permitido por el hook» (sube el `ask` del settings a `allow`). */
export const SALIDA_PERMITIDO = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });

/** Corre el hook: lee stdin, decide y devuelve el código de salida (0 sigue, 2 bloquea). */
export async function correrHook(url: string, token: () => string | null, leer: () => Promise<string>,
                                 escribir: (s: string) => void, escribirError: (s: string) => void): Promise<number> {
  let entrada: unknown = {};
  try {
    entrada = JSON.parse((await leer()) || "{}");
  } catch {
    escribirError("BLOQUEADO: el hook no pudo leer lo que mandó Claude Code.");
    return 2;
  }
  const d = await decidir(entrada, { token, llamar: (t, h, a) => llamarMcp(url, t, h, a, 15_000) });
  if (d.accion === "allow") {
    escribir(SALIDA_PERMITIDO);
    return 0;
  }
  if (d.accion === "seguir") return 0;
  escribirError(d.motivo);
  return 2;
}

/** El bloque para .claude/settings.json (se muestra; no se escribe solo). Llama a node directo: motor.cmd hace pause. */
export function bloqueSettings(node: string, cli: string): string {
  return JSON.stringify({ hooks: hooksAprobacion(node, cli) }, null, 2);
}

/** El objeto `hooks` del settings, con node + dist\cli.js por su ruta absoluta (nunca motor.cmd):
 *  PreToolUse = aprobaciones de lo irreversible (v0.6); PermissionRequest = los diálogos de permiso también en la web
 *  (v0.8.0, permiso.ts). */
export function hooksAprobacion(node: string, cli: string): { PreToolUse: unknown[]; PermissionRequest: unknown[] } {
  const cmd = `"${node}" "${cli}" hook aprobacion`;
  return {
    PreToolUse: [{ matcher: "Bash|PowerShell", hooks: [{ type: "command", command: cmd, timeout: 30 }] }],
    PermissionRequest: [hookPermisoSettings(node, cli)],
  };
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
