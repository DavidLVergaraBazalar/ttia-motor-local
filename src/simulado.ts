import type { ContextoTarea, Ejecutor } from "./protocolo.js";

/**
 * Ejecutor simulado: no llama a Claude ni usa clave. Emite una secuencia realista de eventos,
 * con un pedido de permiso de escritura, para probar la web sin gastar.
 */
export class EjecutorSimulado implements Ejecutor {
  constructor(private retardoMs = 400) {}

  private espera(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const alAbortar = (): void => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        signal.removeEventListener("abort", alAbortar);
        resolve();
      }, ms);
      signal.addEventListener("abort", alAbortar, { once: true });
    });
  }

  async ejecutar(ctx: ContextoTarea): Promise<void> {
    const { id, signal, emitir } = ctx;
    const r = this.retardoMs;
    const hablar = async (texto: string): Promise<void> => {
      for (const parte of texto.match(/.{1,18}/g) ?? []) {
        if (signal.aborted) return;
        emitir({ tipo: "texto", id, delta: parte });
        await this.espera(r / 8, signal);
      }
    };

    emitir({ tipo: "estado", id, estado: "trabajando" });
    await this.espera(r, signal);
    await hablar("Voy a revisar la carpeta de trabajo para entender que hay. ");

    emitir({ tipo: "herramienta", id, nombre: "Glob", objetivo: ".", solo_lectura: true });
    await this.espera(r, signal);
    emitir({ tipo: "herramienta", id, nombre: "Read", objetivo: "notas.txt", solo_lectura: true });
    await this.espera(r, signal);
    await hablar("Ya lei las notas. Preparo un resumen y lo dejo como archivo nuevo. ");

    emitir({ tipo: "estado", id, estado: "necesita_humano" });
    const aprobado = await ctx.pedirPermiso({
      herramienta: "Write",
      resumen: "Crear o sobrescribir el archivo resumen-simulado.md",
    });
    if (signal.aborted) return;

    if (!aprobado) {
      emitir({ tipo: "estado", id, estado: "trabajando" });
      await hablar("No tengo permiso para escribir, asi que dejo el resumen solo en esta conversacion.");
      emitir({ tipo: "fin", id, exito: true, uso: usoSimulado(), sesion: SESION_SIMULADA, resultado: "Resumen (simulado) solo en la conversacion." });
      emitir({ tipo: "estado", id, estado: "libre" });
      return;
    }

    emitir({ tipo: "estado", id, estado: "trabajando" });
    emitir({ tipo: "herramienta", id, nombre: "Write", objetivo: "resumen-simulado.md", solo_lectura: false });
    await this.espera(r, signal);
    await hablar("Listo: deje resumen-simulado.md para que lo revises. (Simulacion: no se escribio nada en disco.)");
    emitir({ tipo: "fin", id, exito: true, uso: usoSimulado(), sesion: SESION_SIMULADA, resultado: "Listo: deje resumen-simulado.md para que lo revises." });
    emitir({ tipo: "estado", id, estado: "entregable_listo" });
  }
}

const SESION_SIMULADA = "00000000-0000-4000-8000-000000000000";

function usoSimulado() {
  return { entrada: 1200, salida: 340, cache_lectura: 0, cache_escritura: 0, costo_usd: 0 };
}
