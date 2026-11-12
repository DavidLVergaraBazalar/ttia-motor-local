import fs from "node:fs";
import path from "node:path";

const WINDOWS = process.platform === "win32";

function normalizarCaso(p: string): string {
  return WINDOWS ? p.toLowerCase() : p;
}

/**
 * Resuelve una ruta a su forma real: absoluta, sin `..` y con los symlinks/junctions
 * resueltos. Si la ruta aun no existe (un archivo nuevo), resuelve el ancestro existente
 * mas cercano y le vuelve a pegar el resto.
 */
export function resolverReal(ruta: string, base?: string): string {
  const abs = path.resolve(base ?? process.cwd(), ruta);
  let actual = abs;
  const resto: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(actual);
      return resto.length ? path.join(real, ...resto.reverse()) : real;
    } catch {
      const padre = path.dirname(actual);
      if (padre === actual) return abs;
      resto.push(path.basename(actual));
      actual = padre;
    }
  }
}

/** true si `ruta` (resuelta contra `base`) cae dentro de alguna de las carpetas permitidas. */
export function rutaPermitida(ruta: string, carpetas: string[], base?: string): boolean {
  if (carpetas.length === 0) return false;
  if (ruta.includes("\0")) return false;
  const objetivo = normalizarCaso(resolverReal(ruta, base));
  for (const c of carpetas) {
    const carpeta = normalizarCaso(resolverReal(c));
    const rel = path.relative(carpeta, objetivo);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true;
  }
  return false;
}
