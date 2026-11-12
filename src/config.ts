import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ConfigMotor {
  carpetas_permitidas: string[];
  origenes: string[];
  modelo: string;
  puerto: number;
  /** Workspace de Anthropic (header anthropic-workspace-id). null = sin workspace (o el de ANTHROPIC_WORKSPACE_ID). */
  workspace: string | null;
}

export const MODELO_POR_DEFECTO = "claude-sonnet-5-5";
export const PUERTO_POR_DEFECTO = 47821;

/** La web publicada de THE TOWN IA y la de desarrollo. Otros origenes se agregan en "origenes" de motor.json. */
export const ORIGEN_PRODUCCION = "https://ttia.awki.ai";
const PLACEHOLDER_V01 = "https://REEMPLAZAR-DOMINIO-PRODUCCION.example";
export const ORIGENES_POR_DEFECTO = ["http://localhost:8765", "http://127.0.0.1:8765", ORIGEN_PRODUCCION];

/** Un id de workspace solo lleva letras, numeros, guion y guion bajo: nada de saltos de linea (inyeccion de headers). */
const WORKSPACE_VALIDO = /^[A-Za-z0-9_-]{1,128}$/;

export function workspaceValido(v: unknown): v is string {
  return typeof v === "string" && WORKSPACE_VALIDO.test(v);
}

/** Origen de una pagina: esquema + host (+ puerto), sin ruta ni barra final. */
const ORIGEN_VALIDO = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$|^http:\/\/\[::1\](:\d{1,5})?$/;

/**
 * Workspace efectivo: el de motor.json y, si no hay, la variable ANTHROPIC_WORKSPACE_ID. Lanza si el valor es invalido.
 */
export function workspaceEfectivo(cfg: ConfigMotor, env: NodeJS.ProcessEnv = process.env): string | null {
  if (cfg.workspace) return cfg.workspace;
  const v = env.ANTHROPIC_WORKSPACE_ID;
  if (v === undefined || v === "") return null;
  if (!workspaceValido(v)) throw new Error("ANTHROPIC_WORKSPACE_ID no es un id de workspace valido.");
  return v;
}

/** Carpeta de datos del motor. `AWKI_OFFICE_DIR` permite cambiarla (tests). */
export function carpetaDatos(): string {
  if (process.env.AWKI_OFFICE_DIR) return process.env.AWKI_OFFICE_DIR;
  const base = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(base, "AwkiOffice");
}

export function rutaConfig(): string {
  return path.join(carpetaDatos(), "motor.json");
}

export function configPorDefecto(): ConfigMotor {
  return {
    carpetas_permitidas: [],
    origenes: [...ORIGENES_POR_DEFECTO],
    modelo: MODELO_POR_DEFECTO,
    puerto: PUERTO_POR_DEFECTO,
    workspace: null,
  };
}

/** Valida y completa lo leido del JSON. Lanza Error con mensaje en espanol si algo esta mal. */
export function normalizarConfig(crudo: unknown): ConfigMotor {
  const def = configPorDefecto();
  if (crudo === null || typeof crudo !== "object") throw new Error("motor.json debe ser un objeto JSON.");
  const c = crudo as Record<string, unknown>;
  const lista = (v: unknown, nombre: string, por: string[]): string[] => {
    if (v === undefined) return por;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      throw new Error(`motor.json: "${nombre}" debe ser una lista de textos.`);
    }
    return v as string[];
  };
  const puerto = c.puerto === undefined ? def.puerto : c.puerto;
  if (typeof puerto !== "number" || !Number.isInteger(puerto) || puerto < 1024 || puerto > 65535) {
    throw new Error('motor.json: "puerto" debe ser un entero entre 1024 y 65535.');
  }
  const modelo = c.modelo === undefined ? def.modelo : c.modelo;
  if (typeof modelo !== "string" || modelo.trim() === "") throw new Error('motor.json: "modelo" debe ser un texto.');
  const workspace = c.workspace === undefined || c.workspace === null || c.workspace === "" ? null : c.workspace;
  if (workspace !== null && !workspaceValido(workspace)) {
    throw new Error('motor.json: "workspace" solo admite letras, numeros, "-" y "_" (es el id del workspace de Anthropic).');
  }
  // El motor.json de la v0.1 traia un placeholder en lugar del dominio de produccion: se cambia por el real.
  const origenes = lista(c.origenes, "origenes", def.origenes).map((o) => (o === PLACEHOLDER_V01 ? ORIGEN_PRODUCCION : o));
  for (const o of origenes) {
    if (!ORIGEN_VALIDO.test(o)) {
      throw new Error(`motor.json: el origen "${o}" no es valido. Usa la forma https://dominio (sin ruta ni barra final).`);
    }
  }
  return {
    carpetas_permitidas: lista(c.carpetas_permitidas, "carpetas_permitidas", def.carpetas_permitidas),
    origenes,
    modelo,
    puerto,
    workspace,
  };
}

export function cargarConfig(): ConfigMotor {
  const ruta = rutaConfig();
  if (!fs.existsSync(ruta)) return configPorDefecto();
  let crudo: unknown;
  try {
    crudo = JSON.parse(fs.readFileSync(ruta, "utf8"));
  } catch {
    throw new Error(`No se pudo leer ${ruta}: el JSON no es valido.`);
  }
  return normalizarConfig(crudo);
}

/** Misma carpeta en Windows: sin distinguir mayusculas ni barra final. */
function mismaCarpeta(a: string, b: string): boolean {
  const n = (x: string) => path.resolve(x).replace(/[\\/]+$/, "").toLowerCase();
  return n(a) === n(b);
}

/**
 * Lista nueva de carpetas permitidas con `ruta` agregada (o quitada). Al agregar verifica que la carpeta exista.
 * Lanza Error con mensaje en espanol si la ruta no sirve.
 */
export function cambiarCarpetas(lista: string[], ruta: string, accion: "agregar" | "quitar"): string[] {
  if (!ruta || !path.isAbsolute(ruta)) {
    throw new Error("Indica la ruta completa de la carpeta (por ejemplo C:\\Users\\Ana\\Documentos).");
  }
  if (accion === "quitar") return lista.filter((c) => !mismaCarpeta(c, ruta));
  const abs = path.resolve(ruta);
  if (path.parse(abs).root.toLowerCase() === abs.toLowerCase()) {
    throw new Error(`No puedes dar acceso a un disco entero (${abs}). Elige una carpeta dentro.`);
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`No existe la carpeta ${abs}.`);
  if (lista.some((c) => mismaCarpeta(c, abs))) return lista;
  return [...lista, abs];
}

/** Agrega o quita una carpeta permitida en motor.json, conservando el resto del archivo. Devuelve la lista final. */
export function guardarCarpeta(ruta: string, accion: "agregar" | "quitar"): string[] {
  crearConfigSiFalta();
  const archivo = rutaConfig();
  const crudo = JSON.parse(fs.readFileSync(archivo, "utf8")) as Record<string, unknown>;
  const nueva = cambiarCarpetas(normalizarConfig(crudo).carpetas_permitidas, ruta, accion);
  crudo.carpetas_permitidas = nueva;
  fs.writeFileSync(archivo, JSON.stringify(crudo, null, 2) + "\n", "utf8");
  return nueva;
}

/** Crea motor.json con los valores por defecto si no existe. Devuelve true si lo creo. */
export function crearConfigSiFalta(): boolean {
  const ruta = rutaConfig();
  if (fs.existsSync(ruta)) return false;
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, JSON.stringify(configPorDefecto(), null, 2) + "\n", "utf8");
  return true;
}
