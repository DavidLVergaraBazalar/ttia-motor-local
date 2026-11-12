import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { cambiarCarpetas, type ConfigMotor } from "../src/config.js";
import { arrancar, carpetaTemporal, emparejado } from "./ayuda.js";

/** Motor de prueba con un «dialogo» falso y un cambiarCarpeta que edita la config en memoria. */
async function motorConDialogo(eleccion: () => Promise<string | null>, inicial: string[] = []) {
  let cfg: ConfigMotor | null = null;
  let llamadas = 0;
  const m = await arrancar({
    carpetas: inicial,
    elegirCarpeta: () => { llamadas++; return eleccion(); },
    cambiarCarpeta: (ruta, accion) => {
      cfg!.carpetas_permitidas = cambiarCarpetas(cfg!.carpetas_permitidas, ruta, accion);
      return cfg!.carpetas_permitidas;
    },
  });
  cfg = m.config;
  const { c, token } = await emparejado(m.puerto, m.emparejamiento.codigoActual);
  return { ...m, c, token, llamadas: () => llamadas };
}

describe("carpetas desde la web (v0.4)", () => {
  it("carpeta_elegir abre el dialogo y agrega la carpeta que eligio la persona", async () => {
    const elegida = carpetaTemporal();
    const m = await motorConDialogo(async () => elegida);
    m.c.enviar({ tipo: "carpeta_elegir", token: m.token });
    const r = await m.c.esperar((x) => x.tipo === "carpetas");
    assert.equal(r.agregada, elegida);
    assert.deepEqual(r.carpetas, [path.resolve(elegida)]);
    assert.deepEqual(m.config.carpetas_permitidas, [path.resolve(elegida)]);
    m.c.cerrar(); await m.servidor.detener();
  });

  it("la web no puede colar una ruta: carpeta_elegir ignora cualquier ruta que venga en el mensaje", async () => {
    const elegida = carpetaTemporal(), colada = carpetaTemporal();
    const m = await motorConDialogo(async () => elegida);
    m.c.enviar({ tipo: "carpeta_elegir", token: m.token, ruta: colada, carpeta: colada });
    const r = await m.c.esperar((x) => x.tipo === "carpetas");
    assert.deepEqual(r.carpetas, [path.resolve(elegida)]);
    assert.ok(!m.config.carpetas_permitidas.includes(path.resolve(colada)));
    m.c.cerrar(); await m.servidor.detener();
  });

  it("si la persona cancela el dialogo, no cambia nada", async () => {
    const antes = carpetaTemporal();
    const m = await motorConDialogo(async () => null, [antes]);
    m.c.enviar({ tipo: "carpeta_elegir", token: m.token });
    const r = await m.c.esperar((x) => x.tipo === "carpetas");
    assert.equal(r.agregada, null);
    assert.deepEqual(m.config.carpetas_permitidas, [antes]);
    m.c.cerrar(); await m.servidor.detener();
  });

  it("no abre dos dialogos a la vez", async () => {
    let soltar: (v: string | null) => void = () => {};
    const m = await motorConDialogo(() => new Promise((res) => { soltar = res; }));
    m.c.enviar({ tipo: "carpeta_elegir", token: m.token });
    m.c.enviar({ tipo: "carpeta_elegir", token: m.token });
    const e = await m.c.esperar((x) => x.tipo === "error" && x.codigo === "dialogo_abierto");
    assert.ok(e);
    assert.equal(m.llamadas(), 1);
    soltar(null);
    await m.c.esperar((x) => x.tipo === "carpetas");
    m.c.cerrar(); await m.servidor.detener();
  });

  it("un disco entero se rechaza aunque lo elija en el dialogo", async () => {
    const raiz = path.parse(process.cwd()).root;
    const m = await motorConDialogo(async () => raiz);
    m.c.enviar({ tipo: "carpeta_elegir", token: m.token });
    const e = await m.c.esperar((x) => x.tipo === "error");
    assert.equal(e.codigo, "carpeta_invalida");
    assert.match(String(e.mensaje), /disco entero/);
    assert.deepEqual(m.config.carpetas_permitidas, []);
    m.c.cerrar(); await m.servidor.detener();
  });

  it("carpeta_quitar solo acepta una carpeta que ya esta en la lista", async () => {
    const a = carpetaTemporal(), b = carpetaTemporal();
    const m = await motorConDialogo(async () => null, [a, b]);
    m.c.enviar({ tipo: "carpeta_quitar", token: m.token, ruta: "C:\\Windows" });
    assert.equal((await m.c.esperar((x) => x.tipo === "error")).codigo, "carpeta_desconocida");
    m.c.enviar({ tipo: "carpeta_quitar", token: m.token, ruta: a });
    const r = await m.c.esperar((x) => x.tipo === "carpetas");
    assert.equal(r.quitada, a);
    assert.deepEqual(m.config.carpetas_permitidas, [b]);
    m.c.cerrar(); await m.servidor.detener();
  });

  it("sin token no se puede elegir ni quitar", async () => {
    const m = await motorConDialogo(async () => carpetaTemporal());
    m.c.enviar({ tipo: "carpeta_elegir" });
    assert.equal((await m.c.esperar((x) => x.tipo === "error")).codigo, "no_autorizado");
    assert.equal(m.llamadas(), 0);
    m.c.cerrar(); await m.servidor.detener();
  });

  it("un motor sin dialogo responde no_disponible", async () => {
    const m = await arrancar({});
    const { c, token } = await emparejado(m.puerto, m.emparejamiento.codigoActual);
    c.enviar({ tipo: "carpeta_elegir", token });
    assert.equal((await c.esperar((x) => x.tipo === "error")).codigo, "no_disponible");
    c.cerrar(); await m.servidor.detener();
  });
});
