/** v0.2: conexion con la web publicada (ttia.awki.ai), workspace de Anthropic, rol del agente y sesiones. */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { WebSocket } from "ws";
import { configPorDefecto, normalizarConfig, ORIGEN_PRODUCCION, workspaceEfectivo } from "../src/config.js";
import { entornoSdk, promptSistema } from "../src/agente.js";
import type { ContextoTarea, Ejecutor } from "../src/protocolo.js";
import { MAX_SISTEMA, VERSION } from "../src/servidor.js";
import { arrancar, carpetaTemporal, conectar, emparejado } from "./ayuda.js";

describe("config v0.2", () => {
  it("acepta la web publicada por defecto, ademas de localhost", () => {
    const c = configPorDefecto();
    assert.ok(c.origenes.includes("https://ttia.awki.ai"));
    assert.ok(c.origenes.includes("http://localhost:8765"));
    assert.equal(ORIGEN_PRODUCCION, "https://ttia.awki.ai");
  });

  it("cambia el placeholder de la v0.1 por el dominio real", () => {
    const c = normalizarConfig({ origenes: ["http://localhost:8765", "https://REEMPLAZAR-DOMINIO-PRODUCCION.example"] });
    assert.deepEqual(c.origenes, ["http://localhost:8765", "https://ttia.awki.ai"]);
  });

  it("rechaza origenes con ruta, comodines o esquemas raros", () => {
    assert.throws(() => normalizarConfig({ origenes: ["https://ttia.awki.ai/"] }));
    assert.throws(() => normalizarConfig({ origenes: ["*"] }));
    assert.throws(() => normalizarConfig({ origenes: ["file://"] }));
    assert.deepEqual(normalizarConfig({ origenes: ["https://otro.ejemplo.pe:8443"] }).origenes, ["https://otro.ejemplo.pe:8443"]);
  });

  it("workspace: valida el formato (sin saltos de linea) y cae en ANTHROPIC_WORKSPACE_ID", () => {
    assert.equal(normalizarConfig({}).workspace, null);
    assert.equal(normalizarConfig({ workspace: "wrkspc_01AbC-d" }).workspace, "wrkspc_01AbC-d");
    assert.throws(() => normalizarConfig({ workspace: "wrk\r\nx-api-key: robada" }));
    assert.throws(() => normalizarConfig({ workspace: 5 }));
    const sin = normalizarConfig({});
    assert.equal(workspaceEfectivo(sin, {}), null);
    assert.equal(workspaceEfectivo(sin, { ANTHROPIC_WORKSPACE_ID: "wrkspc_env" }), "wrkspc_env");
    assert.equal(workspaceEfectivo(normalizarConfig({ workspace: "wrkspc_json" }), { ANTHROPIC_WORKSPACE_ID: "wrkspc_env" }), "wrkspc_json");
    assert.throws(() => workspaceEfectivo(sin, { ANTHROPIC_WORKSPACE_ID: "a b\nc" }));
  });
});

describe("entorno del SDK", () => {
  const CLAVE = "sk-ant-usr-NO-REAL-0000";
  it("manda el header anthropic-workspace-id solo si hay workspace", () => {
    const con = entornoSdk({ PATH: "x" }, CLAVE, "wrkspc_01");
    assert.equal(con.ANTHROPIC_API_KEY, CLAVE);
    assert.equal(con.ANTHROPIC_CUSTOM_HEADERS, "anthropic-workspace-id: wrkspc_01");
    assert.equal(con.PATH, "x");
    const sin = entornoSdk({}, CLAVE, null);
    assert.equal(sin.ANTHROPIC_CUSTOM_HEADERS, undefined);
  });

  it("quita credenciales y headers heredados del entorno", () => {
    const env = entornoSdk(
      {
        ANTHROPIC_AUTH_TOKEN: "t",
        CLAUDE_CODE_OAUTH_TOKEN: "o",
        ANTHROPIC_BASE_URL: "https://proxy.malo",
        ANTHROPIC_CUSTOM_HEADERS: "x: y",
        ANTHROPIC_WORKSPACE_ID: "w",
      },
      CLAVE,
      null,
    );
    for (const k of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_WORKSPACE_ID"]) {
      assert.equal(env[k], undefined, k);
    }
  });

  it("el rol del agente va despues de las reglas del motor", () => {
    const p = promptSistema("Eres Tareas, el agente de David.");
    assert.ok(p.indexOf("Trabaja solo dentro de la carpeta") < p.indexOf("Eres Tareas"));
    assert.ok(p.includes("mandan las reglas del motor"));
    assert.equal(promptSistema(undefined), promptSistema(""));
  });
});

const SESION = "11111111-2222-4333-8444-555555555555";

