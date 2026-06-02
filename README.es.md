<p align="center">
  <img src="assets/source-icon.png" width="88" alt="WhereMyTokens icon" />
</p>

<h1 align="center">WhereMyTokens</h1>

<p align="center">
  <strong>Ahora también rastrea Codex.</strong>
</p>

<p align="center">
  <img alt="Codex tracking" src="https://img.shields.io/badge/Codex_tracking-new-4f46e5?style=for-the-badge">
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-supported-d97706?style=for-the-badge">
  <img alt="Local only" src="https://img.shields.io/badge/Local_only-no_cloud_sync-0f766e?style=for-the-badge">
</p>

<p align="center">
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%2F11-0078d4?style=for-the-badge">
  <img alt="Release" src="https://img.shields.io/github/v/release/jeongwookie/WhereMyTokens?style=for-the-badge">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <a href="https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.16.1/WhereMyTokens-Setup.exe"><strong>Descargar v1.16.1</strong></a>
  ·
  <a href="#características">Características</a>
  ·
  <a href="#screenshots">Capturas</a>
</p>

<p align="center">
  Una app local-first para la bandeja de Windows que muestra tokens, costos, sesiones, caché, uso por modelo y límites de Claude Code y Codex de un vistazo.
</p>

<a id="screenshots"></a>

<table>
  <tr>
    <th>Vista general oscura</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-overview-dark.png" alt="Vista general oscura de WhereMyTokens" /></td>
  </tr>
  <tr>
    <th>Vista general clara</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-overview-light.png" alt="Vista general clara de WhereMyTokens" /></td>
  </tr>
</table>

> Creada por un desarrollador coreano que usa Claude Code a diario — resolviendo mi propia necesidad.

## Novedades

| Versión | Fecha | Cambios destacados |
|---------|-------|-------------------|
| **[v1.16.1](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.16.1)** | 27 may | Mantiene el budgeted ledger warmup tras imports full-history truncados o fallidos y evita completion markers obsoletos por provider |
| **[v1.16.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.16.0)** | 26 may | Añade el ledger persistente de uso, snapshots de inicio instantáneo y la tarjeta Trend con historial de costos/tokens y líneas netas de git |
| **[v1.15.3](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.15.3)** | 25 may | Enruta el refresh por un scheduler serializado y con presupuesto para que la UI de bandeja y el hotkey popup sigan respondiendo durante startup, watcher, history y refresh manual |
| **[v1.15.2](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.15.2)** | 21 may | Incluye logs archivados de Codex y logs agent de Claude en el uso all-time, y muestra sesiones all-time desde el historial completo |
| **[v1.15.1](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.15.1)** | 21 may | Mantiene ágil el hotkey popup sin perder el historial completo de sesiones y evita que las ventanas auxiliares de la bandeja aparezcan en la taskbar |

