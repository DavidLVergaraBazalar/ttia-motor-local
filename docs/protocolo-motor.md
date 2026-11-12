# Protocolo del motor local (web <-> motor) - v0.2

Cambios de la v0.2 (motor 0.2.0): `https://ttia.awki.ai` entra en los origenes por defecto; `tarea` acepta `sistema`
(rol del agente) y `continuar` (sesion del SDK); `fin` trae `sesion` y `resultado`; `info` trae `hay_workspace` y
`ocupado`; nuevo codigo de error `config_invalida`. Todo es compatible hacia atras: un cliente v0.1 sigue funcionando.

El motor local (`motor-local/`) abre un WebSocket en `ws://127.0.0.1:<puerto>` (por defecto 47821). Todo es JSON, un
mensaje por frame de texto, tope de 256 KB.

## Reglas de conexion

1. **Solo 127.0.0.1.** El motor nunca escucha en otra interfaz.
2. **Origin obligatorio y permitido.** El navegador envia el header `Origin`; si no esta en `origenes` de `motor.json`
   (por defecto `http://localhost:8765`, `http://127.0.0.1:8765` y `https://ttia.awki.ai`), el handshake se
   rechaza con HTTP 403. Cada origen es `esquema://host[:puerto]`, sin ruta ni barra final; el placeholder de la v0.1
   (`https://REEMPLAZAR-DOMINIO-PRODUCCION.example`) se cambia solo por `https://ttia.awki.ai`. Una conexion sin `Origin` tambien se rechaza. El header `Host` debe ser `127.0.0.1`,
   `localhost` o `[::1]` (defensa contra DNS rebinding).
3. **Emparejamiento.** Al arrancar, el motor muestra en su consola un codigo de 6 digitos. Vale 5 minutos, se usa una
   sola vez y admite 5 intentos. La web lo manda en `emparejar` y recibe un `token` de sesion (64 hex).
4. **Token en cada mensaje.** Todo mensaje que no sea `emparejar` lleva `"token"`. Sin token valido el motor responde
   `error` con `codigo: "no_autorizado"` y no hace nada. Tras 10 mensajes sin autorizacion cierra la conexion.
5. **Una tarea a la vez.** Si llega otra, responde `error` / `ocupado`.
6. Si `carpetas_permitidas` esta vacia, el motor no ejecuta tareas: responde `error` / `sin_carpetas`.

## Mensajes entrantes (web -> motor)

### `emparejar`

```json
{ "tipo": "emparejar", "codigo": "482913" }
```

Respuesta: `emparejado` o `error` (`codigo_incorrecto`, `codigo_expirado`, `codigo_usado`, `demasiados_intentos`).

### `info`

```json
{ "tipo": "info", "token": "<token>" }
```

Respuesta: `{"tipo":"info","version":"0.2.0","simulado":false,"modelo":"claude-sonnet-5-5","hay_clave":true,"hay_workspace":true,"carpetas":["C:\\Users\\Ana\\Documentos\\Trabajo"],"ocupado":false}`

`ocupado` dice si hay una tarea en curso (la web lo mira antes de tomar una tarea de la nube). `hay_workspace` dice
si hay un workspace de Anthropic configurado (nunca se manda el id ni la clave).

### `tarea`

```json
{
  "tipo": "tarea",
  "token": "<token>",
  "id": "tarea-1",
  "prompt": "Lee las notas de la carpeta y escribe un resumen en resumen.md",
  "carpeta": "C:\\Users\\Ana\\Documentos\\Trabajo",
  "sistema": "Eres Tareas, el agente de Ana...",
  "continuar": "3f0c2a7e-1b2c-4d5e-8f90-123456789abc"
}
```

- `sistema` (opcional, texto de hasta 100 000 caracteres): el rol del agente (md_base + skills + conocimiento), que la
  nube arma para su dueno. El motor lo pone **despues** de sus propias reglas, que mandan si algo choca. No da permisos:
  escribir, borrar, ejecutar o salir a internet siguen pidiendo aprobacion.
- `continuar` (opcional): el `sesion` que vino en un `fin` anterior, para seguir la misma conversacion (chat). Solo
  letras, numeros y guiones (8 a 100). Si no, `error` / `mensaje_invalido`.

