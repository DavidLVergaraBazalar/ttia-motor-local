import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Skills publicas del motor (carpeta `skills/` del repo). Se copian a `~/.claude/skills`.
 * Una skill nuestra lleva `ttia: true` en el frontmatter: solo esas se pueden reemplazar al actualizar.
 * Si ya existe una skill del mismo nombre que NO es nuestra, se salta y se avisa: nunca se pisa.
 */

const NOMBRE_VALIDO = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `skills/` junto a `src/` o `dist/` (tambien en el paquete del instalador). */
export function carpetaSkillsOrigen(): string {
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(aqui, "..", "skills");
}

export function carpetaSkillsUsuario(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

function frontmatter(texto: string): string {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(texto);
  return m?.[1] ?? "";
}

export function esSkillTtia(archivoSkill: string): boolean {
  try {
    return /^ttia:\s*true\s*$/m.test(frontmatter(fs.readFileSync(archivoSkill, "utf8")));
  } catch {
    return false;
  }
}

export interface ResultadoSkill {
  nombre: string;
  estado: "instalada" | "actualizada" | "saltada";
  motivo?: string;
}

export function listarSkillsOrigen(origen = carpetaSkillsOrigen()): string[] {
  try {
    return fs
      .readdirSync(origen, { withFileTypes: true })
      .filter((d) => d.isDirectory() && NOMBRE_VALIDO.test(d.name) && fs.existsSync(path.join(origen, d.name, "SKILL.md")))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export function instalarSkills(origen = carpetaSkillsOrigen(), destino = carpetaSkillsUsuario()): ResultadoSkill[] {
  const resultado: ResultadoSkill[] = [];
  for (const nombre of listarSkillsOrigen(origen)) {
    const desde = path.join(origen, nombre);
    const hasta = path.join(destino, nombre);
    const existe = fs.existsSync(hasta);
    if (existe && !esSkillTtia(path.join(hasta, "SKILL.md"))) {
      resultado.push({ nombre, estado: "saltada", motivo: "ya existe una skill con ese nombre que no es de THE TOWN IA (no se toco)" });
      continue;
    }
    fs.mkdirSync(destino, { recursive: true });
    fs.cpSync(desde, hasta, { recursive: true, force: true });
    resultado.push({ nombre, estado: existe ? "actualizada" : "instalada" });
  }
  return resultado;
}
