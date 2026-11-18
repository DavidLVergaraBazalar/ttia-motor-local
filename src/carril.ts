import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CARRIL_VALIDO, carpetaDatos, crearConfigSiFalta, normalizarConfig, rutaConfig, type ConfigMotor } from "./config.js";
import { parsearRespuestaMcp } from "./despachador.js";
import { hooksAprobacion } from "./hook.js";
import { rutaPermitida } from "./rutas.js";

/**
 * `motor-local carril instalar | abrir | estado | quitar` (v0.7): conectar un carril de Claude Code en una PC con un
 * comando, en vez de editar motor.json, armar el settings del carril y pegar el token en dos sitios a mano.
 *
 * El token: se pide sin eco, se valida contra el MCP de THE TOWN IA ANTES de guardarlo, va al Administrador de
 * credenciales (lo usa el motor) y al MCP `ttia` de Claude Code (lo usa la sesion). A Claude Code se le pasa por la
 * ENTRADA ESTANDAR de `claude mcp add-json ttia - --scope user`: nunca va en la linea de comandos (la ve cualquier
 * proceso de la PC), en un archivo temporal ni en un log. Nunca se imprime.
 */

export type Perfil = "generico" | "apdayc" | "juegos";
export const PERFILES: Perfil[] = ["generico", "apdayc", "juegos"];

export const PROMPT_CARRIL = (carril: string): string => `Eres la sesión del carril ${carril}: sigue la skill carril-ttia.`;

export const MENSAJE_TOKEN_RECHAZADO =
  "THE TOWN IA rechazó el token (revocado o vencido). Crea uno nuevo en THE TOWN IA, Mi PC > Claude Code, y vuelve a correr con --token-nuevo.";

export function normalizarCarril(v: string | undefined): string {
  const c = (v ?? "").trim().toUpperCase();
  if (!CARRIL_VALIDO.test(c)) throw new Error("El carril va en mayúsculas, números, - o _ (hasta 24), por ejemplo JUEGOS o APDAYC.");
  return c;
}

export function carpetaCarrilPorDefecto(carril: string, home = os.homedir()): string {
  return path.join(home, "ttia-carriles", carril);
}

/** La carpeta del respaldo (`claude -p` del despachador): hermana de la del carril, nunca la del carril. */
export function carpetaRespaldoPorDefecto(carpetaCarril: string): string {
  return path.join(path.dirname(path.resolve(carpetaCarril)), "_respaldo");
}

function clave(p: string): string {
  const r = path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? r.toLowerCase() : r;
}

function mismaRuta(a: string, b: string): boolean {
  return clave(a) === clave(b);
}

