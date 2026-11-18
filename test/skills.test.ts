import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { carpetaSkillsOrigen, esSkillTtia, instalarSkills, listarSkillsOrigen } from "../src/skills.js";
import { carpetaTemporal } from "./ayuda.js";

describe("skills publicas", () => {
  const tmp = carpetaTemporal();
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("el repo trae las tres skills, con name, description y el marcador ttia: true", () => {
    const lista = listarSkillsOrigen();
    assert.deepEqual(lista, ["carril-ttia", "conectar-google-empresa", "conectar-microsoft-empresa"]);
    for (const nombre of lista) {
      const texto = fs.readFileSync(path.join(carpetaSkillsOrigen(), nombre, "SKILL.md"), "utf8");
      assert.match(texto, new RegExp(`^---\\r?\\nname: ${nombre}\\r?\\n`));
      assert.match(texto, /\ndescription: .{40,}/);
      assert.ok(esSkillTtia(path.join(carpetaSkillsOrigen(), nombre, "SKILL.md")), nombre);
    }
  });

  it("las skills no llevan datos personales ni secretos", () => {
    for (const nombre of listarSkillsOrigen()) {
      const texto = fs.readFileSync(path.join(carpetaSkillsOrigen(), nombre, "SKILL.md"), "utf8");
      assert.ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(texto), "sin correos");
      assert.ok(!/[A-Za-z]:\\Users\\/.test(texto), "sin rutas de usuario");
      assert.ok(!/ttia_pat_[A-Za-z0-9]/.test(texto), "sin tokens");
      if (nombre.startsWith("conectar-")) {
        assert.match(texto, /guardar_en_boveda/);
        assert.match(texto, /Nunca escribas una contraseña/);
      }
    }
  });

  it("carril-ttia es pública: sin rutas, empresas ni personas, y con la frase de arranque que usa carril abrir", () => {
    const texto = fs.readFileSync(path.join(carpetaSkillsOrigen(), "carril-ttia", "SKILL.md"), "utf8");
    assert.ok(!/[A-Za-z]:[\\/]/.test(texto), "sin rutas de disco");
    assert.ok(!/APDAYC|AWKI|Dohaery|JUEGOS|David|Bruno|192\.168\./.test(texto), "sin empresas, personas ni IPs");
    assert.match(texto, /Eres la sesión del carril <CARRIL>: sigue la skill carril-ttia\./);
    assert.match(texto, /TTIA_MOTOR_NODE/);
    assert.match(texto, /Nunca llamar `gastar_aprobacion`/);
  });

  it("instala, actualiza las nuestras y NO pisa una skill ajena del mismo nombre", () => {
    const destino = path.join(tmp, "destino");
    const r1 = instalarSkills(carpetaSkillsOrigen(), destino);
    assert.deepEqual(r1.map((x) => x.estado), ["instalada", "instalada", "instalada"]);
    assert.ok(fs.existsSync(path.join(destino, "conectar-google-empresa", "SKILL.md")));

    const r2 = instalarSkills(carpetaSkillsOrigen(), destino);
    assert.deepEqual(r2.map((x) => x.estado), ["actualizada", "actualizada", "actualizada"]);

    const ajena = path.join(destino, "conectar-microsoft-empresa", "SKILL.md");
    fs.writeFileSync(ajena, "---\nname: conectar-microsoft-empresa\ndescription: mia\n---\nMI-VERSION\n");
    const r3 = instalarSkills(carpetaSkillsOrigen(), destino);
    assert.equal(r3.find((x) => x.nombre === "conectar-microsoft-empresa")?.estado, "saltada");
    assert.match(fs.readFileSync(ajena, "utf8"), /MI-VERSION/);
  });
});