`carpeta` es opcional (por defecto, la primera de `carpetas_permitidas`) y debe estar dentro de las permitidas
(se comparan rutas ya normalizadas: `..`, enlaces simbolicos y junctions no sirven para escapar). Si no, el motor
responde `error` / `carpeta_no_permitida`. El `id` lo elige la web y vuelve en todos los eventos de esa tarea.

### `respuesta_permiso`

```json
{ "tipo": "respuesta_permiso", "token": "<token>", "id": "p1-mwcmndvp", "aprobado": true }
```

### `cancelar`

```json
{ "tipo": "cancelar", "token": "<token>", "id": "tarea-1" }
```

Interrumpe la tarea. El motor emite `estado: libre` y `error` / `cancelada`. Si la conexion que inicio la tarea se
cierra, la tarea tambien se cancela y los permisos pendientes se deniegan.

## Eventos salientes (motor -> web)

### `emparejado`

```json
{ "tipo": "emparejado", "token": "d098bf5ae5417e00f03e8196ef80c3d36c680675b3ad053925df28047c24c205" }
```

### `estado`

Los estados del semaforo del PLAN (seccion 4):

| estado | Semaforo | Significado |
|---|---|---|
| `trabajando` | verde | el agente trabaja solo |
| `necesita_humano` | rojo | espera una respuesta de permiso |
| `entregable_listo` | amarillo | termino y escribio archivos que hay que revisar |
| `libre` | - | termino sin entregable, o se cancelo |

```json
{ "tipo": "estado", "id": "tarea-1", "estado": "necesita_humano" }
```

### `texto` (stream)

```json
{ "tipo": "texto", "id": "tarea-1", "delta": "Voy a revisar la carpeta " }
```

### `herramienta`

Que esta usando el agente. **Nunca incluye comandos, URLs ni contenido**: solo el nombre y, si hay, la ruta relativa
a la carpeta de trabajo.

```json
{ "tipo": "herramienta", "id": "tarea-1", "nombre": "Read", "objetivo": "notas.txt", "solo_lectura": true }
```

### `permiso`

Pedido de aprobacion (el cartel rojo). Aqui el `resumen` si puede incluir el comando o la direccion, porque la persona
necesita verlos para decidir. Se pide para escritura, borrado, bash/PowerShell, red (WebFetch/WebSearch) y cualquier
herramienta MCP. Las lecturas dentro de las carpetas permitidas son automaticas. Una ruta fuera de las carpetas se
deniega sin preguntar. Si pasan 5 minutos sin respuesta, se deniega.

```json
{
  "tipo": "permiso",
  "id": "p1-mwcmndvp",
  "tarea": "tarea-1",
  "herramienta": "Write",
  "resumen": "Crear o sobrescribir el archivo resumen.md"
}
```

### `fin`

```json
{
  "tipo": "fin",
  "id": "tarea-1",
  "exito": true,
  "uso": { "entrada": 1200, "salida": 340, "cache_lectura": 0, "cache_escritura": 0, "costo_usd": 0.0123 },
  "sesion": "3f0c2a7e-1b2c-4d5e-8f90-123456789abc",
  "resultado": "Listo: deje resumen.md con los puntos principales."
}
```

`costo_usd` es una estimacion del SDK (`null` si no la dio). `sesion` es el id de sesion del SDK (sirve para
`continuar`); `resultado` es el texto final del agente (`null` si fallo). Despues de `fin` llega siempre un `estado`
(`libre` o `entregable_listo`).

### `error`

```json
{ "tipo": "error", "id": "tarea-1", "codigo": "sin_clave", "mensaje": "No hay una clave de Claude guardada. Ejecuta: motor-local clave set" }
```

Codigos: `json_invalido`, `no_autorizado`, `tipo_desconocido`, `mensaje_invalido`, `codigo_incorrecto`,
`codigo_expirado`, `codigo_usado`, `demasiados_intentos`, `sin_carpetas`, `carpeta_no_permitida`, `ocupado`,
`sin_clave`, `config_invalida`, `permiso_desconocido`, `fallo_agente`, `fallo_sdk`, `fallo_interno`, `cancelada`.

`fallo_agente` llega antes de `fin` (la tarea igual termina con `fin` + `estado`). Los demas errores con `id` cierran la
tarea. Al cancelar llegan `estado: libre` y despues `error: cancelada` (sin `fin`).

## Workspace de Anthropic