/** true si `hijo` es `padre` o esta dentro. */
function dentroDe(hijo: string, padre: string): boolean {
  const rel = path.relative(clave(padre), clave(hijo));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** La carpeta de un carril no puede ser un disco, tu carpeta de usuario ni algo dentro de ~/.claude (ahí su settings
 *  sería el de tu usuario). */
export function validarCarpetaCarril(carpeta: string, home = os.homedir()): string {
  if (!carpeta || !path.isAbsolute(carpeta)) throw new Error("La carpeta del carril va con su ruta completa (por ejemplo C:\\Users\\Ana\\ttia-carriles\\JUEGOS).");
  const abs = path.resolve(carpeta);
  if (path.parse(abs).root.toLowerCase() === abs.toLowerCase()) throw new Error(`La carpeta del carril no puede ser un disco entero (${abs}).`);
  if (mismaRuta(abs, home)) throw new Error("La carpeta del carril no puede ser tu carpeta de usuario: su .claude\\settings.json sería el de todo Claude Code.");
  if (dentroDe(abs, path.join(home, ".claude"))) throw new Error("La carpeta del carril no puede estar dentro de ~/.claude.");
  return abs;
}

// ---------------------------------------------------------------- motor.json

export interface PlanMotor {
  crudo: Record<string, unknown>;
  cambios: string[];
  /** La carpeta del respaldo que queda en motor.json (la nueva o la que ya estaba). */
  respaldo: string;
}

/**
 * motor.json con el carril agregado. Puro: no lee ni escribe archivos. Conserva todo lo demás tal cual (claves que este
 * motor no conoce incluidas). Lanza si el resultado no es una configuración válida.
 */
export function planInstalarEnMotor(crudoOriginal: Record<string, unknown>, carrilCrudo: string, carpeta: string, respaldoPorDefecto: string): PlanMotor {
  const carril = normalizarCarril(carrilCrudo);
  const crudo = structuredClone(crudoOriginal);
  const cambios: string[] = [];
  const d: Record<string, unknown> =
    typeof crudo.despachador === "object" && crudo.despachador !== null && !Array.isArray(crudo.despachador)
      ? (crudo.despachador as Record<string, unknown>)
      : {};
  if (crudo.despachador === undefined) cambios.push("despachador: creado");
  crudo.despachador = d;

  if (d.activo !== true) {
    d.activo = true;
    cambios.push("despachador.activo: true");
  }
  const carriles = Array.isArray(d.carriles) ? (d.carriles as unknown[]).map((x) => String(x).trim().toUpperCase()) : [];
  if (!carriles.includes(carril)) {
    carriles.push(carril);
    cambios.push(`despachador.carriles: + ${carril}`);
  }
  d.carriles = [...new Set(carriles)];

  const mapa: Record<string, string> = {};
  if (typeof d.carpetas_carriles === "object" && d.carpetas_carriles !== null && !Array.isArray(d.carpetas_carriles)) {
    for (const [k, v] of Object.entries(d.carpetas_carriles as Record<string, string>)) mapa[k.trim().toUpperCase()] = v;
  }
  if (!mapa[carril] || !mismaRuta(mapa[carril] as string, carpeta)) cambios.push(`despachador.carpetas_carriles.${carril}: ${carpeta}`);
  mapa[carril] = carpeta;
  d.carpetas_carriles = mapa;

  // El respaldo hereda el settings de su carpeta: nunca la de un carril (ni una que contenga a un carril).
  const actual = typeof d.carpeta_trabajo === "string" && d.carpeta_trabajo.trim() ? d.carpeta_trabajo : null;
  const deCarriles = Object.values(mapa);
  const choca = (r: string): boolean => deCarriles.some((c) => dentroDe(c, r) || dentroDe(r, c));
  let respaldo = actual ?? respaldoPorDefecto;
  if (actual === null || choca(actual)) {
    respaldo = respaldoPorDefecto;
    if (choca(respaldo)) throw new Error(`La carpeta de respaldo ${respaldo} coincide con la de un carril: elige otra carpeta para el carril.`);
    d.carpeta_trabajo = respaldo;
    cambios.push(`despachador.carpeta_trabajo: ${respaldo}${actual ? ` (antes ${actual}, que es o contiene la carpeta de un carril)` : ""}`);
  }
  if (d.chrome !== false) {
    d.chrome = false;
    cambios.push("despachador.chrome: false");
  }

  const permitidas = Array.isArray(crudo.carpetas_permitidas) ? [...(crudo.carpetas_permitidas as string[])] : [];
  for (const r of [carpeta, respaldo]) {
    if (!rutaPermitida(r, permitidas)) {
      permitidas.push(path.resolve(r));
      cambios.push(`carpetas_permitidas: + ${path.resolve(r)}`);
    }
  }
  crudo.carpetas_permitidas = permitidas;
  normalizarConfig(crudo); // valida antes de escribir
  return { crudo, cambios, respaldo };
}

/** motor.json sin el carril. No borra carpetas. Puro. */
export function planQuitarDeMotor(crudoOriginal: Record<string, unknown>, carril: string): { crudo: Record<string, unknown>; estaba: boolean } {
  const crudo = structuredClone(crudoOriginal);
  const d = crudo.despachador;
  if (typeof d !== "object" || d === null || Array.isArray(d)) return { crudo, estaba: false };
  const dd = d as Record<string, unknown>;
  const carriles = Array.isArray(dd.carriles) ? (dd.carriles as unknown[]).map((x) => String(x).trim().toUpperCase()) : [];
  const estaba = carriles.includes(carril);
  dd.carriles = carriles.filter((c) => c !== carril);
  if (typeof dd.carpetas_carriles === "object" && dd.carpetas_carriles !== null) {
    const m = { ...(dd.carpetas_carriles as Record<string, string>) };
    delete m[carril];
    dd.carpetas_carriles = m;
  }
  normalizarConfig(crudo);
  return { crudo, estaba };
}

function sello(ahora: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${ahora.getFullYear()}-${p(ahora.getMonth() + 1)}-${p(ahora.getDate())}-${p(ahora.getHours())}${p(ahora.getMinutes())}${p(ahora.getSeconds())}`;
}

/** Copia `archivo` a `archivo.respaldo-AAAA-MM-DD-HHMMSS` y devuelve la ruta (null si no existía). */
export function respaldar(archivo: string, ahora = new Date()): string | null {
  if (!fs.existsSync(archivo)) return null;
  let destino = `${archivo}.respaldo-${sello(ahora)}`;
  for (let i = 2; fs.existsSync(destino); i++) destino = `${archivo}.respaldo-${sello(ahora)}-${i}`;
  fs.copyFileSync(archivo, destino);
  return destino;
}

function escribirJson(archivo: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tmp = `${archivo}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, archivo);
}