[→ Historial completo](https://github.com/jeongwookie/WhereMyTokens/releases)

---

## Descargar

**[⬇ Descargar Instalador (.exe)](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.16.1/WhereMyTokens-Setup.exe)** — descarga y ejecuta, listo

**[⬇ Descargar ZIP portable](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.16.1/WhereMyTokens-v1.16.1-win-x64.zip)** — no requiere instalación

Al descargar o instalar, aceptas el [Acuerdo de Licencia de Usuario Final (EULA)](EULA.txt).

**Opción A — Instalador** _(recomendado)_
1. Descarga `WhereMyTokens-Setup.exe` desde el enlace de arriba
2. Ejecuta el instalador y sigue el asistente
3. La aplicación se abre automáticamente y se ubica en la bandeja del sistema

**Opción B — ZIP Portable** _(sin instalación)_
1. Descarga `WhereMyTokens-v1.16.1-win-x64.zip` desde la página de releases
2. Extrae el zip en cualquier ubicación
3. Ejecuta `WhereMyTokens.exe`

---

## Características

### Seguimiento de Sesiones
- **Casillas de provider Claude + Codex** — monitorea Claude, Codex o ambos en un solo panel
- **Detección en tiempo real** — Terminal, VS Code, Cursor, Windsurf y más con estado en tiempo real: `active` / `waiting` / `idle` / `compacting`
- **Agrupación compacta** — por proyecto git → rama; sesiones Claude/Codex repetidas se apilan por provider/source/model/state
- **Límite por rama** — cada rama muestra las primeras 3 filas por defecto; el resto se abre con "Show N more"
- **Advertencias de ventana de contexto** — barra por sesión; ámbar al 70%, naranja al 85%, rojo al 95%+
- **Barras de uso de herramientas** — barra de color proporcional + etiquetas de herramientas (Bash, Edit, Read, …)

### Límites de Uso y Alertas
- **Barras de límite de uso** — Claude 5h/1sem desde Anthropic API/statusLine como respaldo, con recuperación passive OAuth refresh si el access token local expira; Codex 5h/1sem desde live Codex usage, caché y luego eventos locales de rate-limit
- **Vista Quota Pace** — compara el % de cuota usado con el % de tiempo transcurrido; amarillo/rojo indica que el ritmo va por delante de la ventana de reset
- **Puente Claude Code** — regístrate como plugin `statusLine` para datos en tiempo real sin sondeo de API
- **Notificaciones de Windows** — en umbrales de uso configurables (50% / 80% / 90%)
- **Presupuesto Claude Extra Usage** — créditos mensuales de Claude usados / límite / utilización %

### Análisis y Actividad
- **Estadísticas del encabezado** — alternancia today/all-time: costo, llamadas API, sesiones, eficiencia de caché, ahorros, metadatos compactos de Claude/Codex y estado health/fallback por provider. En `all`, el conteo de sesiones viene del historial completo
- **Snapshots de inicio instantáneo** — restaura al instante el último estado válido de la UI mientras los nuevos escaneos continúan en segundo plano
- **Sincronización de historial al iniciar** — las sesiones actuales y el uso reciente aparecen primero; el historial antiguo sigue por un budgeted refresh scheduler para mantener responsive el hotkey popup y la UI
- **Ledger persistente de uso** — agrega el uso local de JSONL en un ledger local para que los totales antiguos dependan menos de la caché JSONL y puedan reconstruirse desde Settings
- **Tarjeta Trend** — muestra tendencias diarias, semanales o mensuales de costo/tokens junto con líneas netas de git, sin dibujar datos faltantes como ceros
- **Pestañas de actividad** — mapa de calor de 7 días, calendario de 5 meses (estilo GitHub), distribución por hora, comparación de 4 semanas
- **Pestaña Rhythm** — distribución de costos por franja horaria (Morning/Afternoon/Evening/Night) con barras de gradiente, estadísticas detalladas del pico, zona horaria local
- **Desglose por modelo** — tokens y costos de los modelos principales con barras de gradiente
- **Activity Breakdown** — Claude se analiza por output tokens; Codex por tool events en 10 categorías (Thinking, Edit/Write, Read, Search, Git, etc.)

### Producción de Código y Productividad
- **Métricas basadas en Git** — commits, líneas netas cambiadas, **$/100 Added** (costo por 100 líneas añadidas)
- **Hoy vs todo el tiempo** — hoy muestra el costo real por línea añadida con el promedio para comparación
- **Gráfico de crecimiento de Output** — muestra el crecimiento acumulado de líneas netas en los últimos 7 días locales
- **Ámbito de repos de la sesión actual** — Code Output ahora etiqueta que los totales git se calculan sobre los repos vinculados a las sesiones que estás rastreando
- **Histórico por ramas** — Code Output histórico cuenta commits y cambios de líneas en todas las ramas locales, usando tu email local de git
- **Descubrimiento automático** — proyectos Claude desde `~/.claude/projects/` incluyendo logs agent, y sesiones Codex desde `~/.codex/sessions/`, `~/.codex/archived_sessions/`, `~/.codex/session-cleanup-archive/`
- **Solo tus commits** — filtrado por `git config user.email`

### Personalización
- **Tema Auto/Claro/Oscuro** — sigue la preferencia del sistema por defecto
- **Visualización de costos** — USD o KRW con tasa de cambio configurable
- **Floating usage widget** — ventana compacta de Quota Pace con soporte always-on-top; muéstrala u ocúltala desde el encabezado principal, el menú de bandeja, Settings o los controles del widget. Las animaciones waiting están desactivadas por defecto y se pueden reactivar en Settings
- **Etiqueta de bandeja** — muestra % de uso, cantidad de tokens o costo directamente en la barra de tareas
- **Gestión de proyectos** — oculta o excluye completamente proyectos del seguimiento
- **Iniciar con Windows** — inicio automático opcional

---

## Inicio Rápido

### 1. Abrir el panel
Haz clic en el icono de la bandeja (o presiona el atajo global `Ctrl+Shift+D`).

### 2. Conectar puente Claude Code (opcional)
**Settings → Claude Code Integration → Setup** — habilita datos de límite de uso en tiempo real sin sondeo de API.

### 3. Configurar
- **Tracking providers** — activa Claude Code y/o Codex con casillas
- **Moneda** — USD o KRW
- **Alertas** — establece umbrales de uso (50% / 80% / 90%)
- **Tema** — Auto (sigue el sistema) / Claro / Oscuro
- **Etiqueta de bandeja** — elige qué mostrar en la barra de tareas
- **Floating usage widget** — activa la ventana compacta de Quota Pace; luego puedes mostrarla u ocultarla desde el toggle del encabezado principal o el menú de bandeja

---

## Arquitectura

WhereMyTokens es una app de bandeja Electron local-first. El renderer no lee archivos locales ni credenciales directamente; el sistema de archivos, las API de provider, la bandeja y los ajustes se manejan en el proceso main de Electron y llegan al renderer solo mediante el preload bridge.

| Capa | Responsabilidad |
|------|-----------------|
| Electron main | Descubre sesiones Claude/Codex, parsea logs JSONL, obtiene uso del provider, gestiona bandeja/ventanas y persiste ajustes. |
| Preload bridge | Expone la superficie IPC typed `window.wmt` mientras mantiene los límites de `contextIsolation`. |
| React renderer | Muestra el panel de bandeja, ajustes, notificaciones, gráficos de actividad y widget compacto de cuota. |
| `statusLine` bridge | `src/bridge/bridge.ts` recibe JSON de Claude Code por stdin y escribe un snapshot local que observa el proceso main. |

| Flujo de datos | Fuente | Destino | Red |
|----------------|--------|---------|-----|
| Sesiones Claude | `~/.claude/sessions/*.json`, `~/.claude/projects/**/*.jsonl` | Parser/cache del main process, luego renderer state | No |
| Puente Claude | stdin de Claude Code `statusLine` | `%APPDATA%\WhereMyTokens\live-session.json` | No |
| Límites de uso Claude | OAuth token en `~/.claude/.credentials.json` | Anthropic `/api/oauth/usage` | Sí, directo a Anthropic |
| Sesiones Codex | `~/.codex/sessions/**/*.jsonl`, `~/.codex/archived_sessions/**/*.jsonl`, `~/.codex/session-cleanup-archive/**/*.jsonl` | Parser/cache del main process, luego renderer state | No |
| Límites de uso Codex | OAuth token en `~/.codex/auth.json` | ChatGPT/Codex usage endpoint | Sí, directo a OpenAI/ChatGPT |

La prioridad de límites depende del provider: Claude usa primero la API de Anthropic y luego el bridge `statusLine` como fallback; Codex usa primero live usage y luego eventos locales `rate_limits` de los logs JSONL; ambos conservan el último valor conocido solo hasta que queda stale.

---

## Seguridad y Privacidad

WhereMyTokens lee archivos locales y, cuando está habilitado, solo hace solicitudes directas a las API de uso del provider para tu propia cuenta. No hay sincronización en la nube ni telemetría.

| Ruta local | Propósito |
|------------|-----------|
| `~/.claude/sessions/*.json` | Metadatos de sesión Claude, como pid, cwd y modelo. |
| `~/.claude/projects/**/*.jsonl` | Logs de conversación Claude para tokens, costos, contexto y resúmenes de actividad. |
| `~/.claude/.credentials.json` | Material OAuth de Claude usado solo para solicitudes de uso de Anthropic y refresh de access tokens expirados. |
| `~/.codex/sessions/**/*.jsonl` | Logs actuales de sesión Codex para tokens, cached input, modelos, eventos rate-limit y actividad de herramientas. |
| `~/.codex/archived_sessions/**/*.jsonl` | Logs archivados de Codex incluidos en el uso all-time. |
| `~/.codex/session-cleanup-archive/**/*.jsonl` | Logs de cleanup archive de Codex incluidos en el uso all-time. |
| `~/.codex/auth.json` | Material OAuth de ChatGPT usado solo para snapshots de uso de Codex; no se copia al storage de la app ni se registra en logs. |
| `%APPDATA%\WhereMyTokens\live-session.json` | Snapshot local escrito por el bridge `statusLine` de Claude Code. |
| Electron app data (`%APPDATA%\WhereMyTokens`) | Ajustes de la app, cachés locales, historial de notificaciones y estado del bridge. |

El manejo de credenciales es deliberadamente estrecho: WhereMyTokens lee los archivos locales oficiales de la CLI, no pide pegar API keys, no guarda una copia de respaldo de credenciales y oculta detalles de credenciales en la salida de estado. Si el access token de Claude expira, la app puede refrescarlo con Anthropic y escribir las credentials actualizadas de forma atómica en `~/.claude/.credentials.json`.

El acceso de red se limita a los usage endpoints de los providers habilitados. El polling de Claude usage corre como máximo cada 5 minutos y aplica backoff para 429. Codex live usage usa solicitudes HTTPS-only con timeout, límite de tamaño de respuesta, caché y backoff. El parseo local de JSONL y el bridge `statusLine` no envían contenido de sesiones fuera del equipo.

Para desactivar el bridge de Claude Code, abre **Settings -> Claude Code Integration -> Disable**. La app elimina la entrada `statusLine` solo cuando pertenece al comando bridge de WhereMyTokens; no sobrescribe ni borra otro `statusLine` custom. También puedes quitar manualmente la entrada `statusLine` de WhereMyTokens en `~/.claude/settings.json` y reiniciar Claude Code.

---

## Inicio y estado del encabezado

Al iniciar, el panel muestra primero las sesiones actuales y el uso reciente. Si aparece `Partial History`, el historial antiguo sigue sincronizándose en budgeted background slices para que la app de bandeja y el hotkey popup sigan respondiendo.

El pequeño botón PiP del encabezado activa o desactiva el widget flotante Quota Pace. La píldora de estado del encabezado resume el estado más importante de provider/API. Las etiquetas comunes incluyen `Claude local`, `Claude partial`, `Claude refresh`, `Claude login`, `Claude limited`, `Claude offline` y `refresh failed`. El widget Quota Pace muestra chips de health por provider, como `Claude OK` y `Codex OK`; pasa el cursor por cualquier píldora o chip para ver el detalle más reciente.

---

## Detalles de Seguimiento por Provider

### Puente Claude Code

WhereMyTokens puede recibir contexto, modelo, costo y datos de límite de uso como fallback mediante el mecanismo oficial de plugin `statusLine` de Claude Code. Usa **Settings -> Claude Code Integration -> Setup** para registrar el bridge, o **Disable** para eliminar la entrada bridge propiedad de WhereMyTokens.

### Seguimiento de Codex

WhereMyTokens también puede leer los logs JSONL locales de Codex desde `~/.codex/sessions/**/*.jsonl`, `~/.codex/archived_sessions/**/*.jsonl` y `~/.codex/session-cleanup-archive/**/*.jsonl`. En Settings, activa las casillas de los providers que quieras monitorear.

**El seguimiento de Codex incluye:**
- Estado de sesión, agrupación por proyecto/rama y etiquetas de origen como VS Code o Codex Exec
- Uso por modelo GPT/Codex y estimaciones de costo equivalentes a API
- Tokens input, cached input y output, ahorro por caché y totales por modelo
- Porcentajes y tiempos de reset de Codex 5h/1sem desde live Codex usage cuando está disponible, con fallback a caché/eventos locales `rate_limits`
- Activity Breakdown basado en tool events, porque los logs de Codex exponen llamadas a herramientas, no output tokens por herramienta

**Cálculo de caché de Codex:** los logs de Codex reportan `input_tokens` y `cached_input_tokens`. WhereMyTokens guarda el input no cacheado como `input_tokens - cached_input_tokens`, guarda el cached input como cache-read tokens y muestra la eficiencia de caché como:

```text
cached_input_tokens / input_tokens
```

Claude usa esta fórmula:

```text
cache_read_input_tokens / (cache_read_input_tokens + cache_creation_input_tokens)
```

---

## Cómo se calculan los números

Los tokens incluyen **input + output + cache creation + cache reads** cuando están disponibles. El costo siempre es una estimación equivalente a API usando la tabla de precios local de la app.

Claude reporta input, output, cache creation y cache read. Codex reporta raw input, cached input y output; WhereMyTokens divide el raw input en uncached input y cached input para evitar doble conteo en ahorro de caché y totales por modelo.

---

## Instalar desde Código Fuente

### Requisitos

- Windows 10 / 11
- [Node.js](https://nodejs.org) 18+
- [Claude Code](https://claude.ai/code) instalado y con sesión iniciada

### Compilar y Ejecutar

```bash
git clone https://github.com/jeongwookie/WhereMyTokens.git
cd WhereMyTokens
npm install
npm run build
npm start
```

## Aviso Legal

Los costos mostrados son **estimaciones equivalentes a la API**, no facturación real. Las suscripciones Claude Max/Pro son tarifas mensuales fijas. La visualización de costos muestra cuánto valor de uso estás obteniendo de tu suscripción.

---

## Contribuir

Los issues y pull requests son bienvenidos. Por favor, abre un issue primero para discutir los cambios que te gustaría hacer.

---

## Agradecimientos

Inspirado en [duckbar](https://github.com/rofeels/duckbar) — la contraparte para macOS.

---

## Licencia

MIT
