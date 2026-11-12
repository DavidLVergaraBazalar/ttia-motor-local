import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { WebSocket } from "ws";
import { CODIGO_EXPIRA_MS, Emparejamiento, MAX_INTENTOS } from "../src/emparejamiento.js";
import { evaluarHerramienta, SolicitudesPermiso } from "../src/permisos.js";
import { rutaPermitida } from "../src/rutas.js";
import { cambiarCarpetas, guardarCarpeta, normalizarConfig } from "../src/config.js";
import { tachar } from "../src/log.js";
import { arrancar, carpetaTemporal, conectar, emparejado } from "./ayuda.js";

describe("emparejamiento", () => {
  it("acepta el codigo correcto y entrega un token valido", () => {
    const e = new Emparejamiento();
    const r = e.intentar(e.codigoActual);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(e.tokenValido(r.token), true);
  });

  it("rechaza un codigo incorrecto", () => {
    const e = new Emparejamiento();
    const malo = e.codigoActual === "000000" ? "111111" : "000000";
    const r = e.intentar(malo);
    assert.deepEqual(r, { ok: false, motivo: "codigo_incorrecto" });
  });

  it("rechaza un codigo expirado", () => {
    let t = 1_000;
    const e = new Emparejamiento(() => t);
    t += CODIGO_EXPIRA_MS + 1;
    assert.deepEqual(e.intentar(e.codigoActual), { ok: false, motivo: "codigo_expirado" });
  });

  it("es de un solo uso: el segundo intento con el mismo codigo falla", () => {
    const e = new Emparejamiento();
    const codigo = e.codigoActual;
    assert.equal(e.intentar(codigo).ok, true);
    assert.deepEqual(e.intentar(codigo), { ok: false, motivo: "codigo_usado" });
  });

  it("bloquea tras demasiados intentos, incluso con el codigo correcto", () => {
    const e = new Emparejamiento();
    const malo = e.codigoActual === "000000" ? "111111" : "000000";
    for (let i = 0; i < MAX_INTENTOS; i++) e.intentar(malo);
    assert.deepEqual(e.intentar(e.codigoActual), { ok: false, motivo: "demasiados_intentos" });
  });

  it("un token inventado no es valido", () => {
    const e = new Emparejamiento();
    assert.equal(e.tokenValido("a".repeat(64)), false);
    assert.equal(e.tokenValido(undefined), false);
  });
});

describe("rutas permitidas", () => {
  const base = carpetaTemporal();
  const permitida = path.join(base, "trabajo");
  const otra = path.join(base, "secreto");
  fs.mkdirSync(permitida);
  fs.mkdirSync(otra);
  fs.writeFileSync(path.join(otra, "clave.txt"), "x");

  it("acepta rutas dentro de la carpeta", () => {
    assert.equal(rutaPermitida(path.join(permitida, "a", "b.txt"), [permitida]), true);
    assert.equal(rutaPermitida("sub\\archivo.txt", [permitida], permitida), true);
  });

  it("rechaza una ruta fuera de la carpeta", () => {
    assert.equal(rutaPermitida(path.join(otra, "clave.txt"), [permitida]), false);
  });

  it("rechaza escapes con ..\\ y ../", () => {
    assert.equal(rutaPermitida(path.join(permitida, "..", "secreto", "clave.txt"), [permitida]), false);
    assert.equal(rutaPermitida("..\\secreto\\clave.txt", [permitida], permitida), false);
    assert.equal(rutaPermitida("../secreto/clave.txt", [permitida], permitida), false);
  });

  it("una carpeta hermana con el mismo prefijo no cuenta como dentro", () => {
    const hermana = permitida + "-extra";
    fs.mkdirSync(hermana);
    assert.equal(rutaPermitida(path.join(hermana, "x.txt"), [permitida]), false);
  });

  it("rechaza cuando no hay carpetas permitidas", () => {
    assert.equal(rutaPermitida(path.join(permitida, "a.txt"), []), false);
  });

  it("rechaza un symlink/junction de adentro hacia afuera", (t) => {
    const enlace = path.join(permitida, "enlace");
    try {
      fs.symlinkSync(otra, enlace, "junction");
    } catch {
      t.skip("no se pudo crear el enlace en este entorno");
      return;
    }
    assert.equal(rutaPermitida(path.join(enlace, "clave.txt"), [permitida]), false);
  });
});