function leerCrudo(): Record<string, unknown> {
  const ruta = rutaConfig();
  try {
    const j: unknown = JSON.parse(fs.readFileSync(ruta, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error();
    return j as Record<string, unknown>;
  } catch {
    throw new Error(`No pude leer ${ruta}: el JSON no es válido. No cambié nada.`);
  }
}

// ---------------------------------------------------------------- .claude/settings.json del carril

/** Una ruta absoluta en las dos formas que puede comparar Claude Code en Windows: //C:/x y //c/x. */
export function formasAbsolutas(ruta: string): string[] {
  const p = path.resolve(ruta).replace(/\\/g, "/").replace(/\/+$/, "");
  const m = /^([A-Za-z]):\/(.*)$/.exec(p);
  if (!m) return [`/${p}`];
  const unidad = m[1] as string;
  const resto = m[2] as string;
  return [`//${unidad.toUpperCase()}:/${resto}`, `//${unidad.toLowerCase()}/${resto}`];
}

function editarYEscribir(patron: string): string[] {
  return [`Edit(${patron})`, `Write(${patron})`];
}

export interface OpcSettings {
  /** null = settings de la carpeta del respaldo (sin latido). */
  carril: string | null;
  perfil: Perfil;
  node: string;
  cli: string;
  carpetaCarril: string;
  /** Carpeta de instalación del motor (la que tiene dist\ y node\). */
  carpetaMotor: string;
  /** %APPDATA%\AwkiOffice */
  carpetaDatos: string;
}

/**
 * El settings del carril. Freno = «ask por defecto»: `allow` lleva solo formas exactas e inofensivas; lo peligroso va
 * en `ask` o `deny`. El hook PreToolUse solo sube a allow el comando exacto que tiene una aprobación de THE TOWN IA.
 */
export function settingsCarril(o: OpcSettings): Record<string, unknown> {
  const allow = ["mcp__ttia__*", "Read", "Glob", "Grep", "Task", "Monitor", "TodoWrite", "Skill", "Edit", "Write",
    "Bash(git status)", "Bash(git diff)", "Bash(git log --oneline*)"];
  if (o.carril) {
    allow.push(`Bash(motor-local latido ${o.carril})`, `Bash("${o.node}" "${o.cli}" latido ${o.carril})`,
      `Bash("$TTIA_MOTOR_NODE" "$TTIA_MOTOR_CLI" latido ${o.carril})`);
  }
  const ask = ["Bash(git fetch*)", "Bash(git pull*)", "Bash(git commit*)", "Bash(git push*)", "Bash(gh pr create*)",
    "Bash(gh pr merge*)", "Bash(gh api*)", "Bash(*aplicar.py*--escribir*)", "Bash(*desplegar.py*)", "Bash(fastlane*)",
    "Bash(*youtube*)"];
  const deny = ["Bash(git push --force*)", "Bash(git push -f*)", "Bash(git reset --hard*)", "Bash(rm *)", "Bash(mv *)",
    "Bash(gh repo delete*)", "Bash(*--upload-pack*)", "Bash(*--receive-pack*)", "Bash(*--exec*)", "Bash(*--output*)",
    "Bash(*core.hooksPath*)", "Bash(*core.fsmonitor*)", "Bash(*core.sshCommand*)", "mcp__claude-in-chrome__*",
    ...editarYEscribir(".git/hooks/**"), ...editarYEscribir("//**/.git/hooks/**"),
    ...editarYEscribir(".git/config"), ...editarYEscribir("//**/.git/config"),
    ...editarYEscribir(".claude/settings*.json"), ...editarYEscribir("//**/.claude/settings*.json"),
    ...editarYEscribir("~/.gitconfig"), ...editarYEscribir("~/.claude/**")];
  for (const r of [path.join(o.carpetaCarril, ".claude"), o.carpetaMotor, o.carpetaDatos]) {
    for (const f of formasAbsolutas(r)) deny.push(...editarYEscribir(`${f}/**`));
  }
  const s: Record<string, unknown> = {
    "//": `${o.carril ? `Carril ${o.carril}` : "Respaldo del despachador"} de THE TOWN IA, perfil ${o.perfil}. Lo escribió ` +
      "`motor-local carril instalar`. Freno = ask por defecto: allow solo lleva formas exactas e inofensivas; lo peligroso va " +
      "en ask o deny. El hook gasta la aprobación de THE TOWN IA del comando exacto. Para cambiarlo: edítalo a mano o vuelve " +
      "a correr carril instalar con --forzar (respalda el anterior).",
  };
  if (o.perfil === "apdayc") {
    ask.push("Bash(gh issue*)", "Bash(sqlcmd*)", "Bash(*graph*send*)", "Bash(*Send-MailMessage*)", "PowerShell");
    deny.push("Bash(*192.168.252.147*)", "Read(//192.168.252.147/**)", "Edit(//192.168.252.147/**)", "Write(//192.168.252.147/**)");
    s["//perfil"] = "apdayc: SQL, issues, envío de correo y PowerShell piden permiso; el servidor 192.168.252.147 es de solo lectura y aquí ni se lee.";
  }
  if (o.perfil === "juegos") {
    s["//por_completar"] = "Agrega a allow los comandos de prueba EXACTOS de cada juego, por ejemplo " +
      "\"Bash(godot --headless --path C:/ruta/del/juego -s res://tests/correr.gd)\". Sin eso, la sesión pide permiso cada vez " +
      "que corre pruebas. Nada de comodines que dejen pasar opciones.";
  }
  s.permissions = { allow, ask, deny };
  const env: Record<string, string> = { TTIA_MOTOR_NODE: o.node, TTIA_MOTOR_CLI: o.cli };
  if (o.carril) env.TTIA_CARRIL = o.carril;
  s.env = env;
  s.hooks = hooksAprobacion(o.node, o.cli);
  return s;
}

export type ResultadoSettings = "escrito" | "reemplazado" | "igual" | "existe";

/** Escribe el settings. Si ya existe y es distinto: solo con `forzar` (y respaldando el anterior). */
export function escribirSettings(carpeta: string, s: Record<string, unknown>, forzar: boolean, ahora = new Date()): { resultado: ResultadoSettings; respaldo: string | null; archivo: string } {
  const archivo = path.join(carpeta, ".claude", "settings.json");
  const texto = JSON.stringify(s, null, 2) + "\n";
  if (fs.existsSync(archivo)) {
    if (fs.readFileSync(archivo, "utf8") === texto) return { resultado: "igual", respaldo: null, archivo };
    if (!forzar) return { resultado: "existe", respaldo: null, archivo };
    const respaldo = respaldar(archivo, ahora);
    escribirJson(archivo, s);
    return { resultado: "reemplazado", respaldo, archivo };
  }
  escribirJson(archivo, s);
  return { resultado: "escrito", respaldo: null, archivo };
}

/** El ejecutable del hook que trae un settings (para avisar si apunta a un motor que ya no está). */
export function hookDeSettings(archivo: string): { hay: boolean; node: string | null } {
  try {
    const s = JSON.parse(fs.readFileSync(archivo, "utf8")) as { hooks?: { PreToolUse?: Array<{ hooks?: Array<{ command?: unknown }> }> } };
    for (const g of s.hooks?.PreToolUse ?? []) {
      for (const h of g.hooks ?? []) {
        if (typeof h.command === "string" && /hook aprobacion/.test(h.command)) {
          const m = /^"([^"]+)"/.exec(h.command);
          return { hay: true, node: m ? (m[1] as string) : null };
        }
      }
    }
  } catch {
    /* sin settings o ilegible */
  }
  return { hay: false, node: null };
}