Las claves `sk-ant-usr-` exigen el header `anthropic-workspace-id`. El motor lo toma de `"workspace"` en `motor.json`
o, si no esta, de la variable `ANTHROPIC_WORKSPACE_ID`. Solo admite `[A-Za-z0-9_-]` (nada de saltos de linea: no se
pueden inyectar otros headers). Viaja al proceso del SDK como `ANTHROPIC_CUSTOM_HEADERS=anthropic-workspace-id: <id>`;
cualquier `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_BASE_URL` o token heredado del entorno se descarta.

## Conectar desde la web publicada (https) a ws://127.0.0.1

- Contenido mixto: Chrome, Edge y Firefox tratan `127.0.0.1`/`localhost` como origen confiable, asi que una pagina
  https puede abrir `ws://127.0.0.1:47821`. **Safari lo bloquea** (la web muestra el aviso y recomienda otro navegador).
- Local Network Access (antes Private Network Access) de Chrome/Edge: desde Chrome 142 una pagina publica necesita el
  permiso del usuario para llegar a la red local o al bucle local, y desde Chrome 147 tambien rige para WebSockets.
  El navegador muestra «ttia.awki.ai quiere acceder a dispositivos de tu red local»: hay que elegir **Permitir**. Si se
  deniega, el WebSocket falla; la web consulta `navigator.permissions.query({name: "loopback-network"})` (y los nombres
  anteriores `local-network-access` / `local-network`) y, si dice `denied`, explica como activarlo (candado >
  Configuracion del sitio > Acceso a la red local). En equipos administrados, la politica
  `LocalNetworkAccessAllowedForUrls` puede permitir `https://ttia.awki.ai` sin preguntar.
- El handshake de WebSocket no tiene preflight CORS, por eso el motor no responde headers
  `Access-Control-Allow-Private-Network`: la proteccion real es `Origin` + `Host` + emparejamiento + token.
- La web solo busca el motor si el usuario abre «Mi PC» o tiene agentes locales, para no pedir ese permiso a quien no
  lo usa.

## Tareas de la nube hechas por el motor (lo hace la web, no el motor)

El motor no habla con la nube. La web emparejada:

1. `GET /yo/tareas-locales?estado=pendiente` (tareas de los agentes privados del usuario con `ejecucion = 'local'`).
2. Si `info.ocupado` es `false`: `POST /tareas/{tid}/local/iniciar` -> `{prompt, sistema}` y la tarea queda `en_curso`.
3. `tarea` al motor con ese `prompt` y `sistema`; muestra el progreso y el cartel rojo de los `permiso`.
4. Con `fin`: `POST /tareas/{tid}/local/terminar` `{resultado, estado: "por_revisar" | "esperando_humano", uso}`
   (`esperando_humano` si el resultado empieza con `NECESITO:` o si fallo). Si el motor estaba `ocupado` o se corto la
   conexion: `POST /tareas/{tid}/local/soltar` (vuelve a `pendiente`).
5. Si la web se cierra a mitad, la nube devuelve la tarea a `pendiente` a los 15 minutos.


## Secuencia tipica

```
web   -> {"tipo":"emparejar","codigo":"175872"}
motor -> {"tipo":"emparejado","token":"..."}
web   -> {"tipo":"tarea","token":"...","id":"tarea-1","prompt":"...","carpeta":"C:\\..."}
motor -> {"tipo":"estado","id":"tarea-1","estado":"trabajando"}
motor -> {"tipo":"texto","id":"tarea-1","delta":"..."}            (varios)
motor -> {"tipo":"herramienta","id":"tarea-1","nombre":"Read","objetivo":"notas.txt","solo_lectura":true}
motor -> {"tipo":"estado","id":"tarea-1","estado":"necesita_humano"}
motor -> {"tipo":"permiso","id":"p1-...","tarea":"tarea-1","herramienta":"Write","resumen":"..."}
web   -> {"tipo":"respuesta_permiso","token":"...","id":"p1-...","aprobado":true}
motor -> {"tipo":"estado","id":"tarea-1","estado":"trabajando"}
motor -> {"tipo":"herramienta","id":"tarea-1","nombre":"Write","objetivo":"resumen.md","solo_lectura":false}
motor -> {"tipo":"fin","id":"tarea-1","exito":true,"uso":{...}}
motor -> {"tipo":"estado","id":"tarea-1","estado":"entregable_listo"}
```

El modo `--simulado` emite exactamente esta secuencia sin llamar a Claude (ver `motor-local/scripts/cliente-prueba.ts`).
