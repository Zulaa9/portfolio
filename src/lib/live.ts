/**
 * Datos "en vivo" de los proyectos, leídos de fuentes públicas SOLO al compilar.
 * El navegador nunca hace estas peticiones: el sitio publicado sigue sin terceros.
 *
 * Framewise: usuarios de Chrome Web Store (HTML), Edge Add-ons (JSON) y Firefox Add-ons (API pública).
 * KeyPing en Microsoft Store: adquisiciones de la API de análisis de Partner Center. Solo si el
 * build tiene las credenciales (MSSTORE_TENANT_ID, MSSTORE_CLIENT_ID, MSSTORE_CLIENT_SECRET).
 * Los textos de los módulos pueden usar marcadores {{keyping.version}}, {{keyping.date}}, etc.
 * Cuando sale una versión nueva, el deploy hook de Cloudflare recompila el sitio y los
 * marcadores toman el valor nuevo. Si la API falla, se usa src/data/live-fallback.json.
 */
import { gunzipSync } from 'node:zlib';
import fallback from '../data/live-fallback.json';

type KeyPingLive = {
  version: string;
  publishedAt: string;
  releases: number;
  firstVersion: string;
  commits: number;
  electron: string;
  angular: string;
  /** Descargas de instaladores (.exe, .AppImage y .apk) de todas las versiones de GitHub Releases. */
  downloads: number;
  /** Líneas de .ts/.html/.css/.scss de keyping-ui en la última versión publicada. */
  lines: number;
};
/** Usuarios de Framewise según cada tienda (cifra pública de su ficha). */
type FramewiseLive = { chrome: number; edge: number; firefox: number; users: number };
/** Adquisiciones de KeyPing en Microsoft Store (todas las fechas). null = no se cuenta (sin credenciales). */
type StoreLive = { acquisitions: number | null };
export type LiveSource = 'api' | 'fallback';
export type LiveProject = 'keyping' | 'framewise';
export type LiveData = {
  keyping: KeyPingLive;
  framewise: FramewiseLive;
  store: StoreLive;
  /** De dónde salió cada proyecto: de su fuente en este build o del respaldo. */
  sources: Record<LiveProject, LiveSource>;
  /** Fecha (AAAA-MM-DD) de los datos de respaldo: se muestra cuando se usan. */
  fallbackAsOf: string;
};

const REPO = 'Zulaa9/KeyPing';
const TIMEOUT_MS = 10_000;

async function get(url: string, accept = 'application/vnd.github+json'): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept, 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': 'Mozilla/5.0 (compatible; zula-portfolio-build)' };
  if (process.env.GITHUB_TOKEN && url.startsWith('https://api.github.com/')) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Número total de elementos de un listado paginado de GitHub pidiendo 1 por página. */
async function countPaged(url: string): Promise<number> {
  const res = await get(url);
  const last = res.headers.get('link')?.match(/[?&]page=(\d+)>;\s*rel="last"/);
  if (last) return Number(last[1]);
  return ((await res.json()) as unknown[]).length;
}

/**
 * Solo cuentan los instaladores: .blockmap, latest*.yml y SHA256SUMS los piden el
 * autoactualizador o quien verifica, y no son descargas de la app. Una actualización
 * automática sí descarga el instalador, así que esto cuenta descargas, no personas.
 */
export function countInstallerDownloads(releases: { assets?: { name: string; download_count: number }[] }[]): number {
  return releases.flatMap((r) => r.assets ?? []).filter((a) => /\.(exe|AppImage|apk)$/.test(a.name)).reduce((sum, a) => sum + a.download_count, 0);
}

/** Extensiones y carpetas que cuentan como código de la app (mismo criterio que la cifra manual de v1.1.1). */
const CODE_EXT = /\.(ts|html|css|scss)$/;
const SKIP_DIR = /\/(node_modules|dist|release|\.angular)\//;