// ---------------------------------------------------------------- token

export type EstadoToken = "valido" | "rechazado" | "error";

export const FORMATO_TOKEN = /^ttia_pat_[A-Za-z0-9_-]{8,200}$/;

/** Una llamada de solo lectura (`tools/list`) al MCP de THE TOWN IA con el token. 401/403 = rechazado. */
export async function validarToken(url: string, token: string, f: typeof fetch = fetch, timeoutMs = 15_000): Promise<{ estado: EstadoToken; detalle: string }> {
  let resp: Response;
  try {
    resp = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (e) {
    return { estado: "error", detalle: `sin respuesta de ${url} (${e instanceof Error ? e.name : "error"})` };
  }
  const cuerpo = await resp.text().catch(() => "");
  if (resp.status === 401 || resp.status === 403) return { estado: "rechazado", detalle: `HTTP ${resp.status}` };
  if (!resp.ok) return { estado: "error", detalle: `HTTP ${resp.status}` };
  try {
    const rpc = parsearRespuestaMcp(resp.headers.get("content-type") ?? "", cuerpo);
    if (rpc.error) return { estado: "error", detalle: "el MCP respondió un error a tools/list" };
    return { estado: "valido", detalle: "ok" };
  } catch {
    return { estado: "error", detalle: "respuesta no reconocida" };
  }
}

// ---------------------------------------------------------------- MCP `ttia` de Claude Code

export function rutaClaudeJson(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home, ".claude.json");
}

