import fs from "node:fs";
import path from "node:path";
import { carpetaDatos } from "./config.js";

/**
 * Log local. Nunca recibe prompts completos ni claves: quien llama pasa solo metadatos.
 * Como defensa extra, cualquier cosa con forma de API key o token se tacha antes de escribir.
 */
export function tachar(texto: string): string {
  return texto
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-***")
    .replace(/"(token|secreto|clave|codigo)":\s*"[^"]*"/gi, '"$1":"***"');
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export function crearLogger(carpeta = path.join(carpetaDatos(), "logs"), consola = true): Logger {
  try {
    fs.mkdirSync(carpeta, { recursive: true });
  } catch {
    /* sin log en disco, solo consola */
  }
  const escribir = (nivel: string, msg: string, meta?: Record<string, unknown>): void => {
    const ahora = new Date();
    const linea = tachar(`${ahora.toISOString()} ${nivel} ${msg}${meta ? " " + JSON.stringify(meta) : ""}`);
    if (consola) console.log(linea);
    try {
      const dia = ahora.toISOString().slice(0, 10);
      fs.appendFileSync(path.join(carpeta, `motor-${dia}.log`), linea + "\n", "utf8");
    } catch {
      /* ignorar */
    }
  };
  return {
    info: (m, meta) => escribir("INFO", m, meta),
    error: (m, meta) => escribir("ERROR", m, meta),
  };
}

export const loggerSilencioso: Logger = { info() {}, error() {} };