/** Cuenta líneas de código de keyping-ui dentro de un .tar.gz de GitHub (formato ustar con cabeceras pax). */
export function countCodeLines(tgz: Uint8Array): number {
  const tar = gunzipSync(tgz);
  const text = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0[\s\S]*$/, '');
  let off = 0;
  let paxPath: string | null = null;
  let lines = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const name = text(h.subarray(0, 100));
    const size = parseInt(text(h.subarray(124, 136)).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = text(h.subarray(345, 500));
    const body = tar.subarray(off + 512, off + 512 + size);
    if (type === 'x') {
      paxPath = new TextDecoder().decode(body).match(/\d+ path=([^\n]*)\n/)?.[1] ?? null;
    } else {
      const path = paxPath ?? (prefix ? `${prefix}/${name}` : name);
      paxPath = null;
      if ((type === '0' || type === '\0') && path.includes('/keyping-ui/') && CODE_EXT.test(path) && !SKIP_DIR.test(path)) {
        let n = 0;
        for (const byte of body) if (byte === 10) n++;
        if (body.length && body[body.length - 1] !== 10) n++;
        lines += n;
      }
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return lines;
}

const major = (range: string | undefined) => range?.match(/(\d+)/)?.[1] ?? '';

async function loadKeyPing(): Promise<KeyPingLive> {
  const api = `https://api.github.com/repos/${REPO}`;
  const [latest, releases, commits, pkg] = await Promise.all([
    get(`${api}/releases/latest`).then((r) => r.json() as Promise<{ tag_name: string; published_at: string }>),
    get(`${api}/releases?per_page=100`).then(
      (r) => r.json() as Promise<{ tag_name: string; draft: boolean; prerelease: boolean; assets: { name: string; download_count: number }[] }[]>,
    ),
    countPaged(`${api}/commits?sha=main&per_page=1`),
    get(`https://raw.githubusercontent.com/${REPO}/main/keyping-ui/package.json`).then(
      (r) => r.json() as Promise<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>,
    ),
  ]);
  const published = releases.filter((r) => !r.draft && !r.prerelease);
  // Código de la última versión publicada (tarball de la etiqueta, ~8 MB, solo en el build).
  const tgz = new Uint8Array(await (await get(`https://codeload.github.com/${REPO}/tar.gz/refs/tags/${latest.tag_name}`, 'application/gzip')).arrayBuffer());
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const data: KeyPingLive = {
    version: latest.tag_name.replace(/^v/, ''),
    publishedAt: latest.published_at,
    releases: published.length,
    firstVersion: (published.at(-1)?.tag_name ?? 'v1.0.0').replace(/^v/, ''),
    commits,
    electron: major(deps.electron),
    angular: major(deps['@angular/core']),
    downloads: countInstallerDownloads(published),
    lines: countCodeLines(tgz),
  };
  if (!data.version || !data.releases || !data.electron || !data.angular || !data.lines) throw new Error('datos incompletos');
  return data;
}

const FRAMEWISE = { chrome: 'mkpljcojmhhmkpamcdecnmjbndbabfae', edge: 'ppfmagbmfpeldadpbhbknlffhfnnhgee', firefox: 'framewise' };

/** Lee «N users» del HTML de la ficha de Chrome Web Store (no hay API pública). */
export function parseChromeUsers(html: string): number | null {
  const m = html.match(/>\s*([\d,]+)\s+users?\s*</) ?? html.match(/\b([\d,]+)\s+users?\b/);
  return m ? Number(m[1]!.replace(/,/g, '')) : null;
}

async function loadFramewise(): Promise<FramewiseLive> {
  const [html, edgeJson, amo] = await Promise.all([
    get(`https://chromewebstore.google.com/detail/${FRAMEWISE.chrome}?hl=en`, 'text/html').then((r) => r.text()),
    get(`https://microsoftedge.microsoft.com/addons/getproductdetailsbycrxid/${FRAMEWISE.edge}`, 'application/json').then(
      (r) => r.json() as Promise<{ activeInstallCount?: unknown }>,
    ),
    get(`https://addons.mozilla.org/api/v5/addons/addon/${FRAMEWISE.firefox}/`, 'application/json').then(
      (r) => r.json() as Promise<{ average_daily_users?: unknown }>,
    ),
  ]);
  const chrome = parseChromeUsers(html);
  const edge = edgeJson.activeInstallCount;
  if (chrome === null || !Number.isInteger(chrome)) throw new Error('Chrome Web Store: no aparece la cifra de usuarios');
  if (typeof edge !== 'number' || !Number.isInteger(edge)) throw new Error('Edge Add-ons: no aparece activeInstallCount');
  // Firefox: media de usuarios diarios que publica la propia ficha de AMO («Usuarios»).
  const firefox = amo.average_daily_users;
  if (typeof firefox !== 'number' || !Number.isInteger(firefox)) throw new Error('Firefox Add-ons: no aparece average_daily_users');
  return { chrome, edge, firefox, users: chrome + edge + firefox };
}

/** Store ID de KeyPing y día desde el que se suman adquisiciones (antes de la primera publicación). */
const STORE = { appId: '9N168Z5TZT05', since: '2026-11-01' };

/** Suma acquisitionQuantity de las filas de la API de análisis de Microsoft Store. */
export function sumAcquisitions(rows: { acquisitionQuantity?: unknown }[]): number {
  return rows.reduce((sum, r) => sum + (typeof r.acquisitionQuantity === 'number' ? r.acquisitionQuantity : 0), 0);
}

async function loadStore(): Promise<StoreLive> {
  const { MSSTORE_TENANT_ID: tenant, MSSTORE_CLIENT_ID: id, MSSTORE_CLIENT_SECRET: secret } = process.env;
  if (!tenant || !id || !secret) return { acquisitions: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let token: string;
  try {
    const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, resource: 'https://manage.devcenter.microsoft.com' }),
      signal: ctrl.signal,
    });
    // Nunca se registra el cuerpo: podría contener datos de la cuenta.
    if (!res.ok) throw new Error(`token de Microsoft Entra: HTTP ${res.status}`);
    token = ((await res.json()) as { access_token?: string }).access_token ?? '';
    if (!token) throw new Error('token de Microsoft Entra vacío');
  } finally {
    clearTimeout(timer);
  }
  const today = new Date().toISOString().slice(0, 10);
  let url: string | null =
    `https://manage.devcenter.microsoft.com/v1.0/my/analytics/appacquisitions?applicationId=${STORE.appId}` +
    `&startDate=${STORE.since}&endDate=${today}&aggregationLevel=month&top=10000`;
  let total = 0;
  for (let page = 0; url && page < 20; page++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: c.signal });
      if (!res.ok) throw new Error(`análisis de Microsoft Store: HTTP ${res.status}`);
      const json = (await res.json()) as { Value?: { acquisitionQuantity?: unknown }[]; '@nextLink'?: string | null };
      if (!Array.isArray(json.Value)) throw new Error('análisis de Microsoft Store: respuesta sin Value');
      total += sumAcquisitions(json.Value);
      const next = json['@nextLink'];
      url = next ? new URL(next, 'https://manage.devcenter.microsoft.com/v1.0/my/').toString() : null;
    } finally {
      clearTimeout(t);
    }
  }
  return { acquisitions: total };
}