export type EstadoMcp = "igual" | "distinto" | "falta" | "ilegible";

/** Compara el MCP `ttia` (scope user) de Claude Code con el token. Solo lee; no devuelve el token. Avisa si la carpeta
 *  del carril tiene su propio `ttia` (scope local), que le ganaría al de usuario. */
export function estadoMcpClaude(archivo: string, token: string | null, carpetaCarril?: string): { estado: EstadoMcp; local: boolean } {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(fs.readFileSync(archivo, "utf8")) as Record<string, unknown>;
  } catch (e) {
    return { estado: (e as NodeJS.ErrnoException).code === "ENOENT" ? "falta" : "ilegible", local: false };
  }
  let local = false;
  if (carpetaCarril && j.projects && typeof j.projects === "object") {
    for (const [k, v] of Object.entries(j.projects as Record<string, unknown>)) {
      if (mismaRuta(k, carpetaCarril) && v && typeof v === "object" && (v as Record<string, unknown>).mcpServers &&
          typeof (v as Record<string, Record<string, unknown>>).mcpServers === "object" &&
          "ttia" in ((v as Record<string, Record<string, unknown>>).mcpServers as Record<string, unknown>)) local = true;
    }
  }
  const s = (j.mcpServers as Record<string, unknown> | undefined)?.ttia as { headers?: Record<string, unknown> } | undefined;
  if (!s) return { estado: "falta", local };
  const h = s.headers ?? {};
  const auth = Object.entries(h).find(([k]) => k.toLowerCase() === "authorization")?.[1];
  return { estado: token && auth === `Bearer ${token}` ? "igual" : "distinto", local };
}

export function jsonMcp(url: string, token: string): string {
  return JSON.stringify({ type: "http", url, headers: { Authorization: `Bearer ${token}` } });
}

/** Corre un comando con `entrada` por stdin y junta su salida. */
export type Correr = (exe: string, args: string[], entrada: string) => Promise<{ codigo: number | null; salida: string }>;

const WINDOWS = process.platform === "win32";

