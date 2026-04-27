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
  <a href="https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.11.6/WhereMyTokens-Setup.exe"><strong>Descargar v1.11.6</strong></a>
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
    <th width="50%">Modo Claro</th>
    <th width="50%">Modo Oscuro</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-light.png" alt="Light mode" /></td>
    <td><img src="assets/screenshot-dark.png" alt="Dark mode" /></td>
  </tr>
</table>

<table>
  <tr>
    <th width="33%">Rhythm y Estadísticas Pico</th>
    <th width="33%">Mapa de Calor 7 Días</th>
    <th width="33%">Configuración</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-rhythm.png" alt="Rhythm tab" /></td>
    <td><img src="assets/screenshot-heatmap.png" alt="7-day heatmap" /></td>
    <td><img src="assets/screenshot-settings.png" alt="Settings" /></td>
  </tr>
</table>

> Creada por un desarrollador coreano que usa Claude Code a diario — resolviendo mi propia necesidad.

## Novedades

| Versión | Fecha | Cambios destacados |
|---------|-------|-------------------|
| **[v1.11.6](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.11.6)** | 27 abr | Añade selector de idioma del instalador para English, 한국어, 日本語, 简体中文 y Español, manteniendo el EULA en inglés |
| **[v1.11.5](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.11.5)** | 26 abr | Estabiliza la retención de sesiones del popup en ejecuciones largas, evita que los changed files vuelvan a expandir el scoped refresh y añade instrumentación opcional de crash y memoria para diagnóstico |
| **[v1.11.4](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.11.4)** | 25 abr | Mantiene el popup centrado en sesiones recientes + activas, reduce el costo de refresco con la bandeja oculta y añade diagnósticos del proceso principal |
| **[v1.11.3](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.11.3)** | 24 abr | Reduce el refresco en segundo plano cuando está inactivo, ordena los metadatos del encabezado y etiqueta Code Output como repos de las sesiones actuales |
| **[v1.11.2](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.11.2)** | 24 abr | Documenta Partial History y los estados del encabezado, y actualiza la ayuda integrada |