async function attempt<T>(name: string, fn: () => Promise<T>, backup: T, describe: (x: T) => string): Promise<[T, LiveSource]> {
  try {
    const x = await fn();
    console.info(`[live] ${name}: ${describe(x)}`);
    return [x, 'api'];
  } catch (err) {
    console.warn(`[live] ${name}: no se pudo consultar (${(err as Error).message}); se usan los datos de respaldo del ${fallback.asOf}`);
    return [backup, 'fallback'];
  }
}

async function load(): Promise<LiveData> {
  const storeBackup: StoreLive = { acquisitions: fallback.store.acquisitions };
  const base = { keyping: fallback.keyping, framewise: fallback.framewise, store: storeBackup, fallbackAsOf: fallback.asOf };
  if (process.env.LIVE_DATA_OFFLINE === '1') return { ...base, sources: { keyping: 'fallback', framewise: 'fallback' } };
  const [[keyping, k], [framewise, f], [store, s]] = await Promise.all([
    attempt('KeyPing (GitHub)', loadKeyPing, fallback.keyping, (x) => `v${x.version}, ${x.releases} versiones, ${x.commits} commits, ${x.downloads} descargas, ${x.lines} líneas`),
    attempt('Framewise (tiendas)', loadFramewise, fallback.framewise, (x) => `${x.users} usuarios (Chrome ${x.chrome} + Edge ${x.edge} + Firefox ${x.firefox})`),
    attempt('KeyPing (Microsoft Store)', loadStore, storeBackup, (x) => (x.acquisitions === null ? 'sin credenciales, no se cuenta' : `${x.acquisitions} adquisiciones`)),
  ]);
  // La cifra de descargas de KeyPing suma GitHub y la Store: si una de las dos sale del
  // respaldo, el total lleva la fecha del respaldo.
  const keypingSource: LiveSource = k === 'fallback' || (s === 'fallback' && store.acquisitions !== null) ? 'fallback' : 'api';
  return { ...base, keyping, framewise, store, sources: { keyping: keypingSource, framewise: f } };
}