export const correrConEntrada: Correr = (exe, args, entrada) =>
  new Promise((resolve) => {
    const shell = WINDOWS && !/\.exe$/i.test(exe);
    if (shell && !/^[\w .:\\/()-]+$/.test(exe)) return resolve({ codigo: null, salida: "ruta de claude con caracteres no permitidos" });
    let salida = "";
    let p;
    try {
      // args fijos y sin metacaracteres: seguros también por shell. El token va SOLO por stdin.
      p = spawn(shell ? `"${exe}"` : exe, args, { shell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ codigo: null, salida: e instanceof Error ? e.message : "no pude lanzar claude" });
    }
    const t = setTimeout(() => p.kill(), 60_000);
    p.stdout?.on("data", (d: Buffer) => (salida += d.toString("utf8")));
    p.stderr?.on("data", (d: Buffer) => (salida += d.toString("utf8")));
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ codigo: null, salida: e.message });
    });
    p.on("close", (codigo) => {
      clearTimeout(t);
      resolve({ codigo, salida: salida.slice(0, 2000) });
    });
    p.stdin?.on("error", () => {});
    p.stdin?.end(entrada);
  });

/** Quita el token de cualquier texto antes de mostrarlo. */
export function ocultar(texto: string, token: string | null): string {
  return token ? texto.split(token).join("***") : texto;
}

/** Registra (o reemplaza) el MCP `ttia` en Claude Code, scope user, con el token por stdin. Primero intenta agregar;
 *  solo si ya existe lo quita y lo vuelve a agregar (así un fallo de `add` no deja a la PC sin MCP). */
export async function registrarMcp(claude: string, url: string, token: string, correr: Correr = correrConEntrada): Promise<{ ok: boolean; detalle: string }> {
  const agregar = (): Promise<{ codigo: number | null; salida: string }> => correr(claude, ["mcp", "add-json", "ttia", "-", "--scope", "user"], jsonMcp(url, token));
  let r = await agregar();
  if (r.codigo !== 0 && /already exists|ya existe/i.test(r.salida)) {
    const q = await correr(claude, ["mcp", "remove", "ttia", "--scope", "user"], "");
    if (q.codigo !== 0) return { ok: false, detalle: ocultar(q.salida.trim().split(/\r?\n/)[0] ?? "", token) };
    r = await agregar();
  }
  return { ok: r.codigo === 0, detalle: ocultar(r.salida.trim().split(/\r?\n/)[0] ?? "", token) };
}

// ---------------------------------------------------------------- carpeta de un carril ya instalado

export function carpetaDeCarril(cfg: ConfigMotor, carril: string, home = os.homedir()): { ruta: string; origen: "motor.json" | "deducida" | "por defecto" } {
  const registrada = cfg.despachador.carpetas_carriles[carril];
  if (registrada) return { ruta: registrada, origen: "motor.json" };
  // Carriles armados a mano antes de la 0.7: junto a la carpeta del respaldo, con su settings.
  const ct = cfg.despachador.carpeta_trabajo;
  const candidata = ct ? path.join(path.dirname(path.resolve(ct)), carril) : null;
  if (candidata && fs.existsSync(path.join(candidata, ".claude", "settings.json"))) return { ruta: candidata, origen: "deducida" };
  return { ruta: carpetaCarrilPorDefecto(carril, home), origen: "por defecto" };
}

// ---------------------------------------------------------------- abrir

const NOMBRE_SESION = /^[\p{L}\p{N} _.()-]{1,60}$/u;

export function argsAbrir(carril: string, nombre: string): string[] {
  if (!NOMBRE_SESION.test(nombre)) throw new Error("El nombre de la sesión solo admite letras, números, espacios, punto, guion y paréntesis (hasta 60).");
  return ["--name", nombre, "--remote-control", nombre, PROMPT_CARRIL(carril)];
}

/** Para mostrarlo (o correrlo por cmd): cada argumento entre comillas dobles. */
export function lineaComando(exe: string, args: string[]): string {
  return [exe, ...args].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(" ");
}