describe("politica de permisos", () => {
  const base = carpetaTemporal();
  const ctx = { carpetas: [base], cwd: base, contenidoExterno: false };

  it("lectura dentro de la carpeta: automatica", () => {
    assert.deepEqual(evaluarHerramienta("Read", { file_path: path.join(base, "a.txt") }, ctx), { accion: "permitir" });
  });

  it("lectura fuera de la carpeta: denegada (incluye ..)", () => {
    const d = evaluarHerramienta("Read", { file_path: "..\\..\\Windows\\win.ini" }, ctx);
    assert.equal(d.accion, "denegar");
    assert.equal(evaluarHerramienta("Glob", { pattern: "**/*", path: path.dirname(base) }, ctx).accion, "denegar");
  });

  it("escritura, shell, web y MCP piden permiso", () => {
    assert.equal(evaluarHerramienta("Write", { file_path: path.join(base, "n.md") }, ctx).accion, "preguntar");
    assert.equal(evaluarHerramienta("Bash", { command: "dir" }, ctx).accion, "preguntar");
    assert.equal(evaluarHerramienta("WebFetch", { url: "https://x.test" }, ctx).accion, "preguntar");
    assert.equal(evaluarHerramienta("mcp__algo__envia", {}, ctx).accion, "preguntar");
  });

  it("escritura fuera de la carpeta: denegada sin preguntar", () => {
    assert.equal(evaluarHerramienta("Write", { file_path: "C:\\Windows\\x.txt" }, ctx).accion, "denegar");
  });

  it("sin carpetas permitidas todo se deniega", () => {
    assert.equal(evaluarHerramienta("Read", { file_path: "a" }, { ...ctx, carpetas: [] }).accion, "denegar");
  });
});

describe("permiso con timeout", () => {
  it("se deniega solo si nadie responde", async () => {
    const s = new SolicitudesPermiso(50);
    let emitido = 0;
    const ok = await s.pedir(() => emitido++, { herramienta: "Bash", resumen: "x" });
    assert.equal(ok, false);
    assert.equal(emitido, 1);
    assert.equal(s.cantidad, 0);
  });

  it("aprobado cuando la web responde que si", async () => {
    const s = new SolicitudesPermiso(5000);
    const p = s.pedir((ped) => queueMicrotask(() => s.responder(ped.id, true)), { herramienta: "Write", resumen: "x" });
    assert.equal(await p, true);
  });
});