export const live: LiveData = await load();

const MONTHS: Record<'en' | 'es', string[]> = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
};

function values(lang: 'en' | 'es', data: LiveData = live): Record<string, string> {
  const k = data.keyping;
  const d = new Date(k.publishedAt);
  const ok = !Number.isNaN(d.getTime());
  const month = ok ? MONTHS[lang][d.getUTCMonth()] : '';
  const nf = new Intl.NumberFormat(lang === 'es' ? 'es-ES' : 'en-US');
  const store = data.store?.acquisitions ?? null;
  // Fuente de la cifra de descargas: sin dato de la Store, solo GitHub (como antes).
  const downloadSources =
    store === null
      ? lang === 'es' ? 'GitHub Releases (instaladores)' : 'GitHub Releases (installers)'
      : lang === 'es'
        ? `GitHub Releases (${nf.format(k.downloads)} instaladores) + Microsoft Store (${nf.format(store)})`
        : `GitHub Releases (${nf.format(k.downloads)} installers) + Microsoft Store (${nf.format(store)})`;
  return {
    'keyping.version': k.version,
    'keyping.date': ok ? (lang === 'es' ? `${month} de ${d.getUTCFullYear()}` : `${month} ${d.getUTCFullYear()}`) : '',
    'keyping.releases': nf.format(k.releases),
    'keyping.firstVersion': k.firstVersion,
    'keyping.commits': nf.format(k.commits),
    'keyping.electron': k.electron,
    'keyping.angular': k.angular,
    // Total: instaladores de GitHub + adquisiciones de Microsoft Store (si se cuentan).
    'keyping.downloads': nf.format(k.downloads + (store ?? 0)),
    'keyping.githubDownloads': nf.format(k.downloads),
    'keyping.storeDownloads': store === null ? '' : nf.format(store),
    'keyping.downloadSources': downloadSources,
    // Redondeado a centenas: «~19.300».
    'keyping.lines': nf.format(Math.round(k.lines / 100) * 100),
    'framewise.users': nf.format(data.framewise.users),
    'framewise.chrome': nf.format(data.framewise.chrome),
    'framewise.edge': nf.format(data.framewise.edge),
    'framewise.firefox': nf.format(data.framewise.firefox ?? 0),
  };
}

/** Sustituye los marcadores {{proyecto.dato}}. Un marcador desconocido se deja tal cual. */
export function interpolateLive(text: string, lang: 'en' | 'es', data?: LiveData): string {
  if (!text.includes('{{')) return text;
  const v = values(lang, data);
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (all, key: string) => v[key] ?? all);
}