[→ Historial completo](https://github.com/jeongwookie/WhereMyTokens/releases)

---

## Descargar

**[⬇ Descargar Instalador (.exe)](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.11.6/WhereMyTokens-Setup.exe)** — descarga y ejecuta, listo

**[⬇ Descargar ZIP portable](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.11.6/WhereMyTokens-v1.11.6-win-x64.zip)** — no requiere instalación

Al descargar o instalar, aceptas el [Acuerdo de Licencia de Usuario Final (EULA)](EULA.txt).

**Opción A — Instalador** _(recomendado)_
1. Descarga `WhereMyTokens-Setup.exe` desde el enlace de arriba
2. Ejecuta el instalador y sigue el asistente
3. La aplicación se abre automáticamente y se ubica en la bandeja del sistema

**Opción B — ZIP Portable** _(sin instalación)_
1. Descarga `WhereMyTokens-v1.11.6-win-x64.zip` desde la página de releases
2. Extrae el zip en cualquier ubicación
3. Ejecuta `WhereMyTokens.exe`

---

## Características

### Seguimiento de Sesiones
- **Modos Claude + Codex** — monitorea Claude, Codex o ambos en un solo panel
- **Detección en tiempo real** — Terminal, VS Code, Cursor, Windsurf y más con estado en tiempo real: `active` / `waiting` / `idle` / `compacting`
- **Agrupación compacta** — por proyecto git → rama; sesiones Claude/Codex repetidas se apilan por provider/source/model/state
- **Límite por rama** — cada rama muestra las primeras 3 filas por defecto; el resto se abre con "Show N more"
- **Advertencias de ventana de contexto** — barra por sesión; ámbar al 70%, naranja al 85%, rojo al 95%+
- **Barras de uso de herramientas** — barra de color proporcional + etiquetas de herramientas (Bash, Edit, Read, …)

### Límites de Uso y Alertas
- **Barras de límite de uso** — Claude 5h/1sem desde Anthropic API/statusLine; Codex 5h/1sem desde eventos locales de rate-limit en los logs
- **Puente Claude Code** — regístrate como plugin `statusLine` para datos en tiempo real sin sondeo de API
- **Notificaciones de Windows** — en umbrales de uso configurables (50% / 80% / 90%)
- **Presupuesto Claude Extra Usage** — créditos mensuales de Claude usados / límite / utilización %

### Análisis y Actividad
- **Estadísticas del encabezado** — alternancia today/all-time: costo, llamadas API, sesiones, eficiencia de caché, ahorros, metadatos compactos de Claude/Codex y una sola píldora de estado para fallback/reset
- **Sincronización de historial al iniciar** — las sesiones actuales y el uso reciente aparecen primero; el historial antiguo sigue cargando en segundo plano con el aviso `Partial History`
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
- **Descubrimiento automático** — proyectos Claude desde `~/.claude/projects/` y sesiones Codex desde `~/.codex/sessions/`
- **Solo tus commits** — filtrado por `git config user.email`

### Personalización
- **Tema Auto/Claro/Oscuro** — sigue la preferencia del sistema por defecto
- **Visualización de costos** — USD o KRW con tasa de cambio configurable
- **Widget siempre visible** — permanece encima; minimiza vía botón del encabezado, icono de bandeja o atajo global
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
- **Tracking Provider** — Claude / Codex / Both
- **Moneda** — USD o KRW
- **Alertas** — establece umbrales de uso (50% / 80% / 90%)
- **Tema** — Auto (sigue el sistema) / Claro / Oscuro
- **Etiqueta de bandeja** — elige qué mostrar en la barra de tareas

---

## Inicio y estado del encabezado

Al iniciar, el panel muestra primero las sesiones actuales y el uso reciente. Si aparece `Partial History`, el historial antiguo sigue sincronizándose en segundo plano para que la app de bandeja abra rápido.

La píldora de estado del encabezado resume el estado más importante de Claude/API. Las etiquetas más comunes son `Local estimate` (datos locales de respaldo), `Reset unavailable` (hay uso actual pero falta la hora de reset), `Rate limited` y `API offline`. Pasa el cursor por la píldora para ver el detalle más reciente.

---

## Seguimiento de Codex

WhereMyTokens también puede leer los logs JSONL locales de Codex desde `~/.codex/sessions/**/*.jsonl`. En Settings, elige **Claude**, **Codex** o **Both**.

**El seguimiento de Codex incluye:**
- Estado de sesión, agrupación por proyecto/rama y etiquetas de origen como VS Code o Codex Exec
- Uso por modelo GPT/Codex y estimaciones de costo equivalentes a API
- Tokens input, cached input y output, ahorro por caché y totales por modelo
- Porcentajes y tiempos de reset de Codex 5h/1sem cuando el log local contiene eventos `rate_limits`
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

Claude y Codex usan ventanas de reset 5h/1sem separadas. Claude usa Anthropic API primero y luego statusLine/cache como respaldo; Codex usa el evento `rate_limits` más reciente en los JSONL locales de Codex.

---

## Datos y Privacidad

WhereMyTokens solo lee archivos locales — sin sincronización en la nube, sin telemetría.

| Archivo | Propósito |
|---------|-----------|
| `~/.claude/sessions/*.json` | Metadatos de sesión (pid, cwd, modelo) |
| `~/.claude/projects/**/*.jsonl` | Registros de conversación (tokens, costos) |
| `~/.claude/.credentials.json` | Token OAuth — solo para obtener tus estadísticas de uso de Anthropic |
| `~/.codex/sessions/**/*.jsonl` | Logs de sesión Codex (tokens, cached input, modelos, eventos rate-limit, tool calls) |
| `%APPDATA%\WhereMyTokens\live-session.json` | Datos del puente escritos por el plugin `statusLine` |

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

---

## Demo

<div align="center">

https://github.com/user-attachments/assets/98b6f8d7-6fc6-4c12-aef1-af6300db0728

</div>

---

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