/** Lanza Claude Code interactivo en la carpeta del carril. Devuelve su código de salida. */
export function lanzarInteractivo(claude: string, args: string[], cwd: string): Promise<number> {
  if (!/^[\w .:\\/()-]+$/.test(claude)) return Promise.resolve(1);
  return new Promise((resolve) => {
    const intentar = (shell: boolean): void => {
      // Por shell (claude.cmd): los argumentos ya están validados (sin comillas, %, ^, &, | ni < >).
      const p = shell
        ? spawn(lineaComando(claude, args), { cwd, shell: true, stdio: "inherit" })
        : spawn(claude, args, { cwd, stdio: "inherit" });
      p.on("error", (e: NodeJS.ErrnoException) => {
        if (!shell && WINDOWS && e.code === "ENOENT") return intentar(true); // claude.cmd (instalación por npm)
        console.error(`No pude abrir Claude Code: ${e.message}`);
        resolve(1);
      });
      p.on("close", (c) => resolve(c ?? 1));
    };
    intentar(false);
  });
}

// ---------------------------------------------------------------- instalar

export interface AlmacenToken {
  obtener(): string | null;
  guardar(t: string): void;
}

export interface DepsInstalar {
  almacen: AlmacenToken;
  pedir: (pregunta: string) => Promise<string>;
  fetch?: typeof fetch;
  correr?: Correr;
  claudeJson: string;
  home: string;
  node: string;
  cli: string;
  salida: (linea: string) => void;
  ahora?: () => Date;
}

export interface OpcInstalar {
  carril: string;
  carpeta?: string;
  perfil: Perfil;
  tokenNuevo: boolean;
  forzar: boolean;
}

export interface ResultadoInstalar {
  ok: boolean;
  carpeta: string;
  respaldo: string | null;
  mcpPendiente: boolean;
}

const PREGUNTA_TOKEN = "Pega tu token de THE TOWN IA (Mi PC > Claude Code; no se mostrará): ";

/**
 * Hace todo el alta de un carril. Si el token no sirve, termina ANTES de tocar nada. Nunca imprime el token.
 */