describe("servidor WebSocket", () => {
  const cierres: Array<() => Promise<void>> = [];
  after(async () => {
    for (const f of cierres) await f();
  });

  it("rechaza un Origin no permitido", async () => {
    const { servidor, puerto } = await arrancar({});
    cierres.push(() => servidor.detener());
    const resultado = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${puerto}`, { origin: "https://sitio-malo.example" });
      ws.once("open", () => resolve("abrio"));
      ws.once("unexpected-response", (_r, res) => resolve(`http-${res.statusCode}`));
      ws.once("error", () => resolve("error"));
    });
    assert.equal(resultado, "http-403");
  });

  it("escucha solo en 127.0.0.1", async () => {
    const { servidor } = await arrancar({});
    cierres.push(() => servidor.detener());
    assert.equal(servidor.direccion, "127.0.0.1");
  });

  it("rechaza una conexion sin Origin", async () => {
    const { servidor, puerto } = await arrancar({});
    cierres.push(() => servidor.detener());
    await assert.rejects(conectar(puerto, null));
  });

  it("rechaza todo mensaje sin token valido", async () => {
    const carpeta = carpetaTemporal();
    const { servidor, puerto } = await arrancar({ carpetas: [carpeta] });
    cierres.push(() => servidor.detener());
    const c = await conectar(puerto);
    c.enviar({ tipo: "tarea", id: "t1", prompt: "hola", carpeta });
    const e1 = await c.esperar((m) => m.tipo === "error");
    assert.equal(e1.codigo, "no_autorizado");
    c.enviar({ tipo: "tarea", token: "f".repeat(64), id: "t1", prompt: "hola" });
    c.enviar({ tipo: "info" });
    await c.esperar(() => c.recibidos.filter((m) => m.codigo === "no_autorizado").length >= 3);
    assert.equal(c.recibidos.some((m) => m.tipo === "estado"), false);
    c.cerrar();
  });

  it("emparejar con codigo incorrecto da error y con el correcto da token", async () => {
    const { servidor, puerto, emparejamiento } = await arrancar({});
    cierres.push(() => servidor.detener());
    const c = await conectar(puerto);
    const malo = emparejamiento.codigoActual === "000000" ? "111111" : "000000";
    c.enviar({ tipo: "emparejar", codigo: malo });
    assert.equal((await c.esperar((m) => m.tipo === "error")).codigo, "codigo_incorrecto");
    c.enviar({ tipo: "emparejar", codigo: emparejamiento.codigoActual });
    const ok = await c.esperar((m) => m.tipo === "emparejado");
    assert.equal(typeof ok.token, "string");
    c.cerrar();
  });

  it("sin carpetas permitidas no ejecuta tareas y lo dice", async () => {
    const { servidor, puerto, emparejamiento } = await arrancar({ carpetas: [] });
    cierres.push(() => servidor.detener());
    const { c, token } = await emparejado(puerto, emparejamiento.codigoActual);
    c.enviar({ tipo: "tarea", token, id: "t1", prompt: "hola" });
    assert.equal((await c.esperar((m) => m.tipo === "error")).codigo, "sin_carpetas");
    c.cerrar();
  });

  it("rechaza una tarea con carpeta fuera de las permitidas (incluye ..\\)", async () => {
    const carpeta = carpetaTemporal();
    const { servidor, puerto, emparejamiento } = await arrancar({ carpetas: [carpeta] });
    cierres.push(() => servidor.detener());
    const { c, token } = await emparejado(puerto, emparejamiento.codigoActual);
    c.enviar({ tipo: "tarea", token, id: "t1", prompt: "hola", carpeta: path.join(carpeta, "..") });
    assert.equal((await c.esperar((m) => m.tipo === "error")).codigo, "carpeta_no_permitida");
    c.enviar({ tipo: "tarea", token, id: "t2", prompt: "hola", carpeta: carpeta + "\\..\\..\\Windows" });
    await c.esperar((m) => m.tipo === "error" && m.id === "t2");
    assert.equal(c.recibidos.some((m) => m.tipo === "estado"), false);
    c.cerrar();
  });

  it("una tarea simulada pide permiso y se deniega por timeout", async () => {
    const carpeta = carpetaTemporal();
    const { servidor, puerto, emparejamiento } = await arrancar({ carpetas: [carpeta], permisoTimeoutMs: 80 });
    cierres.push(() => servidor.detener());
    const { c, token } = await emparejado(puerto, emparejamiento.codigoActual);
    c.enviar({ tipo: "tarea", token, id: "t1", prompt: "resume", carpeta });
    const p = await c.esperar((m) => m.tipo === "permiso");
    assert.equal(p.herramienta, "Write");
    // Nadie responde: debe denegarse solo y terminar sin entregable.
    const fin = await c.esperar((m) => m.tipo === "fin");
    assert.equal(fin.exito, true);
    const ultimo = await c.esperar((m) => m.tipo === "estado" && m.estado === "libre");
    assert.ok(ultimo);
    assert.equal(c.recibidos.some((m) => m.tipo === "herramienta" && m.nombre === "Write"), false);
    c.cerrar();
  });
});

describe("log", () => {
  it("tacha claves y tokens", () => {
    assert.equal(tachar("clave sk-ant-api03-ABCDEFGHIJ1234"), "clave sk-ant-***");
    assert.equal(tachar('{"token":"abc123"}'), '{"token":"***"}');
  });
});

describe("config", () => {
  it("completa valores por defecto y valida el puerto", () => {
    const c = normalizarConfig({ carpetas_permitidas: ["C:\\x"] });
    assert.equal(c.puerto, 47821);
    assert.equal(c.modelo, "claude-sonnet-5-5");
    assert.throws(() => normalizarConfig({ puerto: 80 }));
  });
});

describe("carpetas permitidas (comando carpeta)", () => {
  it("agrega una carpeta existente, sin duplicar aunque cambien mayusculas o la barra final", () => {
    const base = carpetaTemporal();
    const una = cambiarCarpetas([], base, "agregar");
    assert.deepEqual(una, [path.resolve(base)]);
    assert.deepEqual(cambiarCarpetas(una, base.toUpperCase() + "\\", "agregar"), una);
  });
  it("rechaza rutas relativas y carpetas que no existen", () => {
    assert.throws(() => cambiarCarpetas([], "Documentos", "agregar"), /ruta completa/);
    assert.throws(() => cambiarCarpetas([], path.join(carpetaTemporal(), "no-existe"), "agregar"), /No existe/);
  });
  it("quita una carpeta aunque ya no exista en disco", () => {
    const base = carpetaTemporal();
    const fantasma = path.join(base, "borrada");
    assert.deepEqual(cambiarCarpetas([base, fantasma], fantasma, "quitar"), [base]);
  });
  it("guardarCarpeta conserva el resto de motor.json", () => {
    const datos = carpetaTemporal();
    const previo = process.env.AWKI_OFFICE_DIR;
    process.env.AWKI_OFFICE_DIR = datos;
    try {
      fs.writeFileSync(path.join(datos, "motor.json"), JSON.stringify({ carpetas_permitidas: [], modelo: "claude-opus-5-5" }));
      const trabajo = carpetaTemporal();
      assert.deepEqual(guardarCarpeta(trabajo, "agregar"), [path.resolve(trabajo)]);
      const guardado = JSON.parse(fs.readFileSync(path.join(datos, "motor.json"), "utf8"));
      assert.equal(guardado.modelo, "claude-opus-5-5");
      assert.deepEqual(guardado.carpetas_permitidas, [path.resolve(trabajo)]);
    } finally {
      if (previo === undefined) delete process.env.AWKI_OFFICE_DIR; else process.env.AWKI_OFFICE_DIR = previo;
    }
  });
});
