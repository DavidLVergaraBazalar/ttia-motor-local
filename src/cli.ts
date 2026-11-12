#!/usr/bin/env node
import readline from "node:readline";
import { cargarConfig, crearConfigSiFalta, guardarCarpeta, rutaConfig, workspaceEfectivo, type ConfigMotor } from "./config.js";
import { almacenWindows, claveBorrar, claveEstado, claveSet } from "./clave.js";
import { crearLogger } from "./log.js";
import { Emparejamiento } from "./emparejamiento.js";
import { ServidorMotor, VERSION } from "./servidor.js";
import { EjecutorClaude } from "./agente.js";
import { EjecutorSimulado } from "./simulado.js";

const AYUDA = `THE TOWN IA - motor local v${VERSION}

Uso:
  motor-local                      Arranca el motor (usa Claude con tu clave guardada)
  motor-local --simulado           Arranca sin llamar a Claude (para probar la web, sin gastar)
  motor-local clave set            Guarda tu API key de Claude en el Administrador de credenciales
  motor-local clave borrar         Borra la clave guardada
  motor-local clave estado         Dice si hay una clave guardada (nunca la muestra)
  motor-local carpeta agregar <ruta>   Permite al agente trabajar en esa carpeta
  motor-local carpeta quitar <ruta>    Le quita el acceso a esa carpeta
  motor-local carpeta lista            Muestra las carpetas permitidas
  motor-local --ayuda              Muestra este texto

Configuracion: ${rutaConfig()}
Workspace de Anthropic (claves sk-ant-usr-): campo "workspace" de motor.json o variable ANTHROPIC_WORKSPACE_ID.
`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--ayuda") || args.includes("-h")) {
    console.log(AYUDA);
    return 0;
  }

  if (args[0] === "clave") {
    switch (args[1]) {
      case "set":
        await claveSet();
        console.log("Listo: la clave quedo guardada en el Administrador de credenciales de Windows.");
        return 0;
      case "borrar":
        console.log(claveBorrar() ? "Clave borrada." : "No habia ninguna clave guardada.");
        return 0;
      case "estado":
        console.log(claveEstado() ? "Hay una clave de Claude guardada." : "No hay clave guardada. Usa: motor-local clave set");
        return 0;
      default:
        console.error("Uso: motor-local clave set | borrar | estado");
        return 1;
    }
  }

  if (args[0] === "carpeta") {
    const accion = args[1];
    if (accion === "lista") {
      crearConfigSiFalta();
      const lista = cargarConfig().carpetas_permitidas;
      console.log(lista.length ? lista.join("\n") : "No hay carpetas permitidas. Agrega una: motor-local carpeta agregar <ruta>");
      return 0;
    }
    if ((accion === "agregar" || accion === "quitar") && args[2]) {
      try {
        const lista = guardarCarpeta(args.slice(2).join(" "), accion);
        console.log(`Listo. Carpetas permitidas:\n${lista.join("\n") || "(ninguna)"}`);
        console.log("Si el motor esta corriendo, escribe 'recargar' en su consola.");
        return 0;
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
    }
    console.error("Uso: motor-local carpeta agregar <ruta> | quitar <ruta> | lista");
    return 1;
  }

  const simulado = args.includes("--simulado");
  const creada = crearConfigSiFalta();
  let config: ConfigMotor = cargarConfig();
  const log = crearLogger();
  if (creada) console.log(`Cree la configuracion inicial en ${rutaConfig()}`);

  if (!simulado && !claveEstado()) {
    console.error("No hay una clave de Claude guardada. Ejecuta primero: motor-local clave set (o prueba con --simulado).");
    return 1;
  }
  const workspace = workspaceEfectivo(config); // lanza con un mensaje claro si es invalido
  if (config.carpetas_permitidas.length === 0) {
    console.warn(
      `AVISO: no hay carpetas permitidas. El motor no ejecutara tareas hasta que agregues una en "carpetas_permitidas" de ${rutaConfig()}.`,
    );
  }

  const emparejamiento = new Emparejamiento();
  const ejecutor = simulado ? new EjecutorSimulado() : new EjecutorClaude(() => config, almacenWindows, log);
  const servidor = new ServidorMotor({
    config: () => config,
    ejecutor,
    emparejamiento,
    log,
    simulado,
    hayClave: () => claveEstado(),
    hayWorkspace: () => {
      try {
        return workspaceEfectivo(config) !== null;
      } catch {
        return false;
      }
    },
  });
  const puerto = await servidor.iniciar();

  const mostrarCodigo = (): void => {
    console.log("");
    console.log(`  Codigo de emparejamiento: ${emparejamiento.codigoActual}   (vale 5 minutos y se usa una sola vez)`);
    console.log("  Escribelo en la pagina de THE TOWN IA (https://ttia.awki.ai). Para generar otro, escribe 'nuevo' y Enter.");
    console.log("");
  };
  log.info(`motor ${VERSION} escuchando en 127.0.0.1:${puerto}`, { simulado, modelo: config.modelo });
  console.log(`THE TOWN IA - motor local ${VERSION}${simulado ? " (MODO SIMULADO: no se llama a Claude)" : ""}`);
  console.log(`Escuchando solo en 127.0.0.1:${puerto}. Origenes permitidos: ${config.origenes.join(", ")}`);
  console.log(workspace ? "Workspace de Anthropic: configurado." : "Workspace de Anthropic: ninguno (las claves sk-ant-usr- lo necesitan).");
  mostrarCodigo();

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (l) => {
      const t = l.trim().toLowerCase();
      if (t === "nuevo") {
        emparejamiento.nuevoCodigo();
        mostrarCodigo();
      } else if (t === "recargar") {
        config = cargarConfig();
        console.log("Configuracion recargada.");
      } else if (t === "salir") {
        void servidor.detener().then(() => process.exit(0));
      }
    });
  }

  const cerrar = (): void => {
    void servidor.detener().then(() => process.exit(0));
  };
  process.on("SIGINT", cerrar);
  process.on("SIGTERM", cerrar);
  return -1; // sigue corriendo
}

main().then(
  (cod) => {
    if (cod >= 0) process.exit(cod);
  },
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