/** Ejecutor que guarda lo que recibe y termina enseguida. */
class EjecutorEspia implements Ejecutor {
  recibidos: ContextoTarea[] = [];
  async ejecutar(ctx: ContextoTarea): Promise<void> {
    this.recibidos.push(ctx);
    ctx.emitir({ tipo: "estado", id: ctx.id, estado: "trabajando" });
    ctx.emitir({
      tipo: "fin",
      id: ctx.id,
      exito: true,
      uso: { entrada: 1, salida: 1, cache_lectura: 0, cache_escritura: 0, costo_usd: null },
      sesion: SESION,
      resultado: "ok",
    });
    ctx.emitir({ tipo: "estado", id: ctx.id, estado: "libre" });
  }
}

describe("servidor v0.2", () => {
  const cierres: Array<() => Promise<void>> = [];
  after(async () => {
    for (const f of cierres) await f();
  });

  it("acepta el Origin https://ttia.awki.ai con la config por defecto", async () => {
    const { servidor, puerto } = await arrancar({});
    cierres.push(() => servidor.detener());
    const c = await conectar(puerto, "https://ttia.awki.ai");
    assert.equal(c.ws.readyState, WebSocket.OPEN);
    c.cerrar();
  });

  it("info avisa si hay workspace y si el motor esta ocupado", async () => {
    const { servidor, puerto, emparejamiento } = await arrancar({});
    cierres.push(() => servidor.detener());
    const { c, token } = await emparejado(puerto, emparejamiento.codigoActual);
    c.enviar({ tipo: "info", token });
    const info = await c.esperar((m) => m.tipo === "info");
    assert.equal(info.version, VERSION);
    assert.equal(info.hay_workspace, false);
    assert.equal(info.ocupado, false);
    c.cerrar();
  });

  it("pasa el rol y la sesion a continuar al ejecutor", async () => {
    const carpeta = carpetaTemporal();
    const espia = new EjecutorEspia();
    const { servidor, puerto, emparejamiento } = await arrancar({ carpetas: [carpeta], ejecutor: espia });
    cierres.push(() => servidor.detener());
    const { c, token } = await emparejado(puerto, emparejamiento.codigoActual);
    c.enviar({ tipo: "tarea", token, id: "t1", prompt: "hola", sistema: "Eres Tareas.", continuar: SESION });
    const fin = await c.esperar((m) => m.tipo === "fin");
    assert.equal(fin.sesion, SESION);
    assert.equal(fin.resultado, "ok");
    assert.equal(espia.recibidos[0]?.sistema, "Eres Tareas.");
    assert.equal(espia.recibidos[0]?.continuar, SESION);
    c.cerrar();
  });

  it("rechaza un rol demasiado largo o una sesion con forma rara", async () => {
    const carpeta = carpetaTemporal();
    const espia = new EjecutorEspia();
    const { servidor, puerto, emparejamiento } = await arrancar({ carpetas: [carpeta], ejecutor: espia });
    cierres.push(() => servidor.detener());
    const { c, token } = await emparejado(puerto, emparejamiento.codigoActual);
    c.enviar({ tipo: "tarea", token, id: "t1", prompt: "hola", sistema: "x".repeat(MAX_SISTEMA + 1) });
    assert.equal((await c.esperar((m) => m.tipo === "error" && m.id === "t1")).codigo, "mensaje_invalido");
    c.enviar({ tipo: "tarea", token, id: "t2", prompt: "hola", continuar: "../../etc" });
    assert.equal((await c.esperar((m) => m.tipo === "error" && m.id === "t2")).codigo, "mensaje_invalido");
    c.enviar({ tipo: "tarea", token, id: "t3", prompt: "hola", sistema: 42 });
    assert.equal((await c.esperar((m) => m.tipo === "error" && m.id === "t3")).codigo, "mensaje_invalido");
    assert.equal(espia.recibidos.length, 0);
    c.cerrar();
  });

  it("el modo simulado devuelve sesion y resultado en fin", async () => {
    const carpeta = carpetaTemporal();
    const { servidor, puerto, emparejamiento } = await arrancar({ carpetas: [carpeta] });
    cierres.push(() => servidor.detener());
    const { c, token } = await emparejado(puerto, emparejamiento.codigoActual);
    c.enviar({ tipo: "tarea", token, id: "t1", prompt: "resume" });
    const p = await c.esperar((m) => m.tipo === "permiso");
    c.enviar({ tipo: "respuesta_permiso", token, id: p.id, aprobado: true });
    const fin = await c.esperar((m) => m.tipo === "fin");
    assert.equal(typeof fin.sesion, "string");
    assert.equal(typeof fin.resultado, "string");
    await c.esperar((m) => m.tipo === "estado" && m.estado === "entregable_listo");
    c.cerrar();
  });
});