export async function instalarCarril(o: OpcInstalar, deps: DepsInstalar): Promise<ResultadoInstalar> {
  const out = deps.salida;
  const ahora = deps.ahora ?? (() => new Date());
  const carril = normalizarCarril(o.carril);
  const carpeta = validarCarpetaCarril(o.carpeta ?? carpetaCarrilPorDefecto(carril, deps.home), deps.home);
  const falla: ResultadoInstalar = { ok: false, carpeta, respaldo: null, mcpPendiente: true };

  crearConfigSiFalta();
  const crudoInicial = leerCrudo();
  const cfg = normalizarConfig(crudoInicial);
  const url = cfg.despachador.url_mcp;

  // 1. Token: uno solo para el motor y para Claude Code, validado antes de guardarlo.
  let token = o.tokenNuevo ? null : deps.almacen.obtener();
  let nuevo = false;
  for (let intento = 0; intento < 2; intento++) {
    if (!token) {
      token = (await deps.pedir(PREGUNTA_TOKEN)).trim();
      nuevo = true;
      if (!FORMATO_TOKEN.test(token)) {
        out('Ese token no parece válido (empieza con "ttia_pat_"). Cópialo de nuevo desde THE TOWN IA, Mi PC > Claude Code. No cambié nada.');
        return falla;
      }
    }
    const v = await validarToken(url, token, deps.fetch);
    if (v.estado === "valido") break;
    if (v.estado === "error") {
      out(`No pude comprobar el token contra ${url} (${v.detalle}). Revisa la conexión y vuelve a intentar. No cambié nada.`);
      return falla;
    }
    if (nuevo) {
      out(MENSAJE_TOKEN_RECHAZADO + " No cambié nada.");
      return falla;
    }
    out("El token guardado en esta PC fue rechazado (revocado o vencido): pega uno nuevo.");
    token = null;
  }
  if (!token) return falla;
  if (nuevo) {
    deps.almacen.guardar(token);
    out("Token: válido; guardado en el Administrador de credenciales de Windows.");
  } else {
    out("Token: el guardado en esta PC es válido.");
  }

  // 2. MCP `ttia` de Claude Code con el mismo token.
  let mcpPendiente = false;
  const m = estadoMcpClaude(deps.claudeJson, token, carpeta);
  if (m.estado === "igual") {
    out("MCP ttia de Claude Code: ya tiene este mismo token.");
  } else {
    const r = await registrarMcp(cfg.despachador.claude, url, token, deps.correr);
    if (r.ok) out(`MCP ttia de Claude Code: ${m.estado === "falta" ? "registrado" : "reemplazado (tenía otro token)"} (scope user).`);
    else {
      mcpPendiente = true;
      out(`AVISO: no pude registrar el MCP ttia en Claude Code (${r.detalle || "sin detalle"}). Si estás dentro de una sesión de ` +
        "Claude Code, cierra y corre este mismo comando desde una terminal normal: el resto ya queda hecho y no se repite.");
    }
  }
  if (m.local) out(`AVISO: la carpeta ${carpeta} tiene su propio MCP ttia (scope local) que le gana al de usuario. Quítalo con: claude mcp remove ttia --scope local (dentro de esa carpeta).`);

  // 3. Carpetas.
  fs.mkdirSync(carpeta, { recursive: true });

  // 4. motor.json (con respaldo).
  const plan = planInstalarEnMotor(crudoInicial, carril, carpeta, carpetaRespaldoPorDefecto(carpeta));
  fs.mkdirSync(plan.respaldo, { recursive: true });
  if (plan.cambios.length) {
    const r = respaldar(rutaConfig(), ahora());
    escribirJson(rutaConfig(), plan.crudo);
    out(`motor.json: ${plan.cambios.length} cambio(s)${r ? ` (respaldo en ${r})` : ""}:`);
    for (const c of plan.cambios) out(`  - ${c}`);
  } else {
    out("motor.json: ya tenía este carril tal cual.");
  }

  // 5. Settings del carril y del respaldo.
  const carpetaMotor = path.resolve(path.dirname(deps.cli), "..");
  const base = { perfil: o.perfil, node: deps.node, cli: deps.cli, carpetaMotor, carpetaDatos: carpetaDatos() };
  const sc = escribirSettings(carpeta, settingsCarril({ ...base, carril, carpetaCarril: carpeta }), o.forzar, ahora());
  const textos: Record<ResultadoSettings, string> = {
    escrito: "creado",
    reemplazado: `reemplazado (respaldo en ${sc.respaldo})`,
    igual: "ya estaba igual",
    existe: "ya existe y es distinto: NO lo toqué (usa --forzar para reemplazarlo; se respalda el anterior)",
  };
  out(`Settings del carril (${sc.archivo}): ${textos[sc.resultado]}.`);
  // El settings del respaldo solo se escribe en la carpeta `_respaldo` que crea este comando; en una carpeta que eligió
  // la persona no se escribe nada: solo se avisa si le falta.
  if (mismaRuta(plan.respaldo, carpetaRespaldoPorDefecto(carpeta))) {
    const sr = escribirSettings(plan.respaldo, settingsCarril({ ...base, perfil: "generico", carril: null, carpetaCarril: plan.respaldo }), false, ahora());
    if (sr.resultado === "escrito") out(`Settings del respaldo (${sr.archivo}): creado (sin push, merge ni subidas en allow).`);
  } else if (!fs.existsSync(path.join(plan.respaldo, ".claude", "settings.json"))) {
    out(`Nota: la carpeta del respaldo (${plan.respaldo}) no tiene .claude\\settings.json. No la toqué: es tuya. El respaldo corre ` +
      "con claude -p y las herramientas de despachador.herramientas_permitidas (sin Bash por defecto).");
  }

  return { ok: true, carpeta, respaldo: plan.respaldo, mcpPendiente };
}

/** Quita el carril de motor.json (con respaldo). No borra carpetas. */
export function quitarCarril(carrilCrudo: string, ahora = new Date()): { estaba: boolean; respaldo: string | null } {
  const carril = normalizarCarril(carrilCrudo);
  crearConfigSiFalta();
  const { crudo, estaba } = planQuitarDeMotor(leerCrudo(), carril);
  if (!estaba) return { estaba, respaldo: null };
  const respaldo = respaldar(rutaConfig(), ahora);
  escribirJson(rutaConfig(), crudo);
  return { estaba, respaldo };
}

/** ¿Hay un motor escuchando en 127.0.0.1:<puerto>? (Responde 426 a un GET: lo que cuenta es que responda.) */
export async function motorCorriendo(puerto: number, f: typeof fetch = fetch): Promise<boolean> {
  try {
    await f(`http://127.0.0.1:${puerto}/`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}
